//! Emit / presentation layer — the curated `FusionUpdate` contract + emit-on-change fingerprint
//! + the last-snapshot cache used to rehydrate frontend listeners.
//!
//! Extracted from `brain.rs` (Option D decomposition). Pure data + serialization: no mutable
//! brain state lives here. `FusionBrain` builds a `FusionUpdate`, fingerprints it, and calls
//! `cache_fusion_snapshot`; the snapshot cache is keyed by slot_idx for HMR/remount rehydrate.

use std::collections::HashMap;

use serde::Serialize;

use crate::fusion::brain::{EngineState, InferencePhase};
use crate::fusion::meter::FusionMeterLane;

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
    /// Speculative draft family — "mtp" | "dflash" | "dspark" (from `common_specu` log line).
    #[serde(rename = "specMode", skip_serializing_if = "Option::is_none")]
    pub spec_mode: Option<String>,

    /// Reset source indicator — "prompt" if NewPrompt caught request start (belt), "regression" if fallback detected (suspenders). Flashes for visual feedback then clears on next PP line.
    #[serde(rename = "phaseResetSource", skip_serializing_if = "Option::is_none")]
    pub lp_reset_source: Option<&'static str>,  // Some("prompt") or Some("regression")

    /// Wall clock + hero AVG/LIVE must not tick after request end (bench HTTP return, stop processing, idle tail).
    #[serde(rename = "requestClosed")]
    pub request_closed: bool,

    /// Hero meter lane — parallel bench uses poll-only aggregate wall clock (stderr is per-slot).
    #[serde(rename = "meterLane")]
    pub meter_lane: FusionMeterLane,
    #[serde(rename = "busySlotCount")]
    pub busy_slot_count: usize,
    /// Peak concurrent busy slots this wave (latched) — denominator for per-slot TPS.
    #[serde(rename = "concurrentSlots")]
    pub concurrent_slots: usize,
    /// System TG tok/s ÷ concurrent slots — “per agent” rate under multi-slot load.
    #[serde(rename = "genTpsPerSlot")]
    pub gen_tps_per_slot: f64,
    /// LIVE counterpart of genTpsPerSlot (poll instant ÷ concurrent).
    #[serde(rename = "genTpsPerSlotInstant")]
    pub gen_tps_per_slot_instant: f64,
    /// Monotonic boundary id — bumps on NewPrompt / bench meter reset (FE edge-triggered wipe).
    #[serde(rename = "meterSeq")]
    pub meter_seq: u64,
}

/// Quantized snapshot for emit-on-change (avoids ~10 Hz identical fusion-update IPC).
#[derive(Clone, PartialEq, Eq)]
pub struct FusionEmitFingerprint {
    pub engine_state_tag: u8,
    pub phase_tag: u8,
    pub prefill_progress_milli: u32,
    pub prefill_tokens: u32,
    pub prefill_tokens_total: u32,
    pub prefill_tps_session_centi: u32,
    pub prefill_tps_instant_centi: u32,
    pub prefill_tps_metrics_centi: u32,
    pub gen_tps_deci: u32,
    pub gen_tps_session_deci: u32,
    pub gen_tps_instant_deci: u32,
    pub gen_tokens_request: u32,
    pub gen_tokens_session: u32,
    pub ctx_used: u32,
    pub ctx_fill_centi: u32,
    pub request_elapsed_ms: u64,
    pub ttft_ms: u64,
    pub prefill_ms: u64,
    pub decode_ttft_ms: u64,
    pub slot_ctx_hash: u64,
    pub log_progress_milli: u32,
    pub log_pp_tps_centi: u32,
    pub log_prompt_tokens: u32,
    pub log_gen_tps_deci: u32,
    pub log_phase_tag: u8,
    pub spec_draft_accept_rate_milli: u32,
    pub spec_draft_accepted: u64,
    pub spec_draft_generated: u64,
    pub meter_seq: u64,
    pub concurrent_slots: u32,
    pub gen_tps_per_slot_deci: u32,
}

impl FusionEmitFingerprint {
    pub fn from_update(u: &FusionUpdate) -> Self {
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
            meter_seq: u.meter_seq,
            concurrent_slots: u.concurrent_slots.min(u32::MAX as usize) as u32,
            gen_tps_per_slot_deci: (u.gen_tps_per_slot * 10.0).round() as u32,
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

// ── Last emitted snapshot cache (frontend rehydrate after HMR / remount) ──

static FUSION_SNAPSHOT_CACHE: std::sync::LazyLock<parking_lot::Mutex<HashMap<usize, FusionUpdate>>> =
    std::sync::LazyLock::new(|| parking_lot::Mutex::new(HashMap::new()));

pub fn cache_fusion_snapshot(update: &FusionUpdate) {
    FUSION_SNAPSHOT_CACHE
        .lock()
        .insert(update.slot_idx, update.clone());
}

pub fn remove_fusion_snapshot(slot_idx: usize) {
    FUSION_SNAPSHOT_CACHE.lock().remove(&slot_idx);
}

/// Return last emitted FusionUpdate per active slot — used to rehydrate frontend listeners.
#[tauri::command]
pub fn get_fusion_snapshots() -> Vec<FusionUpdate> {
    FUSION_SNAPSHOT_CACHE.lock().values().cloned().collect()
}

/// Map an engine port → the slot_idx of its last emitted snapshot (used by brain registry ops).
pub fn find_slot_idx_for_port(port: u16) -> Option<usize> {
    FUSION_SNAPSHOT_CACHE
        .lock()
        .values()
        .find(|u| u.port == port)
        .map(|u| u.slot_idx)
}

/// Clear the whole snapshot cache (app shutdown).
pub fn clear_snapshots() {
    FUSION_SNAPSHOT_CACHE.lock().clear();
}
