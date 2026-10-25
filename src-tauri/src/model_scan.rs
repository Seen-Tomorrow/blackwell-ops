//! `model_scan` — the GGUF metadata scan pipeline and the metadata cache that backs it.
//!
//! Seam: moved out of `engine.rs`.
//! This is the *model library* lifecycle — enumerate the catalog, probe each GGUF with
//! `llama-server` so the UI can show real metadata, persist to the cache, and report
//! progress. It never touches the engine stack: it reads `AppContext` only for the
//! configured catalog paths and the log hub. The VRAM-probe sibling is `fit_scanner`.
//!
//! The cache is what makes the empty-state diagnostics in `model_catalog::scan_path_report`
//! meaningful — a scan that silently cached nothing used to look like "no models".

use crate::engine::AppContext;
use crate::log_hub::LogHub;
use crate::output_console::{
    format_console_completion, BlackwellOutputConsoleCategory, BlackwellOutputConsoleLineStyle,
};
use crate::types::ModelMetadata;

/// Total on-disk size for a GGUF path (sums multi-shard sets). Used for draft VRAM forecast.
#[tauri::command]
pub fn get_path_size_bytes(path: String) -> Result<u64, String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("empty path".into());
    }
    let n = crate::model_catalog::get_total_model_size(p);
    if n == 0 && !std::path::Path::new(p).is_file() {
        return Err(format!("path not found: {p}"));
    }
    Ok(n)
}
#[tauri::command]
pub async fn scan_model_metadata_cmd(
    model_path: String,
    provider_id: Option<String>,
    app: tauri::State<'_, AppContext>,
) -> Result<crate::types::ModelEntry, String> {
    let pid = provider_id.unwrap_or_else(|| crate::config::DEFAULT_PROVIDER_ID.to_string());
    let bin_str = {
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        crate::engine_utils::find_provider_binary(&cfg, &pid, "")?.to_string_lossy().to_string()
    };
    // Gate on the runtime of the binary we will actually spawn, not on every profile.
    crate::foundry_toolchain::require_runtime_for_gguf_scan(&bin_str)?;

    // Run scan on a background thread — closure captures only Strings (Send types)
    let metadata_result: Result<crate::types::ModelMetadata, String> = tokio::task::spawn_blocking({
        let mp = model_path.clone();
        move || crate::gguf_scan::scan_model_metadata(&mp, &bin_str)
    })
    .await
    .map_err(|e| format!("Scan task failed: {}", e))?;

    let mut metadata = metadata_result?;

    // Accumulate shard sizes — scanner only reads first shard's file size
    let total_file_size = crate::model_catalog::get_total_model_size(&model_path);
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
    let fname = std::path::Path::new(&model_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    // Prefer refined GGUF file_type_str (print_info + BPW/tensor majority in gguf_scan).
    let quant = if metadata.file_type_str.trim().is_empty()
        || crate::model_catalog::is_shard_noise_quant(&metadata.file_type_str)
    {
        crate::model_catalog::extract_quant(fname)
    } else {
        metadata.file_type_str.clone()
    };
    // The scan just wrote metadata to the cache; read the shape back through the same
    // self-healing path so this row carries header evidence, not a filename guess.
    let shape = crate::model_cache::get_cached_with_shape(&model_path).1;
    let draft_role_hint = crate::spec_draft::catalog_draft_role_hint(
        shape.as_ref(),
        &model_path,
        "scanning",
        hf_id.as_deref(),
        None,
    );
    Ok(crate::types::ModelEntry {
        path: model_path,
        author: "unknown".to_string(),
        name: "scanning".to_string(),
        quant,
        size_str: crate::model_catalog::calc_size_str_from_bytes(file_size),
        vision: false,
        mmproj: None,
        mmproj_size_mib: None,
        backend_type: pid,
        source_path_label: String::new(),
        metadata: Some(metadata),
        gguf_shape: shape,
        hf_meta: hf_meta_for_entry,
        hf_model_id: hf_id,
        draft_role_hint,
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
        let binary_path = crate::engine_utils::find_provider_binary(&cfg, &pid, "")?;
        // Use all configured paths instead of single model_base
        let paths = crate::config::get_model_paths(&cfg);
        let (catalog, _) = crate::model_catalog::merge_catalogs(&paths, Some(&app.log_hub), None)?;
        let total = catalog.len();
        let all_paths: Vec<String> = catalog.iter().map(|e| e.path.clone()).collect();
        if total == 0 {
            return Ok(0);
        }
        (binary_path.to_string_lossy().to_string(), all_paths, total)
    };
    // Gate on the runtime of the binary we will actually spawn, not on every profile.
    crate::foundry_toolchain::require_runtime_for_gguf_scan(&bin_str)?;

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
            let corrected_size = crate::model_catalog::get_total_model_size(path);
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
            let corrected_size = crate::model_catalog::get_total_model_size(path);
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
