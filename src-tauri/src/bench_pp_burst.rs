//! PP (prefill) burst benchmark — single measured run after warmup for clean prefill TPS measurement.
//!
//! 1 warmup run (fixed small length) + 1 measured run (user-selected target length).
//! Generates a synthetic prompt targeting ~N tokens, POSTs to /completion with n_predict=0,
//! and returns prefill TPS from engine-reported timings.

use crate::bench_cancel::{self, post_json};
use crate::bench_prompts::{self, TG_PREFILL_TARGET_TOKENS};
use serde::Serialize;
use tauri::Emitter;

struct BenchPortGuard(u16);

impl Drop for BenchPortGuard {
    fn drop(&mut self) {
        bench_cancel::end(self.0);
    }
}

fn bench_stopped_pp_result() -> BenchPPResult {
    BenchPPResult {
        bench_prefill_tps: 0.0,
        bench_prompt_tokens_actual: 0,
        success: false,
        error: Some("Stopped".to_string()),
    }
}

#[derive(Debug, Serialize)]
pub struct BenchPPResult {
    /// Prefill throughput (tokens/sec) — single measured run
    pub bench_prefill_tps: f64,
    pub bench_prompt_tokens_actual: usize,
    pub success: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn cmd_bench_pp_burst(
    app_handle: tauri::AppHandle,
    port: u16,
    target_tokens: usize,
    bench_prompt_mode: String,
) -> Result<BenchPPResult, String> {
    bench_cancel::begin(port);
    let _guard = BenchPortGuard(port);
    let url = format!("http://127.0.0.1:{port}/completion");
    let client = bench_cancel::bench_http_client(1)?;

    const WARMUP_RUNS: usize = 1;
    const MEASURED_RUNS: usize = 1;
    const TOTAL_RUNS: usize = WARMUP_RUNS + MEASURED_RUNS;

    struct RunStats {
        prefill_tps: f64,
        prompt_tokens: usize,
    }

    let repetitive = bench_prompts::is_repetitive_mode(&bench_prompt_mode);

    // Release all slot KV caches once before the benchmark loop to prevent prompt caching from skewing results.
    if let Ok(slots_resp) = client.get(&format!("http://127.0.0.1:{port}/slots")).send().await {
        if let Ok(slots) = slots_resp.json::<Vec<serde_json::Value>>().await {
            for slot in &slots {
                let idx = slot["id"].as_u64().unwrap_or(0);
                let _ = client
                    .post(&format!("http://127.0.0.1:{port}/slots/{idx}/release"))
                    .send()
                    .await;
            }
            log::debug!("[BENCH_PP] released {} slots before benchmark", slots.len());
        }
    }

    let mut measured_run: Option<RunStats> = None;

    for run in 0..TOTAL_RUNS {
        if bench_cancel::stop_after_current_requested(port) {
            return Ok(bench_stopped_pp_result());
        }

        let phase = if run < WARMUP_RUNS { "warmup" } else { "measured" };
        let effective_target = if run < WARMUP_RUNS {
            TG_PREFILL_TARGET_TOKENS
        } else {
            target_tokens
        };
        crate::fusion_brain::reset_bench_meters_for_port(port);
        let _ = app_handle.emit(
            "bench-pp-progress",
            serde_json::json!({
                "port": port,
                "phase": phase,
                "run": run + 1,
                "total": TOTAL_RUNS,
                "effectiveLength": effective_target,
            }),
        );

        let bench_prompt_text = match bench_prompts::build_prompt_for_token_target(
            &client,
            port,
            effective_target,
            repetitive,
            "[BENCH_PP]",
        )
        .await
        {
            Ok(text) => text,
            Err(e) if e == "Stopped" => return Ok(bench_stopped_pp_result()),
            Err(e) => return Err(e),
        };

        let body = serde_json::json!({
            "prompt": bench_prompt_text,
            "n_predict": 0,
            "temperature": 0.0,
            "stream": false,
            "cache_prompt": false,
        });

        match post_json(&client, &url, &body).await {
            Ok(parsed) => {
                let p_tokens = parsed["tokens_evaluated"].as_u64().unwrap_or(0) as usize;
                let p_ms = parsed["timings"]["prompt_ms"].as_f64().unwrap_or(0.0);
                let prefill_tps = if p_ms > 0.0 {
                    (p_tokens as f64 / p_ms) * 1000.0
                } else {
                    0.0
                };

                log::info!(
                    "[BENCH_PP] run {} | mode={} | target={} actual={} tok | prefill: {:.1} TPS",
                    run + 1,
                    bench_prompt_mode,
                    effective_target,
                    p_tokens,
                    prefill_tps
                );

                if run >= WARMUP_RUNS {
                    measured_run = Some(RunStats {
                        prefill_tps,
                        prompt_tokens: p_tokens,
                    });
                }
            }
            Err(e) => return Err(e),
        }

        if bench_cancel::stop_after_current_requested(port) {
            return Ok(bench_stopped_pp_result());
        }

        if run < WARMUP_RUNS {
            if let Ok(slots_resp) = client.get(&format!("http://127.0.0.1:{port}/slots")).send().await
            {
                if let Ok(slots) = slots_resp.json::<Vec<serde_json::Value>>().await {
                    for slot in &slots {
                        let idx = slot["id"].as_u64().unwrap_or(0);
                        let _ = client
                            .post(&format!("http://127.0.0.1:{port}/slots/{idx}/release"))
                            .send()
                            .await;
                    }
                    log::debug!(
                        "[BENCH_PP] released {} slots after warmup for cold measured run",
                        slots.len()
                    );
                }
            }
        }
    }

    let run = match measured_run {
        Some(r) => r,
        None => {
            return Ok(BenchPPResult {
                bench_prefill_tps: 0.0,
                bench_prompt_tokens_actual: 0,
                success: false,
                error: Some("No successful measured runs".to_string()),
            });
        }
    };

    log::info!(
        "[BENCH_PP] RESULT | mode={} | target={} actual={} tok | prefill: {:.1} TPS",
        bench_prompt_mode,
        target_tokens,
        run.prompt_tokens,
        run.prefill_tps
    );

    Ok(BenchPPResult {
        bench_prefill_tps: run.prefill_tps,
        bench_prompt_tokens_actual: run.prompt_tokens,
        success: true,
        error: None,
    })
}