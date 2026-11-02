//! `model_scan` — the GGUF metadata scan pipeline and the metadata cache that backs it.
//!
//! Seam: moved out of `engine.rs`.
//! This is the *model library* lifecycle — enumerate the catalog, read each GGUF header
//! in-process so the UI can show real metadata, persist to the cache, and report
//! progress. It never touches the engine stack: it reads `AppContext` only for the
//! configured catalog paths and the log hub. The VRAM-probe sibling is `fit_scanner`.
//!
//! The cache is what makes the empty-state diagnostics in `model_catalog::scan_path_report`
//! meaningful — a scan that silently cached nothing used to look like "no models".

use crate::engine::AppContext;

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
#[allow(unused_variables)] // provider id is still sent by the UI; the scan needs no binary
pub async fn scan_model_metadata_cmd(
    model_path: String,
    provider_id: Option<String>,
    // Queue the cache write instead of rewriting the whole cache per scan.
    buffered: Option<bool>,
    _app: tauri::State<'_, AppContext>,
) -> Result<crate::types::ModelEntry, String> {
    let pid = provider_id.unwrap_or_else(|| crate::config::DEFAULT_PROVIDER_ID.to_string());

    // Header only — no engine spawn, no CUDA runtime, no 15 s window, and no scrape
    // fallback: a file the reader cannot parse is a scan failure worth seeing.
    let header_read: Result<crate::types::ModelMetadata, String> = tokio::task::spawn_blocking({
        let mp = model_path.clone();
        move || crate::gguf_meta::metadata_from_header(&mp)
    })
    .await
    .map_err(|e| format!("Scan task failed: {}", e))?;

    let mut metadata = header_read?;

    // Accumulate shard sizes — the reader reports the shard set, the catalog total wins.
    let total_file_size = crate::model_catalog::get_total_model_size(&model_path);
    if total_file_size != metadata.file_size_bytes {
        log::info!("[scan_model_metadata_cmd] Corrected file_size for '{}': {} → {}", model_path, metadata.file_size_bytes, total_file_size);
        metadata.file_size_bytes = total_file_size;
    }

    log::info!("[scan_model_metadata_cmd] Scanned path='{}', arch={}", model_path, metadata.architecture);
    // Save to cache (clone metadata for both cache and return value)
    let cached_meta = metadata.clone();
    if buffered.unwrap_or(false) {
        crate::model_cache::set_cached_buffered(&model_path, cached_meta)
    } else {
        crate::model_cache::set_cached(&model_path, cached_meta)
    }
        .map_err(|e| format!("Cache save failed: {}", e))?;

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
pub fn flush_scan_cache_cmd() -> Result<(), String> {
    crate::model_cache::flush_cached()
}

#[tauri::command]
pub async fn clear_model_cache_cmd() -> Result<(), String> {
    crate::model_cache::clear_cache()
}