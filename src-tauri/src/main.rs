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
mod burst_bench;
mod bench_pp_burst;
mod gguf_scan;
mod model_cache;
mod download_manager;
mod model_catalog;
mod engine_utils;
mod fusion_brain;
mod fusion_poller;
mod fusion_logparser;
mod provider_mgmt;
mod llama_catalog;
mod binary_update;

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
async fn set_hf_token(token: String, app_config: tauri::State<'_, Arc<std::sync::Mutex<config::AppConfig>>>) -> Result<(), String> {
    let mut cfg = app_config.lock().map_err(|e| e.to_string())?;
    cfg.hf_token = token;
    config::save_config(&mut cfg).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn get_hf_token(app_config: tauri::State<'_, Arc<std::sync::Mutex<config::AppConfig>>>) -> Result<Option<String>, String> {
    let cfg = app_config.lock().map_err(|e| e.to_string())?;
    if !cfg.hf_token.is_empty() {
        let masked = if cfg.hf_token.len() > 10 {
            format!("{}***", &cfg.hf_token[..6])
        } else {
            "***".to_string()
        };
        return Ok(Some(masked));
    }
    Ok(None)
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
    config::set_default_model_path(&mut cfg, &path);
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
async fn open_blackwell_output_window(app: tauri::AppHandle) -> Result<(), String> {
    // This will eventually create a real separate Tauri window for the Output Console.
    // For now this is a placeholder that the frontend can call.
    // Full implementation will use WebviewWindowBuilder with a dedicated label.
    // Placeholder — will create a real WebviewWindow when frontend routing is ready.
    // TODO: Create real WebviewWindow here when frontend routing for it is ready.
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
    config::validate_download_url(&url)?;
    {
        let cfg = config.lock().map_err(|e| e.to_string())?;
        config::validate_download_dest(&dest_path, &cfg)?;
    }

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
    // Enable full backtrace on panic
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
    #[cfg(not(debug_assertions))]
    env_logger::init();

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
            let app_config = config::load_config_with_app(app.handle());

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

            // Blackwell Output Console commands (power-user output system)
            get_blackwell_output_console_categories,
            get_blackwell_output_console_buffer_for_category,
            get_blackwell_output_console_latest_line,
            clear_blackwell_output_console_category,
            clear_all_blackwell_output_console_buffers,
            open_blackwell_output_window,
            emit_to_blackwell_console,
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
            add_lmstudio_model_path,
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


