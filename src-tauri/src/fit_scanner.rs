//! FIT Scanner Engine — hardware-probe VRAM estimation using llama-fit-params.exe.
//!
//! Self-contained scan plan with hardcoded GGML-compatible CLI commands.
//! No template system involvement — directly builds args for llama-fit-params.exe.

use crate::engine::AppContext;
use crate::errors::BlackwellError;
use crate::output_console::{BlackwellOutputConsoleCategory, BlackwellOutputConsoleLineStyle};
use crate::telemetry::detect_gpu_count;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::time::Duration;

// ── Constants ───────────────────────────────────────────────

const SCAN_TIMEOUT_SECS: u64 = 30;

/// FIT binary has no tensor fit. Map tensor → layer for all llama-fit-params argv.
pub fn fit_cli_split_mode(split_mode: &str) -> String {
    match split_mode.trim().to_lowercase().as_str() {
        "tensor" => "layer".into(),
        s if !s.is_empty() && s != "none" => s.into(),
        _ => String::new(),
    }
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
    /// Host row model/ctx/compute (`Host a b c`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_components_mib: Option<GpuComponentMib>,
    /// Fitted `-ngl` from free-aware low_vram probe (−1 = all on GPU).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fitted_ngl: Option<i32>,
    /// `full` | `low_vram` — which FIT regime produced this result.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probe_mode: Option<String>,
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

/// Resolve `llama-fit-params.exe` — always edge; provider foundry → bundled runtime → server dir → borrow chain.
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

    // A set whose tail is a separately published PLE/Engram table cannot load without
    // it — `llama-fit-params` shares llama.cpp's common args, so `--ple` applies here
    // exactly as it does at launch. Without this the probe dies on
    // "failed to load model" and the memory glass has nothing to show.
    if let Some(engram) = crate::companions::launch_engram(model_path) {
        args.extend(["--ple".into(), engram]);
    }

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

    args.extend([
        // Force all layers onto GPU — prevents llama-fit-params from auto-calculating ngl
        // and offloading layers. We need the TRUE total VRAM requirement per scan point,
        // not a "fitted" result after internal layer reduction.
        "--n-gpu-layers".into(), "999".into(),
        // KV quant (both K and V for accurate estimation)
        "--cache-type-k".into(), kv_quant.to_lowercase(),
        "--cache-type-v".into(), kv_quant.to_lowercase(),
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

    let cli_split = fit_cli_split_mode(split_mode);
    if !cli_split.is_empty() {
        args.extend(["--split-mode".into(), cli_split]);
    }

    // Flash attention — always ON (required for non-f16 KV quant on modern architectures)
    args.extend(["--flash-attn".into(), "on".into()]);

    args
}

// ── Output Parsing ────────────────────────────────────────────────

/// Parse stdout from `--fit-print on` / `common_fit_print`.
/// Lines: "<device> <model_mib> <ctx_mib> <compute_mib>" (Host row uses same layout).
///
/// **Tensor / Meta note:** launch LEARN expands `Meta()` buffer lines × N GPUs because
/// those are real per-GPU shards from `load_tensors`. `llama-fit-params --fit-print` is
/// different — a Meta/CUDA row is already a full no_alloc estimate (empirically ≈ split=none
/// total). Doubling it produced 2× model VRAM in the library table (e.g. 69G → 138G).
/// Do **not** apply LEARN-style Meta expansion here. Tensor multi-GPU tax from library FIT
/// is often ~0; forecast falls back to launch-calibrated constants or LEARNED launches.
pub fn parse_fit_print_stdout(stdout: &str) -> Option<FitScanRaw> {
    let mut gpu_self: Vec<f64> = Vec::new();
    let mut gpu_components: Vec<GpuComponentMib> = Vec::new();
    let mut host_mib: Option<f64> = None;
    let mut host_components_mib: Option<GpuComponentMib> = None;

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

        let Ok(model_mib) = parts[1].parse::<f64>() else {
            continue;
        };
        let Ok(ctx_mib) = parts[2].parse::<f64>() else {
            continue;
        };
        let Ok(compute_mib) = parts[3].parse::<f64>() else {
            continue;
        };
        let self_mib = model_mib + ctx_mib + compute_mib;
        let device = parts[0].trim_end_matches("()");

        if device.eq_ignore_ascii_case("host") {
            host_mib = Some(self_mib);
            host_components_mib = Some(GpuComponentMib {
                model_mib,
                ctx_mib,
                compute_mib,
            });
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
        host_components_mib,
        fitted_ngl: None,
        fit_attempts: Vec::new(),
    })
}

/// Parse MiB from llama-fit-params.exe output.
/// Multi-pass --fit on runs emit several "projected to use" lines — keep the **last** match.
pub fn parse_fit_output(output: &str) -> Option<f64> {
    let mut last: Option<f64> = None;

    for line in output.lines() {
        let lower = line.to_lowercase();
        if (lower.contains("projected to use") || lower.contains("estimated to use"))
            && (lower.contains("mib") || lower.contains("mb") || lower.contains("mi b"))
        {
            if let Some(num) = extract_number(line) {
                last = Some(num);
            }
        }
    }
    if last.is_some() {
        return last;
    }

    for line in output.lines() {
        let lower = line.to_lowercase();
        if (lower.contains("vram") || lower.contains("memory"))
            && (lower.contains("mib") || lower.contains("mb") || lower.contains("mi b"))
        {
            if let Some(num) = extract_number(line) {
                last = Some(num);
            }
        }
    }
    if last.is_some() {
        return last;
    }

    for line in output.lines() {
        let lower = line.to_lowercase();
        if lower.contains("mib") || lower.contains("mi b") {
            if let Some(num) = extract_number(line) {
                last = Some(num);
            }
        }
    }

    last
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
        if let Ok(val) = num_chars.replace(',', "").parse::<f64>() {
            return Some(val);
        }
    }
    None
}

#[derive(Debug, Clone)]
pub struct FitScanRaw {
    pub vram_mib: f64,
    pub gpu_breakdown_mib: Option<Vec<f64>>,
    pub host_mib: Option<f64>,
    /// Per-GPU component breakdown (model/ctx/compute).
    pub gpu_components_mib: Option<Vec<GpuComponentMib>>,
    /// Host row model/ctx/compute when FIT printed `Host a b c`.
    pub host_components_mib: Option<GpuComponentMib>,
    /// Optional fitted ngl from free-aware fit logs.
    pub fitted_ngl: Option<i32>,
    /// Every fit attempt the binary printed, in order - the same shape the launch records.
    pub fit_attempts: Vec<crate::launch_memory_parse::FitAttempt>,
}

#[derive(Debug, Clone)]
pub struct FitProcessOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub status: ExitStatus,
}

/// Blocking FIT subprocess — mirrors gguf_scan / engine_stack spawn pattern.
///
/// `tokio::process::Command::output()` with CREATE_NO_WINDOW intermittently returns
/// ERROR_INVALID_HANDLE (os error 6) in release builds on Windows. Stdio must be
/// explicit; CWD must be the binary directory so bundled DLLs resolve beside the exe.
pub fn run_fit_process_blocking(
    fit_binary: &str,
    args: &[String],
    cuda_visible_devices: &str,
    timeout: Duration,
) -> Result<FitProcessOutput, String> {
    let binary_path = Path::new(fit_binary);
    let work_dir = binary_path
        .parent()
        .ok_or_else(|| format!("Fit binary has no parent directory: {}", fit_binary))?;

    let mut child_cmd = Command::new(fit_binary);
    child_cmd
        .current_dir(work_dir)
        .args(args)
        .args(crate::types::LLAMA_DIAGNOSTIC_FLAGS.iter().map(|s| s.to_string()))
        .env("CUDA_VISIBLE_DEVICES", cuda_visible_devices)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x08000000); // CREATE_NO_WINDOW — prevents CMD flash in release builds
    crate::engine_utils::apply_cuda_toolchain_for_profile(
        &mut child_cmd,
        crate::config::FIT_SCAN_BINARY_PROFILE,
    )?;
    let mut child = child_cmd
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

/// Human reason for llama-fit-params process death.
pub fn decode_fit_exit(exit_code: Option<i32>) -> String {
    match exit_code {
        None => "no exit code (killed / timeout / spawn fail)".into(),
        Some(1) => "exit 1 (FIT abort — see why line)".into(),
        // 0xC0000409 STATUS_STACK_BUFFER_OVERRUN
        Some(-1073740791) => {
            "exit 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN — FIT crash, often unimplemented tensor or bad load)".into()
        }
        // 0xC0000005 ACCESS_VIOLATION
        Some(-1073741819) => "exit 0xC0000005 (access violation)".into(),
        // 0xC0000374 STATUS_HEAP_CORRUPTION
        Some(-1073740940) => "exit 0xC0000374 (heap corruption)".into(),
        // 0xC0000135 STATUS_DLL_NOT_FOUND — loader death, stderr is empty by construction
        Some(-1073741515) => {
            "exit 0xC0000135 (STATUS_DLL_NOT_FOUND — a dependent DLL is missing, so FIT died in the loader with no output; check the portable CUDA runtime and the MSVC runtime beside the exe)".into()
        }
        // 0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND
        Some(-1073741511) => {
            "exit 0xC0000139 (STATUS_ENTRYPOINT_NOT_FOUND — a stale MSVC/CUDA runtime lacks a needed export)".into()
        }
        Some(c) => format!("exit={c} (0x{c:08X})"),
    }
}

fn fit_process_error_message(
    model_path: &str,
    adapter: crate::fit_adapters::FitAdapterId,
    fit_binary: &str,
    exit_code: Option<i32>,
    stderr: &str,
) -> String {
    let mut msg = format!(
        "Fit process failed for {} (adapter={}, binary={}, {}): {}",
        model_path,
        adapter.as_str(),
        fit_binary,
        decode_fit_exit(exit_code),
        fit_stderr_reason(stderr)
    );
    // Loader death leaves stderr empty, so the static dependency walk is the only evidence.
    if exit_code == Some(crate::engine_utils::EXIT_DLL_NOT_FOUND) {
        msg.push_str(&format!(
            "; {}",
            crate::engine_deps::describe_missing_dlls(
                std::path::Path::new(fit_binary),
                crate::config::FIT_SCAN_BINARY_PROFILE,
            )
        ));
    }
    // FIT has no engine-session stderr to correlate with, so put the reason in the runtime log.
    log::error!("[FIT] {msg}");
    msg
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

    // The same denial table the launch guard uses. A denied knob value must never reach
    // the engine: llama aborts inside context creation (0xC0000409) *after* the weights
    // load, which reads as a silent death with nothing on the console. Refuse first and
    // hand back the rule's reason instead.
    {
        let candidates = [
            ("kv_quant", ["--cache-type-k", "--cache-type-v", "-ctk", "-ctv"].as_slice()),
            ("split", ["--split-mode", "-sm"].as_slice()),
        ];
        let requested: Vec<(&str, String)> = candidates
            .iter()
            .filter(|(knob, _)| crate::engine_denials::knob_has_rules(knob))
            .filter_map(|(knob, flags)| {
                args.windows(2)
                    .find_map(|pair| flags.contains(&pair[0].as_str()).then(|| pair[1].clone()))
                    .map(|value| (*knob, value))
            })
            .collect();
        if !requested.is_empty() {
            let arch = crate::model_cache::get_cached_with_shape(model_path)
                .1
                .or_else(|| crate::gguf_shape::read_shape_for_path(model_path).ok())
                .map(|shape| shape.architecture)
                .unwrap_or_default();
            for (knob, value) in requested {
                if let Some(denial) = crate::engine_denials::evaluate(knob, &value, &arch) {
                    log::warn!("[denial] {}", denial.message());
                    return Err(denial.message());
                }
            }
        }
    }

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

    if let Some(mut raw) = adapter.parse_scan_output(&stdout, &stderr) {
        let combined = format!("{stdout}\n{stderr}");
        crate::fit_low_vram::enrich_raw_with_fitted_ngl(&mut raw, &combined);
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
/// Extracts the "model" value from common_memory_breakdown_print lines (last CUDA row wins).
pub fn parse_projected_vram(output: &str) -> Option<f64> {
    let mut last: Option<f64> = None;
    for line in output.lines() {
        let lower = line.to_lowercase();
        if lower.contains("memory breakdown") && (lower.contains("mib") || lower.contains("mi b")) {
            // Parse the model column value from breakdown table
            // Format: | - CUDA0 ... | 97886 = 78968 + (152340 = 131595 +   20336 +     408) + ...
            if let Some(model_mib) = extract_model_from_breakdown(line) {
                last = Some(model_mib);
            }
        }
    }
    last
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

/// Trailing unaccounted MiB after the SELF paren: `... (2395 = 500 + 1632 + 263) + 133`
#[cfg(test)]
fn extract_unaccounted_mib_from_cuda_breakdown_line(line: &str) -> Option<f64> {
    let last_close = line.rfind(')')?;
    let after = line[last_close + 1..].trim();
    let plus_idx = after.rfind('+')?;
    extract_number(after[plus_idx + 1..].trim())
}

/// Sum of positive per-GPU `unaccounted` from the last complete memory breakdown table.
/// Engine definition: `unaccounted = total - free - self` (accounting residual, NOT split tax).
/// Values are often negative during --fit; do not surface in forecast UI.
#[cfg(test)]
pub fn parse_last_breakdown_unaccounted_mib(output: &str) -> Option<f64> {
    let mut last_sum: Option<f64> = None;
    let mut in_table = false;
    let mut table_sum = 0.0_f64;

    for line in output.lines() {
        if is_memory_breakdown_header(line) {
            table_sum = 0.0;
            in_table = true;
            continue;
        }
        if !in_table || !line.contains('|') {
            continue;
        }
        let lower = line.to_lowercase();
        if lower.contains("cuda") {
            if let Some(v) = extract_unaccounted_mib_from_cuda_breakdown_line(line) {
                if v > 0.0 {
                    table_sum += v;
                }
            }
        } else if lower.contains("host") && !lower.contains("cuda") {
            if table_sum > 0.5 {
                last_sum = Some(table_sum);
            }
            in_table = false;
        }
    }

    last_sum
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

/// Last Host row `self = model + context + compute` from a memory-breakdown table.
pub fn parse_last_host_components(output: &str) -> Option<GpuComponentMib> {
    let mut last = None;
    for line in output.lines() {
        if let Some(c) = parse_host_components_from_breakdown_line(line) {
            last = Some(c);
        }
    }
    last
}

fn parse_host_components_from_breakdown_line(line: &str) -> Option<GpuComponentMib> {
    let lower = line.to_lowercase();
    if !lower.contains("host") || lower.contains("cuda") || !line.contains('|') {
        return None;
    }
    let host_pos = line.find("Host").or_else(|| lower.find("host"))?;
    let after = line.get(host_pos..)?;
    let cell = after.split('|').nth(1).unwrap_or(after);
    let eq = cell.find('=')?;
    let rhs = &cell[eq + 1..];
    let parts: Vec<f64> = rhs
        .split('+')
        .filter_map(extract_number)
        .collect();
    if parts.len() < 3 {
        return None;
    }
    Some(GpuComponentMib {
        model_mib: parts[0],
        ctx_mib: parts[1],
        compute_mib: parts[2],
    })
}

#[tauri::command]
pub async fn fit_scan_model(
    model_path: String,
    _provider_id: Option<String>,
    ctx_size: serde_json::Value,
    kv_quant: String,
    device: String,
    split_mode: String,
    batch: u32,
    _ubatch: u32,
    _flash_attn: bool,
    _offload_mode: String,
    // full (default) | low_vram — free-aware spill probe (manual RE-PROBE LOW VRAM).
    mode: Option<String>,
    // NVML free MiB for target GPU mask (low_vram fit-target correction).
    free_budget_mib: Option<f64>,
    app: tauri::State<'_, AppContext>,
) -> Result<FitScanResult, BlackwellError> {
    let cfg = {
        let guard = app
            .config
            .lock()
            .map_err(|e| BlackwellError::EngineStateBusy { message: e.to_string() })?;
        guard.clone()
    };

    let backend_type = _provider_id.unwrap_or_else(|| crate::config::DEFAULT_PROVIDER_ID.to_string());
    let probe_mode = mode.unwrap_or_else(|| "full".to_string());
    let is_low_vram = probe_mode.eq_ignore_ascii_case("low_vram");

    if let Some(note) = model_fit_skip_note(&backend_type, &model_path) {
        app.log_hub.emit_console_line(
            BlackwellOutputConsoleCategory::Utils,
            &format!("[FIT] {} | skipped | {}", model_path, note),
            BlackwellOutputConsoleLineStyle::Normal,
        );
        return Err(BlackwellError::FitProbeSkipped { message: note.to_string() });
    }

    let fit_binary = resolve_fit_binary(&cfg, &backend_type, "")
        .map_err(crate::errors::classify_fit_probe)?;

    let ctx_int: usize = match &ctx_size {
        serde_json::Value::Number(n) => n.as_u64().map(|v| v as usize).unwrap_or(32768),
        _ => ctx_size.to_string().parse::<usize>().unwrap_or(32768),
    };

    let gpu_count = detect_gpu_count();
    let gpu_mask = crate::engine_utils::compute_gpu_mask_from_params(&device, &split_mode, gpu_count, false);

    let fit_adapter = resolve_fit_adapter(&backend_type);

    let args = if is_low_vram {
        let fit_binary_list = fit_binary.clone();
        let gpu_mask_list = gpu_mask.clone();
        let fit_frees = tokio::task::spawn_blocking(move || {
            crate::fit_low_vram::list_devices_free_mib(&fit_binary_list, &gpu_mask_list)
        })
        .await
        .map_err(|e| crate::errors::classify_fit_probe(format!("low-vram list-devices join: {e}")))
        .and_then(|inner| inner.map_err(crate::errors::classify_fit_probe))?;

        // Single-device mask → first free; multi → min free (tightest card).
        let fit_free = fit_frees.iter().copied().fold(f64::INFINITY, f64::min);
        let nvml_free = free_budget_mib.unwrap_or(fit_free);
        let fit_target = crate::fit_low_vram::fit_target_mib_from_free(fit_free, nvml_free);
        app.log_hub.emit_console_line(
            BlackwellOutputConsoleCategory::Utils,
            &format!(
                "[FIT] PROBE-LOW_VRAM  target={fit_target} MiB (fit_free={fit_free:.0} nvml_free={nvml_free:.0})"
            ),
            BlackwellOutputConsoleLineStyle::Warning,
        );
        crate::fit_low_vram::build_low_vram_fit_command(
            &model_path,
            ctx_int,
            &kv_quant,
            batch,
            _ubatch,
            &split_mode,
            fit_target,
        )
    } else {
        build_fit_command(
            &backend_type,
            &model_path,
            ctx_int,
            &kv_quant,
            batch,
            _ubatch,
            1,
            &split_mode,
        )
    };

    let fit_result =
        scan_single_anchor(&fit_binary, &args, &gpu_mask, fit_adapter).await;
    match &fit_result {
        Ok(raw) => {
            let model_name = std::path::Path::new(&model_path)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(&model_path);
            let tag = if is_low_vram {
                "PROBE-LOW_VRAM"
            } else {
                "PROBE"
            };
            let ngl = raw
                .fitted_ngl
                .map(|n| n.to_string())
                .unwrap_or_else(|| "full".into());
            let host = raw.host_mib.unwrap_or(0.0);
            let host_split = raw
                .host_components_mib
                .as_ref()
                .map(|c| {
                    format!(
                        " host={:.0} (model={:.0} ctx={:.0} compute={:.0})",
                        host, c.model_mib, c.ctx_mib, c.compute_mib
                    )
                })
                .unwrap_or_else(|| format!(" host={host:.0}"));
            let style = if is_low_vram {
                BlackwellOutputConsoleLineStyle::Warning
            } else {
                BlackwellOutputConsoleLineStyle::Normal
            };
            app.log_hub.emit_console_line(
                BlackwellOutputConsoleCategory::Utils,
                &format!(
                    "[FIT] {tag}  ngl={ngl}  GPU={:.0}{host_split}  {model_name}",
                    raw.vram_mib
                ),
                style,
            );
        }
        Err(e) => {
            let tag = if is_low_vram {
                "PROBE-LOW_VRAM"
            } else {
                "PROBE"
            };
            let model_name = std::path::Path::new(&model_path)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(&model_path);
            let cli_split = fit_cli_split_mode(&split_mode);
            let split_note = if cli_split.is_empty() {
                "split=none".to_string()
            } else if cli_split != split_mode.trim().to_lowercase() {
                format!("split={split_mode}→{cli_split}")
            } else {
                format!("split={cli_split}")
            };
            let why = e
                .rsplit("): ")
                .next()
                .unwrap_or(e.as_str())
                .trim();
            let decode = if e.contains("0xC0000409") || e.contains("STACK_BUFFER") {
                "crash=0xC0000409"
            } else if e.contains("exit 1") {
                "abort=exit1"
            } else if e.contains("timeout") {
                "timeout"
            } else {
                "fail"
            };
            // One line, Warning - not two Error lines. A model the fit tool cannot express
            // (tensor split is mapped to layer before the probe) is a finding about that
            // model, not an app failure; the caller still receives the Err.
            app.log_hub.emit_console_line(
                BlackwellOutputConsoleCategory::Utils,
                &format!(
                    "[FIT] {tag}  failed  {decode}  {split_note}  ctx={ctx_int}  kv={kv_quant}  gpus={gpu_count}  mask={gpu_mask}  {model_name}  ·  {why}"
                ),
                BlackwellOutputConsoleLineStyle::Warning,
            );
        }
    }
    let raw = fit_result.map_err(crate::errors::classify_fit_probe)?;
    let vram_mib = raw.vram_mib;

    let gpus = crate::telemetry::scan_gpus().await.unwrap_or_default();
    let total_gpu_mib: f64 = gpus.iter().map(|g| g.memory_total as f64).sum();

    Ok(FitScanResult {
        model_path,
        vram_mib,
        ctx: ctx_int,
        kv_quant,
        fits: vram_mib <= total_gpu_mib,
        gpu_breakdown_mib: raw.gpu_breakdown_mib,
        host_mib: raw.host_mib,
        gpu_components_mib: raw.gpu_components_mib,
        host_components_mib: raw.host_components_mib,
        fitted_ngl: raw.fitted_ngl,
        probe_mode: Some(if is_low_vram {
            "low_vram".into()
        } else {
            "full".into()
        }),
    })
}


