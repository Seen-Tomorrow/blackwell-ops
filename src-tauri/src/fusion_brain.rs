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
    PP,  // Prompt Processing (prefill)
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
    // Current prompt snapshot (for prefill progress + accurate ctx fill including cached history)
    current_prompt_tokens: usize,
    current_prompt_processed: usize,
    current_prompt_cache: usize,
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
            current_prompt_tokens: 0,
            current_prompt_processed: 0,
            current_prompt_cache: 0,
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
    // Full context usage for this slot (n_prompt_tokens + n_decoded). Enables accurate "ctx fill" including prefill + cached history.
    #[serde(rename = "promptTokens")]
    pub prompt_tokens: usize,
    #[serde(rename = "promptTokensProcessed")]
    pub prompt_tokens_processed: usize,
    #[serde(rename = "promptTokensCache")]
    pub prompt_tokens_cache: usize,
    // Additional from full /slots (useful for UI: remaining budget in this request, task id, etc.)
    #[serde(rename = "nRemain")]
    pub n_remain: i64,
    #[serde(rename = "idTask", skip_serializing_if = "Option::is_none")]
    pub id_task: Option<i64>,
    #[serde(rename = "speculative")]
    pub speculative: bool,
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

    // ── Prefill metrics (primary source = /metrics for TPS; /slots for progress/tokens — log parser is secondary/debug) ────────────────
    #[serde(rename = "prefillTpsMetrics")]
    pub prefill_tps_metrics: f64,

    /// Primary prefill progress 0→1 computed from /slots (n_prompt_tokens_processed / n_prompt_tokens). Bypasses log throttle/miss issues.
    #[serde(rename = "prefillProgress")]
    pub prefill_progress: f64,
    /// n_prompt_tokens_processed from /slots for current request (real-time, no log dependency).
    #[serde(rename = "prefillTokens")]
    pub prefill_tokens: usize,
    /// Target prompt size for current request (from /slots n_prompt_tokens or NewPrompt log).
    #[serde(rename = "prefillTokensTotal")]
    pub prefill_tokens_total: usize,

    // ── Generation metrics (primary source = /slots) ─────────────
    #[serde(rename = "genTps")]
    pub gen_tps: f64,

    #[serde(rename = "genTokensPerRequestSlots")]
    pub gen_tokens_per_request_slots: usize,

    // Combined session total
    #[serde(rename = "genTokensPerSession")]
    pub gen_tokens_per_session: usize,

    // ── Context usage (primary source = /slots only) ───────────────
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
    #[serde(rename = "logPrefillProgress")]
    pub lp_prefill_progress: f64,       // exact 0→1 from "prompt processing, progress = X.XX"

    #[serde(rename = "logPrefillTps")]
    pub lp_prefill_tps: f64,            // instantaneous tokens/s during PP (engine's own calc)

    #[serde(rename = "logPromptTokens")]
    pub lp_prompt_tokens: usize,        // n_tokens processed so far in current PP request

    #[serde(rename = "logGenTps")]
    pub lp_gen_tps: f64,               // tg = X t/s from generation print_timing line

    #[serde(rename = "logPhase")]
    pub lp_phase: InferencePhase,       // phase derived purely from log events (PP→TG via sampler_init)

    /// Reset source indicator — "prompt" if NewPrompt caught request start (belt), "regression" if fallback detected (suspenders). Flashes for visual feedback then clears on next PP line.
    #[serde(rename = "phaseResetSource", skip_serializing_if = "Option::is_none")]
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
    last_gen_tps: f64,  // "last known" value — persists across phase transitions

    // ── Log-parsed tracking fields ────────────────────────────────
    lp_prefill_progress: f64,       // exact 0→1 from print_timing PP line
    lp_prefill_tps: f64,            // instantaneous tokens/s during PP (from log)
    lp_prompt_tokens: usize,        // n_tokens processed so far in current request (PP)
    lp_gen_tps: f64,               // tg = X t/s from generation print_timing line
    lp_phase: InferencePhase,       // phase derived purely from log events

    /// One-shot reset signal emitted to frontend for visual feedback.
    lp_reset_prompt: bool,    // true after NewPrompt caught the start (belt)
    lp_reset_regression: bool,  // true after regression detected (suspenders)

    /// Log-driven request boundaries (belt for phase — survives multimodal /slots lag).
    log_request_open: bool,
    log_prefill_done: bool,

    // ── Primary prefill from /slots (real-time, reliable) ─────────
    prefill_progress: f64,
    prefill_tokens: usize,
    /// Task prompt size (from NewPrompt log `task.n_tokens`). NOT /slots `n_prompt_tokens` (that is prompt.tokens.size()).
    prefill_tokens_total: usize,

    /// Throttle high-frequency `cached n_tokens` log lines (flood can starve the 256-cap event channel).
    last_cached_log_at: Option<Instant>,
    last_cached_log_tokens: usize,
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
            last_gen_tps: 0.0,

            // Log-parsed fields — initialized to zero/Idle
            lp_prefill_progress: 0.0,
            lp_prefill_tps: 0.0,
            lp_prompt_tokens: 0,
            lp_gen_tps: 0.0,
            lp_phase: InferencePhase::Idle,
            lp_reset_prompt: false,
            lp_reset_regression: false,
            log_request_open: false,
            log_prefill_done: false,

            // Primary prefill from /slots
            prefill_progress: 0.0,
            prefill_tokens: 0,
            prefill_tokens_total: 0,
            last_cached_log_at: None,
            last_cached_log_tokens: 0,
        }
    }

    /// True generation: output tokens are being produced for a request with decode budget remaining.
    /// PP bench (`n_predict: 0`) still evaluates one token — that must not flip UI to TG.
    fn slots_have_active_generation(slots: &[fusion_poller::SlotData]) -> bool {
        slots.iter().any(|s| {
            if !s.is_processing || s.next_token.is_empty() {
                return false;
            }
            let t = &s.next_token[0];
            t.n_decoded > 0 && t.n_remain > 0
        })
    }

    /// Merge log belt + /slots suspenders into the values we emit to the UI.
    fn merged_prefill_display(&self) -> (f64, usize) {
        let total = self.prefill_tokens_total;
        let mut tokens = self.prefill_tokens.max(self.lp_prompt_tokens);
        let mut progress = if total > 0 {
            (tokens as f64 / total as f64).clamp(0.0, 1.0)
        } else {
            0.0
        };
        if self.lp_prefill_progress > progress {
            progress = self.lp_prefill_progress;
            if total > 0 {
                tokens = tokens.max((progress * total as f64).round() as usize);
            }
        }
        if self.prefill_progress > progress {
            progress = self.prefill_progress;
        }
        if total > 0 && tokens + 2 >= total {
            progress = 1.0;
            tokens = total;
        }
        (progress.clamp(0.0, 1.0), tokens)
    }

    // ── Public spawn API ────────────────────────────────────────────

    pub fn spawn(
        log_hub: LogHub,
        config: FusionConfig,
    ) -> (tokio_util::task::AbortOnDropHandle<()>, tokio_util::sync::CancellationToken) {
        let cancel = tokio_util::sync::CancellationToken::new();
        let cancel_spawn = cancel.clone();

       // Fusion brain startup now routed to Blackwell Output Console

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
        let (event_tx, mut event_rx) = tokio::sync::mpsc::channel::<crate::fusion_logparser::LogEvent>(1024);
        register_log_receiver(config.slot_idx, event_tx);

        // Emit initial LOADING update so frontend shows launch animation
        let init = brain.build_update(&[], None);
        log_hub.emit("fusion-update", &init);

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(1500))
            .build()
            .unwrap_or_default();

        let poll_interval = tokio::time::Duration::from_millis(100);
        let mut interval = tokio::time::interval(poll_interval);

        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    // Fusion brain cancellation now routed to Blackwell Output Console
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

                    // Process /slots first so prompt-eval state is current before /metrics PP→TG heuristics
                    let slot_data: Vec<fusion_poller::SlotData> = match slots_result {
                        Ok(slots) => slots,
                        Err(e) => {
                            if brain.engine_state == EngineState::Loading {
                                let update = brain.build_update(&[], metrics_result.as_ref().ok());
                                log_hub.emit("fusion-update", &update);
                            } else {
                                // Fusion brain poll error now routed to Blackwell Output Console
                            }
                            continue;
                        }
                    };

                    brain.process_slots(&slot_data);

                    if let Ok(ref metrics) = metrics_result {
                        brain.process_metrics(metrics, &slot_data);
                    }

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
            crate::fusion_logparser::LogEvent::SamplerInit { total_tokens, .. } => {
                self.handle_sampler_init(*total_tokens);
            }
            crate::fusion_logparser::LogEvent::StopProcessing { .. } => self.handle_stop_processing(),
            crate::fusion_logparser::LogEvent::CachedPromptTokens { cached_tokens, .. } => {
                self.handle_cached_prompt_tokens(*cached_tokens);
            }
            // NewPrompt — belt: reset all LP state at exact request start (fires before any PP work)
            crate::fusion_logparser::LogEvent::NewPrompt { prompt_tokens, .. } => self.handle_new_prompt(*prompt_tokens),
        }
    }

    fn handle_new_prompt(&mut self, prompt_tokens: usize) {
        // Belt: definitive request start — reset LP state to zero so progress bar starts at 0%
        // LP reset now routed to Blackwell Output Console
        self.log_request_open = true;
        self.log_prefill_done = false;
        self.phase = InferencePhase::PP;
        self.lp_phase = InferencePhase::PP;
        self.lp_prefill_progress = 0.0;
        self.lp_prefill_tps = 0.0;
        self.lp_prompt_tokens = 0;
        self.lp_gen_tps = 0.0;
        self.lp_reset_prompt = true; // Belt caught the start
        self.lp_reset_regression = false;

        // Capture target prompt size (task.n_tokens). Never shrink mid-session (LCP/warmup sub-prompts).
        if prompt_tokens > 0 {
            self.prefill_tokens_total = self.prefill_tokens_total.max(prompt_tokens);
        }
        self.prefill_progress = 0.0;
        self.prefill_tokens = 0;
        self.last_cached_log_at = None;
        self.last_cached_log_tokens = 0;
    }

    fn handle_print_timing_pp(&mut self, e: &crate::fusion_logparser::LogEvent) {
        if let crate::fusion_logparser::LogEvent::PrintTimingPP { n_tokens, progress, pp_tps, .. } = e {
            // Suspenders: regression detection — if new progress < previous (missed start), reset first
            if *progress > 0.0 && *progress < self.lp_prefill_progress && self.lp_prefill_progress > 0.1 {
                // LP regression detection now routed to Blackwell Output Console
                self.lp_prefill_progress = 0.0;
                self.lp_prefill_tps = 0.0;
                self.lp_prompt_tokens = 0;
                self.lp_reset_regression = true; // Suspenders caught the regression
                self.lp_reset_prompt = false;
            }

            self.lp_phase = InferencePhase::PP;
            self.phase = InferencePhase::PP;
            self.lp_prefill_progress = *progress;
            self.lp_prefill_tps = *pp_tps;
            self.lp_prompt_tokens = *n_tokens;
            if *n_tokens > self.prefill_tokens {
                self.prefill_tokens = *n_tokens;
            }
            if *progress > self.prefill_progress {
                self.prefill_progress = *progress;
            }
        }
    }

    fn handle_print_timing_gen(&mut self, e: &crate::fusion_logparser::LogEvent) {
        if let crate::fusion_logparser::LogEvent::PrintTimingGen { gen_tps, .. } = e {
            self.lp_phase = InferencePhase::Tg;
            self.lp_gen_tps = *gen_tps;
            // Phase TG is decided in reconcile_phase (requires n_remain > 0), not from log alone.
        }
    }

    fn handle_cached_prompt_tokens(&mut self, cached_tokens: usize) {
        if self.engine_state != EngineState::Active && !self.log_request_open {
            return;
        }
        // Coalesce ~24ms-spaced cached n_tokens lines so the fusion event channel keeps PP progress lines.
        let now = Instant::now();
        if let Some(last) = self.last_cached_log_at {
            if cached_tokens <= self.last_cached_log_tokens
                && now.duration_since(last).as_millis() < 80
            {
                return;
            }
        }
        self.last_cached_log_at = Some(now);
        self.last_cached_log_tokens = cached_tokens;

        self.log_request_open = true;
        self.log_prefill_done = false;
        self.phase = InferencePhase::PP;
        if cached_tokens > self.prefill_tokens {
            self.prefill_tokens = cached_tokens;
        }
        if self.prefill_tokens_total > 0 {
            let prog =
                (self.prefill_tokens as f64 / self.prefill_tokens_total as f64).clamp(0.0, 1.0);
            if prog > self.prefill_progress {
                self.prefill_progress = prog;
            }
        }
    }

    fn handle_sampler_init(&mut self, task_total_tokens: usize) {
        // Prefill finished — remain PP until /slots shows real generation (n_remain > 0).
        self.log_prefill_done = true;
        self.lp_phase = InferencePhase::PP;
        if self.prefill_tokens_total == 0 && task_total_tokens > 0 {
            self.prefill_tokens_total = task_total_tokens;
        }
        if self.prefill_tokens_total > 0 && self.prefill_tokens < self.prefill_tokens_total {
            self.prefill_tokens = self.prefill_tokens_total;
            self.prefill_progress = 1.0;
        }
    }

    fn handle_stop_processing(&mut self) {
        self.log_request_open = false;
        self.log_prefill_done = false;
        self.phase = InferencePhase::Idle;
        self.lp_phase = InferencePhase::Idle;
        self.lp_prefill_progress = 0.0;
        self.lp_prefill_tps = 0.0;
        self.lp_prompt_tokens = 0;
        // NOTE: lp_gen_tps intentionally NOT reset — keep "last known" TG speed visible after request ends
        self.tg_start_time = None;
        self.last_gen_tps = 0.0;
        self.lp_reset_prompt = false;
        self.lp_reset_regression = false;
        // Primary prefill reset too
        self.prefill_progress = 0.0;
        self.prefill_tokens = 0;
        self.prefill_tokens_total = 0;
        self.last_cached_log_at = None;
        self.last_cached_log_tokens = 0;
    }

    // ── /metrics processing — phase detection + prefill TPS ─────────

    fn process_metrics(&mut self, metrics: &MetricsSnapshot, slots: &[fusion_poller::SlotData]) {
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
            self.phase = InferencePhase::PP;
            self.log_request_open = true;
            self.log_prefill_done = false;
            self.request_start = Some(now);
            self.engine_state = EngineState::Active;
            self.ttft_ms = None;
        } else if request_ended {
            // /metrics requests_processing can dip to 0 between chunks — don't clear if logs/slots still busy.
            let slots_busy = slots.iter().any(|s| s.is_processing);
            if !slots_busy && !self.log_request_open {
                self.log_prefill_done = false;
                self.engine_state = EngineState::Ready;
                self.phase = InferencePhase::Idle;
                self.request_start = None;
                self.prompt_tokens = 0;
                self.ttft_ms = None;
                self.tg_start_time = None;
                self.last_gen_tps = 0.0;
                self.prefill_progress = 0.0;
                self.prefill_tokens = 0;
                self.prefill_tokens_total = 0;
            }
        }

        // Prefill TPS from prompt_tokens_total delta
        if pt_delta > 0 && dt_sec > 0.01 {
            self.prefill_tps = pt_delta as f64 / dt_sec;
            self.log_request_open = true;
            if self.phase == InferencePhase::Idle {
                self.phase = InferencePhase::PP;
            }

            if pt_delta > self.prompt_tokens {
                self.prompt_tokens = pt_delta;
            }
        }

        // Phase PP↔TG is decided in process_slots (WebUI rule: TG iff n_decoded > 0 on a busy slot).
        // Here we only capture TTFT / TG timing when /metrics sees the first predicted token.
        if tt_delta > 0 {
            if self.ttft_ms.is_none() {
                if let Some(start) = self.request_start {
                    self.ttft_ms = Some(start.elapsed().as_millis() as f64);
                }
            }
            if self.phase == InferencePhase::Tg && self.tg_start_time.is_none() {
                self.tg_start_time = Some(now);
                self.tg_start_n_decoded = 0;
            }
        }

        // Store current snapshot for next delta computation
        self.prev_metrics = Some(metrics.clone());
        self.prev_metrics_time = Some(now);
    }

    /// Phase: PP while prefill is in flight; TG only when decode budget remains (n_remain > 0).
    fn reconcile_phase(&mut self, slots: &[fusion_poller::SlotData], any_processing: bool) {
        let metrics_busy = self
            .prev_metrics
            .as_ref()
            .map(|m| m.requests_processing > 0)
            .unwrap_or(false);
        // /slots is_processing and /metrics requests_processing often lag (text bench, WebUI).
        // engine_state ACTIVE is the belt that keeps PP from being wiped every 100ms poll.
        let in_flight = any_processing
            || metrics_busy
            || self.log_request_open
            || self.engine_state == EngineState::Active;

        if !in_flight {
            self.log_request_open = false;
            self.log_prefill_done = false;
            self.phase = InferencePhase::Idle;
            self.prefill_progress = 0.0;
            self.prefill_tokens = 0;
            self.prefill_tokens_total = 0;
            return;
        }

        // Log belt: from NewPrompt until sampler_init — always PP (ignores /slots n_decoded flicker).
        if self.log_request_open && !self.log_prefill_done {
            self.phase = InferencePhase::PP;
            return;
        }

        if Self::slots_have_active_generation(slots) {
            self.phase = InferencePhase::Tg;
            if self.prefill_tokens_total > 0 && self.prefill_tokens < self.prefill_tokens_total {
                self.prefill_tokens = self.prefill_tokens_total;
                self.prefill_progress = 1.0;
            }
            return;
        }

        // In-flight but not generating (PP bench tail, WebUI prefill-only, or between chunks).
        self.phase = InferencePhase::PP;
    }

    /// Update prefill progress from /slots `n_prompt_tokens_processed` only (never `n_prompt_tokens` — that is prompt.tokens.size()).
    fn update_prefill_from_slots(&mut self, slots: &[fusion_poller::SlotData]) {
        if self.prefill_tokens_total == 0 {
            return;
        }
        let total = self.prefill_tokens_total;
        for slot in slots {
            if !slot.is_processing {
                continue;
            }
            let processed = slot.n_prompt_tokens_processed.min(total);
            if processed > self.prefill_tokens {
                self.prefill_tokens = processed;
            }
        }
        let mut prog = (self.prefill_tokens as f64 / total as f64).clamp(0.0, 1.0);
        if self.prefill_tokens + 2 >= total {
            prog = 1.0;
        }
        // Log belt is ahead of /slots during long text prefill — never regress below log progress.
        if prog > self.prefill_progress {
            self.prefill_progress = prog;
        }
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
            // Prompt data for prefill progress + full ctx fill (includes prefill + history + cache reuse)
            prompt_tokens: usize,
            prompt_tokens_processed: usize,
            prompt_tokens_cache: usize,
        }

        let mut decisions: Vec<SlotDecision> = Vec::new();

        for slot in slots {
            let has_token_data = !slot.next_token.is_empty();
            let is_proc = slot.is_processing;

            if is_proc {
                any_processing = true;
            }

            let n_decoded = if has_token_data { slot.next_token[0].n_decoded } else { 0 };
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
                prompt_tokens: slot.n_prompt_tokens,
                prompt_tokens_processed: slot.n_prompt_tokens_processed,
                prompt_tokens_cache: slot.n_prompt_tokens_cache,
            });
        }

        // Second pass: apply decisions — safe to mutate self now
        for d in &decisions {
            if d.new_request {
                if let Some(s) = self.slot_states.get_mut(&d.id) {
                    s.request_start_n_decoded = d.n_decoded;
                }
                self.phase = InferencePhase::PP;
                self.log_request_open = true;
                self.log_prefill_done = false;
                self.request_start = Some(now);
                self.engine_state = EngineState::Active;
                // Reset TG TPS tracking for new request
                self.tg_start_time = None;
                self.tg_start_n_decoded = 0;
                self.ttft_ms = None;
                self.log_request_open = true;
                self.log_prefill_done = false;
                self.prefill_progress = 0.0;
                self.prefill_tokens = 0;
                self.last_cached_log_at = None;
                self.last_cached_log_tokens = 0;
                if d.prompt_tokens_processed > 0 {
                    self.prefill_tokens = d.prompt_tokens_processed;
                }
            }

            if d.ended_session {
                if let Some(s) = self.slot_states.get_mut(&d.id) {
                    // Pure generated tokens for the "gen per session" stats (separate from ctx fill bars)
                    s.total_tokens_lifetime += d.request_tokens_on_end;
                }
                self.session_tokens_generated += d.request_tokens_on_end;
                // Slots often report idle before "stop processing" log — don't wipe belt state early.
                if !self.log_request_open {
                    self.log_prefill_done = false;
                    self.phase = InferencePhase::Idle;
                    self.request_start = None;
                    self.prompt_tokens = 0;
                    self.tg_start_time = None;
                    self.tg_start_n_decoded = 0;
                    self.ttft_ms = None;
                    self.prefill_progress = 0.0;
                    self.prefill_tokens = 0;
                    self.prefill_tokens_total = 0;
                }
            }

            // Update slot state from live /slots data.
            if let Some(s) = self.slot_states.get_mut(&d.id) {
                let new_val = d.n_decoded;

                // Update current prompt snapshot for this slot (for prefill + ctx bars)
                s.current_prompt_tokens = d.prompt_tokens;
                s.current_prompt_processed = d.prompt_tokens_processed;
                s.current_prompt_cache = d.prompt_tokens_cache;

                // Compute authoritative *live* current ctx used for this slot from engine /slots data.
                // During PP: cache + processed gives the actual filling amount (ramps correctly for long prompts).
                // This value is the ground truth for "how much of the ctx is in use right now for this sequence".
                let current_used = if d.prompt_tokens_cache + d.prompt_tokens_processed > 0 {
                    d.prompt_tokens_cache + d.prompt_tokens_processed + d.n_decoded
                } else if d.prompt_tokens > 0 {
                    d.prompt_tokens + d.n_decoded
                } else if d.prompt_tokens_processed > 0 {
                    d.prompt_tokens_processed + d.n_decoded
                } else {
                    d.n_decoded
                };

                // Track live current for the bar. This supports:
                // - growth as chat history / prefill adds tokens over the external session
                // - *downward correction* when the engine performs context shift / compaction / eviction
                //   (server reports smaller effective prompt size after internal "kv cache rm", shifts, etc.)
                // We trust the engine's live numbers every poll rather than only accumulating gens.
                if current_used > 0 {
                    s.session_n_decoded = current_used;
                }

                // Update lifetime max (peak observed ctx used for this slot)
                if current_used > s.total_tokens_lifetime {
                    s.total_tokens_lifetime = current_used;
                }

                s.prev_n_decoded = new_val;
                s.prev_timestamp = now;
                s.was_processing = d.is_proc;
            }

        }

        self.update_prefill_from_slots(slots);
        self.reconcile_phase(slots, any_processing);

        // Update engine state from /slots
        if self.engine_state == EngineState::Loading && !any_processing {
            self.engine_state = EngineState::Ready;
            // Engine ready now routed to Blackwell Output Console
        } else if any_processing && self.engine_state != EngineState::Active {
            self.engine_state = EngineState::Active;
        } else if !any_processing && self.engine_state == EngineState::Active {
            if let Some(ref m) = self.prev_metrics {
                if m.requests_processing == 0 {
                    self.engine_state = EngineState::Ready;
                }
            }
        }

        // Capture TG start snapshot when we enter generation
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

        // Update last known gen TPS — store for use during phase transitions / brief gaps
        if let Some(start) = self.tg_start_time {
            let mut total_n_decoded: usize = 0;
            for slot in slots {
                if !slot.next_token.is_empty() {
                    total_n_decoded += slot.next_token[0].n_decoded;
                }
            }
            let elapsed_ms = start.elapsed().as_millis() as u64;
            if elapsed_ms > 0 && total_n_decoded > self.tg_start_n_decoded {
                let tokens_generated = total_n_decoded.saturating_sub(self.tg_start_n_decoded);
                self.last_gen_tps = (tokens_generated as f64) / (elapsed_ms as f64 / 1000.0);
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

        // Gen TPS from /slots: cumulative average since TG started (accurate immediately, no ramp-up)
        let gen_tps = if self.phase == InferencePhase::Tg {
            if let Some(start) = self.tg_start_time {
                let elapsed_ms = start.elapsed().as_millis() as u64;
                if elapsed_ms > 0 && total_n_decoded > self.tg_start_n_decoded {
                    let tokens_generated = total_n_decoded.saturating_sub(self.tg_start_n_decoded);
                    (tokens_generated as f64) / (elapsed_ms as f64 / 1000.0)
                } else {
                    self.last_gen_tps  // keep last known value during brief gaps
                }
            } else {
                0.0
            }
        } else {
            self.last_gen_tps  // persist across phase transitions (metrics PP→TG flicker)
        };

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

        // Prefill TPS from /metrics gauge
        let prefill_tps_metrics = metrics.map(|m| m.prompt_tps_gauge).unwrap_or(0.0);

        // Context usage — sum of live per-slot current used (from /slots prompt+cache+decoded).
        // This is the actual total KV context currently allocated across sequences (supports compactions that lower individual slots).
        // For the engine-level fill % we use sum vs the configured ctxTotal (whether partitioned or shared pool).
        let mut sum_session_ctx: usize = 0;
        for (_id, s) in &self.slot_states {
            sum_session_ctx += s.session_n_decoded;
        }
        let ctx_used_session = if sum_session_ctx > 0 { sum_session_ctx } else { total_n_decoded };
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
                prompt_tokens: s.current_prompt_tokens,
                prompt_tokens_processed: s.current_prompt_processed,
                prompt_tokens_cache: s.current_prompt_cache,
                n_remain: 0, // populated from fresh slots data below if available
                id_task: None,
                speculative: false,
            })
            .collect();
        slot_ctx.sort_by_key(|s| s.id);

        // Overlay fresh per-slot data from this poll (n_remain, id_task, speculative) so UI gets up-to-date values
        for slot in slots {
            if let Some(info) = slot_ctx.iter_mut().find(|i| i.id == slot.id) {
                if !slot.next_token.is_empty() {
                    let t = &slot.next_token[0];
                    info.n_remain = t.n_remain;
                }
                info.id_task = slot.id_task;
                info.speculative = slot.speculative;
            }
        }

        let (prefill_progress, prefill_tokens) = self.merged_prefill_display();

        FusionUpdate {
            alias: self.alias.clone(),
            slot_idx: self.slot_idx,
            port: self.port,
            engine_state: self.engine_state.clone(),
            phase: self.phase,
            prefill_tps_metrics,
            prefill_progress,
            prefill_tokens,
            prefill_tokens_total: self.prefill_tokens_total,
            gen_tps,
            gen_tokens_per_request_slots: gen_tokens_request_slots,
            gen_tokens_per_session: self.session_tokens_generated,
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
        update.prefill_progress = 0.0;
        update.prefill_tokens = 0;
        update.prefill_tokens_total = 0;
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
        // Fusion brain stopping now routed to Blackwell Output Console
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
        // Fusion brain stopping now routed to Blackwell Output Console
        cancel.cancel();
    }
    // Drain all log event channels too
    {
        let mut event_senders = LOG_EVENT_SENDERS.lock();
        event_senders.clear();
    }
}
