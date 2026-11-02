//! Hugging Face API client for model search and download management.
//!
//! Provides async functions to search GGUF models on HF Hub and fetch detailed
//! model information including available quantization variants.

use std::collections::{HashMap, HashSet};

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use crate::model_catalog;
use crate::types::{
    CatalogUpdateEntry, GgufFile, GgufRole, GgufShard, HfFileUpdateCheck, HfModel, HfModelInfo,
    HfRepoUpdateStatus, HfSearchFilters, HfSearchResponse, ModelPathEntry, QuantUpdateKind,
};
use reqwest::Client;
use serde::Deserialize;

/// True for any GGUF artifact the repo ships — `.gguf`, but also the `.gguf_file`
/// renames Unsloth/DeepSeek use for swappable pieces (`engram/…-MXFP8.gguf_file`).
fn is_gguf_artifact(path: &str) -> bool {
    model_catalog::gguf_artifact_extension(path).is_some()
}

/// True when the filename is a llama.cpp sidecar rather than model weights.
fn is_sidecar_filename(filename: &str) -> bool {
    let lower = filename.to_lowercase();
    lower.contains("mmproj") || lower.contains("imatrix")
}

/// Folder/file vocabulary of speculative-decoding artifacts. Not a repo list — a role
/// vocabulary, so a `dspark/` head is never presented as a full-weight quant.
const DRAFT_HINTS: &[&str] = &["dspark", "draft", "dflash", "mtp", "eagle"];

fn has_draft_hint(s: &str) -> bool {
    let normalized: String = s
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect();
    normalized
        .split_whitespace()
        .any(|t| DRAFT_HINTS.contains(&t))
}

/// Filename without the shard suffix and without the GGUF extension.
fn artifact_stem(path: &str) -> String {
    let filename = path.rsplit('/').next().unwrap_or(path);
    let base = model_catalog::strip_shard_pattern(filename);
    match base.to_lowercase().find(".gguf") {
        Some(idx) if base.is_char_boundary(idx) => base[..idx].to_string(),
        _ => base,
    }
}

/// First repo folder of a path, or `""` at the repo root.
fn folder_of(path: &str) -> &str {
    match path.find('/') {
        Some(idx) => &path[..idx],
        None => "",
    }
}

fn normalize_tag(s: &str) -> String {
    s.to_uppercase().replace(['-', '.'], "_")
}

/// True when a folder name carries the quant tag it holds (`UD-Q4_K_XL` → `Q4_K_XL`,
/// `BF16/` → `BF16`). A folder that does not (`dspark/`, `engram/`) is a different role,
/// which is what keeps heads and swap pieces out of the quant list without a name list.
fn folder_matches_label(folder: &str, label: &str) -> bool {
    if folder.is_empty() || label.is_empty() || label == "GGUF" {
        return false;
    }
    let f = normalize_tag(folder);
    let l = normalize_tag(label);
    f == l || f.ends_with(&format!("_{l}"))
}

/// True for multi-part shard names like `model-00001-of-00004.gguf`.
pub fn is_gguf_shard_filename(filename: &str) -> bool {
    filename
        .trim_end_matches(".gguf")
        .to_lowercase()
        .contains("-of-")
}

/// Validate that a repo-relative path has no traversal segments.
fn validate_repo_path(path_in_repo: &str) -> Result<(), String> {
    if path_in_repo.is_empty() {
        return Err("Empty repo path".to_string());
    }
    for seg in path_in_repo.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err(format!("Invalid path segment in repo path: '{seg}'"));
        }
    }
    Ok(())
}

fn build_hf_resolve_url(namespace: &str, repo: &str, path_in_repo: &str) -> String {
    // path_in_repo is sourced from HF API /tree/main/ — validate defensively.
    debug_assert!(validate_repo_path(path_in_repo).is_ok());
    format!(
        "https://huggingface.co/{namespace}/{repo}/resolve/main/{path_in_repo}"
    )
}

/// Raw tree/sibling entry before quant aggregation.
#[derive(Debug, Clone)]
pub struct RawGgufTreeEntry {
    pub quant: String,
    pub size: u64,
    pub path_in_repo: String,
    pub lfs_oid: String,
    pub last_modified: String,
}

fn latest_iso_date<'a>(dates: impl Iterator<Item = &'a str>) -> String {
    dates
        .filter(|d| !d.is_empty())
        .max()
        .unwrap_or_default()
        .to_string()
}

/// Merge shard siblings into one artifact per (folder, label, role).
///
/// Grouping by quant label alone loses data: two folders can ship the same label
/// (`engram/Q6_K` + `UD-Q6_K/Q6_K`), and a label is a *property*, not an identity.
/// Including the folder means a same-named quant in another folder survives instead
/// of being merged away.
pub fn aggregate_gguf_entries(
    entries: Vec<RawGgufTreeEntry>,
    namespace: &str,
    repo: &str,
) -> Vec<GgufFile> {
    // A folder holding ≥2 distinct quant tags is a quant bucket (`gguf/`, `quants/`),
    // not a role folder — its files are model weights even when the folder name says nothing.
    let mut labels_by_folder: HashMap<String, HashSet<String>> = HashMap::new();
    for entry in &entries {
        let folder = folder_of(&entry.path_in_repo);
        if !folder.is_empty() && !is_sidecar_filename(&entry.path_in_repo) {
            labels_by_folder
                .entry(folder.to_string())
                .or_default()
                .insert(entry.quant.clone());
        }
    }

    let mut by_artifact: HashMap<(String, String, GgufRole), Vec<&RawGgufTreeEntry>> = HashMap::new();

    for entry in &entries {
        let folder = folder_of(&entry.path_in_repo);
        let filename = entry.path_in_repo.rsplit('/').next().unwrap_or(&entry.path_in_repo);
        let stem = artifact_stem(&entry.path_in_repo);
        let multi_quant_folder = labels_by_folder
            .get(folder)
            .map(|l| l.len() >= 2)
            .unwrap_or(false);

        let role = if is_sidecar_filename(filename) {
            GgufRole::Aux
        } else if !filename.to_lowercase().ends_with(".gguf") {
            // `.gguf_file` — a real file the repo deliberately keeps out of launcher globs.
            GgufRole::Swap
        } else if has_draft_hint(folder) || (folder.is_empty() && has_draft_hint(&stem)) {
            GgufRole::Draft
        } else if folder.is_empty() {
            GgufRole::Quant
        } else if folder_matches_label(folder, &entry.quant) || multi_quant_folder {
            GgufRole::Quant
        } else if has_draft_hint(&stem) {
            GgufRole::Draft
        } else {
            GgufRole::Extra
        };

        // Sidecars and unlabeled extras keep their own name; a quant keeps its tag.
        let label = if role == GgufRole::Aux || entry.quant == "GGUF" {
            stem.clone()
        } else {
            entry.quant.clone()
        };

        by_artifact
            .entry((folder.to_string(), label, role))
            .or_default()
            .push(entry);
    }

    let mut result = Vec::new();
    for ((folder, label, role), group) in by_artifact {

        let shard_entries: Vec<&&RawGgufTreeEntry> = group
            .iter()
            .filter(|e| {
                let fname = e.path_in_repo.rsplit('/').next().unwrap_or(&e.path_in_repo);
                is_gguf_shard_filename(fname)
            })
            .collect();

        if !shard_entries.is_empty() {
            let mut shards: Vec<GgufShard> = shard_entries
                .iter()
                .map(|e| GgufShard {
                    file_name: e
                        .path_in_repo
                        .rsplit('/')
                        .next()
                        .unwrap_or(&e.path_in_repo)
                        .to_string(),
                    path_in_repo: e.path_in_repo.clone(),
                    size_bytes: e.size,
                    url: build_hf_resolve_url(namespace, repo, &e.path_in_repo),
                    lfs_oid: e.lfs_oid.clone(),
                    last_modified: e.last_modified.clone(),
                })
                .collect();
            shards.sort_by(|a, b| a.path_in_repo.cmp(&b.path_in_repo));
            let total: u64 = shards.iter().map(|s| s.size_bytes).sum();
            let first_url = shards.first().map(|s| s.url.clone()).unwrap_or_default();
            let last_modified = latest_iso_date(shards.iter().map(|s| s.last_modified.as_str()));
            result.push(GgufFile {
                r#type: label,
                size_bytes: total,
                url: first_url,
                lfs_oid: String::new(),
                shards,
                shard_count: 0,
                last_modified,
                folder,
                role,
            });
        } else if let Some(single) = group.iter().max_by_key(|e| e.size) {
            result.push(GgufFile {
                r#type: label,
                size_bytes: single.size,
                url: build_hf_resolve_url(namespace, repo, &single.path_in_repo),
                lfs_oid: single.lfs_oid.clone(),
                shards: Vec::new(),
                shard_count: 1,
                last_modified: single.last_modified.clone(),
                folder,
                role,
            });
        }
    }

    for g in &mut result {
        if !g.shards.is_empty() {
            g.shard_count = g.shards.len() as u32;
        } else if g.shard_count == 0 {
            g.shard_count = 1;
        }
    }

    fn role_rank(role: GgufRole) -> u8 {
        match role {
            GgufRole::Quant => 0,
            GgufRole::Draft => 1,
            GgufRole::Swap => 2,
            GgufRole::Extra => 3,
            GgufRole::Aux => 4,
        }
    }
    result.sort_by(|a, b| {
        role_rank(a.role)
            .cmp(&role_rank(b.role))
            .then(a.size_bytes.cmp(&b.size_bytes))
            .then(a.r#type.cmp(&b.r#type))
    });
    result
}

// ── Internal types for HF API response deserialization ───────────────────

#[derive(Debug, Deserialize)]
struct HfApiLink {
    #[serde(rename = "self")]
    #[allow(dead_code)]
    self_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct HfSibling {
    rfilename: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    _links: Option<HfApiLink>,
}

#[derive(Debug, Deserialize)]
struct HfApiResponseModel {
    id: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    likes: u64,
    #[serde(default, rename = "lastModified")]
    last_modified: String,
    #[serde(default)]
    siblings: Option<Vec<HfSibling>>,
}

#[derive(Debug, Deserialize)]
struct HfApiModelInfo {
    id: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    likes: u64,
    #[serde(default, rename = "lastModified")]
    last_modified: String,
}

/// Extract GGUF artifacts from a list of HF API siblings (aggregates shards per artifact).
fn extract_gguf_files(siblings: &[HfSibling], model_id: &str) -> Vec<GgufFile> {
    let parts: Vec<&str> = model_id.split('/').collect();
    if parts.len() != 2 {
        return Vec::new();
    }
    let (namespace, repo) = (parts[0], parts[1]);

    let mut raw = Vec::new();
    for sib in siblings {
        if !is_gguf_artifact(&sib.rfilename) {
            continue;
        }
        raw.push(RawGgufTreeEntry {
            quant: model_catalog::extract_quant(&sib.rfilename),
            size: sib.size,
            path_in_repo: sib.rfilename.clone(),
            lfs_oid: String::new(),
            last_modified: String::new(),
        });
    }
    aggregate_gguf_entries(raw, namespace, repo)
}

/// Check if any GGUF file fits within the VRAM limit.
/// Estimates: model weights (smallest quant) + ~2GB KV cache overhead < vram_limit_gb.
fn fits_vram(gguf_files: &[GgufFile], vram_limit_gb: u32) -> bool {
    if vram_limit_gb == 0 || gguf_files.is_empty() {
        return true;
    }
    // Only model weights matter here — a 1 GB mmproj or an engram swap piece must not
    // make a 500 GB repo look like it fits in 8 GB of VRAM.
    let Some(smallest) = gguf_files
        .iter()
        .filter(|g| g.role.is_quant())
        .map(|g| g.size_bytes)
        .min()
    else {
        return true;
    };
    let kv_cache_overhead = 2u64 * 1024 * 1024 * 1024; // ~2GB
    let limit_bytes = (vram_limit_gb as u64) * 1024 * 1024 * 1024;
    smallest.saturating_add(kv_cache_overhead) <= limit_bytes
}

/// Build the reqwest Client with optional Bearer token.
fn build_client(token: Option<&str>) -> Client {
    let mut builder = Client::builder();
    if let Some(t) = token {
        builder = builder.default_headers({
            use reqwest::header;
            let mut headers = header::HeaderMap::new();
            headers.insert(header::AUTHORIZATION, format!("Bearer {}", t).parse().unwrap());
            headers
        });
    }
    builder.build().expect("failed to build HTTP client")
}

/// Search HF Hub for GGUF models matching the given filters.
pub async fn search_models(
    filters: &HfSearchFilters,
    token: Option<&str>,
) -> Result<HfSearchResponse, String> {
    let client = build_client(token);
    let limit = if filters.limit == 0 { 50 } else { filters.limit };

    // Build query URL with search params
    let mut url = format!(
        "https://huggingface.co/api/models?limit={}&sort=downloads&direction=-1&filter=gguf&full=true",
        limit + 20 // fetch extra for VRAM filtering headroom; full=true required for author/lastModified/siblings
    );

    if !filters.query.is_empty() {
        // Use percent-encoding crate for correct UTF-8 handling.
        let encoded_query = utf8_percent_encode(&filters.query, NON_ALPHANUMERIC).to_string();
        url.push_str("&search=");
        url.push_str(&encoded_query);
    }

    // Replace the default sort param with custom one if needed
    // HF API only accepts: downloads, likes, trending. "lastModified" handled client-side.
    if !filters.sort.is_empty() && filters.sort != "downloads" && filters.sort != "lastModified" {
        let sort_param = "sort=downloads";
        if let Some(pos) = url.find(sort_param) {
            url.replace_range(pos..pos + sort_param.len(), &format!("sort={}", filters.sort));
        }
    }

    log::debug!("HF search URL: {}", url);

    let resp = client.get(&url).send().await.map_err(|e| format!("HF search request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "HF API returned status {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        ));
    }

    let models: Vec<HfApiResponseModel> = resp.json().await.map_err(|e| format!("Failed to parse HF response: {e}"))?;

    // Process each model — extract GGUF files and apply VRAM filter
    let mut results = Vec::new();
    for api_model in &models {
        let siblings = api_model.siblings.as_deref().unwrap_or(&[]);
        let gguf_files = extract_gguf_files(siblings, &api_model.id);

        // Apply VRAM filter if specified
        if !fits_vram(&gguf_files, filters.vram_limit_gb) {
            continue;
        }

        // Derive author from ID if not provided by API
        let author = if api_model.author.is_empty() {
            api_model.id.split('/').next().unwrap_or("").to_string()
        } else {
            api_model.author.clone()
        };

        results.push(HfModel {
            id: api_model.id.clone(),
            author,
            tags: api_model.tags.clone(),
            downloads: api_model.downloads,
            likes_count: api_model.likes,
            last_modified: api_model.last_modified.clone(),
            gguf_files,
        });

        if results.len() >= limit {
            break;
        }
    }

    let has_more = models.len() > results.len();

    Ok(HfSearchResponse {
        models: results,
        has_more,
    })
}

/// Fetch and aggregate all GGUF quants from an HF repo file tree.
async fn fetch_repo_gguf_files(
    client: &Client,
    namespace: &str,
    repo: &str,
) -> Result<Vec<GgufFile>, String> {
    let mut raw_entries: Vec<RawGgufTreeEntry> = Vec::new();
    let mut next_url = Some(format!(
        "https://huggingface.co/api/models/{namespace}/{repo}/tree/main/?recursive=true"
    ));

    while let Some(url) = next_url {
        log::debug!("HF tree URL: {}", url);

        let resp = match client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => return Err(format!("Failed to fetch file tree: {e}")),
        };

        if !resp.status().is_success() {
            log::warn!(
                "Tree endpoint returned {}: {}",
                resp.status(),
                resp.text().await.unwrap_or_default()
            );
            break;
        }

        let link_header = resp.headers().get("Link").and_then(|v| v.to_str().ok()).map(String::from);

        #[derive(Debug, Deserialize)]
        struct LfsInfo {
            oid: String,
        }

        #[derive(Debug, Deserialize)]
        struct TreeEntry {
            path: String,
            #[serde(default)]
            size: u64,
            #[serde(default)]
            r#type: String,
            #[serde(default)]
            lfs: Option<LfsInfo>,
        }

        let entries: Vec<TreeEntry> = match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                log::warn!("Failed to parse tree response: {}", e);
                break;
            }
        };

        log::info!(
            "Tree page returned {} entries for {}/{}",
            entries.len(),
            namespace,
            repo
        );

        for entry in &entries {
            if entry.r#type == "file" && is_gguf_artifact(&entry.path) {
                let filename = entry.path.split('/').next_back().unwrap_or(&entry.path);
                // Reject paths with traversal segments — defense in depth.
                if validate_repo_path(&entry.path).is_err() {
                    log::warn!("Skipping file with invalid path segment: {}", entry.path);
                    continue;
                }

                raw_entries.push(RawGgufTreeEntry {
                    quant: model_catalog::extract_quant(filename),
                    size: entry.size,
                    path_in_repo: entry.path.clone(),
                    lfs_oid: entry
                        .lfs
                        .as_ref()
                        .map(|l| l.oid.clone())
                        .unwrap_or_default(),
                    last_modified: String::new(),
                });
            }
        }

        next_url = link_header.and_then(|link| {
            for part in link.split(',') {
                let p = part.trim();
                if p.contains("rel=\"next\"") || p.contains("rel='next'") {
                    if let Some(start) = p.find('<') {
                        if let Some(end) = p[start..].find('>') {
                            return Some(p[start + 1..start + end].trim().to_string());
                        }
                    }
                }
            }
            None
        });
    }

    Ok(aggregate_gguf_entries(raw_entries, namespace, repo))
}

/// Per-quant lastCommit.date — batched paths-info only (no tree re-fetch).
/// Keys are quant tags (e.g. `Q4_K_M`); sharded quants use the latest shard date.
/// Per-file lastCommit.date — batched paths-info only (no tree re-fetch).
/// Keyed by repo-relative **path**: a quant label is not unique across folders
/// (`engram/Q6_K` vs `UD-Q6_K/Q6_K`), so collapsing by label aliases two artifacts.
pub async fn fetch_quant_last_modified(
    model_id: &str,
    paths: &[String],
    token: Option<&str>,
) -> Result<HashMap<String, String>, String> {
    let parts: Vec<&str> = model_id.split('/').collect();
    if parts.len() != 2 {
        return Err(format!("Invalid model ID format: {model_id}"));
    }
    let (namespace, repo) = (parts[0], parts[1]);
    if paths.is_empty() {
        return Ok(HashMap::new());
    }

    let client = build_client(token);
    fetch_paths_last_modified(&client, namespace, repo, paths).await
}

const PATHS_INFO_BATCH: usize = 100;

#[derive(Debug, Deserialize)]
struct HfPathLastCommit {
    date: String,
}

#[derive(Debug, Deserialize)]
struct HfPathInfoEntry {
    path: String,
    #[serde(default, rename = "lastCommit")]
    last_commit: Option<HfPathLastCommit>,
}

/// Per-file lastCommit.date via HF paths-info (expand=true). Batched POST.
async fn fetch_paths_last_modified(
    client: &Client,
    namespace: &str,
    repo: &str,
    paths: &[String],
) -> Result<HashMap<String, String>, String> {
    if paths.is_empty() {
        return Ok(HashMap::new());
    }

    let url = format!(
        "https://huggingface.co/api/models/{namespace}/{repo}/paths-info/main"
    );
    let mut dates = HashMap::new();

    for chunk in paths.chunks(PATHS_INFO_BATCH) {
        let body = serde_json::json!({
            "paths": chunk,
            "expand": true,
        });
        let resp = client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("paths-info request failed: {e}"))?;

        if !resp.status().is_success() {
            log::warn!(
                "paths-info returned {} for {}/{} ({} paths)",
                resp.status(),
                namespace,
                repo,
                chunk.len()
            );
            continue;
        }

        let entries: Vec<HfPathInfoEntry> = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse paths-info response: {e}"))?;

        for entry in entries {
            if let Some(commit) = entry.last_commit {
                if !commit.date.is_empty() {
                    dates.insert(entry.path, commit.date);
                }
            }
        }
    }

    Ok(dates)
}

fn update_checks_from_disk(
    hf_ggufs: &[GgufFile],
    disk_results: &[crate::types::DiskCheckResult],
) -> Vec<HfFileUpdateCheck> {
    let mut files = Vec::new();
    for disk in disk_results {
        if disk.match_type == "none" {
            continue;
        }

        let hf = hf_ggufs
            .iter()
            .find(|g| g.role.is_quant() && g.r#type == disk.quant_type);
        let hf_size = hf.map(|g| g.size_bytes).unwrap_or(0);
        let hf_lfs = hf.map(|g| g.lfs_oid.clone()).unwrap_or_default();

        let (has_update, status) = match disk.match_type.as_str() {
            "mismatch" => (true, "changed".to_string()),
            "lfs" => (false, "lfs_match".to_string()),
            "size" => (false, "size_match".to_string()),
            _ => continue,
        };

        files.push(HfFileUpdateCheck {
            quant_type: disk.quant_type.clone(),
            has_update,
            cached_size_bytes: disk.disk_file_size.unwrap_or(0),
            hf_size_bytes: hf_size,
            hf_lfs_oid: hf_lfs,
            status,
        });
    }

    files.sort_by(|a, b| a.quant_type.cmp(&b.quant_type));
    files
}

/// Fetch detailed information for a single HF model.
/// Uses two endpoints per the official HF API spec:
/// 1. /api/models/{id} — metadata (description, tags, downloads, likes)
/// 2. /api/models/{ns}/{repo}/tree/main/ — file listing with sizes + pagination
pub async fn get_model_info(model_id: &str, token: Option<&str>) -> Result<HfModelInfo, String> {
    let client = build_client(token);

    // Parse namespace/repo from model_id (e.g. "unsloth/Qwen3.6-35B-A3B-GGUF")
    let parts: Vec<&str> = model_id.split('/').collect();
    if parts.len() != 2 {
        return Err(format!("Invalid model ID format: {}", model_id));
    }
    let (namespace, repo) = (parts[0], parts[1]);

    // 1. Fetch metadata
    let info_url = format!("https://huggingface.co/api/models/{model_id}");
    log::debug!("HF model info URL: {}", info_url);

    let resp = client.get(&info_url).send().await.map_err(|e| format!("HF request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "HF API returned status {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        ));
    }

    let api_model: HfApiModelInfo = resp.json().await.map_err(|e| format!("Failed to parse HF response: {e}"))?;

    let gguf_files = fetch_repo_gguf_files(&client, namespace, repo).await?;

    log::info!(
        "Model {} — found {} GGUF files",
        model_id,
        gguf_files.len()
    );

    // Derive author from ID if not provided by API
    let info_author = if api_model.author.is_empty() {
        api_model.id.split('/').next().unwrap_or("").to_string()
    } else {
        api_model.author.clone()
    };

    Ok(HfModelInfo {
        id: api_model.id,
        author: info_author,
        description: api_model.description,
        tags: api_model.tags,
        downloads: api_model.downloads,
        likes_count: api_model.likes,
        last_modified: api_model.last_modified,
        gguf_files,
    })
}

/// Check local on-disk copies of an HF repo against the current Hub tree.
/// Only quants present in the library (scoped to this repo) are reported.
pub async fn check_repo_for_updates(
    model_id: &str,
    paths: &[ModelPathEntry],
    hf_token: Option<&str>,
) -> Result<HfRepoUpdateStatus, String> {
    let parts: Vec<&str> = model_id.split('/').collect();
    if parts.len() != 2 {
        return Err(format!("Invalid model ID format: {}", model_id));
    }
    let (namespace, repo) = (parts[0], parts[1]);

    let client = build_client(hf_token);
    let hf_ggufs = fetch_repo_gguf_files(&client, namespace, repo).await?;

    let disk_results = model_catalog::check_hf_files_against_disk(
        paths,
        &hf_ggufs,
        None,
        Some(model_id),
    );

    let files = update_checks_from_disk(&hf_ggufs, &disk_results);
    let local_copy_count = files.len();
    let update_count = files.iter().filter(|f| f.has_update).count();

    log::info!(
        "HF update check for {}: {} local quants checked, {} out of date",
        model_id,
        local_copy_count,
        update_count
    );

    Ok(HfRepoUpdateStatus {
        hf_model_id: model_id.to_string(),
        files,
        local_copy_count,
        update_count,
        error: None,
    })
}

/// Check ONE local model file against the Hub, using the HF pairing cached at download time.
///
/// No library walk and no tree fetch for unrelated repos: `hf_model_id` + `quant_type` +
/// `lfs_oid` were written when the file landed, so a per-model check costs one tree call
/// plus one OID comparison (a header-probe range request only when the sizes are close).
/// The old whole-catalog sweep scaled HTTP with library size and is gone — re-add bulk
/// only as an explicit scan with throttling, never as a header button.
pub async fn check_local_model_update(
    local_path: &str,
    hf_token: Option<&str>,
) -> Result<CatalogUpdateEntry, String> {
    let path = std::path::Path::new(local_path);
    if !path.is_file() {
        return Err(format!("Model file not found: {local_path}"));
    }
    let filename = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let quant = model_catalog::extract_quant(filename);

    let unpaired = |reason: &str| CatalogUpdateEntry {
        path: local_path.to_string(),
        hf_model_id: String::new(),
        quant: quant.clone(),
        has_update: false,
        kind: QuantUpdateKind::Current,
        remote_url: String::new(),
        remote_total_size: 0,
        reason: reason.to_string(),
        no_remote: true,
    };

    let Some(meta) = crate::model_cache::get_hf_metadata(local_path) else {
        return Ok(unpaired("No Hugging Face pairing on this file"));
    };
    let parts: Vec<&str> = meta.hf_model_id.split('/').collect();
    if parts.len() != 2 {
        return Ok(unpaired("Hugging Face pairing is incomplete on this file"));
    }
    let (namespace, repo) = (parts[0], parts[1]);

    crate::output_console::emit_blackwell_output_console_utils_line(
        format!("[hf-update] check  {}  {}", meta.hf_model_id, filename),
        crate::output_console::BlackwellOutputConsoleLineStyle::Highlight,
    );

    let client = build_client(hf_token);
    let hf_ggufs = fetch_repo_gguf_files(&client, namespace, repo).await?;

    // Prefer the artifact whose own file name matches this file: a label is not unique
    // across folders (`engram/Q6_K` vs `UD-Q6_K/Q6_K`), the name is.
    let hf = hf_ggufs
        .iter()
        .filter(|g| g.role.is_quant())
        .find(|g| {
            g.download_parts()
                .iter()
                .any(|p| p.file_name.eq_ignore_ascii_case(filename))
        })
        .or_else(|| hf_ggufs.iter().find(|g| g.role.is_quant() && g.r#type == quant));

    let Some(hf) = hf else {
        return Ok(unpaired("No Hub match for this quant"));
    };

    // Compare the whole ARTIFACT, not one file against a shard set's summed size:
    // for a 9-shard quant the checked file is 1/9 of the bytes, so a size compare would
    // cry "full update" forever. Every part is resolved to the local sibling beside the
    // checked file and compared by cached LFS OID (size when the Hub has no OID).
    let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let artifact_parts = hf.download_parts();
    // One cache load for the whole set — `load_cache` re-reads the JSON per call, and a
    // 9-shard quant would otherwise pay for 9 reads on one click.
    let model_cache = crate::model_cache::load_cache();
    let part_matches = |part: &GgufShard| -> bool {
        let sibling = dir.join(&part.file_name);
        let Ok(md) = std::fs::metadata(&sibling) else {
            return false;
        };
        if part.lfs_oid.is_empty() {
            return md.len() == part.size_bytes;
        }
        crate::model_cache::get_hf_metadata_with_cache(&model_cache, &sibling.to_string_lossy())
            .map(|m| m.lfs_oid == part.lfs_oid)
            .unwrap_or(false)
    };

    let checked_part = artifact_parts
        .iter()
        .find(|p| p.file_name.eq_ignore_ascii_case(filename));
    let stale = artifact_parts.iter().filter(|p| !part_matches(p)).count();

    let kind = if stale == 0 {
        QuantUpdateKind::Current
    } else {
        // Only the file in front of us can be header-patched. A stale *sibling* means
        // the quant (re)enters the download queue — which already skips complete parts.
        let checked_stale = checked_part.map(|p| !part_matches(p)).unwrap_or(false);
        match (checked_stale, checked_part) {
            (true, Some(part)) => {
                let local_oid = if meta.lfs_oid.is_empty() {
                    None
                } else {
                    Some(meta.lfs_oid.as_str())
                };
                match crate::gguf_patch::classify_update(
                    local_path,
                    &part.url,
                    part.size_bytes,
                    &part.lfs_oid,
                    local_oid,
                    false,
                )
                .await
                {
                    Ok(QuantUpdateKind::Header) => QuantUpdateKind::Header,
                    Ok(QuantUpdateKind::Current) => QuantUpdateKind::Full,
                    Ok(QuantUpdateKind::Full) => QuantUpdateKind::Full,
                    Err(e) => {
                        log::warn!("[hf-update] classify {local_path} failed: {e}");
                        QuantUpdateKind::Full
                    }
                }
            }
            _ => QuantUpdateKind::Full,
        }
    };

    let (reason, has_update) = match kind {
        QuantUpdateKind::Current => ("Up to date — matches the Hub file".to_string(), false),
        QuantUpdateKind::Header => ("Metadata / template only — small download".to_string(), true),
        QuantUpdateKind::Full if artifact_parts.len() > 1 => (
            format!(
                "{} of {} parts differ from the Hub — download fills only the missing ones",
                stale,
                artifact_parts.len()
            ),
            true,
        ),
        QuantUpdateKind::Full => ("Weights differ — full re-download".to_string(), true),
    };

    crate::output_console::emit_blackwell_output_console_utils_line(
        format!(
            "[hf-update] {} {} → {:?}",
            meta.hf_model_id, hf.r#type, kind
        ),
        if has_update {
            crate::output_console::BlackwellOutputConsoleLineStyle::Warning
        } else {
            crate::output_console::BlackwellOutputConsoleLineStyle::Success
        },
    );

    Ok(CatalogUpdateEntry {
        path: local_path.to_string(),
        hf_model_id: meta.hf_model_id,
        quant: hf.r#type.clone(),
        has_update,
        kind,
        // The header-patch path patches ONE local file, so the remote side must be that
        // file — the quant's first-shard URL + summed size would ask for the wrong bytes.
        remote_url: checked_part.map(|p| p.url.clone()).unwrap_or_else(|| hf.url.clone()),
        remote_total_size: checked_part.map(|p| p.size_bytes).unwrap_or(hf.size_bytes),
        reason,
        no_remote: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_gguf_shard_filename_detects_of_pattern() {
        assert!(is_gguf_shard_filename("Llama-3-00001-of-00004.gguf"));
        assert!(!is_gguf_shard_filename("Llama-3-Q4_K_M.gguf"));
    }

    #[test]
    fn aggregate_shards_sums_sizes_and_collects_parts() {
        let entries = vec![
            RawGgufTreeEntry {
                quant: "Q4_K_M".into(),
                size: 1_000,
                path_in_repo: "m-00002-of-00002.gguf".into(),
                lfs_oid: "b".into(),
                last_modified: "2026-03-01T00:00:00.000Z".into(),
            },
            RawGgufTreeEntry {
                quant: "Q4_K_M".into(),
                size: 2_000,
                path_in_repo: "m-00001-of-00002.gguf".into(),
                lfs_oid: "a".into(),
                last_modified: "2026-03-02T00:00:00.000Z".into(),
            },
        ];
        let out = aggregate_gguf_entries(entries, "author", "repo");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].size_bytes, 3_000);
        assert_eq!(out[0].shard_count, 2);
        assert_eq!(out[0].shards.len(), 2);
        assert_eq!(out[0].shards[0].path_in_repo, "m-00001-of-00002.gguf");
        assert_eq!(out[0].last_modified, "2026-03-02T00:00:00.000Z");
    }

    #[test]
    fn update_checks_only_include_local_quants() {
        use crate::types::DiskCheckResult;

        let hf = vec![GgufFile {
            r#type: "Q4_K_M".to_string(),
            size_bytes: 5_000,
            url: String::new(),
            lfs_oid: String::new(),
            shards: Vec::new(),
            shard_count: 1,
            last_modified: String::new(),
            folder: String::new(),
            role: GgufRole::Quant,
        }];
        let disk = vec![
            DiskCheckResult {
                quant_type: "Q4_K_M".into(),
                path_in_repo: "m-Q4_K_M.gguf".into(),
                match_type: "mismatch".into(),
                disk_file_size: Some(4_000),
                disk_author: Some("local".into()),
            },
            DiskCheckResult {
                quant_type: "Q8_0".into(),
                path_in_repo: "m-Q8_0.gguf".into(),
                match_type: "none".into(),
                disk_file_size: None,
                disk_author: None,
            },
        ];
        let files = update_checks_from_disk(&hf, &disk);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].quant_type, "Q4_K_M");
        assert!(files[0].has_update);
    }

    #[test]
    fn validate_repo_path_accepts_normal_paths() {
        assert!(validate_repo_path("model-Q4_K_M.gguf").is_ok());
        assert!(validate_repo_path("subdir/model-Q4_K_M.gguf").is_ok());
        assert!(validate_repo_path("a/b/c/file.gguf").is_ok());
    }

    #[test]
    fn validate_repo_path_rejects_traversal() {
        assert!(validate_repo_path("../etc/passwd").is_err());
        assert!(validate_repo_path("a/../../etc/passwd").is_err());
        assert!(validate_repo_path("./file.gguf").is_err());
        assert!(validate_repo_path("").is_err());
        assert!(validate_repo_path("a//b/file.gguf").is_err());
    }

    #[test]
    fn aggregate_prefers_shards_over_single_with_same_quant() {
        let entries = vec![
            RawGgufTreeEntry {
                quant: "Q4_K_M".into(),
                size: 500,
                path_in_repo: "model-Q4_K_M.gguf".into(),
                lfs_oid: String::new(),
                last_modified: String::new(),
            },
            RawGgufTreeEntry {
                quant: "Q4_K_M".into(),
                size: 1_000,
                path_in_repo: "model-00001-of-00002.gguf".into(),
                lfs_oid: String::new(),
                last_modified: String::new(),
            },
            RawGgufTreeEntry {
                quant: "Q4_K_M".into(),
                size: 1_000,
                path_in_repo: "model-00002-of-00002.gguf".into(),
                lfs_oid: String::new(),
                last_modified: String::new(),
            },
        ];
        let out = aggregate_gguf_entries(entries, "a", "b");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].shard_count, 2);
        assert_eq!(out[0].size_bytes, 2_000);
    }

    fn raw(quant: &str, size: u64, path: &str) -> RawGgufTreeEntry {
        RawGgufTreeEntry {
            quant: quant.into(),
            size,
            path_in_repo: path.into(),
            lfs_oid: String::new(),
            last_modified: String::new(),
        }
    }

    /// Same path as the production tree walk: the label always comes from the filename.
    fn from_path(path: &str, size: u64) -> RawGgufTreeEntry {
        let filename = path.rsplit('/').next().unwrap_or(path);
        RawGgufTreeEntry {
            quant: model_catalog::extract_quant(filename),
            size,
            path_in_repo: path.into(),
            lfs_oid: String::new(),
            last_modified: String::new(),
        }
    }

    #[test]
    fn artifact_extension_accepts_gguf_and_gguf_file_only() {
        assert!(is_gguf_artifact("model-Q4_K_M.gguf"));
        assert!(is_gguf_artifact("engram/Model-engram-Q5_K.gguf_file"));
        assert!(!is_gguf_artifact("model-Q4_K_M.gguf.part"));
        assert!(!is_gguf_artifact("README.md"));
        assert!(!is_gguf_artifact("imatrix.gguf.json"));
    }

    /// The classification that keeps a 4 TB repo honest: quant folders are weights,
    /// `dspark/` is a draft head, `engram/*.gguf_file` is a swap piece, sidecars are tools.
    /// Paths below are the real tree of `unsloth/DeepSeek-V4.1-Flash-1017-GGUF`.
    #[test]
    fn classifies_repo_roles_without_a_folder_name_list() {
        let entries = vec![
            from_path(
                "UD-Q4_K_XL/DeepSeek-V4.1-Flash-1017-UD-Q4_K_XL-00001-of-00009.gguf",
                5_780_589,
            ),
            from_path(
                "UD-Q4_K_XL/DeepSeek-V4.1-Flash-1017-UD-Q4_K_XL-00002-of-00009.gguf",
                48_129_640_000,
            ),
            from_path(
                "UD-Q2_K_XL/DeepSeek-V4.1-Flash-1017-UD-Q2_K_XL-00001-of-00007.gguf",
                2_000,
            ),
            from_path(
                "dspark-DeepSeek-V4.1-Flash-1017-Q8_0.gguf",
                7_976_914_240,
            ),
            from_path(
                "dspark/dspark-DeepSeek-V4.1-Flash-1017-BF16.gguf",
                8_506_281_280,
            ),
            from_path(
                "engram/DeepSeek-V4.1-Flash-1017-engram-Q6_K.gguf_file",
                161_284_798_692,
            ),
            from_path(
                "engram/DeepSeek-V4.1-Flash-1017-engram-MXFP8.gguf_file",
                202_758_032_592,
            ),
            from_path("mmproj-BF16.gguf", 972_208_288),
            from_path("imatrix_unsloth.gguf_file", 789_186_368),
        ];
        let out = aggregate_gguf_entries(entries, "unsloth", "repo");

        let role_of = |folder: &str, label: &str| {
            out.iter()
                .find(|g| g.folder == folder && g.r#type == label)
                .map(|g| g.role)
                .unwrap_or_else(|| {
                    let seen: Vec<String> = out
                        .iter()
                        .map(|g| format!("{}/{}", g.folder, g.r#type))
                        .collect();
                    panic!("missing {folder}/{label} — got {seen:?}")
                })
        };

        assert_eq!(role_of("UD-Q4_K_XL", "Q4_K_XL"), GgufRole::Quant);
        assert_eq!(role_of("UD-Q2_K_XL", "Q2_K_XL"), GgufRole::Quant);
        assert_eq!(role_of("dspark", "BF16"), GgufRole::Draft);
        assert_eq!(role_of("", "Q8_0"), GgufRole::Draft);
        assert_eq!(role_of("engram", "Q6_K"), GgufRole::Swap);
        assert_eq!(role_of("engram", "MXFP8"), GgufRole::Swap);
        assert_eq!(role_of("", "mmproj-BF16"), GgufRole::Aux);
        assert_eq!(role_of("", "imatrix_unsloth"), GgufRole::Aux);
        assert_eq!(out.len(), 8, "shards merge, nothing else is dropped");
        assert_eq!(
            out.iter().filter(|g| g.role.is_quant()).count(),
            2,
            "only the two UD folders are launchable weights"
        );
    }

    /// Same label in two folders must stay two artifacts — the old label-only grouping
    /// merged them and silently kept one.
    #[test]
    fn same_label_in_two_folders_stays_two_entries() {
        let entries = vec![
            raw("Q6_K", 1_000, "Q6_K/model-Q6_K.gguf"),
            raw("Q6_K", 2_000, "other/model-Q6_K.gguf"),
        ];
        let out = aggregate_gguf_entries(entries, "a", "b");
        assert_eq!(out.len(), 2);
        assert_eq!(out.iter().filter(|g| g.r#type == "Q6_K").count(), 2);
    }
}
