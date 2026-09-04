#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod crash_log;
mod session_log;
mod debug_flags;
mod ipc_meter;
mod engine;
mod disk_io_pdh;
mod cpu_topology;
mod telemetry;
mod intel;
mod config;
mod engine_stack;
mod engine_load_progress;

mod log_hub;
mod hf_api;
mod types;

mod templates;
mod nvml_probe;
mod nsys_profile_cmd;
mod fit_adapters;
mod fit_scanner;
mod fit_low_vram;
mod vram_learn;
mod forecast_log;
mod launch_memory_parse;
mod bench_prompts;
mod burst_bench;
mod bench_pp_burst;
mod bench_cancel;
mod llama_bench_cmd;
mod gguf_scan;
mod gguf_patch;
mod model_cache;
mod download_manager;
mod model_catalog;
mod spec_draft;
mod engine_utils;
mod engine_job;
mod app_lifecycle;
mod trash_util;
mod engine_port_lock;
mod fusion;
mod provider_mgmt;
mod llama_catalog;
mod archive_util;
mod binary_update;
mod plugin_catalog;
mod distribution;
mod github_releases;
mod profile_binaries;
mod secrets;

mod foundry_toolchain;
mod reactor_foundry;
mod output_console;
mod playground;
mod pi_code;
mod external_agents;
mod gpu_control;
mod sidecar_elevate;

// Command modules (extracted from main.rs; the single generate_handler! below is
// still the one IPC surface map — these are registrations, not sub-routers).
mod hf_search;
mod model_paths;
mod output_console_cmds;
mod downloads;


use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tokio::sync::Mutex;
use crate::output_console::BlackwellOutputConsoleManager;
use engine::AppContext;
use engine_stack::EngineStack;
use log_hub::LogHub;
use download_manager::DownloadManager;
use tauri::{Emitter, Manager};

/// First frontend IPC after WebView loads the dev/bundled JS module — used to bisect startup delay.
/// Also clears the FRONTEND_DETACHED flag so Rust-side IPC resumes after F5 / page reload.
#[tauri::command]
fn startup_frontend_ping() {
    crate::app_lifecycle::clear_frontend_detached();
    log::info!("[startup] frontend module loaded — IPC bridge live");
}

/// Called from frontend `beforeunload` handler. Suppress Rust→WebView IPC until next ping.
#[tauri::command]
fn frontend_will_unload(app: tauri::State<'_, AppContext>) {
    crate::app_lifecycle::set_frontend_detached();
    // Log to app console DEBUG category so it survives the page reload (buffer is Rust-side).
    app.blackwell_output_console_manager.emit_line_to_category(
        crate::output_console::BlackwellOutputConsoleCategory::Debug,
        "[LIFECYCLE] frontend_will_unload — IPC suppression engaged".to_string(),
        crate::output_console::BlackwellOutputConsoleLineStyle::Normal,
    );
}

#[tokio::main]
async fn main() {
    crash_log::install_native_exception_logger();
    session_log::init();

    #[cfg(debug_assertions)]
    std::env::set_var("RUST_BACKTRACE", "1");
    // Custom panic handler — writes backtrace to file for debugging crashes
    std::panic::set_hook(Box::new(|info| {
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| {
                info.payload()
                    .downcast_ref::<String>()
                    .map(|s| s.clone())
            })
            .unwrap_or_else(|| "<non-string payload>".to_string());
        let backtrace = std::backtrace::Backtrace::force_capture();
        let msg = format!(
            "[PANIC] {} — {}\n{backtrace}\n{:?}",
            info.location().map(|l| l.to_string()).unwrap_or_else(|| "unknown location".to_string()),
            payload,
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

    let _ = debug_flags::flags();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init());
    // Updater plugin omitted while BINARY_UPDATES_ENABLED is false — no startup network probe.
    if binary_update::BINARY_UPDATES_ENABLED {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .setup(move |app| {
            let startup_t0 = std::time::Instant::now();
            // Ensure portable directory structure exists, copy bundled binaries on first run
            let t_structure = std::time::Instant::now();
            config::ensure_portable_structure(app.handle());
            log::info!(
                "[startup] ensure_portable_structure: {:.0}ms",
                t_structure.elapsed().as_secs_f64() * 1000.0
            );

            // Proactively stage the bundled 7z (exe + dll) so it's ready in the
            // portable bin/ folder from launch (consistent with gsudo).
            let t_7z = std::time::Instant::now();
            let _ = sidecar_elevate::stage_7z(app.handle());
            log::info!(
                "[startup] stage_7z: {:.0}ms",
                t_7z.elapsed().as_secs_f64() * 1000.0
            );

            let t_git = std::time::Instant::now();
            if let Err(e) = sidecar_elevate::stage_git(app.handle()) {
                log::debug!("[startup] stage_git skipped: {}", e);
            } else {
                log::info!(
                    "[startup] stage_git: {:.0}ms",
                    t_git.elapsed().as_secs_f64() * 1000.0
                );
            }

            // Load config with bundled path resolution (needs app handle)
            let t_config = std::time::Instant::now();
            let mut app_config = config::load_config_with_app(app.handle());
            log::info!(
                "[startup] load_config_with_app: {:.0}ms",
                t_config.elapsed().as_secs_f64() * 1000.0
            );
            let had_legacy_hf = !app_config.hf_token.is_empty();
            if let Err(e) = secrets::migrate_legacy_hf_token(&mut app_config) {
                log::warn!("[secrets] Legacy HF token migration failed: {e}");
            } else if had_legacy_hf {
                if let Err(e) = config::save_config(&mut app_config) {
                    log::warn!("[secrets] Failed to clear legacy hf_token from config: {e}");
                }
            }

            // Private job: engines die with the app process (KILL_ON_JOB_CLOSE).
            crate::engine_job::init_engine_job();

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
                slot_stderr_tails: Arc::new(parking_lot::Mutex::new(std::collections::HashMap::new())),
                blackwell_output_console_manager: BlackwellOutputConsoleManager::new(2000),
            };

            app.manage(ctx);

            crate::output_console::register_blackwell_output_console_app_handle(app.handle().clone());
            // Console is registered — surface job status (init ran earlier, before AppContext).
            crate::engine_job::emit_engine_job_status_to_console();

            app.manage(config_arc);

            // ── Download Manager ──
            let download_mgr = Arc::new(tokio::sync::RwLock::new(DownloadManager::new()));

            // Recover orphaned .part files from prior session — defer + blocking gather so
            // startup IPC (list_models) is not queued behind large .part metadata / AV scans.
            {
                let dm_clone = download_mgr.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                    let t0 = std::time::Instant::now();
                    let recovered = match tokio::task::spawn_blocking(DownloadManager::gather_recovered_tasks)
                        .await
                    {
                        Ok(tasks) => tasks,
                        Err(e) => {
                            log::warn!("[download] Recovery gather join failed: {}", e);
                            Vec::new()
                        }
                    };
                    log::info!(
                        "[download] gather_recovered_tasks: {:.0}ms ({} task(s))",
                        t0.elapsed().as_secs_f64() * 1000.0,
                        recovered.len()
                    );
                    {
                        let mut dm = dm_clone.write().await;
                        dm.insert_recovered_tasks(recovered);
                        // Re-queue incomplete shards whose sibling completed before the
                        // batch finalized — otherwise they'd vanish from the queue.
                        dm.requeue_orphaned_batch_parts();
                        dm.try_finalize_pending_batches();
                    }
                    log::info!(
                        "[download] recovery complete: {:.0}ms total",
                        t0.elapsed().as_secs_f64() * 1000.0
                    );
                });
            }

            // Kill orphans from prior app death (update/crash), then scrub stale lock files.
            tauri::async_runtime::spawn(async move {
                engine_port_lock::kill_orphans_of_dead_owners().await;
                engine_port_lock::sweep_stale_locks().await;
            });

            app.manage(download_mgr);

            telemetry::ensure_disk_io_poller();
            ipc_meter::start_rotator();

            log::info!(
                "[startup] setup total: {:.0}ms",
                startup_t0.elapsed().as_secs_f64() * 1000.0
            );

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Block exit until engines are torn down — bare exit left orphans under cargo.exe in dev.
                api.prevent_close();
                let app_handle = window.app_handle().clone();
                // Immediate UI feedback — large models can take several seconds to taskkill.
                let _ = app_handle.emit(
                    "app-shutting-down",
                    serde_json::json!({
                        "message": "Shutting down — stopping engines and releasing GPU memory…",
                    }),
                );
                tauri::async_runtime::spawn(async move {
                    engine::teardown_all_for_app_exit(&app_handle).await;
                    // Do not AppHandle::exit — that path heap-corrupted after clean engine teardown.
                    crate::app_lifecycle::finish_process_exit(&app_handle).await;
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
            provider_mgmt::set_group_hidden,
            provider_mgmt::set_profile_binary_source,
            engine::get_binary_build_info,
            engine::get_path_size_bytes,
            engine::set_build_info_for_env,
            engine::open_file_dialog,
            engine::open_folder_dialog,
            engine::reveal_path_in_explorer,
            engine::delete_model_file_cmd,
            engine::rename_model_file_cmd,
            // Template loading
            engine::get_template,
            engine::get_template_for_provider,
            engine::preview_launch_command,
            engine::open_nobsproof_cmd,
            llama_bench_cmd::open_llama_bench_cmd,
            nsys_profile_cmd::open_nsys_profile_cmd,
            nsys_profile_cmd::nsys_profile_status,
            pi_code::pi_code_status,
            pi_code::pi_code_accept_disclaimer,
            pi_code::pi_code_set_project,
            pi_code::pi_code_install,
            pi_code::pi_code_update_latest,
            pi_code::pi_code_console_running,
            pi_code::pi_code_launch,
            intel::fetch_github_intel,
            telemetry::scan_gpus,
            telemetry::scan_cpu,
            telemetry::scan_system_info,
            telemetry::get_nvidia_driver_version,
            telemetry::scan_disk_io,
            config::load_config,
            config::dev_reset_first_run,
            config::get_config_dir,
            config::is_setup_completed,
            config::mark_setup_completed,
            config::reset_app_config,
            config::reset_provider_user_config,
            config::save_user_providers_meta,
            config::reset_param_to_template,
            config::reorder_provider,
            // FIT Scanner commands
            engine::fit_scan_model,
            engine::fit_scan_single_model,
            engine::fit_scan_library,
            engine::fit_stop_scan,
            fit_scanner::get_fit_scan_points,
            fit_scanner::get_fit_scan_cache_snapshot,
            vram_learn::get_learned_vram,
            vram_learn::get_learned_vram_curve,
            vram_learn::prune_learned_vram_curve,
            // GGUF Metadata Scanner commands
            engine::scan_model_metadata_cmd,
            engine::scan_all_models_cmd,
            engine::cancel_gguf_scan_cmd,
            engine::clear_model_cache_cmd,
            burst_bench::cmd_burst_bench,
            bench_pp_burst::cmd_bench_pp_burst,
            bench_cancel::cmd_cancel_bench,
            playground::playground_open_html_in_browser,
            fusion::emit::get_fusion_snapshots,
            fusion::brain::set_fusion_quiet_mode,
            debug_flags::get_debug_flags,
            session_log::get_session_log_status,
            session_log::set_session_log_enabled,
            startup_frontend_ping,
            frontend_will_unload,
            ipc_meter::get_ipc_meter_stats,
            gpu_control::get_gpu_control_devices,
            gpu_control::is_gpu_control_elevated,
            gpu_control::apply_gpu_control_presets,
            gpu_control::reset_gpu_control,
            gpu_control::set_gpu_driver_model,
            // Reactor Foundry build commands
            reactor_foundry::foundry_build,
            reactor_foundry::foundry_cancel,
            reactor_foundry::foundry_preview_source,
            reactor_foundry::foundry_status,
            reactor_foundry::foundry_confirm_build,
            reactor_foundry::foundry_resume_backup,
            reactor_foundry::refresh_build_info,
            reactor_foundry::foundry_restore,
            reactor_foundry::foundry_check_toolchain,
            reactor_foundry::foundry_get_profiles,
            reactor_foundry::foundry_work_cache_status,
            reactor_foundry::foundry_clear_work_cache,
            foundry_toolchain::foundry_get_toolchain_install_info,
            foundry_toolchain::foundry_open_toolchain_install_folder,
            foundry_toolchain::foundry_open_toolchain_cache_folder,

            // Blackwell Output Console commands (power-user output system)
            output_console_cmds::get_blackwell_output_console_categories,
            output_console_cmds::get_blackwell_output_console_buffer_for_category,
            output_console_cmds::get_blackwell_output_console_latest_line,
            output_console_cmds::clear_blackwell_output_console_category,
            output_console_cmds::clear_all_blackwell_output_console_buffers,
            output_console_cmds::emit_to_blackwell_console,
            // Download manager commands
            downloads::start_download,
            downloads::start_quant_download,
            downloads::pause_download,
            downloads::cancel_download,
            downloads::resume_download,
            downloads::start_toolchain_download,
            downloads::retry_toolchain_extract,
            downloads::get_download_tasks,
            downloads::get_download_history,
            downloads::clear_completed_downloads,
            downloads::recover_orphaned_batch_parts,
            downloads::patch_model_metadata,
            downloads::check_download_target,
            downloads::check_hf_files_against_disk,
            // HF Search commands
            hf_search::search_hf_models,
            hf_search::get_hf_model_info,
            hf_search::get_hf_quant_dates,
            hf_search::check_hf_repo_updates,
            hf_search::check_catalog_hf_updates,
            secrets::list_app_secrets,
            secrets::set_app_secret,
            secrets::delete_app_secret,
            // Model Path management commands
            model_paths::list_model_paths,
            model_paths::model_library_configured,
            model_paths::validate_model_library,
            model_paths::add_model_path,
            model_paths::add_lmstudio_model_path,
            model_paths::get_lm_studio_default_path,
            model_paths::lmstudio_models_available,
            model_paths::remove_model_path,
            model_paths::set_default_model_path,
            model_paths::get_disk_usage,
            model_paths::get_default_download_path,
            // Llama catalog (live --help parser)
            llama_catalog::get_llama_catalog,
            // Binary update commands
            binary_update::get_app_package_version,
            binary_update::check_binary_updates,
            binary_update::get_pack_update_provider_ids,
            binary_update::download_binary_update,
            binary_update::get_profile_labels,
            binary_update::check_app_update,
            binary_update::get_update_offerings,
            binary_update::install_app_update,
            binary_update::get_dev_update_version_override,
            binary_update::set_dev_update_version_override,
            binary_update::toggle_dev_update_version_fake,
            binary_update::get_startup_updates,
            binary_update::get_plugin_catalog,
            binary_update::revert_binary_to_bundled,
            // DEV distribution / majestic wrappers
            distribution::get_distribution_dashboard,
            distribution::set_provider_distribution,
            distribution::regenerate_distribution_catalog,
            distribution::run_dev_release_action,
            distribution::get_dev_release_job_status,

        ])
        .run(tauri::generate_context!())
        .expect("error while running Blackwell Ops");
}


