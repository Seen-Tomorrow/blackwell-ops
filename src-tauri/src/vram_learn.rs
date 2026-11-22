//! Post-launch VRAM learning — parse engine memory breakdown from stderr/inventory,
//! cache per typed `LearnKey`, and serve the unified `LearnedForecastBundle`.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

use crate::fit_scanner::GpuComponentMib;
use crate::launch_memory_parse::LaunchMemorySnapshot;
use crate::types::EngineConfig;

/// Version of the *memory maths* that wrote the store. Bump it by hand when a formula changes.
/// Older schemas are discarded cleanly (no migration shims).
const STORE_SCHEMA: u32 = 2;
const STORE_FILE: &str = "learned-vram.json";
/// Matches `HOST_BUFFER_CEILING_GB = 2.5` in `lowVramProbe.ts`.
const HOST_WEIGHT_SPILL_CEILING_MIB: f64 = 2.5 * 1024.0;

fn default_parallel() -> u32 {
    1
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExpertRegime {
    Plain,
    /// `-cmoe`: experts in host RAM; `moe_cache_mib` is additive on top and never part of the key.
    CpuExperts,
}

impl ExpertRegime {
    pub fn from_cpu_moe(val: &str) -> Self {
        if matches!(val.trim().to_lowercase().as_str(), "on" | "true" | "1") {
            Self::CpuExperts
        } else {
            Self::Plain
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Plain => "plain",
            Self::CpuExperts => "cpu_experts",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct LearnKey {
    pub model_path: String,
    pub provider_id: String,
    pub ctx: usize,
    pub kv_quant: String,
    pub split: String,
    pub topo: String,
    pub regime: ExpertRegime,
}

impl LearnKey {
    pub fn canonical(&self) -> String {
        format!(
            "{}|{}|ctx={}|kv={}|topo={}|split={}|regime={}",
            self.model_path,
            self.provider_id,
            self.ctx,
            self.kv_quant,
            self.topo,
            self.split,
            self.regime.as_str()
        )
    }

    pub fn matches_family(
        &self,
        model_path_norm: &str,
        provider_id: &str,
        kv_quant_norm: &str,
        split_norm: &str,
        topo: Option<&str>,
        regime: ExpertRegime,
    ) -> bool {
        if self.model_path != model_path_norm {
            return false;
        }
        if !provider_id.trim().is_empty() && self.provider_id != provider_id.trim() {
            return false;
        }
        if self.kv_quant != kv_quant_norm {
            return false;
        }
        if self.split != split_norm {
            return false;
        }
        if self.regime != regime {
            return false;
        }
        if let Some(t) = topo {
            if device_token_is_vram_topo(t) && !self.topo.is_empty() && !self.topo.eq_ignore_ascii_case(t.trim()) {
                return false;
            }
        }
        true
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearnedVramFitAttempt {
    pub attempt: usize,
    pub vram_mib: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_breakdown_mib: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_mib: Option<f64>,
    pub phase: String,
    pub measured_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearnedSpecDeltaPoint {
    pub ctx: usize,
    pub vram_mib: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_mib: Option<f64>,
    pub measured_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearnedUbPoint {
    pub ubatch: u32,
    #[serde(default)]
    pub gpu_compute_mib: Vec<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_compute_mib: Option<f64>,
    #[serde(default)]
    pub measured_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearnedVramEntry {
    pub key: LearnKey,
    pub vram_mib: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_batch: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_ubatch: Option<u32>,
    #[serde(default = "default_parallel")]
    pub parallel: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_spec_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec_included: Option<bool>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub spec_deltas: HashMap<String, LearnedSpecDeltaPoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_breakdown_mib: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_mib: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_components_mib: Option<Vec<GpuComponentMib>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_components_mib: Option<GpuComponentMib>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_snapshot: Option<LaunchMemorySnapshot>,
    pub measured_at: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ub_points: Vec<LearnedUbPoint>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fit_attempts: Vec<LearnedVramFitAttempt>,
}

impl LearnedVramEntry {
    fn new(key: LearnKey) -> Self {
        Self {
            key,
            vram_mib: 0.0,
            reference_batch: None,
            reference_ubatch: None,
            parallel: 1,
            reference_spec_key: None,
            spec_included: None,
            spec_deltas: HashMap::new(),
            gpu_breakdown_mib: None,
            host_mib: None,
            gpu_components_mib: None,
            host_components_mib: None,
            launch_snapshot: None,
            measured_at: String::new(),
            ub_points: Vec::new(),
            fit_attempts: Vec::new(),
        }
    }

    pub fn paint_vram_mib(&self) -> f64 {
        let Some(snap) = self.launch_snapshot.as_ref() else {
            return self.vram_mib;
        };
        if snap.vram_mib <= 0.0 {
            return self.vram_mib;
        }
        if self.key.regime == ExpertRegime::Plain
            && is_spill_downgrade(self.vram_mib, self.host_mib, snap.vram_mib, snap.host_mib)
        {
            return self.vram_mib;
        }
        snap.vram_mib
    }

    pub fn paint_host_mib(&self) -> Option<f64> {
        let Some(snap) = self.launch_snapshot.as_ref() else {
            return self.host_mib;
        };
        if self.key.regime == ExpertRegime::Plain
            && is_spill_downgrade(self.vram_mib, self.host_mib, snap.vram_mib, snap.host_mib)
        {
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
        if self.key.regime == ExpertRegime::Plain
            && is_spill_downgrade(self.vram_mib, self.host_mib, snap.vram_mib, snap.host_mib)
        {
            return self.gpu_breakdown_mib.as_deref();
        }
        Some(snap.gpu_breakdown_mib.as_slice())
    }

    fn sync_snapshot_totals(&mut self) {
        if let Some(snap) = self.launch_snapshot.as_mut() {
            snap.vram_mib = self.vram_mib;
            if let Some(host) = self.host_mib {
                snap.host_mib = host;
            }
            if let Some(breakdown) = self.gpu_breakdown_mib.as_ref() {
                snap.gpu_breakdown_mib = breakdown.clone();
            }
        }
    }

    fn apply_compute_model(&mut self, ctx: f64, ubatch: f64, model: &ComputeModel) -> bool {
        let Some(components) = self.gpu_components_mib.as_mut() else {
            return false;
        };
        if components.len() != model.gpu.len() {
            return false;
        }
        for (component, fit) in components.iter_mut().zip(model.gpu.iter()) {
            component.compute_mib = fit.predict(ctx, ubatch);
        }
        let totals: Vec<f64> = components
            .iter()
            .map(|c| c.model_mib + c.ctx_mib + c.compute_mib)
            .collect();
        self.vram_mib = totals.iter().sum();
        self.gpu_breakdown_mib = Some(totals);
        if let (Some(host), Some(fit)) = (self.host_components_mib.as_mut(), model.host.as_ref()) {
            host.compute_mib = fit.predict(ctx, ubatch);
            let total = host.model_mib + host.ctx_mib + host.compute_mib;
            if total > 0.0 {
                self.host_mib = Some(total);
            }
        }
        self.sync_snapshot_totals();
        true
    }

    fn scale_compute_by_factor(&mut self, factor: f64) {
        let mut scaled = false;
        if let Some(components) = self.gpu_components_mib.as_mut() {
            for component in components.iter_mut() {
                component.compute_mib *= factor;
            }
            let totals: Vec<f64> = components
                .iter()
                .map(|c| c.model_mib + c.ctx_mib + c.compute_mib)
                .collect();
            self.vram_mib = totals.iter().sum();
            self.gpu_breakdown_mib = Some(totals);
            scaled = true;
        }
        if let Some(host) = self.host_components_mib.as_mut() {
            host.compute_mib *= factor;
            let total = host.model_mib + host.ctx_mib + host.compute_mib;
            if total > 0.0 {
                self.host_mib = Some(total);
            }
            scaled = true;
        }
        if scaled {
            self.sync_snapshot_totals();
        }
    }

    fn scale_compute_by_response(&mut self, ubatch: Option<u32>, share: f64) {
        let Some(now) = ubatch.filter(|b| *b > 0) else {
            return;
        };
        let Some(reference) = self.reference_ubatch.filter(|b| *b > 0) else {
            return;
        };
        if now == reference {
            return;
        }
        let growth = now as f64 / reference as f64;
        let factor = (1.0 + share.clamp(0.0, 1.5) * (growth - 1.0)).max(0.05);
        self.scale_compute_by_factor(factor);
    }

    pub fn scale_compute_to_ubatch(&mut self, ubatch: Option<u32>) {
        let Some(now) = ubatch.filter(|b| *b > 0) else {
            return;
        };
        let Some(reference) = self.reference_ubatch.filter(|b| *b > 0) else {
            return;
        };
        if now == reference {
            return;
        }
        self.scale_compute_by_factor(now as f64 / reference as f64);
    }

    fn remember_ub_point(&mut self, ubatch: u32, measured_at: &str) {
        if ubatch == 0 {
            return;
        }
        let Some(components) = self.gpu_components_mib.as_ref() else {
            return;
        };
        let point = LearnedUbPoint {
            ubatch,
            gpu_compute_mib: components.iter().map(|c| c.compute_mib).collect(),
            host_compute_mib: self.host_components_mib.as_ref().map(|c| c.compute_mib),
            measured_at: measured_at.to_string(),
        };
        self.ub_points.retain(|p| p.ubatch != ubatch);
        self.ub_points.push(point);
        if self.ub_points.len() > 6 {
            let drop = self.ub_points.len() - 6;
            self.ub_points.drain(0..drop);
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct LearnedVramStore {
    #[serde(default)]
    schema: u32,
    #[serde(default)]
    entries: HashMap<String, LearnedVramEntry>,
}

static STORE_CACHE: LazyLock<Mutex<Option<LearnedVramStore>>> = LazyLock::new(|| Mutex::new(None));

fn store_path() -> PathBuf {
    crate::config::cache_dir().join(STORE_FILE)
}

fn accept_store(store: LearnedVramStore) -> LearnedVramStore {
    if store.schema != STORE_SCHEMA {
        log::warn!(
            "[vram_learn] store schema {} != {STORE_SCHEMA} — discarding {} stale row(s)",
            store.schema,
            store.entries.len()
        );
        return LearnedVramStore {
            schema: STORE_SCHEMA,
            entries: HashMap::new(),
        };
    }
    store
}

fn load_store_from_disk() -> LearnedVramStore {
    let path = store_path();
    if !path.exists() {
        return LearnedVramStore {
            schema: STORE_SCHEMA,
            entries: HashMap::new(),
        };
    }
    let store: LearnedVramStore = match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => LearnedVramStore::default(),
    };
    accept_store(store)
}

fn save_store_to_disk(store: &LearnedVramStore) -> Result<(), String> {
    let mut stamped = store.clone();
    stamped.schema = STORE_SCHEMA;
    crate::fs_util::write_json_atomic(&store_path(), &stamped)
}

fn with_store<R>(f: impl FnOnce(&LearnedVramStore) -> R) -> Option<R> {
    let mut guard = STORE_CACHE.lock().ok()?;
    if guard.is_none() {
        *guard = Some(load_store_from_disk());
    }
    guard.as_ref().map(f)
}

fn with_store_mut<R>(
    f: impl FnOnce(&mut LearnedVramStore) -> Result<(R, bool), String>,
) -> Result<R, String> {
    let mut guard = STORE_CACHE
        .lock()
        .map_err(|e| format!("learned-vram store lock poisoned: {e}"))?;
    if guard.is_none() {
        *guard = Some(load_store_from_disk());
    }
    let store = guard.as_mut().expect("initialized");
    let (res, dirty) = f(store)?;
    if dirty {
        save_store_to_disk(store)?;
    }
    Ok(res)
}

pub fn all_entries_snapshot() -> Vec<LearnedVramEntry> {
    with_store(|store| store.entries.values().cloned().collect()).unwrap_or_default()
}

fn normalize_ctx_tokens(ctx: &str) -> usize {
    ctx_tokens_from_str(ctx).unwrap_or(32768)
}

fn ctx_tokens_from_str(raw: &str) -> Option<usize> {
    let s = raw.trim().to_ascii_lowercase();
    if s.is_empty() {
        return None;
    }
    let (digits, mult) = match s.strip_suffix('k') {
        Some(d) => (d, 1024usize),
        None => match s.strip_suffix('m') {
            Some(d) => (d, 1024usize * 1024),
            None => (s.as_str(), 1usize),
        },
    };
    digits.trim().parse::<usize>().ok().map(|n| n * mult)
}

fn normalize_model_path_for_key(model_path: &str) -> String {
    crate::config::model_file_cache_key(model_path)
}

fn normalize_split_mode(split: &str) -> String {
    let s = split.trim().to_lowercase();
    if s.is_empty() {
        "none".to_string()
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

fn normalize_draft_key(raw: &str) -> String {
    let value = raw.trim();
    if value.is_empty()
        || value.eq_ignore_ascii_case("off")
        || value.eq_ignore_ascii_case("none")
        || value.eq_ignore_ascii_case("auto")
    {
        String::new()
    } else {
        value.to_string()
    }
}

fn spec_uses_external_draft(spec_type: &str, draft_key: &str) -> bool {
    let s = normalize_spec_type(spec_type);
    let draft = normalize_draft_key(draft_key);
    if s == "none" {
        return false;
    }
    if s.contains("mtp") && !s.contains("dflash") && !s.contains("dspark") && !s.contains("eagle") {
        return s == "draft-mtp" && !draft.is_empty();
    }
    s.contains("dflash") || s.contains("dspark") || s.contains("eagle")
}

fn draft_key_for_learn(spec_type: &str, draft_key: &str) -> String {
    if !spec_uses_external_draft(spec_type, draft_key) {
        return String::new();
    }
    normalize_draft_key(draft_key)
}

fn draft_basename(draft: &str) -> String {
    let d = draft.trim();
    if d.is_empty() {
        return String::new();
    }
    std::path::Path::new(d)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(d)
        .to_lowercase()
}

fn spec_key_for_learn(spec_type: &str, draft_key: &str) -> String {
    let spec = normalize_spec_type(spec_type);
    let draft = draft_key_for_learn(&spec, draft_key);
    if draft.is_empty() {
        spec
    } else {
        format!("{spec}|{}", draft_basename(&draft))
    }
}

fn draft_path_from_config(config: &EngineConfig) -> String {
    let spec = config
        .get_param_str("spec_type")
        .unwrap_or_else(|| "none".to_string());
    let draft = config
        .get_param_str("spec_draft_model")
        .or_else(|| config.get_param_str("dflash_draft_model"))
        .or_else(|| config.get_param_str("mtp_draft_model"))
        .unwrap_or_default();
    if !spec_uses_external_draft(&spec, &draft) {
        return String::new();
    }
    normalize_draft_key(&draft)
}

fn vram_device_token_from_config(config: &EngineConfig) -> String {
    if let Some(v) = config.get_param_str("__vram_topo") {
        let t = v.trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }
    String::new()
}

fn device_token_is_vram_topo(token: &str) -> bool {
    let t = token.trim();
    !t.is_empty() && !t.to_ascii_uppercase().starts_with("GPU")
}

pub fn learn_key_from_config(model_path: &str, provider_id: &str, config: &EngineConfig) -> LearnKey {
    let ctx_str = config.get_param_str("ctx").unwrap_or_else(|| "32768".to_string());
    LearnKey {
        model_path: normalize_model_path_for_key(model_path),
        provider_id: provider_id.trim().to_string(),
        ctx: normalize_ctx_tokens(&ctx_str),
        kv_quant: config
            .get_param_str("kv_quant")
            .unwrap_or_else(|| "f16".to_string())
            .trim()
            .to_lowercase(),
        split: normalize_split_mode(&config.get_param_str("split").unwrap_or_else(|| "none".to_string())),
        topo: vram_device_token_from_config(config),
        regime: ExpertRegime::from_cpu_moe(&config.get_param_str("cpu_moe").unwrap_or_default()),
    }
}

#[derive(Debug, Clone)]
pub struct VramLearnSnapshot {
    pub key: LearnKey,
    pub learn_key: String,
    pub model_path: String,
    pub provider_id: String,
    pub batch: u32,
    pub ubatch: u32,
    pub parallel: u32,
    pub spec_key: String,
}

impl VramLearnSnapshot {
    pub fn is_cpu_experts(&self) -> bool {
        self.key.regime == ExpertRegime::CpuExperts
    }
}

pub fn snapshot_from_config(
    model_path: &str,
    provider_id: &str,
    config: &EngineConfig,
) -> VramLearnSnapshot {
    let key = learn_key_from_config(model_path, provider_id, config);
    VramLearnSnapshot {
        learn_key: key.canonical(),
        model_path: key.model_path.clone(),
        provider_id: key.provider_id.clone(),
        key,
        batch: config
            .get_param_str("batch")
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0),
        ubatch: config
            .get_param_str("ubatch")
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0),
        parallel: config
            .get_param_str("parallel")
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(1),
        spec_key: spec_key_for_learn(
            &config
                .get_param_str("spec_type")
                .unwrap_or_else(|| "none".to_string()),
            &draft_path_from_config(config),
        ),
    }
}

pub fn lookup_learned_vram_for_config(
    model_path: &str,
    provider_id: &str,
    config: &EngineConfig,
) -> Option<LearnedVramEntry> {
    let want = learn_key_from_config(model_path, provider_id, config);
    let canonical = want.canonical();
    with_store(|store| {
        if let Some(exact) = store.entries.get(&canonical) {
            return Some(exact.clone());
        }
        store
            .entries
            .values()
            .filter(|e| {
                e.key.ctx == want.ctx
                    && e.key.matches_family(
                        &want.model_path,
                        &want.provider_id,
                        &want.kv_quant,
                        &want.split,
                        Some(&want.topo),
                        want.regime,
                    )
            })
            .max_by(|a, b| a.measured_at.cmp(&b.measured_at))
            .cloned()
    })
    .flatten()
}

fn mib_approx_equal(a: f64, b: f64) -> bool {
    (a - b).abs() < 0.5
}

fn is_spill_downgrade(old_gpu: f64, old_host: Option<f64>, new_gpu: f64, new_host: f64) -> bool {
    if old_gpu <= 0.0 || new_gpu + 1.0 >= old_gpu {
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
        Some(vals) => {
            vals.len() == b.len()
                && vals
                    .iter()
                    .zip(b.iter())
                    .all(|(x, y)| mib_approx_equal(*x, *y))
        }
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

fn spec_reference_matches(entry: &mut LearnedVramEntry, spec_key: &str) -> bool {
    match entry.reference_spec_key.as_deref() {
        Some(reference) => reference == spec_key,
        None => {
            entry.reference_spec_key = Some(spec_key.to_string());
            true
        }
    }
}

fn spec_measurement_is_additive(base_vram: f64, measured_vram: f64) -> bool {
    measured_vram >= base_vram * 0.5
}

fn spec_delta_is_additive(base_vram: f64, delta_vram: f64) -> bool {
    delta_vram >= -(base_vram * 0.05).max(512.0)
}

fn record_spec_delta(
    entry: &mut LearnedVramEntry,
    ctx: usize,
    spec_key: &str,
    vram_mib: f64,
    host_mib: Option<f64>,
) {
    let base_vram = entry.paint_vram_mib();
    if !spec_measurement_is_additive(base_vram, vram_mib) {
        log::warn!(
            "[vram_learn] ignoring spec measurement {:.1} MiB vs base {:.1} MiB - draft-only ledger",
            vram_mib,
            base_vram
        );
        return;
    }
    let base_host = entry.paint_host_mib().unwrap_or(0.0);
    entry.spec_deltas.insert(
        spec_key.to_string(),
        LearnedSpecDeltaPoint {
            ctx,
            vram_mib: vram_mib - base_vram,
            host_mib: host_mib.map(|h| h - base_host),
            measured_at: timestamp_now(),
        },
    );
}

fn should_promote_fit_primary(entry: &LearnedVramEntry, new_vram_mib: f64) -> bool {
    if entry.launch_snapshot.is_some() {
        return false;
    }
    entry.vram_mib <= 0.0 || new_vram_mib + 1.0 >= entry.vram_mib
}

pub fn append_fit_breakdown_tables(
    meta: &VramLearnSnapshot,
    tables: &[crate::fit_scanner::MemoryBreakdownTable],
    already_stored: usize,
    phase: &str,
) -> Result<Option<(f64, usize)>, String> {
    if already_stored >= tables.len() {
        return Ok(None);
    }
    with_store_mut(|store| {
        let entry = store
            .entries
            .entry(meta.learn_key.clone())
            .or_insert_with(|| LearnedVramEntry::new(meta.key.clone()));

        let ubatch = if meta.batch > 0 {
            meta.ubatch.min(meta.batch)
        } else {
            meta.ubatch
        };
        if entry.reference_ubatch.is_some_and(|prev| prev != ubatch) {
            entry.remember_ub_point(entry.reference_ubatch.unwrap_or(0), &entry.measured_at.clone());
        }
        entry.reference_batch = Some(meta.batch);
        entry.reference_ubatch = Some(ubatch);
        entry.parallel = meta.parallel.max(1);

        if !spec_reference_matches(entry, &meta.spec_key) {
            let table = tables.last();
            let mib = table.map(|t| t.total_gpu_self_mib()).unwrap_or(0.0);
            if mib > 0.0 {
                record_spec_delta(entry, meta.key.ctx, &meta.spec_key, mib, table.and_then(|t| t.host_mib));
                return Ok((Some((mib, tables.len())), true));
            }
            return Ok((Some((mib, tables.len())), false));
        }

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
            if should_promote_fit_primary(entry, mib) {
                latest_mib = mib;
                entry.vram_mib = mib;
                entry.gpu_breakdown_mib = Some(table.gpu_self_mib.clone());
                entry.host_mib = table.host_mib;
            } else {
                latest_mib = entry.paint_vram_mib();
            }
            entry.measured_at = now;
            dirty = true;
        }

        if !consumed {
            return Ok((None, dirty));
        }
        Ok((Some((latest_mib, tables.len())), dirty))
    })
}

pub fn record_launch_memory_snapshot(
    meta: &VramLearnSnapshot,
    snapshot: LaunchMemorySnapshot,
) -> Result<(), String> {
    let measured_mib = snapshot.vram_mib;
    let host_net_mib = (snapshot.host_mib - snapshot.engram_mib.unwrap_or(0.0)).max(0.0);

    with_store_mut(|store| {
        let entry = store
            .entries
            .entry(meta.learn_key.clone())
            .or_insert_with(|| LearnedVramEntry::new(meta.key.clone()));

        let ubatch = if meta.batch > 0 {
            meta.ubatch.min(meta.batch)
        } else {
            meta.ubatch
        };
        if entry.reference_ubatch.is_some_and(|prev| prev != ubatch) {
            entry.remember_ub_point(entry.reference_ubatch.unwrap_or(0), &entry.measured_at.clone());
        }
        entry.reference_batch = Some(meta.batch);
        entry.reference_ubatch = Some(ubatch);
        entry.parallel = meta.parallel.max(1);

        if !spec_reference_matches(entry, &meta.spec_key) {
            record_spec_delta(entry, meta.key.ctx, &meta.spec_key, snapshot.vram_mib, Some(host_net_mib));
            return Ok(((), true));
        }

        let spill = entry.key.regime == ExpertRegime::Plain
            && is_spill_downgrade(entry.vram_mib, entry.host_mib, snapshot.vram_mib, host_net_mib);
        entry.launch_snapshot = Some(snapshot.clone());
        entry.measured_at = snapshot.measured_at.clone();
        if spill {
            log::info!(
                "[vram_learn] launch snapshot keep primary {:.1} MiB GPU (new {:.1}, host {:.1}) — spill not promoted",
                entry.vram_mib,
                snapshot.vram_mib,
                host_net_mib
            );
        } else {
            entry.vram_mib = snapshot.vram_mib;
            entry.gpu_breakdown_mib = Some(snapshot.gpu_breakdown_mib.clone());
            entry.host_mib = Some(host_net_mib);
            entry.gpu_components_mib = snapshot.gpu_components_mib.clone();
            entry.host_components_mib = snapshot.host_components_mib.clone();
        }
        Ok(((), true))
    })?;

    crate::forecast_log::record_measured(&meta.learn_key, measured_mib, Some(host_net_mib), "launch");
    Ok(())
}

/// Index of a real CUDA device ("CUDA0", "CUDA1"), never the host pseudo-device.
fn cuda_device_index(device: &str) -> Option<usize> {
    let rest = device.strip_prefix("CUDA")?;
    if rest.is_empty() || !rest.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    rest.parse().ok()
}

fn measured_kv_mib(entry: &LearnedVramEntry) -> Option<f64> {
    entry
        .launch_snapshot
        .as_ref()
        .and_then(|s| s.gpu_components_mib.as_ref())
        .or(entry.gpu_components_mib.as_ref())
        .map(|rows| rows.iter().map(|g| g.ctx_mib).sum::<f64>())
        .filter(|mib| *mib > 0.0)
}

fn measured_engram_mib(entry: &LearnedVramEntry) -> Option<f64> {
    entry
        .launch_snapshot
        .as_ref()
        .and_then(|s| s.engram_mib)
        .filter(|mib| *mib > 0.0)
}

fn entry_weight_spill_mib(entry: &LearnedVramEntry, model_engram_mib: Option<f64>) -> Option<f64> {
    if entry.key.regime == ExpertRegime::CpuExperts {
        return None;
    }
    let engram = measured_engram_mib(entry).or(model_engram_mib).unwrap_or(0.0);
    let host_model_mib = entry
        .host_components_mib
        .as_ref()
        .or_else(|| {
            entry
                .launch_snapshot
                .as_ref()
                .and_then(|s| s.host_components_mib.as_ref())
        })
        .map(|c| c.model_mib)
        .filter(|v| *v > 0.0);

    if let Some(model_mib) = host_model_mib {
        let excess = (model_mib - engram).max(0.0);
        return (excess > HOST_WEIGHT_SPILL_CEILING_MIB).then_some(excess);
    }

    // Legacy/no-component fallback only when there are no external spec/draft host buffers.
    if entry.host_components_mib.is_none()
        && entry.spec_included != Some(true)
        && entry.reference_spec_key.as_deref().unwrap_or("none") == "none"
    {
        let excess = (entry.paint_host_mib().unwrap_or(0.0) - engram).max(0.0);
        return (excess > HOST_WEIGHT_SPILL_CEILING_MIB).then_some(excess);
    }
    None
}

// ── Compute-buffer (ctx, ubatch) model ────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct ComputeSample {
    ctx: f64,
    ubatch: f64,
    gpu: Vec<f64>,
    host: Option<f64>,
}

#[derive(Debug, Clone)]
enum ComputeFit {
    Plane([f64; 4]),
    UbOnly([f64; 2]),
}

impl ComputeFit {
    fn predict(&self, ctx: f64, ub: f64) -> f64 {
        let value = match self {
            Self::Plane(c) => return predict_compute(c, ctx, ub),
            Self::UbOnly(c) => c[0] + c[1] * ub,
        };
        if value.is_finite() {
            value.max(0.0)
        } else {
            0.0
        }
    }
}

#[derive(Debug, Clone)]
struct ComputeModel {
    gpu: Vec<ComputeFit>,
    host: Option<ComputeFit>,
}

fn measured_ub_response(store: &LearnedVramStore) -> Option<f64> {
    #[derive(PartialEq, Eq, PartialOrd, Ord)]
    struct FamKey<'a>(&'a str, &'a str, &'a str, &'a str, &'a str, u8);

    let mut families: BTreeMap<FamKey<'_>, BTreeMap<usize, Vec<(u32, f64)>>> = BTreeMap::new();
    for entry in store.entries.values() {
        let Some(ub) = entry.reference_ubatch.filter(|u| *u > 0) else {
            continue;
        };
        let Some(components) = entry.gpu_components_mib.as_ref() else {
            continue;
        };
        let Some(first) = components.first() else {
            continue;
        };
        let fam = FamKey(
            &entry.key.model_path,
            &entry.key.provider_id,
            &entry.key.kv_quant,
            &entry.key.split,
            &entry.key.topo,
            entry.key.regime as u8,
        );
        families
            .entry(fam)
            .or_default()
            .entry(entry.key.ctx)
            .or_default()
            .push((ub, first.compute_mib));
    }

    let mut shares: Vec<f64> = Vec::new();
    for ctxs in families.values() {
        for points in ctxs.values() {
            if points.len() < 2 {
                continue;
            }
            let mut sorted = points.clone();
            sorted.sort_by_key(|(ub, _)| *ub);
            let (u_lo, c_lo) = sorted[0];
            let (u_hi, c_hi) = sorted[sorted.len() - 1];
            if u_hi == u_lo || c_lo <= 0.0 {
                continue;
            }
            let proportional = c_lo * (f64::from(u_hi - u_lo) / f64::from(u_lo));
            if proportional <= 0.0 {
                continue;
            }
            shares.push(((c_hi - c_lo) / proportional).clamp(0.0, 1.5));
        }
    }
    if shares.is_empty() {
        return None;
    }
    shares.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = shares.len() / 2;
    Some(if shares.len() % 2 == 0 {
        (shares[mid - 1] + shares[mid]) / 2.0
    } else {
        shares[mid]
    })
}

fn fit_ub_only(samples: &[(f64, f64, f64)]) -> Option<[f64; 2]> {
    let distinct: Vec<f64> = {
        let mut v: Vec<f64> = samples.iter().map(|s| s.1).collect();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        v.dedup();
        v
    };
    if distinct.len() < 2 {
        return None;
    }
    let ub_scale = distinct.iter().fold(1.0f64, |acc, v| acc.max(*v));
    let n = samples.len() as f64;
    let (mut s0, mut s1, mut s11, mut sy, mut s1y) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for (_, ub, y) in samples {
        let x = ub / ub_scale;
        s0 += 1.0;
        s1 += x;
        s11 += x * x;
        sy += y;
        s1y += x * y;
    }
    let det = s0 * s11 - s1 * s1;
    if det.abs() < 1e-9 || n < 2.0 {
        return None;
    }
    let c0 = (s11 * sy - s1 * s1y) / det;
    let c1 = (s0 * s1y - s1 * sy) / det;
    Some([c0, c1 / ub_scale])
}

fn solve_4x4(mut a: [[f64; 4]; 4], mut b: [f64; 4]) -> Option<[f64; 4]> {
    for col in 0..4 {
        let mut pivot = col;
        for row in col + 1..4 {
            if a[row][col].abs() > a[pivot][col].abs() {
                pivot = row;
            }
        }
        if a[pivot][col].abs() < 1e-9 {
            return None;
        }
        a.swap(col, pivot);
        b.swap(col, pivot);
        for row in col + 1..4 {
            let factor = a[row][col] / a[col][col];
            for k in col..4 {
                a[row][k] -= factor * a[col][k];
            }
            b[row] -= factor * b[col];
        }
    }
    let mut out = [0.0f64; 4];
    for row in (0..4).rev() {
        let mut acc = b[row];
        for k in row + 1..4 {
            acc -= a[row][k] * out[k];
        }
        out[row] = acc / a[row][row];
    }
    out.iter().all(|v| v.is_finite()).then_some(out)
}

fn fit_compute_coeffs(samples: &[(f64, f64, f64)]) -> Option<[f64; 4]> {
    if samples.len() < 4 {
        return None;
    }
    let ctx_scale = samples.iter().map(|s| s.0).fold(1.0f64, f64::max);
    let ub_scale = samples.iter().map(|s| s.1).fold(1.0f64, f64::max);
    let mut ata_n = [[0.0f64; 4]; 4];
    let mut atb_n = [0.0f64; 4];
    for (ctx, ub, y) in samples {
        let row = [
            1.0,
            *ctx / ctx_scale,
            *ub / ub_scale,
            (*ctx / ctx_scale) * (*ub / ub_scale),
        ];
        for i in 0..4 {
            for j in 0..4 {
                ata_n[i][j] += row[i] * row[j];
            }
            atb_n[i] += row[i] * y;
        }
    }
    let mut coeffs = solve_4x4(ata_n, atb_n)?;
    coeffs[1] /= ctx_scale;
    coeffs[2] /= ub_scale;
    coeffs[3] /= ctx_scale * ub_scale;
    Some(coeffs)
}

fn predict_compute(coeffs: &[f64; 4], ctx: f64, ub: f64) -> f64 {
    let value = coeffs[0] + coeffs[1] * ctx + coeffs[2] * ub + coeffs[3] * ctx * ub;
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

fn fit_compute_model(samples: &[ComputeSample]) -> Option<ComputeModel> {
    if samples.len() < 2 {
        return None;
    }
    let cards = samples.iter().map(|s| s.gpu.len()).min()?;
    if cards == 0 {
        return None;
    }
    let fit_points = |points: &[(f64, f64, f64)]| -> Option<ComputeFit> {
        fit_compute_coeffs(points)
            .map(ComputeFit::Plane)
            .or_else(|| fit_ub_only(points).map(ComputeFit::UbOnly))
    };
    let mut gpu = Vec::with_capacity(cards);
    for card in 0..cards {
        let points: Vec<(f64, f64, f64)> = samples
            .iter()
            .map(|s| (s.ctx, s.ubatch, s.gpu[card]))
            .collect();
        gpu.push(fit_points(&points)?);
    }
    let host_points: Vec<(f64, f64, f64)> = samples
        .iter()
        .filter_map(|s| s.host.map(|h| (s.ctx, s.ubatch, h)))
        .collect();
    let host = if host_points.len() == samples.len() {
        fit_points(&host_points)
    } else {
        None
    };
    Some(ComputeModel { gpu, host })
}

fn compute_model_for_family(
    entries: &[&LearnedVramEntry],
) -> Option<ComputeModel> {
    let mut samples: Vec<ComputeSample> = Vec::new();
    for entry in entries {
        if entry.key.ctx == 0 {
            continue;
        }
        let Some(ubatch) = entry.reference_ubatch.filter(|u| *u > 0) else {
            continue;
        };
        let Some(components) = entry.gpu_components_mib.as_ref() else {
            continue;
        };
        samples.push(ComputeSample {
            ctx: entry.key.ctx as f64,
            ubatch: f64::from(ubatch),
            gpu: components.iter().map(|c| c.compute_mib).collect(),
            host: entry.host_components_mib.as_ref().map(|c| c.compute_mib),
        });
        for point in &entry.ub_points {
            if point.ubatch == 0 || point.gpu_compute_mib.is_empty() {
                continue;
            }
            samples.push(ComputeSample {
                ctx: entry.key.ctx as f64,
                ubatch: f64::from(point.ubatch),
                gpu: point.gpu_compute_mib.clone(),
                host: point.host_compute_mib,
            });
        }
    }
    fit_compute_model(&samples)
}

fn apply_ubatch_scaling(
    entry: &mut LearnedVramEntry,
    wanted_ubatch: Option<u32>,
    compute_model: Option<&ComputeModel>,
    global_ub_response: Option<f64>,
) {
    let Some(ub) = wanted_ubatch.filter(|u| *u > 0) else {
        return;
    };
    if Some(ub) == entry.reference_ubatch {
        return;
    }
    if let Some(model) = compute_model {
        if entry.apply_compute_model(entry.key.ctx as f64, f64::from(ub), model) {
            return;
        }
    }
    match global_ub_response {
        Some(response) => entry.scale_compute_by_response(Some(ub), response),
        None => entry.scale_compute_to_ubatch(Some(ub)),
    }
}

fn interpolate_spec_delta(points: &[LearnedSpecDeltaPoint], ctx: usize) -> Option<(f64, f64)> {
    if points.is_empty() {
        return None;
    }
    let at = |p: &LearnedSpecDeltaPoint| (p.vram_mib, p.host_mib.unwrap_or(0.0));
    if ctx <= points[0].ctx {
        return Some(at(&points[0]));
    }
    if ctx >= points[points.len() - 1].ctx {
        return Some(at(&points[points.len() - 1]));
    }
    for pair in points.windows(2) {
        let (left, right) = (&pair[0], &pair[1]);
        if ctx >= left.ctx && ctx <= right.ctx {
            let span = right.ctx.saturating_sub(left.ctx).max(1) as f64;
            let t = (ctx.saturating_sub(left.ctx) as f64) / span;
            let (lv, lh) = at(left);
            let (rv, rh) = at(right);
            return Some((lv + (rv - lv) * t, lh + (rh - lh) * t));
        }
    }
    Some(at(&points[points.len() - 1]))
}

// ── Unified Forecast Bundle IPC ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearnedVramCurvePoint {
    pub ctx: usize,
    pub vram_mib: f64,
    pub host_mib: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kv_mib: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engram_mib: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_model_mib: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearnedForecastBundle {
    pub exact: Option<LearnedVramEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exact_spilled_host_mib: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exact_spilled_at: Option<String>,
    pub curve: Vec<LearnedVramCurvePoint>,
}

fn build_forecast_bundle(
    store: &LearnedVramStore,
    model_path: &str,
    provider_id: &str,
    ctx: &str,
    kv_quant: &str,
    split: &str,
    spec_type: Option<&str>,
    draft_model: Option<&str>,
    vram_topo: Option<&str>,
    ubatch: Option<u32>,
    cpu_moe: Option<&str>,
    model_engram_mib: Option<f64>,
) -> LearnedForecastBundle {
    let path_norm = normalize_model_path_for_key(model_path);
    let kv_n = kv_quant.trim().to_lowercase();
    let split_n = normalize_split_mode(split);
    let regime = ExpertRegime::from_cpu_moe(cpu_moe.unwrap_or(""));
    let wanted_ctx = normalize_ctx_tokens(ctx);
    let spec = spec_type.unwrap_or("none");
    let draft = draft_key_for_learn(spec, draft_model.unwrap_or(""));
    let wanted_spec = spec_key_for_learn(spec, &draft);

    let family_entries: Vec<&LearnedVramEntry> = store
        .entries
        .values()
        .filter(|e| {
            e.key.matches_family(&path_norm, provider_id, &kv_n, &split_n, vram_topo, regime)
        })
        .collect();

    let compute_model = compute_model_for_family(&family_entries);
    let global_ub = measured_ub_response(store);

    let mut spec_by_ctx: BTreeMap<usize, LearnedSpecDeltaPoint> = BTreeMap::new();
    for entry in &family_entries {
        if let Some(point) = entry.spec_deltas.get(&wanted_spec) {
            match spec_by_ctx.get(&point.ctx) {
                Some(existing) if existing.measured_at >= point.measured_at => {}
                _ => {
                    spec_by_ctx.insert(point.ctx, point.clone());
                }
            }
        }
    }
    let spec_points: Vec<LearnedSpecDeltaPoint> = spec_by_ctx.into_values().collect();

    // Deduplicate per ctx by newest measured_at.
    let mut newest_by_ctx: HashMap<usize, &LearnedVramEntry> = HashMap::new();
    for entry in &family_entries {
        match newest_by_ctx.get(&entry.key.ctx) {
            Some(existing) if existing.measured_at >= entry.measured_at => {}
            _ => {
                newest_by_ctx.insert(entry.key.ctx, entry);
            }
        }
    }

    let mut exact: Option<LearnedVramEntry> = None;
    let mut exact_spilled_host_mib: Option<f64> = None;
    let mut exact_spilled_at: Option<String> = None;
    let mut curve: Vec<LearnedVramCurvePoint> = Vec::new();

    for (&entry_ctx, &raw_entry) in &newest_by_ctx {
        let mut entry = raw_entry.clone();
        let spec_mismatch = entry
            .reference_spec_key
            .as_deref()
            .is_some_and(|reference| reference != wanted_spec);

        if spec_mismatch && wanted_spec == "none" {
            continue;
        }

        // Scale ubatch BEFORE spec_delta clears gpu_components_mib.
        apply_ubatch_scaling(&mut entry, ubatch, compute_model.as_ref(), global_ub);

        let mut spec_delta_applied = false;
        if spec_mismatch {
            let base_v = entry.paint_vram_mib();
            let base_h = entry.paint_host_mib();
            let delta = interpolate_spec_delta(&spec_points, entry_ctx)
                .filter(|(vram, _)| spec_delta_is_additive(base_v, *vram));
            if let Some((spec_v, spec_h)) = delta {
                entry.vram_mib = base_v + spec_v;
                entry.host_mib = match (base_h, spec_h) {
                    (Some(base), extra) => Some(base + extra),
                    (None, extra) if extra != 0.0 => Some(extra),
                    (base, _) => base,
                };
                entry.spec_included = Some(true);
                entry.launch_snapshot = None;
                entry.gpu_breakdown_mib = None;
                entry.gpu_components_mib = None;
                entry.host_components_mib = None;
                spec_delta_applied = true;
            } else {
                entry.spec_included = Some(false);
            }
        } else {
            entry.spec_included = Some(wanted_spec != "none");
        }

        entry.vram_mib = entry.paint_vram_mib();
        entry.host_mib = entry.paint_host_mib();
        if let Some(bd) = entry.paint_gpu_breakdown_mib().map(|b| b.to_vec()) {
            entry.gpu_breakdown_mib = Some(bd);
        }

        if let Some(spill_mib) = entry_weight_spill_mib(&entry, model_engram_mib) {
            if entry_ctx == wanted_ctx {
                exact_spilled_host_mib = Some(spill_mib);
                exact_spilled_at = Some(entry.measured_at.clone());
            }
            continue;
        }

        if entry.vram_mib > 0.0 && (!spec_mismatch || spec_delta_applied) {
            curve.push(LearnedVramCurvePoint {
                ctx: entry_ctx,
                vram_mib: entry.vram_mib,
                host_mib: entry.host_mib,
                kv_mib: measured_kv_mib(&entry),
                engram_mib: measured_engram_mib(&entry),
                host_model_mib: entry.host_components_mib.as_ref().map(|c| c.model_mib),
            });
        }

        if entry_ctx == wanted_ctx {
            exact = Some(entry);
        }
    }

    curve.sort_by_key(|p| p.ctx);
    LearnedForecastBundle {
        exact,
        exact_spilled_host_mib,
        exact_spilled_at,
        curve,
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn get_learned_forecast_bundle(
    model_path: String,
    provider_id: String,
    ctx: String,
    kv_quant: String,
    split: String,
    spec_type: Option<String>,
    draft_model: Option<String>,
    vram_topo: Option<String>,
    ubatch: Option<u32>,
    parallel: Option<u32>,
    cpu_moe: Option<String>,
    model_engram_mib: Option<f64>,
) -> LearnedForecastBundle {
    let _ = parallel;
    with_store(|store| {
        build_forecast_bundle(
            store,
            &model_path,
            &provider_id,
            &ctx,
            &kv_quant,
            &split,
            spec_type.as_deref(),
            draft_model.as_deref(),
            vram_topo.as_deref(),
            ubatch,
            cpu_moe.as_deref(),
            model_engram_mib,
        )
    })
    .unwrap_or(LearnedForecastBundle {
        exact: None,
        exact_spilled_host_mib: None,
        exact_spilled_at: None,
        curve: Vec::new(),
    })
}

fn prune_store_curve(
    store: &mut LearnedVramStore,
    model_path: &str,
    provider_id: &str,
    kv_quant: &str,
    split: &str,
    vram_topo: Option<&str>,
    cpu_moe: Option<&str>,
    remove_ctxs: &[u64],
) -> u32 {
    if remove_ctxs.is_empty() {
        return 0;
    }
    let want: HashSet<usize> = remove_ctxs.iter().map(|&c| c as usize).collect();
    let path_norm = normalize_model_path_for_key(model_path);
    let kv_n = kv_quant.trim().to_lowercase();
    let split_n = normalize_split_mode(split);
    let regime = ExpertRegime::from_cpu_moe(cpu_moe.unwrap_or(""));

    let before = store.entries.len();
    store.entries.retain(|_, entry| {
        if !entry.key.matches_family(&path_norm, provider_id, &kv_n, &split_n, vram_topo, regime) {
            return true;
        }
        !want.contains(&entry.key.ctx)
    });
    (before.saturating_sub(store.entries.len())) as u32
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn prune_learned_vram_curve(
    app: tauri::AppHandle,
    model_path: String,
    provider_id: String,
    kv_quant: String,
    spec_type: Option<String>,
    draft_model: Option<String>,
    split: Option<String>,
    vram_topo: Option<String>,
    cpu_moe: Option<String>,
    remove_ctxs: Vec<u64>,
) -> Result<u32, String> {
    use tauri::Emitter;
    let _ = (spec_type.as_deref(), draft_model.as_deref());
    if remove_ctxs.is_empty() {
        return Ok(0);
    }
    let split_n = normalize_split_mode(split.as_deref().unwrap_or("none"));
    let removed = with_store_mut(|store| {
        let n = prune_store_curve(
            store,
            &model_path,
            &provider_id,
            &kv_quant,
            &split_n,
            vram_topo.as_deref(),
            cpu_moe.as_deref(),
            &remove_ctxs,
        );
        Ok((n, n > 0))
    })?;

    if removed > 0 {
        let _ = app.emit(
            "learned-vram-changed",
            serde_json::json!({
                "model_path": model_path,
                "provider_id": provider_id,
            }),
        );
    }
    Ok(removed)
}

// ── Layer-plan & Snapshot views ───────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct LearnedVramForModel {
    pub vram_mib: f64,
    pub host_mib: f64,
    pub entries: u32,
    pub ctx_matched: bool,
    pub kv_mib: f64,
    pub ctx_tokens: Option<usize>,
    pub compute_mib: Vec<f64>,
    pub compute_total_mib: f64,
    pub model_mib: f64,
    pub rs_mib: f64,
    pub fit_changed: Option<bool>,
}

struct CtxPoint {
    ctx: usize,
    kv_mib: f64,
    compute: Vec<f64>,
    host_mib: f64,
    vram_mib: f64,
    model_mib: f64,
    rs_mib: f64,
    fit_changed: Option<bool>,
}

fn extract_ctx_point(entry: &LearnedVramEntry) -> CtxPoint {
    let mut kv_mib = 0.0;
    let mut model_mib = 0.0;
    let mut rs_mib = 0.0;
    let mut compute: Vec<f64> = Vec::new();
    if let Some(snapshot) = entry.launch_snapshot.as_ref() {
        for line in &snapshot.buffers {
            let Some(idx) = cuda_device_index(&line.device) else {
                continue;
            };
            match line.category.as_str() {
                "kv" => kv_mib += line.mib,
                "model" => model_mib += line.mib,
                "rs" | "vision_compute" => rs_mib += line.mib,
                "compute" => {
                    if compute.len() <= idx {
                        compute.resize(idx + 1, 0.0);
                    }
                    compute[idx] += line.mib;
                }
                _ => {}
            }
        }
    }
    CtxPoint {
        ctx: entry.key.ctx,
        kv_mib,
        compute,
        host_mib: entry.host_mib.unwrap_or(0.0),
        vram_mib: entry.vram_mib,
        model_mib,
        rs_mib,
        fit_changed: entry.launch_snapshot.as_ref().and_then(|s| s.fit_changed),
    }
}

fn interpolate_between_ctx(
    entries: &[&LearnedVramEntry],
    want_ctx: usize,
    want_ubatch: Option<u32>,
    want_parallel: u32,
) -> Option<LearnedVramForModel> {
    let mut points: Vec<CtxPoint> = entries
        .iter()
        .filter(|e| {
            e.parallel == want_parallel
                && want_ubatch.map_or(true, |ub| e.reference_ubatch == Some(ub))
        })
        .map(|e| extract_ctx_point(e))
        .collect();
    if points.len() < 2 {
        return None;
    }
    points.sort_by_key(|p| p.ctx);
    let lower = points.iter().rev().find(|p| p.ctx <= want_ctx)?;
    let upper = points.iter().find(|p| p.ctx >= want_ctx)?;
    if lower.ctx == upper.ctx {
        return None;
    }
    let t = (want_ctx.saturating_sub(lower.ctx)) as f64 / (upper.ctx - lower.ctx) as f64;
    let lerp = |a: f64, b: f64| a + (b - a) * t;
    let device_count = lower.compute.len().max(upper.compute.len());
    let mut compute = Vec::with_capacity(device_count);
    for i in 0..device_count {
        let a = lower.compute.get(i).copied().unwrap_or(0.0);
        let b = upper.compute.get(i).copied().unwrap_or(0.0);
        compute.push(lerp(a, b));
    }
    Some(LearnedVramForModel {
        vram_mib: lerp(lower.vram_mib, upper.vram_mib),
        host_mib: lerp(lower.host_mib, upper.host_mib),
        entries: points.len() as u32,
        ctx_matched: false,
        kv_mib: lerp(lower.kv_mib, upper.kv_mib),
        ctx_tokens: Some(want_ctx),
        compute_total_mib: compute.iter().sum(),
        compute_mib: compute,
        model_mib: lower.model_mib,
        rs_mib: lerp(lower.rs_mib, upper.rs_mib),
        fit_changed: match (lower.fit_changed, upper.fit_changed) {
            (None, None) => None,
            (a, b) => Some(a == Some(true) || b == Some(true)),
        },
    })
}

fn learned_vram_for_model_blocking(
    model_path: String,
    ctx: Option<String>,
    kv_quant: Option<String>,
    split: Option<String>,
    ubatch: Option<u32>,
    parallel: Option<u32>,
) -> Option<LearnedVramForModel> {
    let path_norm = normalize_model_path_for_key(&model_path);
    let want_ctx = ctx.as_deref().and_then(ctx_tokens_from_str);
    let want_kv = kv_quant
        .as_deref()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let want_split = split
        .as_deref()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let want_parallel = parallel.unwrap_or(1);

    with_store(|store| {
        let matching: Vec<&LearnedVramEntry> = store
            .entries
            .values()
            .filter(|e| {
                e.key.model_path == path_norm
                    && e.vram_mib > 0.0
                    && e.key.regime == ExpertRegime::Plain
                    && want_kv.as_deref().map_or(true, |kv| e.key.kv_quant == kv)
                    && want_split.as_deref().map_or(true, |sp| e.key.split == sp)
            })
            .collect();

        let count = matching.len() as u32;
        if count == 0 {
            return None;
        }

        if let Some(wc) = want_ctx {
            if let Some(exact) = matching
                .iter()
                .filter(|e| e.key.ctx == wc)
                .max_by(|a, b| a.vram_mib.partial_cmp(&b.vram_mib).unwrap_or(std::cmp::Ordering::Equal))
            {
                let pt = extract_ctx_point(exact);
                return Some(LearnedVramForModel {
                    vram_mib: pt.vram_mib,
                    host_mib: pt.host_mib,
                    entries: count,
                    ctx_matched: true,
                    kv_mib: pt.kv_mib,
                    ctx_tokens: Some(pt.ctx),
                    compute_total_mib: pt.compute.iter().sum(),
                    compute_mib: pt.compute,
                    model_mib: pt.model_mib,
                    rs_mib: pt.rs_mib,
                    fit_changed: pt.fit_changed,
                });
            }
            return interpolate_between_ctx(&matching, wc, ubatch.filter(|u| *u > 0), want_parallel);
        }

        let best = matching
            .iter()
            .max_by(|a, b| a.vram_mib.partial_cmp(&b.vram_mib).unwrap_or(std::cmp::Ordering::Equal))?;
        let pt = extract_ctx_point(best);
        Some(LearnedVramForModel {
            vram_mib: pt.vram_mib,
            host_mib: pt.host_mib,
            entries: count,
            ctx_matched: false,
            kv_mib: pt.kv_mib,
            ctx_tokens: Some(pt.ctx),
            compute_total_mib: pt.compute.iter().sum(),
            compute_mib: pt.compute,
            model_mib: pt.model_mib,
            rs_mib: pt.rs_mib,
            fit_changed: pt.fit_changed,
        })
    })
    .flatten()
}

#[tauri::command]
pub async fn get_learned_vram_for_model(
    model_path: String,
    ctx: Option<String>,
    kv_quant: Option<String>,
    split: Option<String>,
    ubatch: Option<u32>,
    parallel: Option<u32>,
) -> Option<LearnedVramForModel> {
    tokio::task::spawn_blocking(move || {
        learned_vram_for_model_blocking(model_path, ctx, kv_quant, split, ubatch, parallel)
    })
    .await
    .ok()
    .flatten()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearnedRowView {
    pub key: String,
    pub ctx: Option<usize>,
    pub kv: Option<String>,
    pub split: Option<String>,
    pub ubatch: Option<String>,
    pub parallel: u32,
    pub vram_mib: f64,
    pub host_mib: Option<f64>,
    pub measured_at: String,
    pub gpu_breakdown_mib: Option<Vec<f64>>,
    pub components: Option<Vec<GpuComponentMib>>,
}

pub fn snapshot_rows(model_paths: &[String]) -> Vec<LearnedRowView> {
    let wanted: Vec<String> = model_paths
        .iter()
        .map(|path| normalize_model_path_for_key(path))
        .collect();
    with_store(|store| {
        let mut rows: Vec<LearnedRowView> = store
            .entries
            .iter()
            .filter(|(_, entry)| {
                wanted.is_empty() || wanted.iter().any(|p| p == &entry.key.model_path)
            })
            .map(|(key, entry)| LearnedRowView {
                key: key.clone(),
                ctx: Some(entry.key.ctx),
                kv: Some(entry.key.kv_quant.clone()),
                split: Some(entry.key.split.clone()),
                ubatch: entry
                    .reference_ubatch
                    .filter(|u| *u > 0)
                    .map(|u| u.to_string()),
                parallel: entry.parallel,
                vram_mib: entry.paint_vram_mib(),
                host_mib: entry.paint_host_mib(),
                measured_at: entry.measured_at.clone(),
                gpu_breakdown_mib: entry.paint_gpu_breakdown_mib().map(|v| v.to_vec()),
                components: entry.gpu_components_mib.clone(),
            })
            .collect();
        rows.sort_by(|a, b| (a.ctx, a.kv.clone()).cmp(&(b.ctx, b.kv.clone())));
        rows
    })
    .unwrap_or_default()
}

// ── Tests ─────────────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key(ctx: usize, regime: ExpertRegime) -> LearnKey {
        LearnKey {
            model_path: "c:/models/m.gguf".to_string(),
            provider_id: "ggml-master".to_string(),
            ctx,
            kv_quant: "q8_0".to_string(),
            split: "none".to_string(),
            topo: "16".to_string(),
            regime,
        }
    }

    fn make_entry(
        ctx: usize,
        regime: ExpertRegime,
        vram_mib: f64,
        host_mib: f64,
        host_model_mib: f64,
        ubatch: u32,
        compute_mib: f64,
    ) -> LearnedVramEntry {
        let key = test_key(ctx, regime);
        let mut e = LearnedVramEntry::new(key);
        e.vram_mib = vram_mib;
        e.host_mib = Some(host_mib);
        e.reference_ubatch = Some(ubatch);
        e.gpu_components_mib = Some(vec![GpuComponentMib {
            model_mib: (vram_mib - compute_mib).max(0.0),
            ctx_mib: 1024.0,
            compute_mib,
        }]);
        e.host_components_mib = Some(GpuComponentMib {
            model_mib: host_model_mib,
            ctx_mib: 0.0,
            compute_mib: 256.0,
        });
        e.measured_at = "2026-11-22 10:00:00".to_string();
        e
    }

    #[test]
    fn cpu_experts_ignores_cache_mib_and_separates_from_plain() {
        let mut cfg = EngineConfig {
            alias: "a".into(),
            model_path: "C:/models/m.gguf".into(),
            port: 8080,
            backend_type: "ggml-master".into(),
            binary_profile: String::new(),
            extra_params: HashMap::new(),
        };
        cfg.extra_params.insert("cpu_moe".into(), serde_json::json!("on"));
        cfg.extra_params.insert("moe_cache_mib".into(), serde_json::json!(4096));
        let k1 = learn_key_from_config(&cfg.model_path, &cfg.backend_type, &cfg);

        cfg.extra_params.insert("moe_cache_mib".into(), serde_json::json!(16384));
        let k2 = learn_key_from_config(&cfg.model_path, &cfg.backend_type, &cfg);
        assert_eq!(k1, k2);
        assert_eq!(k1.regime, ExpertRegime::CpuExperts);

        cfg.extra_params.insert("cpu_moe".into(), serde_json::json!("off"));
        let k_plain = learn_key_from_config(&cfg.model_path, &cfg.backend_type, &cfg);
        assert_ne!(k1, k_plain);
        assert_eq!(k_plain.regime, ExpertRegime::Plain);
    }

    #[test]
    fn bundle_never_mixes_plain_and_cpu_experts() {
        let mut store = LearnedVramStore {
            schema: STORE_SCHEMA,
            entries: HashMap::new(),
        };
        let plain = make_entry(65536, ExpertRegime::Plain, 40_000.0, 500.0, 0.0, 512, 1000.0);
        let cmoe = make_entry(65536, ExpertRegime::CpuExperts, 4_500.0, 32_000.0, 31_744.0, 512, 800.0);
        store.entries.insert(plain.key.canonical(), plain);
        store.entries.insert(cmoe.key.canonical(), cmoe);

        let b_plain = build_forecast_bundle(
            &store, "c:/models/m.gguf", "ggml-master", "65536", "q8_0", "none", None, None, Some("16"), None, Some("off"), None,
        );
        assert!((b_plain.exact.as_ref().unwrap().vram_mib - 40_000.0).abs() < 0.1);
        assert_eq!(b_plain.curve.len(), 1);

        let b_cmoe = build_forecast_bundle(
            &store, "c:/models/m.gguf", "ggml-master", "65536", "q8_0", "none", None, None, Some("16"), None, Some("on"), None,
        );
        assert!((b_cmoe.exact.as_ref().unwrap().vram_mib - 4_500.0).abs() < 0.1);
        assert_eq!(b_cmoe.curve.len(), 1);
    }

    #[test]
    fn plain_spill_filtered_from_curve_and_reported_while_cmoe_kept() {
        let mut store = LearnedVramStore {
            schema: STORE_SCHEMA,
            entries: HashMap::new(),
        };
        let spilled_plain = make_entry(65536, ExpertRegime::Plain, 12_000.0, 30_000.0, 29_000.0, 512, 800.0);
        let cmoe = make_entry(65536, ExpertRegime::CpuExperts, 4_500.0, 32_000.0, 31_744.0, 512, 800.0);
        store.entries.insert(spilled_plain.key.canonical(), spilled_plain);
        store.entries.insert(cmoe.key.canonical(), cmoe);

        let b_plain = build_forecast_bundle(
            &store, "c:/models/m.gguf", "ggml-master", "65536", "q8_0", "none", None, None, Some("16"), None, Some("off"), None,
        );
        assert!(b_plain.exact.is_none());
        assert!(b_plain.curve.is_empty());
        assert!((b_plain.exact_spilled_host_mib.unwrap() - 29_000.0).abs() < 0.1);

        let b_cmoe = build_forecast_bundle(
            &store, "c:/models/m.gguf", "ggml-master", "65536", "q8_0", "none", None, None, Some("16"), None, Some("on"), None,
        );
        assert!(b_cmoe.exact.is_some());
        assert_eq!(b_cmoe.curve.len(), 1);
        assert!(b_cmoe.exact_spilled_host_mib.is_none());
    }

    #[test]
    fn prune_only_removes_requested_regime() {
        let mut store = LearnedVramStore {
            schema: STORE_SCHEMA,
            entries: HashMap::new(),
        };
        let plain = make_entry(65536, ExpertRegime::Plain, 40_000.0, 500.0, 0.0, 512, 1000.0);
        let cmoe = make_entry(65536, ExpertRegime::CpuExperts, 4_500.0, 32_000.0, 31_744.0, 512, 800.0);
        store.entries.insert(plain.key.canonical(), plain);
        store.entries.insert(cmoe.key.canonical(), cmoe);

        let removed = prune_store_curve(
            &mut store, "c:/models/m.gguf", "ggml-master", "q8_0", "none", Some("16"), Some("on"), &[65536],
        );
        assert_eq!(removed, 1);
        assert_eq!(store.entries.len(), 1);
        assert_eq!(store.entries.values().next().unwrap().key.regime, ExpertRegime::Plain);
    }

    #[test]
    fn rejects_host_pseudo_devices() {
        assert_eq!(cuda_device_index("CUDA0"), Some(0));
        assert_eq!(cuda_device_index("CUDA12"), Some(12));
        assert_eq!(cuda_device_index("CUDA_Host"), None);
        assert_eq!(cuda_device_index("CPU"), None);
        assert_eq!(cuda_device_index("CUDA"), None);
    }

    #[test]
    fn a_draft_only_ledger_is_not_a_spec_delta() {
        let base = 175_940.0;
        assert!(!spec_measurement_is_additive(base, 10_196.0));
        assert!(!spec_delta_is_additive(base, 10_196.0 - base));
        assert!(spec_measurement_is_additive(base, 187_400.0));
        assert!(spec_delta_is_additive(base, 11_460.0));
        assert!(spec_delta_is_additive(base, -100.0));
    }

    #[test]
    fn the_compute_fit_carries_the_ubatch_slope_at_another_ctx() {
        let fit = vec![
            (65_536.0, 512.0, 1121.00),
            (65_536.0, 1024.0, 2097.77),
            (262_144.0, 512.0, 3637.50),
            (262_144.0, 1024.0, 5985.34),
        ];
        let coeffs = fit_compute_coeffs(&fit).expect("four points solve the plane");
        let far = predict_compute(&coeffs, 524_288.0, 512.0);
        assert!((far - 6_981.50).abs() / 6_981.50 < 0.01, "524K@512 predicted {far}");
        let near = predict_compute(&coeffs, 65_536.0, 1024.0);
        assert!((near - 2_097.77).abs() / 2_097.77 < 0.02, "65K@1024 predicted {near}");
    }

    #[test]
    fn bundle_applies_same_ubatch_scaling_to_exact_and_curve() {
        let mut store = LearnedVramStore {
            schema: STORE_SCHEMA,
            entries: HashMap::new(),
        };
        let mut e1 = make_entry(65536, ExpertRegime::Plain, 40_000.0, 500.0, 0.0, 512, 1000.0);
        e1.ub_points.push(LearnedUbPoint {
            ubatch: 1024,
            gpu_compute_mib: vec![1800.0],
            host_compute_mib: Some(400.0),
            measured_at: "2026-11-22 10:01:00".to_string(),
        });
        let e2 = make_entry(131072, ExpertRegime::Plain, 44_000.0, 500.0, 0.0, 512, 1500.0);
        store.entries.insert(e1.key.canonical(), e1);
        store.entries.insert(e2.key.canonical(), e2);

        let b = build_forecast_bundle(
            &store, "c:/models/m.gguf", "ggml-master", "65536", "q8_0", "none", None, None, Some("16"), Some(1024), Some("off"), None,
        );
        let exact_vram = b.exact.as_ref().unwrap().vram_mib;
        let curve_65k = b.curve.iter().find(|p| p.ctx == 65536).unwrap().vram_mib;
        assert!((exact_vram - curve_65k).abs() < 0.01);
        assert!(exact_vram > 40_000.0);
    }

    #[test]
    fn schema_mismatch_discards_stale_store() {
        let mut store = LearnedVramStore {
            schema: 1,
            entries: HashMap::new(),
        };
        let e = make_entry(65536, ExpertRegime::Plain, 40_000.0, 500.0, 0.0, 512, 1000.0);
        store.entries.insert(e.key.canonical(), e);
        let accepted = accept_store(store);
        assert_eq!(accepted.schema, STORE_SCHEMA);
        assert!(accepted.entries.is_empty());
    }
}
