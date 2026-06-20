//! Model catalog scanning — multi-path merge with deduplication.
//!
//! Extracted from engine.rs for modularity. Handles:
//! - Scanning individual paths for .gguf files
//! - Multi-path merging with cross-path deduplication
//! - Quant extraction, shard stripping, size formatting

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::output_console::{BlackwellOutputConsoleCategory, BlackwellOutputConsoleLineStyle};
use crate::types::{
    CatalogDedupConflict, DiskCheckResult, DownloadStatus, DownloadTask, GgufFile, ModelEntry,
    ModelEntryInternal, ModelPathEntry, QuantDownloadBatch,
};

/// Paths + shard groups to omit from catalog during active/incomplete downloads.
#[derive(Debug, Clone, Default)]
pub struct CatalogScanExclusions {
    pub dest_paths: HashSet<String>,
    pub shard_groups: HashSet<String>,
}

impl CatalogScanExclusions {
    pub fn is_empty(&self) -> bool {
        self.dest_paths.is_empty() && self.shard_groups.is_empty()
    }
}

pub fn shard_group_key_from_path(path: &str) -> String {
    let resolved = crate::config::resolve_path(path);
    let parent = resolved
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let fname = resolved
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let base = strip_shard_pattern(fname);
    format!("{}|{}", parent.to_lowercase(), base.to_lowercase())
}

pub fn catalog_exclusions_from_downloads(
    tasks: &HashMap<String, DownloadTask>,
    batches: &HashMap<String, QuantDownloadBatch>,
) -> CatalogScanExclusions {
    let mut dest_paths = HashSet::new();
    let mut shard_groups = HashSet::new();

    for task in tasks.values() {
        if matches!(
            task.status,
            DownloadStatus::Queued | DownloadStatus::Downloading | DownloadStatus::Paused
        ) {
            let resolved = crate::config::resolve_path(&task.dest_path)
                .to_string_lossy()
                .to_string();
            dest_paths.insert(resolved.clone());
            shard_groups.insert(shard_group_key_from_path(&resolved));
        }
    }

    for batch in batches.values() {
        for part in &batch.parts {
            let resolved = crate::config::resolve_path(&part.dest_path)
                .to_string_lossy()
                .to_string();
            dest_paths.insert(resolved.clone());
            shard_groups.insert(shard_group_key_from_path(&resolved));
        }
    }

    CatalogScanExclusions {
        dest_paths,
        shard_groups,
    }
}

/// Parse `-00001-of-00004` suffix → expected shard count (4).
pub fn parse_shard_expected_total(filename: &str) -> Option<u32> {
    let without_ext = filename.trim_end_matches(".gguf");
    if let Some(of_pos) = find_case_insensitive_rfind(without_ext, "-of-") {
        let after_of = &without_ext[of_pos + 4..];
        if !after_of.is_empty() && after_of.chars().all(|c| c.is_ascii_digit()) {
            return after_of.parse().ok();
        }
    }
    None
}

fn is_incomplete_shard_entry(entry: &ModelEntryInternal) -> bool {
    let Some(fname) = Path::new(&entry.path)
        .file_name()
        .and_then(|s| s.to_str())
    else {
        return false;
    };
    let Some(expected) = parse_shard_expected_total(fname) else {
        return false;
    };
    (entry.shards as u32) < expected
}

/// Scan a directory for mmproj companion files. Returns the one with largest filesize.
/// Filesize is the proxy for precision (F32 > F16 in bytes).
/// Returns `(original_filename, size_bytes)` or `None` if no match found.
pub fn find_largest_mmproj(directory: &Path) -> Option<(String, u64)> {
    let entries = std::fs::read_dir(directory).ok()?;
    let mut best: Option<(String, u64)> = None;

    for entry in entries.flatten() {
        let fname = entry.file_name();
        let fname_lower = fname.to_string_lossy().to_lowercase();
        if fname_lower.contains("mmproj") {
            if let Ok(meta) = std::fs::metadata(entry.path()) {
                let size = meta.len();
                match &best {
                    None => best = Some((fname.to_string_lossy().to_string(), size)),
                    Some((_, best_size)) if size > *best_size => {
                        best = Some((fname.to_string_lossy().to_string(), size));
                    }
                    _ => {}
                }
            }
        }
    }

    best
}

/// Directories to skip during recursive scan — build artifacts, caches, IDE folders.
const SKIP_DIRS: &[&str] = &["node_modules", ".git", "target", "__pycache__", 
                              ".vscode", ".idea", "dist", "build", "src-tauri", 
                              ".next", ".nuxt", ".cache"];

/// Count `.gguf` model files under a directory (recursive, skips mmproj and partial downloads).
pub fn count_gguf_files(dir: &Path) -> usize {
    let mut files = Vec::new();
    collect_gguf_files(dir, &mut files);
    files.len()
}

/// Recursively collect all .gguf files under a directory, skipping known junk dirs.
fn collect_gguf_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // Permission denied or other error — skip silently
    };
    
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if !SKIP_DIRS.contains(&name) {
                collect_gguf_files(&path, out);
            }
        } else if path.extension().map_or(false, |e| e == "gguf") {
            let fname = path.file_name().unwrap().to_string_lossy();
            if fname.to_lowercase().contains("mmproj") {
                continue;
            }
            // Skip in-progress HF downloads (partial file written alongside final name).
            let partial_path = PathBuf::from(format!("{}.part", path.display()));
            if partial_path.exists() {
                continue;
            }
            out.push(path);
        }
    }
}

/// Parse model name from filename by stripping quant suffix. Returns (name, quant) to avoid double extract_quant call.
fn parse_name_and_quant(filename: &str) -> (String, String) {
    let without_ext = filename.trim_end_matches(".gguf");
    let q = extract_quant(filename);
    if q != "GGUF" {
        let q_lower = q.to_lowercase();
        if let Some(pos) = without_ext.to_lowercase().rfind(&q_lower) {
            return (without_ext[..pos].trim_end_matches('-').trim_end_matches('.').to_string(), q);
        }
    }
    (strip_shard_pattern(without_ext).trim_end_matches('-').to_string(), q)
}

/// Extract author from HF URL like "https://huggingface.co/bartowski/..." → "bartowski"
fn parse_author_from_url(url: &str) -> Option<String> {
    for pattern in ["huggingface.co/", "hf.co/"] {
        if let Some(pos) = url.find(pattern) {
            let after = &url[pos + pattern.len()..];
            if let Some(slash) = after.find('/') {
                let author = &after[..slash];
                // Reject only domain fragments (www, /) — allow dots in author names like "some.user"
                if !author.is_empty() && !author.starts_with("www") && !author.contains('/') {
                    return Some(author.to_string());
                }
            }
        }
    }
    None
}

/// Universal model scanner — recursive walk that handles ANY directory structure.
/// 
/// Identity resolution from path (fallback only — GGUF header data overrides later):
/// - 2+ levels deep: LM Studio pattern → author = dir[0], name = dir[1..]
/// - 1 level deep: folder as context, parse name from filename
/// - Flat: all files directly in base_path → parse everything from filename
pub fn scan_path(
    base_path: &Path,
    log_hub: Option<&crate::log_hub::LogHub>,
) -> Result<Vec<ModelEntryInternal>, String> {
    if !base_path.exists() {
        return Ok(Vec::new());
    }

    let mut gguf_files: Vec<PathBuf> = Vec::new();
    collect_gguf_files(base_path, &mut gguf_files);

    // LOG: scan start
    if let Some(lh) = log_hub {
        lh.emit_console_line(
            BlackwellOutputConsoleCategory::Utils,
            &format!("[SCAN] Walking '{}': found {} .gguf files", 
                base_path.display(), gguf_files.len()),
            BlackwellOutputConsoleLineStyle::Normal);
    }

    // Group files by parent directory for mmproj detection — HashSet O(n) instead of Vec O(n²)
    let mut unique_parents: HashSet<PathBuf> = HashSet::new();
    for file in &gguf_files {
        if let Some(parent) = file.parent() {
            unique_parents.insert(parent.to_path_buf());
        }
    }
    let dir_mmprojs: HashMap<PathBuf, (Option<String>, u64)> = unique_parents
        .into_iter()
        .filter_map(|dir| find_largest_mmproj(&dir).map(|(name, sz)| (dir, (Some(name), sz))))
        .collect();

    let mut temp_catalog: HashMap<String, ModelEntryInternal> = HashMap::new();

    for file_path in gguf_files {
        let fname = file_path.file_name().unwrap().to_string_lossy().to_string();
        let base_name = strip_shard_pattern(&fname);
        let parent = file_path.parent().unwrap();
        let (mmproj_file, mmproj_size) = dir_mmprojs.get(parent).cloned().unwrap_or((None, 0));

        // Identity from directory structure — fallback only (GGUF data overrides in merge_catalogs)
        let rel = file_path.strip_prefix(base_path).unwrap();
        let components: Vec<String> = rel.parent()
            .map(|p| p.components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect())
            .unwrap_or_default();

        let (author, name, quant) = if components.len() >= 2 {
            // LM Studio pattern: author/model_dir/file.gguf — directory provides identity
            let dir_name = components[1..].join("/").replace("-GGUF", "").replace("-gguf", "");
            let (_name_from_file, q) = parse_name_and_quant(&fname);
            (components[0].clone(), dir_name, q)
        } else if components.len() == 1 {
            let (parsed_name, parsed_q) = parse_name_and_quant(&fname);
            // If folder has digits, it's likely a model name dir (e.g., "Llama-3.1-8B/")
            if components[0].chars().any(|c| c.is_ascii_digit()) {
                ("Unknown".to_string(), 
                 components[0].clone().replace("-GGUF", "").replace("-gguf", ""),
                 parsed_q)
            } else {
                (components[0].clone(), parsed_name, parsed_q)
            }
        } else {
            // Flat — all files directly in base_path → parse everything from filename
            let (parsed_name, parsed_q) = parse_name_and_quant(&fname);
            ("Unknown".to_string(), parsed_name, parsed_q)
        };

        let file_size = std::fs::metadata(&file_path).map(|m| m.len()).unwrap_or(0);
        let size_str = calc_size_str_from_bytes(file_size + mmproj_size);
        let abs_path = file_path.to_string_lossy().to_string();

        // Derive HF repo ID from directory structure (LM Studio pattern: author/model-GGUF/file.gguf)
        let hf_model_id = if components.len() >= 2 {
            // The HF repo is typically "author/model-GGUF" for LM Studio — keep -GGUF since HF repos carry it
            let repo_name = components[1..].join("/");
            Some(format!("{}/{}", components[0], repo_name))
        } else {
            None
        };

        // Dedup key: author/name/base_name — handles sharded models across structures
        let full_id = format!("{}/{}/{}", author, name, base_name);

        if let Some(existing) = temp_catalog.get_mut(&full_id) {
            // Sharded model — accumulate sizes
            existing.model_bytes += file_size;
            existing.total_bytes += file_size;
            existing.shards += 1;
        } else {
            temp_catalog.insert(full_id, ModelEntryInternal {
                path: abs_path.clone(),
                author,
                name,
                quant,
                size_str,
                vision: mmproj_file.is_some(),
                mmproj: mmproj_file.clone(),
                mmproj_size_mib: if mmproj_size > 0 { mmproj_size as f64 / (1024.0 * 1024.0) } else { 0.0 },
                model_bytes: file_size,
                total_bytes: file_size + mmproj_size,
                shards: 1,
                source_path_label: String::new(), // Will be set by caller
                hf_model_id,
            });
        }
    }

    // LOG: scan complete with identity breakdown
    if let Some(lh) = log_hub {
        let lm_studio_count = temp_catalog.values()
            .filter(|e| e.author != "Unknown").count();
        lh.emit_console_line(
            BlackwellOutputConsoleCategory::Utils,
            &format!("[SCAN] '{}' → {} unique models ({} with directory author, {} shards total)", 
                base_path.display(),
                temp_catalog.len(),
                lm_studio_count,
                temp_catalog.values().map(|e| e.shards).sum::<i32>()),
            BlackwellOutputConsoleLineStyle::Success);
    }

    Ok(temp_catalog.into_values().collect())
}

pub fn merge_catalogs(
    paths: &[ModelPathEntry],
    log_hub: Option<&crate::log_hub::LogHub>,
    exclusions: Option<&CatalogScanExclusions>,
) -> Result<(Vec<ModelEntry>, Vec<CatalogDedupConflict>), String> {
    let mut all_internal: Vec<ModelEntryInternal> = Vec::new();

    // LOG: merge start
    if let Some(lh) = log_hub {
        lh.emit_console_line(
            BlackwellOutputConsoleCategory::Utils,
            &format!("[MERGE] Combining {} model paths", paths.len()),
            BlackwellOutputConsoleLineStyle::Normal);
        for (i, p) in paths.iter().enumerate() {
            let label = if p.label.is_empty() { "Default" } else { &p.label };
            lh.emit_console_line(
                BlackwellOutputConsoleCategory::Utils,
                &format!("  [{}]: '{}' → '{}'", i + 1, label, p.path),
                BlackwellOutputConsoleLineStyle::Command);
        }
    }

    // Scan each path and collect entries with source labels
    for path_entry in paths {
        let entries = scan_path(&PathBuf::from(&path_entry.path), log_hub)?;
        for mut entry in entries {
            entry.source_path_label =
                crate::config::format_catalog_source_path_label(&path_entry.path);
            all_internal.push(entry);
        }
    }

    let before_filter = all_internal.len();
    all_internal.retain(|entry| !is_incomplete_shard_entry(entry));
    if let Some(lh) = log_hub {
        let skipped_incomplete = before_filter.saturating_sub(all_internal.len());
        if skipped_incomplete > 0 {
            lh.emit_console_line(
                crate::output_console::BlackwellOutputConsoleCategory::Utils,
                &format!("[MERGE] Skipped {skipped_incomplete} incomplete shard set(s) from catalog"),
                crate::output_console::BlackwellOutputConsoleLineStyle::Normal,
            );
        }
    }

    if let Some(ex) = exclusions {
        if !ex.is_empty() {
            let before = all_internal.len();
            all_internal.retain(|entry| {
                let resolved = crate::config::resolve_path(&entry.path)
                    .to_string_lossy()
                    .to_string();
                if ex.dest_paths.contains(&resolved) {
                    return false;
                }
                let group = shard_group_key_from_path(&entry.path);
                !ex.shard_groups.contains(&group)
            });
            if let Some(lh) = log_hub {
                let skipped = before.saturating_sub(all_internal.len());
                if skipped > 0 {
                    lh.emit_console_line(
                        crate::output_console::BlackwellOutputConsoleCategory::Utils,
                        &format!("[MERGE] Skipped {skipped} in-progress download(s) from catalog"),
                        crate::output_console::BlackwellOutputConsoleLineStyle::Normal,
                    );
                }
            }
        }
    }

    // Deduplicate: group by author|name|quant, detect conflicts across paths
    let mut deduped: HashMap<String, ModelEntryInternal> = HashMap::new();
    let mut conflicts: Vec<CatalogDedupConflict> = Vec::new();

    let total_internal = all_internal.len();
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

    // LOG: dedup results
    if let Some(lh) = log_hub {
        lh.emit_console_line(
            BlackwellOutputConsoleCategory::Utils,
            &format!("[DEDUP] {} total → {} unique ({} conflicts across paths)", 
                total_internal, deduped.len(), conflicts.len()),
            if conflicts.is_empty() { 
                BlackwellOutputConsoleLineStyle::Success 
            } else { 
                BlackwellOutputConsoleLineStyle::Warning 
            });
        for c in &conflicts {
            lh.emit_console_line(
                BlackwellOutputConsoleCategory::Utils,
                &format!("  ⚠ Duplicate: '{}' in '{}' and '{}'", 
                    c.dedup_key, c.entry_a.source_path_label, c.entry_b.source_path_label),
                BlackwellOutputConsoleLineStyle::Warning);
        }
    }

    let model_cache = crate::model_cache::load_cache();
    log::info!("[catalog] Loaded model cache: {} entries", model_cache.len());

    let final_catalog: Vec<ModelEntry> = deduped.into_values()
        .map(|internal| {
            let size_str = calc_size_str_from_bytes(internal.total_bytes);
            let lookup_path = &internal.path;

            log::debug!("[catalog] Cache lookup for '{}', path='{}'", internal.name, lookup_path);
            let mut cached_meta = crate::model_cache::get_cached_with_cache(&model_cache, lookup_path);
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

            let hf_meta = crate::model_cache::get_hf_metadata_with_cache(&model_cache, lookup_path);

            // Author/name resolution chain — GGUF header data overrides directory heuristics
            let (author, name, quant) = if let Some(ref hf) = hf_meta {
                // HF download — authoritative source
                (hf.author.clone(), hf.repo_name.clone(), hf.quant_type.clone())
            } else if let Some(ref meta) = cached_meta {
                // GGUF header resolution:

                // Author = who quantized/published ← what users search for ("Unsloth", "bartowski")
                let resolved_author = if !meta.general_quantized_by.is_empty() {
                    meta.general_quantized_by.clone()
                } else if let Some(a) = parse_author_from_url(&meta.general_repo_url) {
                    a
                } else if !meta.general_author.is_empty() {
                    meta.general_author.clone()
                } else {
                    internal.author.clone() // Directory-derived fallback
                };

                // Name: GGUF header names are unreliable (malformed by quantizers).
                // Always use directory/filename derivation — proven consistent.
                let resolved_name = internal.name.clone();

                (resolved_author, resolved_name, internal.quant)
            } else {
                (internal.author, internal.name, internal.quant) // Filename heuristics only
            };

            // Resolve HF model ID: cache > directory structure
            let resolved_hf_model_id = hf_meta.as_ref()
                .map(|h| h.hf_model_id.clone())
                .or_else(|| internal.hf_model_id.clone());

            ModelEntry {
                path: internal.path,
                author,
                name,
                quant,
                size_str,
                vision: internal.vision,
                mmproj: internal.mmproj,
                mmproj_size_mib: if internal.mmproj_size_mib > 0.0 { Some(internal.mmproj_size_mib) } else { None },
                backend_type: String::new(),
                source_path_label: internal.source_path_label,
                metadata: cached_meta,
                hf_meta,
                hf_model_id: resolved_hf_model_id,
            }
        })
        .collect();

    // Persist discovered HF pairings to model_cache.json — saves pairing for future updates
    let mut paired_count: usize = 0;
    for entry in &final_catalog {
        if entry.hf_meta.is_none() && entry.hf_model_id.is_some() {
            let hf_model_id = entry.hf_model_id.as_ref().unwrap();
            let hf_meta = crate::types::HfMetadata {
                hf_model_id: hf_model_id.clone(),
                author: entry.author.clone(),
                repo_name: entry.name.clone(),
                tags: Vec::new(),
                downloads: 0,
                likes_count: 0,
                quant_type: entry.quant.clone(),
                file_size_bytes: entry.metadata.as_ref().map(|m| m.file_size_bytes).unwrap_or(0),
                last_modified: String::new(),
                lfs_oid: String::new(),
            };
            if let Err(e) = crate::model_cache::set_hf_metadata(&entry.path, hf_meta) {
                log::warn!("[catalog] Failed to persist HF pairing for {}: {}", entry.path, e);
            } else {
                paired_count += 1;
            }
        }
    }
    if paired_count > 0 {
        log::info!("[catalog] Persisted {} HF pairings to model_cache.json", paired_count);
    }

    // LOG: merge complete with metadata stats
    if let Some(lh) = log_hub {
        let with_meta = final_catalog.iter().filter(|e| e.metadata.is_some()).count();
        let with_hf_full = final_catalog.iter().filter(|e| e.hf_meta.is_some()).count();
        let with_hf_id = final_catalog.iter().filter(|e| e.hf_model_id.is_some()).count();
        lh.emit_console_line(
            BlackwellOutputConsoleCategory::Utils,
            &format!("[MERGE] ✅ {} models cataloged ({} with GGUF metadata, {} with HF data, {} paired to HF repo)",
                final_catalog.len(), with_meta, with_hf_full, with_hf_id),
            BlackwellOutputConsoleLineStyle::Success);
    }

    Ok((final_catalog, conflicts))
}

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
    if lower.contains("nvfp4") {
        return Some("NVFP4".to_string());
    }
    None
}

fn match_known_quant_in(s: &str) -> Option<String> {
    let s_lower = s.to_lowercase();
    for pattern in KNOWN_QUANTS {
        if s_lower.contains(&pattern.to_lowercase()) {
            return Some(pattern.to_string());
        }
    }
    None
}

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

pub fn calc_size_str_from_bytes(total_bytes: u64) -> String {
    format!("{:.1}GB", total_bytes as f64 / (1024.0_f64.powi(3)))
}

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

/// Check HF GGUF files against local disk. Returns one DiskCheckResult per file.
/// Matching: LFS OID (exact) > file size (same quant + same bytes) > mismatch (same quant, different size).
pub fn check_hf_files_against_disk(
    paths: &[ModelPathEntry],
    gguf_files: &[GgufFile],
    log_hub: Option<&crate::log_hub::LogHub>,
    hf_model_id: Option<&str>,
) -> Vec<DiskCheckResult> {
    // Build internal catalog entries for size lookup (no logging, no exclusion)
    let mut catalog: Vec<ModelEntryInternal> = Vec::new();
    for path_entry in paths {
        if let Ok(entries) = scan_path(&PathBuf::from(&path_entry.path), None) {
            catalog.extend(entries);
        }
    }

    // Load model cache for LFS OID lookup + HF repo ID resolution
    let model_cache = crate::model_cache::load_cache();

    // Resolve HF repo ID for each catalog entry: cache > directory structure
    let resolved: Vec<(&ModelEntryInternal, Option<String>)> = catalog.iter().map(|entry| {
        let cache_key = entry.path.replace("\\", "/");
        let from_cache = model_cache.get(&entry.path)
            .or_else(|| model_cache.get(&cache_key))
            .and_then(|ce| ce.hf_meta.as_ref())
            .map(|hf| hf.hf_model_id.clone());
        (entry, from_cache.or_else(|| entry.hf_model_id.clone()))
    }).collect();

    // Filter to only entries matching the requested HF repo
    let scoped: Vec<(&ModelEntryInternal, Option<String>)> = resolved.into_iter()
        .filter(|(_entry, repo_id)| {
            if let Some(target) = hf_model_id {
                repo_id.as_deref() == Some(target)
            } else {
                // No HF model ID provided — fall back to full catalog (legacy behavior)
                true
            }
        })
        .collect();

    // Build indexes from scoped (repo-filtered) entries only
    let mut size_index: HashMap<(String, u64), &ModelEntryInternal> = HashMap::new();
    let mut quant_index: HashMap<String, &ModelEntryInternal> = HashMap::new();
    for (entry, _repo_id) in &scoped {
        let quant_key = entry.quant.clone();
        // Index by (quant, size) for exact match
        let size_key = (quant_key.clone(), entry.model_bytes);
        if !size_index.contains_key(&size_key) {
            size_index.insert(size_key, *entry);
        }
        // Index by quant alone for mismatch detection
        if !quant_index.contains_key(&quant_key) {
            quant_index.insert(quant_key, *entry);
        }
    }

    // LOG: disk check start
    if let Some(lh) = log_hub {
        let label = hf_model_id.unwrap_or("unknown");
        lh.emit_console_line(
            BlackwellOutputConsoleCategory::Utils,
            &format!("[DISK CHECK] Scanning {} quants for {}", gguf_files.len(), label),
            BlackwellOutputConsoleLineStyle::Normal);
    }

    // Counters for summary
    let mut n_lfs: usize = 0;
    let mut n_size: usize = 0;
    let mut n_mismatch: usize = 0;
    let mut n_none: usize = 0;

    let results: Vec<DiskCheckResult> = gguf_files.iter().map(|gf| {
        // Step 1: Check LFS OID against model cache
        let lfs_match = if !gf.lfs_oid.is_empty() {
            model_cache.values().find_map(|cached| {
                cached.hf_meta.as_ref().and_then(|hf| {
                    if hf.lfs_oid == gf.lfs_oid {
                        Some(true)
                    } else {
                        None
                    }
                })
            }).unwrap_or(false)
        } else {
            false
        };

        if lfs_match {
            if let Some(lh) = log_hub {
                let oid_preview = if gf.lfs_oid.len() > 16 {
                    &gf.lfs_oid[..16]
                } else {
                    gf.lfs_oid.as_str()
                };
                lh.emit_console_line(
                    BlackwellOutputConsoleCategory::Debug,
                    &format!("[DISK DEBUG] {} → LFS match (oid: {})", gf.r#type, oid_preview),
                    BlackwellOutputConsoleLineStyle::Success);
            }
            n_lfs += 1;
            return DiskCheckResult {
                quant_type: gf.r#type.clone(),
                match_type: "lfs".to_string(),
                disk_file_size: None,
                disk_author: None,
            };
        }

        // Step 2: Check file size match (scoped to same HF repo)
        let size_match = size_index.get(&(gf.r#type.clone(), gf.size_bytes));
        if let Some(_entry) = size_match {
            if let Some(lh) = log_hub {
                lh.emit_console_line(
                    BlackwellOutputConsoleCategory::Debug,
                    &format!("[DISK DEBUG] {} → size match ({} bytes)", gf.r#type, gf.size_bytes),
                    BlackwellOutputConsoleLineStyle::Normal);
            }
            n_size += 1;
            return DiskCheckResult {
                quant_type: gf.r#type.clone(),
                match_type: "size".to_string(),
                disk_file_size: None,
                disk_author: None,
            };
        }

        // Step 3: Check for size mismatch (same quant, different size)
        if let Some(entry) = quant_index.get(&gf.r#type) {
            if let Some(lh) = log_hub {
                lh.emit_console_line(
                    BlackwellOutputConsoleCategory::Debug,
                    &format!("[DISK DEBUG] {} → mismatch (disk: {} bytes, HF: {} bytes, disk author: {})",
                        gf.r#type, entry.model_bytes, gf.size_bytes, entry.author),
                    BlackwellOutputConsoleLineStyle::Warning);
            }
            n_mismatch += 1;
            return DiskCheckResult {
                quant_type: gf.r#type.clone(),
                match_type: "mismatch".to_string(),
                disk_file_size: Some(entry.model_bytes),
                disk_author: Some(entry.author.clone()),
            };
        }

        // Step 4: Not present
        if let Some(lh) = log_hub {
            lh.emit_console_line(
                BlackwellOutputConsoleCategory::Debug,
                &format!("[DISK DEBUG] {} → not found", gf.r#type),
                BlackwellOutputConsoleLineStyle::Normal);
        }
        n_none += 1;

        DiskCheckResult {
            quant_type: gf.r#type.clone(),
            match_type: "none".to_string(),
            disk_file_size: None,
            disk_author: None,
        }
    }).collect();

    // LOG: summary banner
    if let Some(lh) = log_hub {
        let label = hf_model_id.unwrap_or("unknown");
        lh.emit_console_line(
            BlackwellOutputConsoleCategory::Utils,
            &crate::output_console::format_console_completion(
                "HF disk check complete",
                &format!("{} verified, {} on-disk, {} mismatch, {} missing out of {} total for {}",
                    n_lfs, n_size, n_mismatch, n_none, results.len(), label),
            ),
            BlackwellOutputConsoleLineStyle::Success);
    }

    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{DownloadStatus, DownloadTask, QuantBatchPart, QuantDownloadBatch};

    #[test]
    fn parse_shard_expected_total_reads_of_suffix() {
        assert_eq!(
            parse_shard_expected_total("Model-00001-of-00004.gguf"),
            Some(4)
        );
        assert_eq!(parse_shard_expected_total("single.gguf"), None);
    }

    #[test]
    fn is_incomplete_shard_entry_detects_partial_set() {
        let entry = ModelEntryInternal {
            path: "D:/models/Minima-M3-00001-of-00004.gguf".to_string(),
            author: "a".to_string(),
            name: "Minima".to_string(),
            quant: "Q4".to_string(),
            size_str: "1GB".to_string(),
            vision: false,
            mmproj: None,
            mmproj_size_mib: 0.0,
            model_bytes: 1_000_000_000,
            total_bytes: 1_000_000_000,
            shards: 1,
            source_path_label: String::new(),
            hf_model_id: None,
        };
        assert!(is_incomplete_shard_entry(&entry));
    }

    #[test]
    fn catalog_exclusions_cover_active_tasks_and_pending_batches() {
        let mut tasks = HashMap::new();
        tasks.insert(
            "t1".to_string(),
            DownloadTask {
                id: "t1".to_string(),
                hf_model_id: "a/m".to_string(),
                file_name: "m-00002-of-00004.gguf".to_string(),
                download_url: "https://x".to_string(),
                total_bytes: 100,
                downloaded_bytes: 10,
                status: DownloadStatus::Downloading,
                dest_path: "models/m-00002-of-00004.gguf".to_string(),
                speed_bps: 0,
                pause_offset: 0,
                error: None,
                eta_seconds: 0,
                hf_author: "a".to_string(),
                quant_type: "Q4".to_string(),
                lfs_oid: String::new(),
                batch_id: Some("batch-1".to_string()),
            },
        );

        let mut batches = HashMap::new();
        batches.insert(
            "batch-1".to_string(),
            QuantDownloadBatch {
                id: "batch-1".to_string(),
                hf_model_id: "a/m".to_string(),
                quant_type: "Q4".to_string(),
                hf_author: "a".to_string(),
                parts: vec![
                    QuantBatchPart {
                        dest_path: "models/m-00001-of-00004.gguf".to_string(),
                        total_bytes: 100,
                        lfs_oid: String::new(),
                        file_name: "m-00001-of-00004.gguf".to_string(),
                    },
                    QuantBatchPart {
                        dest_path: "models/m-00002-of-00004.gguf".to_string(),
                        total_bytes: 100,
                        lfs_oid: String::new(),
                        file_name: "m-00002-of-00004.gguf".to_string(),
                    },
                ],
            },
        );

        let ex = catalog_exclusions_from_downloads(&tasks, &batches);
        assert!(ex.dest_paths.len() >= 2);
        assert_eq!(ex.shard_groups.len(), 1);
        assert!(ex.shard_groups.iter().any(|g| g.contains("m.gguf")));
    }
}
