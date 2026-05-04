use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

use crate::features::reactor11::core::{R11Core, R11RodHandle};

static R11: std::sync::LazyLock<Arc<TokioMutex<R11Core>>> =
    std::sync::LazyLock::new(|| Arc::new(TokioMutex::new(R11Core::new())));

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct R11Status {
    pub rods: Vec<R11RodHandle>,
    pub total_vram_used_mib: f64,
    pub tier_enabled: bool,
}

fn next_rod_id(rods: &[R11RodHandle]) -> String {
    let mut max_a: i32 = 0;
    let mut max_b: i32 = 0;
    for r in rods {
        if let Some(num) = r.id[4..].parse::<i32>().ok() {
            if r.id.starts_with("ROD_A") { max_a = max_a.max(num); }
            else if r.id.starts_with("ROD_B") { max_b = max_b.max(num); }
        }
    }

    for i in 1..=8 {
        let id = format!("ROD_A{}", i);
        if !rods.iter().any(|r| r.id == id) { return id; }
    }
    for i in 1..=8 {
        let id = format!("ROD_B{}", i);
        if !rods.iter().any(|r| r.id == id) { return id; }
    }

    let count: i32 = (rods.len() + 1) as i32;
    if max_a >= max_b { format!("ROD_A{}", max_a.max(count)) } else { format!("ROD_B{}", max_b.max(count)) }
}

fn estimate_vram(model_path: &str, ctx_size: usize) -> f64 {
    let model_bytes = std::fs::metadata(model_path).map(|m| m.len()).unwrap_or(0);

    // Simple file-size-based estimate for reactor UI (not precision-critical)
    // Model size + 30% overhead (weights + KV cache + CUDA context)
    let base_mib = model_bytes as f64 / (1024.0 * 1024.0);
    let kv_estimate = ctx_size as f64 * 0.002; // rough KV per-token estimate in MiB
    (base_mib * 1.3 + kv_estimate + 2560.0).max(4096.0)
}

#[tauri::command]
pub async fn r11_get_status() -> Result<R11Status, String> {
    let core = R11.lock().await;
    Ok(R11Status {
        rods: core.rods.values().cloned().collect(),
        total_vram_used_mib: core.total_vram_used(),
        tier_enabled: core.tier_enabled,
    })
}

#[tauri::command]
pub async fn r11_insert_rod(
    config: crate::types::EngineConfig,
    gpus: Vec<crate::telemetry::GpuInfo>,
    app: tauri::State<'_, crate::engine::AppContext>,
) -> Result<R11RodHandle, String> {
    let model_path = &config.model_path;

    // Estimate VRAM
    let ctx_int = crate::templates::ProviderTemplate::ctx_to_int_str(&config.ctx_size)
        .parse::<usize>()
        .unwrap_or(32768);
    let vram_estimate = estimate_vram(model_path, ctx_int);

    // Find allocation from R11Core (Dedicated vs Split across GPUs)
    let allocation = {
        let core = R11.lock().await;
        match core.find_allocation(vram_estimate, &gpus) {
            Some(a) => a,
            None => {
                let suggestions: Vec<String> = gpus.iter()
                    .map(|g| format!(
                        "GPU {} ({}MB free)",
                        g.index,
                        ((g.memory_total as i64 - g.memory_used as i64) as f64).max(0.0)
                    ))
                    .collect();
                return Err(format!(
                    "INSUFFICIENT VRAM — model needs ~{:.0}MB\nAvailable: {}",
                    vram_estimate,
                    suggestions.join(", ")
                ));
            }
        }
    };

    // Inject tier-1 flags into config BEFORE launch_engine processes it
    let mut launch_config = config.clone();
    {
        let core = R11.lock().await;
        if core.tier_enabled {
            use serde_json::json;
            launch_config.extra_params.insert("perf".to_string(), json!(true));
            launch_config.extra_params.insert("poll".to_string(), json!(100));
            launch_config.extra_params.insert("backend_sampling".to_string(), json!(true));
        }
    }

    // Derive device string from allocation for llama.cpp --device flag
    match &allocation {
        crate::features::reactor11::core::R11GpuAllocation::Dedicated(idx) => {
            launch_config.device = format!("GPU-{}", idx);
        }
        crate::features::reactor11::core::R11GpuAllocation::Split([a, b]) => {
            // For split: set device to non-GPU-1 value, and split_mode triggers gpu_mask="0,1"
            launch_config.device = format!("GPU-{}/{}", a, b);
        }
    }

    // For split allocations: set layer splitting mode + parallel count
    if allocation.is_split() {
        launch_config.split_mode = "layer".to_string();
        launch_config.parallel = 2;
    }

    let rod_id = next_rod_id(&{
        let core = R11.lock().await;
        core.rods.values().cloned().collect::<Vec<_>>()
    });

    // Create RodHandle with Inserting status
    let handle = R11RodHandle {
        id: rod_id.clone(),
        alias: launch_config.alias.clone(),
        model_path: launch_config.model_path.clone(),
        port: 0,
        status: crate::features::reactor11::core::R11RodStatus::Inserting,
        allocation: allocation.clone(),
        vram_mib: vram_estimate,
        ctx_size: ctx_int,
        slot_idx: None,
        quant: launch_config.kv_quant.clone(),
        gpu_mask: allocation.gpu_mask(),
    };

    // Insert into R11Core state (Inserting status)
    {
        let mut core = R11.lock().await;
        core.rods.insert(rod_id.clone(), handle.clone());
    }

    // === LAUNCH THE ACTUAL ENGINE PROCESS === 
    // This is the bridge to existing EngineStack — Rod maps to a slot via launch_engine
    let stack_entry = crate::engine::launch_engine(
        launch_config,
        None, // model_base not needed — config already has full path
        app.clone(),
    ).await.map_err(|e| format!("Engine launch failed: {}", e))?;

    // Update RodHandle with actual port + slot_idx from launched engine
    {
        let mut core = R11.lock().await;
        if let Some(rod) = core.rods.get_mut(&rod_id) {
            rod.port = stack_entry.port;
            rod.slot_idx = Some(stack_entry.idx);
            rod.status = crate::features::reactor11::core::R11RodStatus::Running;
            // Use actual VRAM from engine if available, otherwise keep estimate
            if stack_entry.vram_mib > 0.0 {
                rod.vram_mib = stack_entry.vram_mib;
            }
        }
    }

    let updated_handle = {
        let core = R11.lock().await;
        core.rods.get(&rod_id).cloned()
    };

    Ok(updated_handle.unwrap_or(handle))
}

#[tauri::command]
pub async fn r11_remove_rod(
    rod_id: String,
    app: tauri::State<'_, crate::engine::AppContext>,
) -> Result<(), String> {
    // Get the alias BEFORE removing from state (needed for stop_engine)
    let alias = {
        let core = R11.lock().await;
        core.rods.get(&rod_id).map(|r| r.alias.clone())
    };

    // Stop the actual engine process via existing EngineStack
    if let Some(alias_str) = &alias {
        crate::engine::stop_engine(
            alias_str.to_string(),
            app,
        ).await.ok(); // Best effort — don't fail rod removal if stop fails
    }

    // Now remove from R11Core state
    let mut core = R11.lock().await;
    if !core.rods.contains_key(&rod_id) {
        return Err(format!("Rod '{}' not found", rod_id));
    }
    core.rods.remove(&rod_id);
    Ok(())
}

#[tauri::command]
pub async fn r11_swap_rod(
    rod_id: String,
    new_config: crate::types::EngineConfig,
) -> Result<R11RodHandle, String> {
    let (allocation_clone, ctx_size, port, slot_idx, vram_mib) = {
        let core = R11.lock().await;
        let rod = core.rods.get(&rod_id)
            .ok_or_else(|| format!("Rod '{}' not found", rod_id))?;

        (
            rod.allocation.clone(),
            rod.ctx_size,
            rod.port,
            rod.slot_idx,
            rod.vram_mib,
        )
    };

    // Update rod state
    {
        let mut core = R11.lock().await;
        core.rods.insert(rod_id.clone(), R11RodHandle {
            id: rod_id.clone(),
            alias: new_config.alias.clone(),
            model_path: new_config.model_path.clone(),
            port,
            status: crate::features::reactor11::core::R11RodStatus::Inserting,
            allocation: allocation_clone.clone(),
            vram_mib,
            ctx_size,
            slot_idx,
            quant: new_config.kv_quant.clone(),
            gpu_mask: allocation_clone.gpu_mask(),
        });
    }

    // Update to running after swap
    {
        let mut core = R11.lock().await;
        if let Some(rod) = core.rods.get_mut(&rod_id) {
            rod.status = crate::features::reactor11::core::R11RodStatus::Running;
        }
    }

    r11_get_rod_by_id(rod_id).await
}

#[tauri::command]
pub async fn r11_get_rod_by_id(rod_id: String) -> Result<R11RodHandle, String> {
    let core = R11.lock().await;
    core.rods.get(&rod_id)
        .cloned()
        .ok_or_else(|| format!("Rod '{}' not found", rod_id))
}

#[tauri::command]
pub async fn r11_toggle_tier() -> Result<bool, String> {
    let mut core = R11.lock().await;
    core.tier_enabled = !core.tier_enabled;
    Ok(core.tier_enabled)
}

/// Update an existing rod's status (called by frontend after engine launch/launch failure).
#[tauri::command]
pub async fn r11_update_rod(
    id: String,
    port: u16,
    vram_mib: f64,
    slot_idx: Option<usize>,
) -> Result<(), String> {
    let mut core = R11.lock().await;
    if let Some(rod) = core.rods.get_mut(&id) {
        rod.port = port;
        rod.vram_mib = vram_mib.max(0.0);
        rod.slot_idx = slot_idx;
    }
    Ok(())
}

#[tauri::command]
pub async fn r11_predict_fit(
    model_path: String,
    gpus: Vec<crate::telemetry::GpuInfo>,
) -> Result<crate::features::reactor11::core::R11PredictiveFit, String> {
    let core = R11.lock().await;
    Ok(core.predict_fit(&model_path, &gpus))
}

#[tauri::command]
pub async fn r11_get_rod_count() -> Result<usize, String> {
    let core = R11.lock().await;
    Ok(core.rod_count())
}

#[tauri::command]
pub async fn r11_get_running_rod_count() -> Result<usize, String> {
    let core = R11.lock().await;
    Ok(core.running_rod_count())
}
