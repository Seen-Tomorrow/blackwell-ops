//! Model catalog scanning — multi-path merge with deduplication.
//!
//! Extracted from engine.rs for modularity. Handles:
//! - Scanning individual paths for .gguf files
//! - Multi-path merging with cross-path deduplication
//! - Quant extraction, shard stripping, size formatting

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::types::{CatalogDedupConflict, ModelEntry, ModelEntryInternal, ModelPathEntry};

/// Scan a single directory path for .gguf model files.
fn scan_path(base_path: &Path) -> Result<Vec<ModelEntryInternal>, String> {
    if !base_path.exists() {
        return Ok(Vec::new());
    }

    let mut temp_catalog: HashMap<String, ModelEntryInternal> = HashMap::new();

    for author_entry in std::fs::read_dir(base_path).map_err(|e| e.to_string())? {
        let author_entry = author_entry.map_err(|e| e.to_string())?;
        let author_path = author_entry.path();
        if !author_path.is_dir() {
            continue;
        }

        let author = author_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();

        for model_dir_entry in std::fs::read_dir(&author_path).map_err(|e| e.to_string())? {
            let model_dir_entry = model_dir_entry.map_err(|e| e.to_string())?;
            let model_path = model_dir_entry.path();
            if !model_path.is_dir() {
                continue;
            }

            let model_dir_name = model_path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string();

            // Find mmproj file in this folder
            let mut mmproj_file: Option<String> = None;
            let mut mmproj_size: u64 = 0;
            if let Ok(files) = std::fs::read_dir(&model_path) {
                for f_entry in files.flatten() {
                    let fname = f_entry.file_name();
                    let fname_str = fname.to_string_lossy().to_lowercase();
                    if fname_str.contains("mmproj") {
                        mmproj_file = Some(fname.to_string_lossy().to_string());
                        if let Ok(meta) = std::fs::metadata(f_entry.path()) {
                            mmproj_size = meta.len();
                        }
                    }
                }
            }

            for f_entry in std::fs::read_dir(&model_path).map_err(|e| e.to_string())? {
                let f_entry = f_entry.map_err(|e| e.to_string())?;
                let fname = f_entry.file_name();
                let fname_str = fname.to_string_lossy().to_string();

                if !fname_str.to_lowercase().ends_with(".gguf")
                    || fname_str.to_lowercase().contains("mmproj")
                {
                    continue;
                }

                // Strip shard pattern: -00001-of-00002
                let base_name = strip_shard_pattern(&fname_str);
                let file_path = f_entry.path();

                let full_id = format!("{author}/{model_dir_name}/{base_name}");

                if let Some(existing) = temp_catalog.get_mut(&full_id) {
                    // Sharded model — accumulate sizes
                    if let Ok(meta) = std::fs::metadata(&file_path) {
                        existing.model_bytes += meta.len();
                        existing.total_bytes += meta.len();
                        existing.shards += 1;
                    }
                } else {
                    let file_size = std::fs::metadata(&file_path)
                        .map(|m| m.len())
                        .unwrap_or(0);

                    let quant = extract_quant(&base_name);
                    let size_str = calc_size_str_from_bytes(file_size + mmproj_size);

                    // Store full absolute path to the GGUF file for downstream validation
                    let abs_path = file_path.to_string_lossy().to_string();

                    temp_catalog.insert(full_id, ModelEntryInternal {
                        path: abs_path.clone(),
                        author: author.clone(),
                        name: model_dir_name.replace("-GGUF", "").replace("-gguf", ""),
                        quant,
                        size_str,
                        vision: mmproj_file.is_some(),
                        mmproj: mmproj_file.clone(),
                        model_bytes: file_size,
                        total_bytes: file_size + mmproj_size,
                        shards: 1,
                        source_path_label: String::new(), // Will be set by caller
                    });
                }
            }
        }
    }

    Ok(temp_catalog.into_values().collect())
}

/// Merge catalogs from multiple configured paths with cross-path deduplication.
/// Returns (final_entries, conflicts) where conflicts are duplicates found across paths.
pub fn merge_catalogs(
    paths: &[ModelPathEntry],
) -> Result<(Vec<ModelEntry>, Vec<CatalogDedupConflict>), String> {
    let mut all_internal: Vec<ModelEntryInternal> = Vec::new();

    // Scan each path and collect entries with source labels
    for path_entry in paths {
        let entries = scan_path(&PathBuf::from(&path_entry.path))?;
        for mut entry in entries {
            entry.source_path_label = path_entry.label.clone();
            all_internal.push(entry);
        }
    }

    // Deduplicate: group by author|name|quant, detect conflicts across paths
    let mut deduped: HashMap<String, ModelEntryInternal> = HashMap::new();
    let mut conflicts: Vec<CatalogDedupConflict> = Vec::new();

    for internal in all_internal {
        let key = format!("{}|{}|{}", internal.author, internal.name, internal.quant);
        if let Some(existing) = deduped.get_mut(&key) {
            // Same model found in two paths — record as conflict
            if existing.source_path_label != internal.source_path_label {
                conflicts.push(CatalogDedupConflict {
                    dedup_key: key.clone(),
                    entry_a: existing.clone(),
                    entry_b: internal,
                });
            } else if internal.total_bytes > existing.total_bytes {
                // Same path, larger file wins (shard accumulation)
                *existing = internal;
            }
        } else {
            deduped.insert(key, internal);
        }
    }

    // Convert to final ModelEntry with cached metadata + HF overrides
    let final_catalog: Vec<ModelEntry> = deduped.into_values()
        .map(|internal| {
            let size_str = calc_size_str_from_bytes(internal.total_bytes);
            let lookup_path = &internal.path;

            // GGUF binary scan cache — mtime-only invalidation
            log::debug!("[catalog] Cache lookup for '{}', path='{}'", internal.name, lookup_path);
            let mut cached_meta = crate::model_cache::get_cached(lookup_path);
            if cached_meta.is_some() {
                log::info!("[catalog] ✅ Cached metadata loaded for {}", internal.name);
            } else {
                log::debug!("[catalog] ❌ No cached metadata for {} (path: {})", internal.name, lookup_path);
            }

            // Override file_size_bytes with accumulated shard total — scanner only reads first shard's size
            if let Some(ref mut m) = cached_meta {
                if internal.shards > 1 || m.file_size_bytes != internal.total_bytes {
                    log::debug!("[catalog] Correcting file_size_bytes for '{}': {} → {} (shards: {})",
                        internal.name, m.file_size_bytes, internal.total_bytes, internal.shards);
                    m.file_size_bytes = internal.total_bytes;
                }
            }

            // HF API cache (persistent) — overrides author/name/quant from directory parsing
            let hf_meta = crate::model_cache::get_hf_metadata(lookup_path);
            let (author, name, quant) = if let Some(ref hf) = hf_meta {
                (hf.author.clone(), hf.repo_name.clone(), hf.quant_type.clone())
            } else {
                (internal.author, internal.name, internal.quant)
            };

            ModelEntry {
                path: internal.path,
                author,
                name,
                quant,
                size_str,
                vision: internal.vision,
                mmproj: internal.mmproj,
                backend_type: String::new(),
                source_path_label: internal.source_path_label,
                metadata: cached_meta,
                hf_meta,
            }
        })
        .collect();

    Ok((final_catalog, conflicts))
}

/// Strip shard pattern from filename: "model-00001-of-00002.gguf" → "model.gguf".
pub fn strip_shard_pattern(filename: &str) -> String {
    if !filename.ends_with(".gguf") {
        return filename.to_string();
    }

    let without_ext = &filename[..filename.len() - 5];

    if let Some(of_pos) = find_case_insensitive_rfind(without_ext, "-of-") {
        let after_of = &without_ext[of_pos + 4..];
        if !after_of.is_empty() && after_of.chars().all(|c| c.is_ascii_digit()) {
            let before_of = &without_ext[..of_pos];
            if let Some(shard_pos) = before_of.rfind('-') {
                let shard_num = &before_of[shard_pos + 1..];
                if shard_num.chars().all(|c| c.is_ascii_digit()) && shard_num.len() >= 3 {
                    return format!("{}.gguf", &before_of[..shard_pos]);
                }
            }
            return format!("{}.gguf", before_of);
        }
    }

    if let Some(part_pos) = find_case_insensitive_rfind(without_ext, "-part-") {
        let after_part = &without_ext[part_pos + 6..];
        if !after_part.is_empty() && after_part.chars().all(|c| c.is_ascii_digit()) {
            return format!("{}.gguf", &without_ext[..part_pos]);
        }
    }

    let parts: Vec<&str> = without_ext.rsplitn(2, '-').collect();
    if parts.len() >= 2 {
        let suffix = parts[0];
        if suffix.chars().all(|c| c.is_ascii_digit()) && suffix.len() >= 3 {
            return format!("{}.gguf", &without_ext[..without_ext.len() - suffix.len() - 1]);
        }
    }

    filename.to_string()
}

/// Find the last occurrence of `pattern` in `s`, case-insensitive.
fn find_case_insensitive_rfind(s: &str, pattern: &str) -> Option<usize> {
    let s_lower = s.to_lowercase();
    let p_lower = pattern.to_lowercase();
    if pattern.is_empty() || pattern.len() > s_lower.len() {
        return None;
    }
    for i in (0..=s_lower.len() - pattern.len()).rev() {
        if &s_lower[i..i + pattern.len()] == p_lower {
            return Some(i);
        }
    }
    None
}

/// Extract quant type from filename. Returns known quant string or fallback.
const KNOWN_QUANTS: &[&str] = &[
    "Q8_0", "Q8_K", "Q6_K",
    "Q5_0", "Q5_1", "Q5_K_M", "Q5_K_S",
    "Q4_0", "Q4_1", "Q4_K_M", "Q4_K_S",
    "Q3_K_M", "Q3_K_S", "Q2_K",
    "IQ4_NL", "IQ3_S", "IQ3_M", "IQ3_XS", "IQ3_XXS",
    "IQ2_S", "IQ2_XS", "IQ2_MS", "IQ2_L",
    "IQ1_S", "IQ1_NL",
    "FP8_E4M3", "FP8_E5M2",
];

/// Check for early-format quant indicators (BF16, F16, MXFP4).
fn check_early_formats(filename: &str) -> Option<String> {
    let lower = filename.to_lowercase();
    if lower.contains("bf16") {
        return Some("BF16".to_string());
    }
    if lower.contains("f16") && !lower.contains("q8_0") && !lower.contains("q4_") {
        for part in filename.split('.').rev() {
            let p = part.to_lowercase();
            if p == "f16" || p == "bf16" {
                return Some(part.to_string());
            }
        }
    }
    if lower.contains("mxfp4") {
        return Some("MXFP4".to_string());
    }
    None
}

/// Match a known quant pattern in a string. Returns the canonical name or None.
fn match_known_quant_in(s: &str) -> Option<String> {
    let s_lower = s.to_lowercase();
    for pattern in KNOWN_QUANTS {
        if s_lower.contains(&pattern.to_lowercase()) {
            return Some(pattern.to_string());
        }
    }
    None
}

/// Find best known quant match across segments of a filename.
fn find_best_segment_match(filename: &str) -> Option<String> {
    let without_ext = filename.trim_end_matches(".gguf");
    let segments: Vec<&str> = without_ext.split(|c: char| c == '-' || c == '.').collect();

    let mut best_match: Option<&str> = None;
    let mut best_len = 0;

    for seg in &segments {
        if seg.is_empty() || seg.len() < 3 { continue; }
        if match_known_quant_in(seg).is_some() && seg.len() > best_len {
            best_match = Some(*seg);
            best_len = seg.len();
        }
    }

    // Return the canonical quant name for the best matching segment
    best_match.and_then(|m| match_known_quant_in(m))
}

pub fn extract_quant(filename: &str) -> String {
    if !filename.ends_with(".gguf") {
        return fallback_quant(filename);
    }

    // Check early formats first
    if let Some(q) = check_early_formats(filename) {
        return q;
    }

    let without_ext = &filename[..filename.len() - 5];

    // Look for "27B-Q8_0" pattern — quant after size suffix
    let chars: Vec<char> = without_ext.chars().collect();
    for i in (1..chars.len()).rev() {
        if chars[i] == 'B' || chars[i] == 'b' {
            if i > 0 && chars[i - 1].is_ascii_digit() {
                if i + 1 < chars.len() && (chars[i + 1] == '-' || chars[i + 1] == '.') {
                    let suffix = &without_ext[i + 2..];
                    if !suffix.is_empty() {
                        if let Some(q) = match_known_quant_in(suffix) {
                            return q;
                        }
                        return fallback_quant(filename);
                    }
                }
            }
        }
    }

    fallback_quant(filename)
}

fn fallback_quant(filename: &str) -> String {
    // Check early formats
    if let Some(q) = check_early_formats(filename) {
        return q;
    }

    // Try segment-based matching against known quants
    if let Some(q) = find_best_segment_match(filename) {
        return q;
    }

    // Last resort: if filename contains "q" or "iq", use last segment as quant name
    let lower = filename.to_lowercase();
    let without_ext = filename.trim_end_matches(".gguf");
    let segments: Vec<&str> = without_ext.split(|c: char| c == '-' || c == '.').collect();
    if let Some(last_seg) = segments.last() {
        if !last_seg.is_empty() && last_seg.len() >= 3 {
            if lower.contains("q") || lower.contains("iq") {
                return last_seg.to_string();
            }
        }
    }

    "GGUF".to_string()
}

/// Format bytes as human-readable string (e.g. "4.2GB").
pub fn calc_size_str_from_bytes(total_bytes: u64) -> String {
    format!("{:.1}GB", total_bytes as f64 / (1024.0_f64.powi(3)))
}

/// Get the total size of a model, summing all shards if sharded.
/// Uses strip_shard_pattern to detect shard siblings in the same directory.
pub fn get_total_model_size(model_path: &str) -> u64 {
    let path = std::path::Path::new(model_path);
    if let Some(parent) = path.parent() {
        let filename = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        let base_name = strip_shard_pattern(filename);
        // Only sum siblings if the file is actually sharded (base differs from original)
        if base_name != filename && parent.exists() {
            let base_without_ext = &base_name[..base_name.len().saturating_sub(5)];
            let mut total: u64 = 0;
            if let Ok(entries) = std::fs::read_dir(parent) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let lower = name.to_lowercase();
                    if !lower.ends_with(".gguf") || lower.contains("mmproj") {
                        continue;
                    }
                    if name.starts_with(base_without_ext) {
                        total += entry.metadata().ok().map(|m| m.len()).unwrap_or(0);
                    }
                }
            }
            return total;
        }
    }
    std::fs::metadata(model_path).ok().map(|m| m.len()).unwrap_or(0)
}
