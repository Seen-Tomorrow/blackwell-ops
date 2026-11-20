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
use tauri::Emitter;

const HEALTH_POLL: Duration = Duration::from_millis(500);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(240);
const GEN_TIMEOUT: Duration = Duration::from_secs(300);
const N_PREDICT: u32 = 512;
/// Fixed, plain prose: the calibrated number must not depend on sampling.
const PROMPT: &str = "The lighthouse keeper had kept a logbook for thirty-one years, and in all that time he had never once written down a lie. So when the ship appeared on the horizon on the first calm morning of October, with no flag, no lights and no one on deck, he sat at his small wooden table for a long while before he picked up the pen. Below him the sea was flat and grey, and the gulls had gone quiet. He wrote the date, the hour and the direction of the wind, and then he stopped, because the next line would have to say what he had seen.";

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MoeTuneCandidate {
    pub cache_mib: u32,
    pub cpu_share: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MoeTunePoint {
    pub cache_mib: u32,
    pub cpu_share: f64,
    pub tps: Option<f64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MoeTuneReport {
    pub points: Vec<MoeTunePoint>,
    /// Best measured configuration - `None` when every run failed.
    pub best: Option<MoeTuneCandidate>,
    pub best_tps: Option<f64>,
    /// Cache-off baseline, when one of the candidates measured it.
    pub baseline_tps: Option<f64>,
    /// Usable VRAM the candidates were derived from, MiB (0 when the caller supplied its own).
    pub budget_mib: u64,
    pub seconds: f64,
}

/// Round to the 256 MiB step the cache flag is tuned in.
fn step_mib(mib: u64) -> u32 {
    ((mib / 256) * 256).max(0) as u32
}

/// The candidate set: cache off (baseline), a quarter and three quarters of the budget, and the
/// larger cache with CPU compute for the misses. Three runs answer both questions that matter -
/// "does the cache help" and "does computing misses on the CPU help".
pub fn candidates_for_budget(budget_mib: u64) -> Vec<MoeTuneCandidate> {
    let mut out = vec![MoeTuneCandidate {
        cache_mib: 0,
        cpu_share: 0.0,
    }];
    let budget = step_mib(budget_mib);
    if budget >= 2048 {
        let small = step_mib((budget / 4) as u64).max(1024);
        let large = step_mib((budget * 3 / 4) as u64);
        if small > 0 && small != large {
            out.push(MoeTuneCandidate {
                cache_mib: small,
                cpu_share: 0.0,
            });
        }
        if large > 0 {
            out.push(MoeTuneCandidate {
                cache_mib: large,
                cpu_share: 0.0,
            });
            out.push(MoeTuneCandidate {
                cache_mib: large,
                cpu_share: 0.95,
            });
        }
    }
    out
}

/// Highest measured t/s wins; a tie within 2 % keeps the smaller cache (and share 0), because a
/// bigger cache costs VRAM the user may want for context or a second engine.
pub fn pick_best(points: &[MoeTunePoint]) -> Option<(MoeTuneCandidate, f64)> {
    let mut best: Option<(MoeTuneCandidate, f64)> = None;
    for p in points {
        let Some(tps) = p.tps else { continue };
        if !tps.is_finite() || tps <= 0.0 {
            continue;
        }
        let cand = MoeTuneCandidate {
            cache_mib: p.cache_mib,
            cpu_share: p.cpu_share,
        };
        best = match best {
            None => Some((cand, tps)),
            Some((b_cand, b_tps)) => {
                let better = tps > b_tps * 1.02;
                let cheaper = (cand.cache_mib, cand.cpu_share.to_bits())
                    < (b_cand.cache_mib, b_cand.cpu_share.to_bits());
                if better || (!better && tps >= b_tps * 0.98 && cheaper) {
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
        // Every expert starts in host RAM; the cache is what this run measures.
        "-cmoe".into(),
    ];
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

/// One measured launch: spawn, wait for health, generate 512 tokens, read the timing, kill.
async fn run_one(
    binary: &PathBuf,
    profile: &str,
    gpu_mask: &str,
    args: &[String],
    port: u16,
    log_path: &std::path::Path,
) -> Result<f64, String> {
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

    let body = serde_json::json!({
        "prompt": PROMPT,
        "n_predict": N_PREDICT,
        "temperature": 0.0,
        "top_k": 1,
        "top_p": 1.0,
        "cache_prompt": false,
        "stream": false,
    });
    let gen_client = reqwest::Client::builder()
        .timeout(GEN_TIMEOUT)
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = gen_client
        .post(format!("{base}/completion"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("completion request failed: {e}\n{}", log_tail(log_path)))?;
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
        return Err(format!("implausible decode speed: {tps} t/s"));
    }
    let _ = std::io::stdout().flush();
    Ok(tps)
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

    let gpu_count = crate::telemetry::detect_gpu_count();
    let gpu_mask =
        crate::engine_utils::compute_gpu_mask_from_params(&device, &split_mode, gpu_count, false);

    // A calibration launch allocates real VRAM; refuse rather than fight an engine for the card.
    let occupied = crate::engine_utils::occupied_target_devices(&gpu_mask, 4096);
    if let Some((index, used_mib)) = occupied.first() {
        return Err(format!(
            "GPU-{index} already has {:.1} GiB in use - stop the engines on that card before tuning",
            *used_mib as f64 / 1024.0
        ));
    }

    let budget = cache_budget_mib(&gpu_mask);
    let candidates = candidates.unwrap_or_else(|| candidates_for_budget(budget));
    if candidates.is_empty() {
        return Err("no calibration candidates".to_string());
    }

    let log_dir = crate::config::cache_dir().join("moe-tune");
    let total = candidates.len();
    let mut points: Vec<MoeTunePoint> = Vec::with_capacity(total);
    for (index, cand) in candidates.iter().enumerate() {
        let port = pick_port()?;
        let args = build_tune_args(
            &model_path,
            ctx_size,
            &kv_quant,
            &split_mode,
            tensor_split.as_deref(),
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
        let _ = app.emit(
            "moe-tune-progress",
            serde_json::json!({
                "index": index,
                "total": total,
                "cache_mib": cand.cache_mib,
                "cpu_share": cand.cpu_share,
                "status": "running",
            }),
        );

        let measured = run_one(&binary, &profile, &gpu_mask, &args, port, &log_path).await;
        let (tps, error) = match measured {
            Ok(tps) => (Some(tps), None),
            Err(e) => (None, Some(e)),
        };
        if let Some(e) = &error {
            log::warn!(
                "[moe-tune] cache {} MiB share {:.2} failed: {e}",
                cand.cache_mib,
                cand.cpu_share
            );
        }
        points.push(MoeTunePoint {
            cache_mib: cand.cache_mib,
            cpu_share: cand.cpu_share,
            tps,
            error,
        });
        let _ = app.emit(
            "moe-tune-progress",
            serde_json::json!({
                "index": index,
                "total": total,
                "cache_mib": cand.cache_mib,
                "cpu_share": cand.cpu_share,
                "status": "done",
                "tps": tps,
            }),
        );
    }

    let best = pick_best(&points);
    let baseline_tps = points
        .iter()
        .find(|p| p.cache_mib == 0 && p.cpu_share == 0.0)
        .and_then(|p| p.tps);
    Ok(MoeTuneReport {
        best: best.map(|(c, _)| c),
        best_tps: best.map(|(_, t)| t),
        baseline_tps,
        budget_mib: budget,
        points,
        seconds: started.elapsed().as_secs_f64(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(cache_mib: u32, cpu_share: f64, tps: Option<f64>) -> MoeTunePoint {
        MoeTunePoint {
            cache_mib,
            cpu_share,
            tps,
            error: None,
        }
    }

    #[test]
    fn candidates_include_baseline_and_grow_with_the_budget() {
        let c = candidates_for_budget(32 * 1024);
        assert_eq!(c[0].cache_mib, 0);
        assert_eq!(c[0].cpu_share, 0.0);
        assert_eq!(c.len(), 4);
        assert!(c.iter().all(|x| x.cache_mib <= 32 * 1024));
        assert!(c[2].cache_mib > c[1].cache_mib);
        // No budget: only the baseline, so a tune still measures cache-off.
        assert_eq!(candidates_for_budget(0).len(), 1);
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
                cache_mib: 0,
                cpu_share: 0.0,
            },
        )
        .join(" ");
        assert!(!off.contains("--moe-cache-mib"));
        assert!(!off.contains("--moe-cache-cpu-share"));
        assert!(!off.contains("--split-mode"));
    }
}
