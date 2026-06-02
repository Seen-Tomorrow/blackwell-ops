//! Fusion Brain — state machine that fuses /slots + /metrics data streams.
//! Emits curated FusionUpdate to frontend via "fusion-update" Tauri event.
//!
//! One brain instance per engine, keyed by slot_idx.

use serde::Serialize;
use std::collections::HashMap;
use std::time::Instant;

use crate::log_hub::LogHub;
use crate::fusion_poller::{self, MetricsSnapshot};

// ── Configuration (immutable after construction) ─────────────────────

#[derive(Clone)]
pub struct FusionConfig {
    pub alias: String,
    pub slot_idx: usize,
    pub port: u16,
    pub ctx_total: usize,
    pub parallel: i64,
    pub unified_kv: bool,
}

// ── Phase state machine ──────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum InferencePhase {
    Idle,
    Pp,  // Prompt Processing (prefill)
    Tg,  // Token Generation
}

// ── Engine lifecycle state ───────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EngineState {
    Loading,
    Ready,
    Active,
}

// ── Per-slot tracking state (from /slots polling) ────────────────────

struct SlotTrackState {
    prev_n_decoded: usize,
    session_n_decoded: usize,
    prev_timestamp: Instant,
    request_start_n_decoded: usize,
    was_processing: bool,
    total_tokens_lifetime: usize,
}

impl SlotTrackState {
    fn new() -> Self {
        Self {
            prev_n_decoded: 0,
            session_n_decoded: 0,
            prev_timestamp: Instant::now(),
            request_start_n_decoded: 0,
            was_processing: false,
            total_tokens_lifetime: 0,
        }
    }
}

// ── Per-slot CTX info emitted to frontend ────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct SlotCtxInfo {
    pub id: usize,
    pub n_decoded: usize,
    #[serde(rename = "sessionNDecoded")]
    pub session_n_decoded: usize,
    #[serde(rename = "totalTokensLifetime")]
    pub total_tokens_lifetime: usize,
    pub is_processing: bool,
}

// ── FusionUpdate — curated data structure for frontend subscribers ───

#[derive(Debug, Clone, Serialize)]
pub struct FusionUpdate {
    pub alias: String,
    #[serde(rename = "slotIdx")]
    pub slot_idx: usize,
    pub port: u16,

    // Lifecycle (3 states)
    pub engine_state: EngineState,

    // Phase — fused from both sources
    pub phase: InferencePhase,

    // ── Prefill metrics (primary source = /metrics) ────────────────
    #[serde(rename = "prefillTpsMetrics")]
    pub prefill_tps_metrics: f64,
    #[serde(rename = "prefillTpsSlots")]
    pub prefill_tps_slots: f64,

    // ── Generation metrics (both sources side by side) ─────────────
    #[serde(rename = "genTpsMetrics")]
    pub gen_tps_metrics: f64,
    #[serde(rename = "genTpsSlots")]
    pub gen_tps_slots: f64,

    #[serde(rename = "genTokensPerRequestMetrics")]
    pub gen_tokens_per_request_metrics: usize,
    #[serde(rename = "genTokensPerRequestSlots")]
    pub gen_tokens_per_request_slots: usize,

    // Combined session total (both sources agree)
    #[serde(rename = "genTokensPerSession")]
    pub gen_tokens_per_session: usize,

    // ── Context usage (primary source = /slots only) ───────────────
    #[serde(rename = "ctxUsedCurrentRequest")]
    pub ctx_used_current_request: usize,
    #[serde(rename = "ctxUsedSession")]
    pub ctx_used_session: usize,
    #[serde(rename = "ctxFillPct")]
    pub ctx_fill_pct: f64,
    #[serde(rename = "ctxTotal")]
    pub ctx_total: usize,

    // ── Request timing ─────────────────────────────────────────────
    #[serde(rename = "requestElapsedMs")]
    pub request_elapsed_ms: u64,
    #[serde(rename = "ttftMs", skip_serializing_if = "Option::is_none")]
    pub ttft_ms: Option<f64>,

    // ── Per-slot CTX bars (from /slots only) ───────────────────────
    #[serde(rename = "slotCtx")]
    pub slot_ctx: Vec<SlotCtxInfo>,

    // ── Engine config ──────────────────────────────────────────────
    pub parallel: i64,
    pub unified_kv: bool,

    // ── Log-parsed values (stderr print_timing lines — red in UI for comparison) ──
    #[serde(rename = "LP_prefillProgress")]
    pub lp_prefill_progress: f64,       // exact 0→1 from "prompt processing, progress = X.XX"

    #[serde(rename = "LP_prefillTps")]
    pub lp_prefill_tps: f64,            // instantaneous tokens/s during PP (engine's own calc)

    #[serde(rename = "LP_promptTokens")]
    pub lp_prompt_tokens: usize,        // n_tokens processed so far in current PP request

    #[serde(rename = "LP_genTps")]
    pub lp_gen_tps: f64,               // tg = X t/s from generation print_timing line

    #[serde(rename = "LP_phase")]
    pub lp_phase: InferencePhase,       // phase derived purely from log events (PP→TG via sampler_init)

    /// Reset source for frontend visual feedback — "prompt" if NewPrompt caught it, "regression" if fallback.
    #[serde(rename = "LP_resetSource", skip_serializing_if = "Option::is_none")]
    pub lp_reset_source: Option<&'static str>,  // Some("prompt") or Some("regression")
}

// ── Brain internal state ─────────────────────────────────────────────

pub struct FusionBrain {
    alias: String,
    slot_idx: usize,
    port: u16,
    ctx_total: usize,
    parallel: i64,
    unified_kv: bool,
    phase: InferencePhase,
    engine_state: EngineState,
    request_start: Option<Instant>,
    prompt_tokens: usize,
    prefill_tps: f64,
    ttft_ms: Option<f64>,
    slot_states: HashMap<usize, SlotTrackState>,
    session_tokens_generated: usize,
    prev_metrics: Option<MetricsSnapshot>,
    prev_metrics_time: Option<Instant>,

    // ── Cumulative TG TPS tracking (accurate from first token) ───────
    tg_start_time: Option<Instant>,
    tg_start_n_decoded: usize,

    // ── Log-parsed tracking fields ────────────────────────────────
    lp_prefill_progress: f64,       // exact 0→1 from print_timing PP line
    lp_prefill_tps: f64,            // instantaneous tokens/s during PP (from log)
    lp_prompt_tokens: usize,        // n_tokens processed so far in current request (PP)
    lp_gen_tps: f64,               // tg = X t/s from generation print_timing line
    lp_phase: InferencePhase,       // phase derived purely from log events

    /// One-shot reset signal emitted to frontend for visual feedback.
    lp_reset_prompt: bool,    // true after NewPrompt caught the start (belt)
    lp_reset_regression: bool,  // true after regression detected (suspenders)
}

impl FusionBrain {
    pub fn new(config: &FusionConfig) -> Self {
        Self {
            alias: config.alias.clone(),
            slot_idx: config.slot_idx,
            port: config.port,
            ctx_total: config.ctx_total,
            parallel: config.parallel,
            unified_kv: config.unified_kv,
            phase: InferencePhase::Idle,
            engine_state: EngineState::Loading,
            request_start: None,
            prompt_tokens: 0,
            prefill_tps: 0.0,
            ttft_ms: None,
            slot_states: HashMap::new(),
            session_tokens_generated: 0,
            prev_metrics: None,
            prev_metrics_time: None,

            // Cumulative TG TPS tracking
            tg_start_time: None,
            tg_start_n_decoded: 0,

            // Log-parsed fields — initialized to zero/Idle
            lp_prefill_progress: 0.0,
            lp_prefill_tps: 0.0,
            lp_prompt_tokens: 0,
            lp_gen_tps: 0.0,
            lp_phase: InferencePhase::Idle,
            lp_reset_prompt: false,
            lp_reset_regression: false,
        }
    }

    // ── Public spawn API ────────────────────────────────────────────

    pub fn spawn(
        log_hub: LogHub,
        config: FusionConfig,
    ) -> (tokio_util::task::AbortOnDropHandle<()>, tokio_util::sync::CancellationToken) {
        let cancel = tokio_util::sync::CancellationToken::new();
        let cancel_spawn = cancel.clone();

        eprintln!(
            "[FUSION] Starting brain: alias={} slot={} port={} ctx_total={}",
            config.alias, config.slot_idx, config.port, config.ctx_total
        );

        let handle = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
            Self::run(log_hub, config, cancel_spawn).await;
        }));

        (handle, cancel)
    }

    // ── Main loop ───────────────────────────────────────────────────

    async fn run(
        log_hub: LogHub,
        config: FusionConfig,
        cancel: tokio_util::sync::CancellationToken,
    ) {
        let mut brain = Self::new(&config);

        // Channel for parsed log events from stderr → this brain task (bounded to backpressure on slow consumer)
        let (event_tx, mut event_rx) = tokio::sync::mpsc::channel::<crate::fusion_logparser::LogEvent>(256);
        register_log_receiver(config.slot_idx, event_tx);

        // Emit initial LOADING update so frontend shows launch animation
        let init = brain.build_update(&[], None);
        log_hub.emit("fusion-update", &init);

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(1500))
            .build()
            .unwrap_or_default();

        let poll_interval = tokio::time::Duration::from_millis(200);
        let mut interval = tokio::time::interval(poll_interval);

        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    eprintln!("[FUSION] slot={} cancelled, emitting terminal update", brain.slot_idx);
                    let term = brain.build_terminal_update();
                    log_hub.emit("fusion-update", &term);
                    return;
                }

                // ── Log-parsed event (stderr print_timing lines) ─────
                Some(log_event) = event_rx.recv() => {
                    brain.process_log_event(&log_event);
                    let update = brain.build_update(&[], None);
                    log_hub.emit("fusion-update", &update);
                }

                _ = interval.tick() => {
                    let slots_fut = fusion_poller::poll_slots(&client, brain.port);
                    let metrics_fut = fusion_poller::poll_metrics(&client, brain.port);
                    let (slots_result, metrics_result) = tokio::join!(slots_fut, metrics_fut);

                    // Process /metrics first for phase detection
                    if let Ok(ref metrics) = metrics_result {
                        brain.process_metrics(metrics);
                    }

                    // Process /slots for token counts and per-slot data
                    let slot_data: Vec<fusion_poller::SlotData> = match slots_result {
                        Ok(slots) => slots,
                        Err(e) => {
                            if brain.engine_state == EngineState::Loading {
                                let update = brain.build_update(&[], metrics_result.as_ref().ok());
                                log_hub.emit("fusion-update", &update);
                            } else {
                                eprintln!("[FUSION] slot={} /slots poll error: {}", brain.slot_idx, e);
                            }
                            continue;
                        }
                    };

                    brain.process_slots(&slot_data);

                    let update = brain.build_update(&slot_data, metrics_result.as_ref().ok());
                    log_hub.emit("fusion-update", &update);
                }
            }
        }
    }

    // ── Log-parsed event handlers (stderr print_timing lines) ───────

    fn process_log_event(&mut self, event: &crate::fusion_logparser::LogEvent) {
        match event {
            crate::fusion_logparser::LogEvent::PrintTimingPP { .. } => self.handle_print_timing_pp(event),
            crate::fusion_logparser::LogEvent::PrintTimingGen { .. } => self.handle_print_timing_gen(event),
            crate::fusion_logparser::LogEvent::SamplerInit { .. } => self.handle_sampler_init(),
            crate::fusion_logparser::LogEvent::StopProcessing { .. } => self.handle_stop_processing(),
            // NewPrompt — belt: reset all LP state at exact request start (fires before any PP work)
            crate::fusion_logparser::LogEvent::NewPrompt { .. } => self.handle_new_prompt(),
        }
    }

    fn handle_new_prompt(&mut self) {
        // Belt: definitive request start — reset LP state to zero so progress bar starts at 0%
        eprintln!("[LP] NewPrompt detected, resetting LP state");
        self.lp_phase = InferencePhase::Idle;
        self.lp_prefill_progress = 0.0;
        self.lp_prefill_tps = 0.0;
        self.lp_prompt_tokens = 0;
        self.lp_gen_tps = 0.0;
        self.lp_reset_prompt = true; // Belt caught the start
        self.lp_reset_regression = false;
    }

    fn handle_print_timing_pp(&mut self, e: &crate::fusion_logparser::LogEvent) {
        if let crate::fusion_logparser::LogEvent::PrintTimingPP { n_tokens, progress, pp_tps, .. } = e {
            // Suspenders: regression detection — if new progress < previous (missed start), reset first
            if *progress > 0.0 && *progress < self.lp_prefill_progress && self.lp_prefill_progress > 0.1 {
                eprintln!("[LP] Regression detected ({:.2} → {:.2}), resetting LP state", self.lp_prefill_progress, progress);
                self.lp_prefill_progress = 0.0;
                self.lp_prefill_tps = 0.0;
                self.lp_prompt_tokens = 0;
                self.lp_reset_regression = true; // Suspenders caught the regression
                self.lp_reset_prompt = false;
            }

            self.lp_phase = InferencePhase::Pp;
            self.lp_prefill_progress = *progress;
            self.lp_prefill_tps = *pp_tps;
            self.lp_prompt_tokens = *n_tokens;
        }
    }

    fn handle_print_timing_gen(&mut self, e: &crate::fusion_logparser::LogEvent) {
        if let crate::fusion_logparser::LogEvent::PrintTimingGen { gen_tps, .. } = e {
            self.lp_phase = InferencePhase::Tg;
            self.lp_gen_tps = *gen_tps;
        }
    }

    fn handle_sampler_init(&mut self) {
        // DEFINITIVE PP→TG boundary signal from engine
        self.lp_phase = InferencePhase::Tg;
    }

    fn handle_stop_processing(&mut self) {
        self.lp_phase = InferencePhase::Idle;
        self.lp_prefill_progress = 0.0;
        self.lp_prefill_tps = 0.0;
        self.lp_prompt_tokens = 0;
        // NOTE: lp_gen_tps intentionally NOT reset — keep "last known" TG speed visible after request ends
        self.lp_reset_prompt = false;
        self.lp_reset_regression = false;
    }

    // ── /metrics processing — phase detection + prefill TPS ─────────

    fn process_metrics(&mut self, metrics: &MetricsSnapshot) {
        let now = Instant::now();

        // Extract decisions from prev_metrics BEFORE mutating self
        let (request_ended, new_request_started, pt_delta, ps_delta, tt_delta, dt_sec) =
            if let Some(ref prev) = self.prev_metrics {
                let was_active = prev.requests_processing > 0;
                let is_active = metrics.requests_processing > 0;

                let request_ended = was_active && !is_active;
                let new_request_started = !was_active && is_active;

                let pt_delta = metrics.prompt_tokens_total.saturating_sub(prev.prompt_tokens_total);
                let ps_delta = metrics.prompt_seconds_total - prev.prompt_seconds_total;
                let tt_delta = metrics.predicted_tokens_total.saturating_sub(prev.predicted_tokens_total);

                let dt_sec = if let Some(t) = self.prev_metrics_time {
                    now.duration_since(t).as_secs_f64()
                } else {
                    0.0
                };

                (request_ended, new_request_started, pt_delta, ps_delta, tt_delta, dt_sec)
            } else {
                (false, false, 0, 0.0, 0, 0.0)
            };

        // Now safe to mutate self — prev_metrics borrow is dropped
        if new_request_started {
            self.phase = InferencePhase::Pp;
            self.request_start = Some(now);
            self.engine_state = EngineState::Active;
            self.ttft_ms = None;
        } else if request_ended {
            self.phase = InferencePhase::Idle;
            self.request_start = None;
            self.prompt_tokens = 0;
            self.ttft_ms = None;
        }

        // Prefill TPS from prompt_tokens_total delta
        if pt_delta > 0 && dt_sec > 0.01 {
            self.prefill_tps = pt_delta as f64 / dt_sec;

            if pt_delta > self.prompt_tokens {
                self.prompt_tokens = pt_delta;
            }
        }

        // PP→TG transition detection from /metrics — capture TTFT + TG start snapshot
        if self.phase == InferencePhase::Pp && tt_delta > 0 {
            self.phase = InferencePhase::Tg;
            // Capture TTFT: time from request start to first generated token
            if self.ttft_ms.is_none() {
                if let Some(start) = self.request_start {
                    self.ttft_ms = Some(start.elapsed().as_millis() as f64);
                }
            }
            if self.tg_start_time.is_none() {
                self.tg_start_time = Some(now);
                // tg_start_n_decoded will be set on next /slots poll (total_n_decoded at that point)
                self.tg_start_n_decoded = 0;
            }
        }

        // Store current snapshot for next delta computation
        self.prev_metrics = Some(metrics.clone());
        self.prev_metrics_time = Some(now);
    }

    // ── /slots processing — token counts, per-slot tracking ─────────

    fn process_slots(&mut self, slots: &[fusion_poller::SlotData]) {
        let now = Instant::now();
        let mut any_processing = false;

        // First pass: compute decisions without mutating slot_states
        struct SlotDecision {
            id: usize,
            n_decoded: usize,
            is_proc: bool,
            new_request: bool,
            ended_session: bool,
            request_tokens_on_end: usize,
        }

        let mut decisions: Vec<SlotDecision> = Vec::new();

        for slot in slots {
            let has_token_data = !slot.next_token.is_empty();
            let is_proc = slot.is_processing;

            if is_proc {
                any_processing = true;
            }

            if has_token_data {
                let n_decoded = slot.next_token[0].n_decoded;
                let s = self.slot_states.entry(slot.id).or_insert_with(SlotTrackState::new);

                let new_request = is_proc && !s.was_processing;
                let ended_session = !is_proc && s.was_processing;
                let request_tokens_on_end = if ended_session {
                    n_decoded.saturating_sub(s.request_start_n_decoded)
                } else {
                    0
                };

                decisions.push(SlotDecision {
                    id: slot.id,
                    n_decoded,
                    is_proc,
                    new_request,
                    ended_session,
                    request_tokens_on_end,
                });
            } else {
                let s = self.slot_states.entry(slot.id).or_insert_with(SlotTrackState::new);
                let ended_session = !is_proc && s.was_processing;

                decisions.push(SlotDecision {
                    id: slot.id,
                    n_decoded: 0,
                    is_proc: false,
                    new_request: false,
                    ended_session,
                    request_tokens_on_end: 0,
                });
            }
        }

        // Second pass: apply decisions — safe to mutate self now
        for d in &decisions {
            if d.new_request {
                if let Some(s) = self.slot_states.get_mut(&d.id) {
                    s.request_start_n_decoded = d.n_decoded;
                }
                self.phase = InferencePhase::Pp;
                self.request_start = Some(now);
                self.engine_state = EngineState::Active;
                // Reset TG TPS tracking for new request
                self.tg_start_time = None;
                self.tg_start_n_decoded = 0;
                self.ttft_ms = None;
            }

            if d.ended_session {
                if let Some(s) = self.slot_states.get_mut(&d.id) {
                    s.total_tokens_lifetime += d.request_tokens_on_end;
                }
                self.session_tokens_generated += d.request_tokens_on_end;
                self.phase = InferencePhase::Idle;
                self.request_start = None;
                self.prompt_tokens = 0;
                // Reset TG TPS tracking for ended session
                self.tg_start_time = None;
                self.tg_start_n_decoded = 0;
                self.ttft_ms = None;
            }

            // Update slot state — accumulate session_n_decoded (smooth real-time fill)
            if let Some(s) = self.slot_states.get_mut(&d.id) {
                let prev = s.prev_n_decoded;
                let new_val = d.n_decoded;
                // Only add delta when n_decoded increases — don't subtract on request reset
                if new_val > prev {
                    s.session_n_decoded += new_val - prev;
                }
                // Snap-correct at request end: trust total_tokens_lifetime as ground truth
                if d.ended_session && s.total_tokens_lifetime > s.session_n_decoded {
                    s.session_n_decoded = s.total_tokens_lifetime;
                }
                s.prev_n_decoded = new_val;
                s.prev_timestamp = now;
                s.was_processing = d.is_proc;
            }
        }

        // Update engine state from /slots
        if self.engine_state == EngineState::Loading && !any_processing {
            self.engine_state = EngineState::Ready;
            eprintln!("[FUSION] slot={} engine READY", self.slot_idx);
        } else if any_processing && self.engine_state != EngineState::Active {
            self.engine_state = EngineState::Active;
        } else if !any_processing && self.engine_state == EngineState::Active {
            if let Some(ref m) = self.prev_metrics {
                if m.requests_processing == 0 {
                    self.engine_state = EngineState::Ready;
                }
            }
        }

        // Phase fallback from /slots: per-request n_decoded delta > 50 means TG, not PP
        for slot in slots {
            if slot.is_processing && !slot.next_token.is_empty() {
                let n_decoded = slot.next_token[0].n_decoded;
                if let Some(s) = self.slot_states.get(&slot.id) {
                    let delta = n_decoded.saturating_sub(s.request_start_n_decoded);
                    if delta > 50 && self.phase == InferencePhase::Pp {
                        self.phase = InferencePhase::Tg;
                        // Capture TTFT: time from request start to first generated token
                        if self.ttft_ms.is_none() {
                            if let Some(start) = self.request_start {
                                self.ttft_ms = Some(start.elapsed().as_millis() as f64);
                            }
                        }
                        // Capture TG start snapshot for cumulative TPS calculation
                        if self.tg_start_time.is_none() {
                            let mut total_at_transition: usize = 0;
                            for sl in slots {
                                if !sl.next_token.is_empty() {
                                    total_at_transition += sl.next_token[0].n_decoded;
                                }
                            }
                            self.tg_start_n_decoded = total_at_transition;
                            self.tg_start_time = Some(now);
                        }
                    }
                }
            }
        }

        // Also handle PP→TG transition from /metrics (line 446-448) — capture snapshot there too
        if self.phase == InferencePhase::Tg && self.tg_start_time.is_none() {
            let mut total_at_transition: usize = 0;
            for slot in slots {
                if !slot.next_token.is_empty() {
                    total_at_transition += slot.next_token[0].n_decoded;
                }
            }
            self.tg_start_n_decoded = total_at_transition;
            self.tg_start_time = Some(now);
        }

    }

    // ── Build FusionUpdate from current state + fresh poll data ─────

    fn build_update(
        &self,
        slots: &[fusion_poller::SlotData],
        metrics: Option<&MetricsSnapshot>,
    ) -> FusionUpdate {
        // Compute total n_decoded across all slots
        let mut total_n_decoded: usize = 0;
        for slot in slots {
            if !slot.next_token.is_empty() {
                total_n_decoded += slot.next_token[0].n_decoded;
            }
        }

        // Gen TPS from /slots: cumulative average since TG started (accurate immediately, no ramp-up)
        let gen_tps_slots = if self.phase == InferencePhase::Tg {
            if let Some(start) = self.tg_start_time {
                let elapsed_ms = start.elapsed().as_millis() as u64;
                if elapsed_ms > 100 {
                    let tokens_generated = total_n_decoded.saturating_sub(self.tg_start_n_decoded);
                    (tokens_generated as f64) / (elapsed_ms as f64 / 1000.0)
                } else {
                    0.0
                }
            } else {
                0.0
            }
        } else {
            0.0
        };

        // Gen TPS from /metrics gauge
        let gen_tps_metrics = metrics.map(|m| m.predicted_tps_gauge).unwrap_or(0.0);

        // Per-request tokens: sum of (n_decoded - request_start_n_decoded) across slots
        let mut gen_tokens_request_slots: usize = 0;
        for slot in slots {
            if !slot.next_token.is_empty() {
                let n_decoded = slot.next_token[0].n_decoded;
                if let Some(s) = self.slot_states.get(&slot.id) {
                    gen_tokens_request_slots += n_decoded.saturating_sub(s.request_start_n_decoded);
                }
            }
        }

        let gen_tokens_request_metrics = if let Some(m) = metrics {
            if let Some(ref prev) = self.prev_metrics {
                m.predicted_tokens_total.saturating_sub(prev.predicted_tokens_total)
                    + self.session_tokens_generated
            } else {
                m.predicted_tokens_total
            }
        } else {
            0
        };

        // Prefill TPS from /metrics gauge
        let prefill_tps_metrics = metrics.map(|m| m.prompt_tps_gauge).unwrap_or(0.0);

        // Context usage
        let ctx_used_session = total_n_decoded;
        let ctx_fill_pct = if self.ctx_total > 0 {
            (ctx_used_session as f64 / self.ctx_total as f64) * 100.0
        } else {
            0.0
        };

        // Request elapsed time
        let request_elapsed_ms = self
            .request_start
            .map(|start| start.elapsed().as_millis() as u64)
            .unwrap_or(0);

        // Per-slot CTX info for bars
        let mut slot_ctx: Vec<SlotCtxInfo> = self.slot_states.iter()
            .map(|(id, s)| SlotCtxInfo {
                id: *id,
                n_decoded: s.prev_n_decoded,
                session_n_decoded: s.session_n_decoded,
                total_tokens_lifetime: s.total_tokens_lifetime,
                is_processing: s.was_processing,
            })
            .collect();
        slot_ctx.sort_by_key(|s| s.id);

        FusionUpdate {
            alias: self.alias.clone(),
            slot_idx: self.slot_idx,
            port: self.port,
            engine_state: self.engine_state.clone(),
            phase: self.phase,
            prefill_tps_metrics,
            prefill_tps_slots: 0.0,
            gen_tps_metrics,
            gen_tps_slots,
            gen_tokens_per_request_metrics: gen_tokens_request_metrics,
            gen_tokens_per_request_slots: gen_tokens_request_slots,
            gen_tokens_per_session: self.session_tokens_generated,
            ctx_used_current_request: total_n_decoded,
            ctx_used_session: ctx_used_session,
            ctx_fill_pct,
            ctx_total: self.ctx_total,
            request_elapsed_ms,
            ttft_ms: self.ttft_ms,
            slot_ctx,
            parallel: self.parallel,
            unified_kv: self.unified_kv,

            // ── Log-parsed values (from stderr print_timing lines) ──
            lp_prefill_progress: self.lp_prefill_progress,
            lp_prefill_tps: self.lp_prefill_tps,
            lp_prompt_tokens: self.lp_prompt_tokens,
            lp_gen_tps: self.lp_gen_tps,
            lp_phase: self.lp_phase,
            lp_reset_source: if self.lp_reset_prompt {
                Some("prompt")
            } else if self.lp_reset_regression {
                Some("regression")
            } else {
                None
            },
        }
    }

    // ── Terminal update (engine stopped) ────────────────────────────

    fn build_terminal_update(&self) -> FusionUpdate {
        let mut update = self.build_update(&[], None);
        update.engine_state = EngineState::Ready;
        update.phase = InferencePhase::Idle;
        update.lp_phase = InferencePhase::Idle;
        update.lp_prefill_progress = 0.0;
        update.lp_prefill_tps = 0.0;
        update.lp_prompt_tokens = 0;
        update.lp_gen_tps = 0.0;
        // Note: lp_reset_source stays as computed by build_update above (shows last reset source)
        update
    }
}

// ── Fusion task registry (replaces old global FUSION_TASKS) ─────────

use tokio::sync::Mutex as TokioMutex;

static BRAIN_REGISTRY: std::sync::LazyLock<
    TokioMutex<HashMap<usize, (tokio_util::task::AbortOnDropHandle<()>, tokio_util::sync::CancellationToken)>>,
> = std::sync::LazyLock::new(|| TokioMutex::new(HashMap::new()));

/// Registry of log event senders — keyed by slot_idx.
/// Uses parking_lot Mutex so .lock() is safe inside both blocking & async contexts.
static LOG_EVENT_SENDERS: std::sync::LazyLock<
    parking_lot::Mutex<HashMap<usize, tokio::sync::mpsc::Sender<crate::fusion_logparser::LogEvent>>>,
> = std::sync::LazyLock::new(|| parking_lot::Mutex::new(HashMap::new()));

/// Register this brain's log event receiver channel. Called from run() before polling starts.
pub fn register_log_receiver(slot_idx: usize, tx: tokio::sync::mpsc::Sender<crate::fusion_logparser::LogEvent>) {
    let mut registry = LOG_EVENT_SENDERS.lock();
    registry.insert(slot_idx, tx);
}

/// Route a parsed log event to the brain for the given slot (fire-and-forget, drops on full).
pub fn route_log_event(slot_idx: usize, event: crate::fusion_logparser::LogEvent) {
    let registry = LOG_EVENT_SENDERS.lock();
    if let Some(tx) = registry.get(&slot_idx) {
        let _ = tx.try_send(event); // bounded channel — drops on full (backpressure)
    }
}

/// Start a fusion brain for an engine. Keyed by slot_idx.
pub async fn start_brain(log_hub: LogHub, config: FusionConfig) {
    let mut registry = BRAIN_REGISTRY.lock().await;

    if let Some((_, cancel)) = registry.remove(&config.slot_idx) {
        cancel.cancel();
    }
    // Clear old log event sender so events between cancel and new register don't route to dead channel
    {
        let mut event_senders = LOG_EVENT_SENDERS.lock();
        event_senders.remove(&config.slot_idx);
    }

    let idx = config.slot_idx;
    let (handle, cancel) = FusionBrain::spawn(log_hub, config);
    registry.insert(idx, (handle, cancel));
}

/// Stop the fusion brain for a specific slot.
pub async fn stop_brain(slot_idx: usize) {
    let mut registry = BRAIN_REGISTRY.lock().await;
    if let Some((_, cancel)) = registry.remove(&slot_idx) {
        eprintln!("[FUSION] Stopping brain: slot={}", slot_idx);
        cancel.cancel();
    }
    // Also clean up log event sender channel for this slot
    {
        let mut event_senders = LOG_EVENT_SENDERS.lock();
        event_senders.remove(&slot_idx);
    }
}

/// Stop all fusion brains. Call on app shutdown.
pub async fn stop_all_brains() {
    let mut registry = BRAIN_REGISTRY.lock().await;
    for (slot_idx, (_, cancel)) in registry.drain() {
        eprintln!("[FUSION] Stopping brain: slot={}", slot_idx);
        cancel.cancel();
    }
    // Drain all log event channels too
    {
        let mut event_senders = LOG_EVENT_SENDERS.lock();
        event_senders.clear();
    }
}
