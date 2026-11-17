//! Shard-set completeness and external-shard pairing.
//!
//! A "set" is what the engine loads as one model: one file, or several shards that
//! declare `split.count`. The old check counted `-0000i-of-0000N` files in one folder
//! and dropped the whole set on any mismatch — which hid two legitimate layouts:
//!
//! * a set whose tail is a separately published PLE/Engram table (the Coder ships 5
//!   shards plus `DeepSeek-V4.1-Flash-Engram-IQ4_NL.gguf` as its shard 6), and
//! * shards that drifted out of the folder (moved, renamed, on another drive).
//!
//! Both are the same thing to llama.cpp: `--shard`/`--ple` takes extra GGUF paths, and
//! the loader places them by `split.no`. So completeness is bookkeeping, not filenames:
//!
//! * **complete** — the found `split.no` values cover `0..split.count`,
//! * **external** — the gap is filled by a PLE table found elsewhere (path attached),
//! * **incomplete** — a gap remains.
//!
//! The declared `split.tensors.count` is checked too: a set that has every index but
//! too few tensors is not complete, whatever its filenames say.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::file_role::FileRole;

/// One file's contribution to a set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShardFact {
    pub path: String,
    pub split_no: Option<u32>,
    pub split_count: Option<u32>,
    pub tensors_declared: Option<u64>,
    pub role: FileRole,
}

impl ShardFact {
    /// What the caller knows about one file, without reading anything else.
    pub fn new(
        path: impl Into<String>,
        split_no: Option<u32>,
        split_count: Option<u32>,
        tensors_declared: Option<u64>,
        role: FileRole,
    ) -> Self {
        Self {
            path: path.into(),
            split_no,
            split_count,
            tensors_declared,
            role,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Completeness {
    /// Single file, or every declared shard is present in the folder.
    Complete,
    /// Every shard index is covered — some of them by a file outside the folder.
    External,
    /// At least one index has no file at all.
    Incomplete,
}

impl Completeness {
    pub fn as_str(self) -> &'static str {
        match self {
            Completeness::Complete => "complete",
            Completeness::External => "external",
            Completeness::Incomplete => "incomplete",
        }
    }
}

/// Resolved state of one set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetStatus {
    pub completeness: Completeness,
    /// `split.count`, or 1 when the file declares none.
    pub declared: u32,
    /// `split.no` values found inside the folder, ascending.
    pub present: Vec<u32>,
    /// Indices with no file at all.
    pub missing: Vec<u32>,
    /// Files outside the folder that fill an index, aligned with the indices they
    /// fill (`external_indexes[i]` ← `external[i]`).
    pub external: Vec<String>,
    pub external_indexes: Vec<u32>,
}

impl SetStatus {
    /// A single file that is simply complete.
    pub fn single() -> Self {
        Self {
            completeness: Completeness::Complete,
            declared: 1,
            present: Vec::new(),
            missing: Vec::new(),
            external: Vec::new(),
            external_indexes: Vec::new(),
        }
    }

    pub fn is_launchable(&self) -> bool {
        self.completeness != Completeness::Incomplete
    }

    /// `--ple` / `--shard` value: the external files in index order, comma-joined.
    pub fn shard_arg(&self) -> Option<String> {
        if self.external.is_empty() {
            None
        } else {
            Some(self.external.join(","))
        }
    }
}

/// Resolve one set.
///
/// `files` are the files found beside the model (the model file itself included).
/// `pool` is every candidate attachment found elsewhere — its entries are matched by
/// index, declared count and declared tensor count, then by role (`PleTable` only: a
/// missing transformer shard is never silently replaced by a lookup table).
pub fn set_status(files: &[ShardFact], pool: &[ShardFact]) -> SetStatus {
    if files.is_empty() {
        return SetStatus::single();
    }

    // No split bookkeeping anywhere: a lone model, or a model beside attachments
    // (drafts, projectors) that share the folder. Not a set.
    if !files
        .iter()
        .any(|f| f.split_count.is_some() || f.split_no.is_some())
    {
        return SetStatus::single();
    }

    let declared = files
        .iter()
        .filter_map(|f| f.split_count)
        .max()
        .unwrap_or(1)
        .max(1);

    let present: BTreeSet<u32> = files.iter().filter_map(|f| f.split_no).collect();
    let present: Vec<u32> = present.into_iter().collect();

    // Every declared index that no local file occupies.
    let mut missing: Vec<u32> = (0..declared)
        .filter(|i| !present.contains(i))
        .collect();

    let declared_tensors: Option<u64> = files.iter().filter_map(|f| f.tensors_declared).max();
    let mut external = Vec::new();
    let mut external_indexes = Vec::new();

    for index in missing.clone() {
        let candidate = pool.iter().find(|c| {
            c.split_no == Some(index)
                && c.role == FileRole::PleTable
                && c.split_count.map(|n| n == declared).unwrap_or(true)
                && match (declared_tensors, c.tensors_declared) {
                    // A PLE table cut from a set declares the set's tensor count; when
                    // both sides say so they must agree, or it belongs to another model.
                    (Some(a), Some(b)) => a == b,
                    _ => true,
                }
                && !files.iter().any(|f| f.path.eq_ignore_ascii_case(&c.path))
        });
        if let Some(c) = candidate {
            external.push(c.path.clone());
            external_indexes.push(index);
        }
    }

    if external_indexes.len() == missing.len() {
        missing.clear();
    } else {
        // Keep only the gaps that stayed open.
        missing.retain(|i| !external_indexes.contains(i));
    }

    let completeness = if missing.is_empty() {
        if external.is_empty() {
            Completeness::Complete
        } else {
            Completeness::External
        }
    } else {
        Completeness::Incomplete
    };

    SetStatus {
        completeness,
        declared,
        present,
        missing,
        external,
        external_indexes,
    }
}

// ── Catalog resolution (filesystem side) ────────────────────────────────

/// What the catalog needs after `merge_catalogs`: one status per model path, the
/// attachments discovered in extras roots, and the pool used for pairing.
#[derive(Debug, Default)]
pub struct CatalogResolution {
    /// Keyed by lowercased resolved model path.
    pub statuses: std::collections::HashMap<String, SetStatus>,
    pub extras: Vec<crate::types::ExtraFileEntry>,
    /// Every lookup table seen anywhere — the pairing pool.
    pub pool: Vec<ShardFact>,
}

fn shape_for(
    cache: &std::collections::HashMap<String, crate::model_cache::CachedEntry>,
    sc: &mut ShapeCache,
    path: &str,
) -> Option<crate::gguf_shape::GgufShape> {
    if let Some(shape) = sc.get(path) {
        return Some(shape);
    }
    if let Some(shape) = crate::model_cache::get_cached_with_cache_and_shape(cache, path)
        .and_then(|(_, shape)| shape)
    {
        sc.put(path, &shape);
        return Some(shape);
    }
    let shape = crate::gguf_shape::read_shape_for_path(path).ok()?;
    sc.put(path, &shape);
    Some(shape)
}

fn fact_for(
    cache: &std::collections::HashMap<String, crate::model_cache::CachedEntry>,
    sc: &mut ShapeCache,
    path: &str,
    draft_hint: &str,
) -> (ShardFact, Option<crate::gguf_shape::GgufShape>, crate::file_role::RoleVerdict) {
    let shape = shape_for(cache, sc, path);
    let verdict = crate::file_role::classify(shape.as_ref(), draft_hint, path);
    // Header bookkeeping first; the filename is the fallback for converters that write
    // no `split.*` KVs. Never the other way round.
    let fname = std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let split_no = shape
        .as_ref()
        .and_then(|s| s.split_no)
        .or_else(|| crate::model_catalog::parse_shard_index(fname));
    let split_count = shape
        .as_ref()
        .and_then(|s| s.split_count)
        .or_else(|| crate::model_catalog::parse_shard_expected_total(fname));
    let fact = ShardFact::new(
        path.to_string(),
        split_no,
        split_count,
        shape.as_ref().and_then(|s| s.tensors_declared),
        verdict.role,
    );
    (fact, shape, verdict)
}

/// Header facts for files the metadata cache does not know (every shard after the
/// first is such a file). `path + size + mtime` makes the second scan a stat call:
/// reading 6 MB of tokenizer arrays off a spinning drive on every catalog refresh is
/// exactly the kind of cost that turns a 1 s scan into a 5 s one.
#[derive(Debug, Default, Serialize, Deserialize)]
pub(crate) struct ShapeCache {
    #[serde(default)]
    entries: std::collections::HashMap<String, CachedShape>,
    #[serde(skip)]
    dirty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedShape {
    size: u64,
    mtime_ms: u64,
    shape: crate::gguf_shape::GgufShape,
}

fn stat_key(path: &str) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some((meta.len(), mtime))
}

impl ShapeCache {
    pub(crate) fn load() -> Self {
        let path = shape_cache_path();
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn get(&self, path: &str) -> Option<crate::gguf_shape::GgufShape> {
        let (size, mtime_ms) = stat_key(path)?;
        let hit = self.entries.get(&path.to_ascii_lowercase())?;
        (hit.size == size && hit.mtime_ms == mtime_ms).then(|| hit.shape.clone())
    }

    fn put(&mut self, path: &str, shape: &crate::gguf_shape::GgufShape) {
        let Some((size, mtime_ms)) = stat_key(path) else {
            return;
        };
        self.entries.insert(
            path.to_ascii_lowercase(),
            CachedShape {
                size,
                mtime_ms,
                shape: shape.clone(),
            },
        );
        self.dirty = true;
    }

    fn save(&self) {
        if !self.dirty {
            return;
        }
        let path = shape_cache_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(e) = crate::fs_util::write_json_atomic(&path, self) {
            log::debug!("[shard_sets] shape cache not written: {e}");
        }
    }
}

fn shape_cache_path() -> std::path::PathBuf {
    crate::config::config_dir().join("cache").join("shard_shapes.json")
}

fn is_gguf_magic(path: &std::path::Path) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut magic = [0u8; 4];
    f.read_exact(&mut magic).is_ok() && &magic == b"GGUF"
}

fn walk_gguf_files(root: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_gguf_files(&path, out);
        } else if path.is_file() && is_gguf_magic(&path) {
            out.push(path);
        }
    }
}

/// Resolve every model's shard set and collect the attachment pool.
///
/// One cache load, one sibling walk per model (the walk already exists for size
/// accounting), and header reads only for files the metadata cache does not know.
pub fn resolve_catalog(
    entries: &[crate::types::ModelEntry],
    extras_roots: &[crate::types::ModelPathEntry],
) -> CatalogResolution {
    let cache = crate::model_cache::load_cache();
    let mut shapes = ShapeCache::load();
    let mut resolution = CatalogResolution::default();
    let mut pool_seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut extras_seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Facts are collected once and reused for the final pass — a second sibling walk
    // per model would double the header I/O, and the scan budget is ~1 s.
    let mut per_entry: Vec<(String, Vec<ShardFact>)> = Vec::with_capacity(entries.len());

    for entry in entries {
        let siblings = crate::model_catalog::shard_sibling_paths(&entry.path);
        let mut facts: Vec<ShardFact> = Vec::with_capacity(siblings.len());
        for sibling in &siblings {
            let path = sibling.to_string_lossy().to_string();
            let hint = if path.eq_ignore_ascii_case(&entry.path) {
                entry.draft_role_hint.as_str()
            } else {
                ""
            };
            let (fact, shape, verdict) = fact_for(&cache, &mut shapes, &path, hint);
            if fact.role == FileRole::PleTable && pool_seen.insert(path.to_ascii_lowercase()) {
                resolution.pool.push(fact.clone());
            }
            // A lookup table inside a set's own folder is still an attachment worth
            // listing: it is the table every sibling quant of this family can share.
            if fact.role == FileRole::PleTable && extras_seen.insert(path.to_ascii_lowercase()) {
                resolution.extras.push(extra_entry_from_fact(
                    &path,
                    &fact,
                    shape.as_ref(),
                    verdict,
                    "beside model",
                ));
            }
            facts.push(fact);
        }
        if facts.is_empty() {
            facts.push(ShardFact::new(
                entry.path.clone(),
                None,
                None,
                None,
                FileRole::Model,
            ));
        }
        // The vision projector is deliberately excluded from the model walk
        // (`collect_gguf_files` skips `mmproj`), so it never becomes a row — but it is
        // exactly the kind of attachment the EXTRAS view exists to show.
        if let Some(mmproj) = entry.mmproj.as_deref() {
            if let Some(parent) = std::path::Path::new(&entry.path).parent() {
                let path = parent.join(mmproj).to_string_lossy().to_string();
                if extras_seen.insert(path.to_ascii_lowercase()) && std::path::Path::new(&path).is_file() {
                    let (fact, shape, verdict) = fact_for(&cache, &mut shapes, &path, "");
                    resolution.extras.push(extra_entry_from_fact(
                        &path,
                        &fact,
                        shape.as_ref(),
                        verdict,
                        "beside model",
                    ));
                }
            }
        }
        per_entry.push((normalize_key(&entry.path), facts));
    }

    // Extras roots: everything GGUF-magic, classified, never a model row.
    for root in extras_roots {
        let mut files = Vec::new();
        walk_gguf_files(std::path::Path::new(&root.path), &mut files);
        files.sort();
        for file in files {
            let path = file.to_string_lossy().to_string();
            if !extras_seen.insert(path.to_ascii_lowercase()) {
                continue;
            }
            let (fact, shape, verdict) = fact_for(&cache, &mut shapes, &path, "");
            if fact.role == FileRole::PleTable && pool_seen.insert(path.to_ascii_lowercase()) {
                resolution.pool.push(fact.clone());
            }
            resolution.extras.push(extra_entry_from_fact(
                &path,
                &fact,
                shape.as_ref(),
                verdict,
                &root.label,
            ));
        }
    }

    // Final pass against the complete pool: a table can live in a folder visited
    // after the model that needs it.
    for (key, facts) in per_entry {
        let status = set_status(&facts, &resolution.pool);
        resolution.statuses.insert(key, status);
    }
    shapes.save();

    resolution
}

/// Key form for status/pair lookups: resolved, lowercased.
pub fn normalize_key(path: &str) -> String {
    crate::config::resolve_path(path)
        .to_string_lossy()
        .to_ascii_lowercase()
}

/// True when a catalog row's `fileRole` is an attachment (not a model row).
pub fn is_attachment_role(role: &str) -> bool {
    FileRole::from_wire(role)
        .map(|r| r.is_attachment())
        .unwrap_or(false)
}

/// Build an extras row from a classified file.
fn extra_entry_from_fact(
    path: &str,
    fact: &ShardFact,
    shape: Option<&crate::gguf_shape::GgufShape>,
    verdict: crate::file_role::RoleVerdict,
    root_label: &str,
) -> crate::types::ExtraFileEntry {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    crate::types::ExtraFileEntry {
        path: path.to_string(),
        file_name: std::path::Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        role: verdict.role.as_str().to_string(),
        role_evidence: verdict.evidence.as_str().to_string(),
        size_bytes: size,
        size_str: crate::model_catalog::calc_size_str_from_bytes(size),
        lookup_dims: shape.and_then(|s| s.lookup_dims.clone()),
        split_no: fact.split_no,
        split_count: fact.split_count,
        tensors_declared: fact.tensors_declared,
        root_label: root_label.to_string(),
    }
}

/// Present an attachment found as a catalog row in the extras list instead.
pub fn extra_entry_from_model(entry: &crate::types::ModelEntry) -> crate::types::ExtraFileEntry {
    let size = std::fs::metadata(&entry.path).map(|m| m.len()).unwrap_or(0);
    let shape = entry.gguf_shape.as_ref();
    crate::types::ExtraFileEntry {
        path: entry.path.clone(),
        file_name: std::path::Path::new(&entry.path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        role: entry.file_role.clone(),
        role_evidence: entry.role_evidence.clone(),
        size_bytes: size,
        size_str: crate::model_catalog::calc_size_str_from_bytes(size),
        lookup_dims: shape.and_then(|s| s.lookup_dims.clone()),
        split_no: shape.and_then(|s| s.split_no),
        split_count: shape.and_then(|s| s.split_count),
        tensors_declared: shape.and_then(|s| s.tensors_declared),
        root_label: entry.source_path_label.clone(),
    }
}

fn pairs_path() -> std::path::PathBuf {
    pairs_path_in(&crate::config::config_dir().join("cache"))
}

fn pairs_path_in(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("shard_pairs.json")
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PairCache {
    /// lowercased resolved model path → external shard paths, index order.
    #[serde(default)]
    pairs: std::collections::HashMap<String, Vec<String>>,
}

/// Persist the resolved pairs so launch does not re-walk the library.
pub fn persist_pairs(entries: &[crate::types::ModelEntry], resolution: &CatalogResolution) {
    persist_pairs_at(&pairs_path(), entries, resolution);
}

fn persist_pairs_at(
    path: &std::path::Path,
    entries: &[crate::types::ModelEntry],
    resolution: &CatalogResolution,
) {
    let mut cache = PairCache::default();
    for entry in entries {
        if let Some(status) = resolution.statuses.get(&normalize_key(&entry.path)) {
            if !status.external.is_empty() {
                cache
                    .pairs
                    .insert(normalize_key(&entry.path), status.external.clone());
            }
        }
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = crate::fs_util::write_json_atomic(path, &cache) {
        log::debug!("[shard_sets] pair cache not written: {e}");
    }
}

/// External shards to pass to `--ple`/`--shard` for one model, if any.
/// Only paths that still exist are returned — a stale cache entry must never reach
/// the engine.
pub fn launch_externals(model_path: &str) -> Vec<String> {
    launch_externals_at(&pairs_path(), model_path)
}

fn launch_externals_at(path: &std::path::Path, model_path: &str) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(cache) = serde_json::from_str::<PairCache>(&text) else {
        return Vec::new();
    };
    cache
        .pairs
        .get(&normalize_key(model_path))
        .map(|paths| {
            paths
                .iter()
                .filter(|p| std::path::Path::new(p).is_file())
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {

    use super::*;

    fn model(idx: u32, total: u32, tensors: u64) -> ShardFact {
        ShardFact::new(
            format!("C:/m/shard-{idx:05}-of-{total:05}.gguf"),
            Some(idx),
            Some(total),
            Some(tensors),
            FileRole::Model,
        )
    }

    fn ple(path: &str, idx: u32, total: u32, tensors: u64) -> ShardFact {
        ShardFact::new(path, Some(idx), Some(total), Some(tensors), FileRole::PleTable)
    }

    fn model_entry(path: &str) -> crate::types::ModelEntry {
        crate::types::ModelEntry {
            path: path.to_string(),
            author: "test".into(),
            name: "test".into(),
            quant: "IQ2_XXS".into(),
            size_str: String::new(),
            vision: false,
            mmproj: None,
            mmproj_size_mib: None,
            backend_type: String::new(),
            source_path_label: "test".into(),
            metadata: None,
            gguf_shape: None,
            hf_meta: None,
            hf_model_id: None,
            draft_role_hint: String::new(),
            vision_capable: false,
            file_role: "model".into(),
            role_evidence: String::new(),
            completeness: "complete".into(),
            declared_shards: 1,
            missing_shards: Vec::new(),
            external_shards: Vec::new(),
        }
    }

    /// The pair cache is what launch reads, so it must round-trip and must never hand
    /// the engine a path that has since disappeared.
    #[test]
    fn pair_cache_round_trips_and_drops_missing_files() {
        let dir = std::env::temp_dir().join(format!("boc-shard-pairs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        let live = dir.join("table.gguf");
        std::fs::write(&live, b"GGUF").expect("live file");
        let gone = dir.join("gone.gguf");

        let model_path = dir.join("model-00001-of-00006.gguf");
        std::fs::write(&model_path, b"GGUF").expect("model file");
        let entry = model_entry(&model_path.to_string_lossy());

        let mut resolution = CatalogResolution::default();
        resolution.statuses.insert(
            normalize_key(&entry.path),
            SetStatus {
                completeness: Completeness::External,
                declared: 6,
                present: (0..5).collect(),
                missing: Vec::new(),
                external: vec![
                    live.to_string_lossy().to_string(),
                    gone.to_string_lossy().to_string(),
                ],
                external_indexes: vec![5],
            },
        );

        let cache = dir.join("shard_pairs.json");
        persist_pairs_at(&cache, std::slice::from_ref(&entry), &resolution);
        let got = launch_externals_at(&cache, &entry.path);
        assert_eq!(got, vec![live.to_string_lossy().to_string()]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn single_file_is_complete() {
        let files = vec![ShardFact::new("C:/m/model.gguf", None, None, None, FileRole::Model)];
        let status = set_status(&files, &[]);
        assert_eq!(status.completeness, Completeness::Complete);
        assert!(status.is_launchable());
        assert_eq!(status.shard_arg(), None);
    }

    #[test]
    fn fully_present_set_is_complete_and_needs_no_arg() {
        let files: Vec<_> = (0..3).map(|i| model(i, 3, 900)).collect();
        let status = set_status(&files, &[]);
        assert_eq!(status.completeness, Completeness::Complete);
        assert_eq!(status.declared, 3);
        assert_eq!(status.present, vec![0, 1, 2]);
        assert_eq!(status.shard_arg(), None);
    }

    /// The Coder shape: 5 of 6 shards on disk, the table published separately.
    #[test]
    fn missing_tail_filled_by_published_ple_table_is_external() {
        let files: Vec<_> = (0..5).map(|i| model(i, 6, 1043)).collect();
        let pool = vec![ple("D:/engram/DeepSeek-V4.1-Flash-Engram-IQ4_NL.gguf", 5, 6, 1043)];
        let status = set_status(&files, &pool);
        assert_eq!(status.completeness, Completeness::External);
        assert!(status.missing.is_empty());
        assert_eq!(status.external_indexes, vec![5]);
        assert_eq!(
            status.shard_arg().as_deref(),
            Some("D:/engram/DeepSeek-V4.1-Flash-Engram-IQ4_NL.gguf")
        );
    }

    /// Same gap, but the only table in the pool was cut from another set
    /// (`split.tensors.count` disagrees) — pairing it would load wrong rows.
    #[test]
    fn table_from_another_set_is_not_paired() {
        let files: Vec<_> = (0..5).map(|i| model(i, 6, 1043)).collect();
        let pool = vec![ple("D:/other/qwen-engram.gguf", 5, 6, 1224)];
        let status = set_status(&files, &pool);
        assert_eq!(status.completeness, Completeness::Incomplete);
        assert_eq!(status.missing, vec![5]);
        assert!(!status.is_launchable());
        assert_eq!(status.shard_arg(), None);
    }

    /// Only a lookup table may fill a gap — a stray model file must never be spliced
    /// into another model's shard set.
    #[test]
    fn non_lookup_candidate_never_fills_a_gap() {
        let files: Vec<_> = (0..5).map(|i| model(i, 6, 1043)).collect();
        let stray = ShardFact::new(
            "D:/elsewhere/other-model-00006-of-00006.gguf",
            Some(5),
            Some(6),
            Some(1043),
            FileRole::Model,
        );
        let status = set_status(&files, &[stray]);
        assert_eq!(status.completeness, Completeness::Incomplete);
        assert_eq!(status.missing, vec![5]);
        assert!(status.external.is_empty());
    }

    /// Shards scattered but all present by index: complete, no arg needed.
    #[test]
    fn renamed_shards_still_complete() {
        let files = vec![
            ShardFact::new("C:/m/a.gguf", Some(0), Some(2), Some(10), FileRole::Model),
            ShardFact::new("C:/m/b.gguf", Some(1), Some(2), Some(10), FileRole::Model),
        ];
        assert_eq!(set_status(&files, &[]).completeness, Completeness::Complete);
    }

    /// No split metadata at all on a multi-file folder: not a set (drafts, projectors).
    #[test]
    fn parallel_non_shard_files_are_a_single_model() {
        let files = vec![
            ShardFact::new("C:/m/model.gguf", None, None, None, FileRole::Model),
            ShardFact::new("C:/m/mmproj.gguf", None, None, None, FileRole::Mmproj),
        ];
        assert_eq!(set_status(&files, &[]).completeness, Completeness::Complete);
    }
}

