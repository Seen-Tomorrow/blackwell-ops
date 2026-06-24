//! Fusion Brain — state machine that fuses /slots + /metrics data streams.
//! Emits curated FusionUpdate to frontend via "fusion-update" Tauri event.
//!
//! One brain instance per engine, keyed by slot_idx.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::time::Instant;

use crate::fusion::adapters::FusionAdapterId;
use crate::fusion::registry;
use crate::log_hub::LogHub;
use crate::fusion::poller::MetricsSnapshot;

/// Cap hero TPS (avoids million-TPS flash when elapsed≈0 or one poll ingests a huge cached chunk).
const MAX_DISPLAY_TPS: f64 = 200_000.0;
/// PP hero AVG: need sustained prefill wall time (sparse agent file bursts skew tokens/request_elapsed).
const MIN_PP_SESSION_AVG_MS: u64 = 10_000;
/// Per-request + session TG AVG: suppress elapsed≈0 spikes (500ms filters 200k flash).
const MIN_TG_PER_REQUEST_AVG_MS: u64 = 500;
/// Agent bursts (Opencode file reads) gap /slots idle briefly — don't flash IDLE or zero CTX.
const INTER_REQUEST_GAP_HOLD_MS: u64 = 1200;
/// Ignore first-poll token bursts after reset (KV restore / cache jump).
const MAX_INSTANT_TOKEN_JUMP: usize = 2048;
/// Active request polling cadence — matches log_hub stderr batch tick.
fn poll_active_ms() -> u64 {
    crate::log_hub::telemetry_tick_ms()
}
/// Min Δt between instant-TPS samples (slightly under poll interval for timer jitter).
const MIN_INSTANT_TPS_DT_SEC: f64 = 0.02;
/// Cold idle + ready cadence — override via `BLACKWELL_FUSION_IDLE_POLL_MS` (default 2500).
fn poll_idle_ms() -> u64 {
    crate::debug_flags::flags().fusion_idle_poll_ms
}
/// Warm idle: recently-used engine between agent turns — /slots only, no /metrics.
/// Tight enough to catch PP start before n_prompt_tokens_processed races ahead (was 400ms).
const WARM_IDLE_POLL_MS: u64 = 100;
/// Stay on warm cadence for this long after last slot activity (coding-session belt).
const WARM_IDLE_WINDOW_MS: u64 = 60_000;
/// Re-emit idle snapshots periodically so frontend can rehydrate after HMR/remount.
const IDLE_HEARTBEAT_MS: u64 = 10_000;
/// Consecutive /health-only cold-idle ticks before a full /slots sample.
const IDLE_CHEAP_HEALTH_STREAK_MAX: u32 = 2;

/// Log lines that signal in-flight work — reschedule active poll + immediate emit (belt).
fn log_event_wakes_poll(event: &crate::fusion::log::LogEvent) -> bool {
    use crate::fusion::log::LogEvent;
    matches!(
        event,
        LogEvent::NewPrompt { .. }
            | LogEvent::PromptProcessingProgress { .. }
            | LogEvent::SamplerInit { .. }
            | LogEvent::PrintTimingPP { .. }
            | LogEvent::PrintTimingGen { .. }
            | LogEvent::CachedPromptTokens { .. }
            | LogEvent::ForcePromptReprocess { .. }
            | LogEvent::PromptEvalComplete { .. }
    )
}

fn clamp_display_tps(tps: f64) -> f64 {
    if !tps.is_finite() || tps <= 0.0 {
        0.0
    } else {
        tps.min(MAX_DISPLAY_TPS)
    }
}

/// Per-slot KV budget when engine has not reported `n_ctx` yet (llama.cpp: n_ctx_seq = n_ctx / n_parallel).
fn default_ctx_per_slot(ctx_total: usize, parallel: i64) -> usize {
    let slots = parallel.max(1) as usize;
    if slots <= 1 {
        ctx_total
    } else if ctx_total > 0 {
        ctx_total / slots
    } else {
        0
    }
}

/// Live TG extension on the busy slot only — fill numerator is log-primary (`log_prompt_fill` + gen delta).
fn apply_log_primary_ctx_live(s: &mut SlotTrackState, n_decoded: usize, slot_busy: bool) {
    if !slot_busy {
        return;
    }
    let gen_delta = n_decoded.saturating_sub(s.request_start_n_decoded);
    let live = s.log_prompt_fill.saturating_add(gen_delta);
    if live == 0 {
        return;
    }
    if live > s.session_n_decoded {
        s.session_n_decoded = live;
    }
    if live > s.total_tokens_lifetime {
        s.total_tokens_lifetime = live;
    }
}

// ── Configuration (immutable after construction) ─────────────────────

#[derive(Clone)]
pub struct FusionConfig {
    pub alias: String,
    pub slot_idx: usize,
    pub port: u16,
    pub ctx_total: usize,
    pub parallel: i64,
    pub unified_kv: bool,
    pub provider_id: String,
    pub adapter: FusionAdapterId,
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
    current_task_id: Option<i64>,
    total_tokens_lifetime: usize,
    // Current prompt snapshot (for prefill progress + accurate ctx fill including cached history)
    current_prompt_tokens: usize,
    current_prompt_processed: usize,
    current_prompt_cache: usize,
    /// Per-slot PP fill from stderr (`print_timing` / `cached n_tokens`) when /slots omits prompt fields.
    log_prompt_fill: usize,
    /// Per-slot KV budget from engine (`/slots` n_ctx or log `n_ctx_slot`).
    n_ctx_slot: usize,
    /// Throttle per-slot `cached n_tokens` log lines (global throttle starved compaction on other slots).
    last_cached_log_at: Option<Instant>,
    last_cached_log_tokens: usize,
}

impl SlotTrackState {
    fn new() -> Self {
        Self {
            prev_n_decoded: 0,
            session_n_decoded: 0,
            prev_timestamp: Instant::now(),
            request_start_n_decoded: 0,
            was_processing: false,
            current_task_id: None,
            total_tokens_lifetime: 0,
            current_prompt_tokens: 0,
            current_prompt_processed: 0,
            current_prompt_cache: 0,
            log_prompt_fill: 0,
            n_ctx_slot: 0,
            last_cached_log_at: None,
            last_cached_log_tokens: 0,
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
    /// Per-slot KV budget from engine (`/slots` n_ctx or log `n_ctx_slot`).
    #[serde(rename = "nCtxSlot")]
    pub n_ctx_slot: usize,
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

    /// Request-average prefill TPS (tokens processed / wall elapsed) — matches bench `tokens_evaluated / prompt_ms`.
    #[serde(rename = "prefillTpsSession")]
    pub prefill_tps_session: f64,

    /// Per-poll / log-chunk prefill TPS (responsive; use with hero LIVE mode).
    #[serde(rename = "prefillTpsInstant")]
    pub prefill_tps_instant: f64,

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

    /// Session-average TG TPS (cumulative decode wall) — hero AVG mode, mirrors prefillTpsSession.
    #[serde(rename = "genTpsSession")]
    pub gen_tps_session: f64,

    /// Per-poll / log-chunk generation TPS (responsive; use with hero LIVE mode).
    #[serde(rename = "genTpsInstant")]
    pub gen_tps_instant: f64,

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
    /// Per-slot KV budget (engine `n_ctx_seq`); fallback `ctx_total / parallel`.
    #[serde(rename = "ctxPerSlot")]
    pub ctx_per_slot: usize,

    // ── Request timing ─────────────────────────────────────────────
    #[serde(rename = "requestElapsedMs")]
    pub request_elapsed_ms: u64,
    #[serde(rename = "ttftMs", skip_serializing_if = "Option::is_none")]
    pub ttft_ms: Option<f64>,
    /// Wall ms for prompt prefill only (sampler_init / prompt eval complete).
    #[serde(rename = "prefillMs", skip_serializing_if = "Option::is_none")]
    pub prefill_ms: Option<f64>,
    /// Wall ms from prefill complete → first output token (TG decode start).
    #[serde(rename = "decodeTtftMs", skip_serializing_if = "Option::is_none")]
    pub decode_ttft_ms: Option<f64>,

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

    /// Session cumulative MTP draft acceptance rate (accepted / generated), 0–1.
    #[serde(rename = "specDraftAcceptRate", skip_serializing_if = "Option::is_none")]
    pub spec_draft_accept_rate: Option<f64>,
    #[serde(rename = "specDraftAccepted")]
    pub spec_draft_accepted: u64,
    #[serde(rename = "specDraftGenerated")]
    pub spec_draft_generated: u64,
    /// Last completed request draft acceptance (from print_timing line).
    #[serde(rename = "specDraftAcceptRateLast", skip_serializing_if = "Option::is_none")]
    pub spec_draft_accept_rate_last: Option<f64>,
    #[serde(rename = "specDraftAcceptedLast", skip_serializing_if = "Option::is_none")]
    pub spec_draft_accepted_last: Option<usize>,
    #[serde(rename = "specDraftGeneratedLast", skip_serializing_if = "Option::is_none")]
    pub spec_draft_generated_last: Option<usize>,

    /// Reset source indicator — "prompt" if NewPrompt caught request start (belt), "regression" if fallback detected (suspenders). Flashes for visual feedback then clears on next PP line.
    #[serde(rename = "phaseResetSource", skip_serializing_if = "Option::is_none")]
    pub lp_reset_source: Option<&'static str>,  // Some("prompt") or Some("regression")

    /// Wall clock + hero AVG/LIVE must not tick after request end (bench HTTP return, stop processing, idle tail).
    #[serde(rename = "requestClosed")]
    pub request_closed: bool,
}

/// Quantized snapshot for emit-on-change (avoids ~10 Hz identical fusion-update IPC).
#[derive(Clone, PartialEq, Eq)]
struct FusionEmitFingerprint {
    engine_state_tag: u8,
    phase_tag: u8,
    prefill_progress_milli: u32,
    prefill_tokens: u32,
    prefill_tokens_total: u32,
    prefill_tps_session_centi: u32,
    prefill_tps_instant_centi: u32,
    prefill_tps_metrics_centi: u32,
    gen_tps_deci: u32,
    gen_tps_session_deci: u32,
    gen_tps_instant_deci: u32,
    gen_tokens_request: u32,
    gen_tokens_session: u32,
    ctx_used: u32,
    ctx_fill_centi: u32,
    request_elapsed_ms: u64,
    ttft_ms: u64,
    prefill_ms: u64,
    decode_ttft_ms: u64,
    slot_ctx_hash: u64,
    log_progress_milli: u32,
    log_pp_tps_centi: u32,
    log_prompt_tokens: u32,
    log_gen_tps_deci: u32,
    log_phase_tag: u8,
    spec_draft_accept_rate_milli: u32,
    spec_draft_accepted: u64,
    spec_draft_generated: u64,
}

impl FusionEmitFingerprint {
    fn from_update(u: &FusionUpdate) -> Self {
        Self {
            engine_state_tag: engine_state_tag(&u.engine_state),
            phase_tag: phase_tag(&u.phase),
            prefill_progress_milli: (u.prefill_progress * 1000.0).round() as u32,
            prefill_tokens: u.prefill_tokens.min(u32::MAX as usize) as u32,
            prefill_tokens_total: u.prefill_tokens_total.min(u32::MAX as usize) as u32,
            prefill_tps_session_centi: (u.prefill_tps_session * 100.0).round() as u32,
            prefill_tps_instant_centi: (u.prefill_tps_instant * 100.0).round() as u32,
            prefill_tps_metrics_centi: (u.prefill_tps_metrics * 100.0).round() as u32,
            gen_tps_deci: (u.gen_tps * 10.0).round() as u32,
            gen_tps_session_deci: (u.gen_tps_session * 10.0).round() as u32,
            gen_tps_instant_deci: (u.gen_tps_instant * 10.0).round() as u32,
            gen_tokens_request: u.gen_tokens_per_request_slots.min(u32::MAX as usize) as u32,
            gen_tokens_session: u.gen_tokens_per_session.min(u32::MAX as usize) as u32,
            ctx_used: u.ctx_used_session.min(u32::MAX as usize) as u32,
            ctx_fill_centi: (u.ctx_fill_pct * 100.0).round() as u32,
            request_elapsed_ms: u.request_elapsed_ms,
            ttft_ms: u.ttft_ms.map(|v| v.round() as u64).unwrap_or(0),
            prefill_ms: u.prefill_ms.map(|v| v.round() as u64).unwrap_or(0),
            decode_ttft_ms: u.decode_ttft_ms.map(|v| v.round() as u64).unwrap_or(0),
            slot_ctx_hash: hash_slot_ctx(&u.slot_ctx),
            log_progress_milli: (u.lp_prefill_progress * 1000.0).round() as u32,
            log_pp_tps_centi: (u.lp_prefill_tps * 100.0).round() as u32,
            log_prompt_tokens: u.lp_prompt_tokens.min(u32::MAX as usize) as u32,
            log_gen_tps_deci: (u.lp_gen_tps * 10.0).round() as u32,
            log_phase_tag: phase_tag(&u.lp_phase),
            spec_draft_accept_rate_milli: u
                .spec_draft_accept_rate
                .map(|r| (r * 1000.0).round() as u32)
                .unwrap_or(0),
            spec_draft_accepted: u.spec_draft_accepted,
            spec_draft_generated: u.spec_draft_generated,
        }
    }
}

fn engine_state_tag(s: &EngineState) -> u8 {
    match s {
        EngineState::Loading => 0,
        EngineState::Ready => 1,
        EngineState::Active => 2,
    }
}

fn phase_tag(p: &InferencePhase) -> u8 {
    match p {
        InferencePhase::Idle => 0,
        InferencePhase::PP => 1,
        InferencePhase::Tg => 2,
    }
}

fn hash_slot_ctx(ctx: &[SlotCtxInfo]) -> u64 {
    let mut h: u64 = 0;
    for s in ctx {
        h = h
            .wrapping_mul(31)
            .wrapping_add(s.id as u64)
            .wrapping_mul(31)
            .wrapping_add(s.session_n_decoded as u64)
            .wrapping_mul(31)
            .wrapping_add(s.n_decoded as u64)
            .wrapping_mul(31)
            .wrapping_add(s.prompt_tokens_processed as u64)
            .wrapping_mul(31)
            .wrapping_add(s.prompt_tokens_cache as u64)
            .wrapping_mul(31)
            .wrapping_add(s.is_processing as u64);
    }
    h
}

// ── Brain internal state ─────────────────────────────────────────────

pub struct FusionBrain {
    alias: String,
    slot_idx: usize,
    port: u16,
    ctx_total: usize,
    parallel: i64,
    unified_kv: bool,
    adapter: FusionAdapterId,
    phase: InferencePhase,
    engine_state: EngineState,
    request_start: Option<Instant>,
    prompt_tokens: usize,
    prefill_tps: f64,
    ttft_ms: Option<f64>,
    prefill_ms: Option<f64>,
    decode_ttft_ms: Option<f64>,
    slot_states: HashMap<usize, SlotTrackState>,
    session_tokens_generated: usize,
    prev_metrics: Option<MetricsSnapshot>,
    prev_metrics_time: Option<Instant>,

    // ── Cumulative TG TPS tracking (accurate from first token) ───────
    tg_start_time: Option<Instant>,
    tg_start_n_decoded: usize,
    last_gen_tps: f64,  // "last known" value — persists across phase transitions
    /// Pinned hero AVG when `request_closed` (immune to post-end elapsed growth).
    frozen_request_gen_tps: f64,

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

    /// Frozen wall-clock when /slots reports idle (timer must not run after request ends).
    request_elapsed_frozen_ms: u64,

    /// Set on definitive request end — blocks ensure_request_clock until the next NewPrompt/slots new_request.
    request_closed: bool,

    /// From `prompt eval time = X ms / N tokens` — same formula as bench result panel.
    prefill_tps_eval: f64,

    /// Per-poll instant TPS (less smoothing than session averages).
    prefill_tps_instant: f64,
    gen_tps_instant: f64,
    prev_instant_poll_at: Option<Instant>,
    prev_instant_prefill_tokens: usize,
    prev_instant_gen_decoded: usize,

    /// Skip fusion-update IPC when fingerprint unchanged (log belt sets emit_dirty).
    last_emit_fp: Option<FusionEmitFingerprint>,
    emit_dirty: bool,

    /// Last poll where any slot reported `is_processing` (inter-request hold).
    last_slot_busy_at: Option<Instant>,

    /// MTP draft acceptance — session cumulative + last request snapshot.
    spec_draft_accept_rate: Option<f64>,
    spec_draft_accepted_total: u64,
    spec_draft_generated_total: u64,
    spec_draft_accept_rate_last: Option<f64>,
    spec_draft_accepted_last: Option<usize>,
    spec_draft_generated_last: Option<usize>,

    /// PP hero AVG — cumulative across PP bursts this engine session (not per-request wall / elapsed).
    pp_completed_tokens: u64,
    pp_completed_ms: u64,
    pp_burst_peak_tokens: usize,
    pp_burst_started_at: Option<Instant>,

    /// TG hero AVG — cumulative decode tokens / wall across bursts this engine session.
    tg_completed_tokens: u64,
    tg_completed_ms: u64,
    tg_burst_peak_tokens: usize,
    tg_burst_started_at: Option<Instant>,
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
            adapter: config.adapter,
            phase: InferencePhase::Idle,
            engine_state: EngineState::Loading,
            request_start: None,
            prompt_tokens: 0,
            prefill_tps: 0.0,
            ttft_ms: None,
            prefill_ms: None,
            decode_ttft_ms: None,
            slot_states: HashMap::new(),
            session_tokens_generated: 0,
            prev_metrics: None,
            prev_metrics_time: None,

            // Cumulative TG TPS tracking
            tg_start_time: None,
            tg_start_n_decoded: 0,
            last_gen_tps: 0.0,
            frozen_request_gen_tps: 0.0,

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
            request_elapsed_frozen_ms: 0,
            request_closed: false,
            prefill_tps_eval: 0.0,
            prefill_tps_instant: 0.0,
            gen_tps_instant: 0.0,
            prev_instant_poll_at: None,
            prev_instant_prefill_tokens: 0,
            prev_instant_gen_decoded: 0,
            last_emit_fp: None,
            emit_dirty: false,
            last_slot_busy_at: None,
            spec_draft_accept_rate: None,
            spec_draft_accepted_total: 0,
            spec_draft_generated_total: 0,
            spec_draft_accept_rate_last: None,
            spec_draft_accepted_last: None,
            spec_draft_generated_last: None,
            pp_completed_tokens: 0,
            pp_completed_ms: 0,
            pp_burst_peak_tokens: 0,
            pp_burst_started_at: None,
            tg_completed_tokens: 0,
            tg_completed_ms: 0,
            tg_burst_peak_tokens: 0,
            tg_burst_started_at: None,
        }
    }

    fn pp_prefill_active(&self, slots: &[crate::fusion::poller::SlotData]) -> bool {
        self.phase == InferencePhase::PP
            || self.slots_prefill_in_progress(slots)
            || (self.log_request_open && !self.log_prefill_done)
    }

    /// Fold finished PP burst into session accumulators (agent file cadence / SWA re-prefill).
    fn close_pp_burst(&mut self) {
        if let Some(start) = self.pp_burst_started_at.take() {
            let ms = start.elapsed().as_millis() as u64;
            if ms > 0 && self.pp_burst_peak_tokens > 0 {
                self.pp_completed_ms = self.pp_completed_ms.saturating_add(ms);
                self.pp_completed_tokens = self
                    .pp_completed_tokens
                    .saturating_add(self.pp_burst_peak_tokens as u64);
            }
        }
        self.pp_burst_peak_tokens = 0;
    }

    fn tick_pp_session_avg(&mut self, slots: &[crate::fusion::poller::SlotData], prefill_tokens: usize) {
        let pp_active = self.pp_prefill_active(slots);
        if pp_active {
            if self.pp_burst_started_at.is_none() {
                self.pp_burst_started_at = Some(Instant::now());
            }
            if prefill_tokens > self.pp_burst_peak_tokens {
                self.pp_burst_peak_tokens = prefill_tokens;
            }
        } else if self.pp_burst_started_at.is_some() {
            self.close_pp_burst();
        }
    }

    fn pp_session_avg_tps(&self, slots: &[crate::fusion::poller::SlotData], prefill_tokens: usize) -> f64 {
        let mut total_ms = self.pp_completed_ms;
        let mut total_tokens = self.pp_completed_tokens;
        if self.pp_prefill_active(slots) {
            if let Some(start) = self.pp_burst_started_at {
                total_ms += start.elapsed().as_millis() as u64;
            }
            let peak = prefill_tokens.max(self.pp_burst_peak_tokens) as u64;
            total_tokens = self.pp_completed_tokens.saturating_add(peak);
        }
        if total_ms >= MIN_PP_SESSION_AVG_MS && total_tokens > 0 {
            clamp_display_tps((total_tokens as f64 / total_ms as f64) * 1000.0)
        } else {
            0.0
        }
    }

    fn reset_pp_session_avg(&mut self) {
        self.close_pp_burst();
        self.pp_completed_tokens = 0;
        self.pp_completed_ms = 0;
        self.pp_burst_peak_tokens = 0;
    }

    fn tg_generation_active(&self, slots: &[crate::fusion::poller::SlotData]) -> bool {
        !self.request_closed
            && (self.phase == InferencePhase::Tg
                || self.slots_have_active_generation(slots)
                || (self.log_request_open && self.log_prefill_done && self.lp_gen_tps > 0.0))
    }

    fn close_tg_burst(&mut self) {
        if let Some(start) = self.tg_burst_started_at.take() {
            let ms = start.elapsed().as_millis() as u64;
            if ms > 0 && self.tg_burst_peak_tokens > 0 {
                self.tg_completed_ms = self.tg_completed_ms.saturating_add(ms);
                self.tg_completed_tokens = self
                    .tg_completed_tokens
                    .saturating_add(self.tg_burst_peak_tokens as u64);
            }
        }
        self.tg_burst_peak_tokens = 0;
    }

    fn tick_tg_session_avg(&mut self, slots: &[crate::fusion::poller::SlotData]) {
        let tg_active = self.tg_generation_active(slots);
        if tg_active {
            if self.tg_burst_started_at.is_none() {
                self.tg_burst_started_at = Some(Instant::now());
            }
            let tokens = self.per_request_gen_tokens(slots);
            if tokens > self.tg_burst_peak_tokens {
                self.tg_burst_peak_tokens = tokens;
            }
        } else if self.tg_burst_started_at.is_some() {
            self.close_tg_burst();
        }
    }

    fn tg_session_avg_tps(&self, slots: &[crate::fusion::poller::SlotData]) -> f64 {
        let mut total_ms = self.tg_completed_ms;
        let mut total_tokens = self.tg_completed_tokens;
        if self.tg_generation_active(slots) {
            if let Some(start) = self.tg_burst_started_at {
                total_ms += start.elapsed().as_millis() as u64;
            }
            let peak = self
                .per_request_gen_tokens(slots)
                .max(self.tg_burst_peak_tokens) as u64;
            total_tokens = self.tg_completed_tokens.saturating_add(peak);
        }
        if total_ms >= MIN_TG_PER_REQUEST_AVG_MS && total_tokens > 0 {
            clamp_display_tps((total_tokens as f64 / total_ms as f64) * 1000.0)
        } else {
            0.0
        }
    }

    fn reset_tg_session_avg(&mut self) {
        self.close_tg_burst();
        self.tg_completed_tokens = 0;
        self.tg_completed_ms = 0;
        self.tg_burst_peak_tokens = 0;
    }

    fn within_inter_request_hold(&self, now: Instant) -> bool {
        self.last_slot_busy_at
            .map(|t| now.duration_since(t).as_millis() < INTER_REQUEST_GAP_HOLD_MS as u128)
            .unwrap_or(false)
    }

    fn touch_slot_activity(&mut self, now: Instant) {
        self.last_slot_busy_at = Some(now);
    }

    fn is_idle_ready(&self) -> bool {
        self.phase == InferencePhase::Idle && self.engine_state == EngineState::Ready
    }

    /// Recently-used engine between agent turns — faster /slots-only polls (warm tier).
    fn is_warm_idle(&self, now: Instant) -> bool {
        if !self.is_idle_ready() {
            return false;
        }
        self.log_request_open
            || self.emit_dirty
            || self.within_inter_request_hold(now)
            || self
                .last_slot_busy_at
                .map(|t| now.duration_since(t).as_millis() < WARM_IDLE_WINDOW_MS as u128)
                .unwrap_or(false)
    }

    fn poll_tier_ms(&self, now: Instant) -> u64 {
        if !self.is_idle_ready() || self.log_request_open || self.phase == InferencePhase::PP {
            poll_active_ms()
        } else if self.is_warm_idle(now) {
            WARM_IDLE_POLL_MS
        } else {
            poll_idle_ms()
        }
    }

    /// True when /slots or log belt should run at active cadence (PP start before phase flips).
    fn wants_active_poll(&self) -> bool {
        !self.is_idle_ready() || self.log_request_open || self.phase == InferencePhase::PP
    }

    /// HTTP poll + state merge + emit. Returns true when brain left idle-ready (active tier).
    async fn fusion_poll_cycle(
        &mut self,
        client: &reqwest::Client,
        log_hub: &LogHub,
        idle_cheap_streak: &mut u32,
        last_idle_heartbeat: &mut Instant,
    ) -> bool {
        let now = Instant::now();
        let cold_idle = self.is_idle_ready() && !self.is_warm_idle(now);

        if cold_idle && !self.emit_dirty && *idle_cheap_streak < IDLE_CHEAP_HEALTH_STREAK_MAX {
            if crate::fusion::poller::poll_health_ok(client, self.port).await {
                *idle_cheap_streak += 1;
                let heartbeat_due =
                    last_idle_heartbeat.elapsed() >= std::time::Duration::from_millis(IDLE_HEARTBEAT_MS);
                if heartbeat_due {
                    let update = self.build_update(&[], None);
                    self.force_emit(log_hub, update);
                    *last_idle_heartbeat = Instant::now();
                }
                return false;
            }
        }
        *idle_cheap_streak = 0;

        let idle_ready = self.is_idle_ready();
        let (slots_result, metrics_result) = if idle_ready {
            (
                crate::fusion::poller::poll_slots(client, self.port).await,
                Err("idle-skip-metrics".to_string()),
            )
        } else {
            tokio::join!(
                crate::fusion::poller::poll_slots(client, self.port),
                crate::fusion::poller::poll_metrics(client, self.port),
            )
        };

        let mut slot_data: Vec<crate::fusion::poller::SlotData> = match slots_result {
            Ok(slots) => slots,
            Err(_e) => {
                if self.engine_state == EngineState::Loading {
                    let update = self.build_update(&[], metrics_result.as_ref().ok());
                    self.try_emit(log_hub, update);
                }
                return false;
            }
        };

        let was_idle_ready = self.is_idle_ready();
        self.adapter.normalize_slots(&mut slot_data);
        self.process_slots(&slot_data);

        if let Ok(ref metrics) = metrics_result {
            self.process_metrics(metrics, &slot_data);
        }

        if was_idle_ready && !self.is_idle_ready() {
            self.emit_dirty = true;
        }

        let update = self.build_update(&slot_data, metrics_result.as_ref().ok());
        let idle_heartbeat_due = self.is_idle_ready()
            && last_idle_heartbeat.elapsed() >= std::time::Duration::from_millis(IDLE_HEARTBEAT_MS);
        if idle_heartbeat_due {
            self.force_emit(log_hub, update);
            *last_idle_heartbeat = Instant::now();
        } else {
            self.try_emit(log_hub, update);
        }

        !self.is_idle_ready()
    }

    fn force_emit(&mut self, log_hub: &LogHub, update: FusionUpdate) {
        self.last_emit_fp = Some(FusionEmitFingerprint::from_update(&update));
        self.emit_dirty = false;
        cache_fusion_snapshot(&update);
        log_hub.emit("fusion-update", &update);
    }

    fn try_emit(&mut self, log_hub: &LogHub, update: FusionUpdate) {
        let fp = FusionEmitFingerprint::from_update(&update);
        if !self.emit_dirty && self.last_emit_fp.as_ref() == Some(&fp) {
            return;
        }
        self.last_emit_fp = Some(fp);
        self.emit_dirty = false;
        cache_fusion_snapshot(&update);
        log_hub.emit("fusion-update", &update);
    }

    /// Authoritative request start — clears per-request timing for a new request.
    fn restart_request_clock(&mut self) {
        self.request_closed = false;
        self.frozen_request_gen_tps = 0.0;
        self.request_start = Some(Instant::now());
        self.request_elapsed_frozen_ms = 0;
        self.ttft_ms = None;
        self.prefill_ms = None;
        self.decode_ttft_ms = None;
    }

    fn capture_prefill_if_unset(&mut self) {
        if self.prefill_ms.is_some() {
            return;
        }
        if let Some(start) = self.request_start {
            let ms = start.elapsed().as_secs_f64() * 1000.0;
            if ms > 0.0 {
                self.prefill_ms = Some(ms);
                self.update_decode_ttft_from_split();
            }
        }
    }

    fn update_decode_ttft_from_split(&mut self) {
        if self.decode_ttft_ms.is_some() {
            return;
        }
        if let (Some(ttft), Some(prefill)) = (self.ttft_ms, self.prefill_ms) {
            self.decode_ttft_ms = Some((ttft - prefill).max(0.0));
        }
    }

    /// Belt when logs/slots/metrics race — never reset an already-running clock (bench TTFT).
    fn ensure_request_clock(&mut self) {
        if self.request_closed {
            return;
        }
        if self.request_start.is_none() {
            self.restart_request_clock();
        }
    }

    fn capture_ttft_if_unset(&mut self) {
        if self.ttft_ms.is_some() {
            return;
        }
        if let Some(start) = self.request_start {
            let ms = start.elapsed().as_secs_f64() * 1000.0;
            if ms > 0.0 {
                self.ttft_ms = Some(ms);
            }
        } else if self.request_elapsed_frozen_ms > 0 {
            self.ttft_ms = Some(self.request_elapsed_frozen_ms as f64);
        }
        self.update_decode_ttft_from_split();
    }

    fn stop_request_clock(&mut self) {
        if let Some(start) = self.request_start.take() {
            self.request_elapsed_frozen_ms = start.elapsed().as_millis() as u64;
        }
        self.tg_start_time = None;
        self.request_closed = true;
        // Keep last_gen_tps — frozen hero AVG after request end (do not zero).
    }

    fn reset_prefill_counters(&mut self) {
        self.prefill_progress = 0.0;
        self.prefill_tokens = 0;
        self.prefill_tokens_total = 0;
        self.lp_prefill_progress = 0.0;
        self.lp_prefill_tps = 0.0;
        self.lp_prompt_tokens = 0;
        self.last_cached_log_at = None;
        self.last_cached_log_tokens = 0;
        self.prefill_tps_eval = 0.0;
        self.prefill_tps_instant = 0.0;
        self.gen_tps_instant = 0.0;
        self.prev_instant_poll_at = None;
        self.prev_instant_prefill_tokens = 0;
        self.prev_instant_gen_decoded = 0;
    }

    /// Bench warmup/measured phases reuse the same slot without an idle gap — force fresh TG/PP meters.
    /// Definitive request end — freeze elapsed + pin hero AVG (survives stale lp_gen_tps / delayed stop log).
    fn finalize_request_meters(&mut self, slots: &[crate::fusion::poller::SlotData]) {
        if self.request_closed {
            return;
        }
        if let Some(start) = self.tg_start_time {
            let tokens = self.per_request_gen_tokens(slots);
            let elapsed_ms = start.elapsed().as_millis().max(1) as u64;
            if tokens > 0 {
                self.frozen_request_gen_tps =
                    clamp_display_tps((tokens as f64) / (elapsed_ms as f64 / 1000.0));
                self.last_gen_tps = self.frozen_request_gen_tps;
            } else if self.last_gen_tps > 0.0 {
                self.frozen_request_gen_tps = self.last_gen_tps;
            }
        } else if self.last_gen_tps > 0.0 {
            self.frozen_request_gen_tps = self.last_gen_tps;
        }
        self.close_tg_burst();
        self.log_request_open = false;
        self.stop_request_clock();
        self.lp_gen_tps = 0.0;
        self.gen_tps_instant = 0.0;
        self.log_prefill_done = false;
        self.phase = InferencePhase::Idle;
        self.lp_phase = InferencePhase::Idle;
        self.emit_dirty = true;
    }

    fn reset_bench_meters(&mut self) {
        self.phase = InferencePhase::PP;
        self.lp_phase = InferencePhase::PP;
        self.log_request_open = false;
        self.log_prefill_done = false;
        self.prompt_tokens = 0;
        self.prefill_tps = 0.0;
        self.request_start = None;
        self.request_elapsed_frozen_ms = 0;
        self.request_closed = false;
        self.frozen_request_gen_tps = 0.0;
        self.ttft_ms = None;
        self.prefill_ms = None;
        self.decode_ttft_ms = None;
        self.tg_start_time = None;
        self.tg_start_n_decoded = 0;
        self.last_gen_tps = 0.0;
        self.lp_gen_tps = 0.0;
        self.lp_reset_prompt = false;
        self.lp_reset_regression = false;
        self.reset_prefill_counters();
        self.reset_pp_session_avg();
        self.reset_tg_session_avg();
        for s in self.slot_states.values_mut() {
            s.was_processing = false;
            s.session_n_decoded = 0;
            s.log_prompt_fill = 0;
        }
        self.emit_dirty = true;
    }

    fn per_request_gen_tokens(&self, slots: &[crate::fusion::poller::SlotData]) -> usize {
        let mut n = 0usize;
        for slot in slots {
            if slot.next_token.is_empty() {
                continue;
            }
            let decoded = slot.next_token[0].n_decoded;
            let baseline = self
                .slot_states
                .get(&slot.id)
                .map(|s| s.request_start_n_decoded)
                .unwrap_or(0);
            n += decoded.saturating_sub(baseline);
        }
        n
    }

    fn update_instant_tps(&mut self, slots: &[crate::fusion::poller::SlotData], now: Instant) {
        if self.request_closed {
            return;
        }
        let tokens = self.prefill_tokens.max(self.lp_prompt_tokens);
        let gen_request_tokens = self.per_request_gen_tokens(slots);

        if let Some(prev) = self.prev_instant_poll_at {
            let dt = now.duration_since(prev).as_secs_f64();
            if dt >= MIN_INSTANT_TPS_DT_SEC {
                if tokens > self.prev_instant_prefill_tokens {
                    let delta = tokens - self.prev_instant_prefill_tokens;
                    // First sample after reset often jumps by full cache size in one poll.
                    if self.prev_instant_prefill_tokens > 0 || delta <= MAX_INSTANT_TOKEN_JUMP {
                        let rate = delta as f64 / dt;
                        self.prefill_tps_instant = clamp_display_tps(rate);
                    }
                }
                if gen_request_tokens > self.prev_instant_gen_decoded {
                    let delta = gen_request_tokens - self.prev_instant_gen_decoded;
                    if self.prev_instant_gen_decoded > 0 || delta <= 64 {
                        let rate = delta as f64 / dt;
                        self.gen_tps_instant = clamp_display_tps(rate);
                    }
                }
            }
        }

        self.prev_instant_poll_at = Some(now);
        self.prev_instant_prefill_tokens = tokens;
        self.prev_instant_gen_decoded = gen_request_tokens;

        // Log `tg =` is sparse (MTP) — fallback only when poll deltas have not produced LIVE TPS yet.
        if self.prefill_tps_instant <= 0.0 && self.lp_prefill_tps > 0.0 {
            self.prefill_tps_instant = clamp_display_tps(self.lp_prefill_tps);
        }
        if self.gen_tps_instant <= 0.0
            && self.lp_gen_tps > 0.0
            && self.effective_generation_active()
        {
            self.gen_tps_instant = clamp_display_tps(self.lp_gen_tps);
        }
    }

    fn pin_slot_ctx_capacity(&mut self, slot_id: usize, n_ctx: usize) {
        if n_ctx == 0 {
            return;
        }
        let s = self
            .slot_states
            .entry(slot_id)
            .or_insert_with(SlotTrackState::new);
        if s.n_ctx_slot != n_ctx {
            s.n_ctx_slot = n_ctx;
            self.emit_dirty = true;
        }
    }

    /// Authoritative KV occupancy — `stop processing`, compaction, sampler total (exact set).
    fn pin_slot_ctx_fill(&mut self, slot_id: usize, n_tokens: usize) {
        let s = self
            .slot_states
            .entry(slot_id)
            .or_insert_with(SlotTrackState::new);
        s.log_prompt_fill = n_tokens;
        s.session_n_decoded = n_tokens;
        s.current_prompt_processed = n_tokens;
        if n_tokens > s.total_tokens_lifetime {
            s.total_tokens_lifetime = n_tokens;
        }
        self.emit_dirty = true;
    }

    /// Live in-request growth only (monotonic) — PP chunks / TG decode between authoritative pins.
    fn bump_slot_ctx_from_log(&mut self, slot_id: usize, prompt_fill: usize, n_decoded: usize) {
        if prompt_fill == 0 && n_decoded == 0 {
            return;
        }
        let used = if prompt_fill > 0 {
            let gen_delta = n_decoded.saturating_sub(
                self.slot_states
                    .get(&slot_id)
                    .map(|s| s.request_start_n_decoded)
                    .unwrap_or(0),
            );
            prompt_fill.saturating_add(gen_delta)
        } else {
            n_decoded
        };
        let s = self
            .slot_states
            .entry(slot_id)
            .or_insert_with(SlotTrackState::new);
        if prompt_fill > 0 {
            s.log_prompt_fill = prompt_fill;
            s.current_prompt_processed = prompt_fill;
        }
        if used > s.session_n_decoded {
            s.session_n_decoded = used;
        }
        if used > s.total_tokens_lifetime {
            s.total_tokens_lifetime = used;
        }
        self.emit_dirty = true;
    }

    /// Pin TG decode baseline when a request (or SWA re-prefill) starts on a slot that never went idle.
    /// Pass live `/slots` `n_decoded` when available — `prev_n_decoded` from the prior request is stale on bench/MTP turn boundaries.
    fn begin_request_on_slot(
        &mut self,
        slot_id: usize,
        task_id: Option<i64>,
        decode_baseline: Option<usize>,
    ) {
        let baseline = decode_baseline.unwrap_or_else(|| {
            self.slot_states
                .get(&slot_id)
                .map(|s| s.prev_n_decoded)
                .unwrap_or(0)
        });
        let s = self
            .slot_states
            .entry(slot_id)
            .or_insert_with(SlotTrackState::new);
        s.request_start_n_decoded = baseline;
        if let Some(tid) = task_id {
            s.current_task_id = Some(tid);
        }
        self.tg_start_time = None;
        self.tg_start_n_decoded = baseline;
        self.last_gen_tps = 0.0;
    }

    /// Engine resets per-task `n_decoded` while we still hold the prior request's high baseline (common after bench/MTP).
    fn rebaseline_decode_if_stale(&mut self, slot_id: usize, n_decoded: usize) {
        if let Some(s) = self.slot_states.get_mut(&slot_id) {
            if n_decoded < s.request_start_n_decoded {
                s.request_start_n_decoded = n_decoded;
                if self.tg_start_n_decoded > n_decoded {
                    self.tg_start_n_decoded = n_decoded;
                }
            }
        }
    }

    /// Per-request decode progress — `n_decoded > request_start_n_decoded` (not raw `n_decoded > 0`).
    /// Do not gate on `n_remain <= 0`: unlimited chat uses negative `n_remain`; MTP can report 0 while finishing.
    fn slot_has_request_decode(&self, slot: &crate::fusion::poller::SlotData) -> bool {
        if !slot.is_processing || slot.next_token.is_empty() {
            return false;
        }
        let t = &slot.next_token[0];
        let baseline = self
            .slot_states
            .get(&slot.id)
            .map(|st| st.request_start_n_decoded)
            .unwrap_or(0);
        t.n_decoded > baseline
    }

    fn slots_have_active_generation(&self, slots: &[crate::fusion::poller::SlotData]) -> bool {
        slots.iter().any(|s| self.slot_has_request_decode(s))
    }

    /// TG belt: fused phase OR log print_timing `tg =` while request is open (MTP emits sparse gen lines).
    fn effective_generation_active(&self) -> bool {
        self.phase == InferencePhase::Tg
            || (self.log_request_open && self.lp_gen_tps > 0.0)
    }

    /// /slots shows prompt eval still in flight — beats stale decode counters during SWA re-prefill.
    fn slots_prefill_in_progress(&self, slots: &[crate::fusion::poller::SlotData]) -> bool {
        if self.log_prefill_done {
            return false;
        }
        if self.log_request_open
            && self.lp_prefill_progress > 0.0
            && self.lp_prefill_progress < 0.995
        {
            return true;
        }
        if !self.adapter.slots_expose_prompt_processed() {
            return false;
        }
        let total = self.prefill_tokens_total;
        for slot in slots {
            if !slot.is_processing {
                continue;
            }
            if total > 0 && slot.n_prompt_tokens_processed + 2 < total {
                return true;
            }
            if total == 0
                && slot.n_prompt_tokens > 0
                && slot.n_prompt_tokens_processed > 0
                && slot.n_prompt_tokens_processed < slot.n_prompt_tokens
            {
                return true;
            }
        }
        false
    }

    /// Merge log belt + /slots suspenders into the values we emit to the UI.
    fn merged_prefill_display(&self) -> (f64, usize) {
        let total = self.prefill_tokens_total;
        let mut progress = self
            .lp_prefill_progress
            .max(self.prefill_progress)
            .clamp(0.0, 1.0);

        // Live processed count: log `n_tokens` / cached lines (never stale total from prior bench).
        let mut tokens = if self.lp_prompt_tokens > 0 {
            self.lp_prompt_tokens
        } else {
            self.prefill_tokens
        };

        if total > 0 && progress > 0.0 && progress < 0.995 {
            let cap = ((progress * total as f64) as usize)
                .saturating_add(768)
                .min(total);
            if tokens > cap {
                tokens = cap.max(self.lp_prompt_tokens);
            }
        } else if progress >= 0.995 && total > 0 {
            progress = 1.0;
            tokens = total.max(tokens).min(total);
        } else if total > 0 && tokens > total {
            tokens = total;
        }

        (progress, tokens)
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
        registry::register_slot_adapter(config.slot_idx, config.adapter);

        // Channel for log events + bench meter resets → this brain task (bounded to backpressure on slow consumer)
        let (event_tx, mut event_rx) =
            tokio::sync::mpsc::channel::<BrainInbound>(1024);
        register_brain_inbound(config.slot_idx, event_tx);

        // Emit initial LOADING update so frontend shows launch animation
        let init = brain.build_update(&[], None);
        brain.force_emit(&log_hub, init);

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(1500))
            .build()
            .unwrap_or_default();

        let slot_idx = config.slot_idx;
        let mut next_poll =
            tokio::time::Instant::now() + tokio::time::Duration::from_millis(poll_active_ms());
        let mut last_idle_heartbeat = std::time::Instant::now();
        let mut idle_cheap_streak: u32 = 0;

        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    unregister_brain_inbound(slot_idx);
                    let term = brain.build_terminal_update();
                    brain.force_emit(&log_hub, term);
                    return;
                }

                // Log belt: immediate emit (A) + optional /slots wake (D); active poll on activity.
                Some(inbound) = event_rx.recv() => {
                    match inbound {
                        BrainInbound::Log(log_event) => {
                            let wakes = log_event_wakes_poll(&log_event);
                            brain.process_log_event(&log_event);
                            brain.emit_dirty = true;
                            idle_cheap_streak = 0;

                            let preview = brain.build_update(&[], None);
                            if wakes {
                                brain.force_emit(&log_hub, preview);
                            } else {
                                brain.try_emit(&log_hub, preview);
                            }

                            let mut promote_active = wakes;
                            // Belt wake: merge /slots on activity logs (not only cold-idle path).
                            if wakes || brain.is_idle_ready() {
                                if brain
                                    .fusion_poll_cycle(
                                        &client,
                                        &log_hub,
                                        &mut idle_cheap_streak,
                                        &mut last_idle_heartbeat,
                                    )
                                    .await
                                {
                                    promote_active = true;
                                }
                            }

                            let now = std::time::Instant::now();
                            let poll_ms = if promote_active || brain.wants_active_poll() {
                                poll_active_ms()
                            } else {
                                brain.poll_tier_ms(now)
                            };
                            next_poll = tokio::time::Instant::now()
                                + tokio::time::Duration::from_millis(poll_ms);
                        }
                        BrainInbound::BenchMeterReset(ack) => {
                            brain.reset_bench_meters();
                            if let Some(tx) = ack {
                                let _ = tx.send(());
                            }
                        }
                        BrainInbound::BenchMeterFreeze(ack) => {
                            brain.finalize_request_meters(&[]);
                            if let Some(tx) = ack {
                                let _ = tx.send(());
                            }
                        }
                    }
                }

                _ = tokio::time::sleep_until(next_poll) => {
                    if crate::debug_flags::flags().disable_fusion_poll {
                        continue;
                    }

                    let _ = brain
                        .fusion_poll_cycle(
                            &client,
                            &log_hub,
                            &mut idle_cheap_streak,
                            &mut last_idle_heartbeat,
                        )
                        .await;

                    let poll_ms = brain.poll_tier_ms(std::time::Instant::now());
                    next_poll = tokio::time::Instant::now()
                        + tokio::time::Duration::from_millis(poll_ms);
                }
            }
        }
    }

    // ── Log-parsed event handlers (stderr print_timing lines) ───────

    fn process_log_event(&mut self, event: &crate::fusion::log::LogEvent) {
        match event {
            crate::fusion::log::LogEvent::PrintTimingPP { .. } => self.handle_print_timing_pp(event),
            crate::fusion::log::LogEvent::PrintTimingGen { .. } => self.handle_print_timing_gen(event),
            crate::fusion::log::LogEvent::DraftAcceptance { .. } => {
                self.handle_draft_acceptance(event);
            }
            crate::fusion::log::LogEvent::SamplerInit {
                slot_id,
                total_tokens,
                ..
            } => self.handle_sampler_init(*slot_id, *total_tokens),
            crate::fusion::log::LogEvent::StopProcessing {
                slot_id,
                n_tokens,
                ..
            } => self.handle_stop_processing(*slot_id, *n_tokens),
            crate::fusion::log::LogEvent::CachedPromptTokens {
                slot_id,
                cached_tokens,
                ..
            } => self.handle_cached_prompt_tokens(*slot_id, *cached_tokens),
            // NewPrompt — belt: reset all LP state at exact request start (fires before any PP work)
            crate::fusion::log::LogEvent::NewPrompt {
                slot_id,
                task_id,
                prompt_tokens,
                n_ctx_slot,
            } => self.handle_new_prompt(*slot_id, *task_id, *prompt_tokens, *n_ctx_slot),
            crate::fusion::log::LogEvent::NewSlot { slot_id, n_ctx } => {
                self.pin_slot_ctx_capacity(*slot_id, *n_ctx);
            }
            crate::fusion::log::LogEvent::ForcePromptReprocess { slot_id, task_id } => {
                self.handle_force_prompt_reprocess(*slot_id, *task_id);
            }
            crate::fusion::log::LogEvent::PromptEvalComplete {
                slot_id,
                tokens,
                eval_ms,
                ..
            } => self.handle_prompt_eval_complete(*slot_id, *tokens, *eval_ms),
            crate::fusion::log::LogEvent::PromptProcessingProgress {
                slot_id,
                task_id,
                n_tokens,
                progress,
            } => self.handle_prompt_processing_progress(*slot_id, *task_id, *n_tokens, *progress),
        }
    }

    fn handle_prompt_processing_progress(
        &mut self,
        slot_id: usize,
        task_id: i64,
        n_tokens: usize,
        progress: f64,
    ) {
        if progress <= 0.0 || n_tokens == 0 {
            return;
        }
        // TG bench freeze can linger until reset is processed — Tom PP belt must reopen meters.
        self.request_closed = false;
        self.frozen_request_gen_tps = 0.0;
        self.log_request_open = true;
        self.log_prefill_done = false;
        self.phase = InferencePhase::PP;
        self.lp_phase = InferencePhase::PP;
        let prog = progress.clamp(0.0, 1.0);
        self.lp_prefill_progress = prog;
        if prog > self.prefill_progress {
            self.prefill_progress = prog;
        }
        self.lp_prompt_tokens = n_tokens;
        if n_tokens > self.prefill_tokens {
            self.prefill_tokens = n_tokens;
        }
        if self.prefill_tokens_total == 0 && prog > 0.0 {
            let total = ((n_tokens as f64) / prog).round() as usize;
            if total > 0 {
                self.prefill_tokens_total = total;
            }
        }
        if self.slot_states.get(&slot_id).map(|s| s.current_task_id).flatten().is_none() {
            self.begin_request_on_slot(slot_id, Some(task_id), None);
        }
        self.restart_request_clock();
        self.engine_state = EngineState::Active;
        self.touch_slot_activity(Instant::now());
        self.emit_dirty = true;
    }

    fn handle_new_prompt(
        &mut self,
        slot_id: usize,
        task_id: i64,
        prompt_tokens: usize,
        n_ctx_slot: Option<usize>,
    ) {
        if let Some(n_ctx) = n_ctx_slot {
            self.pin_slot_ctx_capacity(slot_id, n_ctx);
        }
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

        // task.n_tokens for this prompt (replace — do not max with prior bench; that froze token display).
        if prompt_tokens > 0 {
            self.prefill_tokens_total = prompt_tokens;
        }
        self.prefill_progress = 0.0;
        self.prefill_tokens = 0;
        self.lp_prompt_tokens = 0;
        if let Some(s) = self.slot_states.get_mut(&slot_id) {
            s.last_cached_log_at = None;
            s.last_cached_log_tokens = 0;
        }
       self.prefill_tps_instant = 0.0;
        self.gen_tps_instant = 0.0;
        self.prev_instant_poll_at = None;
        self.prev_instant_prefill_tokens = 0;
        self.prev_instant_gen_decoded = 0;
        self.begin_request_on_slot(slot_id, Some(task_id), None);
        self.restart_request_clock();
        self.engine_state = EngineState::Active;
        self.touch_slot_activity(Instant::now());
        self.emit_dirty = true;
        // Do not bump from task.n_tokens — planned size, not KV fill; wait for cached / sampler / stop lines.
    }

    fn handle_force_prompt_reprocess(&mut self, slot_id: usize, task_id: i64) {
        // SWA / hybrid cache miss: KV cleared — drop stale monotonic fill before cached n_tokens = 0 lands.
        self.pin_slot_ctx_fill(slot_id, 0);
        // SWA / hybrid cache miss: same task, slot stays busy — stale n_decoded looks like TG.
        self.log_request_open = true;
        self.log_prefill_done = false;
        self.phase = InferencePhase::PP;
        self.lp_phase = InferencePhase::PP;
        self.lp_prefill_progress = 0.0;
        self.lp_prefill_tps = 0.0;
        self.lp_gen_tps = 0.0;
        self.prefill_progress = 0.0;
        self.prefill_tokens = 0;
        self.prefill_tps_instant = 0.0;
        self.gen_tps_instant = 0.0;
        self.prev_instant_poll_at = None;
        self.prev_instant_prefill_tokens = 0;
        self.prev_instant_gen_decoded = 0;
        self.begin_request_on_slot(slot_id, Some(task_id), None);
        self.ensure_request_clock();
        self.touch_slot_activity(Instant::now());
        self.emit_dirty = true;
    }

    fn fold_pp_eval_burst(&mut self, tokens: usize, eval_ms: f64) {
        self.pp_burst_started_at = None;
        self.pp_burst_peak_tokens = 0;
        if tokens > 0 && eval_ms > 0.0 {
            self.pp_completed_tokens = self.pp_completed_tokens.saturating_add(tokens as u64);
            self.pp_completed_ms = self
                .pp_completed_ms
                .saturating_add(eval_ms.round() as u64);
        }
    }

    fn handle_prompt_eval_complete(&mut self, slot_id: usize, tokens: usize, eval_ms: f64) {
        if tokens == 0 {
            return;
        }
        // MTP/end-of-request print_timing repeats prompt eval *after* decode lines — don't rewind to PP.
        if self.log_prefill_done || self.lp_phase == InferencePhase::Tg || self.lp_gen_tps > 0.0 {
            if eval_ms > 0.0 && self.prefill_ms.is_none() {
                self.prefill_ms = Some(eval_ms);
                self.prefill_tps_eval = clamp_display_tps((tokens as f64 / eval_ms) * 1000.0);
                self.update_decode_ttft_from_split();
            }
            return;
        }
        // Server-reported actual prefill size (often differs from task.n_tokens estimate).
        self.prefill_tokens_total = tokens;
        self.prefill_tokens = tokens;
        self.lp_prompt_tokens = tokens;
        self.prefill_progress = 1.0;
        self.lp_prefill_progress = 1.0;
        if eval_ms > 0.0 {
            self.prefill_tps_eval = clamp_display_tps((tokens as f64 / eval_ms) * 1000.0);
            self.prefill_ms = Some(eval_ms);
            self.update_decode_ttft_from_split();
            self.fold_pp_eval_burst(tokens, eval_ms);
        }
        let n_decoded = self
            .slot_states
            .get(&slot_id)
            .map(|s| s.prev_n_decoded)
            .unwrap_or(0);
        self.bump_slot_ctx_from_log(slot_id, tokens, n_decoded);
    }

    fn handle_print_timing_pp(&mut self, e: &crate::fusion::log::LogEvent) {
        if let crate::fusion::log::LogEvent::PrintTimingPP {
            slot_id,
            n_tokens,
            progress,
            pp_tps,
            ..
        } = e
        {
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
            if *pp_tps > 0.0 {
                self.prefill_tps_instant = clamp_display_tps(*pp_tps);
            }
            let n_decoded = self
                .slot_states
                .get(slot_id)
                .map(|s| s.prev_n_decoded)
                .unwrap_or(0);
            self.bump_slot_ctx_from_log(*slot_id, *n_tokens, n_decoded);
        }
    }

    fn handle_print_timing_gen(&mut self, e: &crate::fusion::log::LogEvent) {
        if let crate::fusion::log::LogEvent::PrintTimingGen {
            gen_tps,
            slot_id,
            n_decoded,
            ..
        } = e
        {
            self.rebaseline_decode_if_stale(*slot_id, *n_decoded);
            self.capture_ttft_if_unset();
            self.log_prefill_done = true;
            self.lp_phase = InferencePhase::Tg;
            self.phase = InferencePhase::Tg;
            self.lp_gen_tps = *gen_tps;
            if *gen_tps > 0.0 {
                self.gen_tps_instant = clamp_display_tps(*gen_tps);
                self.last_gen_tps = self.gen_tps_instant;
            }
            if self.tg_start_time.is_none() {
                self.tg_start_time = Some(Instant::now());
                self.tg_start_n_decoded = self
                    .slot_states
                    .get(slot_id)
                    .map(|s| s.request_start_n_decoded)
                    .unwrap_or(0);
            }
            let prompt_base = self
                .prefill_tokens_total
                .max(self.lp_prompt_tokens)
                .max(self.prefill_tokens);
            self.bump_slot_ctx_from_log(*slot_id, prompt_base, *n_decoded);
            self.emit_dirty = true;
        }
    }

    fn handle_draft_acceptance(&mut self, e: &crate::fusion::log::LogEvent) {
        let crate::fusion::log::LogEvent::DraftAcceptance {
            accepted,
            generated,
            accept_rate,
            ..
        } = e
        else {
            return;
        };
        if *generated == 0 {
            return;
        }
        self.spec_draft_accepted_total += *accepted as u64;
        self.spec_draft_generated_total += *generated as u64;
        self.spec_draft_accept_rate = Some(
            self.spec_draft_accepted_total as f64 / self.spec_draft_generated_total as f64,
        );
        self.spec_draft_accept_rate_last = Some(*accept_rate);
        self.spec_draft_accepted_last = Some(*accepted);
        self.spec_draft_generated_last = Some(*generated);
        self.emit_dirty = true;
    }

    fn handle_cached_prompt_tokens(&mut self, slot_id: usize, cached_tokens: usize) {
        if self.engine_state != EngineState::Active && !self.log_request_open {
            return;
        }
        let now = Instant::now();
        let (prior_cached, prior_session, n_decoded, request_start) = self
            .slot_states
            .get(&slot_id)
            .map(|s| {
                (
                    s.last_cached_log_tokens,
                    s.session_n_decoded,
                    s.prev_n_decoded,
                    s.request_start_n_decoded,
                )
            })
            .unwrap_or((0, 0, 0, 0));

        // Downward jumps = compaction / checkpoint rewind / full re-process — never throttle.
        let compaction = cached_tokens + 256 < prior_cached
            || cached_tokens + 256 < prior_session
            || (cached_tokens == 0 && prior_session > 512);
        if !compaction {
            if let Some(s) = self.slot_states.get(&slot_id) {
                if let Some(last) = s.last_cached_log_at {
                    if cached_tokens <= s.last_cached_log_tokens
                        && now.duration_since(last).as_millis() < 80
                    {
                        return;
                    }
                }
            }
        }

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
        let gen_delta = n_decoded.saturating_sub(request_start);
        let live = cached_tokens.saturating_add(gen_delta);
        if compaction {
            self.pin_slot_ctx_fill(slot_id, live);
        } else {
            self.bump_slot_ctx_from_log(slot_id, cached_tokens, n_decoded);
        }
        if let Some(s) = self.slot_states.get_mut(&slot_id) {
            s.last_cached_log_at = Some(now);
            s.last_cached_log_tokens = cached_tokens;
        }
    }

    fn handle_sampler_init(&mut self, slot_id: usize, task_total_tokens: usize) {
        // Prefill finished — remain PP until /slots shows real generation (n_remain > 0).
        self.log_prefill_done = true;
        self.capture_prefill_if_unset();
        self.lp_phase = InferencePhase::PP;
        if self.prefill_tokens_total == 0 && task_total_tokens > 0 {
            self.prefill_tokens_total = task_total_tokens;
        }
        if self.prefill_tokens_total > 0 {
            self.prefill_progress = 1.0;
        }
        // Authoritative KV size at PP→TG boundary (`init sampler … total = N`).
        let n_decoded = self
            .slot_states
            .get(&slot_id)
            .map(|s| s.prev_n_decoded)
            .unwrap_or(0);
        let gen_delta = n_decoded.saturating_sub(
            self.slot_states
                .get(&slot_id)
                .map(|s| s.request_start_n_decoded)
                .unwrap_or(0),
        );
        self.pin_slot_ctx_fill(slot_id, task_total_tokens.saturating_add(gen_delta));
    }

    fn handle_stop_processing(&mut self, slot_id: usize, n_tokens: usize) {
        // Exact pin — monotonic max here kept bars at 100% after compaction / new session.
        self.pin_slot_ctx_fill(slot_id, n_tokens);
        if let Some(s) = self.slot_states.get_mut(&slot_id) {
            s.was_processing = false;
        }
        self.lp_reset_prompt = false;
        self.lp_reset_regression = false;
        // Do not finalize global meters here — multi-slot: other slots may still be busy.
        self.lp_prefill_progress = 0.0;
        self.lp_prefill_tps = 0.0;
        self.lp_prompt_tokens = 0;
    }

    // ── /metrics processing — phase detection + prefill TPS ─────────

    fn process_metrics(&mut self, metrics: &MetricsSnapshot, slots: &[crate::fusion::poller::SlotData]) {
        let now = Instant::now();

        // Extract decisions from prev_metrics BEFORE mutating self
        let (request_ended, new_request_started, pt_delta, _ps_delta, tt_delta, dt_sec) =
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
            self.request_closed = false;
            self.phase = InferencePhase::PP;
            self.log_request_open = true;
            self.log_prefill_done = false;
            self.ensure_request_clock();
            self.engine_state = EngineState::Active;
        } else if request_ended {
            // /metrics requests_processing can dip to 0 between chunks — don't clear if logs/slots still busy.
            let slots_busy = slots.iter().any(|s| s.is_processing);
            if !slots_busy
                && !self.log_request_open
                && !self.within_inter_request_hold(now)
            {
                self.log_prefill_done = false;
                self.engine_state = EngineState::Ready;
                self.phase = InferencePhase::Idle;
                self.stop_request_clock();
                self.prompt_tokens = 0;
                self.reset_prefill_counters();
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

        // Phase PP↔TG is decided in process_slots. TTFT is captured there on first real decode
        // (per-request n_decoded) — not from predicted_tokens_total, which is cumulative and often
        // updates in one batch at request end (bench TG showed multi-second bogus TTFT).
        if tt_delta > 0 && self.phase == InferencePhase::Tg && self.tg_start_time.is_none() {
            let baseline: usize = self
                .slot_states
                .values()
                .map(|s| s.request_start_n_decoded)
                .sum();
            self.tg_start_n_decoded = baseline;
            self.tg_start_time = Some(now);
        }

        // Store current snapshot for next delta computation
        self.prev_metrics = Some(metrics.clone());
        self.prev_metrics_time = Some(now);
    }

    /// Phase: PP while prefill is in flight; TG only when decode budget remains (n_remain > 0).
    fn reconcile_phase(
        &mut self,
        slots: &[crate::fusion::poller::SlotData],
        any_processing: bool,
        now: Instant,
    ) {
        if self.request_closed {
            // Belt: PP logs/slots can arrive before bench reset drains after TG freeze.
            let pp_reopening = self.log_request_open
                && !self.log_prefill_done
                && (self.phase == InferencePhase::PP
                    || self.lp_prefill_progress > 0.0
                    || self.prefill_progress > 0.0);
            if pp_reopening {
                self.request_closed = false;
                self.frozen_request_gen_tps = 0.0;
            } else {
                self.phase = InferencePhase::Idle;
                self.lp_phase = InferencePhase::Idle;
                return;
            }
        }

        let metrics_busy = self
            .prev_metrics
            .as_ref()
            .map(|m| m.requests_processing > 0)
            .unwrap_or(false);
        // /slots is_processing and /metrics requests_processing often lag (text bench, WebUI).
        // engine_state ACTIVE is the belt that keeps PP from being wiped every poll tick.
        let in_flight = any_processing
            || metrics_busy
            || self.log_request_open
            || self.engine_state == EngineState::Active
            || self.within_inter_request_hold(now);

        if !in_flight {
            self.log_request_open = false;
            self.log_prefill_done = false;
            self.phase = InferencePhase::Idle;
            self.stop_request_clock();
            self.reset_prefill_counters();
            return;
        }

        // Active decode beats stale print_timing PP progress (AVG hero needs stable TG + tg_start_time).
        if self.slots_have_active_generation(slots) {
            if self.log_request_open {
                self.log_prefill_done = true;
            }
            self.phase = InferencePhase::Tg;
            return;
        }

        if self.slots_prefill_in_progress(slots) {
            self.phase = InferencePhase::PP;
            return;
        }

        // In-flight but not generating (PP bench tail, WebUI prefill-only, or between MTP log chunks).
        if self.log_prefill_done || self.lp_gen_tps > 0.0 {
            self.phase = InferencePhase::Tg;
        } else {
            self.phase = InferencePhase::PP;
        }
    }

    /// Update prefill progress from /slots `n_prompt_tokens_processed` only (never `n_prompt_tokens` — that is prompt.tokens.size()).
    fn update_prefill_from_slots(&mut self, slots: &[crate::fusion::poller::SlotData]) {
        if !self.adapter.slots_expose_prompt_processed() || self.prefill_tokens_total == 0 {
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

    fn process_slots(&mut self, slots: &[crate::fusion::poller::SlotData]) {
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
            n_ctx: usize,
        }

        let mut decisions: Vec<SlotDecision> = Vec::new();

        for slot in slots {
            if slot.n_ctx > 0 {
                self.pin_slot_ctx_capacity(slot.id, slot.n_ctx);
            }
            let has_token_data = !slot.next_token.is_empty();
            let is_proc = slot.is_processing;

            if is_proc {
                any_processing = true;
            }

            let n_decoded = if has_token_data { slot.next_token[0].n_decoded } else { 0 };
            let s = self.slot_states.entry(slot.id).or_insert_with(SlotTrackState::new);

            let task_changed = match (slot.id_task, s.current_task_id) {
                (Some(new_id), Some(old_id)) => new_id != old_id,
                (Some(_), None) => is_proc,
                _ => false,
            };
            // Brief /slots idle mid-request (MTP) must not look like a new bench turn — trust log_request_open.
            let idle_resume = is_proc && !s.was_processing;
            let new_request =
                (is_proc && task_changed) || (idle_resume && !self.log_request_open);
            let ended_session = !is_proc && s.was_processing && !self.log_request_open;
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
                n_ctx: slot.n_ctx,
            });
        }

        // Second pass: apply decisions — safe to mutate self now
        let mut saw_first_decode = false;
        for d in &decisions {
            if d.is_proc {
                self.rebaseline_decode_if_stale(d.id, d.n_decoded);
            }

            if d.new_request {
                self.request_closed = false;
                let task_id = slots
                    .iter()
                    .find(|sl| sl.id == d.id)
                    .and_then(|sl| sl.id_task);
                if let Some(s) = self.slot_states.get_mut(&d.id) {
                    s.log_prompt_fill = 0;
                }
                self.begin_request_on_slot(d.id, task_id, Some(d.n_decoded));
                self.phase = InferencePhase::PP;
                self.log_request_open = true;
                self.log_prefill_done = false;
                self.ensure_request_clock();
                self.engine_state = EngineState::Active;
                // NewPrompt log often lands before the first /slots poll that sees is_processing.
                // reset_prefill_counters() clears prefill_tokens_total and disables /slots progress
                // until print_timing PP (~70% on long prefills).
                if !(self.lp_reset_prompt && self.prefill_tokens_total > 0) {
                    self.reset_prefill_counters();
                }
            }

            if d.ended_session {
                if d.request_tokens_on_end > 0 {
                    self.capture_ttft_if_unset();
                }
                if let Some(s) = self.slot_states.get_mut(&d.id) {
                    // Pure generated tokens for the "gen per session" stats (separate from ctx fill bars)
                    s.total_tokens_lifetime += d.request_tokens_on_end;
                }
                self.session_tokens_generated += d.request_tokens_on_end;
                // Freeze per-request wall clock immediately — micro-stats must not tick after slot ends.
                self.stop_request_clock();
                self.tg_start_time = None;
                // Micro idle between agent turns — defer phase reset until hold expires.
                if !self.within_inter_request_hold(now) && !self.log_request_open {
                    self.log_prefill_done = false;
                    self.phase = InferencePhase::Idle;
                    self.prompt_tokens = 0;
                    self.tg_start_n_decoded = 0;
                    self.reset_prefill_counters();
                }
            }

            if d.is_proc {
                if self
                    .slot_states
                    .get(&d.id)
                    .map(|s| d.n_decoded > s.request_start_n_decoded)
                    .unwrap_or(false)
                {
                    saw_first_decode = true;
                }
            }

            // Update slot state from live /slots data.
            if let Some(s) = self.slot_states.get_mut(&d.id) {
                let new_val = d.n_decoded;

                // Update current prompt snapshot for this slot (for prefill + ctx bars)
                s.current_prompt_tokens = d.prompt_tokens;
                s.current_prompt_processed = d.prompt_tokens_processed;
                s.current_prompt_cache = d.prompt_tokens_cache;

                if d.n_ctx > 0 {
                    s.n_ctx_slot = d.n_ctx;
                }
                apply_log_primary_ctx_live(s, d.n_decoded, d.is_proc);

                s.prev_n_decoded = new_val;
                s.prev_timestamp = now;
                s.was_processing = d.is_proc;
                if let Some(tid) = slots.iter().find(|sl| sl.id == d.id).and_then(|sl| sl.id_task) {
                    s.current_task_id = Some(tid);
                }
            }

        }

        if saw_first_decode {
            self.capture_ttft_if_unset();
        }

        if any_processing {
            self.touch_slot_activity(now);
        } else if self.log_request_open {
            // All engine slots idle — safe to close global request belt (multi-slot: one stop must not clear).
            self.finalize_request_meters(slots);
        }

        self.update_prefill_from_slots(slots);
        self.reconcile_phase(slots, any_processing, now);
        let (_, prefill_tokens_tick) = self.merged_prefill_display();
        self.tick_pp_session_avg(slots, prefill_tokens_tick);
        self.tick_tg_session_avg(slots);
        self.update_instant_tps(slots, now);

        let seen_ids: HashSet<usize> = slots.iter().map(|s| s.id).collect();
        self.slot_states.retain(|id, _| seen_ids.contains(id));

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

        // Capture TG start when /slots first shows real generation this request.
        if self.phase == InferencePhase::Tg && self.tg_start_time.is_none() {
            self.capture_ttft_if_unset();
            let mut total_at_transition: usize = 0;
            for slot in slots {
                if !slot.next_token.is_empty() {
                    total_at_transition += slot.next_token[0].n_decoded;
                }
            }
            if total_at_transition == 0 {
                total_at_transition = self
                    .slot_states
                    .values()
                    .map(|s| s.request_start_n_decoded)
                    .sum();
            }
            self.tg_start_n_decoded = total_at_transition;
            self.tg_start_time = Some(now);
        }

        // Update last known gen TPS — store for use during phase transitions / after request end.
        if !self.request_closed {
            if let Some(start) = self.tg_start_time {
                let tokens_generated = self.per_request_gen_tokens(slots);
                let elapsed_ms = start.elapsed().as_millis() as u64;
                if elapsed_ms > 0 && tokens_generated > 0 {
                    self.last_gen_tps =
                        (tokens_generated as f64) / (elapsed_ms as f64 / 1000.0);
                }
            }
        }

        // Idle tail after TG — lp_gen_tps can keep phase TG until stop log; freeze once hold expires.
        if !any_processing
            && !self.request_closed
            && self.request_start.is_some()
            && self.log_prefill_done
            && !self.within_inter_request_hold(now)
        {
            self.finalize_request_meters(slots);
        }

    }

    // ── Build FusionUpdate from current state + fresh poll data ─────

    fn build_update(
        &self,
        slots: &[crate::fusion::poller::SlotData],
        metrics: Option<&MetricsSnapshot>,
    ) -> FusionUpdate {
        // Compute total n_decoded across all slots
        let mut total_n_decoded: usize = 0;
        for slot in slots {
            if !slot.next_token.is_empty() {
                total_n_decoded += slot.next_token[0].n_decoded;
            }
        }

        let request_live = self.request_start.is_some();

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

        // Gen TPS (hero AVG): live during request; pinned after finalize (no post-end decay).
        let gen_tps = if self.request_closed {
            if self.frozen_request_gen_tps > 0.0 {
                self.frozen_request_gen_tps
            } else {
                self.last_gen_tps
            }
        } else if request_live && self.effective_generation_active() {
            if let Some(start) = self.tg_start_time {
                let tokens_since_tg = self.per_request_gen_tokens(slots);
                let elapsed_ms = start.elapsed().as_millis() as u64;
                if tokens_since_tg > 0 && elapsed_ms >= MIN_TG_PER_REQUEST_AVG_MS {
                    clamp_display_tps(
                        (tokens_since_tg as f64) / (elapsed_ms as f64 / 1000.0),
                    )
                } else {
                    0.0
                }
            } else if self.lp_gen_tps > 0.0 {
                clamp_display_tps(self.lp_gen_tps)
            } else {
                0.0
            }
        } else if self.last_gen_tps > 0.0 {
            self.last_gen_tps
        } else {
            0.0
        };

        // Prefill TPS from /metrics gauge
        let prefill_tps_metrics = metrics.map(|m| m.prompt_tps_gauge).unwrap_or(0.0);

        // Context usage — log-primary per slot; engine-level % = peak slot fill vs per-slot budget.
        let fallback_per_slot = default_ctx_per_slot(self.ctx_total, self.parallel);
        let mut ctx_per_slot = fallback_per_slot;
        let mut peak_slot_used: usize = 0;
        let mut ctx_fill_pct = 0.0_f64;
        for (_id, s) in &self.slot_states {
            if s.n_ctx_slot > 0 {
                ctx_per_slot = s.n_ctx_slot;
            }
            peak_slot_used = peak_slot_used.max(s.session_n_decoded);
            let denom = if s.n_ctx_slot > 0 {
                s.n_ctx_slot
            } else {
                fallback_per_slot
            };
            if denom > 0 && s.session_n_decoded > 0 {
                let pct = (s.session_n_decoded as f64 / denom as f64) * 100.0;
                ctx_fill_pct = ctx_fill_pct.max(pct);
            }
        }
        if ctx_per_slot == 0 {
            for slot in slots {
                if slot.n_ctx > 0 {
                    ctx_per_slot = slot.n_ctx;
                    break;
                }
            }
        }
        if ctx_per_slot == 0 {
            ctx_per_slot = fallback_per_slot;
        }
        let ctx_used_session = if peak_slot_used > 0 {
            peak_slot_used
        } else {
            total_n_decoded
        };

        let request_elapsed_ms = if let Some(start) = self.request_start {
            start.elapsed().as_millis() as u64
        } else {
            self.request_elapsed_frozen_ms
        };

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
                n_ctx_slot: if s.n_ctx_slot > 0 {
                    s.n_ctx_slot
                } else {
                    ctx_per_slot
                },
            })
            .collect();
        slot_ctx.sort_by_key(|s| s.id);

        // Overlay fresh /slots data — is_processing must mirror poll exactly (multi-client slot switch).
        for slot in slots {
            if let Some(info) = slot_ctx.iter_mut().find(|i| i.id == slot.id) {
                if !slot.next_token.is_empty() {
                    let t = &slot.next_token[0];
                    info.n_remain = t.n_remain;
                }
                info.id_task = slot.id_task;
                info.speculative = slot.speculative;
                info.is_processing = slot.is_processing;
                if slot.n_ctx > 0 {
                    info.n_ctx_slot = slot.n_ctx;
                }
                if slot.is_processing {
                    info.prompt_tokens = slot.n_prompt_tokens;
                    info.prompt_tokens_processed = slot.n_prompt_tokens_processed;
                    info.prompt_tokens_cache = slot.n_prompt_tokens_cache;
                    if !slot.next_token.is_empty() {
                        info.n_decoded = slot.next_token[0].n_decoded;
                    }
                }
                // IK /slots omits prompt fields — surface log belt fill only on the busy slot.
                if info.is_processing
                    && info.prompt_tokens == 0
                    && info.prompt_tokens_processed == 0
                    && info.prompt_tokens_cache == 0
                {
                    if let Some(s) = self.slot_states.get(&slot.id) {
                        if s.log_prompt_fill > 0 {
                            info.prompt_tokens_processed = s.log_prompt_fill;
                        }
                    }
                }
            } else {
                slot_ctx.push(SlotCtxInfo {
                    id: slot.id,
                    n_decoded: slot
                        .next_token
                        .first()
                        .map(|t| t.n_decoded)
                        .unwrap_or(0),
                    session_n_decoded: self
                        .slot_states
                        .get(&slot.id)
                        .map(|s| s.session_n_decoded)
                        .unwrap_or(0),
                    total_tokens_lifetime: self
                        .slot_states
                        .get(&slot.id)
                        .map(|s| s.total_tokens_lifetime)
                        .unwrap_or(0),
                    is_processing: slot.is_processing,
                    prompt_tokens: slot.n_prompt_tokens,
                    prompt_tokens_processed: slot.n_prompt_tokens_processed,
                    prompt_tokens_cache: slot.n_prompt_tokens_cache,
                    n_remain: slot.next_token.first().map(|t| t.n_remain).unwrap_or(0),
                    id_task: slot.id_task,
                    speculative: slot.speculative,
                    n_ctx_slot: if slot.n_ctx > 0 {
                        slot.n_ctx
                    } else {
                        ctx_per_slot
                    },
                });
            }
        }
        slot_ctx.sort_by_key(|s| s.id);

        let (prefill_progress, prefill_tokens) = self.merged_prefill_display();

        // PP hero AVG: cumulative PP wall across bursts — not tokens/request_elapsed (spikes on SWA/file cadence).
        let mut prefill_tps_session = self.pp_session_avg_tps(slots, prefill_tokens);
        if prefill_tps_session <= 0.0 && self.prefill_tps_eval > 0.0 {
            prefill_tps_session = self.prefill_tps_eval;
        } else if prefill_tps_session <= 0.0 && self.lp_prefill_tps > 0.0 {
            prefill_tps_session = clamp_display_tps(self.lp_prefill_tps);
        }
        let gen_tps_session = self.tg_session_avg_tps(slots);

        FusionUpdate {
            alias: self.alias.clone(),
            slot_idx: self.slot_idx,
            port: self.port,
            engine_state: self.engine_state.clone(),
            phase: self.phase,
            prefill_tps_metrics: clamp_display_tps(prefill_tps_metrics),
            prefill_tps_session,
            prefill_tps_instant: clamp_display_tps(self.prefill_tps_instant),
            prefill_progress,
            prefill_tokens,
            prefill_tokens_total: self.prefill_tokens_total,
            gen_tps: clamp_display_tps(gen_tps),
            gen_tps_session,
            gen_tps_instant: clamp_display_tps(self.gen_tps_instant),
            gen_tokens_per_request_slots: gen_tokens_request_slots,
            gen_tokens_per_session: self.session_tokens_generated,
            ctx_used_session: ctx_used_session,
            ctx_fill_pct,
            ctx_total: self.ctx_total,
            ctx_per_slot,
            request_elapsed_ms,
            ttft_ms: self.ttft_ms,
            prefill_ms: self.prefill_ms,
            decode_ttft_ms: self.decode_ttft_ms,
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
            spec_draft_accept_rate: self.spec_draft_accept_rate,
            spec_draft_accepted: self.spec_draft_accepted_total,
            spec_draft_generated: self.spec_draft_generated_total,
            spec_draft_accept_rate_last: self.spec_draft_accept_rate_last,
            spec_draft_accepted_last: self.spec_draft_accepted_last,
            spec_draft_generated_last: self.spec_draft_generated_last,
            request_closed: self.request_closed,
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
        update.spec_draft_accept_rate = None;
        update.spec_draft_accepted = 0;
        update.spec_draft_generated = 0;
        update.spec_draft_accept_rate_last = None;
        update.spec_draft_accepted_last = None;
        update.spec_draft_generated_last = None;
        // Note: lp_reset_source stays as computed by build_update above (shows last reset source)
        update
    }
}

// ── Last emitted snapshot cache (frontend rehydrate after HMR / remount) ──

static FUSION_SNAPSHOT_CACHE: std::sync::LazyLock<
    parking_lot::Mutex<HashMap<usize, FusionUpdate>>,
> = std::sync::LazyLock::new(|| parking_lot::Mutex::new(HashMap::new()));

fn cache_fusion_snapshot(update: &FusionUpdate) {
    FUSION_SNAPSHOT_CACHE
        .lock()
        .insert(update.slot_idx, update.clone());
}

fn remove_fusion_snapshot(slot_idx: usize) {
    FUSION_SNAPSHOT_CACHE.lock().remove(&slot_idx);
}

/// Return last emitted FusionUpdate per active slot — used to rehydrate frontend listeners.
#[tauri::command]
pub fn get_fusion_snapshots() -> Vec<FusionUpdate> {
    FUSION_SNAPSHOT_CACHE.lock().values().cloned().collect()
}

// ── Fusion task registry (replaces old global FUSION_TASKS) ─────────

use tokio::sync::Mutex as TokioMutex;

/// Inbound messages to a running FusionBrain task (stderr logs + bench phase boundaries).
pub enum BrainInbound {
    Log(crate::fusion::log::LogEvent),
    BenchMeterReset(Option<tokio::sync::oneshot::Sender<()>>),
    /// Bench HTTP returned — freeze meters before trailing print_timing / stop log.
    BenchMeterFreeze(Option<tokio::sync::oneshot::Sender<()>>),
}

static BRAIN_REGISTRY: std::sync::LazyLock<
    TokioMutex<HashMap<usize, (tokio_util::task::AbortOnDropHandle<()>, tokio_util::sync::CancellationToken)>>,
> = std::sync::LazyLock::new(|| TokioMutex::new(HashMap::new()));

/// Registry of brain inbound senders — keyed by slot_idx.
/// Uses parking_lot Mutex so .lock() is safe inside both blocking & async contexts.
static BRAIN_INBOUND_SENDERS: std::sync::LazyLock<
    parking_lot::Mutex<HashMap<usize, tokio::sync::mpsc::Sender<BrainInbound>>>,
> = std::sync::LazyLock::new(|| parking_lot::Mutex::new(HashMap::new()));

/// Register this brain's inbound channel. Called from run() before polling starts.
pub fn register_brain_inbound(slot_idx: usize, tx: tokio::sync::mpsc::Sender<BrainInbound>) {
    let mut registry = BRAIN_INBOUND_SENDERS.lock();
    registry.insert(slot_idx, tx);
}

fn unregister_brain_inbound(slot_idx: usize) {
    let mut registry = BRAIN_INBOUND_SENDERS.lock();
    registry.remove(&slot_idx);
}

/// Route a parsed log event to the brain for the given slot (fire-and-forget, drops on full).
pub fn route_log_event(slot_idx: usize, event: crate::fusion::log::LogEvent) {
    let registry = BRAIN_INBOUND_SENDERS.lock();
    if let Some(tx) = registry.get(&slot_idx) {
        let _ = tx.try_send(BrainInbound::Log(event));
    }
}

/// Freeze fusion hero meters when a bench HTTP run completes (definitive for stream:false).
pub async fn freeze_request_meters_for_port(port: u16) {
    let slot_idx = FUSION_SNAPSHOT_CACHE
        .lock()
        .values()
        .find(|u| u.port == port)
        .map(|u| u.slot_idx);
    if let Some(idx) = slot_idx {
        let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
        let brain_tx = BRAIN_INBOUND_SENDERS.lock().get(&idx).cloned();
        if let Some(tx) = brain_tx {
            if tx.try_send(BrainInbound::BenchMeterFreeze(Some(ack_tx))).is_ok() {
                let _ = tokio::time::timeout(
                    std::time::Duration::from_millis(200),
                    ack_rx,
                )
                .await;
            }
        }
    }
}

/// Reset fusion hero meters at bench phase boundaries (warmup ↔ measured, TG → PP).
pub async fn reset_bench_meters_for_port(port: u16) {
    let slot_idx = FUSION_SNAPSHOT_CACHE
        .lock()
        .values()
        .find(|u| u.port == port)
        .map(|u| u.slot_idx);
    if let Some(idx) = slot_idx {
        let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
        let brain_tx = BRAIN_INBOUND_SENDERS.lock().get(&idx).cloned();
        if let Some(tx) = brain_tx {
            if tx.try_send(BrainInbound::BenchMeterReset(Some(ack_tx))).is_ok() {
                let _ = tokio::time::timeout(
                    std::time::Duration::from_millis(200),
                    ack_rx,
                )
                .await;
            }
        }
    }
}

/// Start a fusion brain for an engine. Keyed by slot_idx.
pub async fn start_brain(log_hub: LogHub, config: FusionConfig) {
    log::info!(
        "[fusion] slot={} provider={} adapter={} port={}",
        config.slot_idx,
        config.provider_id,
        config.adapter.as_str(),
        config.port
    );
    let mut registry = BRAIN_REGISTRY.lock().await;

    if let Some((_, cancel)) = registry.remove(&config.slot_idx) {
        cancel.cancel();
    }
    // Clear old inbound sender so events between cancel and new register don't route to dead channel
    {
        let mut senders = BRAIN_INBOUND_SENDERS.lock();
        senders.remove(&config.slot_idx);
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
    // Also clean up inbound channel for this slot
    {
        let mut senders = BRAIN_INBOUND_SENDERS.lock();
        senders.remove(&slot_idx);
    }
    registry::unregister_slot_adapter(slot_idx);
    remove_fusion_snapshot(slot_idx);
}

/// Stop all fusion brains. Call on app shutdown.
pub async fn stop_all_brains() {
    let mut registry = BRAIN_REGISTRY.lock().await;
    for (_slot_idx, (_, cancel)) in registry.drain() {
        // Fusion brain stopping now routed to Blackwell Output Console
        cancel.cancel();
    }
    // Drain all inbound channels too
    {
        let mut senders = BRAIN_INBOUND_SENDERS.lock();
        senders.clear();
    }
    registry::clear_slot_adapters();
    FUSION_SNAPSHOT_CACHE.lock().clear();
}
