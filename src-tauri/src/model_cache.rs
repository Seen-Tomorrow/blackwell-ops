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

fn storage_key_for(model_path: &str) -> String {
    let key = crate::config::model_file_cache_key(model_path);
    if key.is_empty() {
        model_path.to_string()
    } else {
        key
    }
}

fn keys_for_same_file(cache: &HashMap<String, CachedEntry>, model_path: &str) -> Vec<String> {
    let target = storage_key_for(model_path);
    cache
        .keys()
        .filter(|k| storage_key_for(k) == target)
        .cloned()
        .collect()
}

/// Resolve a model path to its cache key, handling canonical + legacy slash variants.
fn resolve_cache_key(cache: &HashMap<String, CachedEntry>, model_path: &str) -> Option<String> {
    let target = storage_key_for(model_path);
    if target.is_empty() {
        return None;
    }
    if cache.contains_key(&target) {
        return Some(target);
    }
    if let Some(k) = cache.keys().find(|k| storage_key_for(k) == target) {
        return Some(k.clone());
    }
    // Slash-only fallback for entries written before canonical keys.
    cache.keys().find(|k| {
        k.as_str() == model_path.replace('\\', "/") || k.as_str() == model_path.replace('/', "\\")
    }).cloned()
}

/// Get cached GGUF metadata for a model path if it's still fresh.
pub fn get_cached(model_path: &str) -> Option<ModelMetadata> {
    let cache = load_cache();
    log::debug!("[Cache] Lookup key: {}", model_path);
    log::debug!("[Cache] All keys in cache: {:?}", cache.keys().collect::<Vec<_>>());

    let entry_key = match resolve_cache_key(&cache, model_path) {
        Some(k) => k,
        None => {
            log::debug!("[Cache] MISS for {}", model_path);
            return None;
        }
    };

    let entry = cache.get(&entry_key)?;

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
    let storage_key = storage_key_for(model_path);

    let file_mtime_ms = std::fs::metadata(model_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    // Preserve existing hf_meta from any legacy alias key.
    let existing_hf = keys_for_same_file(&cache, model_path)
        .iter()
        .find_map(|k| cache.get(k).and_then(|e| e.hf_meta.clone()));

    log::debug!(
        "[Cache] SAVE key: {} (mtime {}, arch: {})",
        storage_key,
        file_mtime_ms,
        metadata.architecture
    );

    for alias in keys_for_same_file(&cache, model_path) {
        if alias != storage_key {
            cache.remove(&alias);
        }
    }

    cache.insert(
        storage_key,
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
    let storage_key = storage_key_for(model_path);

    let aliases = keys_for_same_file(&cache, model_path);
    let existing_gguf = aliases
        .iter()
        .find_map(|k| cache.get(k).and_then(|e| e.gguf_meta.clone()));
    let existing_mtime = aliases
        .iter()
        .find_map(|k| cache.get(k).map(|e| e.file_mtime_ms))
        .unwrap_or(0);

    log::debug!(
        "[Cache] SET HF meta for {} (model_id: {})",
        storage_key,
        hf_meta.hf_model_id
    );

    for alias in aliases {
        if alias != storage_key {
            cache.remove(&alias);
        }
    }

    cache.insert(
        storage_key,
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

    let entry_key = resolve_cache_key(&cache, model_path)?;
    cache.get(&entry_key)?.hf_meta.clone()
}

/// Get cached GGUF metadata using a pre-loaded cache (avoids redundant disk reads).
pub fn get_cached_with_cache(cache: &HashMap<String, CachedEntry>, model_path: &str) -> Option<ModelMetadata> {
    let entry_key = resolve_cache_key(cache, model_path)?;

    let entry = cache.get(&entry_key)?;
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
    let entry_key = resolve_cache_key(cache, model_path)?;
    cache.get(&entry_key)?.hf_meta.clone()
}

/// Drop cached metadata for one model file (all path aliases).
pub fn remove_cached(model_path: &str) -> Result<(), String> {
    let mut cache = load_cache();
    let keys = keys_for_same_file(&cache, model_path);
    if keys.is_empty() {
        return Ok(());
    }
    for key in keys {
        cache.remove(&key);
    }
    save_cache(&cache)
}

/// Move a cache entry from an old on-disk path to a new one after rename.
pub fn rename_cached_path(old_path: &str, new_path: &str) -> Result<(), String> {
    let mut cache = load_cache();
    let old_key = match resolve_cache_key(&cache, old_path) {
        Some(k) => k,
        None => return Ok(()),
    };
    let Some(entry) = cache.remove(&old_key) else {
        return Ok(());
    };
    for alias in keys_for_same_file(&cache, old_path) {
        cache.remove(&alias);
    }
    cache.insert(storage_key_for(new_path), entry);
    save_cache(&cache)
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