//! FIT Scanner Engine — hardware-probe VRAM estimation using llama-fit-params.exe.
//!
//! Self-contained scan plan with hardcoded GGML-compatible CLI commands.
//! No template system involvement — directly builds args for llama-fit-params.exe.

use crate::log_hub::LogHub;
use crate::output_console::{BlackwellOutputConsoleCategory, BlackwellOutputConsoleLineStyle};
use crate::telemetry::detect_gpu_count;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc as StdArc;
use std::time::Duration;
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

    // === SPLIT TAX — multi-GPU communication overhead at various contexts ===
    ("split_layer_64k", 65536, "q4_0", 512, 1, "layer"),
    ("split_row_64k", 65536, "q4_0", 512, 1, "row"),
    ("split_tensor_64k", 65536, "q4_0", 512, 1, "tensor"),
    ("split_layer_256k", 262144, "q4_0", 512, 1, "layer"),
    ("split_row_256k", 262144, "q4_0", 512, 1, "row"),
    ("split_tensor_256k", 262144, "q4_0", 512, 1, "tensor"),

    // === EDGE CASES — large batch + large context combos ===
    ("heavy_256k_b2k", 262144, "q4_0", 2048, 1, "none"),
    ("heavy_1m_b1k", 1048576, "q4_0", 1024, 1, "none"),
];

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
    /// Model intentionally not probed (e.g. Tom + MTP) — not a scan failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<String>,
    /// Per-label skips (e.g. Tom tensor points) — counted as done for incremental scan.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped_points: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FitScanProgress {
    pub model_path: String,
    pub model_name: String,
    /// `scanning` | `complete` | `error` | `skipped` | `point_skipped` | `library_meta`.
    pub status: String,
    /// Set when `status == "skipped"` (model-level skip, not a point failure).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<String>,
    /// The CLI args used for this scan (for debugging).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<String>,
    /// VRAM result in MiB if complete.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vram_mib: Option<f64>,
    /// Scan point label (e.g., "base", "ctx_128k") — set on "complete" events.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_models: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scan_points_total: Option<usize>,
}

/// Cached FIT library partition — for incremental scan UI bootstrap + tab reconnect.
#[derive(Debug, Clone, Serialize)]
pub struct FitScanCacheSnapshot {
    pub provider_id: String,
    pub scan_points_total: usize,
    pub results: HashMap<String, FitScanFull>,
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
pub fn find_fit_binary(provider_binary_path: &str) -> Option<String> {
    let base = PathBuf::from(provider_binary_path);
    if let Some(parent_dir) = base.parent() {
        let fit_path = parent_dir.join("llama-fit-params.exe");
        if fit_path.exists() {
            return Some(fit_path.to_string_lossy().to_string());
        }
    }
    None
}

fn fit_scan_profile(binary_profile: &str) -> &str {
    if binary_profile.trim().is_empty() {
        crate::config::FIT_SCAN_BINARY_PROFILE
    } else {
        binary_profile
    }
}

fn foundry_fit_binary(provider_id: &str, profile: &str) -> Option<String> {
    let path = crate::config::foundry_artifact_release_dir(provider_id, profile).join("llama-fit-params.exe");
    if path.exists() {
        return Some(path.to_string_lossy().to_string());
    }
    None
}

fn bundled_fit_binary(provider_id: &str, profile: &str) -> Option<String> {
    let path = crate::config::resolve_path(&format!(
        "runtime/{}/{}/llama-fit-params.exe",
        provider_id, profile
    ));
    if path.exists() {
        return Some(path.to_string_lossy().to_string());
    }
    None
}

fn fit_binary_borrow_chain(provider_id: &str) -> Vec<String> {
    let mut chain = Vec::new();
    if let Some(borrow) = crate::templates::load_provider_defaults(provider_id)
        .map(|t| t.spawn_profile.fit_binary_provider)
        .filter(|s| !s.trim().is_empty())
    {
        chain.push(borrow);
    }
    if !provider_id.eq_ignore_ascii_case(crate::config::DEFAULT_PROVIDER_ID) {
        chain.push(crate::config::DEFAULT_PROVIDER_ID.to_string());
    }
    chain
}

/// Resolve `llama-fit-params.exe` — always frontier; provider foundry → bundled runtime → server dir → borrow chain.
pub fn resolve_fit_binary(
    cfg: &crate::config::AppConfig,
    provider_id: &str,
    binary_profile: &str,
) -> Result<String, String> {
    let profile = fit_scan_profile(binary_profile);
    let fit_adapter = resolve_fit_adapter(provider_id);

    if let Some(fit) = foundry_fit_binary(provider_id, profile) {
        return Ok(fit);
    }

    if let Some(fit) = bundled_fit_binary(provider_id, profile) {
        return Ok(fit);
    }

    if let Ok(server_path) = crate::engine_utils::find_provider_binary(cfg, provider_id, profile) {
        if let Some(fit) = find_fit_binary(server_path.to_str().unwrap_or("")) {
            return Ok(fit);
        }
    }

    // Tom rejects master `--fit-print` output — never borrow ggml-master fit-params.
    if fit_adapter != crate::fit_adapters::FitAdapterId::GgmlTom {
        for borrow_id in fit_binary_borrow_chain(provider_id) {
            if borrow_id.eq_ignore_ascii_case(provider_id) {
                continue;
            }
            if let Some(fit) = foundry_fit_binary(&borrow_id, profile) {
                log::info!(
                    "[FIT] Using foundry llama-fit-params from '{}' for provider '{}'",
                    borrow_id,
                    provider_id
                );
                return Ok(fit);
            }
            if let Some(fit) = bundled_fit_binary(&borrow_id, profile) {
                log::info!(
                    "[FIT] Using bundled llama-fit-params from '{}' for provider '{}'",
                    borrow_id,
                    provider_id
                );
                return Ok(fit);
            }
            if let Ok(borrow_server) = crate::engine_utils::find_provider_binary(cfg, &borrow_id, profile) {
                if let Some(fit) = find_fit_binary(borrow_server.to_str().unwrap_or("")) {
                    log::info!(
                        "[FIT] Using llama-fit-params beside '{}' server for provider '{}'",
                        borrow_id,
                        provider_id
                    );
                    return Ok(fit);
                }
            }
        }
    }

    if fit_adapter == crate::fit_adapters::FitAdapterId::GgmlTom {
        return Err(format!(
            "Tom FIT requires ggml-tom llama-fit-params (Foundry {}). Build Tom {} in Foundry.",
            profile, profile
        ));
    }

    Err(format!(
        "llama-fit-params.exe not found for provider '{}' (profile={}) — build Foundry {} or bundle the tool",
        provider_id, profile, profile
    ))
}

// ── Command Builder ────────────────────────────────────────────────

/// Build CLI args for llama-fit-params.exe — provider adapter selects `--fit-print` vs `--fit on`.
pub fn build_fit_command(
    provider_id: &str,
    model_path: &str,
    ctx_tokens: usize,
    kv_quant: &str,
    batch: u32,
    ubatch: u32,
    parallel: u32,
    split_mode: &str,
) -> Vec<String> {
    let adapter = resolve_fit_adapter(provider_id);
    adapter.build_scan_args(model_path, ctx_tokens, kv_quant, batch, ubatch, parallel, split_mode)
}

pub fn resolve_fit_adapter(provider_id: &str) -> crate::fit_adapters::FitAdapterId {
    let spawn = crate::templates::load_provider_defaults(provider_id)
        .map(|t| t.spawn_profile.fit_adapter)
        .unwrap_or_default();
    crate::fit_adapters::FitAdapterId::resolve(provider_id, &spawn)
}

/// Whole-model FIT skip for this provider (Tom MTP) — same gate as library scan.
pub fn model_fit_skip_note(provider_id: &str, model_path: &str) -> Option<&'static str> {
    resolve_fit_adapter(provider_id).model_skip_note(model_path)
}

/// Shared scan arg builder — `use_fit_print` false for Tom (uses `--fit on` + projected MiB line).
pub fn build_fit_command_base(
    model_path: &str,
    ctx_tokens: usize,
    kv_quant: &str,
    batch: u32,
    ubatch: u32,
    parallel: u32,
    split_mode: &str,
    use_fit_print: bool,
) -> Vec<String> {
    let mut args = vec![
        "-m".into(),
        model_path.into(),
    ];

    if use_fit_print {
        // Direct memory estimate to stdout — avoids the fitting path that can exit 1
        // (e.g. tensor split) before any breakdown is printed.
        args.extend(["--fit-print".into(), "on".into(), "--fit".into(), "off".into()]);
    } else {
        args.extend([
            "--fit".into(),
            "on".into(),
            "--fit-ctx".into(),
            ctx_tokens.to_string(),
        ]);
    }

    let mut args = args;
    args.extend([
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
    ]);

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

/// Parse stdout from `--fit-print on` / `common_fit_print`.
/// Lines: "<device> <model_mib> <ctx_mib> <compute_mib>" (Host row uses same layout).
pub fn parse_fit_print_stdout(stdout: &str) -> Option<FitScanRaw> {
    let mut gpu_self: Vec<f64> = Vec::new();
    let mut gpu_components: Vec<GpuComponentMib> = Vec::new();
    let mut host_mib: Option<f64> = None;

    for line in stdout.lines() {
        let cleaned = strip_ansi(line);
        let trimmed = cleaned.trim();
        if trimmed.is_empty() || trimmed.to_lowercase().contains("printing estimated memory") {
            continue;
        }

        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() < 4 {
            continue;
        }

        let model_mib: f64 = parts[1].parse().ok()?;
        let ctx_mib: f64 = parts[2].parse().ok()?;
        let compute_mib: f64 = parts[3].parse().ok()?;
        let self_mib = model_mib + ctx_mib + compute_mib;

        if parts[0].eq_ignore_ascii_case("host") {
            host_mib = Some(self_mib);
        } else {
            gpu_self.push(self_mib);
            gpu_components.push(GpuComponentMib {
                model_mib,
                ctx_mib,
                compute_mib,
            });
        }
    }

    if gpu_self.is_empty() {
        return None;
    }

    let vram_mib: f64 = gpu_self.iter().sum();
    if vram_mib <= 0.0 {
        return None;
    }

    Some(FitScanRaw {
        vram_mib,
        gpu_breakdown_mib: Some(gpu_self),
        host_mib,
        gpu_components_mib: Some(gpu_components),
    })
}

/// Parse MiB from llama-fit-params.exe output.
pub fn parse_fit_output(output: &str) -> Option<f64> {
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
    crate::engine_utils::strip_ansi(s)
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

struct FitProcessOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    status: ExitStatus,
}

/// Blocking FIT subprocess — mirrors gguf_scan / engine_stack spawn pattern.
///
/// `tokio::process::Command::output()` with CREATE_NO_WINDOW intermittently returns
/// ERROR_INVALID_HANDLE (os error 6) in release builds on Windows. Stdio must be
/// explicit; CWD must be the binary directory so bundled DLLs resolve beside the exe.
fn run_fit_process_blocking(
    fit_binary: &str,
    args: &[String],
    cuda_visible_devices: &str,
    timeout: Duration,
) -> Result<FitProcessOutput, String> {
    let binary_path = Path::new(fit_binary);
    let work_dir = binary_path
        .parent()
        .ok_or_else(|| format!("Fit binary has no parent directory: {}", fit_binary))?;

    let mut child = Command::new(fit_binary)
        .current_dir(work_dir)
        .args(args)
        .args(crate::types::LLAMA_DIAGNOSTIC_FLAGS.iter().map(|s| s.to_string()))
        .env("CUDA_VISIBLE_DEVICES", cuda_visible_devices)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x08000000) // CREATE_NO_WINDOW — prevents CMD flash in release builds
        .spawn()
        .map_err(|e| format!("Failed to spawn {}: {}", fit_binary, e))?;

    let mut stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;
    let mut stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture stderr".to_string())?;

    let stdout_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        buf
    });
    let stderr_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        buf
    });

    let start = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_handle.join();
                    let _ = stderr_handle.join();
                    return Err(format!("timed out after {}s", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();
                return Err(e.to_string());
            }
        }
    };

    let stdout = stdout_handle.join().unwrap_or_default();
    let stderr = stderr_handle.join().unwrap_or_default();

    Ok(FitProcessOutput {
        stdout,
        stderr,
        status,
    })
}

fn fit_stderr_reason(stderr: &str) -> String {
    for line in stderr.lines().rev() {
        let cleaned = strip_ansi(line);
        let trimmed = cleaned.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_lowercase();
        if lower.contains("failed to load model")
            || lower.contains("failed to open gguf")
            || lower.contains("failed to fit cli")
            || lower.contains("failed to fit params")
            || lower.contains("llama_params_fit:")
            || lower.contains("error loading model")
        {
            return trimmed.chars().take(200).collect();
        }
    }
    stderr
        .lines()
        .rev()
        .map(strip_ansi)
        .map(|l| l.trim().to_string())
        .find(|l| !l.is_empty())
        .map(|l| l.chars().take(200).collect())
        .unwrap_or_else(|| "unknown fit error".to_string())
}

fn fit_process_error_message(
    model_path: &str,
    adapter: crate::fit_adapters::FitAdapterId,
    fit_binary: &str,
    exit_code: Option<i32>,
    stderr: &str,
) -> String {
    format!(
        "Fit process failed for {} (adapter={}, binary={}, exit={:?}): {}",
        model_path,
        adapter.as_str(),
        fit_binary,
        exit_code,
        fit_stderr_reason(stderr)
    )
}

/// Scan a single model at one anchor point with pre-built CLI args.
pub async fn scan_single_anchor(
    fit_binary: &str,
    args: &[String],
    cuda_visible_devices: &str,
    adapter: crate::fit_adapters::FitAdapterId,
) -> Result<FitScanRaw, String> {
    if adapter == crate::fit_adapters::FitAdapterId::GgmlTom {
        let norm = fit_binary.replace('\\', "/").to_lowercase();
        if !norm.contains("ggml-tom") {
            return Err(format!(
                "Tom FIT requires ggml-tom llama-fit-params (Foundry {}). Resolved: {}",
                crate::config::FIT_SCAN_BINARY_PROFILE,
                fit_binary
            ));
        }
    }
    let model_path = args
        .iter()
        .position(|a| a == "-m")
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
        .unwrap_or("unknown");

    let fit_binary = fit_binary.to_string();
    let fit_binary_log = fit_binary.clone();
    let args = args.to_vec();
    let cuda_visible_devices = cuda_visible_devices.to_string();
    let model_path_owned = model_path.to_string();

    let output = tokio::task::spawn_blocking(move || {
        run_fit_process_blocking(
            &fit_binary,
            &args,
            &cuda_visible_devices,
            Duration::from_secs(SCAN_TIMEOUT_SECS),
        )
    })
    .await
    .map_err(|e| format!("Fit scan task failed for {}: {}", model_path_owned, e))?
    .map_err(|e| format!("Fit scan IO error for {}: {}", model_path_owned, e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() {
        return Err(fit_process_error_message(
            model_path,
            adapter,
            &fit_binary_log,
            output.status.code(),
            &stderr,
        ));
    }

    if let Some(raw) = adapter.parse_scan_output(&stdout, &stderr) {
        return Ok(raw);
    }

    let stderr_tail: String = stderr
        .lines()
        .rev()
        .take(8)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" | ");
    log::warn!(
        "Fit scan parse failed for {} (adapter={}, binary={}): exit={:?} tail={}",
        model_path,
        adapter.as_str(),
        fit_binary_log,
        output.status.code(),
        stderr_tail.chars().take(240).collect::<String>()
    );
    Err(format!(
        "Could not parse VRAM from fit output (adapter={}, binary={}). Exit code: {:?}",
        adapter.as_str(),
        fit_binary_log,
        output.status.code()
    ))
}

/// Parse projected VRAM from memory breakdown when model doesn't fit single GPU.
/// Extracts the "model" value from common_memory_breakdown_print lines.
pub fn parse_projected_vram(output: &str) -> Option<f64> {
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
    // Numeric breakdown is the last parenthesized group — skip the GPU name "(RTX ...)" prefix.
    if let Some(start) = line.rfind('(') {
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
/// Sum of per-GPU SELF MiB from the last memory breakdown table in engine/fit output.
pub fn parse_engine_memory_breakdown_mib(output: &str) -> Option<f64> {
    parse_engine_memory_breakdown(output).0
}

/// One complete `common_memory_breakdown_print` table from stderr.
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryBreakdownTable {
    pub gpu_self_mib: Vec<f64>,
    pub host_mib: Option<f64>,
}

impl MemoryBreakdownTable {
    pub fn total_gpu_self_mib(&self) -> f64 {
        self.gpu_self_mib.iter().sum()
    }
}

/// True when a breakdown table row ends with the Host line (all GPU rows are present).
pub fn is_complete_memory_breakdown_table_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("common_memory_breakdown_print")
        && lower.contains("host")
        && !lower.contains("cuda")
        && line.contains('|')
}

/// Every **complete** memory breakdown table in order (--fit on may emit dozens during MoE offload search).
/// A table is complete only after the Host row — never flush on partial CUDA-only rows.
pub fn parse_all_memory_breakdown_tables(output: &str) -> Vec<MemoryBreakdownTable> {
    let mut tables: Vec<MemoryBreakdownTable> = Vec::new();
    let mut current = MemoryBreakdownTable {
        gpu_self_mib: Vec::new(),
        host_mib: None,
    };
    let mut in_table = false;

    let flush_current = |tables: &mut Vec<MemoryBreakdownTable>, current: &mut MemoryBreakdownTable| {
        if !current.gpu_self_mib.is_empty() && current.host_mib.is_some() {
            tables.push(MemoryBreakdownTable {
                gpu_self_mib: current.gpu_self_mib.clone(),
                host_mib: current.host_mib,
            });
            current.gpu_self_mib.clear();
            current.host_mib = None;
        }
    };

    for line in output.lines() {
        let lower = line.to_lowercase();

        if is_memory_breakdown_header(line) {
            // Drop any in-progress probe (CUDA rows seen but Host not yet printed).
            current.gpu_self_mib.clear();
            current.host_mib = None;
            in_table = true;
            continue;
        }

        if !in_table || !line.contains('|') {
            continue;
        }

        if lower.contains("cuda") {
            if let Some(val) = extract_self_mib_from_cuda_breakdown_line(line) {
                current.gpu_self_mib.push(val);
            }
        } else if lower.contains("host") && !lower.contains("cuda") {
            if let Some(host_pos) = line.find("Host") {
                let rest = &line[host_pos..];
                if let Some(second_pipe) = rest[4..].find('|') {
                    let between = rest[4 + second_pipe + 1..].trim();
                    current.host_mib = extract_number(between);
                }
            }
            flush_current(&mut tables, &mut current);
            in_table = false;
        }
    }

    flush_current(&mut tables, &mut current);
    tables
}

/// (total_gpu_self_mib, per_gpu_self_mib) from the last memory breakdown table.
pub fn parse_engine_memory_breakdown(output: &str) -> (Option<f64>, Option<Vec<f64>>) {
    let tables = parse_all_memory_breakdown_tables(output);
    tables.last().map(|t| {
        (
            Some(t.total_gpu_self_mib()),
            Some(t.gpu_self_mib.clone()),
        )
    }).unwrap_or((None, None))
}

fn is_memory_breakdown_header(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("memory breakdown")
        && (lower.contains("[mib]")
            || (lower.contains("total") && lower.contains("free") && lower.contains("self")))
}

/// SELF MiB from a CUDA row: `... (2395 = 500 + 1632 + 263) ...`
fn extract_self_mib_from_cuda_breakdown_line(line: &str) -> Option<f64> {
    let last_open = line.rfind('(')?;
    let end_paren = line[last_open..].find(')')?;
    let inner = &line[last_open + 1..last_open + end_paren];
    if !inner.contains('=') || inner.matches('+').count() < 2 {
        return None;
    }
    extract_number(inner.trim())
}

pub fn parse_fit_breakdown(output: &str) -> (Option<Vec<f64>>, Option<f64>) {
    let tables = parse_all_memory_breakdown_tables(output);
    tables.last().map(|t| {
        (
            Some(t.gpu_self_mib.clone()),
            t.host_mib,
        )
    }).unwrap_or((None, None))
}

/// Parse per-GPU component breakdown from memory breakdown table.
/// Returns Vec<GpuComponentMib> with model/ctx/compute for each GPU.
///
/// llama-fit-params prints multiple memory tables during its iterative fitting algorithm.
/// We only want the LAST table — it represents the final fitted configuration.
pub fn parse_gpu_components(output: &str) -> Option<Vec<GpuComponentMib>> {
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

    if last_components.is_empty() { None } else { Some(last_components) }
}

// ── Library Scanner ─────────────────────────────────────────────────

fn emit_fit_scan_line(
    log_hub: Option<&LogHub>,
    category: BlackwellOutputConsoleCategory,
    content: &str,
    style: BlackwellOutputConsoleLineStyle,
) {
    if let Some(hub) = log_hub {
        hub.emit_console_line(category, content, style);
    }
}

/// Extract model name from full path (last component without .gguf).
pub fn extract_model_name(path: &str) -> String {
    crate::engine_utils::extract_model_name(path)
}

fn fit_scan_full_skipped(model_path: &str, skip_reason: &str) -> FitScanFull {
    FitScanFull {
        model_path: model_path.to_string(),
        points: Vec::new(),
        error: None,
        skip_reason: Some(skip_reason.to_string()),
        skipped_points: None,
    }
}

pub fn fit_scan_labels_done(full: &FitScanFull) -> HashSet<String> {
    let mut done: HashSet<String> = full.points.iter().map(|p| p.label.clone()).collect();
    if let Some(skipped) = &full.skipped_points {
        done.extend(skipped.keys().cloned());
    }
    done
}

/// Find all models using the shared model_catalog logic (multi-path, shard dedup, mmproj filter).
fn find_all_models(paths: &[String], log_hub: Option<&LogHub>) -> Vec<String> {
    let path_entries: Vec<crate::types::ModelPathEntry> = paths
        .iter()
        .filter(|p| !p.trim().is_empty())
        .enumerate()
        .map(|(i, p)| crate::types::ModelPathEntry {
            path: p.clone(),
            label: if i == 0 && !p.is_empty() {
                "Default".into()
            } else {
                format!("Path {}", i + 1)
            },
            is_default: i == 0,
        })
        .collect();

    match crate::model_catalog::merge_catalogs(&path_entries, log_hub, None) {
        Ok((entries, _conflicts)) => entries.into_iter().map(|e| e.path).collect(),
        Err(e) => {
            log::warn!("Failed to scan model paths: {}", e);
            emit_fit_scan_line(
                log_hub,
                BlackwellOutputConsoleCategory::Error,
                &format!("[FIT-SCAN] Catalog scan failed: {e}"),
                BlackwellOutputConsoleLineStyle::Error,
            );
            Vec::new()
        }
    }
}

/// Lookup one model in the provider's fit-adapter partition (path + filename fallback).
pub fn find_existing_scan_in_provider_partition(
    provider_id: &str,
    model_path: &str,
) -> Option<FitScanFull> {
    let data = load_full_scan_partition_for_provider(provider_id);
    find_existing_scan(&data, model_path)
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

/// Number of probe points per model — keep in sync with `FIT_SCAN_POINTS_TOTAL` in fitScanTable.ts.
pub fn scan_points_total() -> usize {
    SCAN_PLAN.len()
}

fn missing_scan_labels(existing_full: Option<&FitScanFull>) -> Vec<String> {
    let labels_done: HashSet<String> = existing_full
        .map(fit_scan_labels_done)
        .unwrap_or_default();
    let plan_labels: HashSet<&str> = SCAN_PLAN.iter().map(|p| p.0).collect();

    if existing_full
        .and_then(|e| e.skip_reason.as_ref())
        .is_some()
    {
        return Vec::new();
    }
    if labels_done.len() >= SCAN_PLAN.len()
        && plan_labels.is_subset(&labels_done.iter().map(|s| s.as_str()).collect())
    {
        return Vec::new();
    }

    SCAN_PLAN
        .iter()
        .filter(|p| !labels_done.contains(p.0))
        .map(|p| p.0.to_string())
        .collect()
}

/// Serializes partition RMW when multiple catalog FIT scans run in parallel.
static PARTITION_PERSIST_LOCK: LazyLock<TokioMutex<()>> = LazyLock::new(|| TokioMutex::new(()));

async fn persist_single_model_scan(
    fit_adapter: crate::fit_adapters::FitAdapterId,
    model_path: &str,
    result: &FitScanFull,
    shared_cache: Option<&TokioMutex<HashMap<String, FitScanFull>>>,
) {
    if let Some(cache) = shared_cache {
        let mut map = cache.lock().await;
        map.insert(model_path.to_string(), result.clone());
        save_full_scan_partition(fit_adapter, &map);
    } else {
        let _guard = PARTITION_PERSIST_LOCK.lock().await;
        let mut map = load_full_scan_partition(fit_adapter);
        map.insert(model_path.to_string(), result.clone());
        save_full_scan_partition(fit_adapter, &map);
    }
}

/// Full SCAN_PLAN probe for one model — shared by library scan and on-demand catalog scan.
pub async fn scan_single_model_full(
    fit_binary: &str,
    model_path: &str,
    provider_id: &str,
    progress_tx: Option<&broadcast::Sender<FitScanProgress>>,
    cancelled: &AtomicBool,
    log_hub: Option<&LogHub>,
    force_rescan: bool,
    shared_cache: Option<&TokioMutex<HashMap<String, FitScanFull>>>,
) -> FitScanFull {
    let fit_adapter = resolve_fit_adapter(provider_id);
    let partition_snapshot: HashMap<String, FitScanFull> = if let Some(cache) = shared_cache {
        cache.lock().await.clone()
    } else {
        load_full_scan_partition(fit_adapter)
    };
    let existing_full: Option<FitScanFull> = if force_rescan {
        None
    } else {
        find_existing_scan(&partition_snapshot, model_path)
    };

    if let Some(skip_note) = fit_adapter.model_skip_note(model_path) {
        let result = existing_full
            .filter(|e| e.skip_reason.is_some())
            .unwrap_or_else(|| fit_scan_full_skipped(model_path, skip_note));
        if let Some(tx) = progress_tx {
            let _ = tx.send(FitScanProgress {
                model_path: model_path.to_string(),
                model_name: extract_model_name(model_path),
                status: "skipped".to_string(),
                args: None,
                vram_mib: None,
                label: None,
                provider_id: None,
                total_models: None,
                scan_points_total: Some(SCAN_PLAN.len()),
                skip_reason: result.skip_reason.clone(),
            });
        }
        persist_single_model_scan(fit_adapter, model_path, &result, shared_cache).await;
        return result;
    }

    let missing_labels = if force_rescan {
        SCAN_PLAN.iter().map(|p| p.0.to_string()).collect()
    } else {
        missing_scan_labels(existing_full.as_ref())
    };

    if missing_labels.is_empty() {
        if let Some(existing) = existing_full {
            return existing;
        }
    }

    let model_name = extract_model_name(model_path);
    let gpu_count = detect_gpu_count();
    let existing_points: Vec<FitDataPoint> = existing_full
        .as_ref()
        .map(|e| e.points.clone())
        .unwrap_or_default();
    let mut skipped_points: HashMap<String, String> = existing_full
        .as_ref()
        .and_then(|e| e.skipped_points.clone())
        .unwrap_or_default();

    let mut points: Vec<FitDataPoint> = if missing_labels.is_empty() {
        Vec::with_capacity(SCAN_PLAN.len())
    } else {
        existing_points.clone()
    };
    let mut failures = Vec::new();

    for (label, ctx_tokens, kv_q, batch_val, parallel_val, split_val) in SCAN_PLAN {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }

        if !missing_labels.iter().any(|l| l.as_str() == *label) {
            continue;
        }

        if let Some(note) = fit_adapter.point_skip_note(label, split_val) {
            skipped_points.insert((*label).to_string(), note.to_string());
            emit_fit_scan_line(
                log_hub,
                BlackwellOutputConsoleCategory::Utils,
                &format!(
                    "[FIT-SCAN] {} | {label} | skipped | {note}",
                    extract_model_name(model_path)
                ),
                BlackwellOutputConsoleLineStyle::Normal,
            );
            if let Some(tx) = progress_tx {
                let _ = tx.send(FitScanProgress {
                    model_path: model_path.to_string(),
                    model_name: model_name.clone(),
                    status: "point_skipped".to_string(),
                    args: None,
                    vram_mib: None,
                    label: Some((*label).to_string()),
                    provider_id: None,
                    total_models: None,
                    scan_points_total: Some(SCAN_PLAN.len()),
                    skip_reason: Some(note.to_string()),
                });
            }
            continue;
        }

        let point_gpu_mask = if *split_val != "none" && !split_val.is_empty() {
            (0..gpu_count)
                .map(|i| i.to_string())
                .collect::<Vec<_>>()
                .join(",")
        } else {
            "0".to_string()
        };

        let args = build_fit_command(
            provider_id,
            model_path,
            *ctx_tokens,
            kv_q,
            *batch_val,
            *batch_val,
            *parallel_val,
            split_val,
        );

        if let Some(tx) = progress_tx {
            let _ = tx.send(FitScanProgress {
                model_path: model_path.to_string(),
                model_name: model_name.clone(),
                status: "scanning".to_string(),
                args: Some(args.join(" ")),
                vram_mib: None,
                label: Some((*label).to_string()),
                provider_id: Some(provider_id.to_string()),
                total_models: Some(1),
                scan_points_total: Some(SCAN_PLAN.len()),
                skip_reason: None,
            });
        }

        match scan_single_anchor(fit_binary, &args, &point_gpu_mask, fit_adapter).await {
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

                if let Some(tx) = progress_tx {
                    let _ = tx.send(FitScanProgress {
                        model_path: model_path.to_string(),
                        model_name: model_name.clone(),
                        status: "complete".to_string(),
                        args: None,
                        vram_mib: Some(raw.vram_mib),
                        label: Some((*label).to_string()),
                        provider_id: Some(provider_id.to_string()),
                        total_models: Some(1),
                        scan_points_total: Some(SCAN_PLAN.len()),
                        skip_reason: None,
                    });
                }
            }
            Err(e) => {
                failures.push(format!("{}:{}", label, e));
                log::warn!("Scan {} failed for {}: {}", label, model_path, e);
                emit_fit_scan_line(
                    log_hub,
                    BlackwellOutputConsoleCategory::Error,
                    &format!(
                        "[FIT-SCAN] {} | {label} | {e}",
                        extract_model_name(model_path)
                    ),
                    BlackwellOutputConsoleLineStyle::Error,
                );
                if let Some(tx) = progress_tx {
                    let _ = tx.send(FitScanProgress {
                        model_path: model_path.to_string(),
                        model_name: model_name.clone(),
                        status: "error".to_string(),
                        args: None,
                        vram_mib: None,
                        label: Some((*label).to_string()),
                        provider_id: None,
                        total_models: None,
                        scan_points_total: None,
                        skip_reason: None,
                    });
                }
            }
        }
    }

    let result = FitScanFull {
        model_path: model_path.to_string(),
        points,
        error: if failures.is_empty() {
            None
        } else {
            Some(failures.join(" | "))
        },
        skip_reason: None,
        skipped_points: if skipped_points.is_empty() {
            None
        } else {
            Some(skipped_points)
        },
    };

    persist_single_model_scan(fit_adapter, model_path, &result, shared_cache).await;

    result
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
    log_hub: Option<LogHub>,
) -> FitScanComplete {
    let hub_ref = log_hub.as_ref();

    // Use shared model_catalog logic for multi-path scanning, shard dedup, mmproj filter
    let models = find_all_models(model_paths, hub_ref);
    let total = models.len();

    if let Some(tx) = &progress_tx {
        let _ = tx.send(FitScanProgress {
            model_path: String::new(),
            model_name: String::new(),
            status: "library_meta".to_string(),
            args: None,
            vram_mib: None,
            label: None,
            provider_id: Some(provider_id.clone()),
            total_models: Some(total),
            scan_points_total: Some(SCAN_PLAN.len()),
            skip_reason: None,
        });
    }

    if total == 0 {
        let msg = if model_paths.iter().all(|p| p.trim().is_empty()) {
            "[FIT-SCAN] No model library paths configured.".to_string()
        } else {
            format!(
                "[FIT-SCAN] No GGUF models found under {} configured path(s).",
                model_paths.iter().filter(|p| !p.trim().is_empty()).count()
            )
        };
        emit_fit_scan_line(
            hub_ref,
            BlackwellOutputConsoleCategory::Error,
            &msg,
            BlackwellOutputConsoleLineStyle::Error,
        );
        return FitScanComplete {
            provider_id,
            total_models: 0,
            completed: 0,
            failed: 0,
            scan_points_total: SCAN_PLAN.len(),
            results: HashMap::new(),
        };
    }

    let fit_adapter = resolve_fit_adapter(&provider_id);

    log::info!(
        "[FIT-SCAN] provider='{}' fit_adapter='{}' — cache partition is per adapter (not per provider)",
        provider_id,
        fit_adapter.as_str()
    );
    emit_fit_scan_line(
        hub_ref,
        BlackwellOutputConsoleCategory::Utils,
        &format!(
            "[FIT-SCAN] provider={} adapter={} (fit_scan_full.json partition)",
            provider_id,
            fit_adapter.as_str()
        ),
        BlackwellOutputConsoleLineStyle::Normal,
    );

    let existing_data = load_full_scan_partition(fit_adapter);

    let semaphore = StdArc::new(Semaphore::new(max_parallel as usize));
    let failed_count = StdArc::new(TokioMutex::new(0usize));

    let full_results_map: StdArc<TokioMutex<HashMap<String, FitScanFull>>> =
        StdArc::new(TokioMutex::new(existing_data));

    let mut handles = vec![];

    for model_path in models {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }

        let existing_full = {
            let map = full_results_map.lock().await;
            find_existing_scan(&map, &model_path)
        };
        if missing_scan_labels(existing_full.as_ref()).is_empty() {
            if let Some(existing) = existing_full {
                full_results_map.lock().await.insert(model_path.clone(), existing);
            }
            continue;
        }

        let sem = semaphore.clone();
        let fit_bin = fit_binary.to_string();
        let cancel = cancelled.clone();
        let prog_tx = progress_tx.clone();
        let full_map = full_results_map.clone();
        let log_hub_task = log_hub.clone();
        let scan_provider_id = provider_id.clone();

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

            let result = scan_single_model_full(
                &fit_bin,
                &model_path,
                &scan_provider_id,
                prog_tx.as_ref(),
                &cancel,
                log_hub_task.as_ref(),
                false,
                Some(full_map.as_ref()),
            )
            .await;

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
                emit_fit_scan_line(
                    hub_ref,
                    BlackwellOutputConsoleCategory::Error,
                    &format!("[FIT-SCAN] Scan task failed: {e}"),
                    BlackwellOutputConsoleLineStyle::Error,
                );
                let mut f = failed_count.lock().await;
                *f += 1;
            }
        }
    }

    let completed = final_results.len();
    let failed = *failed_count.lock().await;

    save_full_scan_partition(fit_adapter, &final_results);

    FitScanComplete {
        provider_id,
        total_models: total,
        completed,
        failed,
        scan_points_total: SCAN_PLAN.len(),
        results: final_results,
    }
}

// ── Full Scan Export (partitioned by fit_adapter) ───────────────────
const FIT_SCAN_EXPORT_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FitScanPartitionedExport {
    version: u32,
    partitions: HashMap<String, HashMap<String, FitScanFull>>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum FitScanExportFile {
    V2(FitScanPartitionedExport),
    Legacy(HashMap<String, FitScanFull>),
}

fn full_scan_export_path() -> PathBuf {
    crate::config::cache_dir().join("fit_scan_full.json")
}

fn load_all_scan_partitions() -> HashMap<String, HashMap<String, FitScanFull>> {
    let path = full_scan_export_path();
    if !path.exists() {
        return HashMap::new();
    }
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return HashMap::new(),
    };
    match serde_json::from_str::<FitScanExportFile>(&content) {
        Ok(FitScanExportFile::V2(exp)) => exp.partitions,
        Ok(FitScanExportFile::Legacy(legacy)) => {
            if legacy.is_empty() {
                HashMap::new()
            } else {
                log::info!(
                    "[FIT] Migrated {} model(s) in fit_scan_full.json → ggml_master partition",
                    legacy.len()
                );
                let mut partitions = HashMap::new();
                partitions.insert(crate::fit_adapters::FitAdapterId::GgmlMaster.as_str().to_string(), legacy);
                partitions
            }
        }
        Err(e) => {
            log::warn!("[FIT] Failed to parse fit_scan_full.json: {e}");
            HashMap::new()
        }
    }
}

fn write_all_scan_partitions(partitions: &HashMap<String, HashMap<String, FitScanFull>>) {
    if partitions.values().all(|p| p.is_empty()) {
        return;
    }
    let path = full_scan_export_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let export = FitScanPartitionedExport {
        version: FIT_SCAN_EXPORT_VERSION,
        partitions: partitions.clone(),
    };
    if let Ok(json) = serde_json::to_string_pretty(&export) {
        let _ = std::fs::write(&path, json);
    }
}

/// One fit-adapter partition (`ggml_master` | `ggml_tom`).
pub fn load_full_scan_partition(adapter: crate::fit_adapters::FitAdapterId) -> HashMap<String, FitScanFull> {
    load_all_scan_partitions()
        .remove(adapter.as_str())
        .unwrap_or_default()
}

pub fn load_full_scan_partition_for_provider(provider_id: &str) -> HashMap<String, FitScanFull> {
    load_full_scan_partition(resolve_fit_adapter(provider_id))
}

fn save_full_scan_partition(
    adapter: crate::fit_adapters::FitAdapterId,
    partition: &HashMap<String, FitScanFull>,
) {
    if partition.is_empty() {
        return;
    }
    let mut all = load_all_scan_partitions();
    all.insert(adapter.as_str().to_string(), partition.clone());
    write_all_scan_partitions(&all);
}

/// Clear all FIT library scan partitions.
pub fn clear_full_scan_export() {
    let path = full_scan_export_path();
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
}

/// Drop one fit-adapter partition (`ggml_master` | `ggml_tom`) — other providers' cache kept.
pub fn clear_full_scan_partition(adapter: crate::fit_adapters::FitAdapterId) {
    let mut all = load_all_scan_partitions();
    if all.remove(adapter.as_str()).is_none() {
        return;
    }
    if all.is_empty() {
        clear_full_scan_export();
    } else {
        write_all_scan_partitions(&all);
    }
}

pub fn clear_full_scan_partition_for_provider(provider_id: &str) {
    let adapter = resolve_fit_adapter(provider_id);
    log::info!(
        "[FIT-SCAN] Force rescan — clearing {} partition for provider '{}'",
        adapter.as_str(),
        provider_id
    );
    clear_full_scan_partition(adapter);
}

/// Full cached library partition for one provider (incremental scan bootstrap / UI reconnect).
#[tauri::command]
pub fn get_fit_scan_cache_snapshot(provider_id: String) -> FitScanCacheSnapshot {
    let adapter = resolve_fit_adapter(&provider_id);
    FitScanCacheSnapshot {
        provider_id,
        scan_points_total: scan_points_total(),
        results: load_full_scan_partition(adapter),
    }
}

/// Get raw FIT scan points for a model — partition follows provider fit_adapter.
#[tauri::command]
pub fn get_fit_scan_points(model_path: String, provider_id: Option<String>) -> Option<Vec<FitDataPoint>> {
    let provider_id = provider_id.unwrap_or_else(|| crate::config::DEFAULT_PROVIDER_ID.to_string());
    let data = load_full_scan_partition_for_provider(&provider_id);
    find_existing_scan(&data, &model_path).map(|f| f.points.clone())
}

#[cfg(test)]
mod memory_breakdown_tests {
    use super::{
        parse_all_memory_breakdown_tables, parse_engine_memory_breakdown,
        parse_engine_memory_breakdown_mib, parse_fit_print_stdout,
    };

    const FIT_AT_LOAD: &str = r#"0.00.971.498 I common_memory_breakdown_print: | memory breakdown [MiB]                                 | total    free    self   model   context   compute    unaccounted |
0.00.971.505 I common_memory_breakdown_print: |   - CUDA0 (RTX PRO 6000 Blackwell Workstation Edition) | 97886 = 95357 + (2395 =   500 +    1632 +     263) +         133 |
0.00.971.506 I common_memory_breakdown_print: |   - Host                                               |                   269 =   137 +       0 +     131                |"#;

    const AT_EXIT: &str = r#"0.04.450.376 I common_memory_breakdown_print: | memory breakdown [MiB]                                 | total    free    self   model   context   compute    unaccounted |
0.04.450.381 I common_memory_breakdown_print: |   - CUDA0 (RTX PRO 6000 Blackwell Workstation Edition) | 97886 = 92883 + (2395 =   500 +    1632 +     263) +        2607 |
0.04.450.382 I common_memory_breakdown_print: |   - Host                                               |                   269 =   137 +       0 +     131                |"#;

    #[test]
    fn parses_fit_print_stdout_single_gpu() {
        const OUT: &str = r#"0.00.041.481 I llama_fit_params: printing estimated memory in MiB to stdout (device, model, context, compute) ...
CUDA0 20386 2197 505
Host 994 0 52
"#;
        let raw = parse_fit_print_stdout(OUT).expect("fit-print stdout");
        assert_eq!(raw.vram_mib, 23088.0);
        assert_eq!(raw.gpu_breakdown_mib, Some(vec![23088.0]));
        assert_eq!(raw.host_mib, Some(1046.0));
        assert_eq!(raw.gpu_components_mib.as_ref().map(|c| c.len()), Some(1));
    }

    #[test]
    fn parses_fit_print_stdout_multi_gpu_and_tensor_meta() {
        const OUT: &str = r#"CUDA0 9829 1179 226
CUDA1 10556 1167 649
Host 994 0 84
"#;
        let raw = parse_fit_print_stdout(OUT).expect("fit-print stdout");
        assert_eq!(raw.vram_mib, 23606.0);
        assert_eq!(raw.gpu_breakdown_mib, Some(vec![11234.0, 12372.0]));
        assert_eq!(raw.host_mib, Some(1078.0));
    }

    #[test]
    fn breakdown_fallback_when_no_summary_line() {
        const FIT_AT_LOAD: &str = r#"0.00.971.498 I common_memory_breakdown_print: | memory breakdown [MiB]                                 | total    free    self   model   context   compute    unaccounted |
0.00.971.505 I common_memory_breakdown_print: |   - CUDA0 (RTX PRO 6000 Blackwell Workstation Edition) | 97886 = 95357 + (2395 =   500 +    1632 +     263) +         133 |
0.00.971.506 I common_memory_breakdown_print: |   - Host                                               |                   269 =   137 +       0 +     131                |"#;
        assert_eq!(parse_engine_memory_breakdown_mib(FIT_AT_LOAD), Some(2395.0));
    }

    #[test]
    fn parses_fit_time_breakdown_from_real_stderr() {
        let (total, gpus) = parse_engine_memory_breakdown(FIT_AT_LOAD);
        assert_eq!(total, Some(2395.0));
        assert_eq!(gpus, Some(vec![2395.0]));
    }

    #[test]
    fn parses_exit_breakdown_from_real_stderr() {
        let (total, gpus) = parse_engine_memory_breakdown(AT_EXIT);
        assert_eq!(total, Some(2395.0));
        assert_eq!(gpus, Some(vec![2395.0]));
    }

    #[test]
    fn uses_last_table_when_multiple_present() {
        let combined = format!("{FIT_AT_LOAD}\n{AT_EXIT}");
        let (total, _) = parse_engine_memory_breakdown(&combined);
        assert_eq!(total, Some(2395.0));
    }

    #[test]
    fn parses_dual_gpu_moe_initial_probe() {
        const MOE_FITS: &str = r#"0.01.623.223 I common_memory_breakdown_print: | memory breakdown [MiB] | total free self model context compute unaccounted |
0.01.623.239 I common_memory_breakdown_print: | - CUDA0 (RTX PRO 6000 Blackwell Workstation Edition) | 97886 = 95257 + (80959 = 77283 + 2003 + 1673) + -78330 |
0.01.623.240 I common_memory_breakdown_print: | - CUDA1 (RTX PRO 6000 Blackwell Workstation Edition) | 97886 = 95269 + (77365 = 73404 + 2262 + 1697) + -74747 |
0.01.623.240 I common_memory_breakdown_print: | - Host | 1586 = 545 + 0 + 1041 |"#;

        let tables = parse_all_memory_breakdown_tables(MOE_FITS);
        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0].gpu_self_mib, vec![80959.0, 77365.0]);
        assert_eq!(tables[0].total_gpu_self_mib(), 158324.0);
        assert_eq!(tables[0].host_mib, Some(1586.0));
    }

    #[test]
    fn ignores_partial_table_before_host_row() {
        const PARTIAL: &str = r#"0.01 I common_memory_breakdown_print: | memory breakdown [MiB] | total free self model context compute unaccounted |
0.01 I common_memory_breakdown_print: | - CUDA0 (GPU) | 90000 = 10000 + (80959 = 77283 + 2003 + 1673) + 0 |"#;
        assert!(parse_all_memory_breakdown_tables(PARTIAL).is_empty());
    }

    #[test]
    fn parses_moe_fit_final_offload_table() {
        const FINAL_FIT: &str = r#"0.15.574.254 I common_memory_breakdown_print: | memory breakdown [MiB] | total free self model context compute unaccounted |
0.15.574.260 I common_memory_breakdown_print: | - CUDA0 (RTX PRO 6000 Blackwell Workstation Edition) | 97886 = 95357 + ( 93183 = 90542 + 131 + 2508) + -90653 |
0.15.574.260 I common_memory_breakdown_print: | - CUDA1 (RTX PRO 6000 Blackwell Workstation Edition) | 97886 = 95357 + ( 93325 = 92828 + 263 + 233) + -90795 |
0.15.574.260 I common_memory_breakdown_print: | - Host | 111400 = 111355 + 5 + 40 |"#;

        let tables = parse_all_memory_breakdown_tables(FINAL_FIT);
        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0].total_gpu_self_mib(), 186508.0);
        assert_eq!(tables[0].host_mib, Some(111400.0));
    }

    #[test]
    fn parses_multiple_fit_iterations() {
        const ITER_A: &str = r#"0.01 I common_memory_breakdown_print: | memory breakdown [MiB] | total free self model context compute unaccounted |
0.01 I common_memory_breakdown_print: |   - CUDA0 (GPU) | 90000 = 10000 + (62000 = 60000 + 1000 + 1000) + 0 |
0.01 I common_memory_breakdown_print: |   - Host | 50000 = 48000 + 0 + 2000 |"#;
        const ITER_B: &str = r#"0.02 I common_memory_breakdown_print: | memory breakdown [MiB] | total free self model context compute unaccounted |
0.02 I common_memory_breakdown_print: |   - CUDA0 (GPU) | 90000 = 20000 + (45000 = 42000 + 2000 + 1000) + 0 |
0.02 I common_memory_breakdown_print: |   - CUDA1 (GPU) | 90000 = 30000 + (12000 = 10000 + 1000 + 1000) + 0 |
0.02 I common_memory_breakdown_print: |   - Host | 80000 = 75000 + 0 + 5000 |"#;

        let tables = parse_all_memory_breakdown_tables(&format!("{ITER_A}\n{ITER_B}"));
        assert_eq!(tables.len(), 2);
        assert_eq!(tables[0].total_gpu_self_mib(), 62000.0);
        assert_eq!(tables[1].total_gpu_self_mib(), 57000.0); // 45000 + 12000
        assert_eq!(tables[1].gpu_self_mib.len(), 2);
    }
}
