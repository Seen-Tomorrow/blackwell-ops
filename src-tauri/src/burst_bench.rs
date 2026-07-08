//! TG (generation) burst benchmark — single measured run after warmup for clean TPS measurement.
//!
//! Strategy: optional 1 warmup run (512-tok decode) + 1 measured run (user n_predict).
//! Prefill prompt is token-calibrated (shared with PP bench) — same text for warmup + measured.
//! Measured run can fan out N identical `/completion` requests in parallel (load / multi-slot stress).
//! Uses engine-reported timings (prompt_ms, predicted_ms).
//! Parallel measured runs: headline TG TPS = sum(gen_tokens) / decode wall window
//! (HTTP wall minus max per-feed prefill — prefills overlap, must not sum prompt_ms).
//! Per-slot engine decode rate is stored in `per_request_gen_tps` (~ITL / req ms).

use std::time::Instant;

use crate::bench_cancel::{self, post_json};
use crate::bench_prompts::{self, TG_PREFILL_TARGET_TOKENS};
use serde::Serialize;

use tokio::task::JoinSet;

struct BenchPortGuard(u16);

impl Drop for BenchPortGuard {
    fn drop(&mut self) {
        bench_cancel::end(self.0);
    }
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
    #[serde(default = "default_parallel_one")]
    pub parallel_requests: usize,
    /// Total generated tokens / wall seconds when `parallel_requests > 1`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aggregate_gen_tps: Option<f64>,
    /// Mean per-request engine `gen_tps` when `parallel_requests > 1`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub per_request_gen_tps: Option<f64>,
}

#[allow(dead_code)]
fn default_parallel_one() -> usize {
    1
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
        "stream": false,
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

async fn run_one_completion(
    client: &reqwest::Client,
    url: &str,
    body: &serde_json::Value,
) -> Result<RunStats, String> {
    let parsed = post_json(client, url, body).await?;
    Ok(stats_from_completion(&parsed))
}

async fn run_measured_completions(
    client: &reqwest::Client,
    url: &str,
    prompt: &str,
    n_predict: usize,
    parallel_requests: usize,
) -> Result<(Vec<RunStats>, f64), String> {
    let n = parallel_requests.max(1);
    if n == 1 {
        let body = bench_body(prompt, n_predict, None);
        let stats = run_one_completion(client, url, &body).await?;
        return Ok((vec![stats], 0.0));
    }

    log::info!("[BENCH_TG] launching parallel×{n} completion feeds");
    let wall_start = Instant::now();
    let mut set = JoinSet::new();

    for i in 0..n {
        let client = client.clone();
        let url = url.to_string();
        let prompt = prompt.to_string();
        set.spawn(async move {
            let req_start = Instant::now();
            let body = bench_body(&prompt, n_predict, Some(i));
            let result = run_one_completion(&client, &url, &body).await;
            (i, req_start, result)
        });
    }

    let mut runs = Vec::with_capacity(n);
    while let Some(joined) = set.join_next().await {
        let (i, req_start, result) = joined.map_err(|e| format!("Parallel task failed: {}", e))?;
        let elapsed_ms = req_start.elapsed().as_secs_f64() * 1000.0;
        match result {
            Ok(stats) => {
                log::info!(
                    "[BENCH_TG] parallel feed {} done in {:.0} ms | g_tok={} gen={:.1} t/s",
                    i,
                    elapsed_ms,
                    stats.gen_tokens,
                    stats.gen_tps
                );
                runs.push(stats);
            }
            Err(e) => return Err(e),
        }
    }

    let wall_ms = wall_start.elapsed().as_secs_f64() * 1000.0;
    log::info!(
        "[BENCH_TG] parallel×{n} wall {:.0} ms (sum of per-feed wall times would be {:.0} ms if serial)",
        wall_ms,
        runs.len() as f64 * (wall_ms / runs.len().max(1) as f64)
    );
    Ok((runs, wall_ms))
}

/// Decode-only wall window for parallel feeds — subtract overlapping prefill, not summed prefill.
fn parallel_decode_window_ms(runs: &[RunStats], wall_ms: f64) -> f64 {
    let max_prompt_ms = runs.iter().map(|r| r.prompt_ms).fold(0.0f64, f64::max);
    let max_predicted_ms = runs.iter().map(|r| r.predicted_ms).fold(0.0f64, f64::max);
    let decode_ms = wall_ms - max_prompt_ms;
    if decode_ms > 1.0 {
        decode_ms
    } else {
        max_predicted_ms.max(1.0)
    }
}

fn aggregate_parallel_runs(
    runs: &[RunStats],
    wall_ms: f64,
    parallel_requests: usize,
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
    let total_predicted_ms: f64 = runs.iter().map(|r| r.predicted_ms).sum();
    let avg_prompt_tps = runs.iter().map(|r| r.prompt_tps).sum::<f64>() / n;
    let avg_gen_tps = runs.iter().map(|r| r.gen_tps).sum::<f64>() / n;
    let decode_window_ms = parallel_decode_window_ms(runs, wall_ms);
    let system_gen_tps = (total_gen as f64 / decode_window_ms) * 1000.0;
    let wall_raw_tps = if wall_ms > 0.0 {
        (total_gen as f64 / wall_ms) * 1000.0
    } else {
        system_gen_tps
    };
    let summed_pred_tps = if total_predicted_ms > 0.0 {
        (total_gen as f64 / total_predicted_ms) * 1000.0
    } else {
        avg_gen_tps
    };

    log::info!(
        "[BENCH_TG] parallel×{} | system {:.1} TPS (decode window {:.0} ms) | per-req avg {:.1} TPS | wall raw {:.1} TPS | summed-pred {:.1} TPS | max_p_ms={:.0} wall_ms={:.0} | g_tok={}",
        parallel_requests,
        system_gen_tps,
        decode_window_ms,
        avg_gen_tps,
        wall_raw_tps,
        summed_pred_tps,
        max_prompt_ms,
        wall_ms,
        total_gen
    );

    RunStats {
        prompt_tps: avg_prompt_tps,
        gen_tps: system_gen_tps,
        prompt_tokens: total_prompt,
        gen_tokens: total_gen,
        prompt_ms: max_prompt_ms,
        predicted_ms: decode_window_ms,
    }
}

async fn release_all_slots(client: &reqwest::Client, port: u16, label: &str) {
    if let Ok(slots_resp) = client
        .get(format!("http://127.0.0.1:{port}/slots"))
        .send()
        .await
    {
        if let Ok(slots) = slots_resp.json::<Vec<serde_json::Value>>().await {
            for slot in &slots {
                let idx = slot["id"].as_u64().unwrap_or(0);
                let _ = client
                    .post(format!("http://127.0.0.1:{port}/slots/{idx}/release"))
                    .send()
                    .await;
            }
            log::debug!("[BENCH_TG] released {} slots {}", slots.len(), label);
        }
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

    let repetitive = bench_prompts::is_repetitive_mode(&bench_prompt_mode);

    log::info!(
        "[BENCH_TG] start | n_predict={} parallel={} engine_slots={} mode={} prefill_target={}",
        n_predict,
        parallel_requests,
        engine_slots,
        bench_prompt_mode,
        TG_PREFILL_TARGET_TOKENS
    );

    let warmup_runs = if tg_warmup_enabled { 1 } else { 0 };
    let total_runs = warmup_runs + 1;

    release_all_slots(&client, port, "before benchmark").await;

    // One calibrated prefill for warmup + measured — decode length alone varies via n_predict.
    let bench_prompt_text = match bench_prompts::build_prompt_for_token_target(
        &client,
        port,
        TG_PREFILL_TARGET_TOKENS,
        repetitive,
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

        crate::fusion::reset_bench_meters_for_port(port).await;
        crate::ipc_meter::emit_tracked(
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
        )
        .await
        {
            Ok((runs, wall_ms)) => {
                let summary = if run_parallel > 1 {
                    let avg_gen = runs.iter().map(|r| r.gen_tps).sum::<f64>() / runs.len() as f64;
                    measured_per_request_gen_tps = Some(avg_gen);
                    let agg = aggregate_parallel_runs(&runs, wall_ms, run_parallel);
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

                log::info!(
                    "[BENCH_TG] run {} | mode={} | parallel={} | prefill: {:.1} TPS | gen: {:.1} TPS | p_tok={} g_tok={}",
                    run + 1,
                    bench_prompt_mode,
                    run_parallel,
                    summary.prompt_tps,
                    summary.gen_tps,
                    summary.prompt_tokens,
                    summary.gen_tokens
                );

                crate::fusion::freeze_request_meters_for_port(port).await;

                if !is_warmup {
                    measured_parallel = run_parallel;
                    measured_run = Some(summary);
                }
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

    log::info!(
        "[BENCH_TG] RESULT | mode={} | parallel={} | prefill: {:.1} TPS | gen: {:.1} TPS | ITL: {:.2}ms",
        bench_prompt_mode,
        measured_parallel,
        run.prompt_tps,
        run.gen_tps,
        itl_ms
    );

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