//! Model metadata cache — persists scanned GGUF headers and HF API data to {exe_parent}/config(-dev)/cache/model_cache.json.
//! GGUF entries are valid if file mtime matches and scan is < 24 hours old.
//! HF entries are persistent — set once at download time, never expire.

use crate::gguf_shape::GgufShape;
use crate::types::{HfMetadata, ModelMetadata};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const CACHE_FILE: &str = "model_cache.json";

/// Unified cache entry — HF metadata (persistent) + GGUF scan metadata (no TTL, mtime-only invalidation).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedEntry {
    /// Persistent HF API metadata — set once at download time, never expires.
    #[serde(default, rename = "hfMeta")]
    pub hf_meta: Option<HfMetadata>,
    /// GGUF binary scan results — no TTL, invalidated only when file mtime changes.
    #[serde(default, rename = "ggufMeta")]
    pub gguf_meta: Option<ModelMetadata>,
    /// Header tensor-table facts, read without an engine spawn. A **sibling** of
    /// `gguf_meta`, not a field inside it: mtime is the only invalidation signal, so
    /// anything nested under a value written by an older scan would stay stale forever.
    #[serde(default, rename = "ggufShape")]
    pub gguf_shape: Option<GgufShape>,
    /// File modification time in milliseconds (from std::fs::metadata)
    #[serde(rename = "file_mtime_ms")]
    pub file_mtime_ms: u64,
}

/// Load the entire cache from disk.
pub fn load_cache() -> HashMap<String, CachedEntry> {
    load_cache_from(&cache_path())
}

/// Load from an explicit file — the test seam. See [`cache_path_in`].
fn load_cache_from(path: &Path) -> HashMap<String, CachedEntry> {
    if !path.exists() {
        return HashMap::new();
    }

    if let Ok(content) = std::fs::read_to_string(path) {
        if let Ok(cache) = serde_json::from_str::<HashMap<String, CachedEntry>>(&content) {
            return cache;
        }
    }

    HashMap::new()
}

/// Save the entire cache to disk.
pub fn save_cache(cache: &HashMap<String, CachedEntry>) -> Result<(), String> {
    save_cache_to(cache, &cache_path())
}

/// Save to an explicit file — the test seam. See [`cache_path_in`].
fn save_cache_to(cache: &HashMap<String, CachedEntry>, path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let json = serde_json::to_string_pretty(cache).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())?;
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

fn current_mtime_ms(model_path: &str) -> Option<u64> {
    std::fs::metadata(model_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

/// Shared validity gate: has GGUF scan data, a real file size, and an unchanged mtime.
fn entry_is_fresh<'a>(
    entry: &'a CachedEntry,
    model_path: &str,
    require_shape: bool,
) -> Option<&'a CachedEntry> {
    let gguf_meta = entry.gguf_meta.as_ref()?;

    if gguf_meta.file_size_bytes == 0 {
        log::warn!("[Cache] INVALID — file_size_bytes is 0 for {}, forcing re-scan", model_path);
        return None;
    }

    if require_shape && entry.gguf_shape.is_none() {
        return None;
    }

    if let Some(mtime) = current_mtime_ms(model_path) {
        if mtime != entry.file_mtime_ms {
            log::debug!("[Cache] MISS — file changed (mtime {} vs cached {})", mtime, entry.file_mtime_ms);
            return None;
        }
    }

    Some(entry)
}

/// Read the header tensor table for a model file. Header-only — no engine spawn.
/// Sharded sets are merged so a nextn tensor living in a later split is still seen.
fn read_shape_for_model(model_path: &str) -> Option<GgufShape> {
    let shards = crate::model_catalog::shard_sibling_paths(model_path);
    if shards.len() > 1 {
        return crate::gguf_shape::read_shape_sharded(&shards)
            .map(|mut shape| {
                shape.shard_count = shards.len() as u32;
                shape
            })
            .ok();
    }
    crate::gguf_shape::read_shape_for_path(model_path).ok()
}

/// Get cached GGUF metadata for a model path if it's still fresh.
pub fn get_cached(model_path: &str) -> Option<ModelMetadata> {
    get_cached_with_shape(model_path).0
}

/// Get cached GGUF metadata **and** the cached `GgufShape` for a model path.
///
/// Self-healing, no migration: an entry that has `gguf_meta` but no `gguf_shape`
/// (written before the shape field existed) gets its header read here — cheap, no
/// engine spawn — and the shape is written back. That is the whole mechanism.
pub fn get_cached_with_shape(model_path: &str) -> (Option<ModelMetadata>, Option<GgufShape>) {
    let mut cache = load_cache();
    log::debug!("[Cache] Lookup key: {}", model_path);
    log::debug!("[Cache] All keys in cache: {:?}", cache.keys().collect::<Vec<_>>());

    let Some(entry_key) = resolve_cache_key(&cache, model_path) else {
        log::debug!("[Cache] MISS for {}", model_path);
        return (None, None);
    };

    let fresh = entry_is_fresh(&cache[&entry_key], model_path, false).is_some();
    if !fresh {
        log::debug!("[Cache] MISS for {}", model_path);
        return (None, None);
    }

    let mut shape = cache[&entry_key].gguf_shape.clone();
    if shape.is_none() {
        shape = read_shape_for_model(model_path);
        if let Some(ref shape) = shape {
            cache.entry(entry_key.clone()).and_modify(|e| e.gguf_shape = Some(shape.clone()));
            if let Err(e) = save_cache(&cache) {
                log::warn!("[Cache] Failed to persist shape for {}: {}", model_path, e);
            }
        }
    }

    let meta = cache[&entry_key].gguf_meta.clone();
    log::debug!("[Cache] HIT for {}", model_path);
    (meta, shape)
}

/// Insert or update GGUF scan metadata for a model path.
/// Preserves existing hf_meta if the entry already exists.
pub fn set_cached(model_path: &str, metadata: ModelMetadata) -> Result<(), String> {
    let mut cache = load_cache();
    let storage_key = storage_key_for(model_path);

    let file_mtime_ms = current_mtime_ms(model_path).unwrap_or(0);

    // Preserve existing hf_meta from any alias key.
    let existing_hf = keys_for_same_file(&cache, model_path)
        .iter()
        .find_map(|k| cache.get(k).and_then(|e| e.hf_meta.clone()));
    // A fresh engine scan says nothing about the tensor table — keep any shape we have.
    let existing_shape = keys_for_same_file(&cache, model_path)
        .iter()
        .find_map(|k| cache.get(k).and_then(|e| e.gguf_shape.clone()));

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
            gguf_shape: existing_shape,
            file_mtime_ms,
        },
    );

    save_cache(&cache)
}

/// Set HF metadata for a model path. Preserves existing gguf_meta / gguf_shape if present.
pub fn set_hf_metadata(model_path: &str, hf_meta: HfMetadata) -> Result<(), String> {
    let mut cache = load_cache();
    let storage_key = storage_key_for(model_path);

    let aliases = keys_for_same_file(&cache, model_path);
    let existing_gguf = aliases
        .iter()
        .find_map(|k| cache.get(k).and_then(|e| e.gguf_meta.clone()));
    let existing_shape = aliases
        .iter()
        .find_map(|k| cache.get(k).and_then(|e| e.gguf_shape.clone()));
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
            gguf_shape: existing_shape,
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
    get_cached_with_cache_and_shape(cache, model_path).and_then(|(meta, _)| meta)
}

/// Get cached GGUF metadata **and** shape using a pre-loaded cache.
///
/// Read-only: this never touches the header. Callers that need a shape for an entry
/// written before the field existed use [`get_cached_with_shape`], which self-heals.
pub fn get_cached_with_cache_and_shape(
    cache: &HashMap<String, CachedEntry>,
    model_path: &str,
) -> Option<(Option<ModelMetadata>, Option<GgufShape>)> {
    let entry_key = resolve_cache_key(cache, model_path)?;
    let entry = cache.get(&entry_key)?;
    let entry = entry_is_fresh(entry, model_path, false)?;
    Some((entry.gguf_meta.clone(), entry.gguf_shape.clone()))
}

/// Read (and persist) the shape for one path against a pre-loaded cache.
/// Returns the shape whether it came from the cache or from a fresh header read.
/// Mutates `cache` in place; the caller decides when to [`save_cache`].
pub fn ensure_shape_in_cache(
    cache: &mut HashMap<String, CachedEntry>,
    model_path: &str,
) -> Option<GgufShape> {
    let entry_key = resolve_cache_key(cache, model_path)?;
    if let Some(shape) = cache.get(&entry_key)?.gguf_shape.clone() {
        return Some(shape);
    }
    // Nothing scanned yet — a shape alone would not be a valid entry to write back.
    cache.get(&entry_key)?.gguf_meta.as_ref()?;
    let shape = read_shape_for_model(model_path)?;
    cache.entry(entry_key).and_modify(|e| e.gguf_shape = Some(shape.clone()));
    Some(shape)
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

/// Move cached metadata when a model file is renamed.
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
    cache_path_in(&crate::config::cache_dir())
}

/// Seam for tests: the cache lives under the app root, and a test that wrote through
/// the real path would corrupt the owner's live model cache.
fn cache_path_in(dir: &Path) -> PathBuf {
    dir.join(CACHE_FILE)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(tag: &str) -> PathBuf {
        // This session runs at Low integrity and cannot write std::env::temp_dir();
        // app_root_dir() is target/debug, which is writable. See gguf_shape::scratch_dir.
        let dir = crate::config::app_root_dir().join(format!(
            "gguf-shape-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn stub_meta(path: &str) -> ModelMetadata {
        ModelMetadata {
            architecture: "qwen35".into(),
            model_type_label: String::new(),
            n_layer: 48,
            n_ctx_train: 0,
            n_embd: 0,
            n_head: 0,
            n_head_kv: 0,
            n_expert: 0,
            n_expert_used: 0,
            rope_freq_base: 0.0,
            rope_dim: 0,
            feed_forward_length: 0,
            expert_feed_forward_length: 0,
            file_type_str: String::new(),
            bpw: 0.0,
            tensor_counts: HashMap::new(),
            total_params_str: String::new(),
            vocab_size: 0,
            general_name: String::new(),
            rope_scaling_type: String::new(),
            tokenizer_model: String::new(),
            file_size_bytes: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
            scan_timestamp: 0,
            file_created: 0,
            nextn_predict_layers: 0,
            raw_kvs: HashMap::new(),
            raw_print_info: HashMap::new(),
            general_author: String::new(),
            general_repo_url: String::new(),
            general_basename: String::new(),
            general_quantized_by: String::new(),
            general_license: String::new(),
            general_tags: Vec::new(),
            base_models: Vec::new(),
            chat_template: String::new(),
        }
    }

    fn fresh_entry_for(model_path: &str) -> CachedEntry {
        CachedEntry {
            hf_meta: None,
            gguf_meta: Some(stub_meta(model_path)),
            gguf_shape: None,
            file_mtime_ms: current_mtime_ms(model_path).unwrap_or(0),
        }
    }

    /// A `ggufMeta` entry with no `ggufShape` is healed by a header read, not migrated.
    #[test]
    fn shape_self_heals_from_a_meta_only_entry() {
        let dir = scratch_dir("heal");
        let model = crate::gguf_shape::tests::write_minimal_gguf(
            &dir,
            "Qwen3.5-4B-Q4_K_M.gguf",
            "qwen35",
            2,
            &["blk.0.attn_q.weight", "token_embd.weight"],
        );
        let model_path = model.to_string_lossy().to_string();
        // Never through the real cache file — that is the owner's live data.
        let cache_file = cache_path_in(&dir);

        let key = storage_key_for(&model_path);
        let mut cache: HashMap<String, CachedEntry> = HashMap::new();
        cache.insert(key.clone(), fresh_entry_for(&model_path));
        save_cache_to(&cache, &cache_file).expect("seed cache");

        let mut cache = load_cache_from(&cache_file);
        assert!(cache[&key].gguf_shape.is_none(), "seeded without a shape");

        let shape = ensure_shape_in_cache(&mut cache, &model_path);
        assert!(shape.is_some(), "header read should have produced a shape");
        assert_eq!(shape.unwrap().architecture, "qwen35");
        assert!(cache[&key].gguf_shape.is_some(), "shape now sits beside ggufMeta");

        // Second call is a cache hit — no second header read needed.
        let again = ensure_shape_in_cache(&mut cache, &model_path);
        assert_eq!(again.unwrap().architecture, "qwen35");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// mtime is the only invalidation signal, so a changed file drops both halves.
    /// Asserted through `entry_is_fresh` directly — the public getters read the real
    /// cache file, which is the owner's live data.
    #[test]
    fn changed_mtime_drops_meta_and_shape_together() {
        let dir = scratch_dir("mtime");
        let model = crate::gguf_shape::tests::write_minimal_gguf(
            &dir,
            "plain.gguf",
            "llama",
            1,
            &["token_embd.weight"],
        );
        let model_path = model.to_string_lossy().to_string();

        let shape = GgufShape {
            architecture: "llama".into(),
            ple_layers: 0,
            block_count: 1,
            nextn_layers: 0,
            has_markov_w1: false,
            has_trunk: true,
            has_vocab: true,
            shard_count: 1,
            tensor_count: 1,
            alignment: 32,
            arch_mismatch: false,
            header_end: 0,
        };

        // Fresh mtime → the entry survives, both halves present.
        let fresh = CachedEntry {
            gguf_shape: Some(shape.clone()),
            ..fresh_entry_for(&model_path)
        };
        let hit = entry_is_fresh(&fresh, &model_path, true).expect("fresh entry");
        assert!(hit.gguf_meta.is_some());
        assert_eq!(hit.gguf_shape.as_ref().unwrap().architecture, "llama");

        // Stale mtime → neither half survives. The shape must not outlive the metadata.
        let stale = CachedEntry {
            file_mtime_ms: 1,
            ..fresh.clone()
        };
        assert!(entry_is_fresh(&stale, &model_path, true).is_none());
        assert!(entry_is_fresh(&stale, &model_path, false).is_none());

        // A meta-only entry fails the shape-required gate but stays a valid metadata hit.
        let meta_only = CachedEntry {
            gguf_shape: None,
            ..fresh.clone()
        };
        assert!(entry_is_fresh(&meta_only, &model_path, true).is_none());
        assert!(entry_is_fresh(&meta_only, &model_path, false).is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
