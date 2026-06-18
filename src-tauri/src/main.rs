#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;
mod disk_io_pdh;
mod telemetry;
mod intel;
mod config;
mod engine_stack;
mod log_hub;
mod hf_api;
mod types;

mod templates;
mod nvml_probe;
mod fit_scanner;
mod vram_learn;
mod mobile_bridge;
mod bench_prompts;
mod burst_bench;
mod bench_pp_burst;
mod bench_cancel;
mod gguf_scan;
mod model_cache;
mod download_manager;
mod model_catalog;
mod engine_utils;
mod engine_port_lock;
mod fusion_brain;
mod fusion_poller;
mod fusion_logparser;
mod provider_mgmt;
mod llama_catalog;
mod binary_update;
mod secrets;

#[cfg(feature = "reactor11")]
pub mod features;
mod foundry_toolchain;
mod reactor_foundry;
mod output_console;


use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tokio::sync::{Mutex, RwLock};
use crate::output_console::BlackwellOutputConsoleManager;

// ── HF Search Commands ────────────────────────────────────────────────

#[tauri::command]
async fn search_hf_models(
    query: String,
    vram_limit_gb: Option<u32>,
    sort: Option<String>,
    limit: Option<usize>,
) -> Result<crate::types::HfSearchResponse, String> {
    let filters = config::normalize_hf_search_inputs(query, vram_limit_gb, sort, limit)?;
    let hf_token = secrets::get_secret("hf_token")?;
    hf_api::search_models(&filters, hf_token.as_deref()).await
}

#[tauri::command]
async fn get_hf_model_info(model_id: String) -> Result<crate::types::HfModelInfo, String> {
    config::validate_hf_model_id(&model_id)?;
    let hf_token = secrets::get_secret("hf_token")?;
    hf_api::get_model_info(&model_id, hf_token.as_deref()).await
}

#[tauri::command]
async fn check_hf_repo_updates(
    config: tauri::State<'_, Arc<std::sync::Mutex<config::AppConfig>>>,
    model_id: String,
) -> Result<crate::types::HfRepoUpdateStatus, String> {
    config::validate_hf_model_id(&model_id)?;
    let paths = {
        let cfg = config.lock().map_err(|e| e.to_string())?;
        config::get_model_paths(&cfg)
    };
    let hf_token = secrets::get_secret("hf_token")?;
    hf_api::check_repo_for_updates(&model_id, &paths, hf_token.as_deref()).await
}

#[tauri::command]
async fn check_catalog_hf_updates(
    config: tauri::State<'_, Arc<std::sync::Mutex<config::AppConfig>>>,
) -> Result<Vec<crate::types::CatalogUpdateEntry>, String> {
    let paths = {
        let cfg = config.lock().map_err(|e| e.to_string())?;
        config::get_model_paths(&cfg)
    };
    let hf_token = secrets::get_secret("hf_token")?;
    hf_api::check_catalog_hf_updates(&paths, hf_token.as_deref()).await
}

// ── Model Path Management Commands ────────────────────────────────────

#[tauri::command]
async fn list_model_paths(
    config: tauri::State<'_, Arc<std::sync::Mutex<config::AppConfig>>>,
) -> Result<Vec<crate::types::ModelPathEntry>, String> {
    let cfg = config.lock().map_err(|e| e.to_string())?;
    Ok(config::get_model_paths(&cfg))
}

#[tauri::command]
fn model_library_configured(
    config: tauri::State<'_, Arc<std::sync::Mutex<config::AppConfig>>>,
) -> Result<bool, String> {
    let cfg = config.lock().map_err(|e| e.to_string())?;
    Ok(config::model_library_configured(&cfg))
}

#[tauri::command]
fn validate_model_library(path: String) -> Result<crate::types::ModelLibraryValidation, String> {
    Ok(config::validate_model_library(&path))
}

#[tauri::command]
async fn add_model_path(
    config: tauri::State<'_, Arc<std::sync::Mutex<config::AppConfig>>>,
    path: String,
    label: Option<String>,
) -> Result<(), String> {
    let mut cfg = config.lock().map_err(|e| e.to_string())?;
    config::add_model_path(&mut cfg, path, label);
    config::save_config(&mut cfg).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn remove_model_path(
    config: tauri::State<'_, Arc<std::sync::Mutex<config::AppConfig>>>,
    path: String,
) -> Result<(), String> {
    let mut cfg = config.lock().map_err(|e| e.to_string())?;
    config::remove_model_path(&mut cfg, &path).map_err(|e| e.to_string())?;
    config::save_config(&mut cfg).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn lmstudio_models_available() -> bool {
    config::lm_studio_models_available()
}

#[tauri::command]
fn get_lm_studio_default_path() -> String {
    config::lm_studio_default_path_display()
}

#[tauri::command]
async fn add_lmstudio_model_path(
    config: tauri::State<'_, Arc<std::sync::Mutex<config::AppConfig>>>,
) -> Result<bool, String> {
    let mut cfg = config.lock().map_err(|e| e.to_string())?;
    let added = config::add_lmstudio_model_path(&mut cfg)?;
    if added {
        config::save_config(&mut cfg).map_err(|e| e.to_string())?;
    }
    Ok(added)
}

#[tauri::command]
async fn set_default_model_path(
    config: tauri::State<'_, Arc<std::sync::Mutex<config::AppConfig>>>,
    path: String,
) -> Result<(), String> {
    let mut cfg = config.lock().map_err(|e| e.to_string())?;
    config::set_default_model_path(&mut cfg, &path)?;
    config::save_config(&mut cfg).map_err(|e| e.to_string())?;
    Ok(())
}

// ── Blackwell Output Console Commands ─────────────────────────────────

#[tauri::command]
async fn get_blackwell_output_console_categories() -> Vec<String> {
    use crate::output_console::BlackwellOutputConsoleCategory;
    vec![
        BlackwellOutputConsoleCategory::Engines.identifier().to_string(),
        BlackwellOutputConsoleCategory::Utils.identifier().to_string(),
        BlackwellOutputConsoleCategory::Foundry.identifier().to_string(),
        BlackwellOutputConsoleCategory::Error.identifier().to_string(),
        BlackwellOutputConsoleCategory::General.identifier().to_string(),
        BlackwellOutputConsoleCategory::Debug.identifier().to_string(),
    ]
}

#[tauri::command]
async fn get_blackwell_output_console_buffer_for_category(
    category: String,
    limit: Option<usize>,
    app: tauri::State<'_, AppContext>,
) -> Result<Vec<crate::output_console::BlackwellOutputConsoleTextLine>, String> {
    use crate::output_console::BlackwellOutputConsoleCategory;

    let cat = match category.as_str() {
        "engines" => BlackwellOutputConsoleCategory::Engines,
        "utils" => BlackwellOutputConsoleCategory::Utils,
        "foundry" => BlackwellOutputConsoleCategory::Foundry,
        "error" => BlackwellOutputConsoleCategory::Error,
        "general" => BlackwellOutputConsoleCategory::General,
        "debug" => BlackwellOutputConsoleCategory::Debug,
        _ => return Err("Unknown category".to_string()),
    };

    let lines = app.blackwell_output_console_manager
        .get_recent_lines_for_category(cat, limit.unwrap_or(500));

    Ok(lines)
}

#[tauri::command]
async fn get_blackwell_output_console_latest_line(
    app: tauri::State<'_, AppContext>,
) -> Result<Option<crate::output_console::BlackwellOutputConsoleLatestLine>, String> {
    Ok(app.blackwell_output_console_manager.get_latest_line_across_categories())
}

#[tauri::command]
async fn clear_blackwell_output_console_category(
    category: String,
    app: tauri::State<'_, AppContext>,
) -> Result<(), String> {
    use crate::output_console::BlackwellOutputConsoleCategory;

    let cat = match category.as_str() {
        "engines" => BlackwellOutputConsoleCategory::Engines,
        "utils" => BlackwellOutputConsoleCategory::Utils,
        "foundry" => BlackwellOutputConsoleCategory::Foundry,
        "error" => BlackwellOutputConsoleCategory::Error,
        "general" => BlackwellOutputConsoleCategory::General,
        "debug" => BlackwellOutputConsoleCategory::Debug,
        _ => return Err("Unknown category".to_string()),
    };

    app.blackwell_output_console_manager.clear_category_buffer(cat);
    Ok(())
}

#[tauri::command]
async fn clear_all_blackwell_output_console_buffers(
    app: tauri::State<'_, AppContext>,
) -> Result<(), String> {
    app.blackwell_output_console_manager.clear_all_buffers();
    Ok(())
}

// ── End Blackwell Output Console Commands ─────────────────────────────

#[tauri::command]
async fn emit_to_blackwell_console(
    category: String,
    content: String,
    style: String,
    app: tauri::State<'_, AppContext>,
) -> Result<(), String> {
    use crate::output_console::BlackwellOutputConsoleCategory;
    use crate::output_console::BlackwellOutputConsoleLineStyle;

    let cat = match category.as_str() {
        "engines" => BlackwellOutputConsoleCategory::Engines,
        "utils" => BlackwellOutputConsoleCategory::Utils,
        "foundry" => BlackwellOutputConsoleCategory::Foundry,
        "error" => BlackwellOutputConsoleCategory::Error,
        "general" => BlackwellOutputConsoleCategory::General,
        "debug" => BlackwellOutputConsoleCategory::Debug,
        _ => return Err("Unknown category".to_string()),
    };

    let style = match style.as_str() {
        "Normal" => BlackwellOutputConsoleLineStyle::Normal,
        "Command" => BlackwellOutputConsoleLineStyle::Command,
        "Success" => BlackwellOutputConsoleLineStyle::Success,
        "Warning" => BlackwellOutputConsoleLineStyle::Warning,
        "Error" => BlackwellOutputConsoleLineStyle::Error,
        "Highlight" => BlackwellOutputConsoleLineStyle::Highlight,
        _ => BlackwellOutputConsoleLineStyle::Normal,
    };

    // Split content by newlines and emit each line separately
    for line in content.lines() {
        if !line.is_empty() {
            app.blackwell_output_console_manager.emit_line_to_category(cat, line.to_string(), style);
        }
    }

    Ok(())
}

#[tauri::command]
async fn get_disk_usage(
    config: tauri::State<'_, Arc<std::sync::Mutex<config::AppConfig>>>,
) -> Result<Vec<crate::types::PathDiskUsage>, String> {
    let cfg = config.lock().map_err(|e| e.to_string())?;
    let paths = config::get_model_paths(&cfg);
    Ok(config::calculate_disk_usage(&paths))
}

#[tauri::command]
async fn get_default_download_path(
    config: tauri::State<'_, Arc<std::sync::Mutex<config::AppConfig>>>,
) -> Result<String, String> {
    let cfg = config.lock().map_err(|e| e.to_string())?;
    Ok(config::get_default_download_path(&cfg))
}

// ── Download Manager Commands ────────────────────────────────────────

#[tauri::command]
async fn start_download(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
    config: tauri::State<'_, Arc<std::sync::Mutex<config::AppConfig>>>,
    hf_model_id: String,
    file_name: String,
    url: String,
    total_bytes: u64,
    dest_path: String,
    hf_author: String,
    quant_type: String,
    lfs_oid: String,
) -> Result<String, String> {
    config::validate_hf_model_id(&hf_model_id)?;
    config::validate_download_file_name(&file_name)?;
    config::validate_download_url_matches_model(&url, &hf_model_id, &file_name)?;
    {
        let cfg = config.lock().map_err(|e| e.to_string())?;
        config::validate_download_dest(&dest_path, &cfg)?;
    }

    let mut dm = manager.write().await;
    if dm.has_active_task_for_dest(&dest_path) {
        return Err("A download for this file is already in progress".to_string());
    }
    let task_id = dm.start_download(hf_model_id, file_name, url, total_bytes, dest_path, hf_author, quant_type, lfs_oid, Arc::clone(&manager)).await?;
    drop(dm);

    let _ = app.emit("download-event", serde_json::json!({
        "type": "queued",
        "taskId": task_id,
    }));

    Ok(task_id)
}

/// Download all parts of a quant — single file or full shard set.
#[tauri::command]
async fn start_quant_download(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
    config: tauri::State<'_, Arc<std::sync::Mutex<config::AppConfig>>>,
    hf_model_id: String,
    hf_author: String,
    quant_type: String,
    gguf_file: crate::types::GgufFile,
) -> Result<Vec<String>, String> {
    config::validate_hf_model_id(&hf_model_id)?;
    config::validate_quant_download(&gguf_file, &hf_model_id)?;

    let default_path = {
        let cfg = config.lock().map_err(|e| e.to_string())?;
        config::get_default_download_path(&cfg)
    };

    let parts = gguf_file.download_parts();
    let mut task_ids: Vec<String> = Vec::new();
    let mut skipped_complete = 0usize;
    let mut skipped_active = 0usize;

    let mut dm = manager.write().await;
    for part in parts {
        let dest_path = config::build_quant_dest_path(&default_path, &hf_model_id, &part.path_in_repo)?;
        {
            let cfg = config.lock().map_err(|e| e.to_string())?;
            config::validate_download_dest(&dest_path, &cfg)?;
        }

        if config::quant_part_already_downloaded(&dest_path, part.size_bytes, &part.lfs_oid) {
            skipped_complete += 1;
            continue;
        }
        if dm.has_active_task_for_dest(&dest_path) {
            skipped_active += 1;
            continue;
        }

        let task_id = dm
            .start_download(
                hf_model_id.clone(),
                part.file_name.clone(),
                part.url.clone(),
                part.size_bytes,
                dest_path,
                hf_author.clone(),
                quant_type.clone(),
                part.lfs_oid.clone(),
                Arc::clone(&manager),
            )
            .await?;
        task_ids.push(task_id);
    }
    drop(dm);

    if task_ids.is_empty() {
        if skipped_complete > 0 && skipped_active == 0 {
            return Err("All parts already downloaded".to_string());
        }
        if skipped_active > 0 {
            return Err("All parts already downloaded or in progress".to_string());
        }
        return Err("No files to download".to_string());
    }

    for task_id in &task_ids {
        let _ = app.emit("download-event", serde_json::json!({
            "type": "queued",
            "taskId": task_id,
        }));
    }

    Ok(task_ids)
}

#[tauri::command]
async fn pause_download(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
    task_id: String,
) -> Result<(), String> {
    let mut dm = manager.write().await;
    dm.pause_task(&task_id)?;
    drop(dm);

    let _ = app.emit("download-event", serde_json::json!({
        "type": "paused",
        "taskId": task_id,
    }));

    Ok(())
}

#[tauri::command]
async fn cancel_download(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
    task_id: String,
) -> Result<(), String> {
    let mut dm = manager.write().await;
    dm.cancel_task(&task_id)?;
    drop(dm);

    let _ = app.emit("download-event", serde_json::json!({
        "type": "cancelled",
        "taskId": task_id,
    }));

    Ok(())
}

#[tauri::command]
async fn resume_download(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
    task_id: String,
) -> Result<(), String> {
    let mut dm = manager.write().await;
    let result = dm.resume_download(task_id.clone(), Arc::clone(&manager)).await;
    drop(dm);

    if result.is_ok() {
        let _ = app.emit("download-event", serde_json::json!({
            "type": "resumed",
            "taskId": task_id,
        }));
    }

    result
}

#[tauri::command]
async fn get_download_tasks(
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
) -> Result<Vec<serde_json::Value>, String> {
    let dm = manager.read().await;
    let tasks = dm.get_all_tasks();
    drop(dm);

    Ok(tasks.iter().map(|t| serde_json::to_value(t).unwrap_or_default()).collect())
}

#[tauri::command]
async fn clear_completed_downloads(
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
) -> Result<(), String> {
    let mut dm = manager.write().await;
    dm.remove_completed();
    Ok(())
}

/// Check whether the target file already exists on disk and compare its LFS OID.
#[tauri::command]
fn check_download_target(
    config: tauri::State<'_, Arc<std::sync::Mutex<config::AppConfig>>>,
    dest_path: String,
    lfs_oid: String,
) -> Result<serde_json::Value, String> {
    {
        let cfg = config.lock().map_err(|e| e.to_string())?;
        config::validate_download_dest(&dest_path, &cfg)?;
    }

    let exists = std::path::Path::new(&dest_path).exists();
    if !exists {
        return Ok(serde_json::json!({
            "exists": false,
            "sameModel": false,
            "lfsMatch": false,
            "cachedLfsOid": null,
        }));
    }

    // Look up cached HF metadata for this file
    let cached_hf = crate::model_cache::get_hf_metadata(&dest_path);
    let cached_lfs = cached_hf.as_ref().and_then(|m| if m.lfs_oid.is_empty() { None } else { Some(m.lfs_oid.clone()) });

    let cached_oid_str = cached_lfs.clone();
    // Both empty = can't differentiate, assume identical (pre-fix downloads or non-LFS files).
    let lfs_match = if lfs_oid.is_empty() {
        cached_lfs.is_none()
    } else {
        cached_lfs.as_deref() == Some(lfs_oid.as_str())
    };

    // Determine sameModel: same cached HF model ID or same filename
    let same_model = cached_hf.is_some();

    Ok(serde_json::json!({
        "exists": true,
        "sameModel": same_model,
        "lfsMatch": lfs_match,
        "cachedLfsOid": cached_oid_str,
    }))
}

/// Check HF GGUF files against local disk catalog. Returns per-file match results.
#[tauri::command]
async fn check_hf_files_against_disk(
    config: tauri::State<'_, Arc<std::sync::Mutex<config::AppConfig>>>,
    gguf_files: Vec<crate::types::GgufFile>,
    app: tauri::AppHandle,
    hf_model_id: Option<String>,
) -> Result<Vec<crate::types::DiskCheckResult>, String> {
    if let Some(ref model_id) = hf_model_id {
        config::validate_hf_model_id(model_id)?;
    }
    for gf in &gguf_files {
        if !gf.url.is_empty() {
            config::validate_download_url(&gf.url)?;
        }
    }

    let cfg = config.lock().map_err(|e| e.to_string())?;
    let paths = config::get_model_paths(&cfg);
    let log_hub = app.state::<AppContext>().log_hub.clone();
    Ok(model_catalog::check_hf_files_against_disk(&paths, &gguf_files, Some(&log_hub), hf_model_id.as_deref()))
}

use engine::AppContext;
use engine_stack::EngineStack;
use log_hub::LogHub;
use mobile_bridge::MobileBridge;
use download_manager::DownloadManager;
use tauri::Manager;
use tauri::Emitter;

#[tokio::main]
async fn main() {
    #[cfg(debug_assertions)]
    std::env::set_var("RUST_BACKTRACE", "1");
    // Custom panic handler — writes backtrace to file for debugging crashes
    std::panic::set_hook(Box::new(|info| {
        let msg = format!(
            "[PANIC] {}\n{:?}",
            info.location().map(|l| l.to_string()).unwrap_or_else(|| "unknown location".to_string()),
            info
        );
        // Panic info now routed to Blackwell Output Console
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(std::env::temp_dir().join("blackwell-panic.log")) {
            use std::io::Write;
            let _ = writeln!(f, "{}\n", msg);
            let _ = f.flush();
        }
    }));

    #[cfg(debug_assertions)]
    {
        let mut builder = env_logger::Builder::from_default_env();
        builder.filter_level(log::LevelFilter::Info);
        builder.init();
    }

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_mcp_bridge::init());
    }

    builder
        .setup(move |app| {
            // Ensure portable directory structure exists, copy bundled binaries on first run
            config::ensure_portable_structure(app.handle());

            // Load config with bundled path resolution (needs app handle)
            let mut app_config = config::load_config_with_app(app.handle());
            let had_legacy_hf = !app_config.hf_token.is_empty();
            if let Err(e) = secrets::migrate_legacy_hf_token(&mut app_config) {
                log::warn!("[secrets] Legacy HF token migration failed: {e}");
            } else if had_legacy_hf {
                if let Err(e) = config::save_config(&mut app_config) {
                    log::warn!("[secrets] Failed to clear legacy hf_token from config: {e}");
                }
            }

            let slot_count = crate::templates::resolve_engine_slot_count();
            let stack = Arc::new(Mutex::new(EngineStack::new(slot_count)));
            log::info!("Initializing EngineStack with {} engine slot(s) (from provider spawn_profile)", slot_count);
            let log_hub = LogHub::new(app.handle().clone());
            let config_arc = Arc::new(std::sync::Mutex::new(app_config.clone()));

            let stack_init = stack.clone();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                stack_init.lock().await.set_log_hub(LogHub::new(app_handle));
            });

            let ctx = AppContext {
                stack,
                log_hub,
                config: config_arc.clone(),
                fit_scan_cancel: Arc::new(Mutex::new(Arc::new(AtomicBool::new(false)))),
                blackwell_output_console_manager: BlackwellOutputConsoleManager::new(2000),
            };

            app.manage(ctx);

            app.manage(config_arc);

            // ── Download Manager ──
            let download_mgr = Arc::new(tokio::sync::RwLock::new(DownloadManager::new()));

            // Recover orphaned .part files from prior session
            {
                let dm_clone = download_mgr.clone();
                tauri::async_runtime::spawn(async move {
                    let mut dm = dm_clone.write().await;
                    dm.recover_part_files();
                });
            }

            // Remove engine-locks left when engines crashed or the app was killed
            tauri::async_runtime::spawn(async move {
                engine_port_lock::sweep_stale_locks().await;
            });

            app.manage(download_mgr);

            // -- Mobile Bridge
            let mobile_bridge = MobileBridge::new(3814);
            app.manage(mobile_bridge.clone());

            telemetry::ensure_disk_io_poller();

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Block exit until engines are torn down — fire-and-forget left orphans under cargo.exe in dev.
                api.prevent_close();
                let app_handle = window.app_handle().clone();
                let stack_clone = app_handle.state::<AppContext>().stack.clone();
                let fit_cancel = app_handle.state::<AppContext>().fit_scan_cancel.clone();
                tauri::async_runtime::spawn(async move {
                    fusion_brain::stop_all_brains().await;
                    {
                        let guard = fit_cancel.lock().await;
                        guard.store(true, std::sync::atomic::Ordering::Relaxed);
                    }
                    reactor_foundry::foundry_kill_all_children();
                    EngineStack::kill_all(&stack_clone).await;
                    app_handle.exit(0);
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            engine::list_models,
            engine::launch_engine,
            engine::stop_engine,
            engine::stop_engine_slot,
            engine::stop_all_engines,
            engine::stop_engines_by_provider,
            engine::get_stack_status,
            engine::clean_exit,
            // Provider management commands
            provider_mgmt::list_providers,
            provider_mgmt::save_provider,
            provider_mgmt::export_provider_factory_template,
            provider_mgmt::remove_provider,
            provider_mgmt::toggle_group_hidden,
            engine::get_binary_build_info,
            engine::set_build_info_for_env,
            engine::open_file_dialog,
            engine::open_folder_dialog,
            // Template loading
            engine::get_template,
            engine::get_template_for_provider,
            engine::preview_launch_command,
            intel::fetch_github_intel,
            telemetry::scan_gpus,
            telemetry::scan_cpu,
            telemetry::scan_system_info,
            telemetry::scan_disk_io,
            config::load_config,
            config::dev_reset_first_run,
            config::reset_provider_user_config,
            config::save_user_providers_meta,
            config::reset_param_to_template,
            config::reorder_provider,
            // FIT Scanner commands
            engine::fit_scan_model,
            engine::fit_scan_library,
            engine::fit_stop_scan,
            fit_scanner::get_fit_scan_points,
            vram_learn::get_learned_vram,
            // GGUF Metadata Scanner commands
            engine::scan_model_metadata_cmd,
            engine::scan_all_models_cmd,
            engine::cancel_gguf_scan_cmd,
            engine::clear_model_cache_cmd,
            burst_bench::cmd_burst_bench,
            bench_pp_burst::cmd_bench_pp_burst,
            bench_cancel::cmd_cancel_bench,
            fusion_brain::get_fusion_snapshots,
            // Mobile Sentinel Bridge commands (always active)
            mobile_bridge::cmd_mobile_bridge_start,
            mobile_bridge::cmd_mobile_bridge_stop,
            mobile_bridge::cmd_mobile_bridge_status,
            mobile_bridge::cmd_mobile_bridge_push_telemetry,
            mobile_bridge::cmd_mobile_bridge_send_heartbeat,

            // Reactor11 commands — DISABLED via feature flag (see Cargo.toml)
            // Reenable by adding `reactor11` to default features in Cargo.toml
            // Reactor Foundry build commands
            reactor_foundry::foundry_build,
            reactor_foundry::foundry_cancel,
            reactor_foundry::foundry_status,
            reactor_foundry::foundry_confirm_build,
            reactor_foundry::foundry_resume_backup,
            reactor_foundry::refresh_build_info,
            reactor_foundry::foundry_restore,
            reactor_foundry::foundry_check_toolchain,
            reactor_foundry::foundry_get_profiles,
            foundry_toolchain::foundry_get_toolchain_install_info,
            foundry_toolchain::foundry_open_toolchain_install_folder,

            // Blackwell Output Console commands (power-user output system)
            get_blackwell_output_console_categories,
            get_blackwell_output_console_buffer_for_category,
            get_blackwell_output_console_latest_line,
            clear_blackwell_output_console_category,
            clear_all_blackwell_output_console_buffers,
            emit_to_blackwell_console,
            // Download manager commands
            start_download,
            start_quant_download,
            pause_download,
            cancel_download,
            resume_download,
            get_download_tasks,
            clear_completed_downloads,
            check_download_target,
            check_hf_files_against_disk,
            // HF Search commands
            search_hf_models,
            get_hf_model_info,
            check_hf_repo_updates,
            check_catalog_hf_updates,
            secrets::list_app_secrets,
            secrets::set_app_secret,
            secrets::delete_app_secret,
            // Model Path management commands
            list_model_paths,
            model_library_configured,
            validate_model_library,
            add_model_path,
            add_lmstudio_model_path,
            get_lm_studio_default_path,
            lmstudio_models_available,
            remove_model_path,
            set_default_model_path,
            get_disk_usage,
            get_default_download_path,
            // Llama catalog (live --help parser)
            llama_catalog::get_llama_catalog,
            // Binary update commands
            binary_update::check_binary_updates,
            binary_update::download_binary_update,
            binary_update::get_profile_labels,
            binary_update::check_app_update,
            binary_update::install_app_update,
            binary_update::get_startup_updates,
            binary_update::revert_binary_to_bundled,

        ])
        .run(tauri::generate_context!())
        .expect("error while running Blackwell Ops");
}


