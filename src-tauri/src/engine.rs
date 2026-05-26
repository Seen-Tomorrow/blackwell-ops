use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::sync::Mutex as TokioMutex;
use tokio::sync::broadcast; // For fit scanner progress channel


use crate::engine_stack::SlotStatus;
use crate::config::AppConfig;
use crate::engine_stack::EngineStack;
use crate::log_hub::LogHub;
use crate::types::{EngineConfig, ModelEntry};

use crate::fit_scanner;
use crate::telemetry;
use crate::telemetry::detect_gpu_count;
use crate::fusion_brain;
use crate::model_catalog;
use crate::engine_utils;

/// Compute CUDA_VISIBLE_DEVICES mask from config + detected GPU count.
/// Split mode → all GPUs joined by comma. Single GPU → parsed index from "GPU-N".
fn compute_gpu_mask(config: &EngineConfig, gpu_count: usize, test_has_split: bool) -> String {
    let split_mode = config.get_param_str("split").unwrap_or_default();
    let split_active = (!split_mode.is_empty() && split_mode.to_uppercase() != "NONE") || test_has_split;

    if split_active {
        (0..gpu_count).map(|i| i.to_string()).collect::<Vec<_>>().join(",")
    } else {
        let device = config.get_param_str("device").unwrap_or_else(|| "GPU-0".to_string());
        let idx = device.strip_prefix("GPU-")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0);
        if idx < gpu_count {
            idx.to_string()
        } else {
            "0".to_string()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StackEntryOut {
    pub idx: usize,
    pub alias: String,
    pub model_name: String,
    pub port: u16,
    pub gpu: String,
    pub status: String,
    #[serde(default)]
    pub slot_id: u32,
    #[serde(default = "crate::types::default_provider_type")]
    pub provider_type: String,
    #[serde(default)]
    pub model_path: String,
    #[serde(default)]
    pub vram_mib: f64,
    #[serde(default = "crate::types::default_ctx_size")]
    pub n_ctx: usize,
    /// Provider display name (e.g. "GGML Stable")
    #[serde(default)]
    pub provider_name: String,
    /// Build info for the running engine's provider (CUDA version, build date)
    #[serde(default)]
    pub build_info: Option<crate::types::BuildInfo>,
}

fn default_ctx_size() -> usize { 32768 }

pub struct AppContext {
    pub stack: Arc<Mutex<EngineStack>>,
    pub log_hub: LogHub,
    pub config: Arc<std::sync::Mutex<AppConfig>>,
    /// Cancellation flag for in-progress library scans.
    pub fit_scan_cancel: Arc<TokioMutex<Arc<AtomicBool>>>,
}

// ── Model Catalog (multi-path merge via model_catalog module) ───────

#[tauri::command]
pub async fn list_models(
    config: tauri::State<'_, Arc<std::sync::Mutex<AppConfig>>>,
) -> Result<Vec<ModelEntry>, String> {
    let cfg = config.lock().map_err(|e| e.to_string())?;
    let paths = crate::config::get_model_paths(&cfg);

    if paths.is_empty() {
        return Ok(Vec::new());
    }

    let (entries, _conflicts) = model_catalog::merge_catalogs(&paths)?;
    if !_conflicts.is_empty() {
        log::warn!("[list_models] Found {} cross-path duplicates (keeping largest)", _conflicts.len());
    }

    Ok(entries)
}

// ── Engine Management Commands ──────────────────────────────────────

#[tauri::command]
pub async fn launch_engine(
    config: EngineConfig,
    _model_base: Option<String>,
    app: tauri::State<'_, AppContext>,
) -> Result<StackEntryOut, String> {
    let backend_type = if config.backend_type.is_empty() {
        crate::config::DEFAULT_PROVIDER_ID.to_string()
    } else {
        config.backend_type.clone()
    };

    let cfg = {
        let guard = app.config.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };

    let binary_path = engine_utils::find_provider_binary(&cfg, &backend_type, &config.binary_profile);

    let template = crate::templates::ProviderTemplate::load_by_id(&backend_type)
        .unwrap_or_else(|| crate::templates::ProviderTemplate::load(crate::config::DEFAULT_PROVIDER_ID));

    let provider_opt2 = cfg.providers.iter().find(|p| p.id == backend_type);

    // User params are the single source of truth for CLI generation
    let user_params: Vec<crate::types::UserEditedTemplateParam> = provider_opt2
        .map(|p| p.user_edited_template_params.clone())
        .unwrap_or_default();

    let mut config = config;
    let test_has_split = config.extra_params.get("__test_args")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.windows(2).any(|w| {
                w[0].as_str().map(|s| s == "-sm" || s == "--split-mode").unwrap_or(false)
                    && w.get(1).and_then(|s| s.as_str()).map(|v| {
                        !matches!(v.to_uppercase().as_str(), "NONE" | "0")
                    }).unwrap_or(false)
            })
        }).unwrap_or(false);

    let gpu_count = detect_gpu_count();
    let gpu_mask = compute_gpu_mask(&config, gpu_count, test_has_split);

    let gpu_mask_msg = format!("[GPU_MASK] provider={} split_mode=\"{}\" test_has_split={} -> CUDA_VISIBLE_DEVICES={}", backend_type, config.get_param_str("split").unwrap_or_default(), test_has_split, gpu_mask);
    eprintln!("{}", gpu_mask_msg);
    // SANITY-BOX — route GPU mask info to sanity box
   app.log_hub.emit_sanity_log("warn", &gpu_mask_msg);

    eprintln!("[LAUNCH_DIAG] step1: validate binary");
    crate::config::validate_provider_binary(binary_path.to_str().unwrap_or(""))?;
    eprintln!("[LAUNCH_DIAG] step2: validate model");
    crate::config::validate_model_path(&config.model_path)?;

    eprintln!("[LAUNCH_DIAG] step3: waiting for stack lock...");
    let (slot_idx, slot_port) = {
        let stack = match tokio::time::timeout(Duration::from_secs(5), app.stack.lock()).await {
            Ok(guard) => guard,
            Err(_) => {
                eprintln!("[LAUNCH_DIAG] step3 FAIL: stack lock timeout — possible deadlock");
                return Err("Stack lock timeout — possible deadlock. Another task may be holding the lock.".to_string());
            }
        };
        eprintln!("[LAUNCH_DIAG] step4: stack lock acquired, finding idle slot...");
        let idx = stack.find_idle_slot().ok_or("All engine slots are occupied")?;
        eprintln!("[LAUNCH_DIAG] step5: idle slot found: idx={} config.port={}", idx, config.port);
        let port = stack.get_slot(idx).map(|s| s.port).unwrap_or(9090 + idx as u16);
        (idx, port)
    };

    config.port = slot_port;
    eprintln!("[LAUNCH_DIAG] step6: killing existing process on port {}", slot_port);

    let ps_script = format!(
        r"$pids = netstat -ano | Select-String ':{0} ' | ForEach-Object {{ ($_ -split '\s+')[-1] }}; $pids | Where-Object {{ $_.Length -gt 0 -and $_ -ne '0' }} | ForEach-Object {{ taskkill /F /PID $_ 2>$null }}",
        slot_port
    );
    eprintln!("[LAUNCH_DIAG] step6a: spawning powershell taskkill");
    let kill_result = tokio::process::Command::new("powershell")
        .args(&["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &ps_script])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .await;
    eprintln!("[LAUNCH_DIAG] step6b: taskkill returned: {:?}", kill_result.as_ref().map(|o| o.status.success()));

    eprintln!("[LAUNCH_DIAG] step7: sleeping 300ms for port release");
    tokio::time::sleep(Duration::from_millis(300)).await;
    eprintln!("[LAUNCH_DIAG] step7b: woke from sleep, continuing");

    let provider_display_name = backend_type.clone();
    eprintln!("[LAUNCH_DIAG] step8a: provider_display_name = {}", provider_display_name);

    eprintln!("[LAUNCH_DIAG] step8: building command args");
    let cmd_args = template.build_command(&config, &gpu_mask, &user_params);
    eprintln!("[LAUNCH_DIAG] step8c: cmd_args built, len={}", cmd_args.len());
    let launch_cmd = format!("{} {}", binary_path.display(), cmd_args.join(" "));
    eprintln!("\n========== [LAUNCH_CMD] slot={} ==========", slot_idx);
    eprintln!("{}", launch_cmd);
    eprintln!("==========================================\n");
    // SANITY-BOX — route launch command to sanity box
    app.log_hub.emit_sanity_log("warn", &format!("[LAUNCH_CMD] slot={}: {}", slot_idx, launch_cmd));

    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(r"C:\tmp\blackwell-launch.log") {
        use std::io::Write;
        let _ = writeln!(f, "\n[{}] slot={} CMD:\n{}\n", chrono::Local::now().format("%H:%M:%S%.3f"), slot_idx, launch_cmd);
        let _ = f.flush();
    }

    app.log_hub.emit_system_event(slot_idx, &config.alias, "Engine launching...").await;

    let ctx_size_int = crate::templates::ctx_to_int_tokens(&config.get_param_str("ctx").unwrap_or_else(|| "32k".to_string()));

    // Helper to build the on_ready closure
    fn make_on_ready(
        stack: Arc<tokio::sync::Mutex<EngineStack>>,
        slot_idx: usize,
    ) -> impl Fn() + Send + Sync + 'static {
        move || {
            let s_clone = stack.clone();
            let si = slot_idx;
            tokio::spawn(async move {
                // Update slot status under lock, then drop lock BEFORE emitting
                {
                    let s = s_clone.lock().await;
                    if let Some(mut slot) = s.get_slot(si) {
                        use crate::engine_stack::SlotStatus;
                        slot.status = SlotStatus::Running;
                    }; // drop parking_lot MutexGuard before dropping tokio guard
                } // tokio Mutex dropped here — no hold during emit
                // Re-acquire for emit_stack_changed (get_status + emit)
                {
                    let s = s_clone.lock().await;
                    s.emit_stack_changed();
                }
            });
        }
    }

    // Spawn engine with auto-retry (once) on immediate crash
    let stack_for_ready = app.stack.clone();
    let slot_for_ready = slot_idx;
    let mut last_err = None;
    for attempt in 0..2 {
        let result = EngineStack::load_slot(
            slot_idx, &config, &binary_path, gpu_mask.clone(), cmd_args.clone(),
            provider_display_name.clone(), backend_type.clone(), &app.stack,
            app.log_hub.clone(),
            make_on_ready(stack_for_ready.clone(), slot_for_ready),
        ).await;

        match result {
            Ok(()) => break,
            Err(e) => {
                last_err = Some(e);
                if attempt == 0 {
                    eprintln!("[LAUNCH] slot={} first attempt failed: {} — retrying in 1s...", slot_idx, last_err.as_ref().unwrap());
                    app.log_hub.emit_system_event(slot_idx, &config.alias, &format!("[RETRY] Launch failed: {} — retrying...", last_err.as_ref().unwrap())).await;
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    }

    if let Some(e) = last_err {
        return Err(e);
    }

    // Spawn FUSION brain — /slots + /metrics polling, state machine, emits "fusion-update"
    {
        let fusion_log_hub = app.log_hub.clone();
        let fusion_alias = config.alias.clone();
        let fusion_port = slot_port;
        let fusion_parallel = config.get_parallel();
        let fusion_unified_kv = config.get_unified_kv();

        tokio::spawn(async move {
            fusion_brain::start_brain(
                fusion_log_hub,
                fusion_brain::FusionConfig {
                    alias: fusion_alias,
                    slot_idx,
                    port: fusion_port,
                    ctx_total: ctx_size_int,
                    parallel: fusion_parallel,
                    unified_kv: fusion_unified_kv,
                },
            ).await;
        });
    }

    let model_name = config.model_path.rsplit('/').next().unwrap_or("unknown").to_string();

    // Emit stack-changed push event so frontend gets instant update without polling
    {
        let stack = app.stack.lock().await;
        stack.emit_stack_changed();
    }

    Ok(StackEntryOut {
        idx: slot_idx,
        alias: config.alias.clone(),
        model_name,
        port: slot_port,
        gpu: gpu_mask,
        status: "LOADING".to_string(),
        slot_id: slot_idx as u32,
        provider_type: backend_type,
        model_path: config.model_path.clone(),
        vram_mib: 0.0,
        n_ctx: ctx_size_int,
        provider_name: provider_display_name,
        build_info: None,
    })
}



#[tauri::command]
pub async fn stop_engine(alias: String, app: tauri::State<'_, AppContext>) -> Result<String, String> {
    let slot_idx = {
        let stack = app.stack.lock().await;
        let slot_count = stack.slots.len();
        (0..slot_count).find(|&i| {
            stack.get_slot(i).map_or(false, |s| s.alias == alias)
        }).ok_or(format!("Engine '{}' not found", alias))?
    };

    // Cancel fusion brain BEFORE stopping the slot — prevents race with channel close
    fusion_brain::stop_brain(slot_idx).await;

    // stop_slot is self-locking — does NOT require caller to hold stack lock
    EngineStack::stop_slot(slot_idx, &app.stack).await?;

    Ok(format!("Engine {} stopped", alias))
}


#[tauri::command]
pub async fn stop_all_engines(app: tauri::State<'_, AppContext>) -> Result<String, String> {
    let slots_to_stop: Vec<usize> = {
        let stack = app.stack.lock().await;
        let slot_count = stack.slots.len();

        (0..slot_count)
            .filter(|&i| {
                stack.get_slot(i).map_or(false, |s| !matches!(s.status, SlotStatus::Idle))
            })
            .collect()
    }; // Stack lock released

    // Cancel all fusion brains in parallel BEFORE stopping slots
    for idx in &slots_to_stop {
        fusion_brain::stop_brain(*idx).await;
    }

    // stop_all_parallel is self-locking — does NOT require caller to hold stack lock
    let stopped = EngineStack::stop_all_parallel(&app.stack).await;

    Ok(format!("All {} engines stopped", stopped.len()))
}

/// Stops all running engines for a specific provider (by backend_type).
#[tauri::command]
pub async fn stop_engines_by_provider(provider_id: String, app: tauri::State<'_, AppContext>) -> Result<String, String> {
    let slots_to_stop: Vec<usize> = {
        let stack = app.stack.lock().await;
        (0..stack.slots.len())
            .filter(|&i| {
                stack.get_slot(i).map_or(false, |s| {
                    s.backend_type == provider_id && !matches!(s.status, SlotStatus::Idle)
                })
            })
            .collect()
    };

    // Cancel fusion brains BEFORE stopping slots
    for idx in &slots_to_stop {
        fusion_brain::stop_brain(*idx).await;
    }

    // stop_slots_by_provider_parallel is self-locking — no stack lock needed
    let stopped = EngineStack::stop_slots_by_provider_parallel(&provider_id, &app.stack).await;

    Ok(format!("Stopped {} engine(s) for '{}'", stopped.len(), provider_id))
}

#[tauri::command]
pub async fn get_stack_status(app: tauri::State<'_, AppContext>) -> Result<Vec<StackEntryOut>, String> {
    let stack = app.stack.lock().await;
    let engine_entries = stack.get_status();

    // Build a lookup map from provider id → build_info
    let cfg_guard = app.config.lock().map_err(|e| e.to_string())?;
    let build_map: std::collections::HashMap<String, &crate::types::BuildInfo> = cfg_guard.providers.iter()
        .filter(|p| !p.build_info_per_env.is_empty())
        .flat_map(|p| {
            p.build_info_per_env.iter().map(move |(env_label, info)| {
                (format!("{}:{}", p.id, env_label), info)
            }).collect::<Vec<_>>()
        })
        .chain(cfg_guard.providers.iter().filter_map(|p| {
            // Also allow lookup by provider id alone if it has build info
            if !p.build_info_per_env.is_empty() {
                let first = p.build_info_per_env.values().next();
                first.map(|info| (p.id.clone(), info))
            } else {
                None
            }
        }))
        .collect();

    let entries: Vec<StackEntryOut> = engine_entries.into_iter()
        .map(|e| {
            let build_info = if e.status == "RUNNING" && !e.provider_type.is_empty() {
                build_map.get(&e.provider_type).cloned().cloned()
                    .or_else(|| build_map.get(&format!("{}:stable", e.provider_type)).cloned().cloned())
            } else {
                None
            };
            StackEntryOut {
                idx: e.idx,
                alias: e.alias.clone(),
                model_name: e.model_name.clone(),
                port: e.port,
                gpu: e.gpu.clone(),
                status: e.status.clone(),
                slot_id: e.slot_id,
                provider_type: e.provider_type.clone(),
                model_path: e.model_path.clone(),
                vram_mib: e.vram_mib,
                n_ctx: e.n_ctx,
                provider_name: e.provider_name.clone(),
                build_info,
            }
        })
        .collect();

    Ok(entries)
}

#[tauri::command]
pub async fn clean_exit(app: tauri::State<'_, AppContext>) -> Result<(), String> {
    log::info!("Clean exit requested — killing all orphaned processes");

    // Stop fusion brains first to prevent orphaned HTTP polling
    fusion_brain::stop_all_brains().await;

    // kill_all is self-locking — no stack lock needed
    EngineStack::kill_all(&app.stack).await;
    Ok(())
}

// ── Helpers ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_template(provider_id: Option<String>) -> Result<crate::templates::ProviderTemplate, String> {
    let id = provider_id.unwrap_or_else(|| crate::config::DEFAULT_PROVIDER_ID.to_string());

    // Try loading by specific ID first
    if let Some(template) = crate::templates::ProviderTemplate::load_by_id(&id) {
        return Ok(template);
    }

    // Fallback: load default template (ggml-master)
    Ok(crate::templates::ProviderTemplate::load(crate::config::DEFAULT_PROVIDER_ID))
}

#[tauri::command]
pub fn get_template_for_provider(provider_id: String) -> Result<crate::templates::ProviderTemplate, String> {
    let metas = crate::config::load_user_providers_meta();
    let meta = metas.iter().find(|m| m.id == provider_id);
    let template_type = crate::config::resolve_template_type(&provider_id, meta.map(|m| &m.template_type));

    let Some(template_key) = crate::config::template_key_for_type(&template_type) else {
        return Err(format!("No provider default config for type '{}' — cannot reset", template_type));
    };

    Ok(crate::templates::load_provider_defaults(&template_key).ok_or("Unknown provider")?)
}

#[tauri::command]
pub async fn preview_launch_command(
    config: EngineConfig,
    provider_id: Option<String>,
    app: tauri::State<'_, AppContext>,
) -> Result<String, String> {
    let backend_type = provider_id.unwrap_or_else(|| {
        if config.backend_type.is_empty() { crate::config::DEFAULT_PROVIDER_ID.to_string() } else { config.backend_type.clone() }
    });

    let cfg = {
        let guard = app.config.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };

    let binary_path = engine_utils::find_provider_binary(&cfg, &backend_type, &config.binary_profile);
    let template = crate::templates::ProviderTemplate::load_by_id(&backend_type)
        .unwrap_or_else(|| crate::templates::ProviderTemplate::load(crate::config::DEFAULT_PROVIDER_ID));

    let provider_opt_prev = cfg.providers.iter().find(|p| p.id == backend_type);
    let user_params: Vec<crate::types::UserEditedTemplateParam> = provider_opt_prev
        .map(|p| p.user_edited_template_params.clone())
        .unwrap_or_default();

    let gpu_count = detect_gpu_count();
    let gpu_mask = compute_gpu_mask(&config, gpu_count, false);

    let cmd_args = template.build_command(&config, &gpu_mask, &user_params);
    Ok(format!("{} {}", binary_path.display(), cmd_args.join(" ")))
}

// ── File Dialog (rfd native dialog) ───────────────────────────────

#[tauri::command]
pub async fn open_file_dialog(title: Option<String>, _filter: Option<String>) -> Result<Option<String>, String> {
    let title = title.unwrap_or_else(|| "Select File".to_string());
    let result = tokio::task::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title(&title)
            .pick_file()
    })
    .await
    .map_err(|e| format!("File dialog panicked: {}", e))?;

    Ok(result.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn open_folder_dialog(title: Option<String>) -> Result<Option<String>, String> {
    let title = title.unwrap_or_else(|| "Select Model Folder".to_string());

    let result = tokio::task::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title(&title)
            .pick_folder()
    })
    .await
    .map_err(|e| format!("Folder dialog panicked: {}", e))?;

    Ok(result.map(|p| p.to_string_lossy().to_string()))
}

// ── FIT Scanner Commands ────────────────────────────────────────────

#[tauri::command]
pub async fn fit_scan_model(
    model_path: String,
    _provider_id: Option<String>,
    ctx_size: String,
    kv_quant: String,
    device: String,
    split_mode: String,
    batch: u32,
    _ubatch: u32,
    parallel: u32,
    _flash_attn: bool,
    _offload_mode: String,
    app: tauri::State<'_, AppContext>,
) -> Result<fit_scanner::FitScanResult, String> {
    let cfg = {
        let guard = app.config.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };

    let backend_type = _provider_id.unwrap_or_else(|| crate::config::DEFAULT_PROVIDER_ID.to_string());
    let binary_path = engine_utils::find_provider_binary(&cfg, &backend_type, "");

    let fit_binary = fit_scanner::find_fit_binary(binary_path.to_str().unwrap_or(""))
        .ok_or_else(|| "llama-fit-params.exe not found — ensure provider is built".to_string())?;

    // Parse context size to integer tokens
    let ctx_int = crate::templates::ctx_to_int_tokens(&ctx_size);

    // Derive GPU mask from device + split_mode — same logic as launch_engine
    let gpu_count = detect_gpu_count();
    let gpu_mask = if !split_mode.is_empty() && split_mode.to_uppercase() != "NONE" {
        (0..gpu_count).map(|i| i.to_string()).collect::<Vec<_>>().join(",")
    } else {
        let idx = device.strip_prefix("GPU-")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0);
        if idx < gpu_count { idx.to_string() } else { "0".to_string() }
    };

    // Build CLI args directly — no template involvement
    let args = fit_scanner::build_fit_command(
        &model_path, ctx_int, &kv_quant, batch, _ubatch, parallel, &split_mode,
    );
    // SANITY-BOX — route FIT scan result to sanity box
    let fit_result = fit_scanner::scan_single_anchor(&fit_binary, &args, &gpu_mask).await;
    match &fit_result {
        Ok(raw) => {
            app.log_hub.emit_sanity_log("warn", &format!("[FIT] {} -> {:.1} MiB", model_path, raw.vram_mib));
        }
        Err(e) => {
            app.log_hub.emit_sanity_log("error", &format!("[FIT] {} failed: {}", model_path, e));
        }
    }
    let raw = fit_result?;
    let vram_mib = raw.vram_mib;

    let gpus = telemetry::scan_gpus().await.unwrap_or_default();
    let total_gpu_mib: f64 = gpus.iter().map(|g| g.memory_total as f64).sum();

    Ok(fit_scanner::FitScanResult {
        model_path,
        vram_mib,
        ctx: ctx_int,
        kv_quant,
        fits: vram_mib <= total_gpu_mib,
        gpu_breakdown_mib: raw.gpu_breakdown_mib,
        host_mib: raw.host_mib,
        gpu_components_mib: raw.gpu_components_mib,
    })
}

#[tauri::command]
pub async fn fit_scan_library(
    provider_id: String,
    model_base: String,
    parallel_count: u32,
    _batch: u32,
    _ubatch: u32,
    force_rescan: Option<bool>,
    app: tauri::State<'_, AppContext>,
) -> Result<fit_scanner::FitScanComplete, String> {
    let cfg = {
        let guard = app.config.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };

    // Use provided path or ALL configured model paths from config
    let all_paths = if !model_base.is_empty() {
        vec![model_base]
    } else {
        cfg.model_paths.iter().map(|p| p.path.clone()).collect::<Vec<_>>()
    };

    let binary_path = engine_utils::find_provider_binary(&cfg, &provider_id, "");
    let fit_binary = fit_scanner::find_fit_binary(binary_path.to_str().unwrap_or(""))
        .ok_or_else(|| "llama-fit-params.exe not found — ensure provider is built".to_string())?;

    // Get total GPU VRAM for fit checking
    let gpus = telemetry::scan_gpus().await.unwrap_or_default();
    let total_gpu_mib: f64 = gpus.iter().map(|g| g.memory_total as f64).sum::<f64>() + (gpus.len() as f64 * fit_scanner::FIT_OVERHEAD_PER_GPU);

    // Create broadcast channel for real-time progress events
    let (progress_tx, _progress_rx) = broadcast::channel::<fit_scanner::FitScanProgress>(64);
    let log_hub_clone = app.log_hub.clone();

    let prog_for_spawn = progress_tx.clone();

    tokio::spawn(async move {
        let mut rx = prog_for_spawn.subscribe();
        while let Ok(evt) = rx.recv().await {
            log_hub_clone.emit("fit-scan-progress", &evt);
        }
    });

    // Create cancellation flag and store in AppContext
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut guard = app.fit_scan_cancel.lock().await;
        *guard = cancel_flag.clone();
    }

    // Force rescan: delete stale cache so nothing is skipped
    if force_rescan.unwrap_or(false) {
        let _ = fit_scanner::clear_full_scan_export();
    }

    // Run library scan — scans all configured paths, deduplicates across them
    let result = fit_scanner::scan_library(
        &fit_binary, &all_paths, parallel_count.max(1), total_gpu_mib,
        provider_id.clone(), Some(progress_tx), cancel_flag,
    ).await;

    Ok(result)
}

#[tauri::command]
pub async fn fit_stop_scan(app: tauri::State<'_, AppContext>) -> Result<(), String> {
    let guard = app.fit_scan_cancel.lock().await;
    guard.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn get_binary_build_info(binary_path: String) -> Result<crate::types::BuildInfo, String> {
    let path = crate::config::resolve_path(&binary_path);

    // Always try to get mtime first — this is the most reliable signal
    let build_date = tokio::fs::metadata(&path).await
        .map(|meta| meta.modified().ok())
        .map_err(|e| format!("Binary not found: {}", e))?
        .map(|mt| {
            use chrono::{DateTime, Local};
            let dt: DateTime<Local> = mt.into();
            dt.format("%Y-%m-%d %H:%M").to_string()
        })
        .unwrap_or_else(|| "unknown".to_string());

    // Run binary with --version and capture both stdout and stderr
    // (some binaries write CUDA init info to stdout, version line may be on either stream)
    let output = tokio::process::Command::new(&path)
        .args(["--version"])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW — prevents CMD flash in release builds
        .output()
        .await;

    let cleaned = match output {
        Ok(o) if o.status.success() => {
            let raw = format!("{}{}", 
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            );
            regex::Regex::new(r"\x1b\[[0-9;?]*[a-zA-Z]")
                .ok()
                .map(|re| re.replace_all(&raw, "").to_string())
                .unwrap_or(raw)
                .chars().filter(|c| *c <= '\x7F').collect::<String>()
        }
        Ok(_o) => {
            log::warn!("Binary --version exited with error for '{}'", path.display());
            String::new()
        }
        Err(e) => {
            log::warn!("Failed to run binary --version '{}': {}", path.display(), e);
            String::new()
        }
    };

    // Parse version string — matches "version: 3 (f535774)" format
    let re = regex::Regex::new(r"version:\s*(\d+)\s*\(([^)]+)\)")
        .map_err(|e| format!("Regex error: {}", e))?;

    if let Some(caps) = re.captures(&cleaned) {
        let version = format!("{} ({})", &caps[1], &caps[2]);
        return Ok(crate::types::BuildInfo { 
            version, 
            build_date,
            cuda_version: None,
        });
    }

    // Version regex didn't match — still return mtime-based date with fallback version
    if !cleaned.is_empty() {
        log::warn!("Could not parse version from binary '{}', output: {}", 
            path.display(), cleaned.chars().take(200).collect::<String>());
    }
    Ok(crate::types::BuildInfo { 
        version: "unknown".to_string(), 
        build_date,
        cuda_version: None,
    })
}

#[tauri::command]
pub async fn set_build_info_for_env(
    provider_id: String,
    env_label: String,
    build_info: crate::types::BuildInfo,
    app: tauri::State<'_, AppContext>,
) -> Result<(), String> {
    let mut cfg = app.config.lock().map_err(|e| e.to_string())?;
    if let Some(provider) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
        provider.build_info_per_env.insert(env_label, build_info);
    }
    crate::config::persist_user_providers_meta(&cfg.providers).map_err(|e| e.to_string())
}

// ── GGUF Metadata Scanner Commands ────────────────────────────────────────

#[tauri::command]
pub async fn scan_model_metadata_cmd(
    model_path: String,
    provider_id: Option<String>,
    app: tauri::State<'_, AppContext>,
) -> Result<crate::types::ModelEntry, String> {
    let pid = provider_id.unwrap_or_else(|| crate::config::DEFAULT_PROVIDER_ID.to_string());
    let bin_str = {
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        let binary_path = engine_utils::find_provider_binary(&cfg, &pid, "");
        if !binary_path.exists() {
            return Err(format!("Provider binary not found: {}", binary_path.display()));
        }
        binary_path.to_string_lossy().to_string()
    };

    // Run scan on a background thread — closure captures only Strings (Send types)
    let metadata_result: Result<crate::types::ModelMetadata, String> = tokio::task::spawn_blocking({
        let mp = model_path.clone();
        move || crate::gguf_scan::scan_model_metadata(&mp, &bin_str)
    })
    .await
    .map_err(|e| format!("Scan task failed: {}", e))?;

    let mut metadata = metadata_result?;

    // Accumulate shard sizes — scanner only reads first shard's file size
    let total_file_size = model_catalog::get_total_model_size(&model_path);
    if total_file_size != metadata.file_size_bytes {
        log::info!("[scan_model_metadata_cmd] Corrected file_size for '{}': {} → {}", model_path, metadata.file_size_bytes, total_file_size);
        metadata.file_size_bytes = total_file_size;
    }

    log::info!("[scan_model_metadata_cmd] Scanned path='{}', arch={}", model_path, metadata.architecture);
    // Save to cache (clone metadata for both cache and return value)
    let cached_meta = metadata.clone();
    crate::model_cache::set_cached(&model_path, cached_meta)
        .map_err(|e| format!("Cache save failed: {}", e))?;

    // Return enriched ModelEntry — build minimal entry with metadata attached
    let file_size = total_file_size;

    let hf_meta_for_entry = crate::model_cache::get_hf_metadata(&model_path);
    Ok(crate::types::ModelEntry {
        path: model_path,
        author: "unknown".to_string(),
        name: "scanning".to_string(),
        quant: metadata.file_type_str.clone(),
        size_str: model_catalog::calc_size_str_from_bytes(file_size),
        vision: false,
        mmproj: None,
        mmproj_size_mib: None,
        backend_type: pid,
        source_path_label: String::new(),
        metadata: Some(metadata),
        hf_meta: hf_meta_for_entry,
    })
}

#[tauri::command]
pub async fn scan_all_models_cmd(
    _model_base: Option<String>,
    provider_id: Option<String>,
    app: tauri::State<'_, AppContext>,
) -> Result<usize, String> {
    let (bin_str, all_paths, total) = {
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        let pid = provider_id.unwrap_or_else(|| crate::config::DEFAULT_PROVIDER_ID.to_string());
        let binary_path = engine_utils::find_provider_binary(&cfg, &pid, "");
        if !binary_path.exists() {
            return Err(format!("Provider binary not found: {}", binary_path.display()));
        }
        // Use all configured paths instead of single model_base
        let paths = crate::config::get_model_paths(&cfg);
        let (catalog, _) = model_catalog::merge_catalogs(&paths)?;
        let total = catalog.len();
        let all_paths: Vec<String> = catalog.iter().map(|e| e.path.clone()).collect();
        if total == 0 {
            return Ok(0);
        }
        (binary_path.to_string_lossy().to_string(), all_paths, total)
    };

    // Clone log_hub for event emission (LogHub is Clone)
    let log_hub = app.log_hub.clone();

    // Reset cancellation flag at start of batch scan
    crate::gguf_scan::reset_cancel();

    tokio::spawn({
        let log_hub_start = log_hub.clone();
        async move {
            log_hub_start.emit("gguf-scan-start", &serde_json::json!({ "total": total }));
        }
    });

    // Run scans sequentially in batches — each spawn_blocking captures only Send types
    let mut scanned: usize = 0;
    let mut failed: usize = 0;
    const CONCURRENCY: usize = 2;
    type ScanHandle = tokio::task::JoinHandle<Result<crate::types::ModelMetadata, String>>;
    let mut handles: Vec<(usize, String, ScanHandle)> = Vec::new();

    for (i, path) in all_paths.iter().enumerate() {
        // Check cancellation between models
        if crate::gguf_scan::is_cancelled() {
            log::info!("GGUF scan cancelled after {} models", scanned);
            break;
        }

        // Incremental skip: check if cached metadata is still valid
        let cached = crate::model_cache::get_cached(path);
        if cached.is_some() {
            log::debug!("[batch_scan] SKIP (cache HIT): {}", path);
            scanned += 1;
            continue;
        }

        let scan_path = path.clone();
        let bin = bin_str.clone();

        log::debug!("[batch_scan] Scanning: {}", scan_path);
        let handle = tokio::task::spawn_blocking(move || {
            crate::gguf_scan::scan_model_metadata(&scan_path, &bin)
        });

        handles.push((i, path.clone(), handle));

        // When we hit concurrency limit, await one before spawning next
        if handles.len() >= CONCURRENCY {
            let (_, p, h) = handles.remove(0);
            match h.await {
                Ok(Ok(mut metadata)) => {
                    let corrected_size = model_catalog::get_total_model_size(&p);
                    if corrected_size != metadata.file_size_bytes {
                        log::info!("[batch_scan] Corrected file_size for '{}': {} → {}", p, metadata.file_size_bytes, corrected_size);
                        metadata.file_size_bytes = corrected_size;
                    }
                    if let Err(e) = crate::model_cache::set_cached(&p, metadata.clone()) {
                        log::warn!("Failed to cache {}: {}", p, e);
                    }
                    scanned += 1;
                }
                Ok(Err(e)) => {
                    let msg = format!("[SCAN] {} failed: {}", p, e);
                    log::warn!("{}", msg);
                    // SANITY-BOX — route scan failure to sanity box
                    log_hub.emit_sanity_log("error", &msg);
                    failed += 1;
                }
                Err(e) => {
                    let msg = format!("[SCAN] {} task panicked: {}", p, e);
                    log::warn!("{}", msg);
                    // SANITY-BOX — route scan failure to sanity box
                    log_hub.emit_sanity_log("error", &msg);
                    failed += 1;
                }
            }

            let lh = log_hub.clone();
            tokio::spawn(async move {
                lh.emit("gguf-scan-progress", &serde_json::json!({
                    "scanned": scanned,
                    "failed": failed,
                    "total": total,
                    "current_model": p,
                }));
            });
        }
    }

    // Await remaining handles (let in-flight scans finish)
    for (_, p, h) in handles {
        match h.await {
            Ok(Ok(mut metadata)) => {
                let corrected_size = model_catalog::get_total_model_size(&p);
                if corrected_size != metadata.file_size_bytes {
                    log::info!("[batch_scan] Corrected file_size for '{}': {} → {}", p, metadata.file_size_bytes, corrected_size);
                    metadata.file_size_bytes = corrected_size;
                }
                if let Err(e) = crate::model_cache::set_cached(&p, metadata.clone()) {
                    log::warn!("Failed to cache {}: {}", p, e);
                }
                scanned += 1;
            }
            Ok(Err(e)) => {
                log::warn!("Scan failed for {}: {}", p, e);
                failed += 1;
            }
            Err(e) => {
                log::warn!("Task failed for {}: {}", p, e);
                failed += 1;
            }
        }

        let lh = log_hub.clone();
        tokio::spawn(async move {
            lh.emit("gguf-scan-progress", &serde_json::json!({
                "scanned": scanned,
                "failed": failed,
                "total": total,
                "current_model": p,
            }));
        });
    }

    // Emit complete event
    let lh = log_hub.clone();
    tokio::spawn(async move {
        lh.emit("gguf-scan-complete", &serde_json::json!({
            "scanned": scanned,
            "failed": failed,
            "total": total,
        }));
    });

    Ok(scanned)
}

#[tauri::command]
pub fn cancel_gguf_scan_cmd() {
    crate::gguf_scan::GGUF_SCAN_CANCEL.store(true, std::sync::atomic::Ordering::Relaxed);
}

#[tauri::command]
pub async fn clear_model_cache_cmd() -> Result<(), String> {
    crate::model_cache::clear_cache()
}

