//! TG (generation) burst benchmark — single measured run after warmup for clean TPS measurement.
//!
//! Strategy: 1 warmup run (fixed length=512) + 1 measured run (user-selected n_predict) → single result values.
//! Measured run can fan out N identical `/completion` requests in parallel (load / multi-slot stress).
//! Uses engine-reported timings (prompt_ms, predicted_ms) not HTTP round-trip time.

use std::time::Instant;

use crate::bench_cancel::{self, post_json};
use serde::Serialize;
use tauri::Emitter;
use tokio::task::JoinSet;

struct BenchPortGuard(u16);

impl Drop for BenchPortGuard {
    fn drop(&mut self) {
        bench_cancel::end(self.0);
    }
}

/// ~500 token prompt to properly warm Blackwell kernels for realistic prefill measurement.
const BENCH_PROMPT_UNIQUE: &str = "The architecture of modern large language models represents a fundamental shift in how we approach artificial intelligence and natural language processing. These systems are built on the transformer architecture, which relies entirely on self-attention mechanisms to process input sequences. The key innovation is that each position can attend to all positions in the previous layer, allowing the model to capture long-range dependencies that were previously difficult for recurrent architectures. Training these models requires massive computational resources, often involving thousands of GPU hours across distributed clusters. The scaling laws discovered by Kaplan and subsequent researchers show that model performance improves predictably with compute budget, dataset size, and parameter count. This has led to an arms race in model sizes, from GPT-3's 175 billion parameters to models exceeding one trillion parameters. Inference optimization is equally critical, as serving these models at scale requires techniques like quantization, speculative decoding, and efficient attention implementations. The KV cache alone can consume significant memory during long-context generation, making memory management a first-class concern in production deployments. Techniques such as PagedAttention have revolutionized how we handle the KV cache by eliminating memory fragmentation through virtual memory-like paging. Flash Attention further optimizes the computation by reordering operations to minimize HBM access, achieving both speedup and memory reduction. As models grow larger, tensor parallelism across multiple GPUs becomes essential for both training and inference workloads.";

/// Repetitive prompt pattern — predictable output ideal for testing speculative decoding acceleration.
const BENCH_PROMPT_REPETITIVE: &str = "the cat sat on the mat and then walked away because it was tired so the dog ran after the cat but the cat jumped over the fence and the dog could not follow because the fence was too high so the dog went back to the house where the cat had been sitting on the mat and the dog lay down next to the mat because it was also tired from running after the cat that had jumped over the fence which was too high for the dog to climb so they both rested on the mat until the sun went down behind the old oak tree in the backyard where the children used to play before they grew up and moved away to different cities far from the house with the tall fence and ";

#[derive(Debug, Clone)]
struct RunStats {
    prompt_tps: f64,
    gen_tps: f64,
    prompt_tokens: usize,
    gen_tokens: usize,
}

#[derive(Debug, Serialize)]
pub struct BenchResult {
    pub prompt_tokens: usize,
    pub gen_tokens: usize,
    /// Prefill throughput (tokens/sec) — per-request average on the measured run
    pub prompt_tps: f64,
    /// Generation throughput (tokens/sec) — per-request engine timing (parallel=1) or aggregate wall TPS
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
        };
    }

    let n = runs.len() as f64;
    let total_gen: usize = runs.iter().map(|r| r.gen_tokens).sum();
    let total_prompt: usize = runs.iter().map(|r| r.prompt_tokens).sum();
    let avg_prompt_tps = runs.iter().map(|r| r.prompt_tps).sum::<f64>() / n;
    let avg_gen_tps = runs.iter().map(|r| r.gen_tps).sum::<f64>() / n;
    let aggregate_gen_tps = if wall_ms > 0.0 {
        (total_gen as f64 / wall_ms) * 1000.0
    } else {
        avg_gen_tps
    };

    log::info!(
        "[BENCH_TG] parallel×{} | per-req gen avg {:.1} TPS | aggregate {:.1} TPS | total g_tok={}",
        parallel_requests,
        avg_gen_tps,
        aggregate_gen_tps,
        total_gen
    );

    RunStats {
        prompt_tps: avg_prompt_tps,
        gen_tps: aggregate_gen_tps,
        prompt_tokens: total_prompt,
        gen_tokens: total_gen,
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

    log::info!(
        "[BENCH_TG] start | n_predict={} parallel={} engine_slots={} mode={}",
        n_predict,
        parallel_requests,
        engine_slots,
        bench_prompt_mode
    );

    const WARMUP_TOKENS: usize = 512;
    let warmup_runs = if tg_warmup_enabled && n_predict <= WARMUP_TOKENS {
        1
    } else {
        0
    };
    let total_runs = warmup_runs + 1;

    release_all_slots(&client, port, "before benchmark").await;

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
        let effective_length = if is_warmup { WARMUP_TOKENS } else { n_predict };
        let run_parallel = if is_warmup { 1 } else { parallel_requests };

        crate::fusion_brain::reset_bench_meters_for_port(port);
        let _ = app_handle.emit(
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

        let bench_prompt_text = if bench_prompt_mode == "repetitive" {
            BENCH_PROMPT_REPETITIVE
        } else {
            BENCH_PROMPT_UNIQUE
        };

        match run_measured_completions(
            &client,
            &url,
            bench_prompt_text,
            effective_length,
            run_parallel,
        )
        .await
        {
            Ok((runs, wall_ms)) => {
                let summary = if run_parallel > 1 {
                    let avg_gen = runs.iter().map(|r| r.gen_tps).sum::<f64>() / runs.len() as f64;
                    measured_per_request_gen_tps = Some(avg_gen);
                    measured_aggregate_gen_tps = Some(
                        if wall_ms > 0.0 {
                            (runs.iter().map(|r| r.gen_tokens).sum::<usize>() as f64 / wall_ms)
                                * 1000.0
                        } else {
                            avg_gen
                        },
                    );
                    aggregate_parallel_runs(&runs, wall_ms, run_parallel)
                } else {
                    runs.into_iter().next().unwrap_or(RunStats {
                        prompt_tps: 0.0,
                        gen_tps: 0.0,
                        prompt_tokens: 0,
                        gen_tokens: 0,
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

                crate::fusion_brain::freeze_request_meters_for_port(port);

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