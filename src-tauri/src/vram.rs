//! VRAM Prediction Engine — full port of tower_vram.py math.
//!
//! Calculates accurate VRAM requirements based on model architecture and runtime config.
//! Supports dense models, MoE (CPU experts), sliding window attention, and FIT cache fallback.

use serde::Serialize;
use std::collections::HashMap;
use std::fs;

// ── Constants (exact parity with tower_vram.py) ─────────────────────

pub const MOE_ATTENTION_RATIO: f64 = 0.18;
pub const MOE_ROUTING_RATIO: f64 = 0.04;
pub const MOE_NON_EXPERT_FFN_RATIO: f64 = 0.03;

pub const CUDA_BASE_OVERHEAD: f64 = 2.5;       // GB
pub const CUDA_PARALLEL_OVERHEAD_PER_REQ: f64 = 0.5; // GB per parallel request
pub const CUDA_BATCH_OVERHEAD_FACTOR: f64 = 1.5 / 4096.0;
pub const CUDA_CTX_OVERHEAD_FACTOR: f64 = 0.5 / 131072.0;

const KV_BYTES_MAP: &[(&str, f64)] = &[
    ("q4_0", 0.5),
    ("q4_k", 0.8),
    ("q8_0", 1.0),
    ("f16", 2.0),
    ("f32", 4.0),
];

// ── Architecture Config ─────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ArchConfig {
    pub layers: u32,
    pub hidden_dim: u32,
    pub heads: u32,
    pub kv_heads: u32,
    pub sliding_window: Option<u32>,
    pub head_dim: Option<u32>,
    pub kv_active_layers: Option<u32>,
    pub ssm_state_gb: f64,
    pub layer_types: Option<Vec<String>>,
}

impl ArchConfig {
    fn head_dim_or_default(&self) -> u32 {
        self.head_dim.unwrap_or_else(|| {
            if self.heads > 0 {
                self.hidden_dim / self.heads
            } else {
                128
            }
        })
    }
}

pub fn arch_defaults() -> HashMap<&'static str, ArchConfig> {
    let mut map = HashMap::new();
    map.insert(
        "llama-7b",
        ArchConfig {
            layers: 32,
            hidden_dim: 4096,
            heads: 32,
            kv_heads: 32,
            sliding_window: None,
            head_dim: None,
            kv_active_layers: None,
            ssm_state_gb: 0.0,
            layer_types: None,
        },
    );
    map.insert(
        "llama-13b",
        ArchConfig {
            layers: 40,
            hidden_dim: 5120,
            heads: 40,
            kv_heads: 40,
            sliding_window: None,
            head_dim: None,
            kv_active_layers: None,
            ssm_state_gb: 0.0,
            layer_types: None,
        },
    );
    map.insert(
        "llama-30b",
        ArchConfig {
            layers: 60,
            hidden_dim: 6144,
            heads: 48,
            kv_heads: 8,
            sliding_window: None,
            head_dim: None,
            kv_active_layers: None,
            ssm_state_gb: 0.0,
            layer_types: None,
        },
    );
    map.insert(
        "llama-70b",
        ArchConfig {
            layers: 80,
            hidden_dim: 8192,
            heads: 64,
            kv_heads: 8,
            sliding_window: None,
            head_dim: None,
            kv_active_layers: None,
            ssm_state_gb: 0.0,
            layer_types: None,
        },
    );
    map.insert(
        "llama-405b",
        ArchConfig {
            layers: 120,
            hidden_dim: 16384,
            heads: 128,
            kv_heads: 16,
            sliding_window: None,
            head_dim: None,
            kv_active_layers: None,
            ssm_state_gb: 0.0,
            layer_types: None,
        },
    );
    map.insert(
        "nemotron-h-moe",
        ArchConfig {
            layers: 88,
            hidden_dim: 4096,
            heads: 32,
            kv_heads: 2,
            sliding_window: None,
            head_dim: None,
            kv_active_layers: Some(8),
            ssm_state_gb: 0.16,
            layer_types: None,
        },
    );
    map.insert(
        "default",
        ArchConfig {
            layers: 80,
            hidden_dim: 8192,
            heads: 64,
            kv_heads: 8,
            sliding_window: None,
            head_dim: None,
            kv_active_layers: None,
            ssm_state_gb: 0.0,
            layer_types: None,
        },
    );
    map
}

// ── Calculation Config ──────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct VramCalcConfig {
    pub model_bytes: u64,          // total GGUF file size in bytes
    pub mmproj_bytes: u64,         // vision projector (0 if none)
    pub vision_enabled: bool,
    pub offload_layers: u32,       // 999 or "ALL" = all layers on GPU
    pub ctx: usize,                // context length in tokens
    pub kv_quant: String,          // "q4_0", "q8_0", "f16"
    pub parallel: u32,
    pub batch: u32,
}

// ── Result Types ────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct VramBreakdown {
    pub vram_weights: f64,   // GB for model weights on GPU
    pub vram_kv: f64,        // GB for KV cache
    pub vram_overhead: f64,  // GB CUDA overhead
}

#[derive(Debug, Clone, Serialize)]
pub struct VramResult {
    pub total_vram: f64,     // GB
    pub vram_weights: f64,   // GB
    pub vram_kv: f64,        // GB
    pub vram_overhead: f64,  // GB
    pub source: String,      // "fit_cache", "lmstudio", "gguf", "fallback"
}

#[derive(Debug, Clone, Serialize)]
pub struct VramFitResult {
    pub total_vram_gb: f64,
    pub fits: bool,
    pub gpu_total_gb: f64,
    #[serde(rename = "breakdown")]
    pub breakdown: VramBreakdownJson,
}

#[derive(Debug, Clone, Serialize)]
pub struct VramBreakdownJson {
    pub model_weights_gb: f64,
    pub kv_cache_gb: f64,
    pub overhead_gb: f64,
}

// ── KV Bytes Helper ────────────────────────────────────────────────

/// Returns bytes per parameter for KV cache quantization format.
pub fn kv_bytes_per_param(quant_str: &str) -> f64 {
    if quant_str.is_empty() {
        return 1.0;
    }
    let q = quant_str.to_lowercase();
    // Exact match first
    for (key, val) in KV_BYTES_MAP {
        if q.contains(*key) {
            return *val;
        }
    }
    // Fuzzy matching
    if q.contains("turbo") || q.contains("q4") {
        0.5
    } else if q.contains("q5") || q.contains("q6") {
        0.8
    } else if q.contains("q7") || q.contains("q8") {
        1.0
    } else {
        1.0
    }
}

// ── Architecture Detection ─────────────────────────────────────────

/// Detect architecture defaults from model name patterns.
pub fn detect_arch_from_name(model_name: &str) -> ArchConfig {
    let name_lower = model_name.to_lowercase();
    let defaults = arch_defaults();

    if name_lower.contains("405b") || name_lower.contains("400b") {
        return defaults["llama-405b"].clone();
    } else if name_lower.contains("70b") || name_lower.contains("72b") {
        return defaults["llama-70b"].clone();
    } else if name_lower.contains("30b") || name_lower.contains("31b") {
        return defaults["llama-30b"].clone();
    } else if name_lower.contains("13b") || name_lower.contains("14b") {
        return defaults["llama-13b"].clone();
    } else if name_lower.contains("7b") || name_lower.contains("8b") {
        return defaults["llama-7b"].clone();
    }

    defaults["default"].clone()
}

/// Extracts architecture metadata from LM Studio's config.json.
pub fn get_metadata_from_config_json(model_path: &str) -> Option<ArchConfig> {
    let dir = std::path::Path::new(model_path).parent()?;
    let config_path = dir.join("config.json");

    if !config_path.exists() {
        return None;
    }

    let content = fs::read_to_string(&config_path).ok()?;
    let data: serde_json::Value = serde_json::from_str(&content).ok()?;

    let text_config = data.get("text_config")?.as_object()?;
    let hidden_size = text_config.get("hidden_size")?.as_u64()? as u32;
    let num_attention_heads = text_config.get("num_attention_heads")?.as_u64()? as u32;

    // Compute head_dim: explicit, or hidden_size / num_attention_heads
    let head_dim = text_config
        .get("head_dim")
        .or_else(|| text_config.get("global_head_dim"))
        .and_then(|v| v.as_u64())
        .map(|v| v as u32)
        .or_else(|| {
            if num_attention_heads > 0 {
                Some(hidden_size / num_attention_heads)
            } else {
                None
            }
        });

    let arch = ArchConfig {
        layers: text_config.get("num_hidden_layers")?.as_u64()? as u32,
        hidden_dim: hidden_size,
        heads: num_attention_heads,
        kv_heads: text_config.get("num_key_value_heads")?.as_u64()? as u32,
        sliding_window: text_config.get("sliding_window").and_then(|v| v.as_u64()).map(|v| v as u32),
        head_dim,
        kv_active_layers: None,
        ssm_state_gb: 0.0,
        layer_types: text_config
            .get("layer_types")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect()),
    };

    Some(arch)
}

// ── VRAM Calculations ───────────────────────────────────────────────

/// Calculate VRAM for dense (non-MoE) model weights on GPU.
pub fn calc_dense_vram(arch: &ArchConfig, config: &VramCalcConfig) -> f64 {
    let model_gb = config.model_bytes as f64 / (1024.0_f64.powi(3));
    let mmproj_gb = if config.vision_enabled {
        config.mmproj_bytes as f64 / (1024.0_f64.powi(3))
    } else {
        0.0
    };

    // ALL layers on GPU
    if config.offload_layers == 999 || config.offload_layers == u32::MAX {
        return model_gb + mmproj_gb;
    }

    let total_layers = max_u32(arch.layers, 1);
    let gpu_ratio = (config.offload_layers as f64) / (total_layers as f64);
    let gpu_ratio = gpu_ratio.min(1.0); // Cap at 100%

    // Non-linear adjustment: embeddings + attention must stay on GPU (~15% minimum)
    let min_gpu_ratio = 0.15;
    let effective_ratio = gpu_ratio.max(min_gpu_ratio);

    // Vision projector is always 100% on GPU if enabled
    (model_gb * effective_ratio) + mmproj_gb
}

/// Calculate VRAM for MoE model weights on GPU (attention + routing only, experts on CPU).
pub fn calc_moe_vram(_arch: &ArchConfig, config: &VramCalcConfig) -> f64 {
    let model_gb = config.model_bytes as f64 / (1024.0_f64.powi(3));
    let mmproj_gb = if config.vision_enabled {
        config.mmproj_bytes as f64 / (1024.0_f64.powi(3))
    } else {
        0.0
    };

    // MoE breakdown: only attention + routing + non-expert FFN on GPU
    let gpu_ratio = MOE_ATTENTION_RATIO + MOE_ROUTING_RATIO + MOE_NON_EXPERT_FFN_RATIO; // = 0.25

    (model_gb * gpu_ratio) + mmproj_gb
}

/// Calculate KV cache VRAM requirement. Supports Sliding Window Attention (SWA).
pub fn calc_kv_cache(arch: &ArchConfig, config: &VramCalcConfig) -> f64 {
    let num_layers = arch.kv_active_layers.unwrap_or(arch.layers);
    let kv_heads = arch.kv_heads;
    let seq_len = config.ctx;
    let bytes_per_param = kv_bytes_per_param(&config.kv_quant);

    // Use precise head_dim if available
    let head_dim = arch.head_dim_or_default();

    // Sliding Window Attention (SWA) Logic
    if let Some(sliding_window) = arch.sliding_window {
        if sliding_window > 0 {
            if let Some(ref layer_types) = arch.layer_types {
                // Exact count from LM Studio config labels
                let full_layers = layer_types
                    .iter()
                    .filter(|t| matches!(t.as_str(), "full_attention" | "full" | "global"))
                    .count();
                let swa_layers = max_u32(num_layers, 1) as usize - full_layers;

                // Global layers: full sequence
                let global_bytes =
                    2.0 * (full_layers as f64) * (kv_heads as f64) * (head_dim as f64) * (seq_len as f64) * bytes_per_param;
                // Sliding layers: only the window
                let swa_bytes = 2.0
                    * (swa_layers as f64)
                    * (kv_heads as f64)
                    * (head_dim as f64)
                    * (seq_len.min(sliding_window as usize) as f64)
                    * bytes_per_param;

                let kv_bytes = global_bytes + swa_bytes;
                return apply_kv_multipliers(kv_bytes, config);
            } else {
                // Heuristic: approx 1/4 layers are global
                let full_layers = max_u32(num_layers, 1) / 4;
                let swa_layers = num_layers - full_layers;

                let global_bytes = 2.0
                    * (full_layers as f64)
                    * (kv_heads as f64)
                    * (head_dim as f64)
                    * (seq_len as f64)
                    * bytes_per_param;
                let swa_bytes = 2.0
                    * (swa_layers as f64)
                    * (kv_heads as f64)
                    * (head_dim as f64)
                    * (seq_len.min(sliding_window as usize) as f64)
                    * bytes_per_param;

                let kv_bytes = global_bytes + swa_bytes;
                return apply_kv_multipliers(kv_bytes, config);
            }
        }
    }

    // Standard full attention for all layers
    let kv_elements = 2.0
        * (num_layers as f64)
        * (kv_heads as f64)
        * (head_dim as f64)
        * (seq_len as f64);
    let kv_bytes = kv_elements * bytes_per_param;

    apply_kv_multipliers(kv_bytes, config)
}

fn apply_kv_multipliers(kv_bytes: f64, config: &VramCalcConfig) -> f64 {
    let parallel_mult = config.parallel as f64;
    let batch_mult = (config.batch as f64 / 2048.0).max(1.0);
    kv_bytes * parallel_mult * batch_mult / (1024.0_f64.powi(3)) // Convert to GB
}

/// Calculate CUDA overhead and working memory.
pub fn calc_overhead(config: &VramCalcConfig) -> f64 {
    let base = CUDA_BASE_OVERHEAD;
    let parallel_overhead = (config.parallel as f64) * CUDA_PARALLEL_OVERHEAD_PER_REQ;
    let batch_overhead = (config.batch as f64) * CUDA_BATCH_OVERHEAD_FACTOR;
    let ctx_overhead = if config.ctx > 65536 {
        (config.ctx as f64) * CUDA_CTX_OVERHEAD_FACTOR
    } else {
        0.0
    };

    base + parallel_overhead + batch_overhead + ctx_overhead
}

/// Main VRAM calculation function.
pub fn calculate_vram(arch: &ArchConfig, config: &VramCalcConfig, offload_mode: &str) -> VramBreakdown {
    let vram_weights = if matches!(offload_mode, "MOE_CPU_EXPERTS" | "MOE_OPTIMAL") {
        calc_moe_vram(arch, config)
    } else {
        calc_dense_vram(arch, config)
    };

    let vram_kv = calc_kv_cache(arch, config);
    let vram_overhead = calc_overhead(config);
    let ssm_state = arch.ssm_state_gb;

    VramBreakdown {
        vram_weights,
        vram_kv,
        vram_overhead: vram_overhead + ssm_state,
    }
}

/// Calculate VRAM with automatic fallback to estimation if metadata unavailable.
/// Priority: 1. FIT Cache -> 2. LM Studio Config -> 3. Name Fallback
/// After calculation, writes result back to cache for future lookups (lazy-update).
pub fn calculate_vram_with_fallback(
    model_path: &str,
    config: &VramCalcConfig,
    offload_mode: &str,
) -> VramResult {
    // Load cache once at start
    let mut cache = load_fit_cache().unwrap_or_default();
    
    // 1. Try FIT Cache first (highest precision)
    if let Some(kv_map) = cache.get(model_path) {
        let kv_key = match config.kv_quant.to_lowercase().as_str() {
            "q4_0" => "q4_0",
            "q8_0" => "q8_0",
            "f16" => "f16",
            _ => "f16",
        };
        let combo_key = format!("ctx{}_kv{}", config.ctx, kv_key);

        if let Some(entry) = kv_map.get(&combo_key) {
            // FIT cache gives total VRAM; split for display
            return VramResult {
                total_vram: entry.vram_gb,
                vram_weights: entry.vram_gb * 0.8,
                vram_kv: entry.vram_gb * 0.15,
                vram_overhead: entry.vram_gb * 0.05,
                source: "fit_cache".to_string(),
            };
        }
    }

    // Calculate VRAM (cache miss — will write back after)
    let breakdown = if let Some(arch) = get_metadata_from_config_json(model_path) {
        calculate_vram(&arch, config, offload_mode)
    } else {
        // Fallback to name-based detection with safety margin
        let model_name = std::path::Path::new(model_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown");

        let arch = detect_arch_from_name(model_name);
        let mut safe_config = config.clone();
        safe_config.model_bytes = (safe_config.model_bytes as f64 * 1.2) as u64;
        calculate_vram(&arch, &safe_config, offload_mode)
    };

    let total = breakdown.vram_weights + breakdown.vram_kv + breakdown.vram_overhead;
    
    // Determine source for result and cache entry
    let source = if get_metadata_from_config_json(model_path).is_some() {
        "lmstudio"
    } else {
        "fallback"
    };

    // Write back to cache (lazy-update strategy)
    let kv_key = match config.kv_quant.to_lowercase().as_str() {
        "q4_0" => "q4_0",
        "q8_0" => "q8_0",
        "f16" => "f16",
        _ => "f16",
    };
    let combo_key = format!("ctx{}_kv{}", config.ctx, kv_key);
    
    cache.entry(model_path.to_string())
        .or_insert_with(HashMap::new)
        .insert(combo_key, FitCacheEntry { vram_gb: total });
    
    save_fit_cache(&cache);

    VramResult {
        total_vram: total,
        vram_weights: breakdown.vram_weights,
        vram_kv: breakdown.vram_kv,
        vram_overhead: breakdown.vram_overhead,
        source: source.to_string(),
    }
}

/// Check if the calculated VRAM fits within available GPU memory.
pub fn check_vram_fit(gpus: &[crate::telemetry::GpuInfo], result: &VramResult) -> VramFitResult {
    // Sum total VRAM across all GPUs (in MB from GpuInfo, convert to GB)
    let total_gpu_gb: f64 = gpus.iter().map(|g| g.memory_total as f64 / 1024.0).sum();

    let fits = result.total_vram <= total_gpu_gb;

    VramFitResult {
        total_vram_gb: round_to_nearest(result.total_vram, 0.5),
        fits,
        gpu_total_gb: round_to_nearest(total_gpu_gb, 0.5),
        breakdown: VramBreakdownJson {
            model_weights_gb: round_to_nearest(result.vram_weights, 0.5),
            kv_cache_gb: round_to_nearest(result.vram_kv, 0.5),
            overhead_gb: round_to_nearest(result.vram_overhead, 0.5),
        },
    }
}

// ── FIT Cache ───────────────────────────────────────────────────────

#[derive(serde::Deserialize, serde::Serialize)]
pub(crate) struct FitCacheEntry {
    vram_gb: f64,
}

type FitCache = HashMap<String, HashMap<String, FitCacheEntry>>;

fn load_fit_cache() -> Option<FitCache> {
    let cache_path = dirs::config_dir()?.join("blackwell-ops").join("fit_cache.json");
    if !cache_path.exists() {
        return None;
    }
    let content = fs::read_to_string(&cache_path).ok()?;
    serde_json::from_str(&content).ok()
}

/// Save FIT cache to disk. Called after successful VRAM calculation when cache misses.
pub fn save_fit_cache(cache: &FitCache) {
    if let Some(app_dir) = dirs::config_dir() {
        let cache_path = app_dir.join("blackwell-ops").join("fit_cache.json");
        if let Some(dir) = cache_path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(cache) {
            let _ = fs::write(&cache_path, json);
        }
    }
}

// ── Helpers ─────────────────────────────────────────────────────────

fn round_to_nearest(val: f64, step: f64) -> f64 {
    (val / step).round() * step
}

fn max_u32(a: u32, b: u32) -> u32 {
    if a > b { a } else { b }
}
