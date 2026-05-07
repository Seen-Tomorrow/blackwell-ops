#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;
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
mod mobile_bridge;
mod engine_perf;
mod burst_bench;
mod gguf_scan;
mod model_cache;
mod download_manager;
mod model_catalog;
mod engine_utils;
mod provider_mgmt;

pub mod features;
mod reactor_bridge;
mod reactor_foundry;

// Reactor11 — isolated next-gen reactor interface (in features/reactor11/) // handled by pub mod features;



use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::{Mutex, RwLock};

// ── HF Search Commands ────────────────────────────────────────────────

#[tauri::command]
async fn search_hf_models(
    query: String,
    vram_limit_gb: Option<u32>,
    sort: Option<String>,
    limit: Option<usize>,
    hf_token: Option<String>,
) -> Result<crate::types::HfSearchResponse, String> {
    let filters = crate::types::HfSearchFilters {
        query,
        vram_limit_gb: vram_limit_gb.unwrap_or(0),
        limit: limit.unwrap_or(50),
        sort: sort.unwrap_or_else(|| "downloads".to_string()),
    };
    hf_api::search_models(&filters, hf_token.as_deref()).await
}

#[tauri::command]
async fn get_hf_model_info(
    model_id: String,
    hf_token: Option<String>,
) -> Result<crate::types::HfModelInfo, String> {
    hf_api::get_model_info(&model_id, hf_token.as_deref()).await
}

#[tauri::command]
async fn set_hf_token(token: String) -> Result<(), String> {
    let app_dir = dirs::config_dir().ok_or("Could not find config directory")?;
    let config_path = app_dir.join("blackwell-ops").join("hf_token.txt");
    std::fs::create_dir_all(config_path.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, token).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn get_hf_token() -> Result<Option<String>, String> {
    if let Some(app_dir) = dirs::config_dir() {
        let token_path = app_dir.join("blackwell-ops").join("hf_token.txt");
        if token_path.exists() {
            let content = std::fs::read_to_string(&token_path).map_err(|e| e.to_string())?;
            if !content.is_empty() {
                let masked = if content.len() > 10 {
                    format!("{}***", &content[..6])
                } else {
                    "***".to_string()
                };
                return Ok(Some(masked));
            }
        }
    }
    Ok(None)
}

// ── Model Path Management Commands ────────────────────────────────────

#[tauri::command]
async fn list_model_paths(
    config: tauri::State<'_, Arc<std::sync::Mutex<config::AppConfig>>>,
) -> Result<Vec<crate::types::ModelPathEntry>, String> {
    let cfg = config.lock().unwrap();
    Ok(config::get_model_paths(&cfg))
}

#[tauri::command]
async fn add_model_path(
    config: tauri::State<'_, Arc<std::sync::Mutex<config::AppConfig>>>,
    path: String,
    label: Option<String>,
) -> Result<(), String> {
    let mut cfg = config.lock().unwrap();
    config::add_model_path(&mut cfg, path, label);
    config::save_config(&cfg).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn remove_model_path(
    config: tauri::State<'_, Arc<std::sync::Mutex<config::AppConfig>>>,
    path: String,
) -> Result<(), String> {
    let mut cfg = config.lock().unwrap();
    config::remove_model_path(&mut cfg, &path);
    config::save_config(&cfg).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn set_default_model_path(
    config: tauri::State<'_, Arc<std::sync::Mutex<config::AppConfig>>>,
    path: String,
) -> Result<(), String> {
    let mut cfg = config.lock().unwrap();
    config::set_default_model_path(&mut cfg, &path);
    config::save_config(&cfg).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn get_disk_usage(
    config: tauri::State<'_, Arc<std::sync::Mutex<config::AppConfig>>>,
) -> Result<Vec<crate::types::PathDiskUsage>, String> {
    let cfg = config.lock().unwrap();
    let paths = config::get_model_paths(&cfg);
    Ok(config::calculate_disk_usage(&paths))
}

#[tauri::command]
async fn get_default_download_path(
    config: tauri::State<'_, Arc<std::sync::Mutex<config::AppConfig>>>,
) -> Result<String, String> {
    let cfg = config.lock().unwrap();
    Ok(config::get_default_download_path(&cfg))
}

// ── Download Manager Commands ────────────────────────────────────────

#[tauri::command]
async fn start_download(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
    hf_model_id: String,
    file_name: String,
    url: String,
    total_bytes: u64,
    dest_path: String,
    hf_author: String,
    quant_type: String,
    lfs_oid: String,
) -> Result<String, String> {
    let mut dm = manager.write().await;
    let task_id = dm.start_download(hf_model_id, file_name, url, total_bytes, dest_path, hf_author, quant_type, lfs_oid, Arc::clone(&manager)).await?;
    drop(dm);

    let _ = app.emit("download-event", serde_json::json!({
        "type": "queued",
        "taskId": task_id,
    }));

    Ok(task_id)
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
    {
        let mut builder = env_logger::Builder::from_default_env();
        builder.filter_level(log::LevelFilter::Info);
        builder.init();
    }
    #[cfg(not(debug_assertions))]
    env_logger::init();

    let app_config = config::load_config();

    // Validate llama-server path on startup — show warning if missing
    if !app_config.llama_path.exists() {
        log::warn!("llama-server.exe not found at: {}. Models may fail to launch.", app_config.llama_path.display());
    }

    // Wipe WebView2 cache on every dev launch — prevents stale JS bundle from persisting
    #[cfg(debug_assertions)]
    {
        if let Some(data_dir) = dirs::data_local_dir() {
            let cache_path = data_dir.join("com.blackwell-ops.sentinel/EBWebView/Default");
            for subfolder in &["Cache", "Code Cache"] {
                let target = cache_path.join(subfolder);
                if target.exists() {
                    log::info!("Clearing WebView2 {} on dev startup", subfolder);
                    let _ = std::fs::remove_dir_all(&target);
                }
            }
        }
    }

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init());

    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_mcp_bridge::init());
    }

    builder
        .setup(move |app| {
            let slot_count = std::cmp::max(1, app_config.gpu_slots);
            let stack = Arc::new(Mutex::new(EngineStack::new(app_config.base_port, slot_count)));
            log::info!("Initializing EngineStack with {} slots for {} GPU(s)", slot_count, slot_count);
            let log_hub = LogHub::new(app.handle().clone());
            let config_arc = Arc::new(std::sync::Mutex::new(app_config.clone()));

            // Attach a separate LogHub instance to EngineStack for system event emission
            let stack_init = stack.clone();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                stack_init.lock().await.set_log_hub(LogHub::new(app_handle));
            });

            // Build app context — providers come from disk via list_providers
            let ctx = AppContext {
                stack,
                log_hub,
                config: config_arc.clone(),
                fit_scan_cancel: Arc::new(Mutex::new(Arc::new(AtomicBool::new(false)))),
            };

            app.manage(ctx);

            // Manage config Arc<Mutex<AppConfig>> directly for commands that need it
            app.manage(config_arc);

            // ── Download Manager ──
            let download_mgr = Arc::new(tokio::sync::RwLock::new(DownloadManager::new()));
            app.manage(download_mgr);

            // ── Mobile Sentinel Bridge (always active, started on-demand via UI) ──
            let mobile_bridge = MobileBridge::new(3814);
            app.manage(mobile_bridge.clone());

            // GPU telemetry is frontend-driven only (App.tsx polling at 250ms).
            // Backend loop removed — it emitted "telemetry-update" to zero listeners.

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let app_handle = window.app_handle();
                let ctx = app_handle.state::<AppContext>();

                let stack_clone = ctx.stack.clone();
                tauri::async_runtime::spawn(async move {
                    let mut stack = stack_clone.lock().await;
                    stack.kill_all().await;
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            engine::list_models,
            engine::launch_engine,
            engine::hot_swap_engine,
            engine::stop_engine,
            engine::stop_all_engines,
            engine::stop_engines_by_provider,
            engine::get_stack_status,
            engine::clean_exit,
            // Provider management commands
            provider_mgmt::list_providers,
            provider_mgmt::save_provider,
            provider_mgmt::remove_provider,
            engine::get_binary_build_info,
            engine::set_build_info_for_env,
            engine::open_file_dialog,
            engine::open_folder_dialog,
            // Template loading
            engine::get_template,
            engine::preview_launch_command,
            intel::fetch_github_intel,
            telemetry::scan_gpus,
            telemetry::scan_cpu,
            telemetry::scan_system_info,
            config::load_config,
            config::validate_provider_meta,
            config::check_template_update,
            config::apply_template_update,
            config::save_provider_meta,
            config::reset_param_to_template,
            // FIT Scanner commands
            engine::fit_scan_model,
            engine::fit_scan_library,
            engine::fit_stop_scan,
            // GGUF Metadata Scanner commands
            engine::scan_model_metadata_cmd,
            engine::scan_all_models_cmd,
            engine::cancel_gguf_scan_cmd,
            engine::clear_model_cache_cmd,
            // Engine Performance Pulse commands
            engine_perf::cmd_start_beta_fuel_tank,
            burst_bench::cmd_burst_bench,
            // Mobile Sentinel Bridge commands (always active)
            mobile_bridge::cmd_mobile_bridge_start,
            mobile_bridge::cmd_mobile_bridge_stop,
            mobile_bridge::cmd_mobile_bridge_status,
            mobile_bridge::cmd_mobile_bridge_push_telemetry,
            mobile_bridge::cmd_mobile_bridge_send_heartbeat,
            // Reactor commands (legacy)
            reactor_bridge::reactor_get_status,
            reactor_bridge::reactor_insert_rod,
            reactor_bridge::reactor_remove_rod,
            reactor_bridge::reactor_swap_rod,
            reactor_bridge::reactor_get_rod_by_id,
            reactor_bridge::reactor_toggle_tier,
            reactor_bridge::reactor_update_rod,
            // Reactor11 commands (isolated next-gen)
            features::reactor11::bridge::r11_get_status,
            features::reactor11::bridge::r11_insert_rod,
            features::reactor11::bridge::r11_remove_rod,
            features::reactor11::bridge::r11_swap_rod,
            features::reactor11::bridge::r11_get_rod_by_id,
            features::reactor11::bridge::r11_toggle_tier,
            features::reactor11::bridge::r11_update_rod,
            features::reactor11::bridge::r11_predict_fit,
            features::reactor11::bridge::r11_get_rod_count,
            features::reactor11::bridge::r11_get_running_rod_count,
            // Reactor Foundry build commands
            reactor_foundry::foundry_build,
            reactor_foundry::foundry_cancel,
            reactor_foundry::foundry_status,
            reactor_foundry::foundry_confirm_build,
            // Download manager commands
            start_download,
            pause_download,
            cancel_download,
            resume_download,
            get_download_tasks,
            clear_completed_downloads,
            // HF Search commands
            search_hf_models,
            get_hf_model_info,
            set_hf_token,
            get_hf_token,
            // Model Path management commands
            list_model_paths,
            add_model_path,
            remove_model_path,
            set_default_model_path,
            get_disk_usage,
            get_default_download_path,

        ])
        .run(tauri::generate_context!())
        .expect("error while running Blackwell Ops");
}


