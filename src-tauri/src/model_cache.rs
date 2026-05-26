//! Model metadata cache — persists scanned GGUF headers and HF API data to {exe_parent}/config(-dev)/cache/model_cache.json.
//! GGUF entries are valid if file mtime matches and scan is < 24 hours old.
//! HF entries are persistent — set once at download time, never expire.

use crate::types::{HfMetadata, ModelMetadata};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

const CACHE_FILE: &str = "model_cache.json";

/// Legacy format for migration from old single-metadata cache.
#[derive(Debug, Deserialize)]
struct LegacyCachedEntry {
    metadata: ModelMetadata,
    #[serde(rename = "file_mtime_ms")]
    file_mtime_ms: u64,
}

/// Unified cache entry — HF metadata (persistent) + GGUF scan metadata (no TTL, mtime-only invalidation).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedEntry {
    /// Persistent HF API metadata — set once at download time, never expires.
    #[serde(default, rename = "hfMeta")]
    pub hf_meta: Option<HfMetadata>,
    /// GGUF binary scan results — no TTL, invalidated only when file mtime changes.
    #[serde(default, rename = "ggufMeta")]
    pub gguf_meta: Option<ModelMetadata>,
    /// File modification time in milliseconds (from std::fs::metadata)
    #[serde(rename = "file_mtime_ms")]
    pub file_mtime_ms: u64,
}

/// Load the entire cache from disk with legacy migration support.
pub fn load_cache() -> HashMap<String, CachedEntry> {
    let path = cache_path();
    if !path.exists() {
        return HashMap::new();
    }

    // Try new format first
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            if let Ok(cache) = serde_json::from_str::<HashMap<String, CachedEntry>>(&content) {
                return cache;
            }
            // New format failed — try legacy format and migrate
            if let Ok(legacy_cache) = serde_json::from_str::<HashMap<String, LegacyCachedEntry>>(&content) {
                log::info!("[Cache] Migrating {} legacy entries to unified format", legacy_cache.len());
                let migrated: HashMap<String, CachedEntry> = legacy_cache
                    .into_iter()
                    .map(|(k, v)| {
                        (
                            k,
                            CachedEntry {
                                hf_meta: None,
                                gguf_meta: Some(v.metadata),
                                file_mtime_ms: v.file_mtime_ms,
                            },
                        )
                    })
                    .collect();
                // Save in new format immediately so we don't re-migrate next load
                let _ = save_cache(&migrated);
                return migrated;
            }
        }
        Err(_) => {}
    }

    HashMap::new()
}

/// Save the entire cache to disk.
pub fn save_cache(cache: &HashMap<String, CachedEntry>) -> Result<(), String> {
    let path = cache_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let json = serde_json::to_string_pretty(cache).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

/// Resolve a model path to its cache key, handling forward/backward slash normalization.
fn resolve_cache_key<'a>(cache: &'a HashMap<String, CachedEntry>, model_path: &str) -> Option<&'a String> {
    if cache.contains_key(model_path) {
        return Some(cache.keys().find(|k| k.as_str() == model_path).unwrap());
    }
    // Try normalized lookup (forward slashes vs backslashes)
    cache.keys().find(|k| {
        k.as_str() == model_path.replace("\\", "/") || k.as_str() == model_path.replace("/", "\\")
    })
}

/// Get cached GGUF metadata for a model path if it's still fresh.
pub fn get_cached(model_path: &str) -> Option<ModelMetadata> {
    let cache = load_cache();
    log::debug!("[Cache] Lookup key: {}", model_path);
    log::debug!("[Cache] All keys in cache: {:?}", cache.keys().collect::<Vec<_>>());

    let entry_key = match resolve_cache_key(&cache, model_path) {
        Some(k) => k.clone(),
        None => {
            log::debug!("[Cache] MISS for {}", model_path);
            return None;
        }
    };

    let entry = cache.get(&entry_key).unwrap();

    // Must have GGUF metadata to return
    let gguf_meta = match &entry.gguf_meta {
        Some(m) => m,
        None => {
            log::debug!("[Cache] MISS — no GGUF scan data for {}", model_path);
            return None;
        }
    };

    // Invalidate stale entries that lack file_size_bytes (pre-scan refactor cache corruption)
    if gguf_meta.file_size_bytes == 0 {
        log::warn!("[Cache] INVALID — file_size_bytes is 0 for {}, forcing re-scan", model_path);
        return None;
    }

    // Check file mtime matches — only invalidation mechanism (no TTL, GGUF headers are immutable)
    let current_mtime = std::fs::metadata(model_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);

    if let Some(mtime) = current_mtime {
        if mtime != entry.file_mtime_ms {
            log::debug!("[Cache] MISS — file changed (mtime {} vs cached {})", mtime, entry.file_mtime_ms);
            return None;
        }
    }

    log::debug!("[Cache] HIT for {}", model_path);
    Some(gguf_meta.clone())
}

/// Insert or update GGUF scan metadata for a model path.
/// Preserves existing hf_meta if the entry already exists.
pub fn set_cached(model_path: &str, metadata: ModelMetadata) -> Result<(), String> {
    let mut cache = load_cache();

    let file_mtime_ms = std::fs::metadata(model_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    // Preserve existing hf_meta if entry already exists
    let existing_hf = cache.get(model_path).and_then(|e| e.hf_meta.clone());

    log::debug!(
        "[Cache] SAVE key: {} (mtime {}, arch: {})",
        model_path,
        file_mtime_ms,
        metadata.architecture
    );
    cache.insert(
        model_path.to_string(),
        CachedEntry {
            hf_meta: existing_hf,
            gguf_meta: Some(metadata),
            file_mtime_ms,
        },
    );

    save_cache(&cache)
}

/// Set HF metadata for a model path. Preserves existing gguf_meta if present.
pub fn set_hf_metadata(model_path: &str, hf_meta: HfMetadata) -> Result<(), String> {
    let mut cache = load_cache();

    // Preserve existing gguf_meta and mtime if entry already exists
    let existing_gguf = cache.get(model_path).and_then(|e| e.gguf_meta.clone());
    let existing_mtime = cache.get(model_path).map(|e| e.file_mtime_ms).unwrap_or(0);

    log::debug!(
        "[Cache] SET HF meta for {} (model_id: {})",
        model_path,
        hf_meta.hf_model_id
    );
    cache.insert(
        model_path.to_string(),
        CachedEntry {
            hf_meta: Some(hf_meta),
            gguf_meta: existing_gguf,
            file_mtime_ms: existing_mtime,
        },
    );

    save_cache(&cache)
}

/// Get HF metadata for a model path regardless of GGUF scan state.
pub fn get_hf_metadata(model_path: &str) -> Option<HfMetadata> {
    let cache = load_cache();

    let entry_key = match resolve_cache_key(&cache, model_path) {
        Some(k) => k.clone(),
        None => return None,
    };

    let entry = cache.get(&entry_key).unwrap();
    entry.hf_meta.clone()
}

/// Get cached GGUF metadata using a pre-loaded cache (avoids redundant disk reads).
pub fn get_cached_with_cache(cache: &HashMap<String, CachedEntry>, model_path: &str) -> Option<ModelMetadata> {
    let entry_key = match resolve_cache_key(cache, model_path) {
        Some(k) => k.clone(),
        None => return None,
    };

    let entry = cache.get(&entry_key).unwrap();
    let gguf_meta = match &entry.gguf_meta {
        Some(m) => m,
        None => return None,
    };

    if gguf_meta.file_size_bytes == 0 {
        log::warn!("[Cache] INVALID — file_size_bytes is 0 for {}, forcing re-scan", model_path);
        return None;
    }

    let current_mtime = std::fs::metadata(model_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);

    if let Some(mtime) = current_mtime {
        if mtime != entry.file_mtime_ms {
            log::debug!("[Cache] MISS — file changed (mtime {} vs cached {})", mtime, entry.file_mtime_ms);
            return None;
        }
    }

    Some(gguf_meta.clone())
}

/// Get HF metadata using a pre-loaded cache.
pub fn get_hf_metadata_with_cache(cache: &HashMap<String, CachedEntry>, model_path: &str) -> Option<HfMetadata> {
    let entry_key = match resolve_cache_key(cache, model_path) {
        Some(k) => k.clone(),
        None => return None,
    };

    cache.get(&entry_key).unwrap().hf_meta.clone()
}

/// Clear the entire cache.
pub fn clear_cache() -> Result<(), String> {
    let path = cache_path();
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Get path to model_cache.json — portable: {exe_parent}/config(-dev)/cache/model_cache.json.
fn cache_path() -> PathBuf {
    crate::config::cache_dir().join(CACHE_FILE)
}
