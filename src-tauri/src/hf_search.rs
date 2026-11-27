// ── HF Search Commands ────────────────────────────────────────────────
//!
//! Moved verbatim out of `main.rs`; bodies unchanged.

use std::sync::Arc;

#[tauri::command]
pub async fn search_hf_models(
    query: String,
    vram_limit_gb: Option<u32>,
    sort: Option<String>,
    limit: Option<usize>,
) -> Result<crate::types::HfSearchResponse, String> {
    let filters = crate::config::normalize_hf_search_inputs(query, vram_limit_gb, sort, limit)?;
    let hf_token = crate::secrets::get_secret("hf_token")?;
    crate::hf_api::search_models(&filters, hf_token.as_deref()).await
}

#[tauri::command]
pub async fn get_hf_model_info(model_id: String) -> Result<crate::types::HfModelInfo, String> {
    crate::config::validate_hf_model_id(&model_id)?;
    let hf_token = crate::secrets::get_secret("hf_token")?;
    crate::hf_api::get_model_info(&model_id, hf_token.as_deref()).await
}

#[tauri::command]
pub async fn get_hf_quant_dates(
    model_id: String,
    paths: Vec<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    crate::config::validate_hf_model_id(&model_id)?;
    let hf_token = crate::secrets::get_secret("hf_token")?;
    // Keyed by repo path, not quant label — a label is not unique across folders.
    crate::hf_api::fetch_quant_last_modified(&model_id, &paths, hf_token.as_deref()).await
}

#[tauri::command]
pub async fn check_hf_repo_updates(
    app_config: tauri::State<'_, Arc<std::sync::Mutex<crate::config::AppConfig>>>,
    model_id: String,
) -> Result<crate::types::HfRepoUpdateStatus, String> {
    crate::config::validate_hf_model_id(&model_id)?;
    let paths = {
        let cfg = app_config.lock().map_err(|e| e.to_string())?;
        crate::config::get_model_paths(&cfg)
    };
    let hf_token = crate::secrets::get_secret("hf_token")?;
    crate::hf_api::check_repo_for_updates(&model_id, &paths, hf_token.as_deref()).await
}

/// One local model file against its Hub repo. Cost is O(that repo), not O(library):
/// the pairing comes from the download-time cache, so there is no catalog walk.
#[tauri::command]
pub async fn check_model_hf_update(
    local_path: String,
) -> Result<crate::types::CatalogUpdateEntry, String> {
    let hf_token = crate::secrets::get_secret("hf_token")?;
    crate::hf_api::check_local_model_update(&local_path, hf_token.as_deref()).await
}
/// Confirm a candidate Hub pairing for one local file and persist it on a match.
///
/// The catalog already derives `author/repo` from an LM Studio-shaped path and stores it
/// as a pairing — but it trusts the folder name. This asks the Hub, so a wrong folder
/// name is caught instead of failing later at update-check time. One request per model;
/// the caller runs the list sequentially and stops on a quota error.
#[tauri::command]
pub async fn verify_hf_pairing(
    model_path: String,
    repo_id: String,
    file_name: String,
    size_bytes: u64,
) -> Result<bool, String> {
    let repo_id = crate::companions::normalize_repo_id(&repo_id)
        .ok_or_else(|| format!("'{repo_id}' is not an org/repo id"))?;
    crate::config::validate_hf_model_id(&repo_id)?;
    let hf_token = crate::secrets::get_secret("hf_token")?;
    let files = crate::hf_api::list_repo_gguf_files(&repo_id, hf_token.as_deref()).await?;
    let matched = files.iter().any(|file| {
        let Some(path_in_repo) = crate::types::hf_resolve_path_from_url(&file.url) else {
            return false;
        };
        let name = path_in_repo.rsplit('/').next().unwrap_or("");
        name.eq_ignore_ascii_case(&file_name)
            && (size_bytes == 0 || file.size_bytes == size_bytes)
    });
    if !matched {
        return Ok(false);
    }
    let slash = repo_id.find('/').unwrap_or(0);
    let meta = crate::types::HfMetadata {
        hf_model_id: repo_id.clone(),
        author: repo_id[..slash].to_string(),
        repo_name: repo_id[slash + 1..].to_string(),
        tags: Vec::new(),
        downloads: 0,
        likes_count: 0,
        quant_type: String::new(),
        file_size_bytes: size_bytes,
        last_modified: String::new(),
        lfs_oid: String::new(),
    };
    crate::model_cache::set_hf_metadata(&model_path, meta)?;
    Ok(true)
}

/// Manually pair a local GGUF file (and any sibling shards in the same folder) with a
/// Hugging Face `owner/repo` ID, persist the pairing in `model_cache`, and immediately
/// run `check_local_model_update` so the caller gets a live update-check verdict.
#[tauri::command]
pub async fn pair_model_hf_repo(
    model_path: String,
    repo_id: String,
) -> Result<crate::types::CatalogUpdateEntry, String> {
    let cleaned = repo_id
        .trim()
        .trim_start_matches("https://huggingface.co/")
        .trim_start_matches("http://huggingface.co/")
        .trim_matches('/');
    let repo_id = crate::companions::normalize_repo_id(cleaned)
        .ok_or_else(|| format!("'{repo_id}' is not an owner/repo id"))?;
    crate::config::validate_hf_model_id(&repo_id)?;

    let path = std::path::Path::new(&model_path);
    if !path.is_file() {
        return Err(format!("Model file not found: {model_path}"));
    }
    let filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("Invalid model file path: {model_path}"))?;
    let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));

    let hf_token = crate::secrets::get_secret("hf_token")?;
    let files = crate::hf_api::list_repo_gguf_files(&repo_id, hf_token.as_deref()).await?;

    let quant = crate::model_catalog::extract_quant(filename);
    let matched = files
        .iter()
        .find(|g| {
            g.download_parts()
                .iter()
                .any(|p| p.file_name.eq_ignore_ascii_case(filename))
        })
        .or_else(|| {
            files
                .iter()
                .find(|g| g.role.is_quant() && g.r#type == quant)
        })
        .ok_or_else(|| format!("No matching GGUF in {repo_id} for {filename}"))?;

    let slash = repo_id.find('/').unwrap_or(0);
    let author = repo_id[..slash].to_string();
    let repo_name = repo_id[slash + 1..].to_string();

    let make_meta = |size_bytes: u64| crate::types::HfMetadata {
        hf_model_id: repo_id.clone(),
        author: author.clone(),
        repo_name: repo_name.clone(),
        tags: Vec::new(),
        downloads: 0,
        likes_count: 0,
        quant_type: matched.r#type.clone(),
        file_size_bytes: size_bytes,
        last_modified: String::new(),
        lfs_oid: String::new(),
    };

    let mut paired_selected = false;
    for part in matched.download_parts() {
        let sibling = dir.join(&part.file_name);
        if sibling.is_file() {
            let size_bytes = std::fs::metadata(&sibling).map(|m| m.len()).unwrap_or(0);
            let sibling_str = sibling.to_string_lossy().to_string();
            crate::model_cache::set_hf_metadata(&sibling_str, make_meta(size_bytes))?;
            if sibling_str == model_path {
                paired_selected = true;
            }
        }
    }
    if !paired_selected {
        let size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        crate::model_cache::set_hf_metadata(&model_path, make_meta(size_bytes))?;
    }

    crate::output_console::emit_blackwell_output_console_utils_line(
        format!("[hf-update] paired  {repo_id}  {filename}"),
        crate::output_console::BlackwellOutputConsoleLineStyle::Highlight,
    );

    crate::hf_api::check_local_model_update(&model_path, hf_token.as_deref()).await
}