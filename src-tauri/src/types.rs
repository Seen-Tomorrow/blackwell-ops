//! Shared type definitions for engine, config, and template management.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Engine Configuration ───────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineConfig {
    pub alias: String,
    pub model_path: String,
    pub port: u16,
    pub device: String,
    pub kv_quant: String,
    pub ctx_size: String,
    pub batch: i64,
    pub ubatch: i64,
    pub parallel: i64,
    pub offload: String,
    pub offload_mode: String,
    pub split_mode: String,
    pub vision: String,
    pub flash_attn: bool,
    pub jinja: bool,
    pub cont_batching: bool,
    pub metrics: bool,
    pub reasoning: bool,
    pub mmap: bool,
    #[serde(default)]
    pub unified_kv: bool,
    #[serde(default)]
    pub verbose: bool,
    #[serde(default)]
    pub log_timestamps: bool,
    #[serde(default)]
    pub backend_type: String,
    #[serde(default = "default_ffi_provider")]
    pub provider_type: String,
    #[serde(default)]
    pub n_gpu_layers: i32,
    #[serde(default)]
    pub extra_params: HashMap<String, serde_json::Value>,
}

fn default_ffi_provider() -> String { "ggml-stable".to_string() }

// ── Model Catalog Entry ────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelEntry {
    pub path: String,
    pub author: String,
    pub name: String,
    pub quant: String,
    pub size_str: String,
    #[serde(default)]
    pub vision: bool,
    #[serde(default)]
    pub mmproj: Option<String>,
    #[serde(default)]
    pub backend_type: String,
}

/// Internal representation used during catalog scanning (before dedup).
#[derive(Debug, Clone)]
pub struct ModelEntryInternal {
    pub path: String,
    pub author: String,
    pub name: String,
    pub quant: String,
    pub size_str: String,
    pub vision: bool,
    pub mmproj: Option<String>,
    pub model_bytes: u64,
    pub total_bytes: u64,
    pub shards: i32,
}

// ── Stack Entry (for frontend display) ─────────────────────────────────
#[derive(Debug, Clone, Serialize)]
pub struct StackEntry {
    pub idx: usize,
    pub alias: String,
    pub model_name: String,
    pub port: u16,
    pub gpu: String,
    pub status: String,
    #[serde(default)]
    pub slot_id: u32,
    #[serde(default = "default_provider_type")]
    pub provider_type: String,
    #[serde(default)]
    pub model_path: String,
    #[serde(default)]
    pub vram_mib: f64,
    /// Context size in tokens (e.g. 32768 for 32K) — used by FuelTank display
    #[serde(default = "default_ctx_size")]
    pub n_ctx: usize,
    /// Provider display name (e.g. "GGML Stable")
    #[serde(default)]
    pub provider_name: String,
    /// Build info for the running engine's provider (CUDA version, build date)
    #[serde(default)]
    pub build_info: Option<BuildInfo>,
}

fn default_provider_type() -> String { "ggml-stable".to_string() }
fn default_ctx_size() -> usize { 32768 }

// ── Provider Configuration ─────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    pub display_name: String,
    pub binary_path: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub params: serde_json::Value,
    #[serde(default)]
    pub param_definitions: Vec<ParamDef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub _original_id: Option<String>,
    #[serde(default)]
    pub git_url: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub build_profile: String,
    /// Template type determines which genesis_template.json params to use.
    /// "ggml-llama" = ggml-stable/ggml-dev (19 shared params),
    /// "ik-llama" = ik-extreme (7 IK-specific params),
    /// "" = custom (user adds all params manually).
    #[serde(default)]
    pub template_type: String,
    /// Per-environment build info (vanguard/stable/fresh) — captured from binary --version + file mtime.
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "buildInfoPerEnv")]
    pub build_info_per_env: HashMap<String, BuildInfo>,
}

fn default_true() -> bool { true }

/// Build metadata extracted from a compiled binary via --version flag + file mtime.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildInfo {
    /// Version string parsed from binary output (e.g., "3 (f535774)").
    pub version: String,
    /// File modification time of the binary — proxy for build date.
    #[serde(rename = "buildDate")]
    pub build_date: String,
    /// CUDA version detected from binary --version output (e.g., "12.8").
    #[serde(default, rename = "cudaVersion")]
    pub cuda_version: Option<String>,
}

// ── Parameter Definition (template-driven) ─────────────────────────────
/// A single parameter definition for a provider.
///
/// SINGLE SOURCE OF TRUTH: Every param carries both its factory default (from genesis_template.json)
/// and its current runtime value. No cross-referencing templates at render time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamDef {
    pub key: String,
    pub label: String,
    #[serde(rename = "values")]
    pub values: Vec<serde_json::Value>,
    pub order: i32,
    #[serde(default)]
    pub hidden: bool,
    /// Values hidden from the catalog UI (persisted, but still usable).
    #[serde(default, rename = "hiddenValues")]
    pub hidden_values: Vec<serde_json::Value>,
    pub config_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flag: Option<String>,
    pub ptype: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub map_id: Option<String>,
    #[serde(default)]
    pub ui_group: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub pattern: String,
    /// Current default value (what the UI shows as selected by default).
    /// Set from factory_default on first load; changed via admin edits.
    #[serde(default, rename = "defaultValue")]
    pub default_value: serde_json::Value,
    /// Values added by the user at runtime — rendered with yellow styling.
    #[serde(default, rename = "userAddedValues")]
    pub user_added_values: Vec<serde_json::Value>,
    /// Factory (genesis) default — set once on template load, NEVER changed by admin edits.
    /// Used to detect if current default was changed from factory. Reset via CHECK TEMPLATE UPDATE.
    #[serde(default, rename = "factoryDefault")]
    pub factory_default: serde_json::Value,
    /// Per-value extra CLI args (e.g. {"ultra": ["-sas", "1", "-gr", "1"]}).
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "sub_params")]
    pub sub_params: Option<HashMap<String, Vec<String>>>,
}

impl ParamDef {
    /// Returns true if this value is hidden from the catalog UI.
    pub fn is_value_hidden(&self, value: &str) -> bool {
        self.hidden_values.iter().any(|v| v.as_str() == Some(value))
    }

    /// The first non-hidden value — used when the saved default is hidden so launch always has a visible selection.
    pub fn effective_default(&self) -> Option<&serde_json::Value> {
        for v in &self.values {
            if !self.is_value_hidden(v.as_str().unwrap_or("")) {
                return Some(v);
            }
        }
        None
    }
}

