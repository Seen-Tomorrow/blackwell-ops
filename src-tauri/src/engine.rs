use serde::Serialize;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::sync::broadcast; // For fit scanner progress channel


use crate::engine_stack::SlotStatus;
use crate::config::AppConfig;
use crate::engine_stack::EngineStack;
use crate::log_hub::LogHub;
use crate::output_console::{
    format_console_completion, BlackwellOutputConsoleCategory, BlackwellOutputConsoleLineStyle,
    BlackwellOutputConsoleManager,
};
use crate::types::{EngineConfig, ModelEntry, ModelMetadata};
use crate::types::StackEntry;

const DEFAULT_BASE_PORT: u16 = 8080;
const PRIVILEGED_PORT_THRESHOLD: u16 = 1024;
const MAX_PORT_SCAN_RANGE: u16 = 512;

/// Pick the next free engine port at or above `base_port`, skipping stack reservations,
/// lock-file ownership, and TCP listeners already held by live stack engines.
async fn pick_next_engine_port(
    base_port: u16,
    used_ports: &HashSet<u16>,
    live_pids: &HashSet<u32>,
) -> u16 {
    let end = base_port.saturating_add(MAX_PORT_SCAN_RANGE);
    for port in base_port..=end {
        if port <= PRIVILEGED_PORT_THRESHOLD || used_ports.contains(&port) {
            continue;
        }
        if !crate::engine_utils::is_port_in_use(port).await {
            return port;
        }
        if let Some(listener_pid) = crate::engine_utils::get_listening_pid(port).await {
            if live_pids.contains(&listener_pid) {
                continue;
            }
        }
        return port;
    }
    base_port
}

use crate::fit_scanner;
use crate::telemetry;
use crate::telemetry::detect_gpu_count;
use crate::fusion;
use crate::model_catalog;
use crate::model_cache;
use crate::engine_utils;

/// Auto-hide SPECULATIVE-DECODING params if the model doesn't support MTP.
/// Cache-only lookup — models always have cached metadata from library/single scan.
fn guard_speculative_decoding(
    user_params: Vec<crate::types::UserEditedTemplateParam>,
    model_path: &str,
) -> Vec<crate::types::UserEditedTemplateParam> {
    let has_mtp = if let Some(meta) = model_cache::get_cached(model_path) {
        meta.nextn_predict_layers > 0
    } else {
        false // No cache — default to non-MTP, safe fallback
    };

    if has_mtp {
        return user_params;
    }

    let mut filtered = user_params;
    for p in &mut filtered {
        if p.ui_group == "SPECULATIVE-DECODING" && !p.hidden {
            p.hidden = true;
        }
    }
    filtered
}

pub struct AppContext {
    pub stack: Arc<Mutex<EngineStack>>,
    pub log_hub: LogHub,
    pub config: Arc<std::sync::Mutex<AppConfig>>,
    /// Cancellation flag for in-progress library scans.
    pub fit_scan_cancel: Arc<Mutex<Arc<AtomicBool>>>,

    /// Central manager for the Blackwell Output Console (power-user tabbed output system).
    /// This is the single source of truth for all text streams shown in the Blackwell Output Console.
    pub blackwell_output_console_manager: BlackwellOutputConsoleManager,
}

// ── Model Catalog (multi-path merge via model_catalog module) ───────

#[tauri::command]
pub async fn list_models(
    config: tauri::State<'_, Arc<std::sync::Mutex<AppConfig>>>,
    downloads: tauri::State<'_, Arc<tokio::sync::RwLock<crate::download_manager::DownloadManager>>>,
) -> Result<Vec<ModelEntry>, String> {
    let paths = {
        let cfg = config.lock().map_err(|e| e.to_string())?;
        crate::config::get_model_paths(&cfg)
    };

    if paths.is_empty() {
        return Ok(Vec::new());
    }

    let exclude_paths = {
        let dm = downloads.read().await;
        dm.in_progress_dest_paths()
    };

    let (entries, _conflicts) = model_catalog::merge_catalogs(
        &paths,
        None,
        Some(&exclude_paths),
    )?;
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
) -> Result<StackEntry, String> {
    let backend_type = if config.backend_type.is_empty() {
        crate::config::DEFAULT_PROVIDER_ID.to_string()
    } else {
        config.backend_type.clone()
    };

    let cfg = {
        let guard = app.config.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };

    let binary_path = engine_utils::find_provider_binary(&cfg, &backend_type, &config.binary_profile)?;

    let template = crate::templates::ProviderTemplate::load_for_provider(&backend_type)?;

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
    let gpu_mask = engine_utils::compute_gpu_mask(&config, gpu_count, test_has_split);

    let gpu_mask_msg = format!("[GPU_MASK] provider={} split_mode=\"{}\" test_has_split={} -> CUDA_VISIBLE_DEVICES={}", backend_type, config.get_param_str("split").unwrap_or_default(), test_has_split, gpu_mask);
    app.log_hub.emit_console_line(BlackwellOutputConsoleCategory::Debug, &gpu_mask_msg, BlackwellOutputConsoleLineStyle::Warning);

    crate::config::validate_provider_binary(binary_path.to_str().unwrap_or(""))?;
    crate::config::validate_model_path(&config.model_path)?;

    // Compute port dynamically from provider's base_port with global collision avoidance
    let provider_base_port = config.get_param_str("base_port")
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(DEFAULT_BASE_PORT);

    // Validate base_port is in safe range (avoid privileged ports below PRIVILEGED_PORT_THRESHOLD)
    if provider_base_port <= PRIVILEGED_PORT_THRESHOLD {
        return Err(format!("base_port {} is too low — must be > {}", provider_base_port, PRIVILEGED_PORT_THRESHOLD));
    }

    // Resolve unique alias before reserving a slot (backend is authoritative).
    {
        let stack = app.stack.lock().await;
        if stack.alias_in_use(&config.alias) {
            let base = config.alias.clone();
            let mut suffix = 2u32;
            loop {
                let candidate = format!("{}_{}", base, suffix);
                if !stack.alias_in_use(&candidate) {
                    config.alias = candidate;
                    break;
                }
                suffix += 1;
                if suffix > 99 {
                    return Err(format!("Could not find a free alias for '{}'", base));
                }
            }
        }
    }

    let (slot_idx, slot_port, live_pids) = {
        let stack = match tokio::time::timeout(Duration::from_secs(5), app.stack.lock()).await {
            Ok(guard) => guard,
            Err(_) => {
                log::error!("[launch_engine] stack lock timeout — possible deadlock");
                return Err("Stack lock timeout — possible deadlock. Another task may be holding the lock.".to_string());
            }
        };
        let slot_idx = stack.find_idle_slot().ok_or("All engine slots are occupied")?;
        let mut used_ports = stack.reserved_ports();
        used_ports.extend(crate::engine_port_lock::occupied_ports_from_locks());
        let live_pids = stack.live_engine_pids();
        let slot_port =
            pick_next_engine_port(provider_base_port, &used_ports, &live_pids).await;
        stack.reserve_slot(slot_idx, &config.alias, slot_port)?;
        stack.emit_stack_changed();
        (slot_idx, slot_port, live_pids)
    };

    config.port = slot_port;

    if let Err(e) =
        crate::engine_port_lock::reclaim_our_ghost_or_fail(slot_port, &binary_path, &live_pids)
            .await
    {
        {
            let stack = app.stack.lock().await;
            stack.release_reserved_slot(slot_idx);
            stack.emit_stack_changed();
        }
        return Err(e);
    }

    let provider_display_name = backend_type.clone();

    // Guard: auto-hide SPECULATIVE-DECODING params for non-MTP models — prevents CLI crash
    let final_user_params = guard_speculative_decoding(user_params, &config.model_path);

    let supports_fusion = template.spawn_profile.supports_fusion;
    let fusion_adapter = fusion::resolve_adapter(
        &backend_type,
        provider_opt2
            .map(|p| p.template_type.as_str())
            .unwrap_or(""),
        Some(template.spawn_profile.fusion_adapter.as_str()),
    );
    let cmd_args = template.build_command(&config, &gpu_mask, &final_user_params);
    let launch_cmd = format!(
        "{} {}",
        engine_utils::format_debug_executable(&binary_path),
        cmd_args.join(" ")
    );

    // Emit full launch command to Blackwell Output Console (DEBUG category)
    app.blackwell_output_console_manager.emit_line_to_category(
        crate::output_console::BlackwellOutputConsoleCategory::Debug,
        format!("[LAUNCH_CMD] slot={}: {}", slot_idx, launch_cmd),
        crate::output_console::BlackwellOutputConsoleLineStyle::Command,
    );

    // Launch command logged to Blackwell Output Console instead of eprintln!

    #[cfg(debug_assertions)]
    {
        let log_path = std::env::temp_dir().join("blackwell-launch.log");
        match std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
            Ok(mut f) => {
                use std::io::Write;
                if let Err(e) = writeln!(f, "\n[{}] slot={} CMD:\n{}\n", chrono::Local::now().format("%H:%M:%S%.3f"), slot_idx, launch_cmd) {
                    log::warn!("Failed to write launch log: {}", e);
                }
                if let Err(e) = f.flush() { log::warn!("Failed to flush launch log: {}", e); }
            },
            Err(e) => log::warn!("Failed to open launch log at {}: {}", log_path.display(), e),
        }
    }

    // Route launch status to Blackwell Output Console
    app.blackwell_output_console_manager.emit_line_to_category(
        crate::output_console::BlackwellOutputConsoleCategory::Engines,
        format!("[{}] Engine launching...", config.alias),
        crate::output_console::BlackwellOutputConsoleLineStyle::Normal,
    );

    app.blackwell_output_console_manager.emit_line_to_category(
        crate::output_console::BlackwellOutputConsoleCategory::Engines,
        format!("[{}] Loading model...", config.alias),
        crate::output_console::BlackwellOutputConsoleLineStyle::Normal,
    );

    let ctx_size_int = config.get_param_str("ctx")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(32768);

    // Promote stack slot LOADING→RUNNING (idempotent — GGML /health can fire before model load).
    fn make_on_ready(
        stack: Arc<tokio::sync::Mutex<EngineStack>>,
        slot_idx: usize,
    ) -> Arc<dyn Fn() + Send + Sync> {
        Arc::new(move || {
            let s_clone = stack.clone();
            let si = slot_idx;
            tokio::spawn(async move {
                let should_emit = {
                    let s = s_clone.lock().await;
                    let promote = {
                        if let Some(mut slot) = s.get_slot(si) {
                            use crate::engine_stack::SlotStatus;
                            if matches!(slot.status, SlotStatus::Loading) {
                                slot.status = SlotStatus::Running;
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    };
                    promote
                };
                if should_emit {
                    let s = s_clone.lock().await;
                    s.emit_stack_changed();
                }
            });
        })
    }

    // Spawn engine with auto-retry (once) on immediate crash
    let stack_for_ready = app.stack.clone();
    let slot_for_ready = slot_idx;
    let mut last_err = None;
    for attempt in 0..2 {
        let result = EngineStack::load_slot(
            slot_idx, &config, &binary_path, gpu_mask.clone(), cmd_args.clone(),
            provider_display_name.clone(), backend_type.clone(), supports_fusion, fusion_adapter,
            &app.stack,
            app.log_hub.clone(),
            make_on_ready(stack_for_ready.clone(), slot_for_ready),
        ).await;

        match result {
            Ok(()) => {
                last_err = None;
                break;
            }
            Err(e) => {
                last_err = Some(e);
                if attempt == 0 {
                    app.blackwell_output_console_manager.emit_line_to_category(
                        crate::output_console::BlackwellOutputConsoleCategory::Error,
                        format!("[{}] [RETRY] Launch failed: {} — retrying...", config.alias, last_err.as_ref().unwrap()),
                        crate::output_console::BlackwellOutputConsoleLineStyle::Warning,
                    );
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }
    }

    if let Some(e) = last_err {
        {
            let stack = app.stack.lock().await;
            stack.release_reserved_slot(slot_idx);
            stack.emit_stack_changed();
        }
        return Err(e);
    }

    // Spawn FUSION brain only for providers that declare supports_fusion in spawn_profile
    if supports_fusion {
        let fusion_log_hub = app.log_hub.clone();
        let fusion_alias = config.alias.clone();
        let fusion_port = slot_port;
        let fusion_parallel = config.get_parallel();
        let fusion_unified_kv = config.get_unified_kv();
        let fusion_provider_id = backend_type.clone();

        tokio::spawn(async move {
            fusion::start_brain(
                fusion_log_hub,
                fusion::FusionConfig {
                    alias: fusion_alias,
                    slot_idx,
                    port: fusion_port,
                    ctx_total: ctx_size_int,
                    parallel: fusion_parallel,
                    unified_kv: fusion_unified_kv,
                    provider_id: fusion_provider_id,
                    adapter: fusion_adapter,
                },
            ).await;
        });
    }

    let model_name = engine_utils::extract_model_name(&config.model_path);

    // Emit stack-changed push event so frontend gets instant update without polling
    {
        let stack = app.stack.lock().await;
        stack.emit_stack_changed();
    }

    Ok(StackEntry {
        idx: slot_idx,
        alias: config.alias.clone(),
        model_name,
        port: slot_port,
        gpu: gpu_mask,
        status: "LOADING".to_string(),
        slot_id: slot_idx as u32,
        provider_type: backend_type,
        binary_profile: if config.binary_profile.is_empty() {
            crate::config::DEFAULT_BINARY_PROFILE.to_string()
        } else {
            config.binary_profile.clone()
        },
        model_path: config.model_path.clone(),
        vram_mib: 0.0,
        gpu_breakdown_mib: None,
        n_ctx: ctx_size_int,
        provider_name: provider_display_name,
        build_info: None,
        supports_fusion,
    })
}



#[tauri::command]
pub async fn stop_engine_slot(slot_idx: usize, app: tauri::State<'_, AppContext>) -> Result<String, String> {
    let alias = {
        let stack = app.stack.lock().await;
        let slot = stack.get_slot(slot_idx).ok_or(format!("Slot {} not found", slot_idx))?;
        if matches!(slot.status, SlotStatus::Idle) {
            return Err(format!("Slot {} is already idle", slot_idx));
        }
        slot.alias.clone()
    };

    EngineStack::stop_slot(slot_idx, &app.stack).await?;
    Ok(format!("Engine {} (slot {}) stopped", alias, slot_idx))
}

#[tauri::command]
pub async fn stop_engine(alias: String, app: tauri::State<'_, AppContext>) -> Result<String, String> {
    let slot_indices: Vec<usize> = {
        let stack = app.stack.lock().await;
        let slot_count = stack.slots.len();
        (0..slot_count)
            .filter(|&i| {
                stack.get_slot(i).map_or(false, |s| {
                    s.alias == alias && !matches!(s.status, SlotStatus::Idle)
                })
            })
            .collect()
    };

    if slot_indices.is_empty() {
        return Err(format!("Engine '{}' not found", alias));
    }

    for idx in slot_indices {
        EngineStack::stop_slot(idx, &app.stack).await?;
    }

    Ok(format!("Engine {} stopped", alias))
}


#[tauri::command]
pub async fn stop_all_engines(app: tauri::State<'_, AppContext>) -> Result<String, String> {
    let stopped = EngineStack::stop_all_parallel(&app.stack).await;

    if !stopped.is_empty() {
        app.log_hub.emit(
            "engines-all-stopped",
            &serde_json::json!({ "slots": stopped }),
        );
    }

    Ok(format!("All {} engines stopped", stopped.len()))
}

/// Stops all running engines for a specific provider (by backend_type).
#[tauri::command]
pub async fn stop_engines_by_provider(provider_id: String, app: tauri::State<'_, AppContext>) -> Result<String, String> {
    let stopped = EngineStack::stop_slots_by_provider_parallel(&provider_id, &app.stack).await;

    Ok(format!("Stopped {} engine(s) for '{}'", stopped.len(), provider_id))
}

#[tauri::command]
pub async fn get_stack_status(app: tauri::State<'_, AppContext>) -> Result<Vec<StackEntry>, String> {
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

    let entries: Vec<StackEntry> = engine_entries.into_iter()
        .map(|e| {
            let build_info = if e.status == "RUNNING" && !e.provider_type.is_empty() {
                build_map.get(&e.provider_type).cloned().cloned()
                    .or_else(|| build_map.get(&format!("{}:stable", e.provider_type)).cloned().cloned())
            } else {
                None
            };
            StackEntry {
                idx: e.idx,
                alias: e.alias.clone(),
                model_name: e.model_name.clone(),
                port: e.port,
                gpu: e.gpu.clone(),
                status: e.status.clone(),
                slot_id: e.slot_id,
                provider_type: e.provider_type.clone(),
                binary_profile: e.binary_profile.clone(),
                model_path: e.model_path.clone(),
                vram_mib: e.vram_mib,
                gpu_breakdown_mib: e.gpu_breakdown_mib.clone(),
                n_ctx: e.n_ctx,
                provider_name: e.provider_name.clone(),
                build_info,
                supports_fusion: e.supports_fusion,
            }
        })
        .collect();

    Ok(entries)
}

#[tauri::command]
pub async fn clean_exit(app: tauri::State<'_, AppContext>) -> Result<(), String> {
    log::info!("Clean exit requested — killing all orphaned processes");

    // Stop fusion brains first to prevent orphaned HTTP polling
    fusion::stop_all_brains().await;

    // kill_all is self-locking — no stack lock needed
    EngineStack::kill_all(&app.stack).await;
    Ok(())
}

// ── Helpers ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_template(provider_id: Option<String>) -> Result<crate::templates::ProviderTemplate, String> {
    let id = provider_id.unwrap_or_else(|| crate::config::DEFAULT_PROVIDER_ID.to_string());

    crate::templates::ProviderTemplate::load_for_provider(&id)
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

    let binary_path = engine_utils::find_provider_binary(&cfg, &backend_type, &config.binary_profile)?;
    let template = crate::templates::ProviderTemplate::load_for_provider(&backend_type)?;

    let provider_opt_prev = cfg.providers.iter().find(|p| p.id == backend_type);
    let user_params: Vec<crate::types::UserEditedTemplateParam> = provider_opt_prev
        .map(|p| p.user_edited_template_params.clone())
        .unwrap_or_default();

    let gpu_count = detect_gpu_count();
    let gpu_mask = engine_utils::compute_gpu_mask(&config, gpu_count, false);

    // Guard: auto-hide SPECULATIVE-DECODING params for non-MTP models — prevents CLI crash
    let final_user_params = guard_speculative_decoding(user_params, &config.model_path);

    let cmd_args = template.build_command(&config, &gpu_mask, &final_user_params);
    Ok(format!(
        "{} {}",
        engine_utils::format_debug_executable(&binary_path),
        cmd_args.join(" ")
    ))
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
    ctx_size: serde_json::Value,
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
    let fit_binary = fit_scanner::resolve_fit_binary(&cfg, &backend_type, "")?;

    // Resolve ctx — slider sends raw number, legacy string ("32k") still handled
    let ctx_int: usize = match &ctx_size {
        serde_json::Value::Number(n) => n.as_u64().map(|v| v as usize).unwrap_or(32768),
        _ => ctx_size.to_string().parse::<usize>().unwrap_or(32768), // fallback for old "32k" format — will fail parse, default kicks in
    };

    // Derive GPU mask from device + split_mode — same logic as launch_engine
    let gpu_count = detect_gpu_count();
    let gpu_mask = engine_utils::compute_gpu_mask_from_params(&device, &split_mode, gpu_count, false);

    // Build CLI args directly — no template involvement
    let args = fit_scanner::build_fit_command(
        &model_path, ctx_int, &kv_quant, batch, _ubatch, parallel, &split_mode,
    );
    let fit_result = fit_scanner::scan_single_anchor(&fit_binary, &args, &gpu_mask).await;
    match &fit_result {
        Ok(raw) => {
            app.log_hub.emit_console_line(BlackwellOutputConsoleCategory::Utils, &format!("[FIT] {} -> {:.1} MiB", model_path, raw.vram_mib), BlackwellOutputConsoleLineStyle::Normal);
        }
        Err(e) => {
            app.log_hub.emit_console_line(BlackwellOutputConsoleCategory::Error, &format!("[FIT] {} failed: {}", model_path, e), BlackwellOutputConsoleLineStyle::Error);
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

    // Use provided path or ALL configured model paths — resolved the same way as list_models.
    let all_paths = if !model_base.is_empty() {
        vec![crate::config::resolve_stored_model_path(&model_base)]
    } else {
        crate::config::get_model_paths(&cfg)
            .into_iter()
            .map(|p| p.path)
            .collect::<Vec<_>>()
    };

    let fit_binary = match fit_scanner::resolve_fit_binary(&cfg, &provider_id, "") {
        Ok(path) => path,
        Err(e) => {
            app.log_hub.emit_console_line(
                BlackwellOutputConsoleCategory::Error,
                &format!("[FIT-SCAN] {e}"),
                BlackwellOutputConsoleLineStyle::Error,
            );
            return Err(e);
        }
    };

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
        &fit_binary,
        &all_paths,
        parallel_count.max(1),
        total_gpu_mib,
        provider_id.clone(),
        Some(progress_tx),
        cancel_flag,
        Some(app.log_hub.clone()),
    )
    .await;

    let models_with_errors = result
        .results
        .values()
        .filter(|entry| entry.error.is_some())
        .count();
    let summary_style = if models_with_errors > 0 || result.failed > 0 {
        BlackwellOutputConsoleLineStyle::Warning
    } else {
        BlackwellOutputConsoleLineStyle::Success
    };
    app.log_hub.emit_console_line(
        BlackwellOutputConsoleCategory::Utils,
        &format_console_completion(
            "VRAM fit scan complete",
            &format!(
                "{}/{} models ({} failed, {} with scan errors)",
                result.completed,
                result.total_models,
                result.failed,
                models_with_errors
            ),
        ),
        summary_style,
    );

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
            cuda_architectures: None,
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
        cuda_architectures: None,
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
        engine_utils::find_provider_binary(&cfg, &pid, "")?.to_string_lossy().to_string()
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
    let hf_id = hf_meta_for_entry.as_ref().map(|h| h.hf_model_id.clone());
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
        hf_model_id: hf_id,
    })
}

#[tauri::command]
pub async fn scan_all_models_cmd(
    _model_base: Option<String>,
    provider_id: Option<String>,
    concurrency: Option<usize>,
    app: tauri::State<'_, AppContext>,
) -> Result<usize, String> {
    let (bin_str, all_paths, total) = {
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        let pid = provider_id.unwrap_or_else(|| crate::config::DEFAULT_PROVIDER_ID.to_string());
        let binary_path = engine_utils::find_provider_binary(&cfg, &pid, "")?;
        // Use all configured paths instead of single model_base
        let paths = crate::config::get_model_paths(&cfg);
        let (catalog, _) = model_catalog::merge_catalogs(&paths, Some(&app.log_hub), None)?;
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
    let concurrency = concurrency.unwrap_or(2); // default 2x, frontend can pass 4 or 8
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
        if handles.len() >= concurrency {
            let (_, p, h) = handles.remove(0);
            handle_scan_result_with_sanity(h.await, &p, &mut scanned, &mut failed, &log_hub);

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
        handle_scan_result(h.await, &p, &mut scanned, &mut failed);

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

    // Emit complete event + docked-console banner
    let final_scanned = scanned;
    let final_failed = failed;
    let lh = log_hub.clone();
    tokio::spawn(async move {
        lh.emit("gguf-scan-complete", &serde_json::json!({
            "scanned": final_scanned,
            "failed": final_failed,
            "total": total,
        }));
        let style = if final_failed > 0 {
            BlackwellOutputConsoleLineStyle::Warning
        } else {
            BlackwellOutputConsoleLineStyle::Success
        };
        lh.emit_console_line(
            BlackwellOutputConsoleCategory::Utils,
            &format_console_completion(
                "GGUF metadata scan complete",
                &format!("{final_scanned} scanned, {final_failed} failed, {total} total"),
            ),
            style,
        );
    });

    Ok(scanned)
}

/// Handle scan result — correct file size, cache, update counters.
fn handle_scan_result(
    result: Result<Result<ModelMetadata, String>, tokio::task::JoinError>,
    path: &str,
    scanned: &mut usize,
    failed: &mut usize,
) {
    match result {
        Ok(Ok(mut metadata)) => {
            let corrected_size = model_catalog::get_total_model_size(path);
            if corrected_size != metadata.file_size_bytes {
                log::info!("[batch_scan] Corrected file_size for '{}': {} → {}", path, metadata.file_size_bytes, corrected_size);
                metadata.file_size_bytes = corrected_size;
            }
            if let Err(e) = crate::model_cache::set_cached(path, metadata.clone()) {
                log::warn!("Failed to cache {}: {}", path, e);
            }
            *scanned += 1;
        }
        Ok(Err(e)) => {
            log::warn!("[SCAN] {} failed: {}", path, e);
            *failed += 1;
        }
        Err(e) => {
            log::warn!("[SCAN] {} task panicked: {}", path, e);
            *failed += 1;
        }
    }
}

/// Handle scan result with sanity box emission.
fn handle_scan_result_with_sanity(
    result: Result<Result<ModelMetadata, String>, tokio::task::JoinError>,
    path: &str,
    scanned: &mut usize,
    failed: &mut usize,
    log_hub: &LogHub,
) {
    match result {
        Ok(Ok(mut metadata)) => {
            let corrected_size = model_catalog::get_total_model_size(path);
            if corrected_size != metadata.file_size_bytes {
                log::info!("[batch_scan] Corrected file_size for '{}': {} → {}", path, metadata.file_size_bytes, corrected_size);
                metadata.file_size_bytes = corrected_size;
            }
            if let Err(e) = crate::model_cache::set_cached(path, metadata.clone()) {
                log::warn!("Failed to cache {}: {}", path, e);
            }
            *scanned += 1;
        }
        Ok(Err(e)) => {
            let msg = format!("[SCAN] {} failed: {}", path, e);
            log::warn!("{}", msg);
            log_hub.emit_console_line(BlackwellOutputConsoleCategory::Error, &msg, BlackwellOutputConsoleLineStyle::Error);
            *failed += 1;
        }
        Err(e) => {
            let msg = format!("[SCAN] {} task panicked: {}", path, e);
            log::warn!("{}", msg);
            log_hub.emit_console_line(BlackwellOutputConsoleCategory::Error, &msg, BlackwellOutputConsoleLineStyle::Error);
            *failed += 1;
        }
    }
}

#[tauri::command]
pub fn cancel_gguf_scan_cmd() {
    crate::gguf_scan::GGUF_SCAN_CANCEL.store(true, std::sync::atomic::Ordering::Relaxed);
}

#[tauri::command]
pub async fn clear_model_cache_cmd() -> Result<(), String> {
    crate::model_cache::clear_cache()
}

