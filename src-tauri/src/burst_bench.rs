//! TG (generation) burst benchmark — multi-run POST to llama-server for realistic TPS measurement.
//!
//! Strategy: 1 warmup run (discarded) + N measured runs → min/avg/max stats.
//! Uses engine-reported timings (prompt_ms, predicted_ms) not HTTP round-trip time.

use serde::Serialize;

/// ~500 token prompt to properly warm Blackwell kernels for realistic prefill measurement.
const BENCH_PROMPT_UNIQUE: &str = "The architecture of modern large language models represents a fundamental shift in how we approach artificial intelligence and natural language processing. These systems are built on the transformer architecture, which relies entirely on self-attention mechanisms to process input sequences. The key innovation is that each position can attend to all positions in the previous layer, allowing the model to capture long-range dependencies that were previously difficult for recurrent architectures. Training these models requires massive computational resources, often involving thousands of GPU hours across distributed clusters. The scaling laws discovered by Kaplan and subsequent researchers show that model performance improves predictably with compute budget, dataset size, and parameter count. This has led to an arms race in model sizes, from GPT-3's 175 billion parameters to models exceeding one trillion parameters. Inference optimization is equally critical, as serving these models at scale requires techniques like quantization, speculative decoding, and efficient attention implementations. The KV cache alone can consume significant memory during long-context generation, making memory management a first-class concern in production deployments. Techniques such as PagedAttention have revolutionized how we handle the KV cache by eliminating memory fragmentation through virtual memory-like paging. Flash Attention further optimizes the computation by reordering operations to minimize HBM access, achieving both speedup and memory reduction. As models grow larger, tensor parallelism across multiple GPUs becomes essential for both training and inference workloads.";

/// Repetitive prompt pattern — predictable output ideal for testing speculative decoding acceleration.
const BENCH_PROMPT_REPETITIVE: &str = "the cat sat on the mat and then walked away because it was tired so the dog ran after the cat but the cat jumped over the fence and the dog could not follow because the fence was too high so the dog went back to the house where the cat had been sitting on the mat and the dog lay down next to the mat because it was also tired from running after the cat that had jumped over the fence which was too high for the dog to climb so they both rested on the mat until the sun went down behind the old oak tree in the backyard where the children used to play before they grew up and moved away to different cities far from the house with the tall fence";

#[derive(Debug, Serialize)]
pub struct BenchResult {
    pub prompt_tokens: usize,
    pub gen_tokens: usize,
    /// Prefill throughput stats (tokens/sec)
    pub prompt_tps_min: f64,
    pub prompt_tps_avg: f64,
    pub prompt_tps_max: f64,
    /// Generation throughput stats (tokens/sec)
    pub gen_tps_min: f64,
    pub gen_tps_avg: f64,
    pub gen_tps_max: f64,
    /// Average inter-token latency across all measured runs
    pub itl_ms_avg: f64,
    /// Number of measured runs (excludes warmup)
    pub runs_count: usize,
    pub success: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn cmd_burst_bench(
    port: u16,
    n_predict: usize,
    bench_prompt_mode: String,
) -> Result<BenchResult, String> {
    let url = format!("http://127.0.0.1:{}/completion", port);
    let client = reqwest::Client::new();

    const WARMUP_RUNS: usize = 1;
    const MEASURED_RUNS: usize = 3;
    const TOTAL_RUNS: usize = WARMUP_RUNS + MEASURED_RUNS;

    struct RunStats {
        prompt_tps: f64,
        gen_tps: f64,
        prompt_tokens: usize,
        gen_tokens: usize,
    }

    let mut measured_runs: Vec<RunStats> = Vec::with_capacity(MEASURED_RUNS);

    for run in 0..TOTAL_RUNS {
        // Release all slot KV caches before each run to prevent prompt caching from skewing results.
        if let Ok(slots_resp) = client.get(&format!("http://127.0.0.1:{}/slots", port)).send().await {
            if let Ok(slots) = slots_resp.json::<Vec<serde_json::Value>>().await {
                for slot in &slots {
                    let idx = slot["id"].as_u64().unwrap_or(0);
                    let _ = client.post(&format!("http://127.0.0.1:{}/slots/{}/release", port, idx)).send().await;
                }
                log::debug!("[BENCH_TG] released {} slots for run {}", slots.len(), run + 1);
            }
        }

        let bench_prompt_text = if bench_prompt_mode == "repetitive" {
            BENCH_PROMPT_REPETITIVE
        } else {
            BENCH_PROMPT_UNIQUE
        };

        let body = serde_json::json!({
            "prompt": bench_prompt_text,
            "n_predict": n_predict,
            "temperature": 0.0,
            "stream": false,
        });

        match client.post(&url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await {
                Ok(resp) => {
                    if !resp.status().is_success() {
                        return Err(format!("Server returned error: {}", resp.status()));
                    }

                    let parsed: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

                    // Extract token counts
                    let p_tokens = parsed["tokens_evaluated"].as_u64().unwrap_or(0) as usize;
                    let g_tokens = parsed["tokens_predicted"].as_u64().unwrap_or(0) as usize;

                    // Engine-reported timings in ms (not HTTP round-trip)
                    let p_ms = parsed["timings"]["prompt_ms"].as_f64().unwrap_or(0.0);
                    let g_ms = parsed["timings"]["predicted_ms"].as_f64().unwrap_or(0.0);

                    // Calculate per-run metrics
                    let prompt_tps = if p_ms > 0.0 { (p_tokens as f64 / p_ms) * 1000.0 } else { 0.0 };
                    let gen_tps = if g_ms > 0.0 { (g_tokens as f64 / g_ms) * 1000.0 } else { 0.0 };

                    log::info!("[BENCH_TG] run {} | mode={} | prefill: {:.1} TPS | gen: {:.1} TPS | p_tok={} g_tok={}",
                        run + 1, bench_prompt_mode, prompt_tps, gen_tps, p_tokens, g_tokens);

                    if run >= WARMUP_RUNS {
                        measured_runs.push(RunStats {
                            prompt_tps,
                            gen_tps,
                            prompt_tokens: p_tokens,
                            gen_tokens: g_tokens,
                        });
                    }
                }
                Err(e) => return Err(format!("Request failed: {}", e)),
            }
    }

    if measured_runs.is_empty() {
        return Ok(BenchResult {
            prompt_tokens: 0, gen_tokens: 0,
            prompt_tps_min: 0.0, prompt_tps_avg: 0.0, prompt_tps_max: 0.0,
            gen_tps_min: 0.0, gen_tps_avg: 0.0, gen_tps_max: 0.0,
            itl_ms_avg: 0.0, runs_count: 0, success: false,
            error: Some("No successful measured runs".to_string()),
        });
    }

    // Aggregate stats across measured runs
    let prompt_tps_values: Vec<f64> = measured_runs.iter().map(|r| r.prompt_tps).collect();
    let gen_tps_values: Vec<f64> = measured_runs.iter().map(|r| r.gen_tps).collect();

    let avg_fn = |vals: &[f64]| vals.iter().sum::<f64>() / vals.len() as f64;
    let min_fn = |vals: &[f64]| vals.iter().cloned().fold(f64::MAX, f64::min);
    let max_fn = |vals: &[f64]| vals.iter().cloned().fold(0.0_f64, f64::max);

    let gen_tps_avg = avg_fn(&gen_tps_values);
    let itl_ms_avg = if gen_tps_avg > 0.0 { 1000.0 / gen_tps_avg } else { 0.0 };

    // Use last run's token counts (most representative)
    let last = measured_runs.last().unwrap();

    log::info!("[BENCH_TG] RESULT | mode={} | prefill: {:.1}+/-{:.1} TPS | gen: {:.1}+/-{:.1} TPS | ITL: {:.2}ms",
        bench_prompt_mode,
        avg_fn(&prompt_tps_values), max_fn(&prompt_tps_values) - min_fn(&prompt_tps_values),
        gen_tps_avg, max_fn(&gen_tps_values) - min_fn(&gen_tps_values), itl_ms_avg);

    Ok(BenchResult {
        prompt_tokens: last.prompt_tokens,
        gen_tokens: last.gen_tokens,
        prompt_tps_min: min_fn(&prompt_tps_values),
        prompt_tps_avg: avg_fn(&prompt_tps_values),
        prompt_tps_max: max_fn(&prompt_tps_values),
        gen_tps_min: min_fn(&gen_tps_values),
        gen_tps_avg,
        gen_tps_max: max_fn(&gen_tps_values),
        itl_ms_avg,
        runs_count: measured_runs.len(),
        success: true,
        error: None,
    })
}
