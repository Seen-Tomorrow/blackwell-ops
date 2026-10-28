use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use tauri::Manager;
use tokio::sync::Mutex;

use crate::engine_stack::SlotStatus;
use crate::config::AppConfig;
use crate::engine_stack::EngineStack;
use crate::log_hub::LogHub;
use crate::output_console::{
    BlackwellOutputConsoleCategory, BlackwellOutputConsoleLineStyle,
    BlackwellOutputConsoleManager,
};
use crate::types::EngineConfig;
use crate::types::StackEntry;
use crate::errors::BlackwellError;
use crate::fit_scanner;
use crate::telemetry::detect_gpu_count;
use crate::fusion;
use crate::model_catalog;
use crate::model_cache;
use crate::engine_utils;

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




const SPEC_EXTRA_PARAM_KEYS: &[&str] = &[
    "spec_type",
    "spec_draft_model",
    "spec_draft_n_max",
    "spec_draft_n_min",
    "spec_draft_p_min",
];

fn is_spec_decoding_group_active(user_params: &[crate::types::UserEditedTemplateParam]) -> bool {
    user_params.iter().any(|p| {
        let g = p.ui_group.as_str();
        !p.hidden
            && (g.eq_ignore_ascii_case("SPECULATIVE-MTP")
                || g.eq_ignore_ascii_case("SPECULATIVE-DFLASH")
                || g.eq_ignore_ascii_case("SPECULATIVE-DECODING"))
    })
}

fn model_has_embedded_mtp(model_path: &str) -> bool {
    let (_, shape) = model_cache::get_cached_with_shape(model_path);
    crate::spec_draft::baked_mtp_for_path(shape.as_ref(), model_path)
}

/// `draft-mtp` is stale only when the target has no baked-in MTP **and** no external
/// MTP head is configured. With a head, `draft-mtp` is a valid launch on a target that
/// has no nextn layers of its own — stripping the group here would hide the lane before
/// `validate_spec_launch` ever saw it.
fn mtp_spec_is_stale(config: &crate::types::EngineConfig, model_path: &str) -> bool {
    if !config
        .get_param_str("spec_type")
        .is_some_and(|t| t.eq_ignore_ascii_case("draft-mtp"))
    {
        return false;
    }
    if model_has_embedded_mtp(model_path) {
        return false;
    }
    !spec_draft_model_is_set(config)
}

/// Any draft path configured, under any of the three profile keys.
fn spec_draft_model_is_set(config: &crate::types::EngineConfig) -> bool {
    ["spec_draft_model", "dflash_draft_model", "mtp_draft_model"]
        .iter()
        .any(|key| {
            config
                .get_param_str(key)
                .is_some_and(|v| !v.trim().is_empty() && !v.eq_ignore_ascii_case("off"))
        })
}

/// A draft path, or `None` for off/none/empty. `auto` IS a configured draft — the
/// row's `values` list ships it, and the picker writes it — so it must never reach
/// the `.gguf` error verbatim.
fn meaningful_draft_value(raw: Option<String>) -> Option<String> {
    raw.map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("off") && !s.eq_ignore_ascii_case("none"))
}

/// Whether launch must merge the catalog to answer the draft row (`auto`/`on` with
/// no sibling in the main's own folder is the only case). Keeps the catalog walk off
/// every ordinary launch.
fn draft_needs_catalog(config: &crate::types::EngineConfig) -> bool {
    let spec_type = config.get_param_str("spec_type").unwrap_or_default();
    if spec_type.is_empty() || spec_type.eq_ignore_ascii_case("none") {
        return false;
    }
    let draft = draft_model_value_for_spec(config, &spec_type);
    draft.eq_ignore_ascii_case("auto") || draft.eq_ignore_ascii_case("on")
}

/// The draft path for THIS spec type, method-first.
///
/// `mtp_draft_model` is the MTP lane's key; `spec_draft_model` is the CLI alias
/// `buildSpecCliExtraParams` writes. The old code read only `spec_draft_model`, so
/// `mtp_draft_model=auto` (a value the shipped row's `values` list offers) read as
/// "no draft" and the launch died on the baked-in error even with a head configured.
/// The cross-key fallback is the cockpit's own pattern (`useCockpit.activeDraftPath`):
/// a path under any key is a configured draft — the footgun of a stale other-lane
/// path was accepted there, and launch validation is the worse place to be strict.
fn draft_model_value_for_spec(config: &crate::types::EngineConfig, spec_type: &str) -> String {
    let primary = if spec_type.eq_ignore_ascii_case("draft-mtp") {
        "mtp_draft_model"
    } else {
        "dflash_draft_model"
    };
    meaningful_draft_value(config.get_param_str(primary))
        .or_else(|| meaningful_draft_value(config.get_param_str("spec_draft_model")))
        .or_else(|| meaningful_draft_value(config.get_param_str(primary)))
        .unwrap_or_default()
}

fn strip_spec_extra_params(config: &mut crate::types::EngineConfig) {
    config.extra_params.retain(|k, _| {
        !SPEC_EXTRA_PARAM_KEYS
            .iter()
            .any(|sk| k.eq_ignore_ascii_case(sk))
    });
}

/// Drop stale spec keys from launch payload when the UI group is off.
///
/// MTP with no head is **not** treated as stale here: it is a real user selection
/// (the lane is manual), and `validate_spec_launch` reports it with a clear message.
/// Stripping it here would silently launch the target without speculative decoding.
fn sanitize_spec_extra_params(
    config: &mut crate::types::EngineConfig,
    user_params: &[crate::types::UserEditedTemplateParam],
) {
    let group_active = is_spec_decoding_group_active(user_params);
    // Frontend may inject CLI keys even when groups were mis-filed; trust explicit spec_type.
    let has_spec_type = config
        .get_param_str("spec_type")
        .is_some_and(|t| !t.trim().is_empty() && !t.eq_ignore_ascii_case("none"));

    if !group_active && !has_spec_type {
        strip_spec_extra_params(config);
    }
}

/// Strip speculative params when unsafe: external draft-only files as `-m`, or MTP on non-MTP targets.
fn guard_speculative_decoding(
    user_params: Vec<crate::types::UserEditedTemplateParam>,
    model_path: &str,
    config: &crate::types::EngineConfig,
) -> Vec<crate::types::UserEditedTemplateParam> {
    let (_, shape) = model_cache::get_cached_with_shape(model_path);
    let launchable = crate::spec_draft::is_launchable_target(shape.as_ref(), model_path);

    let mut filtered = user_params;
    let group_active = is_spec_decoding_group_active(&filtered);
    let stale_mtp = mtp_spec_is_stale(config, model_path);

    if !launchable || !group_active || stale_mtp {
        for p in &mut filtered {
            let g = p.ui_group.as_str();
            let is_spec = g.eq_ignore_ascii_case("SPECULATIVE-MTP")
                || g.eq_ignore_ascii_case("SPECULATIVE-DFLASH")
                || g.eq_ignore_ascii_case("SPECULATIVE-DECODING");
            if is_spec && !p.hidden {
                p.hidden = true;
            }
        }
    }

    filtered
}

/// `catalog` is the merged model library, when the caller has it (launch does).
/// `auto` resolves via the main's folder first, then the catalog — a head in a
/// `…/MTP/` sidecar is not a sibling of a main in `…/UD-Q4_K_XL/`, and without the
/// catalog fallback the raw "auto" string reached the user as
/// `Draft model path must be a .gguf file (got "auto")`.
fn validate_spec_launch_with_catalog(
    config: &crate::types::EngineConfig,
    catalog: Option<&[crate::types::ModelEntry]>,
) -> Result<(), String> {
    let (_, shape) = model_cache::get_cached_with_shape(&config.model_path);
    if !crate::spec_draft::is_launchable_target(shape.as_ref(), &config.model_path) {
        return Err(
            "Selected file is a draft model — pick a main model to launch, then assign this as the draft."
                .into(),
        );
    }

    let spec_type = config.get_param_str("spec_type").unwrap_or_default();
    if spec_type.is_empty() || spec_type.eq_ignore_ascii_case("none") {
        return Ok(());
    }

    let draft_value = draft_model_value_for_spec(config, &spec_type);
    let draft_set = !draft_value.is_empty()
        && !draft_value.eq_ignore_ascii_case("off")
        && !draft_value.eq_ignore_ascii_case("none");

    // draft-mtp + a draft path is an external MTP head — no baked-in MTP required.
    if spec_type.eq_ignore_ascii_case("draft-mtp") && !draft_set {
        if !model_has_embedded_mtp(&config.model_path) {
            return Err(
                "This needs a model with MTP baked-in or an external MTP draft.".into(),
            );
        }
        return Ok(());
    }

    if !crate::spec_draft::spec_type_needs_external_draft(&spec_type, &draft_value) {
        return Ok(());
    }

    if !draft_set {
        return Err(format!(
            "Speculative decoding ({spec_type}) requires a draft model — set DRAFT-MODEL to a .gguf file."
        ));
    }

    let pattern = {
        let lower = spec_type.to_lowercase();
        if lower.contains("eagle3") {
            "*eagle3*"
        } else if lower.contains("dspark") {
            "*dspark*"
        } else if lower == "draft-mtp" {
            "*mtp*"
        } else {
            "*dflash*"
        }
    };
    let resolved = crate::spec_draft::resolve_spec_draft_model_path(
        &config.model_path,
        &draft_value,
        pattern,
    )
    .or_else(|| {
        if draft_value.ends_with(".gguf") && std::path::Path::new(&draft_value).is_file() {
            Some(draft_value.clone())
        } else {
            None
        }
    })
    .or_else(|| {
        // `auto`/`on` that the sibling scan could not answer: search the catalog.
        let is_auto = draft_value.eq_ignore_ascii_case("auto")
            || draft_value.eq_ignore_ascii_case("on");
        match (is_auto, catalog) {
            (true, Some(entries)) => {
                crate::spec_draft::resolve_auto_draft_from_catalog(&config.model_path, pattern, entries)
            }
            _ => None,
        }
    });

    let Some(path) = resolved else {
        if draft_value.eq_ignore_ascii_case("auto") || draft_value.eq_ignore_ascii_case("on") {
            return Err(format!(
                "No draft model found for \"{spec_type}\" — auto-search found no match. Set DRAFT-MODEL to a .gguf file or use the picker."
            ));
        }
        return Err(format!(
            "Draft model path must be a .gguf file (got \"{draft_value}\")"
        ));
    };

    if !path.to_lowercase().ends_with(".gguf") {
        return Err("Draft model path must end with .gguf".into());
    }

    Ok(())
}

pub struct AppContext {
    pub stack: Arc<Mutex<EngineStack>>,
    pub log_hub: LogHub,
    pub config: Arc<std::sync::Mutex<AppConfig>>,
    /// Cancellation flag for in-progress library scans.
    pub fit_scan_cancel: Arc<Mutex<Arc<AtomicBool>>>,
    /// Rolling stderr tail per slot — last N lines for load-failure diagnostics.
    pub slot_stderr_tails: Arc<parking_lot::Mutex<std::collections::HashMap<usize, Vec<String>>>>,

    /// Central manager for the Blackwell Output Console (power-user tabbed output system).
    /// This is the single source of truth for all text streams shown in the Blackwell Output Console.
    pub blackwell_output_console_manager: BlackwellOutputConsoleManager,
}

// ── Model Catalog (multi-path merge via model_catalog module) ───────

#[tauri::command]
pub async fn list_models(
    config: tauri::State<'_, Arc<std::sync::Mutex<AppConfig>>>,
    downloads: tauri::State<'_, Arc<tokio::sync::RwLock<crate::download_manager::DownloadManager>>>,
    app: tauri::State<'_, AppContext>,
) -> Result<crate::types::CatalogScanReport, String> {
    let paths = {
        let cfg = config.lock().map_err(|e| e.to_string())?;
        crate::config::get_model_paths(&cfg)
    };

    if paths.is_empty() {
        // No configured paths at all — an empty report, not an empty catalog.
        return Ok(crate::types::CatalogScanReport {
            models: Vec::new(),
            paths: Vec::new(),
        });
    }

    let exclusions = match downloads.try_read() {
        Ok(dm) => dm.catalog_scan_exclusions(),
        Err(_) => {
            log::debug!(
                "[list_models] download manager busy (recovery) — using persisted exclusion manifest"
            );
            crate::download_manager::DownloadManager::catalog_exclusions_from_persisted()
        }
    };

    let t0 = std::time::Instant::now();
    log::info!("[list_models] start ({} path(s))", paths.len());
    let paths_for_scan = paths.clone();
    let (entries, path_scans, _conflicts) = tokio::task::spawn_blocking(move || {
        // Diagnostics first — a directory walk with no metadata work — so the
        // report can still name a path that contributed nothing.
        let scans = model_catalog::scan_path_report(&paths_for_scan);
        let (entries, conflicts) =
            model_catalog::merge_catalogs(&paths_for_scan, None, Some(&exclusions))?;
        Ok::<_, String>((entries, scans, conflicts))
    })
    .await
    .map_err(|e| format!("catalog scan task failed: {}", e))??;
    // Summary for both Tauri log and app console.
    {
        let with_meta = entries.iter().filter(|e| e.metadata.is_some()).count();
        let with_hf = entries.iter().filter(|e| e.hf_meta.is_some()).count();
        let summary = format!("[MERGE] ✅ {} models cataloged ({} with GGUF metadata, {} with HF data)",
            entries.len(), with_meta, with_hf);
        log::info!("{}", summary);
        app.blackwell_output_console_manager.emit_line_to_category(
            crate::output_console::BlackwellOutputConsoleCategory::Utils,
            summary,
            crate::output_console::BlackwellOutputConsoleLineStyle::Success,
        );
    }
    log::info!(
        "[list_models] complete: {:.0}ms",
        t0.elapsed().as_secs_f64() * 1000.0
    );
    // A path that produced nothing is the one thing worth saying out loud: the
    // catalog's empty state is the UI half of the diagnosis, this line is the
    // log half. Only the *actionable* half earns a WARN — a folder that is gone
    // or blocked is a problem to fix; a folder you created and have not filled
    // yet is a normal state, so it stays at debug.
    for scan in &path_scans {
        if let Some(err) = &scan.error {
            log::warn!(
                "[list_models] no models from path '{}': folder is unreadable ({})",
                scan.resolved_path,
                err
            );
        } else if !scan.exists {
            log::warn!(
                "[list_models] no models from path '{}': folder does not exist",
                scan.resolved_path
            );
        } else if scan.gguf_count == 0 {
            log::debug!(
                "[list_models] no models from path '{}': folder holds no .gguf files",
                scan.resolved_path
            );
        }
    }
    if !_conflicts.is_empty() {
        log::warn!("[list_models] Found {} cross-path duplicates (keeping largest)", _conflicts.len());
    }

    Ok(crate::types::CatalogScanReport {
        models: entries,
        paths: path_scans,
    })
}

// ── Engine Management Commands ──────────────────────────────────────

#[tauri::command]
pub async fn launch_engine(
    config: EngineConfig,
    _model_base: Option<String>,
    app: tauri::State<'_, AppContext>,
) -> Result<StackEntry, BlackwellError> {
    let backend_type = if config.backend_type.is_empty() {
        crate::config::DEFAULT_PROVIDER_ID.to_string()
    } else {
        config.backend_type.clone()
    };

    let cfg = {
        let guard = app.config.lock().map_err(|message| BlackwellError::EngineStateBusy {
            message: message.to_string(),
        })?;
        guard.clone()
    };

    let binary_path = engine_utils::find_provider_binary(&cfg, &backend_type, &config.binary_profile)
        .map_err(crate::errors::classify_binary_resolution)?;

    // Driver gate. CUDA 13.4 cannot initialize below its driver floor and the failure would
    // surface as a bare engine exit with no usable log, so refuse here — before a port is
    // claimed or a child is spawned. Probe is fresh per launch (no session cache), which is
    // what lets a driver updated mid-session work on the next launch without a restart.
    // NOTE for tests: `BLACKWELL_FAKE_DRIVER_MAJOR` overrides the probe in debug builds only.
    let gate_profile = engine_utils::binary_profile_from_path(&binary_path)
        .unwrap_or_else(|| crate::config::DEFAULT_BINARY_PROFILE.to_string());
    crate::foundry_toolchain::ensure_driver_supports_profile(&gate_profile)
        .await
        .map_err(|message| BlackwellError::EngineSpawnFailed { message })?;

    let template = crate::templates::ProviderTemplate::load_for_provider(&backend_type)
        .map_err(|message| BlackwellError::EngineSpawnFailed { message })?;

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

    crate::config::validate_provider_binary(binary_path.to_str().unwrap_or(""))
        .map_err(|message| BlackwellError::BinaryValidationFailed { message })?;
    crate::config::validate_model_path(&config.model_path)
        .map_err(|message| BlackwellError::EngineSpawnFailed { message })?;
    sanitize_spec_extra_params(&mut config, &user_params);
    // Catalog for `auto` draft resolution — the same merge `list_models` does, from
    // the config clone already held. Only paid when a draft row says `auto`.
    let draft_catalog = if draft_needs_catalog(&config) {
        let paths = crate::config::get_model_paths(&cfg);
        if paths.is_empty() {
            None
        } else {
            model_catalog::merge_catalogs(&paths, None, None)
                .ok()
                .map(|(entries, _)| entries)
        }
    } else {
        None
    };
    validate_spec_launch_with_catalog(&config, draft_catalog.as_deref())
        .map_err(|message| BlackwellError::EngineSpawnFailed { message })?;

    if let Some(note) = fit_scanner::model_fit_skip_note(&backend_type, &config.model_path) {
        app.blackwell_output_console_manager.emit_line_to_category(
            crate::output_console::BlackwellOutputConsoleCategory::Engines,
            format!("[{}] Launch blocked: {}", config.alias, note),
            crate::output_console::BlackwellOutputConsoleLineStyle::Warning,
        );
        return Err(BlackwellError::FitProbeSkipped { message: note.to_string() });
    }

    // Compute port dynamically from provider's base_port with global collision avoidance.
    // Non-zero `config.port` = prefer same port (hot-swap / harness relaunch) when free.
    let provider_base_port = config.get_param_str("base_port")
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(DEFAULT_BASE_PORT);
    let prefer_port = if config.port > PRIVILEGED_PORT_THRESHOLD {
        Some(config.port)
    } else {
        None
    };

    // Validate base_port is in safe range (avoid privileged ports below PRIVILEGED_PORT_THRESHOLD)
    if provider_base_port <= PRIVILEGED_PORT_THRESHOLD {
        return Err(BlackwellError::PortOutOfRange {
            message: format!("base_port {} is too low — must be > {}", provider_base_port, PRIVILEGED_PORT_THRESHOLD),
        });
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
                    return Err(BlackwellError::AliasExhausted {
                        message: format!("Could not find a free alias for '{}'", base),
                    });
                }
            }
        }
    }

    let (slot_idx, slot_port, live_pids, mut reservation) = {
        let stack = match tokio::time::timeout(Duration::from_secs(5), app.stack.lock()).await {
            Ok(guard) => guard,
            Err(_) => {
                log::error!("[launch_engine] stack lock timeout — possible deadlock");
                return Err(BlackwellError::EngineStateBusy {
                    message: "Stack lock timeout — possible deadlock. Another task may be holding the lock.".to_string(),
                });
            }
        };
        let slot_idx = stack.find_idle_slot().ok_or_else(|| BlackwellError::NoFreeSlot {
            message: "All engine slots are occupied".to_string(),
        })?;
        let mut used_ports = stack.reserved_ports();
        used_ports.extend(crate::engine_port_lock::occupied_ports_from_locks());
        let live_pids = stack.live_engine_pids();
        let slot_port = if let Some(p) = prefer_port {
            if !used_ports.contains(&p) {
                p
            } else {
                pick_next_engine_port(provider_base_port, &used_ports, &live_pids).await
            }
        } else {
            pick_next_engine_port(provider_base_port, &used_ports, &live_pids).await
        };
        let reservation = stack
            .reserve_slot(slot_idx, &config.alias, slot_port)
            .map_err(|message| BlackwellError::NoFreeSlot { message })?;
        (slot_idx, slot_port, live_pids, reservation)
    };
    // Emit with the stack lock released — see EngineStack::emit_stack_changed_unlocked.
    EngineStack::emit_stack_changed_unlocked(&app.stack).await;

    config.port = slot_port;

    if let Err(e) =
        crate::engine_port_lock::reclaim_our_ghost_or_fail(slot_port, &binary_path, &live_pids)
            .await
    {
        {
            let stack = app.stack.lock().await;
            stack.release_reserved_slot(slot_idx, reservation);
        }
        EngineStack::emit_stack_changed_unlocked(&app.stack).await;
        return Err(crate::errors::classify_port_reclaim(slot_port, e));
    }

    let provider_display_name = backend_type.clone();

    // Guard: hide SPEC params when group is off, draft-only `-m`, or stale MTP on non-MTP targets.
    let final_user_params = guard_speculative_decoding(user_params, &config.model_path, &config);

    let supports_fusion = template.spawn_profile.supports_fusion;
    let fusion_adapter = fusion::resolve_adapter(
        &backend_type,
        provider_opt2
            .map(|p| p.template_type.as_str())
            .unwrap_or(""),
        Some(template.spawn_profile.fusion_adapter.as_str()),
    );
    let cmd_args = template.build_command(&config, &gpu_mask, &final_user_params);
    // Quoted for console + session logs when install/model dirs contain spaces.
    let launch_cmd = engine_utils::format_cmd_line(&binary_path, &cmd_args);

    if config.extra_params.contains_key("__test_args") {
        app.blackwell_output_console_manager.emit_line_to_category(
            crate::output_console::BlackwellOutputConsoleCategory::Engines,
            format!(
                "[CUSTOM_FLAGS] {} — REPLACE mode: panel config bypassed; only custom flags used",
                config.alias
            ),
            crate::output_console::BlackwellOutputConsoleLineStyle::Warning,
        );
    }

    // Emit full launch command to Blackwell Output Console (ENGINES category,
    // with the active launch mode so ASSISTED/AUTOPILOT runs are distinguishable).
    let launch_mode = match config.get_param_str("__launch_policy").as_deref() {
        Some("full_auto") => "AUTOPILOT",
        Some("assisted_essentials") | Some("assisted_full") => "ASSISTED",
        _ => match config.get_param_str("__memory_mode").as_deref() {
            Some("full_auto") => "AUTOPILOT",
            _ => "ASSISTED",
        },
    };
    app.blackwell_output_console_manager.emit_line_to_category(
        crate::output_console::BlackwellOutputConsoleCategory::Engines,
        format!("[LAUNCH_CMD] {launch_mode} slot={}: {}", slot_idx, launch_cmd),
        crate::output_console::BlackwellOutputConsoleLineStyle::Command,
    );

    // Launch command logged to Blackwell Output Console instead of eprintln!

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
        reservation: u64,
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
                            if slot.reservation == reservation
                                && matches!(slot.status, SlotStatus::Loading)
                            {
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
                    // Readiness fact for the stream-only fusion brain (no HTTP path to ask).
                    crate::engine_stack::mark_slot_ready(si);
                    EngineStack::emit_stack_changed_unlocked(&s_clone).await;
                }
            });
        })
    }

    // Spawn engine with auto-retry (once) on immediate crash
    let stack_for_ready = app.stack.clone();
    let slot_for_ready = slot_idx;
    let mut last_err = None;
    for attempt in 0..2 {
        // A relaunch starts unready; clear even on retry so a failed attempt cannot leak readiness.
        crate::engine_stack::clear_slot_ready(slot_idx);
        let result = EngineStack::load_slot(
            slot_idx, reservation, &config, &binary_path, gpu_mask.clone(), cmd_args.clone(),
            provider_display_name.clone(), backend_type.clone(), supports_fusion, fusion_adapter,
            &app.stack,
            app.log_hub.clone(),
            make_on_ready(stack_for_ready.clone(), slot_for_ready, reservation),
        ).await;

        match result {
            Ok(()) => {
                last_err = None;
                break;
            }
            Err(e) => {
                if e == crate::engine_stack::LOAD_FAILURE_ALREADY_REPORTED {
                    return Err(BlackwellError::EngineSpawnFailed {
                        message: "Model load failed".to_string(),
                    });
                }
                if e == crate::engine_stack::LAUNCH_CANCELLED {
                    return Err(BlackwellError::EngineSpawnFailed {
                        message: "Launch cancelled".to_string(),
                    });
                }
                let err_msg = e.to_string();
                last_err = Some(e);
                if attempt == 0 {
                    // A failed attempt can leave the slot either cleared (retryable:
                    // immediate crash) or still reserved by this token (pre-spawn error).
                    // Never steal a newer launch reservation.
                    let state = {
                        let stack = app.stack.lock().await;
                        stack.get_slot(slot_idx).map(|slot| {
                            (slot.status.clone(), slot.reservation, slot.pid, slot.child_proc.is_some())
                        })
                    };
                    let owns_slot = matches!(
                        &state,
                        Some((_, current, _, _)) if *current == reservation
                    );
                    let retry = match state {
                        Some((SlotStatus::Idle, _, _, _)) => {
                            let stack = app.stack.lock().await;
                            match stack.reserve_slot(slot_idx, &config.alias, config.port) {
                                Ok(token) => {
                                    reservation = token;
                                    true
                                }
                                Err(_) => false,
                            }
                        }
                        Some((_, current, None, false)) if current == reservation => true,
                        _ => false,
                    };
                    if !retry {
                        if owns_slot {
                            let _ = EngineStack::stop_slot(slot_idx, &app.stack).await;
                        } else {
                            let stack = app.stack.lock().await;
                            stack.release_reserved_slot(slot_idx, reservation);
                        }
                        EngineStack::emit_stack_changed_unlocked(&app.stack).await;
                        return Err(BlackwellError::EngineSpawnFailed {
                            message: err_msg,
                        });
                    }
                    app.blackwell_output_console_manager.emit_line_to_category(
                        crate::output_console::BlackwellOutputConsoleCategory::Error,
                        format!("[{}] [RETRY] Launch failed: {} — retrying...", config.alias, err_msg),
                        crate::output_console::BlackwellOutputConsoleLineStyle::Warning,
                    );
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }
    }

    if let Some(e) = last_err {
        let owns_process = {
            let stack = app.stack.lock().await;
            stack.get_slot(slot_idx).is_some_and(|slot| {
                slot.reservation == reservation
                    && (slot.pid.is_some() || slot.child_proc.is_some())
            })
        };
        if owns_process {
            let _ = EngineStack::stop_slot(slot_idx, &app.stack).await;
        } else {
            let stack = app.stack.lock().await;
            stack.release_reserved_slot(slot_idx, reservation);
        }
        EngineStack::emit_stack_changed_unlocked(&app.stack).await;
        return Err(BlackwellError::EngineSpawnFailed { message: e });
    }

    // A stop may have landed after load_slot committed but before this point — never
    // start a fusion brain for a slot that no longer belongs to this launch.
    let still_current = {
        let stack = app.stack.lock().await;
        stack.get_slot(slot_idx).is_some_and(|slot| {
            slot.reservation == reservation
                && !matches!(slot.status, SlotStatus::Idle)
        })
    };
    if !still_current {
        let stack = app.stack.lock().await;
        stack.release_reserved_slot(slot_idx, reservation);
        drop(stack);
        EngineStack::emit_stack_changed_unlocked(&app.stack).await;
        return Err(BlackwellError::EngineSpawnFailed {
            message: "Launch cancelled".to_string(),
        });
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
                    has_log_belt: fusion_adapter.has_log_belt(),
                },
            ).await;
        });
    }

    let model_name = engine_utils::extract_model_name(&config.model_path);

    // Emit stack-changed push event so frontend gets instant update without polling.
    // Lock released first: this fires on every successful launch, and a frontend that
    // is mid-render must never be able to hold up the engine that just started.
    EngineStack::emit_stack_changed_unlocked(&app.stack).await;

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
        split_mode: config.get_param_str("split").unwrap_or_else(|| "none".to_string()),
        parallel: config.get_parallel().max(1),
        vision: cmd_args.windows(2).any(|w| w[0].eq_ignore_ascii_case("--mmproj"))
            || cmd_args
                .iter()
                .any(|a| a.to_ascii_lowercase().starts_with("--mmproj=")),
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
                stack.get_slot(i).is_some_and(|s| {
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

/// Block toolchain install/extract while engines hold CUDA runtime DLLs open.
pub fn toolchain_install_blocked_message(stack: &EngineStack) -> Option<String> {
    let running: Vec<String> = stack
        .get_status()
        .into_iter()
        .filter(|e| e.status != "IDLE")
        .map(|e| format!("{} [{}]", e.alias, e.status))
        .collect();
    if running.is_empty() {
        return None;
    }
    Some(format!(
        "Stop {} running engine(s) before installing toolchain — CUDA runtime files are locked while engines are active:\n  {}",
        running.len(),
        running.join("\n  ")
    ))
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
                split_mode: e.split_mode.clone(),
                parallel: e.parallel.max(1),
                vision: e.vision,
            }
        })
        .collect();

    Ok(entries)
}

/// Single app-exit teardown: fusion brains, fit scan cancel, foundry children, engines (awaited).
/// Used by window close, REL update exit, and `clean_exit` so no path can bare-`exit(0)` with live engines.
pub async fn teardown_all_for_app_exit(app_handle: &tauri::AppHandle) {
    use crate::output_console::{
        emit_blackwell_output_console_debug_line, emit_blackwell_output_console_engines_line,
        BlackwellOutputConsoleLineStyle,
    };

    let job = if crate::engine_job::is_job_active() {
        "job=active"
    } else {
        "job=inactive"
    };
    let start_msg = format!(
        "[teardown] START app_pid={} {job} — fusion brains, foundry children, then taskkill all engines",
        std::process::id()
    );
    log::info!("{start_msg}");
    crate::session_log::append_session_line(&start_msg);
    // Before any cancel/kill: suppress IPC + pipe-exit FIT work (must beat concurrent pipe EOF).
    crate::app_lifecycle::begin_shutdown();
    emit_blackwell_output_console_engines_line(
        &start_msg,
        BlackwellOutputConsoleLineStyle::Highlight,
    );
    emit_blackwell_output_console_debug_line(&start_msg);

    fusion::stop_all_brains().await;
    emit_blackwell_output_console_debug_line("[teardown] fusion brains stopped");
    crate::session_log::append_session_line("[teardown] fusion brains stopped");

    if let Some(ctx) = app_handle.try_state::<AppContext>() {
        {
            let guard = ctx.fit_scan_cancel.lock().await;
            guard.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        crate::reactor_foundry::foundry_kill_all_children();
        let stopped = EngineStack::kill_all(&ctx.stack).await;
        // Pipe readers (blocking BufRead) need a beat to EOF-exit before runtime/WebView teardown.
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        let done = format!(
            "[teardown] DONE — taskkill awaited for {} engine slot(s); job will also kill any residual on process exit",
            stopped.len()
        );
        log::info!("{done}");
        crate::session_log::append_session_line(&done);
        crate::session_log::append_session_line(&format!(
            "[teardown] slots={stopped:?} app_pid={}",
            std::process::id()
        ));
        emit_blackwell_output_console_engines_line(&done, BlackwellOutputConsoleLineStyle::Success);
        emit_blackwell_output_console_debug_line(format!(
            "[teardown] slots={:?} app_pid={}",
            stopped,
            std::process::id()
        ));
    } else {
        crate::reactor_foundry::foundry_kill_all_children();
        let msg = "[teardown] AppContext unavailable — engines may only die via job object on process exit";
        log::warn!("{msg}");
        crate::session_log::append_session_line(msg);
        emit_blackwell_output_console_engines_line(msg, BlackwellOutputConsoleLineStyle::Warning);
        emit_blackwell_output_console_debug_line(msg);
    }
}

/// Same as [`teardown_all_for_app_exit`] when only stack/cancel handles are available.
pub async fn teardown_stack_for_app_exit(
    stack: &Arc<Mutex<EngineStack>>,
    fit_scan_cancel: &Arc<Mutex<Arc<AtomicBool>>>,
) {
    use crate::output_console::{
        emit_blackwell_output_console_debug_line, emit_blackwell_output_console_engines_line,
        BlackwellOutputConsoleLineStyle,
    };

    let start_msg = format!(
        "[teardown] START (stack path) app_pid={} job_active={}",
        std::process::id(),
        crate::engine_job::is_job_active()
    );
    log::info!("{start_msg}");
    crate::app_lifecycle::begin_shutdown();
    emit_blackwell_output_console_engines_line(
        &start_msg,
        BlackwellOutputConsoleLineStyle::Highlight,
    );
    emit_blackwell_output_console_debug_line(&start_msg);

    fusion::stop_all_brains().await;
    {
        let guard = fit_scan_cancel.lock().await;
        guard.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    crate::reactor_foundry::foundry_kill_all_children();
    let stopped = EngineStack::kill_all(stack).await;
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    let done = format!(
        "[teardown] DONE — taskkill awaited for {} engine slot(s)",
        stopped.len()
    );
    log::info!("{done}");
    emit_blackwell_output_console_engines_line(&done, BlackwellOutputConsoleLineStyle::Success);
    emit_blackwell_output_console_debug_line(format!("[teardown] slots={stopped:?}"));
}

#[tauri::command]
pub async fn clean_exit(app: tauri::State<'_, AppContext>) -> Result<(), String> {
    log::info!("Clean exit requested — killing all engines");
    teardown_stack_for_app_exit(&app.stack, &app.fit_scan_cancel).await;
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

pub(crate) struct AssembledLaunch {
    pub launch_cmd: String,
    /// Unquoted argv after the executable (same tokens as `launch_cmd` without the exe).
    pub cmd_args: Vec<String>,
    pub binary_path: std::path::PathBuf,
    pub gpu_mask: String,
    pub model_dir: std::path::PathBuf,
    pub binary_profile: String,
}

pub(crate) fn assemble_launch_command(
    cfg: &AppConfig,
    config: &EngineConfig,
    backend_type: &str,
) -> Result<AssembledLaunch, String> {
    let binary_path = engine_utils::find_provider_binary(cfg, backend_type, &config.binary_profile)?;
    let template = crate::templates::ProviderTemplate::load_for_provider(backend_type)?;

    let user_params: Vec<crate::types::UserEditedTemplateParam> = cfg
        .providers
        .iter()
        .find(|p| p.id == backend_type)
        .map(|p| p.user_edited_template_params.clone())
        .unwrap_or_default();

    let mut config = config.clone();
    if crate::runtime_settings::affinity_bypassed() {
        config.extra_params.insert(
            "__cpu_affinity".into(),
            serde_json::Value::String("off".into()),
        );
    }
    sanitize_spec_extra_params(&mut config, &user_params);

    let test_has_split = config
        .extra_params
        .get("__test_args")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.windows(2).any(|w| {
                w[0]
                    .as_str()
                    .map(|s| s == "-sm" || s == "--split-mode")
                    .unwrap_or(false)
                    && w.get(1).and_then(|s| s.as_str()).map(|v| {
                        !matches!(v.to_uppercase().as_str(), "NONE" | "0")
                    }).unwrap_or(false)
            })
        })
        .unwrap_or(false);

    let gpu_count = detect_gpu_count();
    let gpu_mask = engine_utils::compute_gpu_mask(&config, gpu_count, test_has_split);
    let final_user_params = guard_speculative_decoding(user_params, &config.model_path, &config);
    let cmd_args = template.build_command(&config, &gpu_mask, &final_user_params);
    // Must be cmd-safe: NoBSproof runs this string inside a .cmd with spaces possible.
    let launch_cmd = engine_utils::format_cmd_line(&binary_path, &cmd_args);

    let model_dir = std::path::Path::new(&config.model_path)
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(crate::config::app_root_dir);

    let binary_profile = if config.binary_profile.is_empty() {
        crate::config::DEFAULT_BINARY_PROFILE.to_string()
    } else {
        config.binary_profile.clone()
    };

    Ok(AssembledLaunch {
        launch_cmd,
        cmd_args,
        binary_path,
        gpu_mask,
        model_dir,
        binary_profile,
    })
}

pub(crate) async fn peek_next_launch_port(
    app: &tauri::State<'_, AppContext>,
    config: &EngineConfig,
) -> Result<u16, String> {
    let provider_base_port = config
        .get_param_str("base_port")
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(DEFAULT_BASE_PORT);
    if provider_base_port <= PRIVILEGED_PORT_THRESHOLD {
        return Err(format!(
            "base_port {} is too low — must be > {}",
            provider_base_port, PRIVILEGED_PORT_THRESHOLD
        ));
    }

    let stack = tokio::time::timeout(Duration::from_secs(5), app.stack.lock())
        .await
        .map_err(|_| "Stack lock timeout".to_string())?;
    let mut used_ports = stack.reserved_ports();
    used_ports.extend(crate::engine_port_lock::occupied_ports_from_locks());
    let live_pids = stack.live_engine_pids();
    drop(stack);

    Ok(
        pick_next_engine_port(provider_base_port, &used_ports, &live_pids).await,
    )
}

#[cfg(windows)]
fn batch_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[cfg(windows)]
fn write_nobsproof_batch(
    assembled: &AssembledLaunch,
    cuda: &crate::foundry_toolchain::PortableCudaEnv,
) -> Result<std::path::PathBuf, String> {
    let scrubbed = crate::foundry_toolchain::scrub_foreign_cuda_from_path(
        &std::env::var("PATH").unwrap_or_default(),
    );
    let path_value = if scrubbed.is_empty() {
        cuda.path_prefix.clone()
    } else {
        format!("{};{}", cuda.path_prefix, scrubbed)
    };

    let cuda_root = cuda.cuda_root.to_string_lossy().to_string();
    let model_dir = assembled.model_dir.to_string_lossy().to_string();
    let script_dir = crate::config::config_dir().join("nobsproof");
    std::fs::create_dir_all(&script_dir)
        .map_err(|e| format!("Failed to create {}: {}", script_dir.display(), e))?;

    let script_path = script_dir.join("latest.cmd");
    let fit_off = assembled
        .launch_cmd
        .split_whitespace()
        .collect::<Vec<_>>()
        .windows(2)
        .any(|w| (w[0] == "--fit" || w[0] == "-fit") && w[1].eq_ignore_ascii_case("off"));
    let fit_env = if fit_off {
        "set \"LLAMA_ARG_FIT=off\"\r\n"
    } else {
        ""
    };
    let body = format!(
        "@echo off\r\n\
         title Blackwell NoBSproof\r\n\
         setlocal EnableExtensions\r\n\
         set \"BLACKWELL_NOBSPROOF=1\"\r\n\
         {fit_env}\
         echo NoBSproof - portable CUDA {} / profile {}\r\n\
         echo CWD: {}\r\n\
         echo GPU mask: {}\r\n\
         echo.\r\n\
         set \"PATH={}\"\r\n\
         set \"CUDA_PATH={}\"\r\n\
         set \"{}={}\"\r\n\
         set \"CUDA_VISIBLE_DEVICES={}\"\r\n\
         set \"LLAMA_LOG_COLORS=on\"\r\n\
         cd /d {}\r\n\
         echo Running:\r\n\
         echo   {}\r\n\
         echo.\r\n\
         {}\r\n\
         echo.\r\n\
         echo Exit code: %%ERRORLEVEL%%\r\n",
        cuda.cuda_version,
        assembled.binary_profile,
        batch_quote(&model_dir),
        assembled.gpu_mask,
        path_value,
        cuda_root,
        cuda.cuda_path_var,
        cuda_root,
        assembled.gpu_mask,
        batch_quote(&model_dir),
        assembled.launch_cmd,
        assembled.launch_cmd,
    );

    std::fs::write(&script_path, body)
        .map_err(|e| format!("Failed to write {}: {}", script_path.display(), e))?;
    Ok(script_path)
}

#[cfg(windows)]
pub(crate) fn spawn_nobsproof_cmd_window(script_path: &std::path::Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const CREATE_NEW_CONSOLE: u32 = 0x00000010;

    let script = script_path.to_string_lossy().to_string();
    // PowerShell single-quoted literal: double embedded single quotes.
    let script_ps = script.replace('\'', "''");

    let spawn_hidden = |program: &str, args: &[&str]| -> Result<(), std::io::Error> {
        std::process::Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
    };

    // 0) Preferred: Windows Terminal — opens the visible console in the modern terminal
    //    instead of legacy conhost. `wt.exe` is a UWP launcher that returns immediately
    //    and accepts the command to run as argv. `cmd /k` keeps the window open.
    //    When this process is already elevated, the resulting terminal window is
    //    elevated too. `wt.exe` must be launched with CREATE_NO_WINDOW so no extra
    //    conhost flashes.
    if let Some(wt) = crate::sidecar_elevate::wt_exe() {
        // Pass the script path BARE. WT re-serializes argv for the spawned cmd
        // and DOUBLES any embedded quote: `wt cmd /k "\"C:\path with space\x.cmd\""`
        // arrives at cmd as `""C:\path with space\x.cmd""` → `'""C:\path' is not
        // recognized`. Rust's own argv quoting is the single layer WT strips.
        let ok = spawn_hidden(
            wt.to_str().unwrap_or("wt.exe"),
            &["cmd", "/k", &crate::sidecar_elevate::wt_path_arg(&script)],
        )
        .is_ok();
        if ok {
            return Ok(());
        }
    }

    // 1) PowerShell Start-Process — fully detached visible console, no job breakaway needed.
    // ArgumentList as an array keeps paths with spaces as one argument to cmd /k.
    let ps_cmd = format!(
        "$p='{script_ps}'; Start-Process -FilePath cmd.exe -ArgumentList @('/k', $p) -WindowStyle Normal"
    );
    if spawn_hidden(
        "powershell",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &ps_cmd,
        ],
    )
    .is_ok()
    {
        return Ok(());
    }

    // 2) cmd start — empty quoted title ("") is required; unquoted first token = program name.
    // Quote the script path so "…\Blackwell OPS\…\script.cmd" is one token after start.
    let quoted_script = format!("\"{script}\"");
    if spawn_hidden(
        "cmd",
        &["/C", "start", "", "/k", &quoted_script],
    )
    .is_ok()
    {
        return Ok(());
    }

    // 3) Last resort — direct console (may share dev terminal stderr; still usable).
    // raw_arg so /k keeps a path with spaces as one command after cmd's quote rules.
    let mut last = std::process::Command::new(crate::sidecar_elevate::system_cmd_exe());
    last.raw_arg(format!(r#"/k ""{}"""#, script.replace('"', "")))
        .creation_flags(CREATE_NEW_CONSOLE);
    last.spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to open CMD window: {}", e))
}

#[tauri::command]
pub async fn preview_launch_command(
    config: EngineConfig,
    provider_id: Option<String>,
    app: tauri::State<'_, AppContext>,
) -> Result<String, String> {
    let backend_type = provider_id.unwrap_or_else(|| {
        if config.backend_type.is_empty() {
            crate::config::DEFAULT_PROVIDER_ID.to_string()
        } else {
            config.backend_type.clone()
        }
    });

    let cfg = {
        let guard = app.config.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };

    let mut config = config;
    config.port = peek_next_launch_port(&app, &config).await?;
    assemble_launch_command(&cfg, &config, &backend_type).map(|a| a.launch_cmd)
}

/// Write `config/nobsproof/latest.cmd` with portable CUDA env + exact launch CLI, open CMD.
#[tauri::command]
pub async fn open_nobsproof_cmd(
    config: EngineConfig,
    provider_id: Option<String>,
    app: tauri::State<'_, AppContext>,
) -> Result<String, String> {
    let backend_type = provider_id.unwrap_or_else(|| {
        if config.backend_type.is_empty() {
            crate::config::DEFAULT_PROVIDER_ID.to_string()
        } else {
            config.backend_type.clone()
        }
    });

    let cfg = {
        let guard = app.config.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };

    crate::config::validate_model_path(&config.model_path)?;

    let mut config = config;
    config.port = peek_next_launch_port(&app, &config).await?;
    let assembled = assemble_launch_command(&cfg, &config, &backend_type)?;
    let cuda = crate::foundry_toolchain::portable_cuda_env_for_profile(&assembled.binary_profile)?;
    // Same driver gate as the piped launch path — NoBSproof must not open a console that
    // dies on CUDA init either.
    crate::foundry_toolchain::ensure_driver_supports_profile(&assembled.binary_profile).await?;

    #[cfg(windows)]
    {
        let script_path = write_nobsproof_batch(&assembled, &cuda)?;
        spawn_nobsproof_cmd_window(&script_path)?;
        app.blackwell_output_console_manager.emit_line_to_category(
            BlackwellOutputConsoleCategory::Debug,
            format!(
                "[NoBSproof] Opened CMD — script: {}",
                script_path.display()
            ),
            BlackwellOutputConsoleLineStyle::Command,
        );
        Ok(script_path.to_string_lossy().to_string())
    }

    #[cfg(not(windows))]
    {
        let _ = (assembled, cuda);
        Err("NoBSproof CMD is supported on Windows only.".into())
    }
}




#[cfg(test)]
mod spec_guard_tests {
    use super::*;
    use crate::types::EngineConfig;

    fn config_with(extra: &[(&str, &str)]) -> EngineConfig {
        let mut extra_params = std::collections::HashMap::new();
        for (k, v) in extra {
            extra_params.insert((*k).to_string(), serde_json::json!(*v));
        }
        EngineConfig {
            alias: "test".to_string(),
            model_path: "C:\\models\\plain.gguf".to_string(),
            port: 8080,
            backend_type: "ggml-master".to_string(),
            binary_profile: String::new(),
            extra_params,
        }
    }

    /// `draft-mtp` with no head on a target with no nextn layers is genuinely stale.
    #[test]
    fn baked_mtp_without_a_head_is_stale() {
        let config = config_with(&[("spec_type", "draft-mtp")]);
        assert!(mtp_spec_is_stale(&config, &config.model_path));
    }

    /// The lane step 4 opens: an external MTP head makes `draft-mtp` valid on a
    /// target that has no baked-in MTP. Stripping the group here hid the lane before
    /// `validate_spec_launch` could ever see it.
    #[test]
    fn external_mtp_head_makes_draft_mtp_valid() {
        for key in ["mtp_draft_model", "dflash_draft_model", "spec_draft_model"] {
            let config = config_with(&[("spec_type", "draft-mtp"), (key, "C:\\models\\head.mtp.gguf")]);
            assert!(
                !mtp_spec_is_stale(&config, &config.model_path),
                "{key} should open the external-MTP lane"
            );
        }
    }

    /// `off` is not a path — it must not look like a configured head.
    #[test]
    fn draft_off_does_not_open_the_lane() {
        let config = config_with(&[("spec_type", "draft-mtp"), ("mtp_draft_model", "off")]);
        assert!(mtp_spec_is_stale(&config, &config.model_path));
    }

    /// Only `draft-mtp` is subject to the baked-in check.
    #[test]
    fn non_mtp_spec_types_are_never_mtp_stale() {
        let config = config_with(&[("spec_type", "draft-dflash")]);
        assert!(!mtp_spec_is_stale(&config, &config.model_path));
    }

    /// The shipped row's `values` list offers `auto`, so `mtp_draft_model=auto` is a
    /// configured draft. Reading only `spec_draft_model` made it look unset and the
    /// launch died on the baked-in error with a head in the library (owner-reported
    /// 2026-10-04).
    #[test]
    fn draft_value_reads_the_mtp_lane_key() {
        let config = config_with(&[("spec_type", "draft-mtp"), ("mtp_draft_model", "auto")]);
        assert_eq!(draft_model_value_for_spec(&config, "draft-mtp"), "auto");

        let config = config_with(&[("spec_type", "draft-dflash"), ("dflash_draft_model", "C:\\m\\d.gguf")]);
        assert_eq!(
            draft_model_value_for_spec(&config, "draft-dflash"),
            "C:\\m\\d.gguf"
        );

        // off/empty are not a path.
        let config = config_with(&[("spec_type", "draft-mtp"), ("mtp_draft_model", "off")]);
        assert!(draft_model_value_for_spec(&config, "draft-mtp").is_empty());
    }
}

