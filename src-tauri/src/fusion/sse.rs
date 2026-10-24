//! SseBrain — the stream-only fusion brain.
//!
//! Reads the `/events/sse` snapshot maintained by [`crate::engine_events`] and emits the same
//! `FusionUpdate` contract as the poll brain, on the same render tick. There is no `/slots`, no
//! `/metrics` and no stderr here: the stream is the only source, and a value it cannot supply
//! stays zero/None instead of being guessed.
//!
//! Selected once, at launch, by the capability probe in `start_brain`. The poll brain remains the
//! fallback for engines without the telemetry patch (STABLE builds, ggml-tom, unpatched forks).
//!
//! The request lifecycle (clock, TTFT split, freeze/latch) is the shared
//! [`RequestLifecycle`] — this module feeds it stream numbers and never re-derives the policy.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::fusion::brain::{EngineState, FusionConfig, FUSION_SHUTTING_DOWN};
use crate::fusion::emit::{cache_fusion_snapshot, FusionEmitFingerprint, FusionUpdate, SlotCtxInfo};
use crate::fusion::lifecycle::{
    FreezeInput, InferencePhase, RequestLifecycle, INTER_REQUEST_GAP_HOLD_MS,
    MIN_TG_PER_REQUEST_AVG_MS,
};
use crate::fusion::meter::{self, FusionMeterLane};
use crate::log_hub::LogHub;

/// Render tick — the same constant the poll brain and the frontend already share.
fn render_tick_ms() -> u64 {
    crate::log_hub::telemetry_tick_ms().max(1)
}

/// Map an engine `state` phase onto the UI's three-value phase.
///
/// `WAIT` (slot queued) is displayed as idle: it is not work in progress, and the engine emits no
/// own phase for "queued but not started".
fn stream_phase(phase: &str) -> InferencePhase {
    match phase {
        "PP" => InferencePhase::PP,
        "TG" => InferencePhase::Tg,
        _ => InferencePhase::Idle,
    }
}

/// True when a lane is doing work (queued/WAIT lanes are not).
fn lane_busy(lane: &crate::engine_events::SlotTelemetry) -> bool {
    lane.phase == "PP" || lane.phase == "TG"
}

pub struct SseBrain {
    alias: String,
    slot_idx: usize,
    port: u16,
    ctx_total: usize,
    parallel: i64,
    unified_kv: bool,
    req: RequestLifecycle,
    engine_state: EngineState,
    meter_seq: u64,
    last_emit_fp: Option<FusionEmitFingerprint>,

    /// Generated tokens in the current request (latched max — lanes reset their counters when
    /// they release, so the live sum would fall near the end of a parallel wave).
    request_tokens: u64,
    /// Peak system TG rate seen this request (the freeze's parallel fallback).
    request_peak_tps: f64,
    /// Peak concurrent lanes this request (per-slot denominator + freeze).
    peak_wave: usize,
    /// Last-lane decode clock, latched once the whole wave has produced a token.
    wave_start: Option<Instant>,
    /// Per-lane KV fill (prompt processed + generated) this request. The stream carries
    /// per-request counters, not session ones, so the fill is held between requests and cleared
    /// when the next request starts.
    slot_fill: HashMap<i32, usize>,
    /// Cumulative generated tokens since this brain started (the update's session total).
    session_tokens: u64,
    /// Last tick with a non-idle phase — the close fallback when no `request_end` is seen.
    last_active_at: Option<Instant>,
    /// Port request counter at the last request boundary (see `engine_events::request_epoch`).
    request_epoch: u64,
    /// Throttle the DEV `[fusion-sse]` meter dump.
    last_stats_log_at: Option<Instant>,
    /// Set by `close_request` so the next tick can dump the FINAL line once.
    just_closed: bool,
}

impl SseBrain {
    fn new(config: &FusionConfig) -> Self {
        Self {
            alias: config.alias.clone(),
            slot_idx: config.slot_idx,
            port: config.port,
            ctx_total: config.ctx_total,
            parallel: config.parallel,
            unified_kv: config.unified_kv,
            req: RequestLifecycle::default(),
            // The brain starts with the engine process, before the model is loaded. `/events/sse`
            // carries no readiness event, so readiness comes from the launch path's own probe
            // (`engine_stack::slot_ready`) rather than from the stream.
            engine_state: if crate::engine_stack::slot_ready(config.slot_idx) {
                EngineState::Ready
            } else {
                EngineState::Loading
            },
            meter_seq: 0,
            last_emit_fp: None,
            request_tokens: 0,
            request_peak_tps: 0.0,
            peak_wave: 0,
            wave_start: None,
            slot_fill: HashMap::new(),
            session_tokens: 0,
            last_active_at: None,
            request_epoch: 0,
            last_stats_log_at: None,
            just_closed: false,
        }
    }

    fn begin_request(&mut self) {
        if self.req.begin_request() {
            self.meter_seq = self.meter_seq.wrapping_add(1);
        }
        self.req.phase = InferencePhase::PP;
        self.req.log_request_open = true;
        self.req.log_prefill_done = false;
        self.request_tokens = 0;
        self.request_peak_tps = 0.0;
        self.peak_wave = 0;
        self.wave_start = None;
        self.slot_fill.clear();
        self.engine_state = EngineState::Active;
    }

    fn close_request(&mut self) {
        // Feed the shared freeze policy the numbers this brain owns; it decides peak vs last.
        self.req.sticky_wave_peak = self.peak_wave;
        if self.request_peak_tps > self.req.peak_gen_tps_request {
            self.req.peak_gen_tps_request = self.request_peak_tps;
        }
        self.req.freeze(FreezeInput {
            live_tokens: self.request_tokens as usize,
            peak_tokens: self.request_tokens as usize,
            last_busy_slot_count: self.peak_wave,
            latched_peak: self.peak_wave,
            decode_wall_at: self.wave_start,
            tg_burst_started_at: self.wave_start,
        });
        self.session_tokens = self.session_tokens.saturating_add(self.request_tokens);
        self.req.log_request_open = false;
        self.req.close();
        self.request_tokens = 0;
        self.request_peak_tps = 0.0;
        self.peak_wave = 0;
        self.wave_start = None;
        // The stream goes IDLE after the request; carry that into the update instead of leaving
        // the display stuck in PP/TG until the next request starts.
        self.req.phase = InferencePhase::Idle;
        self.req.lp_phase = InferencePhase::Idle;
        self.engine_state = EngineState::Ready;
        self.just_closed = true;
    }

    /// Tokens ÷ wall since the wave clock started. Zero until the whole wave has decoded and the
    /// 500 ms floor has passed — the row-4 rule ("AVG starts when the last lane decodes").
    fn avg_tps(&self, now: Instant) -> f64 {
        let Some(start) = self.wave_start else {
            return 0.0;
        };
        let elapsed_ms = now.saturating_duration_since(start).as_millis() as u64;
        if elapsed_ms < MIN_TG_PER_REQUEST_AVG_MS || self.request_tokens == 0 {
            return 0.0;
        }
        meter::clamp_display_tps(self.request_tokens as f64 / (elapsed_ms as f64 / 1000.0))
    }

    /// Fold one snapshot into the lifecycle and the request-local latches.
    ///
    /// The caller fetches the snapshot once per tick and hands the *same* view to
    /// [`Self::build_update`], so the phase the update is built from cannot differ from the phase
    /// this method just observed.
    fn observe(
        &mut self,
        t: Option<&crate::engine_events::SlotTelemetry>,
        lanes: &[crate::engine_events::SlotTelemetry],
        now: Instant,
    ) {
        let Some(t) = t else {
            // Attach gap or engine gone: hold the last emitted state until the app stops the
            // brain (stop_brain emits the terminal update).
            return;
        };
        let phase = stream_phase(&t.phase);
        let busy = lanes.iter().filter(|l| lane_busy(l)).count();
        if busy > self.peak_wave {
            self.peak_wave = busy;
        }

        // Hard request boundary: a `state: PP` transition bumps the port's epoch. This catches
        // back-to-back requests whose IDLE state can fall between two 25 ms render ticks.
        let epoch = crate::engine_events::request_epoch(self.port);
        if epoch != self.request_epoch {
            self.request_epoch = epoch;
            if self.req.request_start.is_some() && !self.req.request_closed {
                self.close_request();
            }
        }

        let open = self.req.request_start.is_some() && !self.req.request_closed;
        if !open {
            if phase == InferencePhase::Idle {
                return;
            }
            self.begin_request();
        }

        self.req.phase = phase;
        if phase != InferencePhase::Idle {
            self.last_active_at = Some(now);
            if phase == InferencePhase::Tg {
                self.req.log_prefill_done = true;
            }

            // Latch the wave clock: solo starts at its first token, parallel only when every busy
            // lane has decoded (the aggregate already applied that rule).
            if self.wave_start.is_none() {
                if self.parallel <= 1 {
                    self.wave_start = t.t_first_token;
                } else if t.wave_ready {
                    self.wave_start = t.t_wave_start;
                }
            }

            // Tokens this request: summed decoded, monotonic (lanes reset on release).
            if t.gen_decoded > self.request_tokens {
                self.request_tokens = t.gen_decoded;
            }

            // Per-lane fill for the ctx bars: prompt evaluated + generated this request.
            for lane in lanes {
                let fill = (lane.pp_processed.max(0) + lane.gen_decoded as i64).max(0) as usize;
                let held = self.slot_fill.entry(lane.slot).or_insert(0);
                if fill > *held {
                    *held = fill;
                }
            }

            let avg = self.avg_tps(now);
            if avg > 0.0 {
                self.req.last_gen_tps = avg;
                if avg > self.request_peak_tps {
                    self.request_peak_tps = avg;
                }
            }
        }

        // Close on the first `request_end` after the engine went idle. The aggregate's
        // all-lanes-closed flag is wrong for a one-lane request on a wide engine, so any lane's
        // end is enough; the phase guard keeps an early-finishing lane from closing the wave.
        let still_open = self.req.request_start.is_some() && !self.req.request_closed;
        let any_closed = lanes.iter().any(|l| l.request_closed);
        let idle_long = self
            .last_active_at
            .map(|t| now.saturating_duration_since(t).as_millis() >= INTER_REQUEST_GAP_HOLD_MS as u128)
            .unwrap_or(false);
        if still_open && phase == InferencePhase::Idle && (any_closed || idle_long) {
            self.close_request();
        }
    }

    fn build_update(
        &self,
        t: Option<&crate::engine_events::SlotTelemetry>,
        lanes: &[crate::engine_events::SlotTelemetry],
        now: Instant,
    ) -> FusionUpdate {
        let busy = lanes.iter().filter(|l| lane_busy(l)).count();
        let open = !self.req.request_closed && self.req.request_start.is_some();
        let parallel_lane = self.parallel > 1 || busy > 1;

        // Prefill: live stream window while PP, then the completed request's slot clock.
        let (pp_rate, pp_progress, pp_tokens, pp_total) = match t {
            Some(t) if t.phase == "PP" => {
                let evaluated = (t.pp_processed - t.pp_cache).max(0) as f64;
                (
                    meter::steady_prefill_tps(evaluated, t.pp_time_ms),
                    if t.pp_total > 0 {
                        (t.pp_processed as f64 / t.pp_total as f64).clamp(0.0, 1.0)
                    } else {
                        0.0
                    },
                    t.pp_processed.max(0) as usize,
                    t.pp_total.max(0) as usize,
                )
            }
            Some(t) => {
                let steady = t
                    .last_request
                    .as_ref()
                    .map(|r| meter::steady_prefill_tps(r.tokens_evaluated as f64, r.prompt_ms))
                    .unwrap_or(0.0);
                (steady, 0.0, 0, 0)
            }
            None => (0.0, 0.0, 0, 0),
        };

        // REAL PP: prefill without the context-checkpoint copies. The copy clock comes from the
        // engine log (checkpoint save timestamps), so this works on any engine launched with
        // checkpoints on; it is the figure a `-ctxcp 0` run produces.
        let pp_real = match t {
            Some(t) if t.pp_processed > 0 => meter::real_prefill_tps(
                t.pp_processed.max(0) as u64,
                t.pp_time_ms,
                crate::engine_events::checkpoint_ms(self.port),
            ),
            Some(t) if !open => t
                .last_request
                .as_ref()
                .map(|r| meter::real_prefill_tps(r.tokens_evaluated, r.prompt_ms, r.checkpoint_ms))
                .unwrap_or(0.0),
            _ => 0.0,
        };
        // What the engine's own log reports (copies included) — the small companion.
        let pp_engine = match t {
            Some(t) if t.pp_processed > 0 => {
                meter::engine_prefill_tps(t.pp_processed.max(0) as u64, t.pp_time_ms)
            }
            Some(t) if !open => t
                .last_request
                .as_ref()
                .map(|r| meter::engine_prefill_tps(r.tokens_evaluated, r.prompt_ms))
                .unwrap_or(0.0),
            _ => 0.0,
        };

        let gen_avg = if self.req.request_closed {
            if self.req.frozen_request_gen_tps > 0.0 {
                self.req.frozen_request_gen_tps
            } else {
                self.req.last_gen_tps
            }
        } else if open {
            self.avg_tps(now)
        } else {
            self.req.last_gen_tps
        };
        let gen_instant = match t {
            Some(t) if open => meter::clamp_display_tps(t.gen_tps),
            _ => 0.0,
        };

        let (ttft, prefill_ms, decode_ttft) = match t {
            Some(t) => {
                let ttft = t.ttft_ms().or(self.req.ttft_ms);
                let prefill = t
                    .t_prefill_end
                    .zip(t.t_request_start)
                    .map(|(end, start)| end.saturating_duration_since(start).as_secs_f64() * 1000.0)
                    .or_else(|| t.last_request.as_ref().map(|r| r.prompt_ms))
                    .or(self.req.prefill_ms);
                let decode = t.decode_ttft_ms().or(self.req.decode_ttft_ms);
                (ttft, prefill, decode)
            }
            None => (self.req.ttft_ms, self.req.prefill_ms, self.req.decode_ttft_ms),
        };

        let ctx_per_slot = lanes
            .iter()
            .find_map(|l| (l.n_ctx > 0).then_some(l.n_ctx as usize))
            .unwrap_or_else(|| {
                if self.parallel > 1 {
                    (self.ctx_total / self.parallel as usize).max(1)
                } else {
                    self.ctx_total
                }
            });
        let slot_ctx: Vec<SlotCtxInfo> = lanes
            .iter()
            .map(|l| {
                let fill = self.slot_fill.get(&l.slot).copied().unwrap_or(0);
                SlotCtxInfo {
                    id: l.slot.max(0) as usize,
                    n_decoded: l.gen_decoded as usize,
                    session_n_decoded: fill,
                    total_tokens_lifetime: fill,
                    is_processing: lane_busy(l),
                    prompt_tokens: l.pp_total.max(0) as usize,
                    prompt_tokens_processed: l.pp_processed.max(0) as usize,
                    prompt_tokens_cache: l.pp_cache.max(0) as usize,
                    n_remain: 0,
                    id_task: None,
                    // The telemetry stream does not carry per-lane spec flags.
                    speculative: false,
                    n_ctx_slot: if l.n_ctx > 0 { l.n_ctx as usize } else { ctx_per_slot },
                }
            })
            .collect();
        let ctx_used_session = slot_ctx
            .iter()
            .map(|s| s.session_n_decoded)
            .max()
            .unwrap_or(0);
        let ctx_fill_pct = slot_ctx
            .iter()
            .filter(|s| s.n_ctx_slot > 0)
            .map(|s| s.session_n_decoded as f64 / s.n_ctx_slot as f64 * 100.0)
            .fold(0.0_f64, f64::max);

        let (spec_acc, spec_draft) = t
            .map(|t| (t.spec_accepted_total, t.spec_draft_total))
            .unwrap_or((0, 0));
        let (spec_rate, spec_acc_last, spec_gen_last) = t
            .and_then(|t| t.last_request.as_ref())
            .map(|r| {
                let rate = if r.spec_draft > 0 {
                    Some(r.spec_accepted as f64 / r.spec_draft as f64)
                } else {
                    None
                };
                (
                    rate,
                    Some(r.spec_accepted as usize),
                    Some(r.spec_draft as usize),
                )
            })
            .unwrap_or((None, None, None));

        let concurrent = if self.req.request_closed && self.req.frozen_concurrent_slots > 1 {
            self.req.frozen_concurrent_slots
        } else {
            busy.max(self.peak_wave).max(1)
        };
        let (gen_tps_per_slot, gen_tps_per_slot_instant) = if self.req.request_closed
            && self.req.frozen_gen_tps_per_slot > 0.0
        {
            (
                self.req.frozen_gen_tps_per_slot,
                self.req.frozen_gen_tps_per_slot,
            )
        } else {
            (
                meter::per_slot_tps(gen_avg, concurrent),
                meter::per_slot_tps(gen_instant, concurrent),
            )
        };

        FusionUpdate {
            alias: self.alias.clone(),
            slot_idx: self.slot_idx,
            port: self.port,
            telemetry_source: "sse".to_string(),
            engine_state: self.engine_state.clone(),
            phase: self.req.phase,
            prefill_tps_metrics: 0.0,
            prefill_tps_session: pp_rate,
            // The stream's PP rate is already the steady figure, so LIVE and AVG agree here.
            prefill_tps_instant: pp_rate,
            prefill_tps_real: pp_real,
            prefill_tps_engine: pp_engine,
            prefill_progress: pp_progress,
            prefill_tokens: pp_tokens,
            prefill_tokens_total: pp_total,
            gen_tps: gen_avg,
            gen_tps_session: gen_avg,
            gen_tps_instant: gen_instant,
            gen_tokens_per_request_slots: if open {
                self.request_tokens as usize
            } else {
                0
            },
            gen_tokens_per_session: self.session_tokens as usize,
            ctx_used_session,
            ctx_fill_pct,
            ctx_total: self.ctx_total,
            ctx_per_slot,
            request_elapsed_ms: self
                .req
                .request_start
                .map(|start| start.elapsed().as_millis() as u64)
                .unwrap_or(self.req.request_elapsed_frozen_ms),
            ttft_ms: ttft,
            prefill_ms,
            decode_ttft_ms: decode_ttft,
            slot_ctx,
            parallel: self.parallel,
            unified_kv: self.unified_kv,
            // No stderr: the log-derived comparison fields stay empty by design.
            lp_prefill_progress: 0.0,
            lp_prefill_tps: 0.0,
            lp_prompt_tokens: 0,
            lp_gen_tps: 0.0,
            lp_phase: InferencePhase::Idle,
            spec_draft_accept_rate: if spec_draft > 0 {
                Some(spec_acc as f64 / spec_draft as f64)
            } else {
                None
            },
            spec_draft_accepted: spec_acc,
            spec_draft_generated: spec_draft,
            spec_draft_accept_rate_last: spec_rate,
            spec_draft_accepted_last: spec_acc_last,
            spec_draft_generated_last: spec_gen_last,
            // Draft family comes from stderr (`common_specu`); the stream has no equivalent.
            spec_mode: None,
            lp_reset_source: None,
            request_closed: self.req.request_closed,
            meter_lane: if parallel_lane {
                FusionMeterLane::Parallel
            } else {
                FusionMeterLane::Single
            },
            busy_slot_count: busy,
            concurrent_slots: concurrent,
            gen_tps_per_slot,
            gen_tps_per_slot_instant,
            meter_seq: self.meter_seq,
        }
    }

    fn emit(&mut self, log_hub: &LogHub, update: FusionUpdate) {
        let fp = FusionEmitFingerprint::from_update(&update);
        if self.last_emit_fp.as_ref() == Some(&fp) {
            return;
        }
        self.last_emit_fp = Some(fp);
        cache_fusion_snapshot(&update);
        log_hub.emit("fusion-update", &update);
    }

    /// Promote LOADING → READY from the launch path's readiness fact (the stream has no event).
    /// Never touches ACTIVE — a request in flight must keep the UI's live belt.
    fn sync_ready(&mut self) {
        if self.engine_state == EngineState::Loading
            && crate::engine_stack::slot_ready(self.slot_idx)
        {
            self.engine_state = EngineState::Ready;
        }
    }

    /// One snapshot for both the lifecycle fold and the update built from it.
    fn stream_view(
        &self,
    ) -> (
        Option<crate::engine_events::SlotTelemetry>,
        Vec<crate::engine_events::SlotTelemetry>,
    ) {
        let lanes = crate::engine_events::lanes(self.port);
        let snapshot = if self.parallel <= 1 {
            crate::engine_events::snapshot(self.port)
        } else {
            crate::engine_events::aggregate(self.port)
        };
        (snapshot, lanes)
    }

    /// DEV meter dump → session.log (the SSE brain's `[fusion-stats]`).
    fn log_stats(&mut self, kind: &str, u: &FusionUpdate, raw_phase: Option<&str>) {
        if !crate::session_log::is_active() {
            return;
        }
        let now = Instant::now();
        if kind == "LIVE" {
            if let Some(prev) = self.last_stats_log_at {
                if now.duration_since(prev).as_millis() < 1000 {
                    return;
                }
            }
            self.last_stats_log_at = Some(now);
        }
        crate::session_log::append_session_line(&format!(
            "[fusion-sse] {kind} port={} raw={} phase={:?} engine={:?} proc={} total={} prog={:.3} ppTps={:.1} genAvg={:.1} genInst={:.1} tokens={} ctx={:.0}%",
            self.port,
            raw_phase.unwrap_or("-"),
            u.phase,
            u.engine_state,
            u.prefill_tokens,
            u.prefill_tokens_total,
            u.prefill_progress,
            u.prefill_tps_session,
            u.gen_tps,
            u.gen_tps_instant,
            u.gen_tokens_per_request_slots,
            u.ctx_fill_pct,
        ));
    }

    fn tick(&mut self, log_hub: &LogHub) {
        let now = Instant::now();
        self.sync_ready();
        let (snapshot, lanes) = self.stream_view();
        self.observe(snapshot.as_ref(), &lanes, now);
        let update = self.build_update(snapshot.as_ref(), &lanes, now);
        let raw_phase = snapshot.as_ref().map(|t| t.phase.as_str());
        if self.just_closed {
            self.just_closed = false;
            self.log_stats("FINAL", &update, raw_phase);
        }
        self.log_stats("LIVE", &update, raw_phase);
        self.emit(log_hub, update);
    }

    fn terminal_update(&self) -> FusionUpdate {
        let (snapshot, lanes) = self.stream_view();
        let mut update = self.build_update(snapshot.as_ref(), &lanes, Instant::now());
        update.engine_state = EngineState::Ready;
        update.phase = InferencePhase::Idle;
        update.lp_phase = InferencePhase::Idle;
        update.request_closed = true;
        update
    }

    pub(crate) fn spawn(
        log_hub: LogHub,
        config: FusionConfig,
    ) -> (tokio::task::JoinHandle<()>, tokio_util::sync::CancellationToken) {
        let cancel = tokio_util::sync::CancellationToken::new();
        let cancel_spawn = cancel.clone();
        // JoinHandle (not AbortOnDrop): app exit must cancel+await cleanly.
        let join = tokio::spawn(async move {
            Self::run(log_hub, config, cancel_spawn).await;
        });
        (join, cancel)
    }

    async fn run(
        log_hub: LogHub,
        config: FusionConfig,
        cancel: tokio_util::sync::CancellationToken,
    ) {
        let mut brain = Self::new(&config);
        // Paint the idle glass immediately; the engine is already loaded when this starts.
        let (snapshot, lanes) = brain.stream_view();
        let init = brain.build_update(snapshot.as_ref(), &lanes, Instant::now());
        brain.emit(&log_hub, init);

        let mut tick = tokio::time::interval(Duration::from_millis(render_tick_ms()));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    if !FUSION_SHUTTING_DOWN.load(std::sync::atomic::Ordering::Acquire)
                        && !crate::app_lifecycle::is_shutting_down()
                    {
                        let term = brain.terminal_update();
                        brain.emit(&log_hub, term);
                    }
                    return;
                }
                _ = tick.tick() => brain.tick(&log_hub),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(parallel: i64) -> FusionConfig {
        FusionConfig {
            alias: "sse".into(),
            slot_idx: 0,
            port: 9998,
            ctx_total: 65536,
            parallel,
            unified_kv: true,
            provider_id: "ggml-master".into(),
            adapter: crate::fusion::adapters::FusionAdapterId::GgmlMaster,
            has_log_belt: true,
        }
    }

    #[test]
    fn pp_progress_fields_are_emitted_during_prefill() {
        // Real frame shapes from the telemetry patch: one PP state, then prompt_progress.
        let port = 9997;
        let mut brain = SseBrain::new(&FusionConfig {
            port,
            parallel: 16,
            ..config(16)
        });
        crate::engine_events::note_engine_line(
            port,
            "0.00.000.000 I slot operator (): id  0 | task 1 | new prompt, n_ctx_slot = 4096",
        );
        crate::engine_events::ingest_for_test(
            port,
            concat!(
                "data: {\"type\":\"state\",\"slot\":0,\"phase\":\"PP\",\"busy\":1,\"peak\":1,\"n_ctx\":4096,\"n_ctx_used\":0,\"seq\":1}\n\n",
                "data: {\"type\":\"prompt_progress\",\"slot\":0,\"total\":4096,\"cache\":0,\"processed\":512,\"time_ms\":128.4,\"seq\":2}\n\n",
                "data: {\"type\":\"prompt_progress\",\"slot\":0,\"total\":4096,\"cache\":0,\"processed\":2048,\"time_ms\":401.2,\"seq\":3}\n\n"
            ),
        );

        let t = crate::engine_events::snapshot(port).expect("snapshot");
        let now = Instant::now();
        brain.observe(Some(&t), &[], now);
        let update = brain.build_update(Some(&t), &[], now);

        assert_eq!(update.phase, InferencePhase::PP);
        assert_eq!(update.prefill_tokens, 2048, "processed tokens drive the bar");
        assert_eq!(update.prefill_tokens_total, 4096, "task size must be present");
        assert!(
            (update.prefill_progress - 0.5).abs() < 1e-9,
            "progress = processed / total, got {}",
            update.prefill_progress
        );
        assert!(
            update.prefill_tps_session > 0.0,
            "the PP hero rate comes from the same frame"
        );
        assert!(
            update.prefill_tps_real > 0.0,
            "REAL PP is live while the request prefills"
        );

        // The request ends: `prompt_ms` includes a checkpoint copy. The copy is measured from
        // the engine log: the last frame (401.2 ms of task time) then a save completing at
        // 701.2 ms -> 300 ms of copy that REAL PP must add back.
        crate::engine_events::note_engine_line(
            port,
            "0.00.701.200 I slot create_check: id  0 | task 1 | created context checkpoint 1 of 32 (pos_min = 2044, pos_max = 2044, n_tokens = 2045, size = 112.571 MiB)",
        );

        crate::engine_events::ingest_for_test(
            port,
            concat!(
                "data: {\"type\":\"request_end\",\"slot\":0,\"task\":1,\"prompt_ms\":2440.0,\"predicted_ms\":1.0,\"tokens_evaluated\":16223,\"tokens_predicted\":1,\"cache_hit_tokens\":0,\"spec_accepted\":0,\"spec_draft\":0,\"lib_prompt_ms\":2286.49,\"lib_tokens_evaluated\":16223,\"seq\":4}\n\n",
                "data: {\"type\":\"state\",\"slot\":0,\"phase\":\"IDLE\",\"busy\":0,\"peak\":1,\"n_ctx\":4096,\"n_ctx_used\":16223,\"seq\":5}\n\n"
            ),
        );
        let t = crate::engine_events::snapshot(port).expect("snapshot");
        assert!(
            (t.last_request.as_ref().unwrap().checkpoint_ms - 300.0).abs() < 0.01,
            "checkpoint clock must be attached to the request summary"
        );
        let lanes = crate::engine_events::lanes(port);
        brain.observe(Some(&t), &lanes, now);
        let closed = brain.build_update(Some(&t), &lanes, now);

        assert!(
            closed.request_closed,
            "request_end must close the request"
        );
        let want = crate::fusion::meter::real_prefill_tps(16223, 2440.0, 300.0);
        assert!(
            (closed.prefill_tps_real - want).abs() < 1.0,
            "REAL PP = tokens / (prompt_ms - copy_ms), got {} want {}",
            closed.prefill_tps_real,
            want
        );
        assert!(
            closed.prefill_tps_real > closed.prefill_tps_session,
            "slot PP includes the copy and must sit below REAL PP"
        );
        assert!(
            (closed.prefill_tps_engine - crate::fusion::meter::engine_prefill_tps(16223, 2440.0))
                .abs()
                < 0.01,
            "ENGINE is exactly tokens / prompt_ms, got {}",
            closed.prefill_tps_engine
        );
        assert!(
            closed.prefill_tps_engine < closed.prefill_tps_real,
            "engine figure includes the copy"
        );
    }

    #[test]
    fn stream_phase_maps_wait_to_idle() {
        assert_eq!(stream_phase("PP"), InferencePhase::PP);
        assert_eq!(stream_phase("TG"), InferencePhase::Tg);
        assert_eq!(stream_phase("IDLE"), InferencePhase::Idle);
        assert_eq!(stream_phase("WAIT"), InferencePhase::Idle);
        assert_eq!(stream_phase(""), InferencePhase::Idle);
    }

    #[test]
    fn wave_avg_needs_the_last_lane_and_the_floor() {
        let mut brain = SseBrain::new(&config(16));
        brain.begin_request();
        brain.request_tokens = 4000;
        // No wave clock yet: the last lane has not decoded.
        assert_eq!(brain.avg_tps(Instant::now()), 0.0);
        // Wave open, but under the 500 ms floor: still zero.
        brain.wave_start = Some(Instant::now());
        assert_eq!(brain.avg_tps(Instant::now()), 0.0);
        // Past the floor: tokens ÷ wall since the last-lane start.
        brain.wave_start = Some(Instant::now() - Duration::from_millis(2000));
        let tps = brain.avg_tps(Instant::now());
        assert!((tps - 2000.0).abs() < 100.0, "got {tps}");
    }

    #[test]
    fn solo_close_pins_last_gen_and_parallel_close_pins_peak() {
        // Solo: the pin is the live rate.
        let mut solo = SseBrain::new(&config(1));
        solo.begin_request();
        solo.request_tokens = 4096;
        solo.req.last_gen_tps = 640.0;
        solo.close_request();
        assert_eq!(solo.req.frozen_request_gen_tps, 640.0);
        assert!(solo.req.request_closed);
        assert_eq!(solo.engine_state, EngineState::Ready);

        // Parallel: the wave peak wins over the drained last value.
        let mut par = SseBrain::new(&config(16));
        par.begin_request();
        par.request_tokens = 32000;
        par.peak_wave = 16;
        par.request_peak_tps = 1720.0;
        par.req.last_gen_tps = 1400.0;
        par.close_request();
        assert_eq!(par.req.frozen_request_gen_tps, 1720.0);
        assert_eq!(par.req.frozen_concurrent_slots, 16);
    }

    #[test]
    fn gen_tokens_session_accumulates_once_per_request() {
        let mut brain = SseBrain::new(&config(1));
        brain.begin_request();
        brain.request_tokens = 1000;
        brain.close_request();
        brain.begin_request();
        brain.request_tokens = 500;
        brain.close_request();
        assert_eq!(brain.session_tokens, 1500);
    }
}

