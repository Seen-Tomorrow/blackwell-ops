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

impl LearnedVramEntry {
    /// LEARNED need for forecast. Latest launch wins unless it looks like a
    /// free-dependent spill (GPU down, host up) — that must not replace a fuller GPU.
    pub fn paint_vram_mib(&self) -> f64 {
        let Some(snap) = self.launch_snapshot.as_ref() else {
            return self.vram_mib;
        };
        if snap.vram_mib <= 0.0 {
            return self.vram_mib;
        }
        if is_spill_downgrade(self.vram_mib, self.host_mib, snap.vram_mib, snap.host_mib) {
            return self.vram_mib;
        }
        snap.vram_mib
    }

    pub fn paint_host_mib(&self) -> Option<f64> {
        let Some(snap) = self.launch_snapshot.as_ref() else {
            return self.host_mib;
        };
        if is_spill_downgrade(self.vram_mib, self.host_mib, snap.vram_mib, snap.host_mib) {
            return self.host_mib;
        }
        Some(snap.host_mib)
    }

    pub fn paint_gpu_breakdown_mib(&self) -> Option<&[f64]> {
        let Some(snap) = self.launch_snapshot.as_ref() else {
            return self.gpu_breakdown_mib.as_deref();
        };
        if snap.gpu_breakdown_mib.is_empty() {
            return self.gpu_breakdown_mib.as_deref();
        }
        if is_spill_downgrade(self.vram_mib, self.host_mib, snap.vram_mib, snap.host_mib) {
            return self.gpu_breakdown_mib.as_deref();
        }
        Some(snap.gpu_breakdown_mib.as_slice())
    }
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
    if s.is_empty() || s == "none" || s == "off" {
        "none".to_string()
    } else {
        s
    }
}

/// Baked-in MTP has no external draft GGUF — leftover DFLASH paths must not
/// fingerprint or filter LEARNED rows.
fn spec_uses_external_draft(spec_type: &str) -> bool {
    let s = normalize_spec_type(spec_type);
    if s == "none" {
        return false;
    }
    if s.contains("mtp") && !s.contains("dflash") && !s.contains("dspark") && !s.contains("eagle") {
        return false;
    }
    s.contains("dflash") || s.contains("dspark") || s.contains("eagle")
}

fn draft_key_for_learn(spec_type: &str, draft_key: &str) -> String {
    if !spec_uses_external_draft(spec_type) {
        return String::new();
    }
    draft_key.trim().to_string()
}

fn optional_launch_suffix(spec_type: &str, cache_ram: &str, draft_key: &str) -> String {
    let mut out = String::new();
    let spec = normalize_spec_type(spec_type);
    if spec != "none" {
        out.push_str(&format!("|spec={spec}"));
    }
    let draft = draft_key_for_learn(&spec, draft_key);
    if !draft.is_empty() {
        let base = std::path::Path::new(&draft)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(draft.as_str());
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
    let spec = config
        .get_param_str("spec_type")
        .unwrap_or_else(|| "none".to_string());
    if !spec_uses_external_draft(&spec) {
        return String::new();
    }
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
    let device_token = vram_device_token_from_config(config);
    learned_vram_key_with_draft(
        model_path,
        provider_id,
        &config.get_param_str("ctx").unwrap_or_else(|| "32768".to_string()),
        &config.get_param_str("kv_quant").unwrap_or_else(|| "f16".to_string()),
        &device_token,
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

/// Prefer manufactured-GB topo (`96` / `24+96`) over GPU index.
fn vram_device_token_from_config(config: &EngineConfig) -> String {
    if let Some(v) = config.get_param_str("__vram_topo") {
        let t = v.trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }
    config
        .get_param_str("device")
        .unwrap_or_else(|| "GPU-0".to_string())
}

fn device_token_is_vram_topo(token: &str) -> bool {
    let t = token.trim();
    !t.is_empty() && !t.to_ascii_uppercase().starts_with("GPU")
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

        if !key_matches_vram_topo(k, device) {
            continue;
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
        &vram_device_token_from_config(config),
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

/// GPU fell while host rose → stuffed-GPU spill, not an engine memory fix.
/// Accounting fixes (llama.cpp inventory) drop GPU *and* host together.
fn is_spill_downgrade(old_gpu: f64, old_host: Option<f64>, new_gpu: f64, new_host: f64) -> bool {
    if old_gpu <= 0.0 {
        return false;
    }
    if new_gpu + 1.0 >= old_gpu {
        return false;
    }
    let old_h = old_host.unwrap_or(0.0);
    new_host > old_h + 1.0
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

/// FIT-only primary promote when no launch snapshot yet.
/// Once a launch buffer inventory exists it owns primary; engine memory
/// regressions/fixes are captured by the next `record_launch_memory_snapshot`.
fn should_promote_fit_primary(entry: &LearnedVramEntry, new_vram_mib: f64) -> bool {
    if entry.launch_snapshot.is_some() {
        return false;
    }
    entry.vram_mib <= 0.0 || new_vram_mib + 1.0 >= entry.vram_mib
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

    let mut latest_mib = entry.paint_vram_mib();
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
        // FIT tables seed primary only until a launch inventory exists.
        // Never let FIT re-inflate over a newer lower launch measurement.
        if should_promote_fit_primary(entry, mib) {
            latest_mib = mib;
            entry.vram_mib = mib;
            entry.gpu_breakdown_mib = Some(table.gpu_self_mib.clone());
            entry.host_mib = table.host_mib;
        } else {
            latest_mib = entry.paint_vram_mib();
            if entry.launch_snapshot.is_some() {
                log::info!(
                    "[vram_learn] FIT table {:.1} MiB ignored for primary (launch inventory owns need)",
                    mib
                );
            } else {
                log::info!(
                    "[vram_learn] keep primary {:.1} MiB GPU (new {:.1} lower — likely free-dependent spill)",
                    entry.vram_mib,
                    mib
                );
            }
        }
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
    fn mtp_curve_ignores_leftover_external_draft() {
        let key = "C:/m.gguf|ggml-master|ctx=65536|kv=q8_0|dev=GPU-0|split=none|mode=full_auto|spec=draft-mtp";
        assert!(entry_matches_curve_hard_knobs(
            key,
            "C:/m.gguf",
            "ggml-master",
            "q8_0",
            "draft-mtp",
            "leftover-draft.gguf",
        ));
        assert!(!spec_uses_external_draft("draft-mtp"));
        assert!(spec_uses_external_draft("draft-dflash"));
        assert_eq!(draft_key_for_learn("draft-mtp", "C:/d.gguf"), "");
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

    #[test]
    fn launch_snapshot_replaces_higher_primary() {
        let key = "__launch_lower_primary_test__";
        {
            let _guard = STORE_MUTEX.lock().unwrap();
            let mut store = load_store();
            store.entries.insert(
                key.to_string(),
                LearnedVramEntry {
                    vram_mib: 168861.0,
                    gpu_breakdown_mib: Some(vec![85485.0, 83376.0]),
                    host_mib: Some(105086.0),
                    gpu_components_mib: None,
                    host_components_mib: None,
                    launch_snapshot: None,
                    measured_at: "old".into(),
                    fit_attempts: vec![],
                },
            );
            save_store(&store).unwrap();
        }

        let snap = LaunchMemorySnapshot {
            parser_id: "test".into(),
            reference_profile: None,
            architecture: None,
            requested_ctx: None,
            effective_ctx: None,
            vram_mib: 98853.84,
            gpu_breakdown_mib: vec![50481.74, 48372.1],
            gpu_components_mib: None,
            host_mib: 32761.79,
            host_components_mib: None,
            host_pinned_mib: 0.0,
            mtp_estimate_mib: None,
            mtp_context_mib: None,
            vision_estimate_mib: None,
            vision_mib: None,
            prompt_cache_limit_mib: None,
            buffers: vec![],
            phase: "loaded".into(),
            measured_at: "new".into(),
        };
        record_launch_memory_snapshot(key, snap).unwrap();

        let _guard = STORE_MUTEX.lock().unwrap();
        let mut store = load_store();
        let entry = store.entries.get(key).expect("entry");
        assert!((entry.vram_mib - 98853.84).abs() < 0.1);
        assert!((entry.host_mib.unwrap_or(0.0) - 32761.79).abs() < 0.1);
        assert!((entry.paint_vram_mib() - 98853.84).abs() < 0.1);
        // FIT must not re-inflate over launch inventory.
        drop(_guard);
        let tables = vec![MemoryBreakdownTable {
            gpu_self_mib: vec![85485.0, 83376.0],
            host_mib: Some(105086.0),
        }];
        append_fit_breakdown_tables(key, &tables, 0, "fit").unwrap();
        let _guard = STORE_MUTEX.lock().unwrap();
        let store = load_store();
        let entry = store.entries.get(key).expect("entry");
        assert!((entry.paint_vram_mib() - 98853.84).abs() < 0.1);
        assert!((entry.vram_mib - 98853.84).abs() < 0.1);

        let mut store = store;
        store.entries.remove(key);
        let _ = save_store(&store);
    }

    #[test]
    fn launch_spill_does_not_replace_fuller_primary() {
        let key = "__launch_spill_primary_test__";
        {
            let _guard = STORE_MUTEX.lock().unwrap();
            let mut store = load_store();
            store.entries.insert(
                key.to_string(),
                LearnedVramEntry {
                    vram_mib: 98854.0,
                    gpu_breakdown_mib: Some(vec![50000.0, 48854.0]),
                    host_mib: Some(800.0),
                    gpu_components_mib: None,
                    host_components_mib: None,
                    launch_snapshot: None,
                    measured_at: "full".into(),
                    fit_attempts: vec![],
                },
            );
            save_store(&store).unwrap();
        }
        let snap = LaunchMemorySnapshot {
            parser_id: "test".into(),
            reference_profile: None,
            architecture: None,
            requested_ctx: None,
            effective_ctx: None,
            vram_mib: 40000.0,
            gpu_breakdown_mib: vec![20000.0, 20000.0],
            gpu_components_mib: None,
            host_mib: 50000.0,
            host_components_mib: None,
            host_pinned_mib: 0.0,
            mtp_estimate_mib: None,
            mtp_context_mib: None,
            vision_estimate_mib: None,
            vision_mib: None,
            prompt_cache_limit_mib: None,
            buffers: vec![],
            phase: "loaded".into(),
            measured_at: "spill".into(),
        };
        record_launch_memory_snapshot(key, snap).unwrap();
        let _guard = STORE_MUTEX.lock().unwrap();
        let mut store = load_store();
        let entry = store.entries.get(key).expect("entry");
        assert!((entry.vram_mib - 98854.0).abs() < 0.1, "spill must not lower LEARNED GPU");
        assert!((entry.paint_vram_mib() - 98854.0).abs() < 0.1);
        assert!(entry.launch_snapshot.is_some());
        store.entries.remove(key);
        let _ = save_store(&store);
    }
}

/// Persist post-load buffer inventory.
/// Latest launch updates LEARNED need unless it is a spill (GPU down, host up).
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

    let measured_mib = snapshot.vram_mib;
    let measured_host = snapshot.host_mib;
    let spill = is_spill_downgrade(entry.vram_mib, entry.host_mib, snapshot.vram_mib, snapshot.host_mib);
    entry.launch_snapshot = Some(snapshot.clone());
    entry.measured_at = snapshot.measured_at.clone();
    if spill {
        log::info!(
            "[vram_learn] launch snapshot keep primary {:.1} MiB GPU (new {:.1}, host {:.1}) — spill/low-free not promoted",
            entry.vram_mib,
            snapshot.vram_mib,
            snapshot.host_mib
        );
    } else {
        entry.vram_mib = snapshot.vram_mib;
        entry.gpu_breakdown_mib = Some(snapshot.gpu_breakdown_mib.clone());
        entry.host_mib = Some(snapshot.host_mib);
        entry.gpu_components_mib = snapshot.gpu_components_mib.clone();
        entry.host_components_mib = snapshot.host_components_mib.clone();
    }
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
    vram_topo: Option<String>,
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
    let spec = spec_type.as_deref().unwrap_or("none");
    let cache = cache_ram.as_deref().unwrap_or("0");
    let draft = draft_key_for_learn(spec, draft_model.as_deref().unwrap_or(""));
    let device_token = vram_topo
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(device.as_str());
    let mut entry = lookup_learned_vram_fuzzy(
        &model_path,
        &provider_id,
        &ctx,
        &kv_quant,
        device_token,
        &split,
        &mode,
        &offload,
        spec,
        cache,
        &draft,
    )?;
    let painted_v = entry.paint_vram_mib();
    let painted_h = entry.paint_host_mib();
    let painted_bd = entry.paint_gpu_breakdown_mib().map(|b| b.to_vec());
    entry.vram_mib = painted_v;
    entry.host_mib = painted_h;
    if let Some(bd) = painted_bd {
        entry.gpu_breakdown_mib = Some(bd);
    }
    Some(entry)
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
        if spec_uses_external_draft(spec_n) && !draft_base.is_empty() {
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

fn key_matches_vram_topo(key: &str, want: &str) -> bool {
    if !device_token_is_vram_topo(want) {
        return true;
    }
    let Some(rest) = key.split("|dev=").nth(1) else {
        return true;
    };
    let got = rest.split('|').next().unwrap_or("").trim();
    got.eq_ignore_ascii_case(want.trim())
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
    vram_topo: Option<String>,
) -> Vec<LearnedVramCurvePoint> {
    let Some(_guard) = STORE_MUTEX.lock().ok() else {
        return Vec::new();
    };
    let store = load_store();
    let path_norm = normalize_model_path_for_key(&model_path);
    let kv_n = kv_quant.trim().to_lowercase();
    let spec_n = normalize_spec_type(spec_type.as_deref().unwrap_or("none"));
    let draft_raw = draft_key_for_learn(&spec_n, draft_model.as_deref().unwrap_or(""));
    let draft_base = {
        let d = draft_raw.trim();
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
        if let Some(topo) = vram_topo.as_deref() {
            if !key_matches_vram_topo(k, topo) {
                continue;
            }
        }
        let Some(ctx) = ctx_from_learn_key(k) else {
            continue;
        };
        let vram = entry.paint_vram_mib();
        if vram <= 0.0 {
            continue;
        }
        let point = LearnedVramCurvePoint {
            ctx,
            vram_mib: vram,
            host_mib: entry.paint_host_mib(),
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

/// Delete LEARNED rows for this curve identity whose ctx is in `remove_ctxs`.
/// Same match as `get_learned_vram_curve` (model + kv/spec/draft + split; device ignored).
#[tauri::command]
pub fn prune_learned_vram_curve(
    app: tauri::AppHandle,
    model_path: String,
    provider_id: String,
    kv_quant: String,
    spec_type: Option<String>,
    draft_model: Option<String>,
    split: Option<String>,
    vram_topo: Option<String>,
    remove_ctxs: Vec<u64>,
) -> Result<u32, String> {
    use tauri::Emitter;

    if remove_ctxs.is_empty() {
        return Ok(0);
    }
    let want: std::collections::HashSet<usize> =
        remove_ctxs.into_iter().map(|c| c as usize).collect();

    let _guard = STORE_MUTEX
        .lock()
        .map_err(|e| format!("learned-vram store lock poisoned: {e}"))?;
    let mut store = load_store();
    let path_norm = normalize_model_path_for_key(&model_path);
    let kv_n = kv_quant.trim().to_lowercase();
    let spec_n = normalize_spec_type(spec_type.as_deref().unwrap_or("none"));
    let draft_raw = draft_key_for_learn(&spec_n, draft_model.as_deref().unwrap_or(""));
    let draft_base = {
        let d = draft_raw.trim();
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

    let before = store.entries.len();
    store.entries.retain(|k, _| {
        if !entry_matches_curve_hard_knobs(
            k,
            &path_norm,
            &provider_id,
            &kv_n,
            &spec_n,
            &draft_base,
        ) {
            return true;
        }
        if !key_matches_split(k, &split_n) {
            return true;
        }
        if let Some(topo) = vram_topo.as_deref() {
            if !key_matches_vram_topo(k, topo) {
                return true;
            }
        }
        let Some(ctx) = ctx_from_learn_key(k) else {
            return true;
        };
        !want.contains(&ctx)
    });
    let removed = (before.saturating_sub(store.entries.len())) as u32;
    if removed > 0 {
        save_store(&store)?;
        let _ = app.emit(
            "learned-vram-changed",
            serde_json::json!({
                "model_path": model_path,
                "provider_id": provider_id,
            }),
        );
        log::info!(
            "[vram_learn] pruned {removed} custom curve row(s) for {path_norm} kv={kv_n} split={split_n}"
        );
    }
    Ok(removed)
}
