//! TG (generation) burst benchmark — single measured run after warmup for clean TPS measurement.
//!
//! Strategy: optional 1 warmup run (512-tok decode) + 1 measured run (user n_predict).
//! Prefill prompt is token-calibrated (shared with PP bench) — same text for warmup + measured.
//! Measured run can fan out N identical `/completion` requests in parallel (load / multi-slot stress).
//! Uses engine-reported timings (prompt_ms, predicted_ms).
//! Parallel measured runs: headline TG TPS = sum(gen_tokens) / decode wall window
//! (HTTP wall minus max per-feed prefill — prefills overlap, must not sum prompt_ms).
//! Per-slot engine decode rate is stored in `per_request_gen_tps` (~ITL / req ms).

use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::bench_cancel::{self, post_json, release_all_slots, BenchPortGuard};
use crate::bench_prompts::{self, TG_PREFILL_TARGET_TOKENS};
use serde::Serialize;

use tokio::task::JoinSet;

fn bench_session_log(line: &str) {
    // Console stays quiet: the full run trace still lands in the session log file,
    // and the archive save is the one line worth printing (bench_archive::info).
    log::debug!("{line}");
    crate::session_log::append_session_line(line);
}


#[derive(Debug, Clone)]
struct RunStats {
    prompt_tps: f64,
    gen_tps: f64,
    prompt_tokens: usize,
    gen_tokens: usize,
    prompt_ms: f64,
    predicted_ms: f64,
}

#[derive(Debug, Serialize)]
pub struct BenchResult {
    pub prompt_tokens: usize,
    pub gen_tokens: usize,
    /// Prefill throughput (tokens/sec) — per-request average on the measured run
    pub prompt_tps: f64,
    /// Generation throughput (tokens/sec) — engine `predicted_ms` when parallel=1; system aggregate when parallel>1
    pub gen_tps: f64,
    /// Inter-token latency (ms) — derived from `gen_tps`
    pub itl_ms: f64,
    pub success: bool,
    pub error: Option<String>,
    /// Concurrent `/completion` feeds on the measured run (1 = legacy single-request bench).
    pub parallel_requests: usize,
    /// Total generated tokens / wall seconds when `parallel_requests > 1`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aggregate_gen_tps: Option<f64>,
    /// Mean per-request engine `gen_tps` when `parallel_requests > 1`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub per_request_gen_tps: Option<f64>,
}

fn bench_stopped_result(parallel_requests: usize) -> BenchResult {
    BenchResult {
        prompt_tokens: 0,
        gen_tokens: 0,
        prompt_tps: 0.0,
        gen_tps: 0.0,
        itl_ms: 0.0,
        success: false,
        error: Some("Stopped".to_string()),
        parallel_requests,
        aggregate_gen_tps: None,
        per_request_gen_tps: None,
    }
}

fn stats_from_completion(parsed: &serde_json::Value) -> RunStats {
    let p_tokens = parsed["tokens_evaluated"].as_u64().unwrap_or(0) as usize;
    let g_tokens = parsed["tokens_predicted"].as_u64().unwrap_or(0) as usize;
    let p_ms = parsed["timings"]["prompt_ms"].as_f64().unwrap_or(0.0);
    let g_ms = parsed["timings"]["predicted_ms"].as_f64().unwrap_or(0.0);
    let prompt_tps = if p_ms > 0.0 {
        (p_tokens as f64 / p_ms) * 1000.0
    } else {
        0.0
    };
    let gen_tps = if g_ms > 0.0 {
        (g_tokens as f64 / g_ms) * 1000.0
    } else {
        0.0
    };
    RunStats {
        prompt_tps,
        gen_tps,
        prompt_tokens: p_tokens,
        gen_tokens: g_tokens,
        prompt_ms: p_ms,
        predicted_ms: g_ms,
    }
}

fn bench_body(prompt: &str, n_predict: usize, parallel_index: Option<usize>) -> serde_json::Value {
    let (prompt, id_slot) = if let Some(i) = parallel_index {
        // Tiny per-feed marker — avoids prompt-cache collapse; negligible token cost.
        // Pin each feed to its own llama slot so the server does not defer tasks on a single slot.
        (
            format!("{prompt}\n[bench-feed:{i}]"),
            Some(i as i64),
        )
    } else {
        (prompt.to_string(), None)
    };
    let mut body = serde_json::json!({
        "prompt": prompt,
        "n_predict": n_predict,
        "temperature": 0.0,
        "stream": true,
        "return_progress": true,
        "sse_ping_interval": 1,
        "cache_prompt": false,
        "ignore_eos": true,
    });
    if let Some(slot) = id_slot {
        body["id_slot"] = serde_json::json!(slot);
    }
    body
}

async fn engine_slot_count(client: &reqwest::Client, port: u16) -> usize {
    if let Ok(resp) = client
        .get(format!("http://127.0.0.1:{port}/slots"))
        .send()
        .await
    {
        if let Ok(slots) = resp.json::<Vec<serde_json::Value>>().await {
            return slots.len().max(1);
        }
    }
    1
}

#[derive(Debug, Clone, Copy)]
struct WaveWindowSample {
    wave_tokens: u64,
    wave_ms: f64,
    ramp_ms: f64,
}

/// Tracks steady-state parallel decode: opens when every concurrent feed has produced
/// its first token and closes when the first feed finishes, excluding staggered prefill
/// ramps and end-of-wave drain tails.
struct ParallelWaveTracker {
    expected: usize,
    launch_start: Instant,
    per_feed_decoded: Vec<u64>,
    started_count: usize,
    any_finished: bool,
    wave_start: Option<Instant>,
    start_tokens: Vec<u64>,
    wave_end: Option<Instant>,
    end_tokens: Vec<u64>,
}

impl ParallelWaveTracker {
    fn new(expected: usize, launch_start: Instant) -> Self {
        Self {
            expected,
            launch_start,
            per_feed_decoded: vec![0; expected],
            started_count: 0,
            any_finished: false,
            wave_start: None,
            start_tokens: Vec::new(),
            wave_end: None,
            end_tokens: Vec::new(),
        }
    }

    fn record(&mut self, feed_idx: usize, decoded: u64, is_stop: bool, now: Instant) {
        if feed_idx >= self.expected {
            return;
        }
        let prev = self.per_feed_decoded[feed_idx];
        if decoded > prev {
            self.per_feed_decoded[feed_idx] = decoded;
            if prev == 0 {
                self.started_count += 1;
            }
        }
        if self.wave_start.is_none() && !self.any_finished && self.started_count == self.expected {
            self.wave_start = Some(now);
            self.start_tokens = self.per_feed_decoded.clone();
        }
        if is_stop {
            self.any_finished = true;
            if self.wave_start.is_some() && self.wave_end.is_none() {
                self.wave_end = Some(now);
                self.end_tokens = self.per_feed_decoded.clone();
            }
        }
    }

    fn sample(&self) -> Option<WaveWindowSample> {
        let (start, end) = (self.wave_start?, self.wave_end?);
        let wave_ms = end.saturating_duration_since(start).as_secs_f64() * 1000.0;
        let wave_tokens: u64 = self
            .end_tokens
            .iter()
            .zip(&self.start_tokens)
            .map(|(e, s)| e.saturating_sub(*s))
            .sum();
        let ramp_ms = start.saturating_duration_since(self.launch_start).as_secs_f64() * 1000.0;
        if wave_ms >= 500.0 && wave_tokens >= self.expected as u64 {
            Some(WaveWindowSample {
                wave_tokens,
                wave_ms,
                ramp_ms,
            })
        } else {
            None
        }
    }
}

async fn run_one_completion(
    client: &reqwest::Client,
    url: &str,
    body: &serde_json::Value,
    port: u16,
) -> Result<RunStats, String> {
    let parsed = post_json(client, url, body, port).await?;
    Ok(stats_from_completion(&parsed))
}

async fn run_measured_completions(
    client: &reqwest::Client,
    url: &str,
    prompt: &str,
    n_predict: usize,
    parallel_requests: usize,
    port: u16,
) -> Result<(Vec<RunStats>, f64, Option<WaveWindowSample>), String> {
    let n = parallel_requests.max(1);
    if n == 1 {
        let body = bench_body(prompt, n_predict, None);
        let stats = run_one_completion(client, url, &body, port).await?;
        return Ok((vec![stats], 0.0, None));
    }

    bench_session_log(&format!("[BENCH_TG] launching parallel×{n} completion feeds"));
    let wall_start = Instant::now();
    let tracker = Arc::new(Mutex::new(ParallelWaveTracker::new(n, wall_start)));
    let mut set = JoinSet::new();

    for i in 0..n {
        let client = client.clone();
        let url = url.to_string();
        let prompt = prompt.to_string();
        let tracker = tracker.clone();
        set.spawn(async move {
            let req_start = Instant::now();
            let body = bench_body(&prompt, n_predict, Some(i));
            let cb: bench_cancel::TokenProgressCb = Box::new(move |decoded, is_stop| {
                if let Ok(mut t) = tracker.lock() {
                    t.record(i, decoded, is_stop, Instant::now());
                }
            });
            let result = bench_cancel::post_json_with_progress(&client, &url, &body, port, cb)
                .await
                .map(|parsed| stats_from_completion(&parsed));
            (i, req_start, result)
        });
    }

    let mut runs = Vec::with_capacity(n);
    while let Some(joined) = set.join_next().await {
        let (i, req_start, result) = joined.map_err(|e| format!("Parallel task failed: {e}"))?;
        let elapsed_ms = req_start.elapsed().as_secs_f64() * 1000.0;
        match result {
            Ok(stats) => {
                bench_session_log(&format!(
                    "[BENCH_TG] parallel feed {} done in {:.0} ms | g_tok={} gen={:.1} t/s p_ms={:.0} pred_ms={:.0}",
                    i,
                    elapsed_ms,
                    stats.gen_tokens,
                    stats.gen_tps,
                    stats.prompt_ms,
                    stats.predicted_ms,
                ));
                runs.push(stats);
            }
            Err(e) if bench_cancel::is_stopped_err(&e) => {
                // Abort siblings so STOP does not wait for the whole fan-out.
                set.abort_all();
                while set.join_next().await.is_some() {}
                return Err(e);
            }
            Err(e) => {
                set.abort_all();
                while set.join_next().await.is_some() {}
                return Err(e);
            }
        }
    }

    let wall_ms = wall_start.elapsed().as_secs_f64() * 1000.0;
    let wave_sample = tracker.lock().ok().and_then(|t| t.sample());
    bench_session_log(&format!(
        "[BENCH_TG] parallel×{n} wall {:.0} ms (sum of per-feed wall times would be {:.0} ms if serial)",
        wall_ms,
        runs.len() as f64 * (wall_ms / runs.len().max(1) as f64)
    ));
    Ok((runs, wall_ms, wave_sample))
}

/// Concurrent multi-slot headline TG.
///
/// llama `print_timing` eval line is per-slot (e.g. 57.9 t/s). Fully overlapped ×N
/// capacity is `sum(per-slot gen_tps)` ≈ `sum(tokens) / max(predicted_ms)`.
/// HTTP wall often includes prefill + response drain (~total_time) and under-reports
/// (e.g. 379 vs 465). Never use HTTP wall when engine timings exist.
fn aggregate_parallel_runs(
    runs: &[RunStats],
    wall_ms: f64,
    parallel_requests: usize,
    wave_window: Option<WaveWindowSample>,
) -> RunStats {
    if runs.is_empty() {
        return RunStats {
            prompt_tps: 0.0,
            gen_tps: 0.0,
            prompt_tokens: 0,
            gen_tokens: 0,
            prompt_ms: 0.0,
            predicted_ms: 0.0,
        };
    }

    let n = runs.len() as f64;
    let total_gen: usize = runs.iter().map(|r| r.gen_tokens).sum();
    let total_prompt: usize = runs.iter().map(|r| r.prompt_tokens).sum();
    let max_prompt_ms = runs.iter().map(|r| r.prompt_ms).fold(0.0f64, f64::max);
    let max_predicted_ms = runs.iter().map(|r| r.predicted_ms).fold(0.0f64, f64::max);
    let avg_prompt_tps = runs.iter().map(|r| r.prompt_tps).sum::<f64>() / n;
    let avg_gen_tps = runs.iter().map(|r| r.gen_tps).sum::<f64>() / n;
    let sum_engine_gen_tps: f64 = runs.iter().map(|r| r.gen_tps).filter(|t| *t > 0.0).sum();
    let engine_window_tps = if max_predicted_ms > 1.0 && total_gen > 0 {
        (total_gen as f64 / max_predicted_ms) * 1000.0
    } else {
        0.0
    };
    let wall_decode_ms = (wall_ms - max_prompt_ms).max(0.0);
    let wall_decode_tps = if wall_decode_ms > 1.0 && total_gen > 0 {
        (total_gen as f64 / wall_decode_ms) * 1000.0
    } else {
        0.0
    };
    let wall_raw_tps = if wall_ms > 0.0 && total_gen > 0 {
        (total_gen as f64 / wall_ms) * 1000.0
    } else {
        0.0
    };

    let steady_wave_tps = wave_window.and_then(|w| {
        if w.wave_ms >= 500.0 && w.wave_tokens >= parallel_requests as u64 {
            Some(((w.wave_tokens as f64 / w.wave_ms) * 1000.0, w))
        } else {
            None
        }
    });

    // Prefer steady_wave (all feeds decoding simultaneously, excludes staggered PP ramp).
    // Else sum(engine gen_tps), then tokens/max(predicted_ms), then HTTP wall.
    let (system_gen_tps, decode_window_ms, src) = if let Some((tps, w)) = steady_wave_tps {
        (tps, w.wave_ms, "steady_wave")
    } else if sum_engine_gen_tps > 0.0 {
        let win = if max_predicted_ms > 1.0 {
            max_predicted_ms
        } else {
            wall_decode_ms.max(1.0)
        };
        (sum_engine_gen_tps, win, "sum_engine")
    } else if engine_window_tps > 0.0 {
        (engine_window_tps, max_predicted_ms, "max_predicted")
    } else if wall_decode_tps > 0.0 {
        (wall_decode_tps, wall_decode_ms, "http_wall_decode")
    } else {
        (0.0, wall_ms.max(1.0), "none")
    };

    let wave_log = match steady_wave_tps {
        Some((tps, w)) => format!(
            "wave {:.1} (tok={} ms={:.0} ramp={:.0})",
            tps, w.wave_tokens, w.wave_ms, w.ramp_ms
        ),
        None => "wave -".to_string(),
    };

    bench_session_log(&format!(
        "[BENCH_TG] parallel×{} | headline {:.1} TPS src={src} | {wave_log} | sum_engine {:.1} | max_pred_win {:.1} (ms={:.0}) | wall_dec {:.1} | wall_raw {:.1} | per-req avg {:.1} | max_p_ms={:.0} wall_ms={:.0} | g_tok={}",
        parallel_requests,
        system_gen_tps,
        sum_engine_gen_tps,
        engine_window_tps,
        max_predicted_ms,
        wall_decode_tps,
        wall_raw_tps,
        avg_gen_tps,
        max_prompt_ms,
        wall_ms,
        total_gen
    ));

    RunStats {
        prompt_tps: avg_prompt_tps,
        gen_tps: system_gen_tps,
        prompt_tokens: total_prompt,
        gen_tokens: total_gen,
        prompt_ms: max_prompt_ms,
        predicted_ms: decode_window_ms,
    }
}


#[tauri::command(rename_all = "camelCase")]
pub async fn cmd_burst_bench(
    app_handle: tauri::AppHandle,
    port: u16,
    n_predict: usize,
    bench_prompt_mode: String,
    tg_warmup_enabled: bool,
    parallel_requests: Option<usize>,
) -> Result<BenchResult, String> {
    bench_cancel::begin(port);
    let _guard = BenchPortGuard(port);
    let url = format!("http://127.0.0.1:{port}/completion");
    let requested_parallel = parallel_requests.unwrap_or(1).clamp(1, 128);
    let client = bench_cancel::bench_http_client(requested_parallel)?;
    let engine_slots = engine_slot_count(&client, port).await;
    let parallel_requests = requested_parallel.min(engine_slots);
    if parallel_requests < requested_parallel {
        log::warn!(
            "[BENCH_TG] parallel×{} requested but engine has {} slot(s) — capping to {}",
            requested_parallel,
            engine_slots,
            parallel_requests
        );
    }

    bench_session_log(&format!(
        "[BENCH_TG] start | n_predict={} parallel={} engine_slots={} mode={} prefill_target={}",
        n_predict,
        parallel_requests,
        engine_slots,
        bench_prompt_mode,
        TG_PREFILL_TARGET_TOKENS
    ));

    let warmup_runs = if tg_warmup_enabled { 1 } else { 0 };
    let total_runs = warmup_runs + 1;

    release_all_slots(&client, port, "before benchmark").await;

    // One calibrated prefill for warmup + measured — decode length alone varies via n_predict.
    let bench_prompt_text = match bench_prompts::build_prompt_for_token_target(
        &client,
        port,
        TG_PREFILL_TARGET_TOKENS,
        &bench_prompt_mode,
        "[BENCH_TG]",
    )
    .await
    {
        Ok(text) => text,
        Err(e) if e == "Stopped" => return Ok(bench_stopped_result(parallel_requests)),
        Err(e) => return Err(e),
    };

    let mut measured_run: Option<RunStats> = None;
    let mut measured_parallel = 1usize;
    let mut measured_per_request_gen_tps: Option<f64> = None;
    let mut measured_aggregate_gen_tps: Option<f64> = None;

    for run in 0..total_runs {
        if bench_cancel::stop_after_current_requested(port) {
            return Ok(bench_stopped_result(parallel_requests));
        }

        let is_warmup = run < warmup_runs;
        let phase = if is_warmup { "warmup" } else { "measured" };
        let effective_length = if is_warmup {
            TG_PREFILL_TARGET_TOKENS
        } else {
            n_predict
        };
        let run_parallel = if is_warmup { 1 } else { parallel_requests };

        crate::ipc_emit::emit_guarded(
            &app_handle,
            "bench-tg-progress",
            serde_json::json!({
                "port": port,
                "phase": phase,
                "run": run + 1,
                "total": total_runs,
                "effectiveLength": effective_length,
                "warmupSkipped": warmup_runs == 0,
                "parallelRequests": run_parallel,
            }),
        );

        match run_measured_completions(
            &client,
            &url,
            &bench_prompt_text,
            effective_length,
            run_parallel,
            port,
        )
        .await
        {
            Ok((runs, wall_ms, wave_sample)) => {
                let summary = if run_parallel > 1 {
                    let agg = aggregate_parallel_runs(&runs, wall_ms, run_parallel, wave_sample);
                    if !runs.is_empty() {
                        measured_per_request_gen_tps = Some(agg.gen_tps / runs.len() as f64);
                    }
                    measured_aggregate_gen_tps = Some(agg.gen_tps);
                    agg
                } else {
                    runs.into_iter().next().unwrap_or(RunStats {
                        prompt_tps: 0.0,
                        gen_tps: 0.0,
                        prompt_tokens: 0,
                        gen_tokens: 0,
                        prompt_ms: 0.0,
                        predicted_ms: 0.0,
                    })
                };

                bench_session_log(&format!(
                    "[BENCH_TG] run {} | mode={} | parallel={} | prefill: {:.1} TPS | gen: {:.1} TPS | p_tok={} g_tok={} p_ms={:.0} pred_ms={:.0}",
                    run + 1,
                    bench_prompt_mode,
                    run_parallel,
                    summary.prompt_tps,
                    summary.gen_tps,
                    summary.prompt_tokens,
                    summary.gen_tokens,
                    summary.prompt_ms,
                    summary.predicted_ms,
                ));

                if !is_warmup {
                    measured_parallel = run_parallel;
                    measured_run = Some(summary);
                }
            }
            Err(e) if bench_cancel::is_stopped_err(&e) => {
                return Ok(bench_stopped_result(parallel_requests));
            }
            Err(e) => return Err(e),
        }

        if bench_cancel::stop_after_current_requested(port) {
            return Ok(bench_stopped_result(parallel_requests));
        }

        if is_warmup {
            release_all_slots(&client, port, "after warmup for cold measured run").await;
        }
    }

    let run = match measured_run {
        Some(r) => r,
        None => {
            return Ok(BenchResult {
                prompt_tokens: 0,
                gen_tokens: 0,
                prompt_tps: 0.0,
                gen_tps: 0.0,
                itl_ms: 0.0,
                success: false,
                error: Some("No successful measured runs".to_string()),
                parallel_requests: 1,
                aggregate_gen_tps: None,
                per_request_gen_tps: None,
            });
        }
    };

    let itl_ms = if run.gen_tps > 0.0 {
        1000.0 / run.gen_tps
    } else {
        0.0
    };

    bench_session_log(&format!(
        "[BENCH_TG] RESULT | mode={} | parallel={} | prefill: {:.1} TPS | gen: {:.1} TPS | ITL: {:.2}ms | g_tok={} per_req_avg={:?} aggregate={:?}",
        bench_prompt_mode,
        measured_parallel,
        run.prompt_tps,
        run.gen_tps,
        itl_ms,
        run.gen_tokens,
        measured_per_request_gen_tps,
        measured_aggregate_gen_tps,
    ));

    // Persist the measurement. Fire-and-forget: the archive must never delay or fail a
    // bench, and `/props` + telemetry enrichment happens inside the capture task.
    {
        let metrics = serde_json::json!({
            "success": true,
            "prompt_tokens": run.prompt_tokens,
            "gen_tokens": run.gen_tokens,
            "prompt_tps": run.prompt_tps,
            "gen_tps": run.gen_tps,
            "itl_ms": itl_ms,
            "parallel_requests": measured_parallel,
            "aggregate_gen_tps": measured_aggregate_gen_tps,
            "per_request_gen_tps": measured_per_request_gen_tps,
        });
        let params = serde_json::json!({
            "prompt_mode": bench_prompt_mode.clone(),
            "n_predict": n_predict,
            "tg_warmup_enabled": tg_warmup_enabled,
            "parallel_requests": requested_parallel,
            "measured_parallel": measured_parallel,
            "engine_slots": engine_slots,
        });
        let bench_port = port;
        tokio::spawn(async move {
            if let Err(e) =
                crate::bench_archive::capture("tg_burst", bench_port, params, metrics).await
            {
                log::warn!("[bench-archive] tg capture failed: {e}");
            }
        });
    }

    Ok(BenchResult {
        prompt_tokens: run.prompt_tokens,
        gen_tokens: run.gen_tokens,
        prompt_tps: run.prompt_tps,
        gen_tps: run.gen_tps,
        itl_ms,
        success: true,
        error: None,
        parallel_requests: measured_parallel,
        aggregate_gen_tps: measured_aggregate_gen_tps,
        per_request_gen_tps: measured_per_request_gen_tps,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(gen_tokens: usize, predicted_ms: f64, prompt_ms: f64) -> RunStats {
        let gen_tps = if predicted_ms > 0.0 {
            (gen_tokens as f64 / predicted_ms) * 1000.0
        } else {
            0.0
        };
        let prompt_tokens = 550usize;
        let prompt_tps = if prompt_ms > 0.0 {
            (prompt_tokens as f64 / prompt_ms) * 1000.0
        } else {
            0.0
        };
        RunStats {
            prompt_tps,
            gen_tps,
            prompt_tokens,
            gen_tokens,
            prompt_ms,
            predicted_ms,
        }
    }

    /// User repro: ×8 @ ~57.87 t/s/slot. Fat HTTP wall (~total_time) must not win.
    #[test]
    fn parallel_aggregate_uses_engine_sum_not_fat_wall() {
        let runs: Vec<RunStats> = (0..8)
            .map(|i| {
                let prompt_ms = 2173.0 - i as f64 * 3.5;
                let predicted_ms = 8831.0 - i as f64 * 0.15;
                slot(512, predicted_ms, prompt_ms)
            })
            .collect();
        // ~11s total-time-like wall (PP+TG) — old path reported ~379.
        let wall_ms = 11_050.0;
        let agg = aggregate_parallel_runs(&runs, wall_ms, 8, None);
        let expected_sum: f64 = runs.iter().map(|r| r.gen_tps).sum();
        assert!(
            (agg.gen_tps - expected_sum).abs() < 0.5,
            "headline {} != sum_engine {}",
            agg.gen_tps,
            expected_sum
        );
        assert!(
            agg.gen_tps > 450.0 && agg.gen_tps < 480.0,
            "expected ~463, got {}",
            agg.gen_tps
        );
        // Fat wall would be ~370-390 — must not regress.
        assert!(agg.gen_tps > 400.0, "regressed to wall-ish {}", agg.gen_tps);
    }

    #[test]
    fn parallel_aggregate_falls_back_to_max_predicted_without_rates() {
        let runs = vec![
            RunStats {
                prompt_tps: 0.0,
                gen_tps: 0.0,
                prompt_tokens: 550,
                gen_tokens: 512,
                prompt_ms: 2000.0,
                predicted_ms: 8000.0,
            },
            RunStats {
                prompt_tps: 0.0,
                gen_tps: 0.0,
                prompt_tokens: 550,
                gen_tokens: 512,
                prompt_ms: 2100.0,
                predicted_ms: 8100.0,
            },
        ];
        let agg = aggregate_parallel_runs(&runs, 12_000.0, 2, None);
        // 1024 / 8100 * 1000 ≈ 126.4
        assert!((agg.gen_tps - 126.4).abs() < 1.0, "got {}", agg.gen_tps);
    }

    #[test]
    fn wave_tracker_excludes_prefill_ramp_and_drain_tail() {
        use std::time::Duration;
        let launch = Instant::now();
        let mut tracker = ParallelWaveTracker::new(32, launch);
        // Slots 0..30 start decoding during staggered 5.3s prefill ramp, emitting 10 tokens each.
        for i in 0..31 {
            tracker.record(i, 10, false, launch + Duration::from_millis(600 + (i as u64) * 150));
        }
        assert!(tracker.sample().is_none(), "wave must not open before slot 31 decodes");
        // Slot 31 emits its first token at t=5800ms -> wave opens.
        let t_open = launch + Duration::from_millis(5800);
        tracker.record(31, 1, false, t_open);
        // Steady-state decode for 10.0s at 26.7 tok/s/slot = 267 tokens per slot -> 8544 tokens total.
        let t_close = t_open + Duration::from_millis(10_000);
        for i in 0..31 {
            tracker.record(i, 277, false, t_close - Duration::from_millis(10));
        }
        tracker.record(31, 268, true, t_close);

        let sample = tracker.sample().expect("steady wave sample");
        assert_eq!(sample.wave_tokens, 31 * 267 + 267);
        assert!((sample.wave_ms - 10_000.0).abs() < 1.0);
        assert!((sample.ramp_ms - 5800.0).abs() < 1.0);
        let tps = (sample.wave_tokens as f64 / sample.wave_ms) * 1000.0;
        assert!((tps - 854.4).abs() < 1.0, "expected ~854.4, got {tps}");
    }

    #[test]
    fn wave_tracker_returns_none_when_feed_finishes_before_wave_opens() {
        use std::time::Duration;
        let launch = Instant::now();
        let mut tracker = ParallelWaveTracker::new(4, launch);
        tracker.record(0, 16, true, launch + Duration::from_millis(100));
        tracker.record(1, 16, false, launch + Duration::from_millis(200));
        tracker.record(2, 16, false, launch + Duration::from_millis(300));
        tracker.record(3, 16, false, launch + Duration::from_millis(400));
        assert!(tracker.sample().is_none());
    }

    #[test]
    fn parallel_aggregate_prefers_steady_wave_over_ramp_contaminated_sum_engine() {
        // Simulate x32 where sum_engine is dragged down to 640 by prefill ramp, while steady_wave is 854.
        let runs: Vec<RunStats> = (0..32).map(|_| slot(512, 25_600.0, 2_000.0)).collect();
        let wave = Some(WaveWindowSample {
            wave_tokens: 8544,
            wave_ms: 10_000.0,
            ramp_ms: 5_800.0,
        });
        let agg = aggregate_parallel_runs(&runs, 28_000.0, 32, wave);
        assert!((agg.gen_tps - 854.4).abs() < 0.5, "got {}", agg.gen_tps);
        assert!((agg.predicted_ms - 10_000.0).abs() < 1.0);
    }
}
