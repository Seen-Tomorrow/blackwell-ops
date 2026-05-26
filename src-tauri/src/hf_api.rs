//! Hugging Face API client for model search and download management.
//!
//! Provides async functions to search GGUF models on HF Hub and fetch detailed
//! model information including available quantization variants.

use crate::types::{GgufFile, HfModel, HfModelInfo, HfSearchFilters, HfSearchResponse};
use reqwest::Client;
use serde::Deserialize;

// ── Internal types for HF API response deserialization ───────────────────

#[derive(Debug, Deserialize)]
struct HfApiLink {
    #[serde(rename = "self")]
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

/// Extract GGUF files from a list of HF API siblings.
fn extract_gguf_files(siblings: &[HfSibling], model_id: &str) -> Vec<GgufFile> {
    let mut ggufs = Vec::new();
    for sib in siblings {
        if !sib.rfilename.ends_with(".gguf") {
            continue;
        }
        // Extract quant type from filename like "Llama-3.1-8B-IQ1_Ms.gguf" → "IQ1_MS"
        let quant_type = sib
            .rfilename
            .trim_end_matches(".gguf")
            .split('-')
            .last()
            .unwrap_or("")
            .to_string();

        // Build download URL from _links.self or construct it
        let url = if let Some(ref link) = sib._links {
            link.self_url.clone().unwrap_or_else(|| {
                format!("https://huggingface.co/{}/resolve/main/{}", model_id, sib.rfilename)
            })
        } else {
            format!("https://huggingface.co/{}/resolve/main/{}", model_id, sib.rfilename)
        };

        ggufs.push(GgufFile {
            r#type: quant_type,
            size_bytes: sib.size,
            url,
            lfs_oid: String::new(), // Not available from search siblings — only tree endpoint has it
        });
    }
    ggufs.sort_by(|a, b| a.size_bytes.cmp(&b.size_bytes));
    ggufs
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
        if let Some(pos) = url.find("sort=downloads") {
            url.replace_range(pos..pos + 12, &format!("sort={}", filters.sort));
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

    // 2. Fetch file tree with sizes — paginate through all pages via Link header
    let mut gguf_files = Vec::new();
    let mut next_url = Some(format!(
        "https://huggingface.co/api/models/{}/{}/tree/main/?recursive=true",
        namespace, repo
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

        // Extract next page URL from Link header before consuming response body
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
            namespace, repo
        );

        for entry in &entries {
            if entry.r#type == "file" && entry.path.ends_with(".gguf") {
                let base = entry.path.strip_suffix(".gguf").unwrap_or(&entry.path);
                if base.contains("mmproj") || base.contains("-of-") {
                    continue;
                }

                let filename = base.split('/').last().unwrap_or(base);
                let quant_type = filename.split('-').last().unwrap_or(filename).to_string();

                gguf_files.push(GgufFile {
                    r#type: quant_type,
                    size_bytes: entry.size,
                    url: format!(
                        "https://huggingface.co/{}/{}/resolve/main/{}",
                        namespace, repo, entry.path
                    ),
                    lfs_oid: entry.lfs.as_ref().map(|l| l.oid.clone()).unwrap_or_default(),
                });
            }
        }

        // Parse Link header for next page — look for rel="next"
        next_url = link_header.and_then(|link| {
            let parts: Vec<&str> = link.split(',').collect();
            for part in parts {
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

    gguf_files.sort_by(|a, b| a.size_bytes.cmp(&b.size_bytes));
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
