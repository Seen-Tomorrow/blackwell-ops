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

pub fn default_provider_type() -> String { crate::config::DEFAULT_PROVIDER_ID.to_string() }
pub fn default_ctx_size() -> usize { 32768 }

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
    #[serde(default, rename = "userEditedTemplateParams")]
    pub user_edited_template_params: Vec<UserEditedTemplateParam>,
    /// Custom group order set by user (overrides template insertion order). Empty = use template order.
    #[serde(default, rename = "groupOrder")]
    pub group_order: Vec<String>,
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
    /// "ik-llama" = ik (9 IK-specific params),
    /// "" = custom (user adds all params manually, no template).
    #[serde(default)]
    pub template_type: String,
    /// Per-environment build info (vanguard/stable/fresh) — captured from binary --version + file mtime.
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "buildInfoPerEnv")]
    pub build_info_per_env: HashMap<String, BuildInfo>,
    /// Per-environment binary paths — each env's sacred final binary lives under foundry/artifacts/<id>/<env>/Release/ (post-2026-04 redesign).
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "binaryPathPerEnv")]
    pub binary_path_per_env: HashMap<String, String>,
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
    #[serde(default, skip_serializing, rename = "needsTemplateAttention")]
    pub needs_template_attention: bool,
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

/// A single GGUF quantization variant available for download.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GgufFile {
    /// Display name (e.g. "Llama-3.1-8B-IQ1_Ms.gguf")
    pub r#type: String,           // HF API calls this "type" — the quant tag like Q4_K_M
    pub size_bytes: u64,
    pub url: String,              // direct download URL from hf.co
    /// LFS content hash (SHA-256) from HF tree endpoint for incremental scan.
    #[serde(default)]
    pub lfs_oid: String,
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

