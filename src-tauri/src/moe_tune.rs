//! Expert-cache calibration (`--moe-cache-mib` / `--moe-cache-cpu-share`).
//!
//! Measures decode speed for a small set of configurations by running `llama-server` on a private
//! port with a fixed prompt. Deliberately measured-only: there is no routing-trace replay and no
//! cache simulation here, so nothing in this module can drift from the C++ cache policy.
//!
//! The upstream `scripts/moe-cache-tune.py` predicts a whole grid by replaying a recorded trace
//! through a Python copy of `llama-moe-cache.cpp`. We run three real launches instead and report
//! what they measured, which is both cheaper to maintain and impossible to get subtly wrong.

use std::io::Write;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

/// Set by `moe_tune_stop`, polled between candidates and during a launch. A tuning is a long chain
/// of engine starts; without this the only way out was to wait it out or kill the app.
static TUNE_CANCEL: AtomicBool = AtomicBool::new(false);

fn cancel_requested() -> bool {
    TUNE_CANCEL.load(Ordering::SeqCst)
}

/// Resolves as soon as a stop is requested, so a generation in flight can be abandoned.
async fn cancel_watch() {
    loop {
        if cancel_requested() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[tauri::command]
pub async fn moe_tune_stop() -> Result<bool, String> {
    TUNE_CANCEL.store(true, Ordering::SeqCst);
    Ok(true)
}

const HEALTH_POLL: Duration = Duration::from_millis(500);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(240);
const GEN_TIMEOUT: Duration = Duration::from_secs(300);
const N_PREDICT: u32 = 512;
/// VRAM kept free on top of the launch, on NVML: filling to the last hundred MiB costs speed even
/// when the engine "fits" (measured on a 16 GB card: 14.6 GB used lost to 14.2).
const RESERVE_MIB: u64 = 512;
/// Base/candidate alternations used to confirm the winner. Two pairs is the smallest count that
/// can tell a real gain from run-to-run drift.
const CONFIRM_PAIRS: usize = 2;
/// Fixed, plain prose: the calibrated number must not depend on sampling.
const PROMPT: &str = "The lighthouse keeper had kept a logbook for thirty-one years, and in all that time he had never once written down a lie. So when the ship appeared on the horizon on the first calm morning of October, with no flag, no lights and no one on deck, he sat at his small wooden table for a long while before he picked up the pen. Below him the sea was flat and grey, and the gulls had gone quiet. He wrote the date, the hour and the direction of the wind, and then he stopped, because the next line would have to say what he had seen. This is what he finally wrote:";

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MoeTuneCandidate {
    /// Expert weights in host RAM (`-cmoe`). False measures the plain all-on-GPU launch.
    #[serde(default)]
    pub cpu_moe: bool,
    pub cache_mib: u32,
    pub cpu_share: f64,
}

/// Where the measured VRAM went, from the engine's own ledger when the build carries it.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct MoeTuneComponents {
    pub model_mib: u64,
    pub kv_mib: u64,
    pub compute_mib: u64,
    pub host_mib: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoeTunePoint {
    pub cpu_moe: bool,
    pub cache_mib: u32,
    pub cpu_share: f64,
    pub tps: Option<f64>,
    pub error: Option<String>,
    /// NVML `used` (process-attributed) while this configuration was loaded.
    #[serde(default)]
    pub vram_used_mib: Option<u64>,
    #[serde(default)]
    pub vram_free_mib: Option<u64>,
    #[serde(default)]
    pub components: Option<MoeTuneComponents>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoeTuneReport {
    pub points: Vec<MoeTunePoint>,
    /// Best measured configuration - `None` when every run failed.
    pub best: Option<MoeTuneCandidate>,
    pub best_tps: Option<f64>,
    /// CPU-expert baseline (cache off), when one of the candidates measured it.
    pub baseline_tps: Option<f64>,
    /// The plain all-on-GPU launch: the answer for a model that fits, and the number a cache has
    /// to beat. `None` speed means it did not fit (or failed to load).
    pub full_gpu_tps: Option<f64>,
    pub full_gpu_error: Option<String>,
    /// Usable VRAM the candidates were derived from, MiB (0 when the caller supplied its own).
    pub budget_mib: u64,
    pub seconds: f64,
    // ── identity + evidence: what makes this result reusable later ──────────
    #[serde(default)]
    pub measured_at: String,
    #[serde(default)]
    pub model_path: String,
    #[serde(default)]
    pub model_size_bytes: u64,
    #[serde(default)]
    pub ctx_size: u64,
    #[serde(default)]
    pub kv_quant: String,
    #[serde(default)]
    pub split_mode: String,
    #[serde(default)]
    pub tensor_split: Option<String>,
    #[serde(default)]
    pub gpu_mask: String,
    #[serde(default)]
    pub engine_build: Option<String>,
    #[serde(default)]
    pub driver_version: Option<String>,
    /// Free VRAM on the target cards when the run started (what the budget was derived from).
    #[serde(default)]
    pub start_free_mib: u64,
    /// The confirmation alternations: label ("base" / "candidate") and the measured t/s.
    #[serde(default)]
    pub pair_runs: Vec<MoeTunePairRun>,
    /// Median gain of the winner over the CPU-expert baseline, and the run-to-run spread it had to
    /// clear. `verdict` is "improved", "inconclusive" or "flat" - or absent when no pairing ran.
    #[serde(default)]
    pub gain_pct: Option<f64>,
    #[serde(default)]
    pub noise_pct: Option<f64>,
    #[serde(default)]
    pub verdict: Option<String>,
    /// True when the run was stopped part-way; the points collected up to that moment are kept.
    #[serde(default)]
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoeTunePairRun {
    pub label: String,
    pub cache_mib: u32,
    pub cpu_share: f64,
    pub tps: Option<f64>,
}

/// Round to the 256 MiB step the cache flag is tuned in.
fn step_mib(mib: u64) -> u32 {
    ((mib / 256) * 256).max(0) as u32
}

/// Usable VRAM for the expert cache, from what the launch itself needs.
///
/// `start_free` is NVML free before tuning; `components` is the ledger of the cache-off run
/// (model + KV + compute on the device). The reserve keeps the card off its last hundred MiB.
pub fn compute_budget(start_free_mib: u64, components: Option<MoeTuneComponents>) -> u64 {
    let launch_mib = components
        .map(|c| c.model_mib + c.kv_mib + c.compute_mib)
        .unwrap_or(0);
    start_free_mib
        .saturating_sub(launch_mib)
        .saturating_sub(RESERVE_MIB)
}

/// Cache sizes to measure: 25, 50, 75 and 100 % of the budget, on the 256 MiB step the flag uses.
/// Granular on purpose - a home test found its optimum at 6.2 GiB on a 16 GB card, which a
/// quarter/half/three-quarter grid can miss entirely.
pub fn cache_steps(budget_mib: u64) -> Vec<u32> {
    let mut out: Vec<u32> = Vec::new();
    for pct in [25u64, 50, 75, 100] {
        let mib = step_mib(budget_mib * pct / 100);
        if mib >= 1024 && !out.contains(&mib) {
            out.push(mib);
        }
    }
    out
}

/// Confirm the winner against the CPU-expert baseline: alternate base/candidate, then compare.
/// Returns (median gain %, noise %, verdict). "inconclusive" is a legitimate answer - a difference
/// smaller than the run-to-run spread is not a tuning.
pub fn pair_verdict(baselines: &[f64], bests: &[f64]) -> (Option<f64>, Option<f64>, Option<String>) {
    if baselines.len() < 2 || bests.len() < 2 || baselines.len() != bests.len() {
        return (None, None, None);
    }
    let b_mean = baselines.iter().sum::<f64>() / baselines.len() as f64;
    if !(b_mean > 0.0) {
        return (None, None, None);
    }
    let spread = (baselines[0] - baselines[1]).abs() / b_mean;
    let mut gains: Vec<f64> = baselines
        .iter()
        .zip(bests.iter())
        .map(|(b, s)| if *b > 0.0 { s / b } else { 1.0 })
        .collect();
    gains.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = gains[gains.len() / 2];
    let all_above = gains.iter().all(|g| *g >= 1.0 + spread);
    let any_below = gains.iter().any(|g| *g < 1.0 + spread);
    let verdict = if all_above && median > 1.02 {
        "improved"
    } else if any_below && median < 1.0 + spread {
        "inconclusive"
    } else {
        "flat"
    };
    (
        Some((median - 1.0) * 100.0),
        Some(spread * 100.0),
        Some(verdict.to_string()),
    )
}

/// The winner: the all-on-GPU launch unless a CPU-expert configuration beats it by more than 2 %.
///
/// The 2 % band matters: keeping the experts on the GPU is the simpler, more predictable launch,
/// so a cache that merely ties it is not worth recommending. Between cache configurations a tie
/// within 2 % keeps the smaller cache (and share 0), because VRAM is also context and neighbours.
pub fn pick_best(points: &[MoeTunePoint]) -> Option<(MoeTuneCandidate, f64)> {
    let mut best: Option<(MoeTuneCandidate, f64)> = None;
    for p in points {
        let Some(tps) = p.tps else { continue };
        if !tps.is_finite() || tps <= 0.0 {
            continue;
        }
        let cand = MoeTuneCandidate {
            cpu_moe: p.cpu_moe,
            cache_mib: p.cache_mib,
            cpu_share: p.cpu_share,
        };
        best = match best {
            None => Some((cand, tps)),
            Some((b_cand, b_tps)) => {
                let better = tps > b_tps * 1.02;
                // Prefer the GPU: on a tie the launch without host experts wins.
                let equal_band = tps >= b_tps * 0.98;
                let gpu_preferred = !cand.cpu_moe && b_cand.cpu_moe;
                let cheaper = (cand.cache_mib, cand.cpu_share.to_bits())
                    < (b_cand.cache_mib, b_cand.cpu_share.to_bits());
                if better || (equal_band && (gpu_preferred || (!b_cand.cpu_moe && cheaper))) {
                    Some((cand, tps))
                } else {
                    Some((b_cand, b_tps))
                }
            }
        };
    }
    best
}

/// llama-server argv for one calibration run. Only the placement-relevant subset: the cache is
/// split across devices like `-ts`, so the split and the tensor split must match the real config.
pub fn build_tune_args(
    model_path: &str,
    ctx_size: usize,
    kv_quant: &str,
    split_mode: &str,
    tensor_split: Option<&str>,
    batch: u32,
    ubatch: u32,
    port: u16,
    candidate: &MoeTuneCandidate,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-m".into(),
        model_path.into(),
        "-c".into(),
        ctx_size.to_string(),
        "--cache-type-k".into(),
        kv_quant.to_lowercase(),
        "--cache-type-v".into(),
        kv_quant.to_lowercase(),
        "-b".into(),
        batch.to_string(),
        "-ub".into(),
        ubatch.to_string(),
        "-ngl".into(),
        "999".into(),
        "--flash-attn".into(),
        "on".into(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
        "-np".into(),
        "1".into(),
    ];
    if candidate.cpu_moe {
        args.push("-cmoe".into());
    }
    let split = split_mode.trim();
    if !split.is_empty() && !split.eq_ignore_ascii_case("none") {
        args.push("--split-mode".into());
        args.push(split.to_lowercase());
    }
    if let Some(ts) = tensor_split.map(str::trim).filter(|s| !s.is_empty()) {
        args.push("-ts".into());
        args.push(ts.to_string());
    }
    if candidate.cache_mib > 0 {
        args.push("--moe-cache-mib".into());
        args.push(candidate.cache_mib.to_string());
    }
    if candidate.cpu_share > 0.0 {
        args.push("--moe-cache-cpu-share".into());
        args.push(format!("{:.2}", candidate.cpu_share));
    }
    args
}

/// Kills the calibration server on every exit path, including early returns.
struct ChildGuard(Option<Child>);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn pick_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("no free loopback port for the calibration server: {e}"))?;
    listener
        .local_addr()
        .map(|a| a.port())
        .map_err(|e| format!("no free loopback port for the calibration server: {e}"))
}

fn log_tail(path: &std::path::Path) -> String {
    let Ok(text) = std::fs::read_to_string(path) else {
        return String::new();
    };
    let chars: Vec<char> = text.chars().collect();
    let start = chars.len().saturating_sub(4000);
    chars[start..].iter().collect()
}

/// What one measured launch produced: the speed plus the memory it actually used.
#[derive(Debug, Clone, Default)]
struct Measurement {
    tps: f64,
    vram_used_mib: Option<u64>,
    vram_free_mib: Option<u64>,
    components: Option<MoeTuneComponents>,
}

/// NVML `used`/`free` for one card. `used` is process-attributed, so an idle card reads 0.
fn sample_vram(index: u32) -> (Option<u64>, Option<u64>) {
    let Some(samples) = crate::nvml_metrics::scan() else {
        return (None, None);
    };
    match samples.iter().find(|s| s.index == index) {
        Some(s) => (Some(s.memory_used_mib), Some(s.memory_free_mib)),
        None => (None, None),
    }
}

/// Read the engine's own ledger (`/memory`, present only in a memory-patched build) and fold it into
/// model / KV / compute / host. Missing endpoint or unpatched build simply yields `None`.
async fn fetch_components(client: &reqwest::Client, base: &str) -> Option<MoeTuneComponents> {
    let payload: serde_json::Value = client
        .get(format!("{base}/memory"))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let ledger = payload.get("ledger")?.as_array()?;
    if ledger.is_empty() {
        return None;
    }
    let mut c = MoeTuneComponents::default();
    for entry in ledger {
        let mib = entry.get("mib").and_then(|m| m.as_u64()).unwrap_or(0);
        let kind = entry.get("kind").and_then(|k| k.as_str()).unwrap_or("");
        let device = entry.get("device").and_then(|d| d.as_str()).unwrap_or("");
        if device.eq_ignore_ascii_case("CUDA_Host") || device.eq_ignore_ascii_case("host") {
            c.host_mib += mib;
            continue;
        }
        match kind {
            "model" => c.model_mib += mib,
            "kv" | "rs" | "rotation" | "dsv4_state" => c.kv_mib += mib,
            _ => c.compute_mib += mib,
        }
    }
    if c.host_mib == 0 {
        if let Some(host) = payload.get("host_self_mib").and_then(|h| h.as_u64()) {
            c.host_mib = host;
        }
    }
    Some(c)
}

/// One measured launch: spawn, wait for health, read the ledger, generate 512 tokens, read the
/// timing and the VRAM it left in use, kill.
async fn run_one(
    binary: &PathBuf,
    profile: &str,
    gpu_mask: &str,
    args: &[String],
    port: u16,
    log_path: &std::path::Path,
    device_index: u32,
) -> Result<Measurement, String> {
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let log = std::fs::File::create(log_path)
        .map_err(|e| format!("cannot create {}: {e}", log_path.display()))?;
    let log_err = log
        .try_clone()
        .map_err(|e| format!("cannot duplicate the calibration log handle: {e}"))?;

    let work_dir = binary
        .parent()
        .ok_or_else(|| format!("engine binary has no parent: {}", binary.display()))?;
    let mut cmd = Command::new(binary);
    cmd.current_dir(work_dir)
        .args(args)
        .env("CUDA_VISIBLE_DEVICES", gpu_mask)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    crate::engine_utils::apply_cuda_toolchain_for_profile(&mut cmd, profile)?;

    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to start {}: {e}", binary.display()))?;
    let _guard = ChildGuard(Some(child));

    let base = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let started = Instant::now();
    loop {
        if cancel_requested() {
            return Err("cancelled".to_string());
        }
        if started.elapsed() > HEALTH_TIMEOUT {
            return Err(format!(
                "server did not become ready within {}s\n{}",
                HEALTH_TIMEOUT.as_secs(),
                log_tail(log_path)
            ));
        }
        match client.get(format!("{base}/health")).send().await {
            Ok(resp) if resp.status().is_success() => break,
            _ => tokio::time::sleep(HEALTH_POLL).await,
        }
    }

    let components = fetch_components(&client, &base).await;

    let body = serde_json::json!({
        "prompt": PROMPT,
        "n_predict": N_PREDICT,
        "temperature": 0.0,
        "top_k": 1,
        "top_p": 1.0,
        "cache_prompt": false,
        "stream": false,
        // Without this a quantized model can answer the sentence and stop on the first token,
        // which measures 0 t/s instead of decode speed.
        "ignore_eos": true,
    });
    let gen_client = reqwest::Client::builder()
        .timeout(GEN_TIMEOUT)
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = tokio::select! {
        resp = gen_client.post(format!("{base}/completion")).json(&body).send() => {
            resp.map_err(|e| format!("completion request failed: {e}\n{}", log_tail(log_path)))?
        }
        _ = cancel_watch() => return Err("cancelled".to_string()),
    };
    if !resp.status().is_success() {
        return Err(format!(
            "completion returned {}\n{}",
            resp.status(),
            log_tail(log_path)
        ));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("completion response was not JSON: {e}"))?;
    let tps = json
        .get("timings")
        .and_then(|t| t.get("predicted_per_second"))
        .and_then(|v| v.as_f64())
        .ok_or_else(|| {
            format!(
                "the server returned no timings\n{}",
                log_tail(log_path)
            )
        })?;
    if !tps.is_finite() || tps <= 0.0 {
        let predicted_n = json
            .get("timings")
            .and_then(|t| t.get("predicted_n"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        return Err(format!(
            "implausible decode speed: {tps} t/s ({predicted_n} token(s) generated)"
        ));
    }
    let _ = std::io::stdout().flush();
    // Sample after generation: the expert cache is warm and any prompt-path loan has been paid.
    let (vram_used_mib, vram_free_mib) = sample_vram(device_index);
    Ok(Measurement {
        tps,
        vram_used_mib,
        vram_free_mib,
        components,
    })
}

/// Usable VRAM for the expert cache on the cards this launch may touch, MiB.
fn cache_budget_mib(gpu_mask: &str) -> u64 {
    let targets: Vec<u32> = gpu_mask
        .split(',')
        .filter_map(|p| p.trim().parse::<u32>().ok())
        .collect();
    let Some(samples) = crate::nvml_metrics::scan() else {
        return 0;
    };
    samples
        .iter()
        .filter(|s| targets.is_empty() || targets.contains(&s.index))
        .map(|s| s.memory_free_mib)
        .sum()
}

/// FNV-1a over the identity string: a short, stable filename, no dependency.
fn store_key(identity: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in identity.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Everything that makes a result reusable: change any of it and the numbers are not this config's.
fn identity(
    model_path: &str,
    model_size_bytes: u64,
    ctx_size: usize,
    kv_quant: &str,
    split_mode: &str,
    tensor_split: Option<&str>,
    gpu_mask: &str,
) -> String {
    let ts = tensor_split.unwrap_or("").trim();
    format!(
        "v1|{model_path}|{model_size_bytes}|ctx={ctx_size}|kv={}|split={}|ts={ts}|gpu={gpu_mask}",
        kv_quant.to_lowercase(),
        split_mode.to_lowercase()
    )
}

fn store_path(key: &str) -> std::path::PathBuf {
    crate::config::cache_dir()
        .join("moe-tune")
        .join(format!("{key}.json"))
}

fn save_report(report: &MoeTuneReport, key: &str) -> Result<(), String> {
    let path = store_path(key);
    let stored = StoredTune {
        identity: format!(
            "{}|ctx={}|kv={}|split={}|ts={}|gpu={}",
            report.model_path,
            report.ctx_size,
            report.kv_quant,
            report.split_mode,
            report.tensor_split.clone().unwrap_or_default(),
            report.gpu_mask
        ),
        report: report.clone(),
    };
    crate::fs_util::write_json_atomic(&path, &stored)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredTune {
    /// Human-readable identity; the filename is its hash.
    identity: String,
    report: MoeTuneReport,
}

/// Run one candidate: private port, private log, progress events, and the measurement back.
#[allow(clippy::too_many_arguments)]
async fn measure_candidate(
    app: &tauri::AppHandle,
    binary: &PathBuf,
    profile: &str,
    gpu_mask: &str,
    model_path: &str,
    ctx_size: usize,
    kv_quant: &str,
    split_mode: &str,
    tensor_split: Option<&str>,
    batch: u32,
    ubatch: u32,
    target_device: u32,
    log_dir: &std::path::Path,
    cand: &MoeTuneCandidate,
    index: usize,
    total: usize,
) -> MoeTunePoint {
    let port = match pick_port() {
        Ok(port) => port,
        Err(e) => {
            return MoeTunePoint {
                cpu_moe: cand.cpu_moe,
                cache_mib: cand.cache_mib,
                cpu_share: cand.cpu_share,
                tps: None,
                error: Some(e),
                vram_used_mib: None,
                vram_free_mib: None,
                components: None,
            }
        }
    };
    let args = build_tune_args(
        model_path,
        ctx_size,
        kv_quant,
        split_mode,
        tensor_split,
        batch,
        ubatch,
        port,
        cand,
    );
    let log_path = log_dir.join(format!(
        "{}-{}-{}.log",
        cand.cache_mib,
        (cand.cpu_share * 100.0).round() as u32,
        port
    ));
    if cancel_requested() {
        return MoeTunePoint {
            cpu_moe: cand.cpu_moe,
            cache_mib: cand.cache_mib,
            cpu_share: cand.cpu_share,
            tps: None,
            error: Some("cancelled".to_string()),
            vram_used_mib: None,
            vram_free_mib: None,
            components: None,
        };
    }
    let _ = app.emit(
        "moe-tune-progress",
        serde_json::json!({
            "index": index,
            "total": total,
            "cpu_moe": cand.cpu_moe,
            "cache_mib": cand.cache_mib,
            "cpu_share": cand.cpu_share,
            "status": "running",
        }),
    );
    let measured = run_one(binary, profile, gpu_mask, &args, port, &log_path, target_device).await;
    let (tps, error, vram_used_mib, vram_free_mib, components) = match measured {
        Ok(m) => (
            Some(m.tps),
            None,
            m.vram_used_mib,
            m.vram_free_mib,
            m.components,
        ),
        Err(e) => (None, Some(e), None, None, None),
    };
    if let Some(e) = &error {
        log::warn!(
            "[moe-tune] cache {} MiB share {:.2} failed: {e}",
            cand.cache_mib,
            cand.cpu_share
        );
    }
    let _ = app.emit(
        "moe-tune-progress",
        serde_json::json!({
            "index": index,
            "total": total,
            "cpu_moe": cand.cpu_moe,
            "cache_mib": cand.cache_mib,
            "cpu_share": cand.cpu_share,
            "status": "done",
            "tps": tps,
        }),
    );
    MoeTunePoint {
        cpu_moe: cand.cpu_moe,
        cache_mib: cand.cache_mib,
        cpu_share: cand.cpu_share,
        tps,
        error,
        vram_used_mib,
        vram_free_mib,
        components,
    }
}

#[tauri::command]
pub async fn moe_tune_history(
    model_path: String,
    ctx_size: usize,
    kv_quant: String,
    split_mode: String,
    tensor_split: Option<String>,
    device: String,
    gpu_count: Option<usize>,
) -> Result<Option<MoeTuneReport>, String> {
    let size = std::fs::metadata(&model_path).map(|m| m.len()).unwrap_or(0);
    let gpus = gpu_count.unwrap_or_else(crate::telemetry::detect_gpu_count);
    let mask = crate::engine_utils::compute_gpu_mask_from_params(&device, &split_mode, gpus, false);
    let id = identity(
        &model_path,
        size,
        ctx_size,
        &kv_quant,
        &split_mode,
        tensor_split.as_deref(),
        &mask,
    );
    let path = store_path(&store_key(&id));
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let stored: StoredTune =
        serde_json::from_str(&text).map_err(|e| format!("cannot parse {}: {e}", path.display()))?;
    Ok(Some(stored.report))
}

#[tauri::command]
pub async fn moe_tune_run(
    app: tauri::AppHandle,
    ctx: tauri::State<'_, crate::engine::AppContext>,
    model_path: String,
    provider_id: Option<String>,
    ctx_size: usize,
    kv_quant: String,
    device: String,
    split_mode: String,
    tensor_split: Option<String>,
    batch: u32,
    ubatch: u32,
    candidates: Option<Vec<MoeTuneCandidate>>,
) -> Result<MoeTuneReport, String> {
    let started = Instant::now();
    TUNE_CANCEL.store(false, Ordering::SeqCst);
    // Fail before touching the engine: a wrong path must not wait out the health timeout.
    if !std::path::Path::new(&model_path).exists() {
        return Err(format!("model file not found: {model_path}"));
    }
    let provider = provider_id
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| crate::config::DEFAULT_PROVIDER_ID.to_string());
    let cfg = {
        let guard = ctx
            .config
            .lock()
            .map_err(|e| format!("config lock poisoned: {e}"))?;
        guard.clone()
    };
    // The active profile's path is already resolved into `binary_path` when providers load.
    let binary = cfg
        .providers
        .iter()
        .find(|p| p.id == provider)
        .map(|p| crate::config::resolve_path(&p.binary_path))
        .filter(|path| path.exists())
        .map(Ok)
        .unwrap_or_else(|| crate::engine_utils::find_provider_binary(&cfg, &provider, ""))?;
    if !binary.exists() {
        return Err(format!(
            "engine binary not found: {} (build the provider first)",
            binary.display()
        ));
    }
    let profile = crate::engine_utils::binary_profile_from_path(&binary)
        .unwrap_or_else(|| crate::config::DEFAULT_BINARY_PROFILE.to_string());

    let model_size_bytes = std::fs::metadata(&model_path).map(|m| m.len()).unwrap_or(0);
    let gpu_count = crate::telemetry::detect_gpu_count();
    let gpu_mask =
        crate::engine_utils::compute_gpu_mask_from_params(&device, &split_mode, gpu_count, false);
    let identity = identity(
        &model_path,
        model_size_bytes,
        ctx_size,
        &kv_quant,
        &split_mode,
        tensor_split.as_deref(),
        &gpu_mask,
    );
    let target_device: u32 = gpu_mask
        .split(',')
        .next()
        .and_then(|p| p.trim().parse().ok())
        .unwrap_or(0);
    let start_free_mib = cache_budget_mib(&gpu_mask);

    // A calibration launch allocates real VRAM; refuse rather than fight an engine for the card.
    // DEV may proceed on an occupied card on purpose: that is how the VRAM ballast turns a 96 GB
    // card into an 8/16/32 GB one, and the free figure it leaves becomes the tuning budget. A
    // release build keeps the refusal - no reduced figure is ever honoured outside DEV.
    let occupied = crate::engine_utils::occupied_target_devices(&gpu_mask, 4096);
    if let Some((index, used_mib)) = occupied.first() {
        if cfg!(debug_assertions) {
            log::warn!(
                "[moe-tune] GPU-{index} already has {:.1} GiB in use - DEV build, measuring against the free remainder",
                *used_mib as f64 / 1024.0
            );
        } else {
            return Err(format!(
                "GPU-{index} already has {:.1} GiB in use - stop the engines on that card before tuning",
                *used_mib as f64 / 1024.0
            ));
        }
    }

    let log_dir = crate::config::cache_dir().join("moe-tune");
    let explicit = candidates.clone();
    let mut points: Vec<MoeTunePoint> = Vec::new();
    let mut ran = 0usize;

    // ── Phase 0: the CPU-expert baseline. It also tells the ledger how much the launch itself
    // needs (model + KV + compute), which is the base of every cache size below.
    let baseline = MoeTuneCandidate {
        cpu_moe: true,
        cache_mib: 0,
        cpu_share: 0.0,
    };
    let first = measure_candidate(
        &app,
        &binary,
        &profile,
        &gpu_mask,
        &model_path,
        ctx_size,
        &kv_quant,
        &split_mode,
        tensor_split.as_deref(),
        batch,
        ubatch,
        target_device,
        &log_dir,
        &baseline,
        ran,
        1,
    )
    .await;
    let components = first.components;
    points.push(first);
    ran += 1;

    // The plan is known only now: 1 baseline + 1 all-on-GPU + cache steps + 2 share points + pairs.
    //
    // The budget comes from the free VRAM *measured while the cache-off run was loaded*, not from
    // the ledger estimate: that reading already includes the weights, KV, compute and the
    // allocator/graph slack, and it is what the card actually had left. Falling back to the ledger
    // (and then to the bare free figure) keeps the first run on an unpatched engine usable.
    let budget = match &explicit {
        Some(_) => start_free_mib,
        None => points
            .first()
            .and_then(|p| p.vram_free_mib)
            .map(|free| free.saturating_sub(RESERVE_MIB))
            .unwrap_or_else(|| compute_budget(start_free_mib, components)),
    };
    let steps = match &explicit {
        Some(_) => Vec::new(),
        None => cache_steps(budget),
    };
    let share_points = if steps.is_empty() { 0 } else { 2 };
    let total = 1 + 1 + steps.len() + share_points + CONFIRM_PAIRS * 2;

    // ── Phase 1: the plain all-on-GPU launch. It is the answer for a model that fits, and the
    // number any cache has to beat. A file larger than the free VRAM cannot fit, and launching it
    // anyway pages for minutes and drags the card to 0 MiB free - the pressure this test must not
    // create. Skip it and say why.
    let full_gpu = MoeTuneCandidate {
        cpu_moe: false,
        cache_mib: 0,
        cpu_share: 0.0,
    };
    let weights_mib = model_size_bytes / (1024 * 1024);
    if weights_mib.saturating_add(RESERVE_MIB) <= start_free_mib {
        points.push(
            measure_candidate(
                &app, &binary, &profile, &gpu_mask, &model_path, ctx_size, &kv_quant, &split_mode,
                tensor_split.as_deref(), batch, ubatch, target_device, &log_dir, &full_gpu, ran, total,
            )
            .await,
        );
    } else {
        log::info!(
            "[moe-tune] skipping the all-on-GPU launch: {weights_mib} MiB of weights vs {start_free_mib} MiB free"
        );
        points.push(MoeTunePoint {
            cpu_moe: false,
            cache_mib: 0,
            cpu_share: 0.0,
            tps: None,
            error: Some(format!(
                "skipped - {weights_mib} MiB of weights does not fit in {start_free_mib} MiB of free VRAM"
            )),
            vram_used_mib: None,
            vram_free_mib: None,
            components: None,
        });
    }
    ran += 1;

    // ── Phase 2: the granular cache sizes from the computed budget (or the caller's list).
    let planned: Vec<MoeTuneCandidate> = match &explicit {
        Some(list) => list.clone(),
        None => steps
            .iter()
            .map(|mib| MoeTuneCandidate {
                cpu_moe: true,
                cache_mib: *mib,
                cpu_share: 0.0,
            })
            .collect(),
    };
    for cand in &planned {
        points.push(
            measure_candidate(
                &app, &binary, &profile, &gpu_mask, &model_path, ctx_size, &kv_quant, &split_mode,
                tensor_split.as_deref(), batch, ubatch, target_device, &log_dir, cand, ran, total,
            )
            .await,
        );
        ran += 1;
    }

    // ── Phase 3: does computing the misses on the CPU pay at the size that won?
    if !steps.is_empty() {
        let best_size = points
            .iter()
            .filter(|p| p.cpu_moe && p.cache_mib > 0)
            .filter_map(|p| p.tps.map(|t| (p.cache_mib, t)))
            .fold(None::<(u32, f64)>, |acc, (mib, t)| match acc {
                Some((bm, bt)) if bt >= t => Some((bm, bt)),
                _ => Some((mib, t)),
            })
            .map(|(mib, _)| mib);
        if let Some(size) = best_size {
            for share in [0.5_f64, 0.95] {
                let cand = MoeTuneCandidate {
                    cpu_moe: true,
                    cache_mib: size,
                    cpu_share: share,
                };
                points.push(
                    measure_candidate(
                        &app, &binary, &profile, &gpu_mask, &model_path, ctx_size, &kv_quant,
                        &split_mode, tensor_split.as_deref(), batch, ubatch, target_device,
                        &log_dir, &cand, ran, total,
                    )
                    .await,
                );
                ran += 1;
            }
        }
    }

    // ── Phase 4: confirm the winner against the baseline, alternating them.
    let mut pair_runs: Vec<MoeTunePairRun> = Vec::new();
    if let Some((winner, winner_tps)) = pick_best(&points) {
        let worth_confirming = winner.cpu_moe
            && winner.cache_mib > 0
            && winner_tps > points
                .iter()
                .find(|p| p.cpu_moe && p.cache_mib == 0 && p.cpu_share == 0.0)
                .and_then(|p| p.tps)
                .unwrap_or(0.0);
        if worth_confirming {
            for _ in 0..CONFIRM_PAIRS {
                for (label, cand) in [("base", baseline), ("candidate", winner)] {
                    let point = measure_candidate(
                        &app, &binary, &profile, &gpu_mask, &model_path, ctx_size, &kv_quant,
                        &split_mode, tensor_split.as_deref(), batch, ubatch, target_device,
                        &log_dir, &cand, ran, total,
                    )
                    .await;
                    pair_runs.push(MoeTunePairRun {
                        label: label.to_string(),
                        cache_mib: point.cache_mib,
                        cpu_share: point.cpu_share,
                        tps: point.tps,
                    });
                    ran += 1;
                }
            }
        }
    }
    let baselines: Vec<f64> = pair_runs
        .iter()
        .filter(|r| r.label == "base")
        .filter_map(|r| r.tps)
        .collect();
    let candidates_tps: Vec<f64> = pair_runs
        .iter()
        .filter(|r| r.label == "candidate")
        .filter_map(|r| r.tps)
        .collect();
    let (gain_pct, noise_pct, verdict) = pair_verdict(&baselines, &candidates_tps);

    let best = pick_best(&points);
    let baseline_tps = points
        .iter()
        .find(|p| p.cpu_moe && p.cache_mib == 0 && p.cpu_share == 0.0)
        .and_then(|p| p.tps);
    let full_gpu = points.iter().find(|p| !p.cpu_moe);
    let full_gpu_tps = full_gpu.and_then(|p| p.tps);
    let full_gpu_error = full_gpu.and_then(|p| p.error.clone());
    let driver_version = crate::nvml_metrics::scan()
        .and_then(|s| s.first().and_then(|g| g.driver_version.clone()));
    let report = MoeTuneReport {
        best: best.map(|(c, _)| c),
        best_tps: best.map(|(_, t)| t),
        baseline_tps,
        full_gpu_tps,
        full_gpu_error,
        budget_mib: budget,
        points,
        seconds: started.elapsed().as_secs_f64(),
        measured_at: chrono::Utc::now().to_rfc3339(),
        model_path: model_path.clone(),
        model_size_bytes,
        ctx_size: ctx_size as u64,
        kv_quant: kv_quant.clone(),
        split_mode: split_mode.clone(),
        tensor_split: tensor_split.clone(),
        gpu_mask: gpu_mask.clone(),
        // The sidecar commit file sits next to the binary and needs no probe process.
        engine_build: crate::engine_build_info::read_sidecar_commit(&binary),
        driver_version,
        start_free_mib,
        pair_runs,
        gain_pct,
        noise_pct,
        verdict,
        cancelled: cancel_requested(),
    };
    if let Err(e) = save_report(&report, &store_key(&identity)) {
        log::warn!("[moe-tune] could not store the report: {e}");
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(cache_mib: u32, cpu_share: f64, tps: Option<f64>) -> MoeTunePoint {
        MoeTunePoint {
            cpu_moe: cache_mib > 0 || cpu_share > 0.0,
            cache_mib,
            cpu_share,
            tps,
            error: None,
            vram_used_mib: None,
            vram_free_mib: None,
            components: None,
        }
    }

    #[test]
    fn cache_steps_are_granular_and_derived_from_the_budget() {
        // 12 GiB of cache budget: 3, 6, 9 and 12 GiB, on the flag's 256 MiB step.
        let steps = cache_steps(12 * 1024);
        assert_eq!(steps, vec![3 * 1024, 6 * 1024, 9 * 1024, 12 * 1024]);
        assert!(steps.windows(2).all(|w| w[0] < w[1]));
        // Granularity is the point: a home optimum of 6.2 GiB falls inside this set.
        assert!(steps.contains(&(6 * 1024)));
        // No budget, no cache steps.
        assert!(cache_steps(0).is_empty());
    }

    #[test]
    fn budget_reserves_the_launch_and_a_safe_margin() {
        let components = Some(MoeTuneComponents {
            model_mib: 1820,
            kv_mib: 610,
            compute_mib: 420,
            host_mib: 26_800,
        });
        // 16384 free - 2850 launch - 512 reserve = 13022.
        assert_eq!(compute_budget(16_384, components), 13_022);
        // No ledger: reserve only, so the estimate stays conservative.
        assert_eq!(compute_budget(16_384, None), 16_384 - RESERVE_MIB);
    }

    #[test]
    fn pair_verdict_believes_a_gain_only_above_the_spread() {
        // Baseline drifts 2 %, candidate wins 30 % both times.
        let (gain, noise, verdict) = pair_verdict(&[60.0, 61.2], &[78.0, 79.5]);
        assert!(verdict.as_deref() == Some("improved"));
        assert!(gain.unwrap() > 29.0 && gain.unwrap() < 31.0);
        assert!(noise.unwrap() > 1.0 && noise.unwrap() < 3.0);

        // The same candidate against a baseline that swings 20 %: not conclusive.
        let (_, _, verdict) = pair_verdict(&[60.0, 72.0], &[78.0, 80.0]);
        assert!(verdict.as_deref() != Some("improved"));

        // No pairs: no verdict at all.
        assert_eq!(pair_verdict(&[], &[]), (None, None, None));
    }

    #[test]
    fn pick_best_prefers_measured_speed_then_the_cheaper_cache() {
        let points = vec![
            point(0, 0.0, Some(60.0)),
            point(8192, 0.0, Some(80.0)),
            point(24576, 0.0, Some(80.5)),
            point(24576, 0.95, Some(70.0)),
        ];
        let (best, tps) = pick_best(&points).expect("a winner");
        assert_eq!(best.cache_mib, 8192);
        assert!((tps - 80.0).abs() < 0.01);
        assert!(best.cpu_moe);
    }

    #[test]
    fn pick_best_keeps_the_gpu_when_a_cache_only_ties() {
        let gpu = MoeTunePoint {
            cpu_moe: false,
            cache_mib: 0,
            cpu_share: 0.0,
            tps: Some(80.0),
            error: None,
            vram_used_mib: None,
            vram_free_mib: None,
            components: None,
        };
        let cache = point(24576, 0.0, Some(81.0)); // +1.25 % - inside the band
        let (best, _) = pick_best(&[gpu.clone(), cache]).expect("a winner");
        assert!(!best.cpu_moe);
        assert_eq!(best.cache_mib, 0);

        let clear_win = point(24576, 0.0, Some(90.0));
        let (best2, _) = pick_best(&[gpu, clear_win]).expect("a winner");
        assert!(best2.cpu_moe);
        assert_eq!(best2.cache_mib, 24576);
    }

    #[test]
    fn pick_best_ignores_failed_runs() {
        let points = vec![
            point(0, 0.0, Some(60.0)),
            point(8192, 0.0, None),
            point(24576, 0.0, Some(90.0)),
        ];
        let (best, _) = pick_best(&points).expect("a winner");
        assert_eq!(best.cache_mib, 24576);
        assert!(pick_best(&[point(0, 0.0, None)]).is_none());
    }

    #[test]
    fn tune_args_carry_the_cache_and_the_placement() {
        let args = build_tune_args(
            "C:/models/x.gguf",
            262144,
            "q4_0",
            "layer",
            Some("0.480,0.520"),
            2048,
            1024,
            8899,
            &MoeTuneCandidate {
                cpu_moe: true,
                cache_mib: 24576,
                cpu_share: 0.95,
            },
        );
        let joined = args.join(" ");
        assert!(joined.contains("--moe-cache-mib 24576"));
        assert!(joined.contains("--moe-cache-cpu-share 0.95"));
        assert!(joined.contains("--split-mode layer"));
        assert!(joined.contains("-ts 0.480,0.520"));
        assert!(joined.contains("-cmoe"));
        assert!(joined.contains("--port 8899"));

        // Cache off means the flags are absent, not zero.
        let off = build_tune_args(
            "m",
            4096,
            "f16",
            "none",
            None,
            512,
            512,
            8899,
            &MoeTuneCandidate {
                cpu_moe: true,
                cache_mib: 0,
                cpu_share: 0.0,
            },
        )
        .join(" ");
        assert!(!off.contains("--moe-cache-mib"));
        assert!(!off.contains("--moe-cache-cpu-share"));
        assert!(!off.contains("--split-mode"));
        assert!(off.contains("-cmoe"));

        // The all-on-GPU launch must not carry -cmoe at all.
        let gpu = build_tune_args(
            "m",
            4096,
            "f16",
            "none",
            None,
            512,
            512,
            8899,
            &MoeTuneCandidate {
                cpu_moe: false,
                cache_mib: 0,
                cpu_share: 0.0,
            },
        )
        .join(" ");
        assert!(!gpu.contains("-cmoe"));
    }
}
