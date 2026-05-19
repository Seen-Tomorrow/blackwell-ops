//! FIT Scanner Engine — hardware-probe VRAM estimation using llama-fit-params.exe.
//!
//! Self-contained scan plan with hardcoded GGML-compatible CLI commands.
//! No template system involvement — directly builds args for llama-fit-params.exe.

use crate::telemetry::detect_gpu_count;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc as StdArc;
use tokio::process::Command;
use tokio::sync::{broadcast, Semaphore};
use tokio::sync::Mutex as TokioMutex;

// ── Constants ───────────────────────────────────────────────

pub const FIT_OVERHEAD_PER_GPU: f64 = 256.0; // MiB static overhead per GPU for CUDA context/P2P
const SCAN_TIMEOUT_SECS: u64 = 30;

/// The complete scan plan — essential data points per model.
/// All points run with flash attention ON (required for non-f16 KV quant on modern architectures).
/// Tuple: (label, ctx_tokens, kv_quant, batch, parallel, split_mode)
const SCAN_PLAN: &[(&str, usize, &str, u32, u32, &str)] = &[
    // === BASELINE — weights + KV + CUDA overhead isolation ===
    ("base_no_batch", 8192, "q4_0", 1, 1, "none"),
    ("base", 8192, "q4_0", 512, 1, "none"),

    // === KV QUANT CURVE — how VRAM changes with KV quantization ===
    ("quant_f16", 131072, "f16", 512, 1, "none"),
    ("quant_q8", 131072, "q8_0", 512, 1, "none"),
    ("quant_q4", 131072, "q4_0", 512, 1, "none"),

    // === CONTEXT SWEEP — KV growth rate across all sizes ===
    ("ctx_4k", 4096, "q4_0", 512, 1, "none"),
    ("ctx_8k", 8192, "q4_0", 512, 1, "none"),
    ("ctx_16k", 16384, "q4_0", 512, 1, "none"),
    ("ctx_32k", 32768, "q4_0", 512, 1, "none"),
    ("ctx_64k", 65536, "q4_0", 512, 1, "none"),
    ("ctx_128k", 131072, "q4_0", 512, 1, "none"),
    ("ctx_256k", 262144, "q4_0", 512, 1, "none"),
    ("ctx_512k", 524288, "q4_0", 512, 1, "none"),
    ("ctx_1m", 1048576, "q4_0", 512, 1, "none"),

    // === BATCH SWEEP — activation memory curve ===
    ("batch_128", 131072, "q4_0", 128, 1, "none"),
    ("batch_256", 131072, "q4_0", 256, 1, "none"),
    ("batch_1k", 131072, "q4_0", 1024, 1, "none"),
    ("batch_2k", 131072, "q4_0", 2048, 1, "none"),
    ("batch_4k", 131072, "q4_0", 4096, 1, "none"),
    ("batch_8k", 131072, "q4_0", 8192, 1, "none"),

    // === PARALLEL SWEEP — per-sequence overhead ===
    ("parallel_2", 131072, "q4_0", 512, 2, "none"),
    ("parallel_4", 131072, "q4_0", 512, 4, "none"),
    ("parallel_8", 131072, "q4_0", 512, 8, "none"),

    // === SPLIT TAX — multi-GPU communication overhead at various contexts ===
    ("split_layer_64k", 65536, "q4_0", 512, 1, "layer"),
    ("split_row_64k", 65536, "q4_0", 512, 1, "row"),
    ("split_layer_256k", 262144, "q4_0", 512, 1, "layer"),
    ("split_row_256k", 262144, "q4_0", 512, 1, "row"),

    // === EDGE CASES — large batch + large context combos ===
    ("heavy_256k_b2k", 262144, "q4_0", 2048, 1, "none"),
    ("heavy_1m_b1k", 1048576, "q4_0", 1024, 1, "none"),
];

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
    /// Per-GPU self MiB breakdown from memory table (when multi-GPU scan).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_breakdown_mib: Option<Vec<f64>>,
    /// Host RAM usage from memory table.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_mib: Option<f64>,
    /// Per-GPU component breakdown (model/ctx/compute) from memory table.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_components_mib: Option<Vec<GpuComponentMib>>,
}

/// Per-GPU component breakdown parsed from llama's memory table.
/// Format per GPU line: (SELF = MODEL + CTX + COMPUTE)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuComponentMib {
    /// Model weights VRAM in MiB.
    pub model_mib: f64,
    /// KV cache VRAM in MiB.
    pub ctx_mib: f64,
    /// Compute/buffer overhead VRAM in MiB.
    pub compute_mib: f64,
}

/// Single measured data point from a comprehensive scan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FitDataPoint {
    /// Human-readable label identifying the test category.
    pub label: String,
    /// Context size in tokens.
    pub ctx: usize,
    /// KV quantization level.
    pub kv_quant: String,
    /// Batch size.
    pub batch: u32,
    /// Parallel sequences.
    pub parallel: u32,
    /// Split mode ("none", "layer", "row").
    pub split_mode: String,
    /// Measured VRAM in MiB.
    pub vram_mib: f64,
}

/// Full comprehensive scan result for one model — all measured data points.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FitScanFull {
    pub model_path: String,
    /// All measured data points.
    pub points: Vec<FitDataPoint>,
    /// Error message if any scan failed.
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
    /// Scan point label (e.g., "base", "ctx_128k") — set on "complete" events.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FitScanComplete {
    pub provider_id: String,
    pub total_models: usize,
    pub completed: usize,
    pub failed: usize,
    /// Number of scan points per model (derived from SCAN_PLAN.len()).
    pub scan_points_total: usize,
    /// Per-model full scan results keyed by model path.
    pub results: HashMap<String, FitScanFull>,
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

// ── Command Builder ────────────────────────────────────────────────

/// Build CLI args for llama-fit-params.exe directly — no template system involvement.
pub fn build_fit_command(
    model_path: &str,
    ctx_tokens: usize,
    kv_quant: &str,
    batch: u32,
    ubatch: u32,
    parallel: u32,
    split_mode: &str,
) -> Vec<String> {
    let mut args = vec![
        "-m".into(),
        model_path.into(),
        "--fit".into(),
        "off".into(),
        // Force all layers onto GPU — prevents llama-fit-params from auto-calculating ngl
        // and offloading layers. We need the TRUE total VRAM requirement per scan point,
        // not a "fitted" result after internal layer reduction.
        "--n-gpu-layers".into(), "999".into(),
        // KV quant (both K and V for accurate estimation)
        "--cache-type-k".into(), kv_quant.to_lowercase().into(),
        "--cache-type-v".into(), kv_quant.to_lowercase().into(),
        // Context size
        "--ctx-size".into(), ctx_tokens.to_string(),
        // Batch sizes
        "--batch-size".into(), batch.to_string(),
        "--ubatch-size".into(), ubatch.to_string(),
    ];

    // Parallel (only if > 1)
    if parallel > 1 {
        args.extend(["--parallel".into(), parallel.to_string()]);
    }

    // Split mode (only if not "none")
    if !split_mode.is_empty() && split_mode.to_lowercase() != "none" {
        args.extend(["--split-mode".into(), split_mode.to_lowercase().into()]);
    }

    // Flash attention — always ON (required for non-f16 KV quant on modern architectures)
    args.extend(["--flash-attn".into(), "on".into()]);

    args
}

// ── Output Parsing ────────────────────────────────────────────────

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

/// Strip ANSI escape sequences from a string.
fn strip_ansi(s: &str) -> String {
    s.chars().scan(false, |in_esc, ch| {
        if *in_esc {
            if ch == 'm' { *in_esc = false; }
            None
        } else if ch == '\x1b' || ch == '\u{001B}' {
            *in_esc = true;
            None
        } else {
            Some(ch)
        }
    }).collect()
}

/// Extract a numeric value from llama-fit-params output.
/// Mode 1 (keyword anchor): find the number immediately before "MiB"/"MB"/"MI B".
///   Handles any prefix noise — timestamps, log levels, ANSI codes, future format changes.
/// Mode 2 (fallback): first valid single-decimal number in the string.
///   Used by breakdown parsers that pass clean substrings like "459 + 46 + 121".
fn extract_number(s: &str) -> Option<f64> {
    // Mode 1: keyword anchor — find number before unit marker
    let lower = s.to_lowercase();
    for marker in &["mib", "mb ", "mi b"] {
        if let Some(pos) = lower.find(marker) {
            let before = strip_ansi(&s[..pos]).trim_end().to_string();
            // Collect digits, dots, commas from the end of the prefix (the numeric token)
            let mut num_chars = String::new();
            for ch in before.chars().rev() {
                if ch.is_ascii_digit() || ch == '.' || ch == ',' {
                    num_chars.push(ch);
                } else {
                    break;
                }
            }
            // Reverse back to normal order
            let reversed: String = num_chars.chars().rev().collect();
            if !reversed.is_empty() && reversed.matches('.').count() <= 1 {
                if let Ok(val) = reversed.replace(',', "").parse::<f64>() {
                    return Some(val);
                }
            }
        }
    }

    // Mode 2: fallback — first valid number (at most one decimal point, rejects timestamps like "0.00.483.965")
    let cleaned = strip_ansi(s).trim().to_string();
    let mut started = false;
    let mut num_chars = String::new();
    for ch in cleaned.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            started = true;
            num_chars.push(ch);
        } else if started {
            break;
        }
    }
    if started && !num_chars.is_empty() && num_chars.matches('.').count() <= 1 {
        return num_chars.replace(',', "").parse::<f64>().ok();
    }
    None
}

/// Raw result from a single FIT scan — total + optional per-GPU breakdown.
#[derive(Debug, Clone)]
pub struct FitScanRaw {
    pub vram_mib: f64,
    pub gpu_breakdown_mib: Option<Vec<f64>>,
    pub host_mib: Option<f64>,
    /// Per-GPU component breakdown (model/ctx/compute).
    pub gpu_components_mib: Option<Vec<GpuComponentMib>>,
}

/// Scan a single model at one anchor point with pre-built CLI args.
pub async fn scan_single_anchor(
    fit_binary: &str,
    args: &[String],
    cuda_visible_devices: &str,
) -> Result<FitScanRaw, String> {
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
        .args(crate::types::LLAMA_DIAGNOSTIC_FLAGS.iter().map(|s| s.to_string()))
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

    let vram_mib = if let Some(v) = parse_fit_output(&combined_output) {
        v
    } else if let Some(projected) = parse_projected_vram(&combined_output) {
        eprintln!("//DEBUG [FIT_PARTIAL] {} -> {:.1} MiB (projected, doesn't fit single GPU)", model_path, projected);
        projected
    } else {
        log::warn!("Fit scan parse failed for {}: exit={:?}", model_path, output.status.code());
        return Err(format!(
            "Could not parse VRAM from fit output. Exit code: {:?}",
            output.status.code()
        ));
    };

    let (gpu_breakdown_mib, host_mib) = parse_fit_breakdown(&combined_output);
    let gpu_components_mib = parse_gpu_components(&combined_output);

    eprintln!("//DEBUG [FIT_OK] {} -> {:.1} MiB | GPUs={:?} Host={:?}",
        model_path, vram_mib, gpu_breakdown_mib, host_mib);
    
    // Debug GPU components
    if let Some(ref comps) = gpu_components_mib {
        for (i, c) in comps.iter().enumerate() {
            eprintln!("//DEBUG [GPU_COMP] GPU{}: model={:.0} ctx={:.0} compute={:.0}", 
                i, c.model_mib, c.ctx_mib, c.compute_mib);
        }
    } else {
        eprintln!("//DEBUG [GPU_COMP] No components parsed from output");
    }

    Ok(FitScanRaw { vram_mib, gpu_breakdown_mib, host_mib, gpu_components_mib })
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

/// Parse per-GPU self MiB and host RAM from memory breakdown table.
/// Returns (gpu_breakdown, host_mib).
///
/// llama-fit-params prints multiple memory tables during its iterative fitting algorithm.
/// We only want the LAST table — it represents the final fitted configuration.
fn parse_fit_breakdown(output: &str) -> (Option<Vec<f64>>, Option<f64>) {
    let mut last_gpu_values: Vec<f64> = Vec::new();
    let mut last_host_val: Option<f64> = None;

    for line in output.lines() {
        let lower = line.to_lowercase();
        if !lower.contains("memory breakdown") {
            continue;
        }

        // A new memory breakdown table starts with the header line.
        // The header contains "memory breakdown" and "[mib]" but no "cuda" or "host".
        // Detect it by checking for the pipe-delimited header format: | memory breakdown [MiB] ... |
        if lower.contains("[mib]") || (lower.contains("total") && lower.contains("free") && lower.contains("self")) {
            // New table header — reset accumulators for this table
            last_gpu_values.clear();
            last_host_val = None;
            continue;
        }

        // CUDA device line: | - CUDA0 ... | TOTAL = FREE + ( SELF = MODEL + CTX + COMPUTE ) + UNACCOUNTED |
        if lower.contains("cuda") {
            if let Some(start) = line.find('(') {
                if let Some(end) = line[start..].find(')') {
                    let inner = &line[start + 1..start + end];
                    // First number in parens is the self total (e.g., "605" from "605 = 440 + 24 + 141")
                    if let Some(val) = extract_number(inner.trim()) {
                        last_gpu_values.push(val);
                    }
                }
            }
        }
        // Host line: | - Host | TOTAL = ...
        else if lower.contains("host") {
            // Find the number after "Host" pipe separator
            if let Some(pipe_pos) = line.rfind('|') {
                let after_pipe = &line[pipe_pos + 1..].trim();
                if !after_pipe.is_empty() {
                    last_host_val = extract_number(after_pipe);
                } else if let Some(first_pipe) = line.find("Host") {
                    // Try extracting from between pipes: | - Host | 470 = ...
                    let rest = &line[first_pipe..];
                    if let Some(second_pipe) = rest[4..].find('|') {
                        let between = rest[4 + second_pipe + 1..].trim();
                        last_host_val = extract_number(between);
                    }
                }
            }
        }
    }

    let gpu_breakdown = if last_gpu_values.is_empty() { None } else { Some(last_gpu_values) };
    (gpu_breakdown, last_host_val)
}

/// Parse per-GPU component breakdown from memory breakdown table.
/// Returns Vec<GpuComponentMib> with model/ctx/compute for each GPU.
///
/// llama-fit-params prints multiple memory tables during its iterative fitting algorithm.
/// We only want the LAST table — it represents the final fitted configuration.
fn parse_gpu_components(output: &str) -> Option<Vec<GpuComponentMib>> {
    let mut last_components: Vec<GpuComponentMib> = Vec::new();

    for line in output.lines() {
        let lower = line.to_lowercase();

        // Detect new memory breakdown table header — reset accumulators
        if lower.contains("memory breakdown") && (lower.contains("[mib]") || (lower.contains("total") && lower.contains("free") && lower.contains("self"))) {
            last_components.clear();
            continue;
        }

        // Skip unless it's a CUDA device line with memory breakdown table format
        if !lower.contains("cuda") || !line.contains('|') {
            continue;
        }

        // Find the LAST opening paren on this line (the component breakdown is near the end)
        // The "(RTX PRO...)" appears first, we want the numeric one like "(52794 = 50838 + 1152 + 804)"
        if let Some(last_open) = line.rfind('(') {
            if let Some(end_paren) = line[last_open..].find(')') {
                let inner = &line[last_open + 1..last_open + end_paren];

                // Must look like "52794 = 50838 + 1152 + 804" (number = number + number + number)
                if !inner.contains('=') || inner.matches('+').count() < 2 {
                    continue;
                }

                let parts: Vec<&str> = inner.split('+').map(|s| s.trim()).collect();
                if parts.len() >= 3 {
                    // First part has format "52794 = 50838", extract the last number
                    let first_part = parts[0];
                    if let Some(eq_pos) = first_part.find('=') {
                        let model_str = &first_part[eq_pos + 1..].trim();

                        if let (Some(model_mib), Some(ctx_mib), Some(compute_mib)) = (
                            extract_number(model_str),
                            extract_number(parts[1]),
                            extract_number(parts[2])
                        ) {
                            last_components.push(GpuComponentMib {
                                model_mib,
                                ctx_mib,
                                compute_mib,
                            });
                        }
                    }
                }
            }
        }
    }

    eprintln!("//DEBUG [GPU_COMPONENTS] parsed {} GPU components", last_components.len());

    if last_components.is_empty() { None } else { Some(last_components) }
}

// ── Library Scanner ─────────────────────────────────────────────────

/// Extract model name from full path (last component without .gguf).
pub fn extract_model_name(path: &str) -> String {
    PathBuf::from(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .trim_end_matches(".gguf")
        .to_string()
}

/// Find all models using the shared model_catalog logic (multi-path, shard dedup, mmproj filter).
fn find_all_models(paths: &[String]) -> Vec<String> {
    let path_entries: Vec<crate::types::ModelPathEntry> = paths.iter().enumerate().map(|(i, p)| {
        crate::types::ModelPathEntry {
            path: p.clone(),
            label: if i == 0 && !p.is_empty() { "Default".into() } else { format!("Path {}", i + 1) },
            is_default: i == 0,
        }
    }).collect();

    match crate::model_catalog::merge_catalogs(&path_entries) {
        Ok((entries, _conflicts)) => entries.into_iter().map(|e| e.path).collect(),
        Err(e) => {
            log::warn!("Failed to scan model paths: {}", e);
            Vec::new()
        }
    }
}

/// Find existing scan data for a model path, with filename fallback for robustness.
/// Handles path format differences (case, trailing slash, UNC prefix) between runs.
fn find_existing_scan(
    existing_data: &HashMap<String, FitScanFull>,
    model_path: &str,
) -> Option<FitScanFull> {
    // Try exact match first
    if let Some(e) = existing_data.get(model_path) {
        return Some(e.clone());
    }
    // Fallback: match by filename (handles path format differences between runs)
    let filename = PathBuf::from(model_path).file_name().and_then(|s| s.to_str()).map(String::from)?;
    let found = existing_data.values().find(|v| {
        PathBuf::from(&v.model_path).file_name()
            .and_then(|s| s.to_str())
            .map(String::from)
            .as_ref()
            == Some(&filename)
    });
    if let Some(e) = found {
        log::debug!("[FIT] Cache miss (exact), filename match: '{}' -> '{}'", model_path, e.model_path);
        return Some(e.clone());
    }
    log::debug!("[FIT] Cache miss (no data): '{}'", model_path);
    None
}

/// Scan an entire library of models with parallel execution.
pub async fn scan_library(
    fit_binary: &str,
    model_paths: &[String],
    max_parallel: u32,
    _gpus_total_mib: f64,
    provider_id: String,
    progress_tx: Option<broadcast::Sender<FitScanProgress>>,
    cancelled: StdArc<AtomicBool>,
) -> FitScanComplete {
    // Use shared model_catalog logic for multi-path scanning, shard dedup, mmproj filter
    let models = find_all_models(model_paths);
    let total = models.len();

    if total == 0 {
        return FitScanComplete {
            provider_id,
            total_models: 0,
            completed: 0,
            failed: 0,
            scan_points_total: SCAN_PLAN.len(),
            results: HashMap::new(),
        };
    }

    // Load existing full scan data for incremental update
    let existing_data = load_full_scan_export().unwrap_or_default();

    // GPU count for per-point mask computation
    let gpu_count = detect_gpu_count();

    let semaphore = StdArc::new(Semaphore::new(max_parallel as usize));
    let completed_count = StdArc::new(TokioMutex::new(0usize));
    let failed_count = StdArc::new(TokioMutex::new(0usize));

    // Full scan data for JSON export + IPC result
    let full_results_map: StdArc<TokioMutex<HashMap<String, FitScanFull>>> =
        StdArc::new(TokioMutex::new(HashMap::with_capacity(total)));

    let mut handles = vec![];

    for model_path in models {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }

        // Look up existing scan data with filename fallback for path robustness
        let existing_full: Option<FitScanFull> = find_existing_scan(&existing_data, &model_path);
        
        // Build a HashSet of existing labels for this model
        let existing_labels: HashSet<String> = existing_full.as_ref().map(|e| {
            e.points.iter().map(|p| p.label.clone()).collect()
        }).unwrap_or_default();

        // Build the set of SCAN_PLAN labels
        let plan_labels: HashSet<&str> = SCAN_PLAN.iter().map(|p| p.0).collect();

        // If ALL labels are present, skip the model entirely (copy existing data)
        let missing_labels: Vec<String> = if existing_labels.len() >= SCAN_PLAN.len() 
            && plan_labels.is_subset(&existing_labels.iter().map(|s| s.as_str()).collect()) {
            Vec::new()
        } else {
            // Only scan points whose label is NOT in the existing set
            SCAN_PLAN.iter()
                .filter(|p| !existing_labels.contains(p.0))
                .map(|p| p.0.to_string())
                .collect()
        };

        if missing_labels.is_empty() {
            // All points already scanned — insert directly (no spawn, avoids race with save)
            if let Some(existing) = existing_full {
                full_results_map.lock().await.insert(model_path.clone(), existing);
                continue;
            }
        }

        // Existing points to carry forward for incremental scan
        let existing_points: Vec<FitDataPoint> = existing_full.map(|e| e.points).unwrap_or_default();

        let sem = semaphore.clone();
        let fit_bin = fit_binary.to_string();
        let comp_count = completed_count.clone();
        let cancel = cancelled.clone();
        let prog_tx = progress_tx.clone();
        let full_map = full_results_map.clone();

        let handle = tokio::spawn(async move {
            if cancel.load(Ordering::Relaxed) {
                return None as Option<(String, FitScanFull)>;
            }

            let _permit = match sem.acquire().await {
                Ok(p) => p,
                Err(_) => return None as Option<(String, FitScanFull)>,
            };

            if cancel.load(Ordering::Relaxed) {
                return None as Option<(String, FitScanFull)>;
            }

            let model_name = extract_model_name(&model_path);

            // Start with existing points for incremental scan
            let mut points: Vec<FitDataPoint> = if missing_labels.is_empty() {
                Vec::with_capacity(SCAN_PLAN.len())
            } else {
                existing_points.clone()
            };
            let mut failures = Vec::new();

            for (label, ctx_tokens, kv_q, batch_val, parallel_val, split_val) in SCAN_PLAN {
                if cancel.load(Ordering::Relaxed) {
                    break;
                }

                // Skip already-scanned labels for incremental update
                if !missing_labels.iter().any(|l| l.as_str() == *label) {
                    continue;
                }

                // Compute GPU mask per-scan-point: split mode needs all GPUs visible
                let point_gpu_mask = if *split_val != "none" && !split_val.is_empty() {
                    (0..gpu_count).map(|i| i.to_string()).collect::<Vec<_>>().join(",")
                } else {
                    // Single GPU — use GPU-0 for scan points
                    "0".to_string()
                };

                // Build CLI args directly from scan plan parameters
                let args = build_fit_command(
                    &model_path, *ctx_tokens, kv_q, *batch_val, *batch_val, *parallel_val, split_val,
                );

                // Emit progress before scan
                if let Some(tx) = &prog_tx {
                    let _ = tx.send(FitScanProgress {
                        model_path: model_path.clone(),
                        model_name: model_name.clone(),
                        status: "scanning".to_string(),
                        args: Some(args.join(" ")),
                        vram_mib: None,
                        label: Some((*label).to_string()),
                    });
                }

                match scan_single_anchor(&fit_bin, &args, &point_gpu_mask).await {
                    Ok(raw) => {
                        points.push(FitDataPoint {
                            label: (*label).to_string(),
                            ctx: *ctx_tokens,
                            kv_quant: (*kv_q).to_string(),
                            batch: *batch_val,
                            parallel: *parallel_val,
                            split_mode: (*split_val).to_string(),
                            vram_mib: raw.vram_mib,
                        });

                        // Emit progress after scan
                        if let Some(tx) = &prog_tx {
                            let _ = tx.send(FitScanProgress {
                                model_path: model_path.clone(),
                                model_name: model_name.clone(),
                                status: "complete".to_string(),
                                args: None,
                                vram_mib: Some(raw.vram_mib),
                                label: Some((*label).to_string()),
                            });
                        }
                    },
                    Err(e) => {
                        failures.push(format!("{}:{}", label, e));
                        log::warn!("Scan {} failed for {}: {}", label, model_path, e);
                    },
                }
            }

            // Save full scan data to shared map + persist incrementally to disk
            let result = FitScanFull {
                model_path: model_path.clone(),
                points,
                error: if failures.is_empty() { None } else { Some(failures.join(" | ")) },
            };

            {
                let mut map = full_map.lock().await;
                map.insert(model_path.clone(), result.clone());
                // Incremental save so data persists mid-scan (not just at the end)
                save_full_scan_export(&map);
            }

            // Update completed count
            {
                let mut c = comp_count.lock().await;
                *c += 1;
            }

            Some((model_path.clone(), result))
        });

        handles.push(handle);
    }

    // Collect results — merge with existing data for models that were skipped
    let mut final_results: HashMap<String, FitScanFull> = full_results_map.lock().await.clone();

    for handle in handles {
        match handle.await {
            Ok(Some((path, scan_full))) => {
                final_results.insert(path, scan_full);
            }
            Ok(None) => {} // Semaphore was closed or cancelled
            Err(e) => {
                log::error!("Library scan task panicked: {}", e);
                let mut f = failed_count.lock().await;
                *f += 1;
            }
        }
    }

    let completed = final_results.len();
    let failed = *failed_count.lock().await;

    // Save comprehensive scan data to JSON for analysis + future incremental scans
    save_full_scan_export(&final_results);

    FitScanComplete {
        provider_id,
        total_models: total,
        completed,
        failed,
        scan_points_total: SCAN_PLAN.len(),
        results: final_results,
    }
}

// ── Full Scan Export ────────────────────────────────────────────────
fn full_scan_export_path() -> PathBuf {
    let name = if cfg!(debug_assertions) { "blackwell-ops-dev" } else { "blackwell-ops" };
    if let Some(app_dir) = dirs::config_dir() {
        app_dir.join(name).join("fit_scan_full.json")
    } else {
        std::env::var("LOCALAPPDATA")
            .ok()
            .map(|d| PathBuf::from(d).join(name).join("fit_scan_full.json"))
            .unwrap_or_else(|| PathBuf::from("fit_scan_full.json"))
    }
}

/// Clear the full scan export so next scan runs fresh (no incremental skip).
pub fn clear_full_scan_export() {
    let path = full_scan_export_path();
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
}

/// Save comprehensive scan data to JSON for offline analysis.
fn save_full_scan_export(full_data: &HashMap<String, FitScanFull>) {
    if full_data.is_empty() {
        return;
    }
    let path = full_scan_export_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(full_data) {
        let _ = std::fs::write(&path, json);
    }
}

/// Load comprehensive scan data from JSON export.
pub fn load_full_scan_export() -> Option<HashMap<String, FitScanFull>> {
    let path = full_scan_export_path();
    if !path.exists() {
        return None;
    }
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

/// Get raw FIT scan points for a model — used by diagnostics to show split mode measurements.
#[tauri::command]
pub fn get_fit_scan_points(model_path: String) -> Option<Vec<FitDataPoint>> {
    let data = load_full_scan_export()?;
    data.get(&model_path).map(|f| f.points.clone())
}
