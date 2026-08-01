//! HuggingFace download URL / model-id / quant validation.

use std::path::PathBuf;


/// Allowed HuggingFace download hosts for Model Hub.
pub fn validate_download_url(url: &str) -> Result<(), String> {
    let lower = url.trim().to_lowercase();
    if !lower.starts_with("https://") {
        return Err("Download URL must use HTTPS".to_string());
    }
    let rest = &lower[8..];
    let host = rest.split('/').next().unwrap_or("");
    let allowed = host == "huggingface.co"
        || host.ends_with(".huggingface.co")
        || host == "cdn-lfs.huggingface.co"
        || host == "cdn-lfs.hf.co";
    if !allowed {
        return Err(format!("Download host not allowed: {host}"));
    }
    Ok(())
}

const HF_MODEL_ID_MAX_LEN: usize = 200;
const HF_SEARCH_MAX_QUERY_LEN: usize = 200;
const HF_SEARCH_MAX_LIMIT: usize = 100;
const HF_VRAM_FILTER_MAX_GB: u32 = 512;

fn is_valid_hf_id_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= HF_MODEL_ID_MAX_LEN
        && !segment.contains("..")
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

/// HuggingFace repo IDs must be `author/repo` with safe path segments.
pub fn validate_hf_model_id(model_id: &str) -> Result<(), String> {
    let trimmed = model_id.trim();
    if trimmed.is_empty() {
        return Err("Model ID is required".to_string());
    }
    if trimmed.len() > HF_MODEL_ID_MAX_LEN {
        return Err("Model ID too long".to_string());
    }
    if trimmed.contains("..") || trimmed.contains('\\') {
        return Err("Invalid model ID".to_string());
    }
    let parts: Vec<&str> = trimmed.split('/').collect();
    if parts.len() != 2 {
        return Err("Model ID must be in author/repo format".to_string());
    }
    for part in parts {
        if !is_valid_hf_id_segment(part) {
            return Err("Invalid characters in model ID".to_string());
        }
    }
    Ok(())
}

/// Download filenames must be a single `.gguf` leaf — no path traversal.
pub fn validate_download_file_name(file_name: &str) -> Result<(), String> {
    let name = file_name.trim();
    if name.is_empty() {
        return Err("File name is required".to_string());
    }
    if name.len() > 255 {
        return Err("File name too long".to_string());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("Invalid file name".to_string());
    }
    if !name.to_lowercase().ends_with(".gguf") {
        return Err("Only .gguf files can be downloaded".to_string());
    }
    Ok(())
}

/// Ensure the download URL references the expected HF model and file.
pub fn validate_download_url_matches_model(
    url: &str,
    hf_model_id: &str,
    file_name: &str,
) -> Result<(), String> {
    validate_download_url(url)?;
    validate_hf_model_id(hf_model_id)?;
    validate_download_file_name(file_name)?;

    let lower = url.trim().to_lowercase();
    let model_lower = hf_model_id.trim().to_lowercase();
    let file_lower = file_name.trim().to_lowercase();

    let resolve_fragment = format!("{model_lower}/resolve/");
    if !lower.contains(&resolve_fragment) {
        return Err("Download URL does not match model ID".to_string());
    }
    if !lower.ends_with(&file_lower) && !lower.contains(&format!("/{file_lower}")) {
        return Err("Download URL does not match file name".to_string());
    }
    Ok(())
}

/// Validate a shard/single-file download URL against model ID and repo-relative path.
pub fn validate_shard_download(url: &str, hf_model_id: &str, path_in_repo: &str) -> Result<(), String> {
    validate_download_url(url)?;
    validate_hf_model_id(hf_model_id)?;

    let repo_path = path_in_repo.trim().replace('\\', "/");
    if repo_path.is_empty() || repo_path.contains("..") {
        return Err("Invalid repo path".to_string());
    }

    let file_name = repo_path.rsplit('/').next().unwrap_or(repo_path.as_str());
    validate_download_file_name(file_name)?;

    let lower = url.trim().to_lowercase();
    let model_lower = hf_model_id.trim().to_lowercase();
    let repo_lower = repo_path.to_lowercase();

    if !lower.contains(&format!("{model_lower}/resolve/")) {
        return Err("Download URL does not match model ID".to_string());
    }
    if !lower.contains(&repo_lower) {
        return Err("Download URL does not match repo path".to_string());
    }
    Ok(())
}

/// Validate every part of a quant (single file or sharded set).
pub fn validate_quant_download(gguf: &crate::types::GgufFile, hf_model_id: &str) -> Result<(), String> {
    let parts = gguf.download_parts();
    if parts.is_empty() {
        return Err("No files to download".to_string());
    }
    for part in &parts {
        validate_shard_download(&part.url, hf_model_id, &part.path_in_repo)?;
    }
    Ok(())
}

/// Build destination path: `{default_root}/{author}/{repo}/{path_in_repo}`.
pub fn build_quant_dest_path(
    default_root: &str,
    hf_model_id: &str,
    path_in_repo: &str,
) -> Result<String, String> {
    validate_hf_model_id(hf_model_id)?;

    let repo_path = path_in_repo.trim().replace('\\', "/");
    if repo_path.is_empty() || repo_path.contains("..") {
        return Err("Invalid repo path".to_string());
    }

    let segments: Vec<&str> = hf_model_id.split('/').collect();
    let mut dest = PathBuf::from(default_root);
    dest.push(segments[0]);
    dest.push(segments[1]);
    for seg in repo_path.split('/') {
        if !seg.is_empty() && seg != "." {
            dest.push(seg);
        }
    }
    Ok(dest.to_string_lossy().to_string())
}

/// True when an on-disk file satisfies the expected part (LFS OID or exact byte size).
pub fn quant_part_already_downloaded(dest_path: &str, expected_size: u64, lfs_oid: &str) -> bool {
    if !std::path::Path::new(dest_path).exists() {
        return false;
    }
    if !lfs_oid.is_empty() {
        let cached = crate::model_cache::get_hf_metadata(dest_path);
        return cached
            .as_ref()
            .map(|m| m.lfs_oid == lfs_oid)
            .unwrap_or(false);
    }
    std::fs::metadata(dest_path)
        .map(|m| m.len() == expected_size)
        .unwrap_or(false)
}

/// Normalize and validate HF search IPC inputs.
pub fn normalize_hf_search_inputs(
    query: String,
    vram_limit_gb: Option<u32>,
    sort: Option<String>,
    limit: Option<usize>,
) -> Result<crate::types::HfSearchFilters, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Err("Search query is required".to_string());
    }
    if q.len() > HF_SEARCH_MAX_QUERY_LEN {
        return Err(format!(
            "Search query too long (max {HF_SEARCH_MAX_QUERY_LEN} chars)"
        ));
    }

    let sort_key = sort.unwrap_or_else(|| "downloads".to_string());
    if !matches!(sort_key.as_str(), "downloads" | "likes" | "lastModified") {
        return Err(format!("Invalid sort: {sort_key}"));
    }

    let raw_limit = limit.unwrap_or(50);
    let capped_limit = if raw_limit == 0 {
        50
    } else {
        raw_limit.min(HF_SEARCH_MAX_LIMIT)
    };

    let vram = vram_limit_gb.unwrap_or(0);
    if vram > HF_VRAM_FILTER_MAX_GB {
        return Err(format!("VRAM filter too large (max {HF_VRAM_FILTER_MAX_GB} GB)"));
    }

    Ok(crate::types::HfSearchFilters {
        query: q,
        vram_limit_gb: vram,
        limit: capped_limit,
        sort: sort_key,
    })
}
