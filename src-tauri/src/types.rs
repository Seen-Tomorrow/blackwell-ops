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
    // RoPE / Context Extension params (from genesis_template.json)
    #[serde(default)]
    pub rope_scaling: String,
    #[serde(default = "default_rope_scale")]
    pub rope_scale: f64,
    #[serde(default)]
    pub yarn_orig_ctx: u32,
    #[serde(default)]
    pub rope_freq_base: f64,
    #[serde(default)]
    pub extra_params: HashMap<String, serde_json::Value>,
}

fn default_rope_scale() -> f64 { 1.0 }

fn default_ffi_provider() -> String { "ggml-stable".to_string() }

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
    /// LFS content hash from HF tree endpoint — immutable file identity for incremental scan.
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
    #[serde(default)]
    pub backend_type: String,
    /// Human-readable label of the configured path this model came from (e.g. ".lmstudio", "D: Archive").
    #[serde(default, rename = "sourcePathLabel")]
    pub source_path_label: String,
    /// Parsed GGUF metadata — populated from cache or on-demand scan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<ModelMetadata>,
    /// Persistent HF API metadata — set at download time, never expires.
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

