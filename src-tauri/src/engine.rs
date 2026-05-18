use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::sync::Mutex as TokioMutex;
use tokio::sync::broadcast; // For fit scanner progress channel (unrelated to ConPTY)


use crate::engine_stack::SlotStatus;
use crate::config::AppConfig;
use crate::engine_stack::EngineStack;
use crate::log_hub::LogHub;
use crate::types::{EngineConfig, ModelEntry};

use crate::fit_scanner;
use crate::telemetry;
use crate::telemetry::detect_gpu_count;
use crate::engine_perf;
use crate::model_catalog;
use crate::engine_utils;

/// Compute CUDA_VISIBLE_DEVICES mask from config + detected GPU count.
/// Split mode → all GPUs joined by comma. Single GPU → parsed index from "GPU-N".
fn compute_gpu_mask(config: &EngineConfig, gpu_count: usize, test_has_split: bool) -> String {
    let split_active = (!config.split_mode.is_empty() && config.split_mode.to_uppercase() != "NONE") || test_has_split;

    if split_active {
        (0..gpu_count).map(|i| i.to_string()).collect::<Vec<_>>().join(",")
    } else {
        let idx = config.device.strip_prefix("GPU-")
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
    #[serde(default = "default_provider_type")]
    pub provider_type: String,
    #[serde(default)]
    pub model_path: String,
    #[serde(default)]
    pub vram_mib: f64,
    #[serde(default = "default_ctx_size")]
    pub n_ctx: usize,
    /// Provider display name (e.g. "GGML Stable")
    #[serde(default)]
    pub provider_name: String,
    /// Build info for the running engine's provider (CUDA version, build date)
    #[serde(default)]
    pub build_info: Option<crate::types::BuildInfo>,
}

fn default_provider_type() -> String { "ggml-stable".to_string() }
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
        "ggml-stable".to_string()
    } else {
        config.backend_type.clone()
    };

    let cfg = {
        let guard = app.config.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };

    let binary_path = engine_utils::find_provider_binary(&cfg, &backend_type, &config.binary_profile);

    let template = crate::templates::ProviderTemplate::load_by_id(&backend_type)
        .unwrap_or_else(crate::templates::ProviderTemplate::load);

    let provider_opt2 = cfg.providers.iter().find(|p| p.id == backend_type);
    let provider_params = provider_opt2.map(|p| &p.params);

    let param_defs_ref: Option<&[crate::types::ParamDef]> =
        provider_opt2.map(|p| p.param_definitions.as_slice());

    let mut config = template.apply_provider_defaults(&config, provider_params);
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

    let gpu_mask_msg = format!("[GPU_MASK] provider={} split_mode=\"{}\" test_has_split={} -> CUDA_VISIBLE_DEVICES={}", backend_type, config.split_mode, test_has_split, gpu_mask);
    eprintln!("{}", gpu_mask_msg);
    // SANITY-BOX — route GPU mask info to sanity box
    app.log_hub.emit_sanity_log("warn", &gpu_mask_msg);

    crate::config::validate_provider_binary(binary_path.to_str().unwrap_or(""))?;
    crate::config::validate_model_path(&config.model_path)?;

    let stack = app.stack.lock().await;
    let slot_idx = stack.find_idle_slot().ok_or("All 4 slots are occupied")?;

    let slot_port = if config.port == 0 {
        stack.get_slot(slot_idx).map(|s| s.port).unwrap_or(config.port)
    } else {
        config.port
    };

    config.port = slot_port;

    drop(stack);

    let ps_script = format!(
        r"$pids = netstat -ano | Select-String ':{0} ' | ForEach-Object {{ ($_ -split '\s+')[-1] }}; $pids | Where-Object {{ $_.Length -gt 0 -and $_ -ne '0' }} | ForEach-Object {{ taskkill /F /PID $_ 2>$null }}",
        slot_port
    );
    let _ = tokio::process::Command::new("powershell")
        .args(&["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &ps_script])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .await;

    tokio::time::sleep(Duration::from_millis(300)).await;

    let mut stack = app.stack.lock().await;

    let provider_display_name = backend_type.clone();

    let cmd_args = template.build_command(&config, &gpu_mask, param_defs_ref);
    let launch_cmd = format!("{} {}", binary_path.display(), cmd_args.join(" "));
    eprintln!("\n========== [LAUNCH_CMD] slot={} ==========", slot_idx);
    eprintln!("{}", launch_cmd);
    eprintln!("==========================================\n");
    // SANITY-BOX — route launch command to sanity box
    app.log_hub.emit_sanity_log("warn", &format!("[LAUNCH_CMD] slot={}: {}", slot_idx, launch_cmd));
    
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(r"C:\tmp\blackwell-launch.log") {
        use std::io::Write;
        let _ = writeln!(f, "\n[{}] slot={} CMD:\n{}\n", chrono::Local::now().format("%H:%M:%S%.3f"), slot_idx, launch_cmd);
    }

    app.log_hub.emit_system_event(slot_idx, &config.alias, "Engine launching...").await;

    let ctx_size_int = crate::templates::ProviderTemplate::ctx_to_int_str(&config.ctx_size)
        .parse::<usize>().unwrap_or(32768);

    // Spawn engine and get ConPTY output receiver for unified reader
    let conpty_rx = match stack.load_slot_with_args(slot_idx, &config, &binary_path, gpu_mask.clone(), cmd_args.clone(), provider_display_name.clone(), backend_type.clone()).await {
        Ok(rx) => rx,
        Err(e) => return Err(e),
    };

    eprintln!("[LAUNCH] slot={} ConPTY output channel ready", slot_idx);

    // Create internal fusion event channel (unified reader → fusion HTTP poller)
    let (fusion_tx, fusion_rx) = tokio::sync::mpsc::unbounded_channel::<engine_perf::FusionEvent>();

    // Spawn unified reader — single-pass ConPTY consumer with restart loop
    let unified_config = engine_perf::UnifiedReaderConfig {
        log_hub: app.log_hub.clone(),
        slot_idx,
        alias: config.alias.clone(),
        ctx_size: ctx_size_int,
        stack: app.stack.clone(),
        fusion_tx,
    };
    engine_perf::spawn_unified_reader(conpty_rx, unified_config);

    // Spawn FUSION HTTP poller — /slots polling + fusion event consumer (no ConPTY dependency)
    {
        let fusion_log_hub = app.log_hub.clone();
        let fusion_alias = config.alias.clone();
        let fusion_port = slot_port;

        tokio::spawn(async move {
            crate::fusion::start_fusion_http_poller(
                fusion_log_hub, fusion_alias, fusion_port, ctx_size_int, config.parallel, config.unified_kv, fusion_rx,
            ).await;
        });
    }

    let model_name = config.model_path.rsplit('/').next().unwrap_or("unknown").to_string();

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
    let (slot_idx, port) = {
        let mut stack = app.stack.lock().await;
        let slot_count = stack.slots.len();
        let idx = (0..slot_count).find(|&i| {
            stack.get_slot(i).map_or(false, |s| s.alias == alias)
        }).ok_or(format!("Engine '{}' not found", alias))?;
        let port = stack.get_slot(idx).map(|s| s.port).unwrap_or(0);
        (idx, port)
    };

    // Cancel fusion monitor BEFORE stopping the slot — prevents race with channel close
    crate::fusion::stop_fusion_task(port).await;

    {
        let mut stack = app.stack.lock().await;
        stack.stop_slot(slot_idx).await?;
    }

    app.log_hub.emit("slot-cleared", &serde_json::json!({ "slot": slot_idx }));

    Ok(format!("Engine {} stopped", alias))
}

pub async fn stop_engine_by_alias(
    alias: String,
    stack: Arc<Mutex<EngineStack>>,
) -> Result<usize, String> {
    let (idx, port) = {
        let mut s = stack.lock().await;
        let slot_count = s.slots.len();
        let idx = (0..slot_count)
            .find(|&i| s.get_slot(i).map_or(false, |sl| sl.alias == alias))
            .ok_or_else(|| format!("Engine '{}' not found", alias))?;
        let port = s.get_slot(idx).map(|s| s.port).unwrap_or(0);
        (idx, port)
    };
    // Cancel fusion before stopping slot
    crate::fusion::stop_fusion_task(port).await;
    {
        let mut s = stack.lock().await;
        s.stop_slot(idx).await?;
    }
    Ok(idx)
}

#[tauri::command]
pub async fn stop_all_engines(app: tauri::State<'_, AppContext>) -> Result<String, String> {
    let stopped_ports = {
        let mut stack = app.stack.lock().await;
        let slot_count = stack.slots.len();

        let mut ports_to_stop = Vec::new();
        for i in 0..slot_count {
            if !stack.get_slot(i).map_or(true, |s| matches!(s.status, SlotStatus::Idle)) {
                let port = stack.get_slot(i).map(|s| s.port).unwrap_or(0);
                ports_to_stop.push(port);
            }
        }

        // Cancel all fusion monitors BEFORE stopping slots
        for port in &ports_to_stop {
            crate::fusion::stop_fusion_task(*port).await;
        }

        let mut stopped = Vec::new();
        for i in 0..slot_count {
            if !stack.get_slot(i).map_or(true, |s| matches!(s.status, SlotStatus::Idle)) {
                let _ = stack.stop_slot(i).await;
                stopped.push(i);
            }
        }
        ports_to_stop
    }; // Lock released

    for _ in &stopped_ports {
        app.log_hub.emit("slot-cleared", &serde_json::json!({ "slot": 0 }));
    }

    Ok(format!("All {} engines stopped", stopped_ports.len()))
}

/// Stops all running engines for a specific provider (by backend_type).
#[tauri::command]
pub async fn stop_engines_by_provider(provider_id: String, app: tauri::State<'_, AppContext>) -> Result<String, String> {
    let stopped_info = {
        let mut stack = app.stack.lock().await;
        let mut ports = Vec::new();
        for i in 0..stack.slots.len() {
            if let Some(slot) = &stack.get_slot(i) {
                if slot.backend_type == provider_id && !matches!(slot.status, SlotStatus::Idle) {
                    ports.push(slot.port);
                }
            }
        }
        // Cancel fusion monitors BEFORE stopping slots
        for port in &ports {
            crate::fusion::stop_fusion_task(*port).await;
        }
        let stopped = stack.stop_slots_by_provider(&provider_id).await;
        (stopped, ports)
    };

    for slot_idx in &stopped_info.0 {
        app.log_hub.emit("slot-cleared", &serde_json::json!({ "slot": slot_idx }));
    }

    Ok(format!("Stopped {} engine(s) for '{}'", stopped_info.0.len(), provider_id))
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

    let mut stack = app.stack.lock().await;
    stack.kill_all().await;
    Ok(())
}

// ── Helpers ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_template(provider_id: Option<String>) -> Result<crate::templates::ProviderTemplate, String> {
    let id = provider_id.unwrap_or_else(|| "ggml-stable".to_string());

    // Try loading by specific ID first
    if let Some(template) = crate::templates::ProviderTemplate::load_by_id(&id) {
        return Ok(template);
    }

    // Fallback: load default template (ggml-stable)
    Ok(crate::templates::ProviderTemplate::load())
}

#[tauri::command]
pub fn get_template_for_provider(provider_id: String) -> Result<crate::templates::ProviderTemplate, String> {
    let metas = crate::config::load_provider_meta();
    let meta = metas.iter().find(|m| m.id == provider_id);
    let template_type = crate::config::resolve_template_type(&provider_id, meta.map(|m| &m.template_type));

    let bundle = crate::templates::TemplateBundle::default();
    let Some(template_key) = crate::config::template_key_for_type(&template_type) else {
        return Err(format!("No genesis template for type '{}' — cannot reset", template_type));
    };

    Ok(bundle.templates.get(template_key).cloned().ok_or("Unknown provider")?)
}

#[tauri::command]
pub async fn preview_launch_command(
    config: EngineConfig,
    provider_id: Option<String>,
    app: tauri::State<'_, AppContext>,
) -> Result<String, String> {
    let backend_type = provider_id.unwrap_or_else(|| {
        if config.backend_type.is_empty() { "ggml-stable".to_string() } else { config.backend_type.clone() }
    });

    let cfg = {
        let guard = app.config.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };

    let binary_path = engine_utils::find_provider_binary(&cfg, &backend_type, &config.binary_profile);
    let template = crate::templates::ProviderTemplate::load_by_id(&backend_type)
        .unwrap_or_else(crate::templates::ProviderTemplate::load);

    let provider_opt_prev = cfg.providers.iter().find(|p| p.id == backend_type);
    let provider_params_pv = provider_opt_prev.map(|p| &p.params);
    let param_defs_pv: Option<&[crate::types::ParamDef]> =
        provider_opt_prev.map(|p| p.param_definitions.as_slice());

    let config = template.apply_provider_defaults(&config, provider_params_pv);

    let gpu_count = detect_gpu_count();
    let gpu_mask = compute_gpu_mask(&config, gpu_count, false);

    let cmd_args = template.build_command(&config, &gpu_mask, param_defs_pv);
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

fn detect_mmproj(model_path: &str) -> (u64, bool) {
    let p = PathBuf::from(model_path);
    if let Some(dir) = p.parent() {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let fname = entry.file_name();
                let fname_str = fname.to_string_lossy().to_lowercase();
                if fname_str.contains("mmproj") && !fname_str.ends_with(".gguf") {
                    if let Ok(meta) = std::fs::metadata(entry.path()) {
                        return (meta.len(), true);
                    }
                }
            }
        }
    }
    (0, false)
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

    let backend_type = _provider_id.unwrap_or_else(|| "ggml-stable".to_string());
    let binary_path = engine_utils::find_provider_binary(&cfg, &backend_type, "");

    // Try provider-specific fit binary first, then fallback (for IK providers using GGML's binary)
    let fit_binary = fit_scanner::find_fit_binary(binary_path.to_str().unwrap_or(""))
        .or_else(|| fit_scanner::find_fallback_fit_binary())
        .ok_or_else(|| "llama-fit-params.exe not found — ensure provider is built".to_string())?;

    // Parse context size to integer tokens
    let ctx_int = crate::templates::ProviderTemplate::ctx_to_int_str(&ctx_size)
        .parse::<usize>().unwrap_or(8192);

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
        .or_else(|| fit_scanner::find_fallback_fit_binary())
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
pub fn get_mmproj_size_mib(model_path: String) -> f64 {
    fit_scanner::get_mmproj_size_mib(&model_path)
}

#[tauri::command]
pub async fn get_binary_build_info(binary_path: String) -> Result<crate::types::BuildInfo, String> {
    let path = PathBuf::from(&binary_path);

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
        Ok(o) => {
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
    crate::config::persist_provider_meta(&cfg.providers).map_err(|e| e.to_string())
}

// ── GGUF Metadata Scanner Commands ────────────────────────────────────────

#[tauri::command]
pub async fn scan_model_metadata_cmd(
    model_path: String,
    provider_id: Option<String>,
    app: tauri::State<'_, AppContext>,
) -> Result<crate::types::ModelEntry, String> {
    let pid = provider_id.unwrap_or_else(|| "ggml-stable".to_string());
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
        let pid = provider_id.unwrap_or_else(|| "ggml-stable".to_string());
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

