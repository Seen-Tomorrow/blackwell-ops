//! Post-launch VRAM learning — parse engine memory breakdown from stderr, cache per config fingerprint.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

use crate::fit_scanner::GpuComponentMib;
use crate::launch_memory_parse::LaunchMemorySnapshot;
use crate::types::EngineConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearnedVramFitAttempt {
    /// 1-based sequence within this launch (each --fit probe prints one table).
    pub attempt: usize,
    pub vram_mib: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_breakdown_mib: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_mib: Option<f64>,
    /// `fit` during load / --fit search; `exit` on graceful shutdown table.
    pub phase: String,
    pub measured_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearnedVramEntry {
    /// Authoritative GPU total — launch buffer inventory when present, else FIT/exit table.
    pub vram_mib: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_breakdown_mib: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_mib: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_components_mib: Option<Vec<GpuComponentMib>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_components_mib: Option<GpuComponentMib>,
    /// Post-load buffer parse — see `launch_memory_parse` architecture memo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_snapshot: Option<LaunchMemorySnapshot>,
    pub measured_at: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fit_attempts: Vec<LearnedVramFitAttempt>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct LearnedVramStore {
    #[serde(default)]
    entries: HashMap<String, LearnedVramEntry>,
}

static STORE_MUTEX: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

const STORE_FILE: &str = "learned-vram.json";

fn legacy_store_path() -> PathBuf {
    crate::config::app_root_dir().join("config").join(STORE_FILE)
}

fn store_path() -> PathBuf {
    crate::config::cache_dir().join(STORE_FILE)
}

/// One-time move from config/learned-vram.json → config/cache/learned-vram.json.
fn migrate_legacy_store_if_needed() {
    let path = store_path();
    if path.exists() {
        return;
    }
    let legacy = legacy_store_path();
    if !legacy.exists() {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::rename(&legacy, &path) {
        Ok(()) => log::info!("[vram_learn] Migrated {STORE_FILE} to config/cache/"),
        Err(e) => log::warn!("[vram_learn] Failed to migrate {STORE_FILE}: {e}"),
    }
}

fn load_store() -> LearnedVramStore {
    migrate_legacy_store_if_needed();
    let path = store_path();
    if !path.exists() {
        return LearnedVramStore::default();
    }
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => LearnedVramStore::default(),
    }
}

fn save_store(store: &LearnedVramStore) -> Result<(), String> {
    let path = store_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

fn normalize_ctx_key(ctx: &str) -> String {
    let s = ctx.trim().to_lowercase();
    if let Some(num) = s.strip_suffix('k') {
        return (num.parse::<usize>().unwrap_or(32) * 1024).to_string();
    }
    if let Some(num) = s.strip_suffix('m') {
        return (num.parse::<usize>().unwrap_or(1) * 1024 * 1024).to_string();
    }
    s.parse::<usize>()
        .map(|n| n.to_string())
        .unwrap_or_else(|_| "32768".to_string())
}

fn normalize_model_path_for_key(model_path: &str) -> String {
    crate::config::model_file_cache_key(model_path)
}

fn normalize_offload_mode(offload_mode: &str) -> String {
    let s = offload_mode.trim().to_lowercase();
    if s.is_empty() || s == "regular" {
        "regular".to_string()
    } else {
        s
    }
}

fn normalize_spec_type(spec_type: &str) -> String {
    let s = spec_type.trim().to_lowercase();
    if s.is_empty() || s == "none" {
        "none".to_string()
    } else {
        s
    }
}

fn optional_launch_suffix(spec_type: &str, cache_ram: &str, draft_key: &str) -> String {
    let mut out = String::new();
    let spec = normalize_spec_type(spec_type);
    if spec != "none" {
        out.push_str(&format!("|spec={spec}"));
    }
    let draft = draft_key.trim();
    if !draft.is_empty() {
        // Basename only — path moves should not bust learned; same draft GGUF = same key.
        let base = std::path::Path::new(draft)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(draft);
        out.push_str(&format!("|draft={}", base.to_lowercase()));
    }
    let ram = cache_ram.trim();
    if !ram.is_empty() && ram != "0" {
        out.push_str(&format!("|cache_ram={ram}"));
    }
    out
}

fn param_suffix(
    provider_id: &str,
    ctx: &str,
    kv_quant: &str,
    device: &str,
    split: &str,
    memory_mode: &str,
    offload_mode: &str,
    spec_type: &str,
    cache_ram: &str,
    draft_key: &str,
) -> String {
    format!(
        "|{}|ctx={}|kv={}|dev={}|split={}|mode={}|offload={}{}",
        provider_id,
        normalize_ctx_key(ctx),
        kv_quant.trim().to_lowercase(),
        device.trim(),
        split.trim().to_lowercase(),
        memory_mode.trim().to_lowercase(),
        normalize_offload_mode(offload_mode),
        optional_launch_suffix(spec_type, cache_ram, draft_key),
    )
}

/// Pre-offload suffix — keys written before offload_mode was part of the fingerprint.
fn param_suffix_legacy(
    provider_id: &str,
    ctx: &str,
    kv_quant: &str,
    device: &str,
    split: &str,
    memory_mode: &str,
) -> String {
    format!(
        "|{}|ctx={}|kv={}|dev={}|split={}|mode={}",
        provider_id,
        normalize_ctx_key(ctx),
        kv_quant.trim().to_lowercase(),
        device.trim(),
        split.trim().to_lowercase(),
        memory_mode.trim().to_lowercase(),
    )
}

/// Fingerprint for learned VRAM — model + provider + launch-relevant params.
#[allow(dead_code)] // Public API / tests; runtime uses `learned_vram_key_with_draft`.
pub fn learned_vram_key(
    model_path: &str,
    provider_id: &str,
    ctx: &str,
    kv_quant: &str,
    device: &str,
    split: &str,
    memory_mode: &str,
    offload_mode: &str,
    spec_type: &str,
    cache_ram: &str,
) -> String {
    learned_vram_key_with_draft(
        model_path,
        provider_id,
        ctx,
        kv_quant,
        device,
        split,
        memory_mode,
        offload_mode,
        spec_type,
        cache_ram,
        "",
    )
}

pub fn learned_vram_key_with_draft(
    model_path: &str,
    provider_id: &str,
    ctx: &str,
    kv_quant: &str,
    device: &str,
    split: &str,
    memory_mode: &str,
    offload_mode: &str,
    spec_type: &str,
    cache_ram: &str,
    draft_key: &str,
) -> String {
    let normalized_path = normalize_model_path_for_key(model_path);
    format!(
        "{}{}",
        normalized_path,
        param_suffix(
            provider_id,
            ctx,
            kv_quant,
            device,
            split,
            memory_mode,
            offload_mode,
            spec_type,
            cache_ram,
            draft_key,
        ),
    )
}

fn draft_path_from_config(config: &EngineConfig) -> String {
    config
        .get_param_str("spec_draft_model")
        .or_else(|| config.get_param_str("dflash_draft_model"))
        .unwrap_or_default()
}

/// Launch-time fingerprint — survives slot clear on stop (memory breakdown prints at exit).
#[derive(Debug, Clone)]
pub struct VramLearnSnapshot {
    pub learn_key: String,
    pub model_path: String,
    pub provider_id: String,
}

pub fn snapshot_from_config(
    model_path: &str,
    provider_id: &str,
    config: &EngineConfig,
) -> VramLearnSnapshot {
    VramLearnSnapshot {
        learn_key: learned_vram_key_from_config(model_path, provider_id, config),
        model_path: normalize_model_path_for_key(model_path),
        provider_id: provider_id.to_string(),
    }
}

fn memory_mode_from_config(config: &EngineConfig) -> String {
    config
        .extra_params
        .get("__memory_mode")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "full_auto".to_string())
}

pub fn learned_vram_key_from_config(model_path: &str, provider_id: &str, config: &EngineConfig) -> String {
    learned_vram_key_with_draft(
        model_path,
        provider_id,
        &config.get_param_str("ctx").unwrap_or_else(|| "32768".to_string()),
        &config.get_param_str("kv_quant").unwrap_or_else(|| "f16".to_string()),
        &config.get_param_str("device").unwrap_or_else(|| "GPU-0".to_string()),
        &config.get_param_str("split").unwrap_or_else(|| "none".to_string()),
        &memory_mode_from_config(config),
        &config
            .get_param_str("offload_mode")
            .unwrap_or_else(|| "regular".to_string()),
        &config
            .get_param_str("spec_type")
            .unwrap_or_else(|| "none".to_string()),
        &config
            .get_param_str("cache_ram")
            .unwrap_or_else(|| "0".to_string()),
        &draft_path_from_config(config),
    )
}

fn lookup_learned_vram_fuzzy(
    model_path: &str,
    provider_id: &str,
    ctx: &str,
    kv_quant: &str,
    device: &str,
    split: &str,
    memory_mode: &str,
    offload_mode: &str,
    spec_type: &str,
    cache_ram: &str,
    draft_key: &str,
) -> Option<LearnedVramEntry> {
    let store = load_store();
    let normalized_path = normalize_model_path_for_key(model_path);
    let primary = learned_vram_key_with_draft(
        model_path,
        provider_id,
        ctx,
        kv_quant,
        device,
        split,
        memory_mode,
        offload_mode,
        spec_type,
        cache_ram,
        draft_key,
    );
    if let Some(entry) = store.entries.get(&primary) {
        return Some(entry.clone());
    }
    // Pre-draft-suffix keys (same spec, no |draft=).
    if !draft_key.trim().is_empty() {
        let no_draft = learned_vram_key_with_draft(
            model_path,
            provider_id,
            ctx,
            kv_quant,
            device,
            split,
            memory_mode,
            offload_mode,
            spec_type,
            cache_ram,
            "",
        );
        if no_draft != primary {
            if let Some(entry) = store.entries.get(&no_draft) {
                return Some(entry.clone());
            }
        }
    }
    // Without spec/cache_ram suffix (pre-MTP keys).
    if normalize_spec_type(spec_type) == "none" && (cache_ram.trim().is_empty() || cache_ram == "0") {
        let without_launch = learned_vram_key_with_draft(
            model_path,
            provider_id,
            ctx,
            kv_quant,
            device,
            split,
            memory_mode,
            offload_mode,
            "none",
            "0",
            "",
        );
        if without_launch != primary {
            if let Some(entry) = store.entries.get(&without_launch) {
                return Some(entry.clone());
            }
        }
    }
    // Legacy entries lack |offload= — only reuse for regular offload, never MOE_OPTIMAL.
    if normalize_offload_mode(offload_mode) == "regular" {
        let legacy_key = format!(
            "{}{}",
            normalized_path,
            param_suffix_legacy(provider_id, ctx, kv_quant, device, split, memory_mode),
        );
        if let Some(entry) = store.entries.get(&legacy_key) {
            return Some(entry.clone());
        }
    }
    // Launch may omit __memory_mode — entry stored under full_auto while UI reads assisted (or vice versa).
    for alt_mode in ["assisted", "full_auto"] {
        if alt_mode == memory_mode {
            continue;
        }
        let alt_key = learned_vram_key_with_draft(
            model_path,
            provider_id,
            ctx,
            kv_quant,
            device,
            split,
            alt_mode,
            offload_mode,
            spec_type,
            cache_ram,
            draft_key,
        );
        if let Some(entry) = store.entries.get(&alt_key) {
            return Some(entry.clone());
        }
    }

    // Device often differs UI vs launch (GPU-0 default vs freest GPU-1). Match by
    // model path + ctx/kv/split/spec/draft ignoring device — but NEVER cross-match
    // boost-on (draft-dspark) rows when the UI is Boost-off, or wrong KV quant.
    let path_norm = normalize_model_path_for_key(model_path);
    let ctx_n = normalize_ctx_key(ctx);
    let kv_n = kv_quant.trim().to_lowercase();
    let split_n = split.trim().to_lowercase();
    let spec_n = normalize_spec_type(spec_type);
    let draft_base = {
        let d = draft_key.trim();
        if d.is_empty() {
            String::new()
        } else {
            std::path::Path::new(d)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(d)
                .to_lowercase()
        }
    };

    let mut best: Option<&LearnedVramEntry> = None;
    let mut best_at = String::new();
    for (k, entry) in &store.entries {
        if !k.starts_with(&path_norm) {
            continue;
        }
        // Hard requirements: same ctx + same KV quant (Q4 vs Q8 vs BF16 must not collapse).
        if !k.contains(&format!("|ctx={ctx_n}|")) {
            continue;
        }
        if !k.contains(&format!("|kv={kv_n}|")) {
            continue;
        }
        if !split_n.is_empty() && split_n != "none" && !k.contains(&format!("|split={split_n}|")) {
            // Allow legacy keys without split= when UI split is none-ish.
            if k.contains("|split=") {
                continue;
            }
        }

        let key_has_spec = k.contains("|spec=");
        let key_has_draft = k.contains("|draft=");

        if spec_n == "none" {
            // Boost OFF: never reuse a launch that had draft-dspark / draft-dflash.
            if key_has_spec {
                // Allow only explicit spec=none if present.
                if !k.contains("|spec=none") {
                    continue;
                }
            }
            if key_has_draft {
                continue;
            }
        } else {
            // Boost ON: require exact spec type.
            if !k.contains(&format!("|spec={spec_n}")) {
                continue;
            }
            // External draft path set → only rows that launched with that draft GGUF.
            if !draft_base.is_empty() {
                if !key_has_draft || !k.contains(&format!("|draft={draft_base}")) {
                    continue;
                }
            }
        }

        if entry.measured_at >= best_at {
            best_at = entry.measured_at.clone();
            best = Some(entry);
        }
    }
    if let Some(entry) = best {
        return Some(entry.clone());
    }
    None
}

#[allow(dead_code)]
pub fn lookup_learned_vram(key: &str) -> Option<LearnedVramEntry> {
    let _guard = STORE_MUTEX.lock().ok()?;
    let store = load_store();
    store.entries.get(key).cloned()
}

/// Fuzzy lookup for launch-time VRAM estimate (path/ctx normalization + legacy keys).
pub fn lookup_learned_vram_for_config(
    model_path: &str,
    provider_id: &str,
    config: &EngineConfig,
) -> Option<LearnedVramEntry> {
    let _guard = STORE_MUTEX.lock().ok()?;
    lookup_learned_vram_fuzzy(
        model_path,
        provider_id,
        &config.get_param_str("ctx").unwrap_or_else(|| "32768".to_string()),
        &config.get_param_str("kv_quant").unwrap_or_else(|| "f16".to_string()),
        &config.get_param_str("device").unwrap_or_else(|| "GPU-0".to_string()),
        &config.get_param_str("split").unwrap_or_else(|| "none".to_string()),
        &memory_mode_from_config(config),
        &config
            .get_param_str("offload_mode")
            .unwrap_or_else(|| "regular".to_string()),
        &config
            .get_param_str("spec_type")
            .unwrap_or_else(|| "none".to_string()),
        &config
            .get_param_str("cache_ram")
            .unwrap_or_else(|| "0".to_string()),
        &draft_path_from_config(config),
    )
}

#[allow(dead_code)]
pub fn record_learned_vram(
    key: String,
    vram_mib: f64,
    gpu_breakdown_mib: Option<Vec<f64>>,
) -> Result<(), String> {
    let _guard = STORE_MUTEX
        .lock()
        .map_err(|e| format!("learned-vram store lock poisoned: {e}"))?;
    let mut store = load_store();
    store.entries.insert(
        key,
        LearnedVramEntry {
            vram_mib,
            gpu_breakdown_mib,
            host_mib: None,
            gpu_components_mib: None,
            host_components_mib: None,
            launch_snapshot: None,
            measured_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            fit_attempts: Vec::new(),
        },
    );
    save_store(&store)
}

fn mib_approx_equal(a: f64, b: f64) -> bool {
    (a - b).abs() < 0.5
}

fn host_mib_equal(a: Option<f64>, b: Option<f64>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => mib_approx_equal(x, y),
        _ => false,
    }
}

fn gpu_breakdown_equal(a: Option<&[f64]>, b: &[f64]) -> bool {
    match a {
        Some(vals) => vals.len() == b.len() && vals.iter().zip(b.iter()).all(|(x, y)| mib_approx_equal(*x, *y)),
        None => b.is_empty(),
    }
}

fn attempt_matches_table(
    attempt: &LearnedVramFitAttempt,
    mib: f64,
    gpu_breakdown: &[f64],
    host_mib: Option<f64>,
    phase: &str,
) -> bool {
    attempt.phase == phase
        && mib_approx_equal(attempt.vram_mib, mib)
        && host_mib_equal(attempt.host_mib, host_mib)
        && gpu_breakdown_equal(attempt.gpu_breakdown_mib.as_deref(), gpu_breakdown)
}

fn timestamp_now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// Append newly seen breakdown tables (MoE --fit may emit many per launch).
/// `already_stored` = number of tables previously persisted for this load.
/// Returns (latest_mib, table_count) when new tables were consumed (including deduped).
pub fn append_fit_breakdown_tables(
    key: &str,
    tables: &[crate::fit_scanner::MemoryBreakdownTable],
    already_stored: usize,
    phase: &str,
) -> Result<Option<(f64, usize)>, String> {
    if already_stored >= tables.len() {
        return Ok(None);
    }

    let _guard = STORE_MUTEX
        .lock()
        .map_err(|e| format!("learned-vram store lock poisoned: {e}"))?;
    let mut store = load_store();
    let entry = store.entries.entry(key.to_string()).or_insert_with(|| LearnedVramEntry {
        vram_mib: 0.0,
        gpu_breakdown_mib: None,
        host_mib: None,
        gpu_components_mib: None,
        host_components_mib: None,
        launch_snapshot: None,
        measured_at: String::new(),
        fit_attempts: Vec::new(),
    });

    let mut latest_mib = entry.vram_mib;
    let mut consumed = false;
    let mut dirty = false;

    for table in tables.iter().skip(already_stored) {
        let mib = table.total_gpu_self_mib();
        if mib <= 0.0 {
            continue;
        }
        consumed = true;
        let now = timestamp_now();

        if let Some(last) = entry.fit_attempts.last() {
            if attempt_matches_table(last, mib, &table.gpu_self_mib, table.host_mib, phase) {
                if let Some(last_mut) = entry.fit_attempts.last_mut() {
                    last_mut.measured_at = now.clone();
                }
                entry.measured_at = now;
                dirty = true;
                continue;
            }
        }

        let attempt_no = entry.fit_attempts.len() + 1;
        entry.fit_attempts.push(LearnedVramFitAttempt {
            attempt: attempt_no,
            vram_mib: mib,
            gpu_breakdown_mib: Some(table.gpu_self_mib.clone()),
            host_mib: table.host_mib,
            phase: phase.to_string(),
            measured_at: now.clone(),
        });
        latest_mib = mib;
        entry.vram_mib = mib;
        entry.gpu_breakdown_mib = Some(table.gpu_self_mib.clone());
        entry.host_mib = table.host_mib;
        entry.measured_at = now;
        dirty = true;
    }

    if !consumed {
        return Ok(None);
    }

    if dirty {
        save_store(&store)?;
    }
    Ok(Some((latest_mib, tables.len())))
}

#[cfg(test)]
mod dedup_tests {
    use super::*;
    use crate::fit_scanner::MemoryBreakdownTable;

    #[test]
    fn attempt_matches_table_compares_phase_and_breakdown() {
        let attempt = LearnedVramFitAttempt {
            attempt: 1,
            vram_mib: 2350.0,
            gpu_breakdown_mib: Some(vec![2350.0]),
            host_mib: Some(519.0),
            phase: "fit".to_string(),
            measured_at: "t0".to_string(),
        };
        assert!(attempt_matches_table(
            &attempt,
            2350.0,
            &[2350.0],
            Some(519.0),
            "fit",
        ));
        assert!(!attempt_matches_table(
            &attempt,
            2350.0,
            &[2350.0],
            Some(519.0),
            "exit",
        ));
        assert!(!attempt_matches_table(
            &attempt,
            2400.0,
            &[2400.0],
            Some(519.0),
            "fit",
        ));
    }

    #[test]
    fn curve_split_none_ignores_layer_and_tensor_keys() {
        let none = "C:/m.gguf|ggml-master|ctx=65536|kv=q8_0|dev=GPU-0|split=none|mode=full_auto";
        let layer = "C:/m.gguf|ggml-master|ctx=65536|kv=q8_0|dev=GPU-0|split=layer|mode=full_auto";
        let tensor = "C:/m.gguf|ggml-master|ctx=65536|kv=q8_0|dev=GPU-0|split=tensor|mode=full_auto";
        let legacy = "C:/m.gguf|ggml-master|ctx=65536|kv=q8_0|dev=GPU-0|mode=full_auto";
        assert!(key_matches_split(none, "none"));
        assert!(key_matches_split(legacy, "none"));
        assert!(!key_matches_split(layer, "none"));
        assert!(!key_matches_split(tensor, "none"));
        assert!(key_matches_split(layer, "layer"));
        assert!(!key_matches_split(none, "layer"));
        assert!(key_matches_split(tensor, "tensor"));
    }

    #[test]
    fn append_skips_duplicate_attempt_rows() {
        let tables = vec![MemoryBreakdownTable {
            gpu_self_mib: vec![100.0, 50.0],
            host_mib: Some(10.0),
        }];
        let key = "__dedup_test_key__";

        {
            let _guard = STORE_MUTEX.lock().unwrap();
            let mut store = load_store();
            store.entries.remove(key);
            save_store(&store).unwrap();
        }

        append_fit_breakdown_tables(key, &tables, 0, "fit").unwrap();
        append_fit_breakdown_tables(key, &tables, 0, "fit").unwrap();

        let _guard = STORE_MUTEX.lock().unwrap();
        let store = load_store();
        let entry = store.entries.get(key).expect("entry");
        assert_eq!(entry.fit_attempts.len(), 1, "duplicate table should not append a second row");

        let mut store = store;
        store.entries.remove(key);
        let _ = save_store(&store);
    }
}

/// Persist post-load buffer inventory — overrides FIT-era totals for forecast/topo.
pub fn record_launch_memory_snapshot(
    key: &str,
    snapshot: LaunchMemorySnapshot,
) -> Result<(), String> {
    let _guard = STORE_MUTEX
        .lock()
        .map_err(|e| format!("learned-vram store lock poisoned: {e}"))?;
    let mut store = load_store();
    let entry = store.entries.entry(key.to_string()).or_insert_with(|| LearnedVramEntry {
        vram_mib: 0.0,
        gpu_breakdown_mib: None,
        host_mib: None,
        gpu_components_mib: None,
        host_components_mib: None,
        launch_snapshot: None,
        measured_at: String::new(),
        fit_attempts: Vec::new(),
    });

    entry.vram_mib = snapshot.vram_mib;
    entry.gpu_breakdown_mib = Some(snapshot.gpu_breakdown_mib.clone());
    entry.host_mib = Some(snapshot.host_mib);
    entry.gpu_components_mib = snapshot.gpu_components_mib.clone();
    entry.host_components_mib = snapshot.host_components_mib.clone();
    entry.measured_at = snapshot.measured_at.clone();
    let measured_mib = snapshot.vram_mib;
    let measured_host = snapshot.host_mib;
    entry.launch_snapshot = Some(snapshot);
    save_store(&store)?;
    drop(_guard);
    crate::forecast_log::record_measured(key, measured_mib, Some(measured_host), "launch");
    Ok(())
}

#[tauri::command]
pub fn get_learned_vram(
    model_path: String,
    provider_id: String,
    ctx: String,
    kv_quant: String,
    device: String,
    split: String,
    memory_mode: Option<String>,
    offload_mode: Option<String>,
    spec_type: Option<String>,
    cache_ram: Option<String>,
    draft_model: Option<String>,
) -> Option<LearnedVramEntry> {
    let _guard = STORE_MUTEX.lock().ok()?;
    let mode = memory_mode
        .as_deref()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "full_auto".to_string());
    let offload = offload_mode
        .as_deref()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "regular".to_string());
    let spec = spec_type
        .as_deref()
        .unwrap_or("none");
    let cache = cache_ram
        .as_deref()
        .unwrap_or("0");
    let draft = draft_model.as_deref().unwrap_or("");
    lookup_learned_vram_fuzzy(
        &model_path,
        &provider_id,
        &ctx,
        &kv_quant,
        &device,
        &split,
        &mode,
        &offload,
        spec,
        cache,
        draft,
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearnedVramCurvePoint {
    pub ctx: usize,
    pub vram_mib: f64,
    pub host_mib: Option<f64>,
}

fn ctx_from_learn_key(key: &str) -> Option<usize> {
    let marker = "|ctx=";
    let start = key.find(marker)? + marker.len();
    let rest = &key[start..];
    let end = rest.find('|').unwrap_or(rest.len());
    rest[..end].parse().ok()
}

fn entry_matches_curve_hard_knobs(
    key: &str,
    path_norm: &str,
    provider_id: &str,
    kv_n: &str,
    spec_n: &str,
    draft_base: &str,
) -> bool {
    let path_prefix = format!("{path_norm}|");
    if !key.starts_with(&path_prefix) {
        return false;
    }
    let prov = provider_id.trim();
    if !prov.is_empty() {
        let rest = &key[path_prefix.len()..];
        if !rest.starts_with(&format!("{prov}|")) {
            return false;
        }
    }
    if !key.contains(&format!("|kv={kv_n}|")) {
        return false;
    }
    let key_has_spec = key.contains("|spec=");
    let key_has_draft = key.contains("|draft=");
    if spec_n == "none" {
        if key_has_spec && !key.contains("|spec=none") {
            return false;
        }
        if key_has_draft {
            return false;
        }
    } else {
        if !key.contains(&format!("|spec={spec_n}")) {
            return false;
        }
        // External draft (dflash/dspark): only launches that recorded this draft basename.
        // Main-only rows must not paint the curve while Boost+draft is on (FIT adds draft).
        if !draft_base.is_empty() {
            if !key_has_draft || !key.contains(&format!("|draft={draft_base}")) {
                return false;
            }
        }
    }
    true
}

fn normalize_split_mode(split: &str) -> String {
    let s = split.trim().to_lowercase();
    if s.is_empty() {
        "none".to_string()
    } else {
        s
    }
}

/// Writes keep split in the key; curve reads must not mix none with layer/tensor.
fn key_matches_split(key: &str, split: &str) -> bool {
    let want = normalize_split_mode(split);
    let want_none = want == "none";
    if let Some(rest) = key.split("|split=").nth(1) {
        let got = rest.split('|').next().unwrap_or("").trim().to_lowercase();
        if want_none {
            return got.is_empty() || got == "none";
        }
        return got == want;
    }
    want_none
}

/// Launch measurements for this model + kv/spec/draft + split, every ctx (device ignored).
#[tauri::command]
pub fn get_learned_vram_curve(
    model_path: String,
    provider_id: String,
    kv_quant: String,
    spec_type: Option<String>,
    draft_model: Option<String>,
    split: Option<String>,
) -> Vec<LearnedVramCurvePoint> {
    let Some(_guard) = STORE_MUTEX.lock().ok() else {
        return Vec::new();
    };
    let store = load_store();
    let path_norm = normalize_model_path_for_key(&model_path);
    let kv_n = kv_quant.trim().to_lowercase();
    let spec_n = normalize_spec_type(spec_type.as_deref().unwrap_or("none"));
    let draft_base = {
        let d = draft_model.as_deref().unwrap_or("").trim();
        if d.is_empty() {
            String::new()
        } else {
            std::path::Path::new(d)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(d)
                .to_lowercase()
        }
    };
    let split_n = normalize_split_mode(split.as_deref().unwrap_or("none"));
    let mut best: std::collections::HashMap<usize, (String, LearnedVramCurvePoint)> =
        std::collections::HashMap::new();
    for (k, entry) in &store.entries {
        if !entry_matches_curve_hard_knobs(
            k,
            &path_norm,
            &provider_id,
            &kv_n,
            &spec_n,
            &draft_base,
        ) {
            continue;
        }
        if !key_matches_split(k, &split_n) {
            continue;
        }
        let Some(ctx) = ctx_from_learn_key(k) else {
            continue;
        };
        let vram = if entry.vram_mib > 0.0 {
            entry.vram_mib
        } else {
            continue;
        };
        let point = LearnedVramCurvePoint {
            ctx,
            vram_mib: vram,
            host_mib: entry.host_mib,
        };
        match best.get(&ctx) {
            Some((at, _)) if entry.measured_at < *at => {}
            _ => {
                best.insert(ctx, (entry.measured_at.clone(), point));
            }
        }
    }
    let mut out: Vec<LearnedVramCurvePoint> = best.into_values().map(|(_, p)| p).collect();
    out.sort_by_key(|p| p.ctx);
    out
}