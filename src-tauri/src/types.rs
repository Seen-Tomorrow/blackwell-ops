//! Shared type definitions for engine, config, and template management.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Engine Configuration ───────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineConfig {
    pub alias: String,
    pub model_path: String,
    pub port: u16,
    #[serde(default)]
    pub backend_type: String,
    #[serde(default, rename = "binary_profile")]
    pub binary_profile: String,
    #[serde(default)]
    pub extra_params: HashMap<String, serde_json::Value>,
}

impl EngineConfig {
    /// Extract parallel from extra_params, default 1.
    pub fn get_parallel(&self) -> i64 {
        self.get_param_str("parallel")
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(1)
    }

    /// Extract unified_kv from extra_params, default false.
    pub fn get_unified_kv(&self) -> bool {
        self.get_param_str("unified_kv")
            .map(|v| v.to_lowercase() != "off" && v.to_lowercase() != "false")
            .unwrap_or(false)
    }

    /// Get a string value from extra_params by key (case-insensitive).
    pub fn get_param_str(&self, key: &str) -> Option<String> {
        let key_lower = key.to_lowercase();
        for (k, v) in &self.extra_params {
            if k.to_lowercase() == key_lower {
                return Some(v.as_str().map(|s| s.to_string()).unwrap_or(v.to_string()));
            }
        }
        None
    }
}

/// CLI flags injected into short-lived diagnostic spawns (fit scanner, GGUF scan).
/// NOT applied to long-running engine servers — those should stay quiet under load.
pub const LLAMA_DIAGNOSTIC_FLAGS: &[&str] = &["-lv", "4"];

/// HF API metadata persisted at download time — never changes, survives API outages.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HfMetadata {
    /// Canonical HF model ID (e.g., "bartowski/Llama-3.1-8B-IQ1_MS")
    #[serde(rename = "hfModelId")]
    pub hf_model_id: String,
    /// Author from HF (e.g., "bartowski")
    pub author: String,
    /// Model repo name (derived from ID, e.g., "Llama-3.1-8B-IQ1_MS")
    #[serde(rename = "repoName")]
    pub repo_name: String,
    /// HF tags (e.g., ["gguf", "llama"])
    #[serde(default)]
    pub tags: Vec<String>,
    /// Download count at time of download
    #[serde(default)]
    pub downloads: u64,
    /// Likes count at time of download
    #[serde(default, rename = "likesCount")]
    pub likes_count: u64,
    /// Quant type from HF (e.g., "Q4_K_M") — more reliable than filename parsing
    #[serde(rename = "quantType")]
    pub quant_type: String,
    /// File size in bytes from HF tree endpoint
    #[serde(rename = "fileSizeBytes")]
    pub file_size_bytes: u64,
    /// Last modified date on HF at time of download
    #[serde(default, rename = "lastModified")]
    pub last_modified: String,
    /// LFS OID
    #[serde(default, rename = "lfsOid")]
    pub lfs_oid: String,
}

/// Result of checking an HF GGUF file against local disk.
#[derive(Debug, Clone, Serialize)]
pub struct DiskCheckResult {
    /// Quant type (e.g. "Q4_K_M")
    #[serde(rename = "quantType")]
    pub quant_type: String,
    /// How the file matched on disk: "lfs" = exact LFS OID match, "size" = file size match, "mismatch" = same quant different size, "none" = not present
    #[serde(rename = "matchType")]
    pub match_type: String,
    /// File size on disk if a local file was found (for mismatch display)
    #[serde(rename = "diskFileSize", skip_serializing_if = "Option::is_none")]
    pub disk_file_size: Option<u64>,
    /// Author of the disk file (for mismatch confirmation modal)
    #[serde(rename = "diskAuthor", skip_serializing_if = "Option::is_none")]
    pub disk_author: Option<String>,
}

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
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "mmproj_size_mib")]
    pub mmproj_size_mib: Option<f64>,
    #[serde(default)]
    pub backend_type: String,
    #[serde(default, rename = "sourcePathLabel")]
    pub source_path_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<ModelMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "hfMeta")]
    pub hf_meta: Option<HfMetadata>,
    /// Discovered HF repo ID from directory structure or cache (e.g. "unsloth/Qwen3.5-4B-GGUF"). Present even when hf_meta is None.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "hfModelId")]
    pub hf_model_id: Option<String>,
}

/// Duplicate model found across multiple configured paths during catalog merge.
#[derive(Debug, Clone, Serialize)]
pub struct CatalogDedupConflict {
    /// Dedup key (author|name|quant).
    #[serde(rename = "dedupKey")]
    pub dedup_key: String,
    /// First occurrence of this model.
    #[serde(rename = "entryA")]
    pub entry_a: ModelEntryInternal,
    /// Second occurrence of this model.
    #[serde(rename = "entryB")]
    pub entry_b: ModelEntryInternal,
}

/// Base model info extracted from GGUF general.base_model.N.* KVs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaseModelInfo {
    /// Model name (e.g., "Qwen3.5 4B")
    pub name: String,
    /// Organization that created the base model (e.g., "Qwen")
    #[serde(rename = "organization")]
    pub organization: String,
    /// HF repo URL of the base model
    #[serde(rename = "repo_url")]
    pub repo_url: String,
}

/// Parsed GGUF model metadata from llama-server header output.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelMetadata {
    /// Architecture name (e.g., "minimax-m2", "llama", "qwen2")
    pub architecture: String,
    /// Model type label from print_info (e.g., "230B.A10B")
    #[serde(default, rename = "modelTypeLabel")]
    pub model_type_label: String,
    /// Number of transformer layers (block_count)
    pub n_layer: u32,
    /// Trained context length in tokens
    #[serde(rename = "n_ctx_train")]
    pub n_ctx_train: u32,
    /// Embedding dimension
    pub n_embd: u32,
    /// Attention head count
    pub n_head: u32,
    /// KV head count (GQA-aware)
    #[serde(rename = "n_head_kv")]
    pub n_head_kv: u32,
    /// Expert count (0 if not MoE)
    #[serde(default)]
    pub n_expert: u32,
    /// Active experts per token (0 if not MoE)
    #[serde(default, rename = "n_expert_used")]
    pub n_expert_used: u32,
    /// Rope frequency base
    #[serde(default, rename = "rope_freq_base")]
    pub rope_freq_base: f32,
    /// Rope dimension count (0 = full head dim)
    #[serde(default)]
    pub rope_dim: u32,
    /// FFN intermediate dimension (feed_forward_length) — 0 if not captured
    #[serde(default, rename = "feed_forward_length")]
    pub feed_forward_length: u32,
    /// MoE expert FFN intermediate dimension — 0 if not MoE or not captured
    #[serde(default, rename = "expert_feed_forward_length")]
    pub expert_feed_forward_length: u32,
    /// File type string (e.g., "Q4_K - Medium")
    #[serde(rename = "file_type_str")]
    pub file_type_str: String,
    /// Bits-per-weight from file size line
    #[serde(default)]
    pub bpw: f32,
    /// Tensor type counts (e.g., {"f32": 373, "q4_K": 375})
    #[serde(default, rename = "tensor_counts")]
    pub tensor_counts: HashMap<String, u32>,
    /// Total parameter count string from print_info (e.g., "228.69 B")
    #[serde(default, rename = "total_params_str")]
    pub total_params_str: String,
    /// Vocabulary size
    #[serde(default)]
    pub vocab_size: u32,
    /// Human-readable name from GGUF general.name KV
    #[serde(default, rename = "general_name")]
    pub general_name: String,
    /// Rope scaling type: "yarn", "linear", "none"
    #[serde(default, rename = "rope_scaling_type")]
    pub rope_scaling_type: String,
    /// Tokenizer model from tokenizer.ggml.model (e.g., "gpt2", "llama")
    #[serde(default, rename = "tokenizer_model")]
    pub tokenizer_model: String,
    /// Exact file size on disk in bytes
    #[serde(rename = "file_size_bytes")]
    pub file_size_bytes: u64,
    /// Unix timestamp of when this metadata was scanned
    #[serde(rename = "scan_timestamp")]
    pub scan_timestamp: u64,
    /// Windows file creation time (Unix timestamp) — used for "date added" sorting
    #[serde(default, rename = "file_created")]
    pub file_created: u64,
    /// Number of nextn prediction layers (>0 means MTP model)
    #[serde(default, rename = "nextn_predict_layers")]
    pub nextn_predict_layers: u32,

    // ── Raw KV dumps (full GGUF header for future use) ────────────────
    /// All KV pairs from GGUF header — key → stringified value. Skips tokenizer arrays.
    #[serde(default, rename = "rawKvs")]
    pub raw_kvs: HashMap<String, String>,
    /// All print_info lines — key → value string.
    #[serde(default, rename = "rawPrintInfo")]
    pub raw_print_info: HashMap<String, String>,

    // ── GGUF general.* convenience fields (extracted from raw) ─────────
    /// Author from general.author KV (if quantizer set it)
    #[serde(default)]
    pub general_author: String,
    /// HF repo URL from general.repo_url — parse author/repo from this
    #[serde(default, rename = "general_repo_url")]
    pub general_repo_url: String,
    /// Canonical base name from general.basename (e.g., "Qwen3.5-4B")
    #[serde(default, rename = "general_basename")]
    pub general_basename: String,
    /// Who quantized/published — PRIMARY author for UI display ("Unsloth", "bartowski")
    #[serde(default, rename = "general_quantized_by")]
    pub general_quantized_by: String,
    /// License from general.license (e.g., "apache-2.0")
    #[serde(default)]
    pub general_license: String,
    /// Tags array from general.tags (e.g., ["unsloth", "image-text-to-text"])
    #[serde(default)]
    pub general_tags: Vec<String>,
    /// Base model info — captures ALL base models from general.base_model.N.*
    #[serde(default, rename = "base_models")]
    pub base_models: Vec<BaseModelInfo>,
    /// Chat template from tokenizer.chat_template (~1-3KB Jinja2 string)
    #[serde(default, rename = "chat_template")]
    pub chat_template: String,
}

/// Internal representation used during catalog scanning (before dedup).
#[derive(Debug, Clone, Serialize)]
pub struct ModelEntryInternal {
    pub path: String,
    pub author: String,
    pub name: String,
    pub quant: String,
    pub size_str: String,
    pub vision: bool,
    pub mmproj: Option<String>,
    /// MMProj file size in MiB (for vision model VRAM calculation)
    pub mmproj_size_mib: f64,
    pub model_bytes: u64,
    pub total_bytes: u64,
    pub shards: i32,
    /// Configured path label this entry came from (e.g. ".lmstudio", "Default").
    pub source_path_label: String,
    /// Discovered HF repo ID from directory structure (e.g. "unsloth/Qwen3.5-4B-GGUF")
    pub hf_model_id: Option<String>,
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
    /// Runtime profile env (vanguard/frontier/fresh/stable) the engine was launched with.
    #[serde(default, rename = "binaryProfile")]
    pub binary_profile: String,
    #[serde(default)]
    pub model_path: String,
    #[serde(default)]
    pub vram_mib: f64,
    /// Per-GPU SELF MiB from live memory breakdown (CUDA0, CUDA1, …).
    #[serde(default, rename = "gpu_breakdown_mib")]
    pub gpu_breakdown_mib: Option<Vec<f64>>,
    /// Context size in tokens (e.g. 32768 for 32K) — used by FuelTank display
    #[serde(default = "default_ctx_size")]
    pub n_ctx: usize,
    /// Provider display name (e.g. "GGML Stable")
    #[serde(default)]
    pub provider_name: String,
    /// Build info for the running engine's provider (CUDA version, build date)
    #[serde(default)]
    pub build_info: Option<BuildInfo>,
    /// Whether live Fusion monitoring is enabled for this provider.
    #[serde(default = "default_true", rename = "supportsFusion")]
    pub supports_fusion: bool,
    /// Multi-GPU split at launch (`none` / `layer` / `row` / `tensor`).
    #[serde(default, rename = "splitMode")]
    pub split_mode: String,
}

#[allow(dead_code)]
pub fn default_provider_type() -> String { crate::config::DEFAULT_PROVIDER_ID.to_string() }
#[allow(dead_code)]
pub fn default_ctx_size() -> usize { 32768 }

// ── Provider Configuration ─────────────────────────────────────────────

/// Engine config column / pin layout — factory defaults + per-user overrides.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LayoutDefaults {
    #[serde(default, rename = "configColumnCount")]
    pub config_column_count: u8,
    #[serde(default, rename = "configColumnWidths")]
    pub config_column_widths: Vec<f64>,
    #[serde(default, rename = "groupDisplayZone")]
    pub group_display_zone: HashMap<String, String>,
    #[serde(default, rename = "groupColumn")]
    pub group_column: HashMap<String, u32>,
    #[serde(default, rename = "aboveColumnWidths")]
    pub above_column_widths: Vec<f64>,
}

impl LayoutDefaults {
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.config_column_count == 0
            && self.config_column_widths.is_empty()
            && self.group_display_zone.is_empty()
            && self.group_column.is_empty()
            && self.above_column_widths.is_empty()
    }
}

/// Factory launch profile synced from `spawn_profile` — drives Auto VRAM UI and --fit wiring.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LaunchProfile {
    /// When true, non-power-users see simplified engine config (simple_param_keys only).
    #[serde(default, rename = "autoVram")]
    pub auto_vram: bool,
    /// `ggml_fit_params` | `none`
    #[serde(default, rename = "fitStyle")]
    pub fit_style: String,
    /// Param keys visible in Auto VRAM mode (e.g. device, ctx, kv_quant).
    #[serde(default, rename = "simpleParamKeys")]
    pub simple_param_keys: Vec<String>,
    /// Param keys shown in Essentials view (engine config panel filter).
    #[serde(default, rename = "essentialParamKeys")]
    pub essential_param_keys: Vec<String>,
    /// Legacy field — kept for config merge compatibility.
    #[serde(default, rename = "fitMarginMib")]
    pub fit_margin_mib: u32,
    #[serde(default = "default_true", rename = "tensorSplit")]
    pub tensor_split: bool,
}

impl LaunchProfile {
    pub fn from_spawn_profile(sp: &crate::templates::SpawnProfile) -> Self {
        let essential = if !sp.essential_param_keys.is_empty() {
            sp.essential_param_keys.clone()
        } else {
            sp.simple_param_keys.clone()
        };
        Self {
            auto_vram: sp.auto_vram,
            fit_style: sp.fit_style.clone(),
            simple_param_keys: sp.simple_param_keys.clone(),
            essential_param_keys: essential,
            fit_margin_mib: sp.fit_margin_mib,
            tensor_split: sp.tensor_split,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    pub display_name: String,
    pub binary_path: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub params: serde_json::Value,
    #[serde(default, rename = "userEditedTemplateParams")]
    pub user_edited_template_params: Vec<UserEditedTemplateParam>,
    /// Factory param keys removed by admin — merge will not re-append from template.
    #[serde(default, rename = "excludedParamKeys", skip_serializing_if = "Vec::is_empty")]
    pub excluded_param_keys: Vec<String>,
    /// Custom group order set by user (overrides template insertion order). Empty = use template order.
    #[serde(default, rename = "groupOrder")]
    pub group_order: Vec<String>,
    #[serde(default, rename = "groupDisplayZone", skip_serializing_if = "HashMap::is_empty")]
    pub group_display_zone: HashMap<String, String>,
    #[serde(default, rename = "configColumnCount", skip_serializing_if = "Option::is_none")]
    pub config_column_count: Option<u8>,
    #[serde(default, rename = "configColumnWidths", skip_serializing_if = "Vec::is_empty")]
    pub config_column_widths: Vec<f64>,
    #[serde(default, rename = "groupColumn", skip_serializing_if = "HashMap::is_empty")]
    pub group_column: HashMap<String, u32>,
    #[serde(default, rename = "aboveColumnWidths", skip_serializing_if = "Vec::is_empty")]
    pub above_column_widths: Vec<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub _original_id: Option<String>,
    #[serde(default)]
    pub git_url: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub build_profile: String,
    /// Template type determines which provider default config to load.
    /// "ggml-llama" = ggml-master (21 params, master for GGML family),

    /// "" = custom (user adds all params manually, no template).
    #[serde(default)]
    pub template_type: String,
    /// Per-environment build info (frontier/stable) — captured from binary --version + file mtime.
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "buildInfoPerEnv")]
    pub build_info_per_env: HashMap<String, BuildInfo>,
    /// Active launch path per profile (resolved from bundled / foundry / download).
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "binaryPathPerEnv")]
    pub binary_path_per_env: HashMap<String, String>,
    /// User preference per profile: `foundry` | `bundled` (empty = auto by mtime on upgrade).
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "binarySourcePerEnv")]
    pub binary_source_per_env: HashMap<String, String>,
    /// Inventory — bundled installer binary (`runtime/<id>/<profile>/`).
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "bundledBinaryPathPerEnv")]
    pub bundled_binary_path_per_env: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "foundryBinaryPathPerEnv")]
    pub foundry_binary_path_per_env: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "bundledBuildInfoPerEnv")]
    pub bundled_build_info_per_env: HashMap<String, BuildInfo>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "foundryBuildInfoPerEnv")]
    pub foundry_build_info_per_env: HashMap<String, BuildInfo>,
    /// Per-environment downloaded release version — tracks which GitHub release tag was installed via update.
    /// Used for comparing against latest release (build_info_per_env stores internal llama.cpp version, not semver).
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "downloadedVersionPerEnv")]
    pub downloaded_version_per_env: HashMap<String, String>,
    /// Last cherry-picked PR number per environment (for badge display)
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "lastPrPerEnv")]
    pub last_pr_per_env: HashMap<String, String>,
    /// Display order in provider list (0 = first). Auto-assigned on save if not set.
    #[serde(default)]
    pub display_order: i32,
    /// True when the provider was discovered from runtime/ directory (bundled or downloaded).
    /// Factory-provided providers cannot be removed, only disabled. Binary path is managed by foundry/download.
    #[serde(default)]
    pub factory_provided: bool,
    /// Template version number — bumped in default config JSON when template changes. Used for UI notification.
    #[serde(default = "default_template_version", rename = "templateVersion")]
    pub template_version: u32,
    /// True when the provider's loaded user config has a different template_version than the fresh factory template.
    /// Shows banner in ConfigPage advising admin to RESET TO DEFAULTS if issues occur after update.
    /// Runtime-only flag for ConfigPage banner — serialized to frontend, not read from client saves.
    #[serde(default, skip_deserializing, rename = "needsTemplateAttention")]
    pub needs_template_attention: bool,
    /// Factory launch profile — synced from runtime default config on load (not user-persisted).
    #[serde(default, rename = "launchProfile")]
    pub launch_profile: LaunchProfile,
}

pub fn default_template_version() -> u32 { 1 }

pub fn default_true() -> bool { true }
pub fn default_ptype() -> String { "arg_select".to_string() }

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
    /// GPU architectures from CMAKE_CUDA_ARCHITECTURES at build time (e.g., ["86", "89", "120"]).
    #[serde(default, rename = "cudaArchitectures", skip_serializing_if = "Option::is_none")]
    pub cuda_architectures: Option<Vec<String>>,
}

// ── User-edited Template Param (persisted to disk) ────────────────────
/// User's saved copy of a ProviderDefaultParam with runtime state (hidden, hiddenValues, userAddedValues, order, etc.).
/// Stored per-provider as {id}-user-config.json. Created from provider defaults at first run, then edited by the user in UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserEditedTemplateParam {
    pub key: String,
    pub label: String,
    #[serde(rename = "values")]
    pub values: Vec<serde_json::Value>,
    pub order: i32,
    #[serde(default)]
    pub hidden: bool,
    /// Per-param catalog hide set in ConfigPage — survives SPECULATIVE-DECODING group OFF/ON.
    #[serde(default, rename = "userHidden")]
    pub user_hidden: bool,
    /// Values hidden from the catalog UI (persisted, but still usable).
    #[serde(default, rename = "hiddenValues")]
    pub hidden_values: Vec<serde_json::Value>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub flag: Option<String>,
    #[serde(default, rename = "flag_pair")]
    pub flag_pair: Vec<String>,
    #[serde(default = "default_ptype")]
    pub ptype: String,
    /// Slider step increment (for ptype="slider"). Range is derived from values[0]..values[last].
    #[serde(default)]
    pub step: Option<f64>,
    #[serde(default)]
    pub ui_group: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub pattern: String,
    #[serde(default, rename = "defaultValue")]
    pub default_value: serde_json::Value,
    #[serde(default, rename = "userAddedValues")]
    pub user_added_values: Vec<serde_json::Value>,
    #[serde(default, rename = "factoryDefault")]
    pub factory_default: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "sub_params")]
    pub sub_params: Option<HashMap<String, Vec<String>>>,
    #[serde(default)]
    pub dock: String,
    /// Essentials view in MODELS — true=force show, false=force hide, None=factory list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub essential: Option<bool>,
}

impl UserEditedTemplateParam {
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

// ── Hugging Face Hub Types ───────────────────────────────────────────────

/// Search result from HF API — a model on the hub.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HfModel {
    pub id: String,               // e.g. "bartowski/Llama-3.1-8B-IQ1_MS"
    pub author: String,           // e.g. "bartowski"
    pub tags: Vec<String>,        // includes "gguf", "llama", etc.
    #[serde(default)]
    pub downloads: u64,
    #[serde(default, deserialize_with = "deserialize_likes", serialize_with = "serialize_likes_count")]
    pub likes_count: u64,
    #[serde(default, rename = "lastModified")]
    pub last_modified: String,
    /// GGUF files extracted from siblings — only .gguf files.
    #[serde(default)]
    pub gguf_files: Vec<GgufFile>,
}

fn deserialize_likes<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let val = serde_json::Value::deserialize(deserializer)?;
    Ok(val.as_u64().unwrap_or(0))
}

fn serialize_likes_count<S>(val: &u64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_u64(*val)
}

/// One physical GGUF file — a single model or one shard of a sharded quant.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GgufShard {
    #[serde(rename = "fileName")]
    pub file_name: String,
    #[serde(rename = "pathInRepo")]
    pub path_in_repo: String,
    pub size_bytes: u64,
    pub url: String,
    #[serde(default, rename = "lfsOid")]
    pub lfs_oid: String,
}

/// A single GGUF quantization variant available for download.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GgufFile {
    /// Display name (e.g. "Llama-3.1-8B-IQ1_Ms.gguf")
    pub r#type: String,           // HF API calls this "type" — the quant tag like Q4_K_M
    pub size_bytes: u64,
    pub url: String,              // direct download URL from hf.co (first shard when sharded)
    /// LFS content hash (SHA-256) from HF tree endpoint for incremental scan.
    #[serde(default, rename = "lfsOid")]
    pub lfs_oid: String,
    /// Individual shard files when the quant is split (e.g. `-00001-of-00004`).
    #[serde(default)]
    pub shards: Vec<GgufShard>,
    /// 1 for single-file quants; >1 when `shards` is populated.
    #[serde(default = "default_shard_count", rename = "shardCount")]
    pub shard_count: u32,
}

fn default_shard_count() -> u32 {
    1
}

impl GgufFile {
    /// Expand to concrete download parts — single-file quants synthesize one shard from `url`.
    pub fn download_parts(&self) -> Vec<GgufShard> {
        if !self.shards.is_empty() {
            return self.shards.clone();
        }
        let path_in_repo = hf_resolve_path_from_url(&self.url).unwrap_or_else(|| {
            self.url
                .rsplit('/')
                .next()
                .unwrap_or(&self.url)
                .to_string()
        });
        let file_name = path_in_repo
            .rsplit('/')
            .next()
            .unwrap_or(path_in_repo.as_str())
            .to_string();
        vec![GgufShard {
            file_name,
            path_in_repo,
            size_bytes: self.size_bytes,
            url: self.url.clone(),
            lfs_oid: self.lfs_oid.clone(),
        }]
    }
}

/// Path inside the HF repo from a `/resolve/main/` download URL.
pub fn hf_resolve_path_from_url(url: &str) -> Option<String> {
    const MARKER: &str = "/resolve/main/";
    let idx = url.find(MARKER)?;
    let path = url[idx + MARKER.len()..].trim();
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

/// Filters for HF model search.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HfSearchFilters {
    #[serde(default)]
    pub query: String,
    /// VRAM tier filter — only show models that fit in this much VRAM (in GB). 0 = no filter.
    #[serde(default, rename = "vram_gb")]
    pub vram_limit_gb: u32,
    #[serde(default)]
    pub limit: usize,            // default 50
    /// Sort: "downloads", "likes", "lastModified"
    #[serde(default)]
    pub sort: String,
}

// ── Download Manager Types ───────────────────────────────────────────────

/// Status of a download task.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DownloadStatus {
    Queued,
    Downloading,
    Paused,
    Completed,
    Failed,
    Scanning,  // Post-download GGUF metadata scan
}

/// A single download task in the queue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadTask {
    pub id: String,              // unique ID (UUID or timestamp-based)
    #[serde(rename = "hfModelId")]
    pub hf_model_id: String,     // HF model ID for display
    pub file_name: String,       // filename being downloaded
    pub download_url: String,    // direct URL from HF
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    #[serde(rename = "downloadedBytes")]
    pub downloaded_bytes: u64,
    pub status: DownloadStatus,
    /// Where the file will be saved (full path).
    #[serde(rename = "destPath")]
    pub dest_path: String,
    /// Current download speed in bytes/sec.
    #[serde(default, rename = "speedBps")]
    pub speed_bps: u64,
    /// Byte offset for resume support.
    #[serde(default, rename = "pauseOffset")]
    pub pause_offset: u64,
    #[serde(default)]
    pub error: Option<String>,
    /// Estimated time remaining in seconds (0 if unknown).
    #[serde(default, rename = "etaSeconds")]
    pub eta_seconds: u64,
    /// HF author (e.g., "bartowski") — used to save HfMetadata on download completion.
    #[serde(default)]
    pub hf_author: String,
    /// Quant type from HF API (e.g., "Q4_K_M") — more reliable than filename parsing.
    #[serde(default, rename = "quantType")]
    pub quant_type: String,
    /// LFS content hash for incremental scan skip on completion.
    #[serde(default, rename = "lfsOid")]
    pub lfs_oid: String,
    /// Sharded quant batch — `.part` → `.gguf` rename deferred until all parts complete.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "batchId")]
    pub batch_id: Option<String>,
}

/// One file in a sharded quant download batch.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuantBatchPart {
    #[serde(rename = "destPath")]
    pub dest_path: String,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    #[serde(default, rename = "lfsOid")]
    pub lfs_oid: String,
    pub file_name: String,
}

/// Sharded quant — finalize all `.part` files together when every part is complete.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuantDownloadBatch {
    pub id: String,
    #[serde(rename = "hfModelId")]
    pub hf_model_id: String,
    #[serde(rename = "quantType")]
    pub quant_type: String,
    #[serde(default)]
    pub hf_author: String,
    pub parts: Vec<QuantBatchPart>,
}

// ── Model Paths Types ────────────────────────────────────────────────────

/// A configured model directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelPathEntry {
    pub path: String,
    /// Human-readable label (e.g., "Main SSD", "D: Archive")
    #[serde(default)]
    pub label: String,
    /// Whether new downloads default to this path.
    #[serde(default, rename = "isDefault")]
    pub is_default: bool,
}

/// Disk usage info for a model path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathDiskUsage {
    pub path: String,
    /// Total size of all .gguf files in this path (bytes).
    #[serde(rename = "totalGgufBytes")]
    pub total_gguf_bytes: u64,
    /// Number of GGUF files.
    #[serde(rename = "fileCount")]
    pub file_count: usize,
}

/// Result of probing a model library folder before onboarding / path add.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelLibraryValidation {
    pub exists: bool,
    #[serde(rename = "ggufCount")]
    pub gguf_count: usize,
    #[serde(rename = "resolvedPath")]
    pub resolved_path: String,
}

/// Response from search_hf_models IPC command.
#[derive(Debug, Clone, Serialize)]
pub struct HfSearchResponse {
    pub models: Vec<HfModel>,
    /// Whether there are more results available (for pagination).
    #[serde(rename = "hasMore")]
    pub has_more: bool,
}

/// Response from get_hf_model_info IPC command — full model details.
#[derive(Debug, Clone, Serialize)]
pub struct HfModelInfo {
    pub id: String,
    pub author: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub downloads: u64,
    pub likes_count: u64,
    /// All GGUF files available for this model.
    pub gguf_files: Vec<GgufFile>,
}

/// Result of checking a single GGUF file on HF for updates.
#[derive(Debug, Clone, Serialize)]
pub struct HfFileUpdateCheck {
    /// Quant type
    #[serde(rename = "quantType")]
    pub quant_type: String,
    /// Whether an update is available on HF
    #[serde(rename = "hasUpdate")]
    pub has_update: bool,
    /// Current cached file size (0 if not cached)
    #[serde(rename = "cachedSizeBytes")]
    pub cached_size_bytes: u64,
    /// Current HF file size
    #[serde(rename = "hfSizeBytes")]
    pub hf_size_bytes: u64,
    /// Current HF LFS OID
    #[serde(rename = "hfLfsOid")]
    pub hf_lfs_oid: String,
    /// Match reason: "lfs_match" = same OID, "size_match" = same size different OID, "changed" = different size
    #[serde(rename = "status")]
    pub status: String,
}

/// Aggregated update status for an HF repo.
#[derive(Debug, Clone, Serialize)]
pub struct HfRepoUpdateStatus {
    /// HF model ID
    #[serde(rename = "hfModelId")]
    pub hf_model_id: String,
    /// Per-quant results — only quants with a local on-disk copy in this repo.
    pub files: Vec<HfFileUpdateCheck>,
    /// Local quants checked (on disk under this HF repo).
    #[serde(rename = "localCopyCount")]
    pub local_copy_count: usize,
    /// Local quants that differ from current HF (size/LFS mismatch).
    #[serde(rename = "updateCount")]
    pub update_count: usize,
    /// Error message if the check failed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Catalog entry with an HF update available for its paired repo + quant.
#[derive(Debug, Clone, Serialize)]
pub struct CatalogUpdateEntry {
    pub path: String,
    #[serde(rename = "hfModelId")]
    pub hf_model_id: String,
    pub quant: String,
    #[serde(rename = "hasUpdate")]
    pub has_update: bool,
}

