//! PP (prefill) burst benchmark — single measured run after warmup for clean prefill TPS measurement.
//!
//! 1 warmup run (fixed small length) + 1 measured run (user-selected target length).
//! Generates a synthetic prompt targeting ~N tokens, POSTs to /completion with n_predict=0,
//! and returns prefill TPS from engine-reported timings.

use crate::bench_cancel::{self, post_json, release_all_slots, BenchPortGuard};
use crate::bench_prompts::{self, TG_PREFILL_TARGET_TOKENS};
use serde::Serialize;


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
    reps: Option<usize>,
) -> Result<BenchPPResult, String> {
    bench_cancel::begin(port);
    let _guard = BenchPortGuard(port);
    let url = format!("http://127.0.0.1:{port}/completion");
    let client = bench_cancel::bench_http_client(1)?;

    const WARMUP_RUNS: usize = 1;
    // Repeats are opt-in: one run by default keeps iteration fast, 3+ is for publishing.
    let measured_runs = reps.unwrap_or(1).clamp(1, 5);
    let total_runs = WARMUP_RUNS + measured_runs;

    /// Physically implausible prefill = the request hit the slot KV cache instead of
    /// evaluating. Dropping those samples is what stops the "tens of thousands" spikes.
    const IMPLAUSIBLE_PREFILL_TPS: f64 = 50_000.0;

    #[derive(Clone, Copy)]
    struct RunStats {
        /// Wall rate the engine prints (includes checkpoint copies) — the hero/log figure.
        prefill_tps_wall: f64,
        /// Wall rate minus the measured checkpoint saves — comparable across engines.
        prefill_tps_real: f64,
        prompt_tokens: usize,
        /// Wall prompt time reported by the engine (includes checkpoint copies).
        prompt_ms: f64,
        /// Checkpoint copy time measured from the engine log and removed from `prefill_tps_real`.
        checkpoint_ms: f64,
    }

    fn median(mut v: Vec<RunStats>) -> RunStats {
        v.sort_by(|a, b| {
            a.prefill_tps_wall
                .partial_cmp(&b.prefill_tps_wall)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        v[v.len() / 2]
    }


    // Probe per-slot n_ctx before release so we can clamp full-CTX PP targets.
    let slot_n_ctx = bench_prompts::probe_min_slot_n_ctx(&client, port).await;
    let pp_budget = bench_prompts::pp_prompt_budget_for_slot_ctx(slot_n_ctx);
    let measured_target = if slot_n_ctx > 0 {
        let clamped = bench_prompts::clamp_pp_target_to_slot_ctx(target_tokens, slot_n_ctx);
        if clamped < target_tokens {
            log::debug!(
                "[BENCH_PP] clamping PP target {} → {} (slot n_ctx={} budget={})",
                target_tokens,
                clamped,
                slot_n_ctx,
                pp_budget
            );
        }
        clamped
    } else {
        target_tokens
    };
    let max_prompt_tokens = if slot_n_ctx > 0 { Some(pp_budget) } else { None };

    // Release all slot KV caches once before the benchmark loop to prevent prompt caching from skewing results.
    release_all_slots(&client, port, "before benchmark").await;

    let spec_before = crate::bench_archive::spec_counters(port).await;
    let mut samples: Vec<RunStats> = Vec::with_capacity(measured_runs);

    for run in 0..total_runs {
        if bench_cancel::stop_after_current_requested(port) {
            return Ok(bench_stopped_pp_result());
        }

        let phase = if run < WARMUP_RUNS { "warmup" } else { "measured" };
        let effective_target = if run < WARMUP_RUNS {
            TG_PREFILL_TARGET_TOKENS
        } else {
            measured_target
        };
        crate::fusion::reset_bench_meters_for_port(port).await;
        crate::ipc_meter::emit_tracked(
            &app_handle,
            "bench-pp-progress",
            serde_json::json!({
                "port": port,
                "phase": phase,
                "run": run + 1,
                "total": total_runs,
                "effectiveLength": effective_target,
            }),
        );

        let bench_prompt_text = match bench_prompts::build_prompt_for_token_target_capped(
            &client,
            port,
            effective_target,
            &bench_prompt_mode,
            "[BENCH_PP]",
            // Warmup is tiny — only enforce ceiling on measured full-CTX runs.
            if run < WARMUP_RUNS { None } else { max_prompt_tokens },
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
            "stream": true,
            "return_progress": true,
            "sse_ping_interval": 1,
            "cache_prompt": false,
        });

        match post_json(&client, &url, &body, port).await {
            Ok(parsed) => {
                let p_tokens = parsed["tokens_evaluated"].as_u64().unwrap_or(0) as usize;
                let p_ms = parsed["timings"]["prompt_ms"].as_f64().unwrap_or(0.0);
                // The checkpoint saves are logged just before the response is written; give the
                // stderr reader one tick if the last line has not landed yet.
                let mut checkpoint_ms = crate::engine_events::checkpoint_ms(port);
                if checkpoint_ms == 0.0 {
                    tokio::time::sleep(std::time::Duration::from_millis(40)).await;
                    checkpoint_ms = crate::engine_events::checkpoint_ms(port);
                }
                if checkpoint_ms < 0.0 || checkpoint_ms >= p_ms * 0.5 {
                    checkpoint_ms = 0.0; // implausible: never skew the number with a bad clock
                }
                let clean_ms = p_ms - checkpoint_ms;
                let prefill_tps_wall = if p_ms > 0.0 {
                    (p_tokens as f64 / p_ms) * 1000.0
                } else {
                    0.0
                };
                let prefill_tps_real = if clean_ms > 0.0 {
                    (p_tokens as f64 / clean_ms) * 1000.0
                } else {
                    0.0
                };

                log::debug!(
                    "[BENCH_PP] run {} | mode={} | target={} actual={} tok | prefill: {:.1} TPS (real {:.1}, wall {:.1} ms, checkpoints {:.1} ms)",
                    run + 1,
                    bench_prompt_mode,
                    effective_target,
                    p_tokens,
                    prefill_tps_wall,
                    prefill_tps_real,
                    p_ms,
                    checkpoint_ms
                );

                if run >= WARMUP_RUNS {
                    if prefill_tps_wall > IMPLAUSIBLE_PREFILL_TPS {
                        // Cache hit, not a prefill — keep it out of the median.
                        log::warn!(
                            "[BENCH_PP] run {} implausible ({:.0} TPS over {} tok) — treating as cache hit, dropping",
                            run + 1,
                            prefill_tps_wall,
                            p_tokens
                        );
                    } else if prefill_tps_wall > 0.0 {
                        samples.push(RunStats {
                            prefill_tps_wall,
                            prefill_tps_real,
                            prompt_tokens: p_tokens,
                            prompt_ms: p_ms,
                            checkpoint_ms,
                        });
                    }
                }
            }
            Err(e) if bench_cancel::is_stopped_err(&e) => {
                return Ok(bench_stopped_pp_result());
            }
            Err(e) => return Err(e),
        }

        if bench_cancel::stop_after_current_requested(port) {
            return Ok(bench_stopped_pp_result());
        }

        // The post-warmup release was there to force a "cold" measured run. It is redundant —
        // every request already sends cache_prompt:false, so the engine re-evaluates the prompt
        // regardless — and it had a cost: releasing every slot moves the measured run onto a
        // different slot than the warmed one, so the first measured run paid cold-slot setup
        // (graph build) inside prompt_ms. Also, on a --parallel 32 engine it was a second full
        // sweep of 32 release calls before a test that uses one slot.
    }

    let spec_after = crate::bench_archive::spec_counters(port).await;
    let (spec_acc, spec_draft, spec_rate) = match (spec_before, spec_after) {
        (Some((a0, d0)), Some((a1, d1))) if d1 >= d0 && a1 >= a0 => {
            let (da, dd) = (a1 - a0, d1 - d0);
            (da, dd, if dd > 0 { da as f64 / dd as f64 } else { 0.0 })
        }
        _ => (0, 0, 0.0),
    };
    let run = match if samples.is_empty() { None } else { Some(median(samples)) } {
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

    let pp_line = format!(
        "[BENCH_PP] RESULT | mode={} | requested={} effective={} actual={} tok | slot_n_ctx={} | prefill: {:.1} TPS (real {:.1}, wall {:.1} ms, checkpoints {:.1} ms)",
        bench_prompt_mode,
        target_tokens,
        measured_target,
        run.prompt_tokens,
        slot_n_ctx,
        run.prefill_tps_wall,
        run.prefill_tps_real,
        run.prompt_ms,
        run.checkpoint_ms
    );
    log::debug!("{pp_line}");
    crate::session_log::append_session_line(&pp_line);

    // Persist the measurement (fire-and-forget; never delays or fails the bench).
    {
        let metrics = serde_json::json!({
            "success": true,
            "prompt_tokens": run.prompt_tokens,
            // Wall is what the engine logs (and the hero pin); real removes the checkpoint saves
            // and is the figure to compare across engines / launch flags.
            "prompt_tps": run.prefill_tps_wall,
            "prompt_tps_real": run.prefill_tps_real,
            "prompt_tps_wall": if run.prompt_ms > 0.0 {
                (run.prompt_tokens as f64 / run.prompt_ms) * 1000.0
            } else {
                0.0
            },
            "checkpoint_ms": run.checkpoint_ms,
        });
        let params = serde_json::json!({
            "prompt_mode": bench_prompt_mode.clone(),
            "target_tokens": target_tokens,
            "effective_target": measured_target,
            "slot_n_ctx": slot_n_ctx,
            "reps": measured_runs,
            "spec_accepted": spec_acc,
            "spec_draft": spec_draft,
            "spec_accept_rate": spec_rate,
        });
        let bench_port = port;
        tokio::spawn(async move {
            if let Err(e) =
                crate::bench_archive::capture("pp_burst", bench_port, params, metrics).await
            {
                log::warn!("[bench-archive] pp capture failed: {e}");
            }
        });
    }

    Ok(BenchPPResult {
        bench_prefill_tps: run.prefill_tps_real,
        bench_prompt_tokens_actual: run.prompt_tokens,
        success: true,
        error: None,
    })
}
