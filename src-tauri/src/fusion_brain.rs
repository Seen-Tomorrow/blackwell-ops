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
    prev_timestamp: Instant,
    request_start_n_decoded: usize,
    was_processing: bool,
    total_tokens_lifetime: usize,
}

impl SlotTrackState {
    fn new() -> Self {
        Self {
            prev_n_decoded: 0,
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
        } else if request_ended {
            self.phase = InferencePhase::Idle;
            self.request_start = None;
            self.prompt_tokens = 0;
        }

        // Prefill TPS from prompt_tokens_total delta
        if pt_delta > 0 && dt_sec > 0.01 {
            self.prefill_tps = pt_delta as f64 / dt_sec;

            let ps_d = ps_delta;
            if ps_d > 0.0 && pt_delta > 0 {
                self.ttft_ms = Some((ps_d / pt_delta as f64) * 1000.0);
            }

            if pt_delta > self.prompt_tokens {
                self.prompt_tokens = pt_delta;
            }
        }

        // PP→TG transition detection
        if self.phase == InferencePhase::Pp && tt_delta > 0 {
            self.phase = InferencePhase::Tg;
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
            }

            if d.ended_session {
                if let Some(s) = self.slot_states.get_mut(&d.id) {
                    s.total_tokens_lifetime += d.request_tokens_on_end;
                }
                self.session_tokens_generated += d.request_tokens_on_end;
                self.phase = InferencePhase::Idle;
                self.request_start = None;
                self.prompt_tokens = 0;
            }

            // Update slot state
            if let Some(s) = self.slot_states.get_mut(&d.id) {
                s.prev_n_decoded = d.n_decoded;
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
                    }
                }
            }
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

        // Gen TPS from /slots: cumulative tokens / elapsed time since request start
        let gen_tps_slots = if self.phase == InferencePhase::Tg && total_n_decoded > 0 {
            let elapsed_ms = self.request_start
                .map(|start| start.elapsed().as_millis() as u64)
                .unwrap_or(0);
            if elapsed_ms > 100 {
                (total_n_decoded as f64) / (elapsed_ms as f64 / 1000.0)
            } else {
                0.0
            }
        } else {
            0.0
        };

        // Gen TPS from /metrics gauge
        let gen_tps_metrics = metrics.map(|m| m.predicted_tps_gauge).unwrap_or(0.0);

        // Gen tokens per request from both sources
        let gen_tokens_request_slots = total_n_decoded;

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
        }
    }

    // ── Terminal update (engine stopped) ────────────────────────────

    fn build_terminal_update(&self) -> FusionUpdate {
        let mut update = self.build_update(&[], None);
        update.engine_state = EngineState::Ready;
        update.phase = InferencePhase::Idle;
        update
    }
}

// ── Fusion task registry (replaces old global FUSION_TASKS) ─────────

use tokio::sync::Mutex as TokioMutex;

static BRAIN_REGISTRY: std::sync::LazyLock<
    TokioMutex<HashMap<usize, (tokio_util::task::AbortOnDropHandle<()>, tokio_util::sync::CancellationToken)>>,
> = std::sync::LazyLock::new(|| TokioMutex::new(HashMap::new()));

/// Start a fusion brain for an engine. Keyed by slot_idx.
pub async fn start_brain(log_hub: LogHub, config: FusionConfig) {
    let mut registry = BRAIN_REGISTRY.lock().await;

    if let Some((_, cancel)) = registry.remove(&config.slot_idx) {
        cancel.cancel();
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
}

/// Stop all fusion brains. Call on app shutdown.
pub async fn stop_all_brains() {
    let mut registry = BRAIN_REGISTRY.lock().await;
    for (slot_idx, (_, cancel)) in registry.drain() {
        eprintln!("[FUSION] Stopping brain: slot={}", slot_idx);
        cancel.cancel();
    }
}
