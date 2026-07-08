//! Hugging Face API client for model search and download management.
//!
//! Provides async functions to search GGUF models on HF Hub and fetch detailed
//! model information including available quantization variants.

use std::collections::HashMap;

use crate::model_catalog;
use crate::types::{
    CatalogUpdateEntry, GgufFile, GgufShard, HfFileUpdateCheck, HfModel, HfModelInfo,
    HfRepoUpdateStatus, HfSearchFilters, HfSearchResponse, ModelEntry, ModelPathEntry,
};
use reqwest::Client;
use serde::Deserialize;

/// Skip mmproj sidecars only — shard files are aggregated, not dropped.
fn should_skip_gguf_filename(filename: &str) -> bool {
    filename.to_lowercase().contains("mmproj")
}

/// True for multi-part shard names like `model-00001-of-00004.gguf`.
pub fn is_gguf_shard_filename(filename: &str) -> bool {
    filename
        .trim_end_matches(".gguf")
        .to_lowercase()
        .contains("-of-")
}

fn build_hf_resolve_url(namespace: &str, repo: &str, path_in_repo: &str) -> String {
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
}

/// Merge shard siblings into single quant entries with summed sizes.
pub fn aggregate_gguf_entries(
    entries: Vec<RawGgufTreeEntry>,
    namespace: &str,
    repo: &str,
) -> Vec<GgufFile> {
    let mut by_quant: HashMap<String, Vec<RawGgufTreeEntry>> = HashMap::new();
    for entry in entries {
        by_quant
            .entry(entry.quant.clone())
            .or_default()
            .push(entry);
    }

    let mut result = Vec::new();
    for (quant, group) in by_quant {
        let shard_entries: Vec<&RawGgufTreeEntry> = group
            .iter()
            .filter(|e| {
                let fname = e.path_in_repo.rsplit('/').next().unwrap_or(&e.path_in_repo);
                is_gguf_shard_filename(fname)
            })
            .collect();

        let single_entries: Vec<&RawGgufTreeEntry> = group
            .iter()
            .filter(|e| {
                let fname = e.path_in_repo.rsplit('/').next().unwrap_or(&e.path_in_repo);
                !is_gguf_shard_filename(fname)
            })
            .collect();

        if !shard_entries.is_empty() {
            let mut shards: Vec<GgufShard> = shard_entries
                .iter()
                .map(|e| {
                    let file_name = e
                        .path_in_repo
                        .rsplit('/')
                        .next()
                        .unwrap_or(&e.path_in_repo)
                        .to_string();
                    GgufShard {
                        file_name,
                        path_in_repo: e.path_in_repo.clone(),
                        size_bytes: e.size,
                        url: build_hf_resolve_url(namespace, repo, &e.path_in_repo),
                        lfs_oid: e.lfs_oid.clone(),
                    }
                })
                .collect();
            shards.sort_by(|a, b| a.path_in_repo.cmp(&b.path_in_repo));
            let total: u64 = shards.iter().map(|s| s.size_bytes).sum();
            let first_url = shards.first().map(|s| s.url.clone()).unwrap_or_default();
            result.push(GgufFile {
                r#type: quant,
                size_bytes: total,
                url: first_url,
                lfs_oid: String::new(),
                shards,
                shard_count: 0,
            });
        } else if let Some(single) = single_entries.iter().min_by_key(|e| e.size) {
            result.push(GgufFile {
                r#type: quant,
                size_bytes: single.size,
                url: build_hf_resolve_url(namespace, repo, &single.path_in_repo),
                lfs_oid: single.lfs_oid.clone(),
                shards: Vec::new(),
                shard_count: 1,
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

    result.sort_by(|a, b| a.size_bytes.cmp(&b.size_bytes));
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
}

/// Extract GGUF files from a list of HF API siblings (aggregates shards per quant).
fn extract_gguf_files(siblings: &[HfSibling], model_id: &str) -> Vec<GgufFile> {
    let parts: Vec<&str> = model_id.split('/').collect();
    if parts.len() != 2 {
        return Vec::new();
    }
    let (namespace, repo) = (parts[0], parts[1]);

    let mut raw = Vec::new();
    for sib in siblings {
        if !sib.rfilename.ends_with(".gguf") || should_skip_gguf_filename(&sib.rfilename) {
            continue;
        }
        raw.push(RawGgufTreeEntry {
            quant: model_catalog::extract_quant(&sib.rfilename),
            size: sib.size,
            path_in_repo: sib.rfilename.clone(),
            lfs_oid: String::new(),
        });
    }
    aggregate_gguf_entries(raw, namespace, repo)
}

/// Check if any GGUF file fits within the VRAM limit.
/// Estimates: model weights (smallest GGUF) + ~2GB KV cache overhead < vram_limit_gb.
fn fits_vram(gguf_files: &[GgufFile], vram_limit_gb: u32) -> bool {
    if vram_limit_gb == 0 || gguf_files.is_empty() {
        return true;
    }
    let smallest = gguf_files[0].size_bytes; // already sorted ascending
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
        // Basic URL-safe encoding for HF search query (alphanumeric, hyphens, dots, underscores are safe)
        let encoded_query: String = filters
            .query
            .chars()
            .map(|c| match c {
                'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '.' | '_' | '~' => c.to_string(),
                _ => format!("%{:02X}", c as u8),
            })
            .collect();
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
            if entry.r#type == "file" && entry.path.ends_with(".gguf") {
                let filename = entry.path.split('/').last().unwrap_or(&entry.path);
                if filename.to_lowercase().contains("mmproj") {
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

fn update_checks_from_disk(
    hf_ggufs: &[GgufFile],
    disk_results: &[crate::types::DiskCheckResult],
) -> Vec<HfFileUpdateCheck> {
    let mut files = Vec::new();
    for disk in disk_results {
        if disk.match_type == "none" {
            continue;
        }

        let hf = hf_ggufs.iter().find(|g| g.r#type == disk.quant_type);
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

/// Scan the local catalog for HF-paired models whose on-disk quant differs from Hub.
pub async fn check_catalog_hf_updates(
    paths: &[ModelPathEntry],
    hf_token: Option<&str>,
) -> Result<Vec<CatalogUpdateEntry>, String> {
    let (catalog, _) = model_catalog::merge_catalogs(paths, None, None)?;
    let client = build_client(hf_token);

    let mut by_repo: HashMap<String, Vec<&ModelEntry>> = HashMap::new();
    for entry in &catalog {
        let repo_id = entry
            .hf_meta
            .as_ref()
            .map(|h| h.hf_model_id.clone())
            .or_else(|| entry.hf_model_id.clone());
        let Some(repo_id) = repo_id else { continue };
        if !repo_id.contains('/') {
            continue;
        }
        by_repo.entry(repo_id).or_default().push(entry);
    }

    let mut results = Vec::new();
    for (repo_id, entries) in by_repo {
        let parts: Vec<&str> = repo_id.split('/').collect();
        if parts.len() != 2 {
            continue;
        }
        let (namespace, repo) = (parts[0], parts[1]);

        let hf_ggufs = match fetch_repo_gguf_files(&client, namespace, repo).await {
            Ok(g) => g,
            Err(e) => {
                log::warn!("[catalog-updates] Skipping {repo_id}: {e}");
                continue;
            }
        };

        let disk_results = model_catalog::check_hf_files_against_disk(
            paths,
            &hf_ggufs,
            None,
            Some(&repo_id),
        );

        for entry in entries {
            let Some(disk) = disk_results.iter().find(|d| d.quant_type == entry.quant) else {
                continue;
            };
            if disk.match_type == "none" {
                continue;
            }
            let has_update = disk.match_type == "mismatch";
            results.push(CatalogUpdateEntry {
                path: entry.path.clone(),
                hf_model_id: repo_id.clone(),
                quant: entry.quant.clone(),
                has_update,
            });
        }
    }

    Ok(results)
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
            },
            RawGgufTreeEntry {
                quant: "Q4_K_M".into(),
                size: 2_000,
                path_in_repo: "m-00001-of-00002.gguf".into(),
                lfs_oid: "a".into(),
            },
        ];
        let out = aggregate_gguf_entries(entries, "author", "repo");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].size_bytes, 3_000);
        assert_eq!(out[0].shard_count, 2);
        assert_eq!(out[0].shards.len(), 2);
        assert_eq!(out[0].shards[0].path_in_repo, "m-00001-of-00002.gguf");
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
        }];
        let disk = vec![
            DiskCheckResult {
                quant_type: "Q4_K_M".into(),
                match_type: "mismatch".into(),
                disk_file_size: Some(4_000),
                disk_author: Some("local".into()),
            },
            DiskCheckResult {
                quant_type: "Q8_0".into(),
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
    fn aggregate_prefers_shards_over_single_with_same_quant() {
        let entries = vec![
            RawGgufTreeEntry {
                quant: "Q4_K_M".into(),
                size: 500,
                path_in_repo: "model-Q4_K_M.gguf".into(),
                lfs_oid: String::new(),
            },
            RawGgufTreeEntry {
                quant: "Q4_K_M".into(),
                size: 1_000,
                path_in_repo: "model-00001-of-00002.gguf".into(),
                lfs_oid: String::new(),
            },
            RawGgufTreeEntry {
                quant: "Q4_K_M".into(),
                size: 1_000,
                path_in_repo: "model-00002-of-00002.gguf".into(),
                lfs_oid: String::new(),
            },
        ];
        let out = aggregate_gguf_entries(entries, "a", "b");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].shard_count, 2);
        assert_eq!(out[0].size_bytes, 2_000);
    }
}
