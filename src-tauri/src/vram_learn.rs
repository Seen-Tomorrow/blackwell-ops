//! Post-launch VRAM learning — parse engine memory breakdown from stderr, cache per config fingerprint.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

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
    /// Latest table — used for forecast (last FIT probe or exit table).
    pub vram_mib: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_breakdown_mib: Option<Vec<f64>>,
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
    crate::config::resolve_model_path(model_path)
}

fn param_suffix(provider_id: &str, ctx: &str, kv_quant: &str, device: &str, split: &str) -> String {
    format!(
        "|{}|ctx={}|kv={}|dev={}|split={}",
        provider_id,
        normalize_ctx_key(ctx),
        kv_quant.trim().to_lowercase(),
        device.trim(),
        split.trim().to_lowercase(),
    )
}

/// Fingerprint for learned VRAM — model + provider + launch-relevant params.
pub fn learned_vram_key(
    model_path: &str,
    provider_id: &str,
    ctx: &str,
    kv_quant: &str,
    device: &str,
    split: &str,
) -> String {
    let normalized_path = normalize_model_path_for_key(model_path);
    format!(
        "{}{}",
        normalized_path,
        param_suffix(provider_id, ctx, kv_quant, device, split),
    )
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

pub fn learned_vram_key_from_config(model_path: &str, provider_id: &str, config: &EngineConfig) -> String {
    learned_vram_key(
        model_path,
        provider_id,
        &config.get_param_str("ctx").unwrap_or_else(|| "32768".to_string()),
        &config.get_param_str("kv_quant").unwrap_or_else(|| "f16".to_string()),
        &config.get_param_str("device").unwrap_or_else(|| "GPU-0".to_string()),
        &config.get_param_str("split").unwrap_or_else(|| "none".to_string()),
    )
}

fn lookup_learned_vram_fuzzy(
    model_path: &str,
    provider_id: &str,
    ctx: &str,
    kv_quant: &str,
    device: &str,
    split: &str,
) -> Option<LearnedVramEntry> {
    let store = load_store();
    let primary = learned_vram_key(model_path, provider_id, ctx, kv_quant, device, split);
    if let Some(entry) = store.entries.get(&primary) {
        return Some(entry.clone());
    }

    // Legacy keys written before path/ctx normalization.
    let legacy = format!(
        "{}{}",
        model_path,
        param_suffix(provider_id, ctx, kv_quant, device, split),
    );
    if legacy != primary {
        if let Some(entry) = store.entries.get(&legacy) {
            return Some(entry.clone());
        }
    }

    let suffix = param_suffix(provider_id, ctx, kv_quant, device, split);
    let path_key = crate::config::model_path_key(&normalize_model_path_for_key(model_path));
    store.entries.iter().find_map(|(key, entry)| {
        let stored_path = key.strip_suffix(&suffix)?;
        if crate::config::model_path_key(stored_path) == path_key {
            Some(entry.clone())
        } else {
            None
        }
    })
}

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
    )
}

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

#[tauri::command]
pub fn get_learned_vram(
    model_path: String,
    provider_id: String,
    ctx: String,
    kv_quant: String,
    device: String,
    split: String,
) -> Option<LearnedVramEntry> {
    let _guard = STORE_MUTEX.lock().ok()?;
    lookup_learned_vram_fuzzy(&model_path, &provider_id, &ctx, &kv_quant, &device, &split)
}