use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

use crate::features::reactor::core::{
    GpuAllocation, ReactorCore, RodHandle,
};
use crate::features::reactor::state::ReactorState;

static REACTOR: std::sync::LazyLock<Arc<TokioMutex<ReactorCore>>> =
    std::sync::LazyLock::new(|| Arc::new(TokioMutex::new(ReactorCore::new())));

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactorStatus {
    pub rods: Vec<RodHandle>,
    pub total_vram_used_mib: f64,
    pub tier_enabled: bool,
}

fn next_rod_id(rods: &[RodHandle]) -> String {
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

fn estimate_vram(model_path: &str, _ctx_size: usize) -> f64 {
    let model_bytes = std::fs::metadata(model_path).map(|m| m.len()).unwrap_or(0);
    
    // 1GB file ≈ ~8GB VRAM (model weights + KV cache + overhead)
    let estimated_gb = (model_bytes as f64 / (1024.0 * 1024.0 * 1024.0)) * 8.0;
    (estimated_gb * 1024.0).max(4096.0)
}

fn derive_allocation_str(allocation: &GpuAllocation) -> String {
    match allocation {
        GpuAllocation::Dedicated(idx) => format!("GPU-{}", idx),
        GpuAllocation::Split([a, b]) => format!("SPLIT-{}-{}", a, b),
    }
}

#[tauri::command]
pub async fn reactor_get_status() -> Result<ReactorStatus, String> {
    let core = REACTOR.lock().await;
    
    Ok(ReactorStatus {
        rods: core.rods.values().cloned().collect(),
        total_vram_used_mib: core.total_vram_used(),
        tier_enabled: core.tier_enabled,
    })
}

#[tauri::command]
pub async fn reactor_insert_rod(
    config: crate::types::EngineConfig,
    gpus: Vec<crate::telemetry::GpuInfo>,
) -> Result<RodHandle, String> {
    let model_path = &config.model_path;
    
    // Estimate VRAM
    let ctx_int = crate::templates::ProviderTemplate::ctx_to_int_str(&config.ctx_size)
        .parse::<usize>()
        .unwrap_or(32768);
    let vram_estimate = estimate_vram(model_path, ctx_int);

    // Find allocation
    let allocation = {
        let core = REACTOR.lock().await;
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
                let headroom = {
                    let c = REACTOR.lock().await;
                    c.headroom_mib
                };
                return Err(format!(
                    "INSUFFICIENT VRAM — model needs ~{:.0}MB\nAvailable: {}\nTip: Reduce context size or increase --headroom_mib (currently {:.0}MB)",
                    vram_estimate,
                    suggestions.join(", "),
                    headroom
                ));
            }
        }
    };

    let rod_id = {
        let core = REACTOR.lock().await;
        next_rod_id(&core.rods.values().cloned().collect::<Vec<_>>())
    };

    let handle = RodHandle {
        id: rod_id.clone(),
        alias: config.alias.clone(),
        model_path: config.model_path.clone(),
        port: 0,
        status: crate::features::reactor::core::RodStatus::Inserting,
        allocation,
        vram_mib: vram_estimate,
        ctx_size: ctx_int,
        slot_idx: None,
    };

    {
        let mut core = REACTOR.lock().await;
        core.rods.insert(rod_id.clone(), handle.clone());
        save_state(&core);
    }

    Ok(handle)
}

#[tauri::command]
pub async fn reactor_remove_rod(rod_id: String) -> Result<(), String> {
    // Remove rod from reactor state (engine stop handled by frontend via standard IPC)
    let mut core = REACTOR.lock().await;
    if !core.rods.contains_key(&rod_id) {
        return Err(format!("Rod '{}' not found", rod_id));
    }
    core.rods.remove(&rod_id);
    save_state(&core);
    Ok(())
}

#[tauri::command]
pub async fn reactor_swap_rod(
    rod_id: String,
    new_config: crate::types::EngineConfig,
) -> Result<RodHandle, String> {
    let (allocation_clone, ctx_size, port, slot_idx) = {
        let core = REACTOR.lock().await;
        let rod = core.rods.get(&rod_id)
            .ok_or_else(|| format!("Rod '{}' not found", rod_id))?;
        
        (
            rod.allocation.clone(),
            rod.ctx_size,
            rod.port,
            rod.slot_idx,
        )
    };

    // Update rod state
    {
        let mut core = REACTOR.lock().await;
        core.rods.insert(rod_id.clone(), RodHandle {
            id: rod_id.clone(),
            alias: new_config.alias.clone(),
            model_path: new_config.model_path.clone(),
            port,
            status: crate::features::reactor::core::RodStatus::Inserting,
            allocation: allocation_clone,
            vram_mib: 0.0,
            ctx_size,
            slot_idx,
        });
    }

    // Update to running after swap
    {
        let mut core = REACTOR.lock().await;
        if let Some(rod) = core.rods.get_mut(&rod_id) {
            rod.status = crate::features::reactor::core::RodStatus::Running;
        }
        save_state(&core);
    }

    reactor_get_rod_by_id(rod_id).await
}

#[tauri::command]
pub async fn reactor_get_rod_by_id(rod_id: String) -> Result<RodHandle, String> {
    let core = REACTOR.lock().await;
    core.rods.get(&rod_id)
        .cloned()
        .ok_or_else(|| format!("Rod '{}' not found", rod_id))
}

#[tauri::command]
pub async fn reactor_toggle_tier() -> Result<bool, String> {
    let mut core = REACTOR.lock().await;
    core.tier_enabled = !core.tier_enabled;
    save_state(&core);
    Ok(core.tier_enabled)
}

/// Update an existing rod's status (called by frontend after engine launch/launch failure).
#[tauri::command]
pub async fn reactor_update_rod(
    id: String,
    port: u16,
    vram_mib: f64,
    slot_idx: Option<usize>,
) -> Result<(), String> {
    let mut core = REACTOR.lock().await;
    if let Some(rod) = core.rods.get_mut(&id) {
        rod.port = port;
        rod.vram_mib = vram_mib.max(0.0);
        rod.slot_idx = slot_idx;
        save_state(&core);
    }
    Ok(())
}

fn save_state(core: &ReactorCore) {
    let state = ReactorState::from_rods(&core.rods.values().cloned().collect::<Vec<_>>(), core.tier_enabled);
    state.save();
}