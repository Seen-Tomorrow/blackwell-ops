#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod crash_log;
mod runtime_log;
mod session_log;
mod runtime_settings;
mod debug_flags;
mod ipc_emit;
mod engine;
mod engine_props;
mod arch_capabilities;
mod engine_packs;
mod disk_io_pdh;
mod cpu_topology;
mod telemetry;
mod config;
mod engine_stack;
mod engine_load_progress;
mod engine_events;

mod log_hub;
mod hf_api;
mod types;

mod templates;
mod nvml_metrics;
mod nsys_profile_cmd;
mod fit_adapters;
mod fit_scanner;
mod fit_low_vram;
mod vram_learn;
mod forecast_log;
mod launch_memory_parse;
mod bench_prompts;
mod bench_archive;
mod burst_bench;
mod bench_pp_burst;
mod bench_cancel;
mod llama_bench_cmd;
mod gguf_scan;
mod gguf_patch;
mod gguf_shape;
mod model_cache;
mod download_manager;
mod model_catalog;
mod spec_draft;
mod engine_utils;
mod engine_job;
mod app_lifecycle;
mod trash_util;
mod fs_util;
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
mod pi_code;
mod external_agents;
mod gateway_cmds;
mod gpu_control;
mod sidecar_elevate;

// Command modules (extracted from main.rs; the single generate_handler! below is
// still the one IPC surface map — these are registrations, not sub-routers).
mod hf_search;
mod model_paths;
mod output_console_cmds;
mod downloads;

// engine.rs domain split — same single
// generate_handler! below; these are domain modules, not sub-routers.
// (`fit_scanner` is already declared above with its fit_adapters / fit_low_vram family.)
mod engine_build_info;
mod model_files;
mod model_scan;

// Change 2 of the same plan: typed errors at the spawn / port-reclaim / FIT boundaries.
mod errors;

// Change 3: the Rust<->TS IPC wire contract, asked of serde. Test-only — the
// module carries the key probe and the gate, so none of it ships.
#[cfg(test)]
mod ipc_contract;


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

/// Candidate paths for the panic record, in priority order.
///
/// `std::env::temp_dir()` is tried first for continuity with older logs, but it is
/// NOT guaranteed writable: a Low-integrity process cannot write up into a
/// Medium-IL `%TEMP%`. The workspace under `target\debug` stays writable in exactly
/// those sessions (see `gguf_shape::scratch_dir`), and the session log directory is
/// the durable option.
fn panic_log_candidates() -> Vec<std::path::PathBuf> {
    let mut v = vec![
        std::env::temp_dir().join("blackwell-panic.log"),
        crate::config::app_root_dir().join("blackwell-panic.log"),
    ];
    if let Some(dir) = crate::session_log::current_dir() {
        v.push(dir.join("panic.log"));
    }
    v
}

/// Append one panic record. Errors are returned to the caller and printed — the
/// previous hook hid them behind `if let Ok(..)`, which is why blackwell-panic.log
/// was never created and nobody knew why.
fn append_panic_record(path: &std::path::Path, msg: &str) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    writeln!(f, "=== panic record ts={ts} pid={} ===", std::process::id())?;
    writeln!(f, "{msg}")?;
    writeln!(f)?;
    f.flush()
}

#[tokio::main]
async fn main() {
    // First: no modal crash dialogs for us or any helper binary we spawn.
    crash_log::silence_crash_dialogs();
    crash_log::install_native_exception_logger();
    session_log::init();

    #[cfg(debug_assertions)]
    std::env::set_var("RUST_BACKTRACE", "1");
    // Custom panic handler: payload first, then location, then backtrace.
    // stderr is written unconditionally; file logging is best-effort but reports
    // failures and falls back to writable dirs. Do not route into the Output
    // Console — those paths allocate and take locks, risking a panic-inside-panic abort.
    std::panic::set_hook(Box::new(|info| {
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string payload>".to_string());
        let location = info
            .location()
            .map(|l| l.to_string())
            .unwrap_or_else(|| "unknown location".to_string());

        // Cap the backtrace so the payload stays visible without scrolling.
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        let mut bt = String::new();
        for line in backtrace.lines().take(60) {
            bt.push_str(line);
            bt.push('\n');
        }

        let msg = format!("[PANIC] {location} — {payload}\n{bt}");

        // Sink 1: stderr, always, before anything that is allowed to fail.
        eprintln!("{msg}\n");

        // Sink 2: the first writable log file. Report every attempt that fails.
        let mut recorded = false;
        for candidate in panic_log_candidates() {
            match append_panic_record(&candidate, &msg) {
                Ok(()) => {
                    eprintln!("[panic] record written to {}", candidate.display());
                    recorded = true;
                    break;
                }
                Err(e) => eprintln!("[panic] cannot write {}: {e}", candidate.display()),
            }
        }
        if !recorded {
            eprintln!("[panic] FATAL: no panic record could be written anywhere");
        }
    }));

    // Installed in EVERY build profile. This used to sit inside
    // `#[cfg(debug_assertions)]`, so REL registered no `log` backend at all and every
    // `log::info!/warn!/error!` in the crate was a no-op that never formatted its
    // arguments — REL was blind, not merely quiet.
    runtime_log::init();

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
            // First line of every session log: which source produced this binary.
            // The version string cannot answer that — `majestic bump` rewrites it across
            // four files without necessarily making a commit — and `tree=dirty` means no
            // commit describes these bytes at all. Baked by build.rs.
            log::info!(
                "[startup] build provenance: app={} sha={} branch={} tree={}",
                app.handle().package_info().version,
                env!("BLACKWELL_GIT_SHA"),
                env!("BLACKWELL_GIT_BRANCH"),
                env!("BLACKWELL_GIT_DIRTY"),
            );
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
            runtime_settings::apply_saved_session_log();
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

            // Cloned before the stack moves into AppContext: the remote route
            // refresh below reads it on a timer.
            let route_refresh_stack = stack.clone();

            let ctx = AppContext {
                stack,
                log_hub,
                config: config_arc.clone(),
                fit_scan_cancel: Arc::new(Mutex::new(Arc::new(AtomicBool::new(false)))),
                slot_stderr_tails: Arc::new(parking_lot::Mutex::new(std::collections::HashMap::new())),
                blackwell_output_console_manager: BlackwellOutputConsoleManager::new(2000),
            };

            app.manage(ctx);

            // ── Remote control room gateway ─────────────────────────────
            // Loopback-only; Cloudflare Tunnel provides the public TLS edge.
            let remote_cfg = oym_gateway::GatewayConfig::for_app(&crate::config::app_root_dir());
            match oym_gateway::GatewayState::load(remote_cfg) {
                Ok(remote) => {
                    let start_state = remote.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) = start_state.start_gateway().await {
                            log::error!("[remote] gateway start: {error}");
                            start_state.set_gateway_error(Some(error)).await;
                        }
                    });
                    let event_state = remote.clone();
                    let event_app = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        let mut rx = event_state.subscribe();
                        loop {
                            match rx.recv().await {
                                Ok(event) => {
                                    let _ = event_app.emit("remote-event", event);
                                }
                                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                                    continue
                                }
                                Err(_) => break,
                            }
                        }
                    });
                    // Local Power Mode (`oym-link --local`) asks the
                    // gateway for routes before any remote session exists, so
                    // the route table must track the running stack. Refresh off
                    // the startup path, a few seconds apart; a session start
                    // still refreshes routes as a fallback.
                    let refresh_remote = remote.clone();
                    app.manage(remote);

                    let refresh_stack = route_refresh_stack.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                        loop {
                            crate::gateway_cmds::refresh_routes(&refresh_stack, &refresh_remote).await;
                            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                        }
                    });
                }
                Err(error) => log::error!("[remote] disabled: {error}"),
            }

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
            engine_props::get_engine_reasoning_levels,
            arch_capabilities::get_arch_capabilities,
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
            engine_build_info::get_binary_build_info,
            model_scan::get_path_size_bytes,
            engine_build_info::set_build_info_for_env,
            model_files::open_file_dialog,
            model_files::open_folder_dialog,
            model_files::reveal_path_in_explorer,
            model_files::delete_model_file_cmd,
            model_files::rename_model_file_cmd,
            // Template loading
            engine::get_template,
            engine::get_template_for_provider,
            engine::preview_launch_command,
            engine::open_nobsproof_cmd,
            llama_bench_cmd::open_llama_bench_cmd,
            nsys_profile_cmd::open_nsys_profile_cmd,
            nsys_profile_cmd::nsys_profile_status,
            nsys_profile_cmd::set_nsys_profile_armed,
            pi_code::pi_code_status,
            pi_code::pi_code_accept_disclaimer,
            pi_code::pi_code_set_project,
            pi_code::pi_code_install,
            pi_code::pi_code_update_latest,
            pi_code::pi_code_console_running,
            pi_code::pi_code_launch,
            // Remote control room
            gateway_cmds::remote_status,
            gateway_cmds::remote_gateway_start,
            gateway_cmds::remote_gateway_stop,
            gateway_cmds::remote_pairing_create,
            gateway_cmds::remote_devices_list,
            gateway_cmds::remote_device_rename,
            gateway_cmds::remote_device_revoke,
            gateway_cmds::remote_health,
            gateway_cmds::remote_session_start,
            gateway_cmds::remote_session_terminate,
            gateway_cmds::remote_session_input,
            gateway_cmds::remote_session_resize,
            gateway_cmds::remote_invites_list,
            gateway_cmds::remote_invite_create,
            gateway_cmds::remote_invite_revoke,
            gateway_cmds::remote_helper_build,
            telemetry::scan_gpus,
            telemetry::scan_cpu,
            telemetry::scan_system_info,
            telemetry::get_nvidia_driver_version,
            telemetry::scan_disk_io,
            telemetry::set_telemetry_timings,
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
            // FIT Scanner commands — the probe lives in fit_scanner with the rest of the domain
            fit_scanner::fit_scan_model,
            fit_scanner::fit_scan_single_model,
            fit_scanner::fit_scan_library,
            fit_scanner::fit_stop_scan,
            fit_scanner::get_fit_scan_points,
            fit_scanner::get_fit_scan_cache_snapshot,
            vram_learn::get_learned_vram,
            vram_learn::get_learned_vram_curve,
            vram_learn::prune_learned_vram_curve,
            // GGUF Metadata Scanner commands
            model_scan::scan_model_metadata_cmd,
            model_scan::scan_all_models_cmd,
            model_scan::cancel_gguf_scan_cmd,
            model_scan::clear_model_cache_cmd,
            burst_bench::cmd_burst_bench,
            bench_pp_burst::cmd_bench_pp_burst,
            bench_cancel::cmd_cancel_bench,
            fusion::emit::get_fusion_snapshots,
            fusion::brain::set_fusion_quiet_mode,
            debug_flags::get_debug_flags,
            session_log::get_session_log_status,
            session_log::set_session_log_enabled,
            runtime_settings::get_runtime_settings,
            runtime_settings::set_runtime_settings,
            startup_frontend_ping,
            frontend_will_unload,
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
            reactor_foundry::foundry_clear_sccache,
            reactor_foundry::foundry_remote_changelog,
            reactor_foundry::foundry_pr_titles,
            foundry_toolchain::foundry_get_toolchain_install_info,
            foundry_toolchain::foundry_open_toolchain_install_folder,
            foundry_toolchain::foundry_open_toolchain_cache_folder,

            // Blackwell Output Console commands (power-user output system)
            output_console_cmds::get_blackwell_output_console_categories,
            output_console_cmds::get_blackwell_output_console_buffer_for_category,
            output_console_cmds::get_blackwell_output_console_latest_line,
            output_console_cmds::clear_blackwell_output_console_category,
            output_console_cmds::clear_all_blackwell_output_console_buffers,
            output_console_cmds::save_output_console_text,
            output_console_cmds::open_output_console_logs_folder,
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
            downloads::set_download_priority,
            downloads::move_download_up,
            downloads::move_download_down,
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
            binary_update::get_build_provenance,
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


