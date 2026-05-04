//! FIT Scanner Engine — hardware-probe VRAM estimation using llama-fit-params.exe.
//!
//! Reuses the same template-driven command building as engine launch (templates::build_command).
//! Only difference: binary swapped to llama-fit-params.exe, --fit off appended, -m/--port replaced.
//! 3 anchor points per model + linear interpolation for arbitrary ctx/KV estimation.

use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc as StdArc;
use tokio::process::Command;
use tokio::sync::{broadcast, Semaphore};
use tokio::sync::Mutex as TokioMutex;

// ── Constants ───────────────────────────────────────────────

pub const FIT_OVERHEAD_PER_GPU: f64 = 256.0; // MiB static overhead per GPU for CUDA context/P2P
const SCAN_TIMEOUT_SECS: u64 = 30;

/// Compute CUDA_VISIBLE_DEVICES mask from config + detected GPU count.
fn compute_gpu_mask(config: &crate::types::EngineConfig, gpu_count: usize) -> String {
    let split_active = !config.split_mode.is_empty() && config.split_mode.to_uppercase() != "NONE";

    if split_active {
        (0..gpu_count).map(|i| i.to_string()).collect::<Vec<_>>().join(",")
    } else {
        let idx = config.device.strip_prefix("GPU-")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0);
        if idx < gpu_count {
            idx.to_string()
        } else {
            "0".to_string()
        }
    }
}

/// Detect physical GPU count via nvidia-smi. Returns 2 as fallback.
fn detect_gpu_count() -> usize {
    let mut gpu_count = 2;
    if let Ok(output) = std::process::Command::new("nvidia-smi")
        .args(&["--query-gpu=index", "--format=csv,noheader"])
        .output()
    {
        let count = String::from_utf8_lossy(&output.stdout)
            .lines().filter(|l| !l.trim().is_empty()).count();
        if count > 0 {
            gpu_count = count;
        }
    }
    gpu_count
}

/// Compute a SHA256 hash from the first 8KB of a model file.
/// Sufficient to detect quantization swaps (GGUF header contains quant info).
pub fn compute_model_hash(path: &str) -> String {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return path.to_string(), // fallback to path if unreadable
    };
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    match file.read(&mut buffer) {
        Ok(n) if n > 0 => hasher.update(&buffer[..n]),
        _ => {}
    }
    format!("{:x}", hasher.finalize())
}

/// Get the mmproj file size in MiB for a model. Scans parent directory for *mmproj* files.
pub fn get_mmproj_size_mib(model_path: &str) -> f64 {
    let model_dir = PathBuf::from(model_path);
    let parent = match model_dir.parent() {
        Some(p) => p,
        None => return 0.0,
    };
    let entries = match std::fs::read_dir(parent) {
        Ok(e) => e,
        Err(_) => return 0.0,
    };
    for entry in entries.flatten() {
        let fname = entry.file_name();
        let fname_lower = fname.to_string_lossy().to_lowercase();
        if fname_lower.contains("mmproj") {
            if let Ok(meta) = std::fs::metadata(entry.path()) {
                return meta.len() as f64 / (1024.0 * 1024.0);
            }
        }
    }
    0.0
}

// ── Result Types ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FitScanResult {
    pub model_path: String,
    /// Total VRAM in MiB at the scanned context/KV setting.
    pub vram_mib: f64,
    /// Context size used for this scan point.
    pub ctx: usize,
    /// KV quantization used (e.g., "f16", "q4_0").
    pub kv_quant: String,
    /// Whether the model fits within total GPU VRAM.
    pub fits: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FitAnchorResults {
    pub model_path: String,
    pub anchor_a_mib: Option<f64>, // 8K / f16
    pub anchor_b_mib: Option<f64>, // 128K / f16
    pub anchor_c_mib: Option<f64>, // 128K / q4_k
    /// Error message if any anchor failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FitScanProgress {
    pub model_path: String,
    pub model_name: String,
    pub status: String, // "scanning", "complete", "error"
    /// The CLI args used for this scan (for debugging).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<String>,
    /// VRAM result in MiB if complete.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vram_mib: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FitScanComplete {
    pub provider_id: String,
    pub total_models: usize,
    pub completed: usize,
    pub failed: usize,
    /// Per-model results keyed by model path.
    pub results: HashMap<String, FitAnchorResults>,
}

// ── Interpolation Engine ────────────────────────────────────────────

/// Represents a 3-anchor VRAM profile for a single model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VramProfile {
    pub anchor_a_mib: f64,   // 8K / f16
    pub anchor_b_mib: f64,   // 128K / f16
    pub anchor_c_mib: f64,   // 128K / q4_k
}

impl VramProfile {
    /// Calculate VRAM in MiB for any context/KV combination using interpolation.
    pub fn estimate_vram_mib(&self, ctx: usize, kv_quant: &str) -> f64 {
        let a = self.anchor_a_mib;
        let b = self.anchor_b_mib;

        if a.is_nan() || b.is_nan() || a <= 0.0 || b <= 0.0 {
            return a.max(b);
        }

        const ANCHOR_A_CTX: usize = 8192;
        const ANCHOR_B_CTX: usize = 131072;
        let ctx_a = ANCHOR_A_CTX as f64;
        let ctx_b = ANCHOR_B_CTX as f64;
        
        // Calculate slope (VRAM growth per token) from anchor points
        let slope_f16 = (b - a) / (ctx_b - ctx_a);
        
        // Clamp context size to valid range for interpolation
        let clamped_ctx = ctx.max(ANCHOR_A_CTX).min(ANCHOR_B_CTX) as f64;
        
        // Estimate base VRAM at requested context with f16 KV cache
        let vram_at_f16 = a + slope_f16 * (clamped_ctx - ctx_a);
        
        // Calculate KV overhead from CTX growth: how much extra for larger contexts
        let kv_overhead_f16 = vram_at_f16 - a;  // Extra VRAM beyond model weights
        
        // Get quantization ratio: anchor C / anchor B (128K q4_0 vs 128K f16)
        let kv_ratio = if self.anchor_c_mib > 0.0 && !self.anchor_c_mib.is_nan() && b > 0.0 {
            self.anchor_c_mib / b
        } else {
            // Fallback ratios when anchor C is missing
            match kv_quant.to_lowercase().as_str() {
                "f16" | "bf16" => return vram_at_f16,
                "q8_0" => 1.0,
                "q5_0" | "q5_1" | "q5_k" => 0.75,
                "q4_0" | "q4_1" | "q4_k" | "iq4_nl" => 0.625, // ~62.5% for Q4_K
                "q3_k" => 0.5,
                "q2_k" => 0.375,
                _ => 0.625, // Default to Q4 ratio
            }
        };

        // Final VRAM = base weights + quantized KV overhead
        a + (kv_overhead_f16 * kv_ratio)
    }
}

// ── Binary Discovery ────────────────────────────────────────────────

/// Find llama-fit-params.exe next to the provider's server binary.
/// Falls back to searching common provider directories if not found in current one.
pub fn find_fit_binary(provider_binary_path: &str) -> Option<String> {
    let base = PathBuf::from(provider_binary_path);
    
    // First try: same directory as server binary
    if let Some(parent_dir) = base.parent() {
        let fit_path = parent_dir.join("llama-fit-params.exe");
        if fit_path.exists() {
            return Some(fit_path.to_string_lossy().to_string());
        }
        
        // Second try (IK fallback): search sibling directories for GGML llama-fit-params.exe
        // IK providers don't bundle this binary, so we reuse GGML's version
        if let Ok(entries) = std::fs::read_dir(parent_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let name_lower = path.file_name()
                        .map(|n| n.to_string_lossy().to_lowercase())
                        .unwrap_or_default();
                    
                    // Look for directories that might contain llama-fit-params.exe
                    if name_lower.contains("ggml") || name_lower.contains("llama") 
                       || !name_lower.is_empty() {
                        let candidate = path.join("llama-fit-params.exe");
                        if candidate.exists() {
                            return Some(candidate.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
    }
    
    None
}

/// Find ANY llama-fit-params.exe in common locations (for system-wide fallback).
/// Used when provider-specific binary is not available.
pub fn find_fallback_fit_binary() -> Option<String> {
    // Search in same directory as current executable
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            let fit_path = exe_dir.join("llama-fit-params.exe");
            if fit_path.exists() {
                return Some(fit_path.to_string_lossy().to_string());
            }
            
            // Search sibling directories
            if let Ok(entries) = std::fs::read_dir(exe_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        let fit_in_subdir = path.join("llama-fit-params.exe");
                        if fit_in_subdir.exists() {
                            return Some(fit_in_subdir.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
    }
    
    None
}

// ── Template-Driven Command Building ────────────────────────

/// Build CLI args for a single fit scan using the provider's template.
/// Same logic as engine launch: template.build_command() -> strip -m/--port -> prepend model + --fit off.
pub fn build_fit_args_from_template(
    template: &crate::templates::ProviderTemplate,
    config: &crate::types::EngineConfig,
    model_path: &str,
    gpu_mask: &str,
) -> Vec<String> {
    // Temporarily clear model_path to suppress [LAUNCH_CMD] during fit-scan arg building.
    let mut cfg = config.clone();
    cfg.model_path = String::new();

    let raw_args = template.build_command(&cfg, gpu_mask, None);

    // Strip flags irrelevant to VRAM estimation: server-only features llama-fit-params doesn't accept.
    let mut args = Vec::with_capacity(raw_args.len());
    let mut iter = raw_args.into_iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            // Flags with values — skip both flag and value
            "-m" | "--mmproj" | "--port" | "--reasoning" => { iter.next(); }
            // Boolean flags (no value) — drop entirely
            "--jinja" | "--cont-batching" | "--metrics" | "--verbose" | "--no-mmap" => {}
            _ => args.push(arg),
        }
    }

    // Prepend actual model path and --fit off
    let mut result = Vec::with_capacity(args.len() + 4);
    result.extend(["-m".into(), model_path.into()]);
    result.extend(["--fit".into(), "off".into()]);
    result.extend(args);

    result
}

/// Parse MiB from llama-fit-params.exe output.
fn parse_fit_output(output: &str) -> Option<f64> {
    for line in output.lines() {
        let lower = line.to_lowercase();
        if (lower.contains("projected to use") || lower.contains("estimated to use")) 
            && (lower.contains("mib") || lower.contains("mb") || lower.contains("mi b")) {
            if let Some(num) = extract_number(line) {
                return Some(num);
            }
        }
    }

    for line in output.lines() {
        let lower = line.to_lowercase();
        if (lower.contains("vram") || lower.contains("memory")) 
            && (lower.contains("mib") || lower.contains("mb") || lower.contains("mi b")) {
            if let Some(num) = extract_number(line) {
                return Some(num);
            }
        }
    }

    for line in output.lines() {
        let lower = line.to_lowercase();
        if lower.contains("mib") || lower.contains("mi b") {
            if let Some(num) = extract_number(line) {
                return Some(num);
            }
        }
    }

    None
}

/// Extract the first number from a string, stripping ANSI escape codes first.
fn extract_number(s: &str) -> Option<f64> {
    // Strip ANSI escape sequences (e.g., \x1b[31;1m) before extracting numbers
    let stripped: String = s.chars().scan(false, |in_escape, ch| {
        if *in_escape {
            if ch == 'm' {
                *in_escape = false;
            }
            None
        } else if ch == '\x1b' || ch == '\u{001B}' {
            *in_escape = true;
            None
        } else {
            Some(ch)
        }
    }).collect();

    let stripped = stripped.trim();
    // Remove commas used as thousand separators before parsing
    let cleaned: String = stripped.chars().filter(|c| !(*c == ',')).collect();
    let mut in_number = false;
    let mut digits = String::new();
    for ch in cleaned.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            digits.push(ch);
            in_number = true;
        } else if in_number {
            break;
        }
    }
    if !digits.is_empty() {
        return digits.parse::<f64>().ok();
    }
    None
}

/// Scan a single model at one anchor point with pre-built CLI args.
pub async fn scan_single_anchor(
    fit_binary: &str,
    args: &[String],
    cuda_visible_devices: &str,
) -> Result<f64, String> {
    let model_path = args.iter()
        .position(|a| a == "-m")
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
        .unwrap_or("unknown");

    // DEBUG Llama-fit-scanner launch memo - always printed for visibility
    eprintln!("//DEBUG [FIT_LAUNCH] binary={} model={}", fit_binary, model_path);
    eprintln!("//DEBUG [FIT_CMD] {} {}", fit_binary, args.join(" "));

    let spawn_future = Command::new(fit_binary)
        .args(args)
        .env("CUDA_VISIBLE_DEVICES", cuda_visible_devices)
        .output();

    let timeout_result = tokio::time::timeout(
        std::time::Duration::from_secs(SCAN_TIMEOUT_SECS),
        spawn_future,
    ).await;

    let output = match timeout_result {
        Ok(inner) => inner.map_err(|e| format!("Fit scan IO error for {}: {}", model_path, e))?,
        Err(_) => return Err(format!("Fit scan timed out after {}s for {}", SCAN_TIMEOUT_SECS, model_path)),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined_output = format!("{}\n{}", stdout, stderr);

    // DEBUG Llama-fit-scanner result - always printed for visibility
    eprintln!("//DEBUG [FIT_RAW] exit={} model={}\nSTDOUT:\n{}\nSTDERR:\n{}", 
        output.status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".to_string()),
        model_path, stdout, stderr);

    if let Some(vram_mib) = parse_fit_output(&combined_output) {
        eprintln!("//DEBUG [FIT_OK] {} -> {:.1} MiB", model_path, vram_mib);
        Ok(vram_mib)
    } else {
        // Even on exit=1 (model doesn't fit), try to extract projected VRAM from memory breakdown
        if let Some(projected) = parse_projected_vram(&combined_output) {
            eprintln!("//DEBUG [FIT_PARTIAL] {} -> {:.1} MiB (projected, doesn't fit single GPU)", model_path, projected);
            Ok(projected)
        } else {
            log::warn!("Fit scan parse failed for {}: exit={:?}", model_path, output.status.code());
            Err(format!(
                "Could not parse VRAM from fit output. Exit code: {:?}",
                output.status.code()
            ))
        }
    }
}

/// Parse projected VRAM from memory breakdown when model doesn't fit single GPU.
/// Extracts the "model" value from common_memory_breakdown_print lines.
fn parse_projected_vram(output: &str) -> Option<f64> {
    for line in output.lines() {
        let lower = line.to_lowercase();
        if lower.contains("memory breakdown") && (lower.contains("mib") || lower.contains("mi b")) {
            // Parse the model column value from breakdown table
            // Format: | - CUDA0 ... | 97886 = 78968 + (152340 = 131595 +   20336 +     408) + ...
            if let Some(model_mib) = extract_model_from_breakdown(line) {
                return Some(model_mib);
            }
        }
    }
    None
}

/// Extract model VRAM from memory breakdown line.
/// Format: (total = model + context + compute) → we want "model" value.
fn extract_model_from_breakdown(line: &str) -> Option<f64> {
    // Find the parenthesized section: (152340 = 131595 +   20336 +     408)
    if let Some(start) = line.find('(') {
        if let Some(end) = line[start..].find(')') {
            let inner = &line[start + 1..start + end];
            // Split by '=' to get total and breakdown: "152340 = 131595 +   20336 +     408"
            if let Some(eq_pos) = inner.find('=') {
                let after_eq = &inner[eq_pos + 1..];
                // First number after '=' is the model weight VRAM
                return extract_number(after_eq.trim());
            }
        }
    }
    None
}

/// Build a VramProfile from anchor results (only if all 3 anchors succeeded).
pub fn build_profile(results: &FitAnchorResults) -> Option<VramProfile> {
    match (results.anchor_a_mib, results.anchor_b_mib, results.anchor_c_mib) {
        (Some(a), Some(b), Some(c)) => Some(VramProfile { anchor_a_mib: a, anchor_b_mib: b, anchor_c_mib: c }),
        _ => None,
    }
}

// ── Library Scanner ─────────────────────────────────────────────────

/// Check if a filename is an mmproj file.
fn is_mmproj_file(filename: &str) -> bool {
    let lower = filename.to_lowercase();
    lower.contains("mmproj")
}

/// Extract model name from full path (last component without .gguf).
pub fn extract_model_name(path: &str) -> String {
    PathBuf::from(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .trim_end_matches(".gguf")
        .to_string()
}

/// Find all .gguf model files under a base directory, deduplicating shards and filtering mmproj.
pub fn find_gguf_models(base_path: &str) -> Vec<String> {
    let base = PathBuf::from(base_path);
    if !base.exists() || !base.is_dir() {
        return vec![];
    }

    // Collect all .gguf files first
    let mut all_files: Vec<(String, u64)> = vec![]; // (canonical_name, file_size)
    collect_gguf_files(&base, &mut all_files);

    if all_files.is_empty() {
        return vec![];
    }

    // Deduplicate shards: keep only the first shard (-00001-of-XXXXX) per unique base name.
    // llama-fit-params requires loading from the first split; it will read all shards automatically.
    let mut deduped: HashMap<(String, String), (String, u64)> = HashMap::new();

    // Sort by path so shard 0 (-00001) comes before -00002, etc.
    let mut sorted_files = all_files;
    sorted_files.sort_by(|a, b| a.0.cmp(&b.0));

    for (path, size) in sorted_files {
        let path_buf = PathBuf::from(&path);
        let filename = path_buf.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");

        // Use shared strip_shard_pattern from model_catalog module
        let base_name = crate::model_catalog::strip_shard_pattern(filename);

        // Use (parent_dir, base_name) as group key to avoid cross-directory collisions
        let parent_key = path_buf.parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let group_key = (parent_key, base_name);

        // Only insert if not already present — first shard wins due to sort order
        deduped.entry(group_key).or_insert_with(|| (path, size));
    }

    // Sort by path for deterministic output
    let mut result: Vec<String> = deduped.into_values().map(|(p, _)| p).collect();
    result.sort();
    result
}

fn collect_gguf_files(dir: &PathBuf, out: &mut Vec<(String, u64)>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension() {
                    if ext.eq_ignore_ascii_case("gguf") {
                        let filename = path.file_name()
                            .and_then(|s| s.to_str())
                            .unwrap_or("");

                        // Skip mmproj files — they are vision projectors, not models
                        if is_mmproj_file(filename) {
                            continue;
                        }

                        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                        out.push((path.to_string_lossy().to_string(), size));
                    }
                }
            } else if path.is_dir() {
                collect_gguf_files(&path, out);
            }
        }
    } else {
        log::warn!("Failed to read directory: {}", dir.display());
    }
}

/// Scan an entire library of models with parallel execution.
/// Uses template-driven command building (same as engine launch).
pub async fn scan_library(
    fit_binary: &str,
    model_base: &str,
    max_parallel: u32,
    _gpus_total_mib: f64,
    provider_id: String,
    template: crate::templates::ProviderTemplate,
    base_config: crate::types::EngineConfig,
    progress_tx: Option<broadcast::Sender<FitScanProgress>>,
    cancelled: StdArc<AtomicBool>,
) -> FitScanComplete {
    let models = find_gguf_models(model_base);
    let total = models.len();

    if total == 0 {
        return FitScanComplete {
            provider_id,
            total_models: 0,
            completed: 0,
            failed: 0,
            results: HashMap::new(),
        };
    }

    let semaphore = StdArc::new(Semaphore::new(max_parallel as usize));
    let mut results_map: HashMap<String, FitAnchorResults> = HashMap::with_capacity(total);
    let completed_count = StdArc::new(TokioMutex::new(0usize));
    let failed_count = StdArc::new(TokioMutex::new(0usize));

    // Anchor definitions: (ctx_size_label, kv_quant) — template maps ctx label via CTX_TO_INT
    // Note: llama-fit-params -ctk only accepts: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1
    const ANCHORS: &[(&str, &str)] = &[
        ("8K", "f16"),      // A: small ctx / f16 KV
        ("128K", "f16"),    // B: large ctx / f16 KV
        ("128K", "q4_0"),   // C: large ctx / q4_0 KV (quantized, binary-compatible)
    ];

    // Derive GPU mask from base_config — same logic as launch_engine
    let gpu_count = detect_gpu_count();
    let gpu_mask = compute_gpu_mask(&base_config, gpu_count);

    let mut handles = vec![];

    for model_path in models {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }

        let sem = semaphore.clone();
        let fit_bin = fit_binary.to_string();
        let tmpl = template.clone();
        let cfg = base_config.clone();
        let gpu_mask_str = gpu_mask.clone();
        let comp_count = completed_count.clone();
        let _fail_count = failed_count.clone();
        let cancel = cancelled.clone();
        let prog_tx = progress_tx.clone();

        let handle = tokio::spawn(async move {
            if cancel.load(Ordering::Relaxed) {
                return None as Option<(String, FitAnchorResults)>;
            }

            let _permit = match sem.acquire().await {
                Ok(p) => p,
                Err(_) => return None as Option<(String, FitAnchorResults)>,
            };

            if cancel.load(Ordering::Relaxed) {
                return None as Option<(String, FitAnchorResults)>;
            }

            let model_name = extract_model_name(&model_path);

            // Build args for anchor A (for progress display)
            let mut cfg_a = cfg.clone();
            cfg_a.ctx_size = ANCHORS[0].0.to_string();
            cfg_a.kv_quant = ANCHORS[0].1.to_string();
            let args_a = build_fit_args_from_template(&tmpl, &cfg_a, &model_path, &gpu_mask_str);
            let args_str = args_a.join(" ");

            // Emit scanning progress
            if let Some(tx) = &prog_tx {
                let _ = tx.send(FitScanProgress {
                    model_path: model_path.clone(),
                    model_name: model_name.clone(),
                    status: "scanning".to_string(),
                    args: Some(args_str),
                    vram_mib: None,
                });
            }

            // Scan 3 anchors with progress between each
            let mut anchor_results = FitAnchorResults {
                model_path: model_path.clone(),
                anchor_a_mib: None,
                anchor_b_mib: None,
                anchor_c_mib: None,
                error: None,
            };

            let mut failures = Vec::new();

            // Anchor A
            match scan_single_anchor(&fit_bin, &args_a, &gpu_mask_str).await {
                Ok(vram) => {
                    anchor_results.anchor_a_mib = Some(vram);
                    if let Some(tx) = &prog_tx {
                        let _ = tx.send(FitScanProgress {
                            model_path: model_path.clone(),
                            model_name: model_name.clone(),
                            status: "complete".to_string(),
                            args: None,
                            vram_mib: Some(vram),
                        });
                    }
                },
                Err(e) => {
                    failures.push(format!("A:{}", e));
                    log::warn!("Anchor A failed for {}: {}", model_path, e);
                },
            }

            // Anchor B
            let mut cfg_b = cfg.clone();
            cfg_b.ctx_size = ANCHORS[1].0.to_string();
            cfg_b.kv_quant = ANCHORS[1].1.to_string();
            let args_b = build_fit_args_from_template(&tmpl, &cfg_b, &model_path, &gpu_mask_str);

            match scan_single_anchor(&fit_bin, &args_b, &gpu_mask_str).await {
                Ok(vram) => {
                    anchor_results.anchor_b_mib = Some(vram);
                    if let Some(tx) = &prog_tx {
                        let _ = tx.send(FitScanProgress {
                            model_path: model_path.clone(),
                            model_name: model_name.clone(),
                            status: "complete".to_string(),
                            args: None,
                            vram_mib: Some(vram),
                        });
                    }
                },
                Err(e) => {
                    failures.push(format!("B:{}", e));
                    log::warn!("Anchor B failed for {}: {}", model_path, e);
                },
            }

            // Anchor C
            let mut cfg_c = cfg.clone();
            cfg_c.ctx_size = ANCHORS[2].0.to_string();
            cfg_c.kv_quant = ANCHORS[2].1.to_string();
            let args_c = build_fit_args_from_template(&tmpl, &cfg_c, &model_path, &gpu_mask_str);

            match scan_single_anchor(&fit_bin, &args_c, &gpu_mask_str).await {
                Ok(vram) => {
                    anchor_results.anchor_c_mib = Some(vram);
                    if let Some(tx) = &prog_tx {
                        let _ = tx.send(FitScanProgress {
                            model_path: model_path.clone(),
                            model_name,
                            status: "complete".to_string(),
                            args: None,
                            vram_mib: Some(vram),
                        });
                    }
                },
                Err(e) => {
                    failures.push(format!("C:{}", e));
                    log::warn!("Anchor C failed for {}: {}", model_path, e);
                },
            };

            // Store error message if any anchor failed
            if !failures.is_empty() {
                anchor_results.error = Some(failures.join(" | "));
            }

            // Update completed count (model was processed, even if anchors failed)
            {
                let mut c = comp_count.lock().await;
                *c += 1;
            }

            Some((model_path.clone(), anchor_results))
        });

        handles.push(handle);
    }

    // Collect results
    for handle in handles {
        match handle.await {
            Ok(Some((path, anchors))) => {
                results_map.insert(path, anchors);
            }
            Ok(None) => {} // Semaphore was closed or cancelled
            Err(e) => {
                log::error!("Library scan task panicked: {}", e);
                let mut f = failed_count.lock().await;
                *f += 1;
            }
        }
    }

    let completed = *completed_count.lock().await;
    let failed = *failed_count.lock().await;

    // Persist all results to cache
    save_library_results_to_cache(&results_map);

    FitScanComplete {
        provider_id,
        total_models: total,
        completed,
        failed,
        results: results_map,
    }
}

// ── Cache Management ────────────────────────────────────────────────

/// Load fit cache from disk.
pub fn load_fit_cache() -> Option<HashMap<String, FitCacheData>> {
    let cache_path = cache_path();
    if !cache_path.exists() {
        return None;
    }
    let content = std::fs::read_to_string(&cache_path).ok()?;
    serde_json::from_str(&content).ok()
}

/// Save fit cache to disk.
pub fn save_fit_cache(cache: &HashMap<String, FitCacheData>) {
    if let Some(app_dir) = dirs::config_dir() {
        let cache_path = app_dir.join("blackwell-ops").join("fit_cache.json");
        if let Some(dir) = cache_path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(cache) {
            let _ = std::fs::write(&cache_path, json);
        }
    }
}

/// Clear the fit cache entirely.
pub fn clear_fit_cache() -> bool {
    if let Some(app_dir) = dirs::config_dir() {
        let cache_path = app_dir.join("blackwell-ops").join("fit_cache.json");
        return std::fs::remove_file(&cache_path).is_ok();
    }
    false
}

fn cache_path() -> PathBuf {
    if let Some(app_dir) = dirs::config_dir() {
        app_dir.join("blackwell-ops").join("fit_cache.json")
    } else {
        // Fallback: use current user's local app data directory
        std::env::var("LOCALAPPDATA")
            .ok()
            .map(|d| PathBuf::from(d).join("blackwell-ops").join("fit_cache.json"))
            .unwrap_or_else(|| PathBuf::from("fit_cache.json"))
    }
}

/// Cache data stored per model — holds the VramProfile and metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FitCacheData {
    pub profile: VramProfile,
    #[serde(default)]
    pub created_at: u64,
    /// SHA256 hash of first 8KB of model file — detects quantization swaps.
    #[serde(default)]
    pub model_hash: String,
}

impl FitCacheData {
    pub fn new(profile: VramProfile) -> Self {
        Self {
            profile,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            model_hash: String::new(),
        }
    }

    pub fn with_hash(profile: VramProfile, model_path: &str) -> Self {
        let hash = compute_model_hash(model_path);
        Self {
            profile,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            model_hash: hash,
        }
    }
}

/// Look up a model's VRAM profile from cache by hash (primary) or path (fallback for old entries).
pub fn get_cached_profile(cache: &HashMap<String, FitCacheData>, model_path: &str) -> Option<VramProfile> {
    let hash = compute_model_hash(model_path);
    // Try hash key first (new format)
    if let Some(data) = cache.get(&hash) {
        if data.model_hash == hash {
            return Some(data.profile.clone());
        }
    }
    // Fallback: path key (old format, backward compat)
    cache.get(model_path).map(|d| d.profile.clone())
}

/// Save anchor scan results to the permanent cache with hash-based key.
pub fn save_anchor_results_to_cache(
    cache: &mut HashMap<String, FitCacheData>,
    model_path: &str,
    results: &FitAnchorResults,
) {
    if let Some(profile) = build_profile(results) {
        // Remove old path-keyed entry if it exists
        cache.remove(model_path);
        let hash = compute_model_hash(model_path);
        cache.insert(hash, FitCacheData::with_hash(profile, model_path));
    }
}

/// Save a single scan result to the permanent cache.
/// Smart logic: complements existing partial profiles rather than overwriting them.
/// If we have 2/3 anchors and add the 3rd, it promotes to a full VramProfile.
pub fn save_single_scan_to_cache(model_path: &str, ctx: usize, kv_quant: &str, vram_mib: f64) {
    let mut cache = load_fit_cache().unwrap_or_default();

    // Determine which anchor this scan matches
    const ANCHOR_A_CTX: usize = 8192;
    const ANCHOR_B_CTX: usize = 131072;
    let is_anchor_a = (ctx == ANCHOR_A_CTX) && kv_quant.to_lowercase() == "f16";
    let is_anchor_b = (ctx == ANCHOR_B_CTX) && kv_quant.to_lowercase() == "f16";
    let is_anchor_c = (ctx == ANCHOR_B_CTX) && kv_quant.to_lowercase() == "q4_0";

    if !is_anchor_a && !is_anchor_b && !is_anchor_c {
        return; // Not a recognized anchor point — skip caching
    }

    // Look up existing by hash or path (backward compat)
    let hash = compute_model_hash(model_path);
    let existing = cache.get(&hash).or_else(|| cache.get(model_path)).map(|d| d.profile.clone());

    let (mut anchor_a, mut anchor_b, mut anchor_c) = match existing {
        Some(p) => (p.anchor_a_mib, p.anchor_b_mib, p.anchor_c_mib),
        None => (0.0, 0.0, 0.0),
    };

    // Slot the new value into the correct anchor
    if is_anchor_a { anchor_a = vram_mib; }
    if is_anchor_b { anchor_b = vram_mib; }
    if is_anchor_c { anchor_c = vram_mib; }

    // Only save if we have a complete profile (all 3 anchors non-zero)
    if anchor_a > 0.0 && anchor_b > 0.0 && anchor_c > 0.0 {
        // Remove old path-keyed entry
        cache.remove(model_path);
        cache.insert(hash, FitCacheData::with_hash(VramProfile {
            anchor_a_mib: anchor_a,
            anchor_b_mib: anchor_b,
            anchor_c_mib: anchor_c,
        }, model_path));
        save_fit_cache(&cache);
    }
}

/// Persist all library scan results to the permanent cache.
fn save_library_results_to_cache(results_map: &HashMap<String, FitAnchorResults>) {
    let mut cache = load_fit_cache().unwrap_or_default();
    for (model_path, anchor_results) in results_map {
        save_anchor_results_to_cache(&mut cache, model_path, anchor_results);
    }
    save_fit_cache(&cache);
}

/// Estimate VRAM for a model at given context/KV using cached profile.
pub fn estimate_from_cache(
    cache: &HashMap<String, FitCacheData>,
    model_path: &str,
    ctx: usize,
    kv_quant: &str,
) -> Option<f64> {
    get_cached_profile(cache, model_path).map(|p| p.estimate_vram_mib(ctx, kv_quant))
}
