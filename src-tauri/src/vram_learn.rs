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
pub struct LearnedBatchDelta {
    #[serde(default)]
    pub vram_mib: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_mib: Option<f64>,
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
pub struct LearnedVramEntry {
    /// Authoritative GPU total — launch buffer inventory when present, else FIT/exit table.
    pub vram_mib: f64,
    /// Batch/ubatch of the base measurement. Deltas below are relative to this pair.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_batch: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_ubatch: Option<u32>,
    /// Spec/draft identity of the base measurement. Spec deltas are relative to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_spec_key: Option<String>,
    /// Learned VRAM additions for other batch/ubatch pairs (key: "batch|ubatch").
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub batch_deltas: HashMap<String, LearnedBatchDelta>,
    /// Learned spec/draft additions at this ctx (key: spec identity).
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub spec_deltas: HashMap<String, LearnedSpecDeltaPoint>,
    /// Combined batch+spec additions at this ctx (key: "batch|ubatch|spec").
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub joint_deltas: HashMap<String, LearnedSpecDeltaPoint>,
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
    /// Measured (ubatch -> compute) points at this ctx. A ubatch sweep accumulates here instead of
    /// overwriting the row, which is what lets a family learn its own shape from normal use.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ub_points: Vec<LearnedUbPoint>,
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

    /// Re-evaluate this row's compute term for a different ubatch.
    ///
    /// `ubatch` is a measured point, not part of the row's identity: the compute buffers scale
    /// linearly with it (measured 2026-11-08, 27B: 4096 → 8192 doubled CUDA0/CUDA1/host exactly),
    /// so the forecast can answer for any ubatch from one measurement instead of missing the row.
    /// The components are the only place the term is known per device — without them the row is
    /// left exactly as measured rather than scaled by guesswork.
    /// Replace the compute term from the family fit at (ctx, ubatch).
    ///
    /// Used when the request is at a different ubatch than the row was measured at: the fit is
    /// affine in ubatch *and* ctx, which the proportional fallback cannot express.
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
        if let Some(snap) = self.launch_snapshot.as_mut() {
            snap.vram_mib = self.vram_mib;
            if let Some(host) = self.host_mib {
                snap.host_mib = host;
            }
            if let Some(breakdown) = self.gpu_breakdown_mib.as_ref() {
                snap.gpu_breakdown_mib = breakdown.clone();
            }
        }
        true
    }

    /// Scale the compute term by a measured proportional *share* rather than by the raw ubatch
    /// ratio. `share` = the fraction of the term that moves with ubatch (1.0 = fully proportional,
    /// 0.65 = what the MoE families measured). Clamped positive.
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
    }

    /// Record a measured (ubatch -> compute) operating point.
    ///
    /// A row is per ctx, and ubatch is not identity, so a sweep at one ctx would otherwise
    /// overwrite itself and the family could never learn its own ubatch shape — every change
    /// would fall back to the cross-family prior and over/under-predict forever.
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
        // Keep the newest handful: enough for the plane, bounded on disk.
        if self.ub_points.len() > 6 {
            let drop = self.ub_points.len() - 6;
            self.ub_points.drain(0..drop);
        }
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
        let ratio = now as f64 / reference as f64;
        let mut scaled = false;
        if let Some(components) = self.gpu_components_mib.as_mut() {
            for component in components.iter_mut() {
                component.compute_mib *= ratio;
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
            host.compute_mib *= ratio;
            let total = host.model_mib + host.ctx_mib + host.compute_mib;
            if total > 0.0 {
                self.host_mib = Some(total);
            }
            scaled = true;
        }
        if scaled {
            // `paint_*` prefer the snapshot, so the scaled figure has to land there too.
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
    // Atomic, and it creates the parent dir. These are *learned* curves — the
    // measurements only exist because engines have already run, so losing them
    // costs real GPU time to rebuild.
    crate::fs_util::write_json_atomic(&path, store)
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
/// fingerprint or filter LEARNED rows. `draft-mtp` **with** a draft path is an
/// external MTP head: a different launch with a different VRAM footprint, so it
/// must carry its own draft in the identity key.
fn spec_uses_external_draft(spec_type: &str, draft_key: &str) -> bool {
    let s = normalize_spec_type(spec_type);
    if s == "none" {
        return false;
    }
    if s.contains("mtp") && !s.contains("dflash") && !s.contains("dspark") && !s.contains("eagle") {
        return s == "draft-mtp" && !draft_key.trim().is_empty();
    }
    s.contains("dflash") || s.contains("dspark") || s.contains("eagle")
}

fn draft_key_for_learn(spec_type: &str, draft_key: &str) -> String {
    if !spec_uses_external_draft(spec_type, draft_key) {
        return String::new();
    }
    draft_key.trim().to_string()
}

fn optional_launch_suffix(_spec_type: &str, cache_ram: &str, _draft_key: &str) -> String {
    let mut out = String::new();
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
    _memory_mode: &str,
    offload_mode: &str,
    spec_type: &str,
    cache_ram: &str,
    draft_key: &str,
    ubatch: &str,
    parallel: u32,
) -> String {
    let topo = device.trim();
    let topo_seg = if topo.is_empty() {
        String::new()
    } else {
        format!("|topo={topo}")
    };
    // Identity is only what changes the *shape* of the footprint: model, kv quant, topology,
    // split, offload, spec/draft, cache_ram, and the measured ctx.
    //
    // `mode` is a UI mode, `batch` moves no buffer at all, and `ubatch` / `parallel` are
    // measured points rather than identity: they move the compute term, which the forecast
    // scales by `compute(measured) * ub_now / ub_reference` instead of hiding the row.
    // Measured 2026-11-08 on the 27B: ubatch 4096 -> 8192 doubled every compute buffer exactly
    // (CUDA0 2272.6 -> 4545.3, CUDA1 1552.5 -> 3105.0, host 1056.8 -> 2113.5 MiB).
    let _ = (ubatch, parallel);
    format!(
        "|{}|ctx={}|kv={}{}|split={}|offload={}{}",
        provider_id,
        normalize_ctx_key(ctx),
        kv_quant.trim().to_lowercase(),
        topo_seg,
        split.trim().to_lowercase(),
        normalize_offload_mode(offload_mode),
        optional_launch_suffix(spec_type, cache_ram, draft_key),
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

/// Key without the ubatch/parallel knobs (see `learned_vram_key_with_draft_ubatch`).
#[allow(clippy::too_many_arguments)]
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
    learned_vram_key_with_draft_ubatch(
        model_path, provider_id, ctx, kv_quant, device, split, memory_mode, offload_mode,
        spec_type, cache_ram, draft_key, "", 1,
    )
}

pub fn learned_vram_key_with_draft_ubatch(
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
    ubatch: &str,
    parallel: u32,
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
            ubatch,
            parallel,
        ),
    )
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
    draft
}

/// Launch-time fingerprint — survives slot clear on stop (memory breakdown prints at exit).
#[derive(Debug, Clone)]
pub struct VramLearnSnapshot {
    pub learn_key: String,
    pub model_path: String,
    pub provider_id: String,
    /// Launch batch/ubatch — stored as metadata/deltas, never in the cache key.
    pub batch: u32,
    pub ubatch: u32,
    /// Spec/draft identity — stored as metadata/deltas, never in the cache key.
    pub spec_key: String,
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
        batch: config
            .get_param_str("batch")
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0),
        ubatch: config
            .get_param_str("ubatch")
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0),
        spec_key: spec_key_for_learn(
            &config
                .get_param_str("spec_type")
                .unwrap_or_else(|| "none".to_string()),
            &draft_path_from_config(config),
        ),
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
    let ubatch = config.get_param_str("ubatch").unwrap_or_default();
    // The app always sends parallel (1 by default) precisely because llama picks 4 with a
    // unified 4x cache when the flag is absent.
    let parallel = config
        .get_param_str("parallel")
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(1);
    learned_vram_key_with_draft_ubatch(
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
        &ubatch,
        parallel,
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
    // Topology only. A GPU index is a placement, not a memory fact: keying on it makes the
    // same measurement unfindable from a caller that knows only the device name.
    String::new()
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
    ubatch: &str,
    parallel: u32,
) -> Option<LearnedVramEntry> {
    let store = load_store();
    let primary = learned_vram_key_with_draft_ubatch(
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
        ubatch,
        parallel,
    );
    if let Some(entry) = store.entries.get(&primary) {
        return Some(entry.clone());
    }
    // There is ONE key shape. The `dev=` token, pre-draft keys, pre-`|offload=` keys and the
    // `mode=` token all belong to formats that no longer exist: `mode` is not in the key (it is
    // a UI mode), nothing is written without spec/cache_ram/offload, and the token has always
    // been `topo`. Rows in those shapes are simply stale data — the cache is reset, not migrated
    // (no installed base yet). Keep the lookup exact; a guess here once handed a q8 config an
    // f16 row's KV (+5 GB, c8dd2ba26).

    // The cockpit may pass cache_ram=0 while the launch recorded a real value (or the other
    // way round), which is enough to miss an exact row and fall back to FIT. Retry without the
    // launch suffix, then without spec as well.
    for (spec_alt, cache_alt) in [(spec_type, ""), ("none", "")] {
        let key_alt = learned_vram_key_with_draft_ubatch(
            model_path,
            provider_id,
            ctx,
            kv_quant,
            device,
            split,
            memory_mode,
            offload_mode,
            spec_alt,
            cache_alt,
            draft_key,
            ubatch,
            parallel,
        );
        if let Some(entry) = store.entries.get(&key_alt) {
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
    let ub_n = ubatch.trim().parse::<u32>().unwrap_or(0);
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
        // The entry key carries ubatch because it moves the compute graph; a broad match
        // must not hand a 512 row to a 1024 launch.
        if !key_matches_ubatch(k, ub_n) {
            continue;
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
            if !draft_base.is_empty()
                && (!key_has_draft || !k.contains(&format!("|draft={draft_base}")))
            {
                continue;
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
    let ubatch = config.get_param_str("ubatch").unwrap_or_default();
    let parallel = config
        .get_param_str("parallel")
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(1);
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
        &ubatch,
        parallel,
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
            reference_batch: None,
            reference_ubatch: None,
            batch_deltas: HashMap::new(),
            reference_spec_key: None,
            spec_deltas: HashMap::new(),
            joint_deltas: HashMap::new(),
            gpu_breakdown_mib,
            host_mib: None,
            gpu_components_mib: None,
            host_components_mib: None,
            launch_snapshot: None,
            ub_points: Vec::new(),
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

fn batch_pair(batch: u32, ubatch: u32) -> String {
    format!("{batch}|{ubatch}")
}

/// First measurement becomes the reference; returns true when this write is
/// the reference pair (base update), false for a delta write.
/// Whether this launch is a *new base* for the row.
///
/// `ubatch` is no longer identity: it moves the compute term, which the forecast scales from
/// whichever measurement is newest. So a ubatch-only change replaces the base (measured
/// 2026-11-08: ub 1536 → 15,049 MiB total, ub 8192 → 26,829 MiB at the same ctx) instead of
/// being filed as a delta against a stale operating point. `batch` moves no buffer, so it is
/// not compared either; the reference pair is refreshed so the row records what was measured.
fn batch_reference_matches(entry: &mut LearnedVramEntry, batch: u32, ubatch: u32) -> bool {
    entry.reference_batch = Some(batch);
    entry.reference_ubatch = Some(ubatch);
    true
}

fn record_batch_delta(
    entry: &mut LearnedVramEntry,
    batch: u32,
    ubatch: u32,
    vram_mib: f64,
    host_mib: Option<f64>,
) {
    let base_vram = entry.paint_vram_mib();
    let base_host = entry.paint_host_mib().unwrap_or(0.0);
    entry.batch_deltas.insert(
        batch_pair(batch, ubatch),
        LearnedBatchDelta {
            vram_mib: vram_mib - base_vram,
            host_mib: host_mib.map(|h| h - base_host),
            measured_at: timestamp_now(),
        },
    );
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

fn record_spec_delta(
    entry: &mut LearnedVramEntry,
    ctx: usize,
    spec_key: &str,
    vram_mib: f64,
    host_mib: Option<f64>,
) {
    let base_vram = entry.paint_vram_mib();
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

fn joint_delta_key(pair: &str, spec_key: &str) -> String {
    format!("{pair}|{spec_key}")
}

fn record_joint_delta(
    entry: &mut LearnedVramEntry,
    ctx: usize,
    pair: &str,
    spec_key: &str,
    vram_mib: f64,
    host_mib: Option<f64>,
) {
    let base_vram = entry.paint_vram_mib();
    let base_host = entry.paint_host_mib().unwrap_or(0.0);
    entry.joint_deltas.insert(
        joint_delta_key(pair, spec_key),
        LearnedSpecDeltaPoint {
            ctx,
            vram_mib: vram_mib - base_vram,
            host_mib: host_mib.map(|h| h - base_host),
            measured_at: timestamp_now(),
        },
    );
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
    batch: u32,
    ubatch: u32,
    spec_key: &str,
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
        reference_batch: None,
        reference_ubatch: None,
        batch_deltas: HashMap::new(),
        reference_spec_key: None,
        spec_deltas: HashMap::new(),
        joint_deltas: HashMap::new(),
        gpu_breakdown_mib: None,
        host_mib: None,
        gpu_components_mib: None,
        host_components_mib: None,
        launch_snapshot: None,
        ub_points: Vec::new(),
        measured_at: String::new(),
        fit_attempts: Vec::new(),
    });

    // A different batch/ubatch or spec/draft is a delta against the reference
    // curve; never replace the base measurement.
    // llama clamps ubatch to batch, so a launch asking for ubatch > batch actually ran at batch.
    // Recording the requested value would poison the fit with a point that belongs to a lower
    // ubatch (observed: ub 4096 with batch 2048 measured exactly the ub 2048 compute).
    let ubatch = if batch > 0 { ubatch.min(batch) } else { ubatch };
    // Keep the operating point the row is leaving, so a ubatch change teaches the family rather
    // than overwriting what it knew.
    if entry.reference_ubatch.map_or(false, |prev| prev != ubatch) {
        entry.remember_ub_point(entry.reference_ubatch.unwrap_or(0), &entry.measured_at.clone());
    }
    let batch_matches = batch_reference_matches(entry, batch, ubatch);
    let spec_matches = spec_reference_matches(entry, spec_key);
    if !batch_matches || !spec_matches {
        let table = tables.last();
        let mib = table.map(|t| t.total_gpu_self_mib()).unwrap_or(0.0);
        if mib > 0.0 {
            let host = table.and_then(|t| t.host_mib);
            if !batch_matches && !spec_matches {
                record_joint_delta(
                    entry,
                    ctx_from_learn_key(key).unwrap_or(0),
                    &batch_pair(batch, ubatch),
                    spec_key,
                    mib,
                    host,
                );
            } else {
                if !batch_matches {
                    record_batch_delta(entry, batch, ubatch, mib, host);
                }
                if !spec_matches {
                    record_spec_delta(
                        entry,
                        ctx_from_learn_key(key).unwrap_or(0),
                        spec_key,
                        mib,
                        host,
                    );
                }
            }
            save_store(&store)?;
        }
        return Ok(Some((mib, tables.len())));
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
    fn curve_does_not_mix_ubatch_values() {
        let k512 = "C:/m.gguf|ggml-master|ctx=65536|kv=q8_0|topo=96|split=layer|ubatch=512|offload=regular";
        let k1024 = "C:/m.gguf|ggml-master|ctx=65536|kv=q8_0|topo=96|split=layer|ubatch=1024|offload=regular";
        let legacy = "C:/m.gguf|ggml-master|ctx=65536|kv=q8_0|split=layer";
        assert!(key_matches_ubatch(k512, 512));
        assert!(!key_matches_ubatch(k512, 1024));
        assert!(key_matches_ubatch(k1024, 1024));
        assert!(!key_matches_ubatch(k1024, 512));
        // Keys written before the token existed belong to the default row.
        assert!(key_matches_ubatch(legacy, 0));
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

        append_fit_breakdown_tables(key, &tables, 0, "fit", 0, 0, "none").unwrap();
        append_fit_breakdown_tables(key, &tables, 0, "fit", 0, 0, "none").unwrap();

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
                    reference_batch: None,
                    reference_ubatch: None,
                    batch_deltas: HashMap::new(),
                    reference_spec_key: None,
                    spec_deltas: HashMap::new(),
                    joint_deltas: HashMap::new(),
                    gpu_breakdown_mib: Some(vec![85485.0, 83376.0]),
                    host_mib: Some(105086.0),
                    gpu_components_mib: None,
                    host_components_mib: None,
                    launch_snapshot: None,
                    ub_points: Vec::new(),
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
            engram_mib: None,
            mtp_estimate_mib: None,
            mtp_context_mib: None,
            vision_estimate_mib: None,
            vision_mib: None,
            prompt_cache_limit_mib: None,
        fit_projected_mib: None,
        fit_free_device_mib: None,
        fit_changed: None,
        fit_attempts: Vec::new(),
            buffers: vec![],
            phase: "loaded".into(),
            measured_at: "new".into(),
        };
        record_launch_memory_snapshot(key, snap, 0, 0, "none").unwrap();

        let _guard = STORE_MUTEX.lock().unwrap();
        let store = load_store();
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
        append_fit_breakdown_tables(key, &tables, 0, "fit", 0, 0, "none").unwrap();
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
                    reference_batch: None,
                    reference_ubatch: None,
                    batch_deltas: HashMap::new(),
                    reference_spec_key: None,
                    spec_deltas: HashMap::new(),
                    joint_deltas: HashMap::new(),
                    gpu_breakdown_mib: Some(vec![50000.0, 48854.0]),
                    host_mib: Some(800.0),
                    gpu_components_mib: None,
                    host_components_mib: None,
                    launch_snapshot: None,
                    ub_points: Vec::new(),
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
            engram_mib: None,
            mtp_estimate_mib: None,
            mtp_context_mib: None,
            vision_estimate_mib: None,
            vision_mib: None,
            prompt_cache_limit_mib: None,
        fit_projected_mib: None,
        fit_free_device_mib: None,
        fit_changed: None,
        fit_attempts: Vec::new(),
            buffers: vec![],
            phase: "loaded".into(),
            measured_at: "spill".into(),
        };
        record_launch_memory_snapshot(key, snap, 0, 0, "none").unwrap();
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
    batch: u32,
    ubatch: u32,
    spec_key: &str,
) -> Result<(), String> {
    let _guard = STORE_MUTEX
        .lock()
        .map_err(|e| format!("learned-vram store lock poisoned: {e}"))?;
    let mut store = load_store();
    let entry = store.entries.entry(key.to_string()).or_insert_with(|| LearnedVramEntry {
        vram_mib: 0.0,
        reference_batch: None,
        reference_ubatch: None,
        batch_deltas: HashMap::new(),
        reference_spec_key: None,
        spec_deltas: HashMap::new(),
        joint_deltas: HashMap::new(),
        gpu_breakdown_mib: None,
        host_mib: None,
        gpu_components_mib: None,
        host_components_mib: None,
        launch_snapshot: None,
        ub_points: Vec::new(),
        measured_at: String::new(),
        fit_attempts: Vec::new(),
    });

    // A different batch/ubatch pair is a delta against the reference curve;
    // never replace the base measurement.
    // llama clamps ubatch to batch, so a launch asking for ubatch > batch actually ran at batch.
    // Recording the requested value would poison the fit with a point that belongs to a lower
    // ubatch (observed: ub 4096 with batch 2048 measured exactly the ub 2048 compute).
    let ubatch = if batch > 0 { ubatch.min(batch) } else { ubatch };
    // Keep the operating point the row is leaving, so a ubatch change teaches the family rather
    // than overwriting what it knew.
    if entry.reference_ubatch.map_or(false, |prev| prev != ubatch) {
        entry.remember_ub_point(entry.reference_ubatch.unwrap_or(0), &entry.measured_at.clone());
    }
    let batch_matches = batch_reference_matches(entry, batch, ubatch);
    let spec_matches = spec_reference_matches(entry, spec_key);
    if !batch_matches || !spec_matches {
        if !batch_matches && !spec_matches {
            record_joint_delta(
                entry,
                ctx_from_learn_key(key).unwrap_or(0),
                &batch_pair(batch, ubatch),
                spec_key,
                snapshot.vram_mib,
                Some(snapshot.host_mib),
            );
        } else {
            if !batch_matches {
                record_batch_delta(
                    entry,
                    batch,
                    ubatch,
                    snapshot.vram_mib,
                    Some(snapshot.host_mib),
                );
            }
            if !spec_matches {
                record_spec_delta(
                    entry,
                    ctx_from_learn_key(key).unwrap_or(0),
                    spec_key,
                    snapshot.vram_mib,
                    Some(snapshot.host_mib),
                );
            }
        }
        save_store(&store)?;
        drop(_guard);
        return Ok(());
    }

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
#[allow(clippy::too_many_arguments)] // Tauri IPC: one param per wire field; bundling would change the invoke shape
/// Fallback for callers that cannot supply the launch's topology tag.
///
/// The cockpit passes ram_topo (e.g. 2x96), which becomes the key's dev= token; the
/// catalog seats only know a device name, so an otherwise identical config never matched its
/// own measurement and the seat silently showed nothing. This matches every part of the
/// fingerprint EXCEPT dev=, and takes the highest figure when several devices recorded one.
fn lookup_learned_vram_any_device(
    model_path: &str,
    provider_id: &str,
    ctx: &str,
    kv_quant: &str,
    split: &str,
    memory_mode: &str,
    offload_mode: &str,
    cache_ram: &str,
) -> Option<LearnedVramEntry> {
    let store = load_store();
    let prefix = format!("{}|", normalize_model_path_for_key(model_path));
    let want = [
        format!("ctx={}", normalize_ctx_key(ctx)),
        format!("kv={}", kv_quant.trim().to_lowercase()),
        format!("split={}", split.trim().to_lowercase()),
        format!("mode={}", memory_mode.trim().to_lowercase()),
        format!("offload={}", normalize_offload_mode(offload_mode)),
    ];
    let want_provider = provider_id.trim().to_string();
    let ram = cache_ram.trim();
    let want_cache = if ram.is_empty() || ram == "0" {
        None
    } else {
        Some(format!("cache_ram={ram}"))
    };

    let mut best: Option<LearnedVramEntry> = None;
    for (key, entry) in store.entries.iter() {
        let Some(rest) = key.strip_prefix(&prefix) else {
            continue;
        };
        let mut tokens = rest.split('|');
        if tokens.next() != Some(want_provider.as_str()) {
            continue;
        }
        let mut matched = 0usize;
        let mut cache_ok = want_cache.is_none();
        for token in tokens {
            if token.starts_with("dev=") {
                continue;
            }
            if want_cache.as_deref() == Some(token) {
                cache_ok = true;
                continue;
            }
            if token.starts_with("cache_ram=") {
                continue;
            }
            if want.iter().any(|w| w == token) {
                matched += 1;
            }
        }
        if matched != want.len() || !cache_ok {
            continue;
        }
        let better = best
            .as_ref()
            .map(|b| entry.vram_mib > b.vram_mib)
            .unwrap_or(true);
        if better {
            best = Some(entry.clone());
        }
    }
    best
}

/// Every recorded launch for one model, regardless of the knobs it ran with.
///
/// The catalog seats show what a seat ACTUALLY cost the last time it ran; the seat's saved
/// knobs are not trusted to reconstruct the learned key (device token, topology tag, mode and
/// offload all take part in it). This returns the highest recorded figure for the model, which
/// is the number to show when the exact configuration cannot be matched.
#[derive(serde::Serialize)]
pub struct LearnedVramForModel {
    pub vram_mib: f64,
    pub host_mib: f64,
    /// How many configurations were recorded for this model.
    pub entries: u32,
    /// True when the ctx the caller asked for was among them.
    pub ctx_matched: bool,
    /// KV cache the launch actually allocated, summed over devices, MiB.
    pub kv_mib: f64,
    /// Context length of that launch — KV scales linearly from here.
    pub ctx_tokens: Option<usize>,
    /// Compute-graph buffer per device for that launch, MiB, indexed by CUDA index.
    pub compute_mib: Vec<f64>,
    /// Compute buffers summed over devices, MiB. Kept separately because a per-device
    /// array that is short by one card must not silently halve the plan.
    pub compute_total_mib: f64,
    /// Weights the engine actually held on the GPUs, MiB. The GGUF total differs from this
    /// by the tensors it keeps on the host, so a plan that wants to match the launch must
    /// use this when it is known.
    pub model_mib: f64,
    /// Recurrent-state and vision-compute buffers on the GPUs, MiB - small but part of the
    /// inventory the launch reports.
    pub rs_mib: f64,
    /// `Some(false)` = the engine fitted without changing parameters; `Some(true)` = it had to
    /// shrink something to fit. A squeezed run is slower for the same inventory, so it must not
    /// be compared with its neighbours as an equal.
    pub fit_changed: Option<bool>,
}

/// Parse a ctx token from a learned key or a config value: `262144`, `256k`, `256K`.
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

/// Learned VRAM for one model, preferring the configuration the caller asked for.
///
/// The learned key embeds the topology tag, the device mask, the memory mode and the cache
/// size, so a seat cannot reconstruct it from its saved knobs. Rather than going blank - or
/// silently showing the highest figure ever recorded - this scores the recorded entries on the
/// knobs the user actually chooses (ctx, then kv, then split) and reports whether ctx matched.
#[tauri::command]
pub async fn get_learned_vram_for_model(
    model_path: String,
    ctx: Option<String>,
    kv_quant: Option<String>,
    split: Option<String>,
    ubatch: Option<u32>,
    parallel: Option<u32>,
) -> Option<LearnedVramForModel> {
    let ubatch = ubatch.map(|b| b.to_string());
    // Loads the learned store (a few hundred KB) and scans it; off the UI thread.
    tokio::task::spawn_blocking(move || {
        learned_vram_for_model_blocking(model_path, ctx, kv_quant, split, ubatch, parallel)
    })
    .await
    .ok()
    .flatten()
}

#[allow(clippy::needless_return)]
/// Linear interpolation of KV and compute between the two ctx points that bracket want_ctx.
///
/// The forecast's CURVE source interpolates the total between measured points; the plan used
/// the NEAREST point's compute buffers instead, a step function. Between two points that reads
/// as gigabytes of error, and it shrinks as more points are measured - exactly the symptom.
/// KV is already linear in ctx; compute buffers are not, but between two neighbouring
/// measurements a straight line is the best available answer and matches how the curve is
/// drawn.
/// One measured launch of the same shape, reduced to the numbers a plan needs.
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

/// Linear interpolation of KV and compute between the two ctx points that bracket `want_ctx`.
///
/// The forecast's CURVE source interpolates the total between measured points; the plan used
/// the NEAREST point's compute buffers instead, a step function. Between two points that reads
/// as gigabytes of error, and it shrinks as more points are measured - exactly the symptom.
/// KV is linear in ctx; compute buffers are affine in ctx for a fixed shape/batch/split, so a
/// straight line between neighbours is the best available answer.
fn interpolate_between_ctx(
    store: &LearnedVramStore,
    prefix: &str,
    want_ctx: usize,
    want_kv: Option<&str>,
    want_split: Option<&str>,
    want_ubatch: Option<&str>,
    want_parallel: u32,
) -> Option<LearnedVramForModel> {
    let mut points: Vec<CtxPoint> = Vec::new();
    for (key, entry) in store.entries.iter() {
        if !key.starts_with(prefix) || entry.vram_mib <= 0.0 {
            continue;
        }
        let mut ctx_tokens = None;
        let mut kv_token = "";
        let mut split_token = "";
        let mut ubatch_token = "";
        for token in key[prefix.len()..].split('|') {
            if let Some(v) = token.strip_prefix("ctx=") {
                ctx_tokens = ctx_tokens_from_str(v);
            } else if let Some(v) = token.strip_prefix("kv=") {
                kv_token = v;
            } else if let Some(v) = token.strip_prefix("split=") {
                split_token = v;
            } else if let Some(v) = token.strip_prefix("ubatch=") {
                ubatch_token = v;
            }
        }
        let Some(ctx) = ctx_tokens else { continue };
        if let Some(want) = want_kv {
            if kv_token != want {
                continue;
            }
        }
        // Compute buffers differ ~4x between split=none and split=layer at the same ctx;
        // interpolating across those two families would average two different engines.
        if let Some(want) = want_split {
            if split_token != want {
                continue;
            }
        }
        // `parallel` changes the compute buffers (docs/ENGINE-MEMORY-MEASUREMENTS.md), so a
        // curve must not mix slot counts. Only rows with parallel > 1 carry the token.
        if learn_key_parallel(key) != want_parallel {
            continue;
        }
        if let Some(want) = want_ubatch {
            if ubatch_token != want {
                continue;
            }
        }
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
        points.push(CtxPoint {
            ctx,
            kv_mib,
            compute,
            host_mib: entry.host_mib.unwrap_or(0.0),
            vram_mib: entry.vram_mib,
            model_mib,
            rs_mib,
            fit_changed: entry
                .launch_snapshot
                .as_ref()
                .and_then(|snap| snap.fit_changed),
        });
    }
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
        // Weights do not change with ctx: take the lower point rather than averaging sizes.
        model_mib: lower.model_mib,
        rs_mib: lerp(lower.rs_mib, upper.rs_mib),
        fit_changed: match (lower.fit_changed, upper.fit_changed) {
            (None, None) => None,
            (a, b) => Some(a == Some(true) || b == Some(true)),
        },
    })
}
/// Index of a real CUDA device ("CUDA0", "CUDA1"), never the host pseudo-device.
///
/// `CUDA_Host` starts with "CUDA" and carries a large `compute` buffer (9 GB on a 27B at
/// 262K), so a prefix test charged host memory to every GPU total.
fn cuda_device_index(device: &str) -> Option<usize> {
    let rest = device.strip_prefix("CUDA")?;
    if rest.is_empty() || !rest.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    rest.parse().ok()
}

fn learned_vram_for_model_blocking(
    model_path: String,
    ctx: Option<String>,
    kv_quant: Option<String>,
    split: Option<String>,
    ubatch: Option<String>,
    parallel: Option<u32>,
) -> Option<LearnedVramForModel> {
    let _guard = STORE_MUTEX.lock().ok()?;
    let store = load_store();
    let prefix = format!("{}|", normalize_model_path_for_key(&model_path));
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
    let want_ubatch = ubatch
        .as_deref()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty() && s != "0");

    let mut best: Option<(usize, u32, usize, LearnedVramForModel)> = None;
    let mut count = 0u32;
    for (key, entry) in store.entries.iter() {
        if !key.starts_with(&prefix) || entry.vram_mib <= 0.0 {
            continue;
        }
        count += 1;
        let mut score = 0u32;
        let mut ctx_hit = false;
        let mut ctx_distance: usize = usize::MAX;
        let mut entry_ctx: Option<usize> = None;
        let mut kv_mib = 0.0f64;
        let mut model_mib = 0.0f64;
        let mut rs_mib = 0.0f64;
        let mut compute_total = 0.0f64;
        let mut compute_by_device: Vec<f64> = Vec::new();
        if let Some(snapshot) = entry.launch_snapshot.as_ref() {
            for line in &snapshot.buffers {
                let Some(idx) = cuda_device_index(&line.device) else {
                    continue;
                };
                if line.category == "kv" {
                    kv_mib += line.mib;
                } else if line.category == "model" {
                    model_mib += line.mib;
                } else if line.category == "rs" || line.category == "vision_compute" {
                    rs_mib += line.mib;
                } else if line.category == "compute" {
                    compute_total += line.mib;
                    if compute_by_device.len() <= idx {
                        compute_by_device.resize(idx + 1, 0.0);
                    }
                    compute_by_device[idx] += line.mib;
                }
            }
        }
        // Batch, kv quant and split are not preferences: a measurement at another value is a
        // different configuration. Scoring kv at +2 was not enough - with no q8_0 row at that
        // ctx, an f16 row won on ctx+split alone and the plan showed 8,192 MiB of KV for a q8_0
        // config (1.88x the truth).
        let mut entry_kv = "";
        let mut entry_split = "";
        let mut entry_ubatch = "";
        for token in key[prefix.len()..].split('|') {
            if let Some(v) = token.strip_prefix("ubatch=") {
                entry_ubatch = v;
            } else if let Some(v) = token.strip_prefix("ctx=") {
                entry_ctx = ctx_tokens_from_str(v);
                ctx_hit = want_ctx.is_some_and(|w| ctx_tokens_from_str(v) == Some(w));
                if ctx_hit {
                    score += 4;
                }
                if let (Some(w), Some(got)) = (want_ctx, entry_ctx) {
                    ctx_distance = w.abs_diff(got);
                }
            } else if let Some(v) = token.strip_prefix("kv=") {
                entry_kv = v;
                if want_kv.as_deref() == Some(v) {
                    score += 2;
                }
            } else if let Some(v) = token.strip_prefix("split=") {
                entry_split = v;
                if want_split.as_deref() == Some(v) {
                    score += 1;
                }
            }
        }
        // Hard filters: a row measured under different knobs is not a measurement of this one.
        if let Some(want) = want_kv.as_deref() {
            if !entry_kv.eq_ignore_ascii_case(want) {
                continue;
            }
        }
        if let Some(want) = want_split.as_deref() {
            if entry_split.eq_ignore_ascii_case(want) == false {
                continue;
            }
        }
        // `parallel` and `ubatch` are no longer identity: they move the compute term, which the
        // forecast scales from the row's own components. Filtering on them is what made a tuned
        // config look like it had never been measured.
        let _ = (want_parallel, want_ubatch.as_deref(), entry_ubatch);
        let candidate = LearnedVramForModel {
            vram_mib: entry.vram_mib,
            host_mib: entry.host_mib.unwrap_or(0.0),
            entries: count,
            ctx_matched: ctx_hit,
            kv_mib,
            ctx_tokens: entry_ctx,
            compute_total_mib: compute_total,
            compute_mib: compute_by_device,
            model_mib,
            rs_mib,
            fit_changed: entry
                .launch_snapshot
                .as_ref()
                .and_then(|snap| snap.fit_changed),
        };
        // Rank by (ctx bucket, score), then by how close the ctx is, then by size. The old
        // "tie -> highest vram" rule picked a stuffed-GPU spill run (27 GB of compute
        // buffers) for an ordinary 128K plan.
        let bucket = if want_ctx.is_some() {
            if ctx_hit { 0usize } else { 1 }
        } else {
            0
        };
        let better = match &best {
            None => true,
            Some((best_bucket, best_score, best_distance, best_entry)) => {
                (bucket, std::cmp::Reverse(score), ctx_distance)
                    < (*best_bucket, std::cmp::Reverse(*best_score), *best_distance)
                    || (bucket == *best_bucket
                        && score == *best_score
                        && ctx_distance == *best_distance
                        && candidate.vram_mib > best_entry.vram_mib)
            }
        };
        if better {
            best = Some((bucket, score, ctx_distance, candidate));
        }
    }
    // One source per answer. An exact row is returned as-is; otherwise the two bracketing
    // rows are interpolated; otherwise there is no measurement. The old `.or(Some(entry))`
    // mixed an entry measured at another ctx into a result labelled with the requested one -
    // KV from the 256K row with compute from the 64K row.
    match best {
        Some((_, _, _, entry)) if entry.ctx_matched || want_ctx.is_none() => Some(entry),
        _ => want_ctx.and_then(|want| {
            interpolate_between_ctx(
                &store,
                &prefix,
                want,
                want_kv.as_deref(),
                want_split.as_deref(),
                want_ubatch.as_deref(),
                want_parallel,
            )
        }),
    }
}

/// Everything in a learned key except the ctx token — the family a compute fit is shared by.
fn compute_family_key(key: &str) -> String {
    key.split('|')
        .filter(|part| !part.trim_start().starts_with("ctx="))
        .collect::<Vec<_>>()
        .join("|")
}



/// A measured (ubatch -> per-card compute) point remembered on a row, so a later ubatch change can
/// be predicted from this model's own behaviour instead of a cross-family prior.
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

/// One measured compute operating point of a family: (ctx, ubatch) -> per-card compute MiB.
#[derive(Debug, Clone)]
struct ComputeSample {
    ctx: f64,
    ubatch: f64,
    gpu: Vec<f64>,
    host: Option<f64>,
}

/// `compute_i(ctx, ub) = c0 + c1*ctx + c2*ub + c3*ctx*ub`, coefficients per card.
///
/// The measured law is affine in ubatch at a fixed ctx (512 -> 1024 gives ~1.65-1.95x, not 2x)
/// and the ubatch slope itself grows with ctx, so a single proportional factor cannot hold at
/// both ends. Measured on DSV4.1 IQ2_XXS, 40 layers, boundary 22 (2026-11-09):
///   card0 65,536:@512 1,121 / @1024 2,098 | 262,144:@512 3,637 / @1024 5,985
///   card1 65,536:@512 1,892 / @1024 3,688 | 262,144:@512 5,938 / @1024 11,609
#[derive(Debug, Clone)]
struct ComputeModel {
    gpu: Vec<ComputeFit>,
    host: Option<ComputeFit>,
}

/// How a family's compute term is evaluated.
///
/// `Plane` needs samples spread over both ctx and ubatch. A family swept at a single ctx (four
/// ubatch levels, one ctx) cannot identify the plane — the ctx columns collapse — but it *can*
/// identify the affine ubatch law, which is the shape a ubatch change asks for.
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

/// How much of a family's compute term moves proportionally with ubatch — learned from every
/// family that has been measured at two ubatch levels.
///
/// One measured launch is all a user should ever need: this number exists so a *single* point can
/// still answer "what if I raise ubatch", without asking them to run a sweep first. It is the
/// median proportional share across families, so it is the honest middle of what the hardware has
/// shown: dense Qwen3.8-27B doubled exactly (share 1.0), DSV4.1 gave 0.87 at the low end, Flash
/// 0.65 — the median of the measured `(c2-c1) / (c1 * (u2-u1)/u1)` ratios.
///
/// Two points of the *same* family still beat it and take precedence.
fn measured_ub_response(store: &LearnedVramStore) -> Option<f64> {
    use std::collections::BTreeMap;
    let mut families: BTreeMap<String, BTreeMap<usize, Vec<(u32, f64)>>> = BTreeMap::new();
    for (key, entry) in &store.entries {
        let (Some(ctx), Some(ub), Some(components)) = (
            ctx_from_learn_key(key),
            entry.reference_ubatch.filter(|u| *u > 0),
            entry.gpu_components_mib.as_ref(),
        ) else {
            continue;
        };
        let Some(first) = components.first() else { continue };
        families
            .entry(compute_family_key(key))
            .or_default()
            .entry(ctx)
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

/// Least squares `y = c0 + c1*ub`; needs two distinct ubatch levels.
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

/// Least squares over `[1, ctx, ub, ctx*ub]`; needs at least 4 samples with spread on both axes.
fn fit_compute_coeffs(samples: &[(f64, f64, f64)]) -> Option<[f64; 4]> {
    if samples.len() < 4 {
        return None;
    }
    let mut ata = [[0.0f64; 4]; 4];
    let mut atb = [0.0f64; 4];
    for (ctx, ub, y) in samples {
        let row = [1.0, *ctx, *ub, ctx * ub];
        for i in 0..4 {
            for j in 0..4 {
                ata[i][j] += row[i] * row[j];
            }
            atb[i] += row[i] * y;
        }
    }
    // ctx values are ~1e5, so the normal equations are badly scaled: normalise the two
    // dimensions before solving, then fold the scale back into the coefficients.
    let ctx_scale = samples.iter().map(|s| s.0).fold(1.0f64, f64::max);
    let ub_scale = samples.iter().map(|s| s.1).fold(1.0f64, f64::max);
    let mut ata_n = [[0.0f64; 4]; 4];
    let mut atb_n = [0.0f64; 4];
    for (ctx, ub, y) in samples {
        let row = [1.0, *ctx / ctx_scale, *ub / ub_scale, (*ctx / ctx_scale) * (*ub / ub_scale)];
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
    let _ = &mut ata;
    let _ = &mut atb;
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
    // Two points are enough for the affine ubatch fit; the plane needs four (and a spread of ctx).
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

fn compute_model_for(store: &LearnedVramStore, family: &str) -> Option<ComputeModel> {
    let mut samples: Vec<ComputeSample> = Vec::new();
    for (key, entry) in &store.entries {
        if compute_family_key(key) != family {
            continue;
        }
        let Some(ctx) = ctx_from_learn_key(key).filter(|c| *c > 0) else { continue };
        let Some(ubatch) = entry.reference_ubatch.filter(|u| *u > 0) else { continue };
        let Some(components) = entry.gpu_components_mib.as_ref() else { continue };
        samples.push(ComputeSample {
            ctx: ctx as f64,
            ubatch: f64::from(ubatch),
            gpu: components.iter().map(|c| c.compute_mib).collect(),
            host: entry.host_components_mib.as_ref().map(|c| c.compute_mib),
        });
        // Points the row remembered from earlier ubatch changes at this same ctx.
        for point in &entry.ub_points {
            if point.ubatch == 0 || point.gpu_compute_mib.is_empty() {
                continue;
            }
            samples.push(ComputeSample {
                ctx: ctx as f64,
                ubatch: f64::from(point.ubatch),
                gpu: point.gpu_compute_mib.clone(),
                host: point.host_compute_mib,
            });
        }
    }
    fit_compute_model(&samples)
}
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri IPC: one param per wire field; bundling would change the invoke shape
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
    ubatch: Option<u32>,
    parallel: Option<u32>,
    // Forecast only: a row recorded at ANOTHER ctx is not a measurement of this one, and
    // presenting it as such made every ctx look EXACT. Seats keep the any-device fallback
    // (they ask "what did this model cost anywhere"), the forecast never does.
    strict_ctx: Option<bool>,
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
    // Only a topology tag may enter the key; a device index must not (same reason as above).
    let _ = &device;
    let device_token = vram_topo
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("");
    let mut entry = match lookup_learned_vram_fuzzy(
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
        &ubatch.map(|b| b.to_string()).unwrap_or_default(),
        parallel.unwrap_or(1),
    ) {
        Some(entry) => entry,
        None => {
            if strict_ctx.unwrap_or(false) {
                return None;
            }
            lookup_learned_vram_any_device(
                &model_path,
                &provider_id,
                &ctx,
                &kv_quant,
                &split,
                &mode,
                &offload,
                cache,
            )?
        }
    };
    // `batch` is not a memory knob: measured 2026-11-05, batch 512 vs 2048 changed no buffer at
    // all, so it is out of the identity and a different batch is still the same measurement.
    // `ubatch` is part of the key now, so a mismatch there cannot reach this row. What can still
    // differ is the spec/draft identity, when the fuzzy retry matched a boost-off row.
    let wanted_spec = spec_key_for_learn(spec, &draft);
    let path_norm = normalize_model_path_for_key(&model_path);
    let kv_n = kv_quant.trim().to_lowercase();
    let split_n = normalize_split_mode(&split);
    let spec_mismatch = entry
        .reference_spec_key
        .as_deref()
        .map(|reference| reference != wanted_spec)
        .unwrap_or(false);
    if spec_mismatch {
        let base_v = entry.paint_vram_mib();
        let base_h = entry.paint_host_mib();
        let points = {
            let store = load_store();
            find_spec_delta_points(
                &store.entries,
                &path_norm,
                &provider_id,
                &kv_n,
                &split_n,
                vram_topo.as_deref(),
                &wanted_spec,
            )
        };
        let live_ctx = normalize_ctx_key(&ctx).parse::<usize>().ok()?;
        let (spec_v, spec_h) = interpolate_spec_delta(&points, live_ctx)?;
        entry.vram_mib = base_v + spec_v;
        entry.host_mib = match (base_h, spec_h) {
            (Some(base), extra) => Some(base + extra),
            (None, extra) if extra != 0.0 => Some(extra),
            (base, _) => base,
        };
        entry.launch_snapshot = None;
        entry.gpu_breakdown_mib = None;
        entry.gpu_components_mib = None;
        entry.host_components_mib = None;
    }
    // The row is a measurement at one (ctx, ubatch); the caller may be at another ubatch. Prefer
    // the family fit — affine in both, built from every measured point of this model/kv/split/
    // topo/offload/cache family — and fall back to proportional scaling when there are too few
    // points (< 4) to solve it.
    let mut from_model = false;
    let ubatch_changed = ubatch
        .filter(|u| *u > 0)
        .map_or(false, |u| Some(u) != entry.reference_ubatch);
    if ubatch_changed {
        if let (Ok(ctx_now), Some(ub)) = (normalize_ctx_key(&ctx).parse::<f64>(), ubatch) {
            // Compare family-to-family: the stored keys are stripped of their ctx token, so the
            // request side must be stripped the same way (a raw string never matches).
            let family = compute_family_key(&learned_vram_key_with_draft(
                &model_path,
                &provider_id,
                "",
                &kv_quant,
                vram_topo.as_deref().unwrap_or(""),
                &split,
                &mode,
                &offload,
                spec,
                cache,
                &draft,
            ));
            let model = compute_model_for(&load_store(), &family);
            if let Some(model) = model {
                from_model = entry.apply_compute_model(ctx_now, f64::from(ub), &model);
            }
        }
    }
    if !from_model {
        // No two-point fit for this family yet. Use the response measured across every family
        // that has one, so a first launch already answers "what if I raise ubatch" — the user is
        // never asked to sweep to make the forecast work.
        match measured_ub_response(&load_store()) {
            Some(response) => entry.scale_compute_by_response(ubatch, response),
            None => entry.scale_compute_to_ubatch(ubatch),
        }
    }
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
    /// Measured KV (ctx) buffer at this point, MiB. The only slope a lone point can offer:
    /// scaling a single launch to another CTX by its own measured KV beats a header guess.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kv_mib: Option<f64>,
    /// Host-resident lookup table (Engram / PLE) this launch carried, MiB. It is host by
    /// design, so the spill filter must subtract THIS figure, not a GGUF-header guess:
    /// the header read can be missing while the launch snapshot already measured it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engram_mib: Option<f64>,
    /// Host **model** component (weights actually left on the host), MiB.
    ///
    /// The spill filter exists to drop launches that dumped weights into RAM. It used the whole
    /// host figure as the proxy, which is wrong as soon as the host compute buffer is real: a
    /// 8192 ubatch puts ~5.7 GB of graph buffers in host RAM on a fully-GPU model, and every such
    /// point was silently removed from the curve while its exact row still answered lookups.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_model_mib: Option<f64>,
}

/// Measured KV bytes for one launch: per-GPU `ctx` columns, summed.
fn measured_kv_mib(entry: &LearnedVramEntry) -> Option<f64> {
    entry
        .launch_snapshot
        .as_ref()
        .and_then(|s| s.gpu_components_mib.as_ref())
        .or(entry.gpu_components_mib.as_ref())
        .map(|rows| rows.iter().map(|g| g.ctx_mib).sum::<f64>())
        .filter(|mib| *mib > 0.0)
}

/// Host-resident lookup table measured at this launch, MiB.
fn measured_engram_mib(entry: &LearnedVramEntry) -> Option<f64> {
    entry
        .launch_snapshot
        .as_ref()
        .and_then(|s| s.engram_mib)
        .filter(|mib| *mib > 0.0)
}

/// Slot count of a learned key. Rows written for the default carry no token.
fn learn_key_parallel(key: &str) -> u32 {
    key.split('|')
        .find_map(|token| token.strip_prefix("par="))
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(1)
}

/// Ubatch of a learned key. It moves the compute graph (+338/+248 MiB per +512), so a
/// curve must never mix ubatch values even though the entry lookup keys them apart.
fn learn_key_ubatch(key: &str) -> u32 {
    key.split('|')
        .find_map(|token| token.strip_prefix("ubatch="))
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0)
}

fn key_matches_ubatch(key: &str, want: u32) -> bool {
    learn_key_ubatch(key) == want
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
    let rest = key
        .split("|topo=")
        .nth(1)
        .or_else(|| key.split("|dev=").nth(1));
    let Some(rest) = rest else {
        return true;
    };
    let got = rest.split('|').next().unwrap_or("").trim();
    got.eq_ignore_ascii_case(want.trim())
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

/// A batch delta measured at one ctx is a curve-wide addition. Look for it on
/// any entry of the same memory-shape identity, not only the current ctx row.
fn find_batch_delta(
    entries: &HashMap<String, LearnedVramEntry>,
    path_norm: &str,
    provider_id: &str,
    kv_n: &str,
    split_n: &str,
    vram_topo: Option<&str>,
    pair: &str,
) -> Option<LearnedBatchDelta> {
    let mut best: Option<LearnedBatchDelta> = None;
    for (key, entry) in entries {
        if !entry_matches_curve_hard_knobs(key, path_norm, provider_id, kv_n) {
            continue;
        }
        if !key_matches_split(key, split_n) {
            continue;
        }
        if let Some(topo) = vram_topo {
            if !key_matches_vram_topo(key, topo) {
                continue;
            }
        }
        if let Some(delta) = entry.batch_deltas.get(pair) {
            if best
                .as_ref()
                .is_none_or(|current| delta.measured_at > current.measured_at)
            {
                best = Some(delta.clone());
            }
        }
    }
    best
}

fn find_spec_delta_points(
    entries: &HashMap<String, LearnedVramEntry>,
    path_norm: &str,
    provider_id: &str,
    kv_n: &str,
    split_n: &str,
    vram_topo: Option<&str>,
    spec_key: &str,
) -> Vec<LearnedSpecDeltaPoint> {
    let mut by_ctx: std::collections::BTreeMap<usize, LearnedSpecDeltaPoint> =
        std::collections::BTreeMap::new();
    for (key, entry) in entries {
        if !entry_matches_curve_hard_knobs(key, path_norm, provider_id, kv_n) {
            continue;
        }
        if !key_matches_split(key, split_n) {
            continue;
        }
        if let Some(topo) = vram_topo {
            if !key_matches_vram_topo(key, topo) {
                continue;
            }
        }
        if let Some(point) = entry.spec_deltas.get(spec_key) {
            match by_ctx.get(&point.ctx) {
                Some(existing) if existing.measured_at >= point.measured_at => {}
                _ => {
                    by_ctx.insert(point.ctx, point.clone());
                }
            }
        }
    }
    by_ctx.into_values().collect()
}

fn find_joint_delta_points(
    entries: &HashMap<String, LearnedVramEntry>,
    path_norm: &str,
    provider_id: &str,
    kv_n: &str,
    split_n: &str,
    vram_topo: Option<&str>,
    pair: &str,
    spec_key: &str,
) -> Vec<LearnedSpecDeltaPoint> {
    let joint_key = joint_delta_key(pair, spec_key);
    let mut by_ctx: std::collections::BTreeMap<usize, LearnedSpecDeltaPoint> =
        std::collections::BTreeMap::new();
    for (key, entry) in entries {
        if !entry_matches_curve_hard_knobs(key, path_norm, provider_id, kv_n) {
            continue;
        }
        if !key_matches_split(key, split_n) {
            continue;
        }
        if let Some(topo) = vram_topo {
            if !key_matches_vram_topo(key, topo) {
                continue;
            }
        }
        if let Some(point) = entry.joint_deltas.get(&joint_key) {
            match by_ctx.get(&point.ctx) {
                Some(existing) if existing.measured_at >= point.measured_at => {}
                _ => {
                    by_ctx.insert(point.ctx, point.clone());
                }
            }
        }
    }
    by_ctx.into_values().collect()
}

fn interpolate_spec_delta(
    points: &[LearnedSpecDeltaPoint],
    ctx: usize,
) -> Option<(f64, f64)> {
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

/// One learned row, flattened for the NVRAM snapshot (`nvram_snapshot`).
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

fn learn_key_token(key: &str, prefix: &str) -> Option<String> {
    key.split('|').find_map(|token| token.strip_prefix(prefix)).map(str::to_string)
}

/// Rows for the given models, flattened for a snapshot. An empty list means every row.
pub fn snapshot_rows(model_paths: &[String]) -> Vec<LearnedRowView> {
    let _guard = match STORE_MUTEX.lock() {
        Ok(guard) => guard,
        Err(_) => return Vec::new(),
    };
    let store = load_store();
    let wanted: Vec<String> = model_paths
        .iter()
        .map(|path| normalize_model_path_for_key(path))
        .collect();
    let mut rows: Vec<LearnedRowView> = store
        .entries
        .iter()
        .filter(|(key, _)| {
            wanted.is_empty()
                || wanted
                    .iter()
                    .any(|path| key.starts_with(&format!("{path}|")))
        })
        .map(|(key, entry)| LearnedRowView {
            ctx: ctx_from_learn_key(key),
            kv: learn_key_token(key, "kv="),
            split: learn_key_token(key, "split="),
            // ubatch left the key (it is an operating point, not identity) and lives on the row
            // as the reference the components were measured at.
            ubatch: entry
                .reference_ubatch
                .filter(|u| *u > 0)
                .map(|u| u.to_string()),
            parallel: learn_key_parallel(key),
            vram_mib: entry.paint_vram_mib(),
            host_mib: entry.paint_host_mib(),
            measured_at: entry.measured_at.clone(),
            gpu_breakdown_mib: entry.paint_gpu_breakdown_mib().map(|values| values.to_vec()),
            components: entry.gpu_components_mib.clone(),
            key: key.clone(),
        })
        .collect();
    rows.sort_by(|a, b| (a.ctx, a.kv.clone()).cmp(&(b.ctx, b.kv.clone())));
    rows
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
    batch: Option<u32>,
    ubatch: Option<u32>,
    parallel: Option<u32>,
) -> Vec<LearnedVramCurvePoint> {
    let Some(_guard) = STORE_MUTEX.lock().ok() else {
        return Vec::new();
    };
    let store = load_store();
    let path_norm = normalize_model_path_for_key(&model_path);
    let kv_n = kv_quant.trim().to_lowercase();
    let wanted_spec = spec_key_for_learn(
        spec_type.as_deref().unwrap_or("none"),
        draft_model.as_deref().unwrap_or(""),
    );
    let split_n = normalize_split_mode(split.as_deref().unwrap_or("none"));
    let wanted_batch = batch.unwrap_or(0);
    let wanted_ubatch = ubatch.unwrap_or(0);
    let wanted_parallel = parallel.unwrap_or(1);
    let wanted_pair = batch_pair(wanted_batch, wanted_ubatch);
    let global_delta = find_batch_delta(
        &store.entries,
        &path_norm,
        &provider_id,
        &kv_n,
        &split_n,
        vram_topo.as_deref(),
        &wanted_pair,
    );
    let spec_points = find_spec_delta_points(
        &store.entries,
        &path_norm,
        &provider_id,
        &kv_n,
        &split_n,
        vram_topo.as_deref(),
        &wanted_spec,
    );
    let joint_points = find_joint_delta_points(
        &store.entries,
        &path_norm,
        &provider_id,
        &kv_n,
        &split_n,
        vram_topo.as_deref(),
        &wanted_pair,
        &wanted_spec,
    );
    let mut best: std::collections::HashMap<usize, (String, LearnedVramCurvePoint)> =
        std::collections::HashMap::new();
    for (k, entry) in &store.entries {
        if !entry_matches_curve_hard_knobs(k, &path_norm, &provider_id, &kv_n) {
            continue;
        }
        if !key_matches_split(k, &split_n) {
            continue;
        }
        // One curve, any ubatch/parallel: both move the compute term only, and the point is
        // scaled from its own components below.
        let _ = (wanted_parallel, wanted_ubatch);
        if let Some(topo) = vram_topo.as_deref() {
            if !key_matches_vram_topo(k, topo) {
                continue;
            }
        }
        let Some(ctx) = ctx_from_learn_key(k) else {
            continue;
        };
        let mut delta_v = 0.0;
        let mut delta_h = 0.0;
        let batch_mismatch = entry
            .reference_batch
            .zip(entry.reference_ubatch)
            .map(|(rb, ru)| rb != wanted_batch || ru != wanted_ubatch)
            .unwrap_or(false);
        let spec_mismatch = entry
            .reference_spec_key
            .as_deref()
            .map(|reference| reference != wanted_spec)
            .unwrap_or(false);
        let joint_applied = if batch_mismatch && spec_mismatch {
            if let Some((joint_v, joint_h)) = interpolate_spec_delta(&joint_points, ctx) {
                delta_v += joint_v;
                delta_h += joint_h;
                true
            } else {
                false
            }
        } else {
            false
        };
        if !joint_applied {
            if batch_mismatch {
                // A batch difference is not a memory difference (measured 2026-11-05: batch 512
                // vs 2048 changed no buffer), so a missing delta must not drop the point.
                if let Some(delta) = entry
                    .batch_deltas
                    .get(&wanted_pair)
                    .or(global_delta.as_ref())
                {
                    delta_v += delta.vram_mib;
                    delta_h += delta.host_mib.unwrap_or(0.0);
                }
            }
            if spec_mismatch {
                let Some((spec_v, spec_h)) = interpolate_spec_delta(&spec_points, ctx) else {
                    continue;
                };
                delta_v += spec_v;
                delta_h += spec_h;
            }
        }
        // Each point is scaled from its own components: a curve mixes ubatches as soon as the
        // knob moves, and a point measured at another ubatch is still a measurement of this ctx.
        let mut scaled = entry.clone();
        scaled.scale_compute_to_ubatch(Some(wanted_ubatch));
        let vram = scaled.paint_vram_mib() + delta_v;
        if vram <= 0.0 {
            continue;
        }
        let host_mib = match scaled.paint_host_mib() {
            Some(base) => Some(base + delta_h),
            None if delta_h > 0.0 => Some(delta_h),
            None => None,
        };
        let point = LearnedVramCurvePoint {
            ctx,
            vram_mib: vram,
            host_mib,
            kv_mib: measured_kv_mib(entry),
            engram_mib: measured_engram_mib(entry),
            host_model_mib: scaled
                .host_components_mib
                .as_ref()
                .map(|component| component.model_mib),
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
    let _ = (spec_type.as_deref(), draft_model.as_deref());
    let split_n = normalize_split_mode(split.as_deref().unwrap_or("none"));

    let before = store.entries.len();
    store.entries.retain(|k, _| {
        if !entry_matches_curve_hard_knobs(k, &path_norm, &provider_id, &kv_n) {
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
#[cfg(test)]
mod cuda_device_tests {
    use super::cuda_device_index;

    #[test]
    fn rejects_host_pseudo_devices() {
        assert_eq!(cuda_device_index("CUDA0"), Some(0));
        assert_eq!(cuda_device_index("CUDA12"), Some(12));
        assert_eq!(cuda_device_index("CUDA_Host"), None);
        assert_eq!(cuda_device_index("CPU"), None);
        assert_eq!(cuda_device_index("CUDA"), None);
    }
}

#[cfg(test)]
mod compute_model_tests {
    use super::*;

    /// Measured DSV4.1 IQ2_XXS points (2026-11-09): compute MiB on card 0 / card 1.
    /// Fit on the 65,536 and 262,144 rows of both ubatch sets, then predict held-out launches.
    #[test]
    fn the_compute_fit_carries_the_ubatch_slope_at_another_ctx() {
        let fit = vec![
            (65_536.0, 512.0, 1121.00),
            (65_536.0, 1024.0, 2097.77),
            (262_144.0, 512.0, 3637.50),
            (262_144.0, 1024.0, 5985.34),
        ];
        let coeffs = fit_compute_coeffs(&fit).expect("four points solve the plane");
        // Held out: 524,288 @ ub 512 measured 6,981.50.
        let far = predict_compute(&coeffs, 524_288.0, 512.0);
        assert!((far - 6_981.50).abs() / 6_981.50 < 0.01, "524K@512 predicted {far}");
        // Proportional scaling from the 65,536 row would say 2 x 1,121 = 2,242 at ub 1024;
        // the measured value is 2,097.77 - the affine term, which the fit keeps.
        let near = predict_compute(&coeffs, 65_536.0, 1024.0);
        assert!((near - 2_097.77).abs() / 2_097.77 < 0.02, "65K@1024 predicted {near}");
    }

    /// Third run (2026-11-09 12:27): 65,536 @ ub 2048 with batch 4096 measured 4,111.6 / 7,328.2.
    /// Compute is convex in ubatch (increments 977 then 2,014 on card0), which invites a `ub^2`
    /// term — but with only three ubatch levels the highest one *is* the curvature, so holding it
    /// out makes a quadratic term extrapolate wildly (predicts 5,699 and 1,768). The affine model
    /// predicts it at +3.1% / -0.3%, so the quadratic term stays out until a fourth ubatch level
    /// pins it.
    #[test]
    fn the_fit_holds_a_third_ubatch_level_it_never_saw() {
        let fit = vec![
            (65_536.0, 512.0, 1121.00),
            (65_536.0, 1024.0, 2097.77),
            (131_072.0, 1024.0, 3542.59),
            (262_144.0, 512.0, 3637.50),
            (262_144.0, 1024.0, 5985.34),
            (409_600.0, 512.0, 5518.50),
            (524_288.0, 512.0, 6981.50),
        ];
        let coeffs = fit_compute_coeffs(&fit).expect("seven points");
        let predicted = predict_compute(&coeffs, 65_536.0, 2048.0);
        assert!(
            (predicted - 4_111.60).abs() / 4_111.60 < 0.05,
            "65K@ub2048 predicted {predicted}, measured 4,111.6"
        );
    }

    /// Qwen3.8-Flash-Next (MoE, Q2_0) swept at one ctx (65,536) over four ubatch levels
    /// (2026-11-09 12:36): compute 555.9/618.0, 916.5/1053.7, 1637.9/1925.0, 2856.5/3443.6.
    ///
    /// Its compute is SUB-proportional: ub 4096 costs 5.1x the ub 512 value, not 8x, so a
    /// proportional factor over-predicts by +56 % at the top. One ctx cannot identify the plane,
    /// so this family must fall through to the affine ubatch fit.
    #[test]
    fn a_single_ctx_sweep_falls_back_to_the_affine_ubatch_fit() {
        let points = vec![
            (65_536.0, 512.0, 555.9),
            (65_536.0, 1024.0, 916.5),
            (65_536.0, 2048.0, 1637.9),
            (65_536.0, 4096.0, 2856.5),
        ];
        assert!(
            fit_compute_coeffs(&points).is_none(),
            "one ctx must be rank-deficient for the plane"
        );
        let coeffs = fit_ub_only(&points).expect("affine ubatch fit survives");
        let at_4096 = coeffs[0] + coeffs[1] * 4096.0;
        assert!(
            (at_4096 - 2856.5).abs() / 2856.5 < 0.05,
            "ub 4096 predicted {at_4096}, measured 2856.5"
        );
        // The proportional guess the old code would have made, for contrast.
        let proportional = 555.9 * 8.0;
        assert!(proportional > 4_000.0 && at_4096 < proportional);
    }

    /// A user with one measured launch must still get a sane answer to "what if I raise ubatch".
    /// With the measured share (0.65-0.87 across the MoE families) the answer lands within a few
    /// percent; the old raw ratio would have said 8x for a 8x ubatch rise.
    #[test]
    fn a_single_measured_point_scales_compute_by_the_measured_share() {
        let mut entry = LearnedVramEntry {
            vram_mib: 0.0,
            reference_batch: Some(2048),
            reference_ubatch: Some(512),
            reference_spec_key: None,
            batch_deltas: std::collections::HashMap::new(),
            spec_deltas: std::collections::HashMap::new(),
            joint_deltas: std::collections::HashMap::new(),
            gpu_breakdown_mib: None,
            host_mib: None,
            gpu_components_mib: Some(vec![GpuComponentMib {
                model_mib: 30_000.0,
                ctx_mib: 5_000.0,
                compute_mib: 555.9,
            }]),
            host_components_mib: None,
            launch_snapshot: None,
            ub_points: Vec::new(),
            fit_attempts: Vec::new(),
            measured_at: String::new(),
        };
        // Flash measured 2,856.5 at ub 4096 from 555.9 at ub 512: share ~0.65.
        entry.scale_compute_by_response(Some(4096), 0.65);
        let compute = entry.gpu_components_mib.as_ref().unwrap()[0].compute_mib;
        let expected = 555.9 * (1.0 + 0.65 * (4096.0 / 512.0 - 1.0));
        assert!((compute - expected).abs() < 0.5, "compute {compute} vs {expected}");
        // Far from the proportional guess (4,447) and near the measurement (2,857).
        assert!(compute < 3_200.0 && compute > 2_500.0);
    }

    #[test]
    fn a_family_needs_four_points_before_it_is_used() {
        let three = vec![
            (65_536.0, 512.0, 1121.00),
            (65_536.0, 1024.0, 2097.77),
            (262_144.0, 512.0, 3637.50),
        ];
        assert!(fit_compute_coeffs(&three).is_none());
    }

    #[test]
    fn the_family_key_drops_only_the_ctx_token() {
        let key = "m.gguf|ggml-master|ctx=262144|kv=q8_0|topo=96|split=layer|offload=regular|cache_ram=16384";
        assert_eq!(
            compute_family_key(key),
            "m.gguf|ggml-master|kv=q8_0|topo=96|split=layer|offload=regular|cache_ram=16384"
        );
    }
}