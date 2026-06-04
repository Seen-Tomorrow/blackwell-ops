//! TG (generation) burst benchmark — single measured run after warmup for clean TPS measurement.
//!
//! Strategy: 2 warmup runs (discarded) + 1 measured run → single result values.
//! Uses engine-reported timings (prompt_ms, predicted_ms) not HTTP round-trip time.

use serde::Serialize;
use tauri::Emitter;

/// ~500 token prompt to properly warm Blackwell kernels for realistic prefill measurement.
const BENCH_PROMPT_UNIQUE: &str = "The architecture of modern large language models represents a fundamental shift in how we approach artificial intelligence and natural language processing. These systems are built on the transformer architecture, which relies entirely on self-attention mechanisms to process input sequences. The key innovation is that each position can attend to all positions in the previous layer, allowing the model to capture long-range dependencies that were previously difficult for recurrent architectures. Training these models requires massive computational resources, often involving thousands of GPU hours across distributed clusters. The scaling laws discovered by Kaplan and subsequent researchers show that model performance improves predictably with compute budget, dataset size, and parameter count. This has led to an arms race in model sizes, from GPT-3's 175 billion parameters to models exceeding one trillion parameters. Inference optimization is equally critical, as serving these models at scale requires techniques like quantization, speculative decoding, and efficient attention implementations. The KV cache alone can consume significant memory during long-context generation, making memory management a first-class concern in production deployments. Techniques such as PagedAttention have revolutionized how we handle the KV cache by eliminating memory fragmentation through virtual memory-like paging. Flash Attention further optimizes the computation by reordering operations to minimize HBM access, achieving both speedup and memory reduction. As models grow larger, tensor parallelism across multiple GPUs becomes essential for both training and inference workloads.";

/// Repetitive prompt pattern — predictable output ideal for testing speculative decoding acceleration.
const BENCH_PROMPT_REPETITIVE: &str = "the cat sat on the mat and then walked away because it was tired so the dog ran after the cat but the cat jumped over the fence and the dog could not follow because the fence was too high so the dog went back to the house where the cat had been sitting on the mat and the dog lay down next to the mat because it was also tired from running after the cat that had jumped over the fence which was too high for the dog to climb so they both rested on the mat until the sun went down behind the old oak tree in the backyard where the children used to play before they grew up and moved away to different cities far from the house with the tall fence";

#[derive(Debug, Serialize)]
pub struct BenchResult {
    pub prompt_tokens: usize,
    pub gen_tokens: usize,
    /// Prefill throughput (tokens/sec) — single measured run
    pub prompt_tps: f64,
    /// Generation throughput (tokens/sec) — single measured run
    pub gen_tps: f64,
    /// Inter-token latency (ms)
    pub itl_ms: f64,
    pub success: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn cmd_burst_bench(
    app_handle: tauri::AppHandle,
    port: u16,
    n_predict: usize,
    bench_prompt_mode: String,
) -> Result<BenchResult, String> {
    let url = format!("http://127.0.0.1:{}/completion", port);
    let client = reqwest::Client::new();

    const WARMUP_RUNS: usize = 1;
    const MEASURED_RUNS: usize = 1;
    const TOTAL_RUNS: usize = WARMUP_RUNS + MEASURED_RUNS;

    struct RunStats {
        prompt_tps: f64,
        gen_tps: f64,
        prompt_tokens: usize,
        gen_tokens: usize,
    }

    // Release all slot KV caches once before the benchmark loop to prevent prompt caching from skewing results.
    if let Ok(slots_resp) = client.get(&format!("http://127.0.0.1:{}/slots", port)).send().await {
        if let Ok(slots) = slots_resp.json::<Vec<serde_json::Value>>().await {
            for slot in &slots {
                let idx = slot["id"].as_u64().unwrap_or(0);
                let _ = client.post(&format!("http://127.0.0.1:{}/slots/{}/release", port, idx)).send().await;
            }
            log::debug!("[BENCH_TG] released {} slots before benchmark", slots.len());
        }
    }

    let mut measured_run: Option<RunStats> = None;

    for run in 0..TOTAL_RUNS {
        // Signal phase to frontend so UI can show WARMUP vs MEASURED
        let phase = if run < WARMUP_RUNS { "warmup" } else { "measured" };
        let _ = app_handle.emit("bench-tg-progress", serde_json::json!({
            "port": port,
            "phase": phase,
            "run": run + 1,
            "total": TOTAL_RUNS,
        }));

        let bench_prompt_text = if bench_prompt_mode == "repetitive" {
            BENCH_PROMPT_REPETITIVE
        } else {
            BENCH_PROMPT_UNIQUE
        };

        let run_n_predict = if run < WARMUP_RUNS { 1024 } else { n_predict };

        let body = serde_json::json!({
            "prompt": bench_prompt_text,
            "n_predict": run_n_predict,
            "temperature": 0.0,
            "stream": false,
            "cache_prompt": false,
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
                        measured_run = Some(RunStats {
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

    let run = match measured_run {
        Some(r) => r,
        None => {
            return Ok(BenchResult {
                prompt_tokens: 0, gen_tokens: 0,
                prompt_tps: 0.0, gen_tps: 0.0, itl_ms: 0.0,
                success: false,
                error: Some("No successful measured runs".to_string()),
            });
        }
    };

    let itl_ms = if run.gen_tps > 0.0 { 1000.0 / run.gen_tps } else { 0.0 };

    log::info!("[BENCH_TG] RESULT | mode={} | prefill: {:.1} TPS | gen: {:.1} TPS | ITL: {:.2}ms",
        bench_prompt_mode, run.prompt_tps, run.gen_tps, itl_ms);

    Ok(BenchResult {
        prompt_tokens: run.prompt_tokens,
        gen_tokens: run.gen_tokens,
        prompt_tps: run.prompt_tps,
        gen_tps: run.gen_tps,
        itl_ms,
        success: true,
        error: None,
    })
}