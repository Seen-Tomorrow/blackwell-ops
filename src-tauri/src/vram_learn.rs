//! Post-launch VRAM learning — parse engine memory breakdown from stderr, cache per config fingerprint.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

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

fn store_path() -> PathBuf {
    crate::config::app_root_dir().join("config").join("learned-vram.json")
}

fn load_store() -> LearnedVramStore {
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

/// Fingerprint for learned VRAM — model + provider + launch-relevant params.
pub fn learned_vram_key(
    model_path: &str,
    provider_id: &str,
    ctx: &str,
    kv_quant: &str,
    device: &str,
    split: &str,
) -> String {
    format!(
        "{}|{}|ctx={}|kv={}|dev={}|split={}",
        model_path, provider_id, ctx, kv_quant, device, split
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
        model_path: model_path.to_string(),
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

pub fn lookup_learned_vram(key: &str) -> Option<LearnedVramEntry> {
    let store = load_store();
    store.entries.get(key).cloned()
}

pub fn record_learned_vram(
    key: String,
    vram_mib: f64,
    gpu_breakdown_mib: Option<Vec<f64>>,
) -> Result<(), String> {
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

/// Append newly seen breakdown tables (MoE --fit may emit many per launch).
/// `already_stored` = number of tables previously persisted for this load.
/// Returns (latest_mib, total_attempt_count) when new tables were added.
pub fn append_fit_breakdown_tables(
    key: &str,
    tables: &[crate::fit_scanner::MemoryBreakdownTable],
    already_stored: usize,
    phase: &str,
) -> Result<Option<(f64, usize)>, String> {
    if already_stored >= tables.len() {
        return Ok(None);
    }

    let mut store = load_store();
    let entry = store.entries.entry(key.to_string()).or_insert_with(|| LearnedVramEntry {
        vram_mib: 0.0,
        gpu_breakdown_mib: None,
        measured_at: String::new(),
        fit_attempts: Vec::new(),
    });

    let attempts_before = entry.fit_attempts.len();
    let mut latest_mib = entry.vram_mib;
    for table in tables.iter().skip(already_stored) {
        let mib = table.total_gpu_self_mib();
        if mib <= 0.0 {
            continue;
        }
        let attempt_no = entry.fit_attempts.len() + 1;
        entry.fit_attempts.push(LearnedVramFitAttempt {
            attempt: attempt_no,
            vram_mib: mib,
            gpu_breakdown_mib: Some(table.gpu_self_mib.clone()),
            host_mib: table.host_mib,
            phase: phase.to_string(),
            measured_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        });
        latest_mib = mib;
        entry.vram_mib = mib;
        entry.gpu_breakdown_mib = Some(table.gpu_self_mib.clone());
        entry.measured_at = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    }

    if entry.fit_attempts.len() == attempts_before {
        return Ok(None);
    }

    save_store(&store)?;
    // Return parsed table count so caller can skip already-seen tables on next pass.
    Ok(Some((latest_mib, tables.len())))
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
    let key = learned_vram_key(&model_path, &provider_id, &ctx, &kv_quant, &device, &split);
    lookup_learned_vram(&key)
}