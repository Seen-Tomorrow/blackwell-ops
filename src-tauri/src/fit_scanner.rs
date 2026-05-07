//! FIT Scanner Engine — hardware-probe VRAM estimation using llama-fit-params.exe.
//!
//! Reuses the same template-driven command building as engine launch (templates::build_command).
//! Only difference: binary swapped to llama-fit-params.exe, --fit off appended, -m/--port replaced.
//! 21-scan comprehensive strategy per model to measure all parameter axes.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    /// All measured data points (~21 per model).
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
}

#[derive(Debug, Clone, Serialize)]
pub struct FitScanComplete {
    pub provider_id: String,
    pub total_models: usize,
    pub completed: usize,
    pub failed: usize,
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
            "-m" | "--mmproj" | "--port" | "--reasoning" | "--rope-scaling" | "--rope-scale" | "--yarn-orig-ctx" | "--rope-freq-base" => { iter.next(); }
            // Boolean flags (no value) — drop entirely
            "--jinja" | "--cont-batching" | "--metrics" | "--verbose" | "--no-mmap" | "--log-timestamps" => {}
            _ => args.push(arg),
        }
    }

    // Mirror -ctk to -ctv: vision KV cache quant must match text KV quant for accurate estimation.
    let mut final_args = Vec::with_capacity(args.len() + 2);
    let mut iter2 = args.into_iter();
    while let Some(arg) = iter2.next() {
        if arg == "-ctk" {
            final_args.push("-ctk".into());
            if let Some(ctk_val) = iter2.next() {
                final_args.push(ctk_val.clone());
                // Mirror to -ctv
                final_args.push("-ctv".into());
                final_args.push(ctk_val);
            }
        } else {
            final_args.push(arg);
        }
    }

    // Prepend actual model path and --fit off
    let mut result = Vec::with_capacity(final_args.len() + 4);
    result.extend(["-m".into(), model_path.into()]);
    result.extend(["--fit".into(), "off".into()]);
    result.extend(final_args);

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

/// Raw result from a single FIT scan — total + optional per-GPU breakdown.
#[derive(Debug, Clone)]
pub struct FitScanRaw {
    pub vram_mib: f64,
    pub gpu_breakdown_mib: Option<Vec<f64>>,
    pub host_mib: Option<f64>,
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

    eprintln!("//DEBUG [FIT_OK] {} -> {:.1} MiB | GPUs={:?} Host={:?}",
        model_path, vram_mib, gpu_breakdown_mib, host_mib);

    Ok(FitScanRaw { vram_mib, gpu_breakdown_mib, host_mib })
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
fn parse_fit_breakdown(output: &str) -> (Option<Vec<f64>>, Option<f64>) {
    let mut gpu_values: Vec<f64> = Vec::new();
    let mut host_val: Option<f64> = None;

    for line in output.lines() {
        let lower = line.to_lowercase();
        if !lower.contains("memory breakdown") {
            continue;
        }

        // CUDA device line: | - CUDA0 ... | TOTAL = FREE + ( SELF = MODEL + CTX + COMPUTE ) + UNACCOUNTED |
        if lower.contains("cuda") {
            if let Some(start) = line.find('(') {
                if let Some(end) = line[start..].find(')') {
                    let inner = &line[start + 1..start + end];
                    // First number in parens is the self total (e.g., "605" from "605 = 440 + 24 + 141")
                    if let Some(val) = extract_number(inner.trim()) {
                        gpu_values.push(val);
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
                    host_val = extract_number(after_pipe);
                } else if let Some(first_pipe) = line.find("Host") {
                    // Try extracting from between pipes: | - Host | 470 = ...
                    let rest = &line[first_pipe..];
                    if let Some(second_pipe) = rest[4..].find('|') {
                        let between = rest[4 + second_pipe + 1..].trim();
                        host_val = extract_number(between);
                    }
                }
            }
        }
    }

    let gpu_breakdown = if gpu_values.is_empty() { None } else { Some(gpu_values) };
    (gpu_breakdown, host_val)
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

/// Scan an entire library of models with parallel execution.
/// Comprehensive 21-scan strategy per model to measure all parameter axes.
pub async fn scan_library(
    fit_binary: &str,
    model_paths: &[String],
    max_parallel: u32,
    _gpus_total_mib: f64,
    provider_id: String,
    template: crate::templates::ProviderTemplate,
    base_config: crate::types::EngineConfig,
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
            results: HashMap::new(),
        };
    }

    // Comprehensive scan plan — 21 deduplicated data points per model.
    // Base config: batch=512, parallel=1, split_mode="none", flash_attn=true (from base_config).
    // Each tuple: (label, ctx_label, kv_quant, batch, parallel, split_mode)
    const SCAN_PLAN: &[(&str, &str, &str, u32, u32, &str)] = &[
        // 1. Base weights + small KV
        ("base", "8K", "q4_0", 512, 1, "none"),
        // 2-4. Quant anchors at 128K (f16, q8_0, q4_0) — captures non-linearity curve
        ("quant_f16", "128K", "f16", 512, 1, "none"),
        ("quant_q8", "128K", "q8_0", 512, 1, "none"),
        ("quant_q4", "128K", "q4_0", 512, 1, "none"),
        // 5-10. CTX sweep at q4_0 (6 sizes, 8K and 128K already covered)
        ("ctx_16k", "16K", "q4_0", 512, 1, "none"),
        ("ctx_32k", "32K", "q4_0", 512, 1, "none"),
        ("ctx_64k", "64K", "q4_0", 512, 1, "none"),
        ("ctx_256k", "256K", "q4_0", 512, 1, "none"),
        ("ctx_512k", "512K", "q4_0", 512, 1, "none"),
        ("ctx_1m", "1M", "q4_0", 512, 1, "none"),
        // 11-16. Batch sweep at 128K/q4 (6 sizes, 512 already covered)
        ("batch_128", "128K", "q4_0", 128, 1, "none"),
        ("batch_256", "128K", "q4_0", 256, 1, "none"),
        ("batch_1024", "128K", "q4_0", 1024, 1, "none"),
        ("batch_2048", "128K", "q4_0", 2048, 1, "none"),
        ("batch_4096", "128K", "q4_0", 4096, 1, "none"),
        ("batch_8192", "128K", "q4_0", 8192, 1, "none"),
        // 17-19. Parallel sweep at 128K/q4/b512 (3 values, parallel=1 already covered)
        ("parallel_2", "128K", "q4_0", 512, 2, "none"),
        ("parallel_4", "128K", "q4_0", 512, 4, "none"),
        ("parallel_8", "128K", "q4_0", 512, 8, "none"),
        // 20-21. Split tax at base config (layer + row)
        ("split_layer", "128K", "q4_0", 512, 1, "layer"),
        ("split_row", "128K", "q4_0", 512, 1, "row"),
    ];

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

        // Extract existing data before spawning — owned copies to avoid borrow issues
        let existing_full: Option<FitScanFull> = existing_data.get(&model_path).cloned();
        let existing_labels: Vec<String> = existing_full.as_ref().map(|e| {
            e.points.iter().map(|p| p.label.clone()).collect()
        }).unwrap_or_default();
        let needs_scan = existing_labels.len() < SCAN_PLAN.len();

        // If model already has all points, copy without rescanning
        if !needs_scan {
            if let Some(existing) = existing_full {
                tokio::spawn({
                    let full_map = full_results_map.clone();
                    async move {
                        let mut map = full_map.lock().await;
                        map.insert(model_path.clone(), existing);
                    }
                });
                continue;
            }
        }

        // Which labels still need scanning?
        let missing_labels: Vec<String> = if needs_scan {
            SCAN_PLAN.iter().map(|p| p.0.to_string()).collect()
        } else {
            let existing_set: std::collections::HashSet<&str> =
                existing_labels.iter().map(|s| s.as_str()).collect();
            SCAN_PLAN.iter()
                .filter(|p| !existing_set.contains(p.0))
                .map(|p| p.0.to_string())
                .collect()
        };

        // Existing points to carry forward for incremental scan
        let existing_points: Vec<FitDataPoint> = existing_full.map(|e| e.points).unwrap_or_default();

        let sem = semaphore.clone();
        let fit_bin = fit_binary.to_string();
        let tmpl = template.clone();
        let cfg = base_config.clone();
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
            let mut points: Vec<FitDataPoint> = if needs_scan {
                Vec::with_capacity(SCAN_PLAN.len())
            } else {
                existing_points.clone()
            };
            let mut failures = Vec::new();

            for (label, ctx_label, kv_q, batch_val, parallel_val, split_val) in SCAN_PLAN {
                if cancel.load(Ordering::Relaxed) {
                    break;
                }

                // Skip already-scanned labels for incremental update
                if !missing_labels.iter().any(|l| l.as_str() == *label) {
                    continue;
                }

                // Compute GPU mask per-scan-point: split mode needs all GPUs visible
                let scan_cfg_split = (*split_val).to_string();
                let point_gpu_mask = if scan_cfg_split != "none" && !scan_cfg_split.is_empty() {
                    (0..gpu_count).map(|i| i.to_string()).collect::<Vec<_>>().join(",")
                } else {
                    compute_gpu_mask(&cfg, gpu_count)
                };

                // Build config for this scan point
                let mut scan_cfg = cfg.clone();
                scan_cfg.ctx_size = (*ctx_label).to_string();
                scan_cfg.kv_quant = (*kv_q).to_string();
                scan_cfg.batch = *batch_val as i64;
                scan_cfg.ubatch = *batch_val as i64; // ubatch mirrors batch for fit scan
                scan_cfg.parallel = *parallel_val as i64;
                scan_cfg.split_mode = scan_cfg_split.clone();

                let args = build_fit_args_from_template(&tmpl, &scan_cfg, &model_path, &point_gpu_mask);

                // Emit progress before scan
                if let Some(tx) = &prog_tx {
                    let _ = tx.send(FitScanProgress {
                        model_path: model_path.clone(),
                        model_name: model_name.clone(),
                        status: "scanning".to_string(),
                        args: Some(args.join(" ")),
                        vram_mib: None,
                    });
                }

                match scan_single_anchor(&fit_bin, &args, &point_gpu_mask).await {
                    Ok(raw) => {
                        // Parse ctx to int for data point
                        let ctx_int = crate::templates::ProviderTemplate::ctx_to_int_str(ctx_label)
                            .parse::<usize>()
                            .unwrap_or(8192);

                        points.push(FitDataPoint {
                            label: (*label).to_string(),
                            ctx: ctx_int,
                            kv_quant: (*kv_q).to_string(),
                            batch: *batch_val,
                            parallel: *parallel_val,
                            split_mode: scan_cfg_split.clone(),
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
        results: final_results,
    }
}

// ── Full Scan Export ────────────────────────────────────────────────
fn full_scan_export_path() -> PathBuf {
    if let Some(app_dir) = dirs::config_dir() {
        app_dir.join("blackwell-ops").join("fit_scan_full.json")
    } else {
        std::env::var("LOCALAPPDATA")
            .ok()
            .map(|d| PathBuf::from(d).join("blackwell-ops").join("fit_scan_full.json"))
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
