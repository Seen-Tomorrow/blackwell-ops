//! FUSION — Real-time engine monitoring via /slots polling + fusion events.
//!
//! One tokio task per running engine. Polls http://localhost:{port}/slots at 100ms,
//! receives FusionEvents from the unified reader (prompt progress, TTFT, phase changes).
//! Emits "fusion-update" Tauri events with structured FusionUpdate data.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use tokio::sync::mpsc;

use crate::perf_monitor::FusionEvent;
use crate::log_hub::LogHub;

// ── Raw /slots JSON types ────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct RawSlots {
    next_token: Option<Vec<RawNextToken>>,
}

#[derive(serde::Deserialize)]
struct RawNextToken {
    n_decoded: usize,
    n_remain: i64,
    has_next_token: bool,
}

#[derive(serde::Deserialize)]
struct RawSlotParams {
    max_tokens: i64,
    n_predict: i64,
}

#[derive(serde::Deserialize)]
struct RawSlot {
    id: usize,
    #[allow(dead_code)]
    n_ctx: usize,
    is_processing: bool,
    params: Option<RawSlotParams>,
    next_token: Option<Vec<RawNextToken>>,
}

// ── Per-slot CTX info emitted to frontend ───────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct SlotCtxInfo {
    /// Slot ID (0-based)
    pub id: usize,
    /// Cumulative n_decoded for this slot since launch
    pub n_decoded: usize,
    /// Tokens generated in current request for this slot (n_decoded - session_start_n_decoded)
    pub request_tokens: usize,
    /// Cumulative tokens across all requests for this slot's lifetime
    pub total_tokens: usize,
    /// Whether this slot is currently processing a request
    pub is_processing: bool,
}

// ── FusionUpdate emitted to frontend ─────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct FusionUpdate {
    /// Engine alias for identification (may not be unique — use slot_idx instead)
    pub alias: String,
    /// Unique engine slot index (0-based, never duplicated)
    #[serde(rename = "slotIdx")]
    pub slot_idx: usize,
    /// Engine port (also used as task key)
    pub port: u16,
    /// Engine lifecycle state
    pub engine_state: String, // "LOADING" | "READY" | "BUSY" | "IDLE" | "ERROR"

    // ── Real-time metrics from /slots polling ──
    /// Instantaneous TPS (delta n_decoded / delta time) — TG-phase only
    pub tps: f64,
    /// Adaptive EMA smoothed TPS — starts raw, flattens over ~20 samples
    #[serde(rename = "smoothedTps")]
    pub smoothed_tps: f64,
    /// Prefill TPS captured during PP phase (0.0 when not in prefill)
    #[serde(rename = "prefillTps")]
    pub prefill_tps: f64,
    /// Prefill progress 0.0-1.0 from "prompt processing progress" logs
    #[serde(rename = "prefillProgress")]
    pub prefill_progress: f64,
    /// Current inference phase: "PP" (prompt processing), "TG" (token generation), "" (idle)
    pub phase: String,
    /// Cumulative context tokens used (n_decoded across all slots)
    pub ctx_used: usize,
    /// Context window size per slot (n_ctx)
    pub ctx_total: usize,
    /// Context fill percentage 0-100 (aggregate)
    pub ctx_fill_pct: f64,

    // ── Per-request tracking (fused from logs + slots) ──
    /// Tokens generated in current request
    pub request_tokens_gen: usize,
    /// Prompt tokens in current request
    pub request_tokens_prompt: usize,
    /// Wall-clock ms since current request started
    pub request_elapsed_ms: u64,
    /// Time to first token from logs (ms)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_ttft_ms: Option<f64>,

    // ── Generation progress ──
    /// Tokens remaining in current generation (-1 = unlimited)
    pub n_remain: i64,
    /// Max tokens limit from params (max_tokens or n_predict)
    pub max_tokens: i64,
    /// Generation progress percentage 0-100
    pub gen_progress_pct: f64,

    // ── Slot-level overview ──
    /// Number of slots this engine has
    pub slot_count: usize,
    /// How many slots are currently is_processing
    pub active_slots: usize,
    /// Per-slot CTX usage for individual bars
    #[serde(rename = "slotCtx")]
    pub slot_ctx: Vec<SlotCtxInfo>,

    // ── Engine config flags ──
    /// Number of parallel slots configured (--parallel)
    pub parallel: i64,
    /// Whether KV cache is shared across slots (--unified-kv)
    pub unified_kv: bool,

    // ── TPS history for sparkline (last 50 samples) ──
    #[serde(rename = "tpsHistory")]
    pub tps_history: Vec<f64>,
}

// ── Per-slot tracking state ──────────────────────────────────────────

struct SlotState {
    prev_n_decoded: usize,
    prev_timestamp: std::time::Instant,
    session_start_n_decoded: usize,
    was_processing: bool,
    total_tokens_lifetime: usize,
}

impl SlotState {
    fn new() -> Self {
        Self {
            prev_n_decoded: 0,
            prev_timestamp: std::time::Instant::now(),
            session_start_n_decoded: 0,
            was_processing: false,
            total_tokens_lifetime: 0,
        }
    }
}

// ── Per-engine fusion state ──────────────────────────────────────────

struct FusionEngineState {
    alias: String,
    slot_idx: usize,
    port: u16,
    ctx_total: usize,
    parallel: i64,
    unified_kv: bool,
    engine_state: String,
    phase: String,
    /// When did the current request start (wall clock)
    request_start: Option<std::time::Instant>,
    /// Prompt token count for current request (from logs)
    request_tokens_prompt: usize,
    /// TTFT from log parsing
    request_ttft_ms: Option<f64>,
    /// Max tokens limit from /slots params
    max_tokens: i64,
    /// Per-slot state
    slots: HashMap<usize, SlotState>,
    /// Rolling TPS history (last 50 samples) — TG-phase only for sparkline
    tps_history: VecDeque<f64>,
    /// Adaptive EMA smoothed TPS — resets per request
    smoothed_tps: f64,
    /// Sample counter for adaptive alpha — resets per request
    tps_sample_count: u32,
    /// Last captured prefill TPS during PP phase
    prefill_tps: f64,
    /// Current prefill progress (0.0-1.0) from "prompt processing progress" logs
    prefill_progress: f64,
    /// Timestamp of first progress line for running TPS computation
    prefill_start_time: Option<std::time::Instant>,
}

impl FusionEngineState {
    fn new(alias: String, slot_idx: usize, port: u16, ctx_total: usize, parallel: i64, unified_kv: bool) -> Self {
        Self {
            alias,
            slot_idx,
            port,
            ctx_total,
            parallel,
            unified_kv,
            engine_state: "LOADING".to_string(),
            phase: String::new(),
            request_start: None,
            request_tokens_prompt: 0,
            request_ttft_ms: None,
            max_tokens: -1,
            slots: HashMap::new(),
            tps_history: VecDeque::with_capacity(50),
            smoothed_tps: 0.0,
            tps_sample_count: 0,
            prefill_tps: 0.0,
            prefill_progress: 0.0,
            prefill_start_time: None,
        }
    }

    fn get_or_create_slot(&mut self, slot_id: usize) -> &mut SlotState {
        self.slots.entry(slot_id).or_insert_with(SlotState::new)
    }
}

// ── Compiled regex patterns for log fusion (kept for potential future use) ──

#[allow(dead_code)]
static NEW_PROMPT_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
#[allow(dead_code)]
static PROMPT_EVAL_TIME_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
#[allow(dead_code)]
static STOP_PROCESSING_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
#[allow(dead_code)]
static ALL_IDLE_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
#[allow(dead_code)]
static PROMPT_PROGRESS_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();

#[allow(dead_code)]
fn new_prompt_re() -> &'static regex::Regex {
    NEW_PROMPT_RE.get_or_init(|| {
        regex::Regex::new(r"new prompt.*?task\.n_tokens\s*=\s*(\d+)").unwrap()
    })
}

#[allow(dead_code)]
fn prompt_eval_time_re() -> &'static regex::Regex {
    PROMPT_EVAL_TIME_RE.get_or_init(|| {
        regex::Regex::new(
            r"prompt eval time\s*=\s*(\d+\.\d+)\s+ms\s*/\s*(\d+)\s+tokens.*?(\d+\.\d+)\s+tokens per second",
        )
        .unwrap()
    })
}

#[allow(dead_code)]
fn stop_processing_re() -> &'static regex::Regex {
    STOP_PROCESSING_RE.get_or_init(|| {
        regex::Regex::new(r"stop processing:\s*n_tokens\s*=\s*(\d+)").unwrap()
    })
}

#[allow(dead_code)]
fn all_idle_re() -> &'static regex::Regex {
    ALL_IDLE_RE.get_or_init(|| {
        regex::Regex::new(r"all slots are idle").unwrap()
    })
}

#[allow(dead_code)]
fn prompt_progress_re() -> &'static regex::Regex {
    PROMPT_PROGRESS_RE.get_or_init(|| {
        regex::Regex::new(r"prompt processing progress.*?progress\s*=\s*(\d+\.\d+)").unwrap()
    })
}

// ── Global task registry: port → (AbortOnDropHandle, CancellationToken) ─

static FUSION_TASKS: std::sync::LazyLock<
    tokio::sync::Mutex<HashMap<u16, (tokio_util::task::AbortOnDropHandle<()>, tokio_util::sync::CancellationToken)>>,
> = std::sync::LazyLock::new(|| tokio::sync::Mutex::new(HashMap::new()));

// ── Public API ───────────────────────────────────────────────────────

/// Start the FUSION HTTP poller for an engine.
/// Consumes FusionEvents from the unified reader and polls /slots via HTTP.
pub async fn start_fusion_http_poller(
    log_hub: LogHub,
    alias: String,
    slot_idx: usize,
    port: u16,
    ctx_total: usize,
    parallel: i64,
    unified_kv: bool,
    fusion_rx: mpsc::UnboundedReceiver<FusionEvent>,
) {
    let mut tasks = FUSION_TASKS.lock().await;

    // Cancel existing task for this port if any
    if let Some((_, cancel)) = tasks.remove(&port) {
        cancel.cancel();
    }

    eprintln!(
        "[FUSION] Starting HTTP poller: alias={} slot={} port={} ctx_total={} parallel={} unified_kv={}",
        alias, slot_idx, port, ctx_total, parallel, unified_kv
    );

    let cancel = tokio_util::sync::CancellationToken::new();
    let cancel_spawn = cancel.clone();

    let handle = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
        fusion_http_poll_loop(log_hub, alias, slot_idx, port, ctx_total, parallel, unified_kv, fusion_rx, cancel_spawn).await;
    }));

    tasks.insert(port, (handle, cancel));
}

/// Stop the FUSION monitoring task for an engine by port.
pub async fn stop_fusion_task(port: u16) {
    let mut tasks = FUSION_TASKS.lock().await;
    if let Some((_, cancel)) = tasks.remove(&port) {
        eprintln!("[FUSION] Stopping monitor: port={}", port);
        cancel.cancel(); // Graceful exit via cancellation token
    }
}

/// Stop all FUSION monitoring tasks. Call on app shutdown.
pub async fn stop_all_fusion_tasks() {
    let mut tasks = FUSION_TASKS.lock().await;
    for (port, (_, cancel)) in tasks.drain() {
        eprintln!("[FUSION] Stopping monitor: port={}", port);
        cancel.cancel();
    }
}

// ── Main poll loop ───────────────────────────────────────────────────

async fn fusion_http_poll_loop(
    log_hub: LogHub,
    alias: String,
    slot_idx: usize,
    port: u16,
    ctx_total: usize,
    parallel: i64,
    unified_kv: bool,
    mut fusion_rx: mpsc::UnboundedReceiver<FusionEvent>,
    cancel: tokio_util::sync::CancellationToken,
) {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build()
        .unwrap_or_default();

    let mut state = FusionEngineState::new(alias.clone(), slot_idx, port, ctx_total, parallel, unified_kv);
    let poll_interval = tokio::time::Duration::from_millis(100);
    let mut interval = tokio::time::interval(poll_interval);

    /// Build a terminal (engine-stopped) FusionUpdate with zeroed metrics.
    fn build_terminal_update(state: &FusionEngineState, slot_idx: usize, port: u16) -> FusionUpdate {
        let total_n_decoded: usize = state.slots.values().map(|s| s.prev_n_decoded).sum();
        let slot_count = state.slots.len();
        let slot_ctx: Vec<SlotCtxInfo> = state.slots.iter()
            .map(|(id, s)| {
                SlotCtxInfo {
                    id: *id,
                    n_decoded: s.prev_n_decoded,
                    request_tokens: 0,
                    total_tokens: s.total_tokens_lifetime + s.prev_n_decoded.saturating_sub(s.session_start_n_decoded),
                    is_processing: false,
                }
            })
            .collect();

        FusionUpdate {
            alias: state.alias.clone(),
            slot_idx,
            port,
            engine_state: "IDLE".to_string(),
            tps: 0.0,
            smoothed_tps: 0.0,
            phase: String::new(),
            ctx_used: total_n_decoded,
            ctx_total: state.ctx_total,
            ctx_fill_pct: if state.ctx_total > 0 { (total_n_decoded as f64 / state.ctx_total as f64) * 100.0 } else { 0.0 },
            request_tokens_gen: 0,
            request_tokens_prompt: 0,
            request_elapsed_ms: 0,
            request_ttft_ms: None,
            n_remain: -1,
            max_tokens: -1,
            gen_progress_pct: 0.0,
            slot_count,
            active_slots: 0,
            slot_ctx,
            parallel: state.parallel,
            unified_kv: state.unified_kv,
            tps_history: state.tps_history.iter().copied().collect(),
            prefill_tps: 0.0,
            prefill_progress: 0.0,
        }
    }

    // Emit initial LOADING update immediately so frontend shows launch animation
    {
        let init_update = FusionUpdate {
            alias: alias.clone(),
            slot_idx,
            port,
            engine_state: "LOADING".to_string(),
            tps: 0.0,
            smoothed_tps: 0.0,
            phase: String::new(),
            ctx_used: 0,
            ctx_total,
            ctx_fill_pct: 0.0,
            request_tokens_gen: 0,
            request_tokens_prompt: 0,
            request_elapsed_ms: 0,
            request_ttft_ms: None,
            n_remain: -1,
            max_tokens: -1,
            gen_progress_pct: 0.0,
            slot_count: 0,
            active_slots: 0,
            slot_ctx: Vec::new(),
            parallel,
            unified_kv,
            tps_history: Vec::new(),
            prefill_tps: 0.0,
            prefill_progress: 0.0,
        };
        log_hub.emit("fusion-update", &init_update);
    }

    // Small delay to let server fully initialize after readiness signal
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    loop {
        tokio::select! {
            // ── Cancellation — emit terminal update so frontend clears stale overlay ──
            _ = cancel.cancelled() => {
                eprintln!("[FUSION] port={} cancelled, emitting terminal update", port);
                let term = build_terminal_update(&state, slot_idx, port);
                log_hub.emit("fusion-update", &term);
                return;
            }

            // ── /slots poll tick ──────────────────────────────────────
            _ = interval.tick() => {
                if state.phase == "PP" {
                    continue;
                }
                match poll_slots(&client, port, &mut state).await {
                    Ok(update) => {
                        log_hub.emit("fusion-update", &update);
                    }
                    Err(e) => {
                        if state.engine_state == "LOADING" {
                            // Emit heartbeat during loading so frontend animation stays alive
                            let update = build_update(&mut state, 0.0, Vec::new());
                            log_hub.emit("fusion-update", &update);
                        } else {
                            eprintln!("[FUSION] port={} poll error: {}", port, e);
                        }
                    }
                }
            }

            // ── Fusion event from unified reader ──────────────────────
            event = fusion_rx.recv() => {
                let event = match event {
                    Some(e) => e,
                    None => {
                        eprintln!("[FUSION] port={} fusion channel closed, emitting terminal update", port);
                        let term = build_terminal_update(&state, slot_idx, port);
                        log_hub.emit("fusion-update", &term);
                        return; // Unified reader stopped — exit poller
                    }
                };

                handle_fusion_event(&event, &mut state);

                // During PP phase, /slots polls may fail under heavy load.
                // Emit update on progress events so frontend gets real-time data.
                if matches!(event, FusionEvent::PromptProgress(_)) && state.phase == "PP" {
                    let update = build_update(&mut state, 0.0, Vec::new());
                    log_hub.emit("fusion-update", &update);
                }
            }
        }
    }
}

/// Handle a FusionEvent from the unified reader — updates fusion state.
fn handle_fusion_event(event: &FusionEvent, state: &mut FusionEngineState) {
    match event {
        FusionEvent::NewPrompt(prompt_tokens) => {
            state.request_tokens_prompt = *prompt_tokens;
            state.request_start = Some(std::time::Instant::now());
            state.prefill_tps = 0.0;
            state.prefill_progress = 0.0;
            state.prefill_start_time = None;
            state.smoothed_tps = 0.0;
            state.tps_sample_count = 0;
            state.phase = "PP".to_string();
        }

        FusionEvent::PromptProgress(progress) => {
            if state.phase.is_empty() {
                state.phase = "PP".to_string();
            }
            state.prefill_progress = *progress;
            let now = std::time::Instant::now();
            if state.prefill_start_time.is_none() {
                state.prefill_start_time = Some(now);
            }
            if let Some(start) = state.prefill_start_time {
                let elapsed_sec = now.duration_since(start).as_secs_f64();
                if elapsed_sec > 0.01 && state.request_tokens_prompt > 0 {
                    state.prefill_tps = (state.request_tokens_prompt as f64 * progress) / elapsed_sec;
                }
            }
        }

        FusionEvent::PromptEvalDone(ttft_ms, prefill_tps) => {
            state.request_ttft_ms = Some(*ttft_ms);
            if *prefill_tps > 0.0 {
                state.prefill_tps = *prefill_tps;
            } else if state.request_tokens_prompt > 0 && ttft_ms > &0.0 {
                state.prefill_tps = state.request_tokens_prompt as f64 / (ttft_ms / 1000.0);
            }
            if state.prefill_progress < 1.0 {
                state.prefill_progress = 1.0;
            }
            state.phase = "TG".to_string();
        }

        FusionEvent::StopProcessing => {
            state.phase = String::new();
            state.request_start = None;
            state.request_tokens_prompt = 0;
            state.request_ttft_ms = None;
            for s in state.slots.values_mut() {
                if s.prev_n_decoded > s.session_start_n_decoded {
                    s.total_tokens_lifetime += s.prev_n_decoded - s.session_start_n_decoded;
                }
                s.session_start_n_decoded = s.prev_n_decoded;
            }
        }

        FusionEvent::EngineReady => {
            if state.engine_state == "LOADING" {
                state.engine_state = "READY".to_string();
                eprintln!("[FUSION] port={} engine READY", state.port);
            }
        }
    }
}

// ── /slots polling ───────────────────────────────────────────────────

async fn poll_slots(
    client: &reqwest::Client,
    port: u16,
    state: &mut FusionEngineState,
) -> Result<FusionUpdate, String> {
    let url = format!("http://localhost:{}/slots", port);
    let slots: Vec<RawSlot> = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("HTTP error: {}", e))?
        .error_for_status()
        .map_err(|e| format!("Status error: {}", e))?
        .json::<Vec<RawSlot>>()
        .await
        .map_err(|e| format!("JSON parse: {}", e))?;

    let now = std::time::Instant::now();
    
    // First pass: read slot state and compute per-slot deltas (mutable borrow of slots map)
    struct SlotDelta {
        id: usize,
        n_decoded: usize,
        is_proc: bool,
        #[allow(dead_code)]
        n_remain: i64,
        tps: f64,
        #[allow(dead_code)]
        session_start_n_decoded: usize,
        was_processing: bool,
        new_session: bool,
        ended_session: bool,
    }

    let mut deltas: Vec<SlotDelta> = Vec::with_capacity(slots.len());

    for slot in &slots {
        let token_info = slot.next_token.as_ref().and_then(|v| v.first());
        let is_proc = slot.is_processing;

        // When next_token is None (slot idle), preserve last known prev_n_decoded
        // instead of zeroing it — this keeps delta calculations correct for parallel slots
        if let Some(info) = token_info {
            let n_decoded = info.n_decoded;
            let n_remain = info.n_remain;

            let s = state.get_or_create_slot(slot.id);
            let dt_sec = now.duration_since(s.prev_timestamp).as_secs_f64();

            let mut tps: f64 = 0.0;
            if n_decoded > s.prev_n_decoded && dt_sec > 0.01 {
                tps = (n_decoded - s.prev_n_decoded) as f64 / dt_sec;
            }

            let new_session = is_proc && !s.was_processing;
            let ended_session = !is_proc && s.was_processing;

            deltas.push(SlotDelta {
                id: slot.id,
                n_decoded,
                is_proc,
                n_remain,
                tps,
                session_start_n_decoded: s.session_start_n_decoded,
                was_processing: s.was_processing,
                new_session,
                ended_session,
            });

            // Update slot state in-place
            if new_session {
                s.session_start_n_decoded = n_decoded;
            }
            s.prev_n_decoded = n_decoded;
            s.prev_timestamp = now;
            s.was_processing = is_proc;
        } else {
            // No token data — slot idle, preserve last known state
            let s = state.get_or_create_slot(slot.id);
            let ended_session = !is_proc && s.was_processing;

            deltas.push(SlotDelta {
                id: slot.id,
                n_decoded: s.prev_n_decoded,  // keep last known value
                is_proc: false,
                n_remain: -1,
                tps: 0.0,
                session_start_n_decoded: s.session_start_n_decoded,
                was_processing: s.was_processing,
                new_session: false,
                ended_session,
            });

            // Don't touch prev_n_decoded or session_start_n_decoded — preserve them
            s.prev_timestamp = now;
            s.was_processing = false;
        }
    }

    // Second pass: apply state changes (no overlapping borrows)
    let mut total_tps: f64 = 0.0;
    let mut any_processing = false;

    for d in &deltas {
        // Update max_tokens from params
        if let Some(params) = slots.iter().find(|s| s.id == d.id).and_then(|s| s.params.as_ref()) {
            let mt = if params.max_tokens > 0 {
                params.max_tokens
            } else if params.n_predict > 0 {
                params.n_predict
            } else {
                -1
            };
            state.max_tokens = mt;
        }

        if d.new_session {
            state.request_start = Some(now);
            // Reset TPS smoothing for new request
            state.tps_sample_count = 0;
            state.smoothed_tps = 0.0;
            // Only set phase from /slots when logs haven't already determined it
            if state.phase.is_empty() {
                state.phase = "TG".to_string();
            }
        }

        if d.ended_session {
            // Accumulate this request's tokens into lifetime total for this slot
            let slot_state = state.slots.get_mut(&d.id).unwrap();
            slot_state.total_tokens_lifetime += d.n_decoded.saturating_sub(d.session_start_n_decoded);

            state.phase = String::new();
            state.request_start = None;
            state.request_tokens_prompt = 0;
            state.request_ttft_ms = None;
            // Don't reset prefill_tps here — /slots ended_session is unreliable during cont-batching.
            // Only the "stop processing" log handler resets it (authoritative request-end signal).
        }

        if d.is_proc {
            any_processing = true;
            // Phase is driven by log lines ("prompt processing progress" → PP, "prompt eval time"/"prompt processing done" → TG)
            // /slots poll only captures TPS split — doesn't override phase from logs
        }

        if state.phase != "PP" {
            total_tps += d.tps;
        }
    }

    // Update engine state
    if state.engine_state == "LOADING" && !any_processing {
        state.engine_state = "READY".to_string();
    } else if any_processing {
        state.engine_state = "BUSY".to_string();
    } else if state.engine_state == "BUSY" {
        state.engine_state = "READY".to_string();
    }

    Ok(build_update(state, total_tps, slots.iter().map(|s| s.id).collect()))
}

fn build_update(
    state: &mut FusionEngineState,
    instant_tps: f64,
    _slot_ids: Vec<usize>,
) -> FusionUpdate {
    // Update TPS history — only TG-phase samples for clean sparkline
    let mut smoothed = instant_tps;
    if state.phase != "PP" && instant_tps > 0.0 {
        state.tps_history.push_back(instant_tps);
        if state.tps_history.len() > 50 {
            state.tps_history.pop_front();
        }
        // Adaptive EMA: alpha decays from ~1.0 (raw) to 0.15 floor over 20 samples
        state.tps_sample_count += 1;
        let alpha = (1.0 / state.tps_sample_count as f64).max(0.05);
        if state.smoothed_tps == 0.0 {
            smoothed = instant_tps;
        } else {
            smoothed = alpha * instant_tps + (1.0 - alpha) * state.smoothed_tps;
        }
        state.smoothed_tps = smoothed;
    }

    let total_n_decoded: usize = state.slots.values().map(|s| s.prev_n_decoded).sum();
    let active_slots = state.slots.values().filter(|s| s.was_processing).count();
    let slot_count = state.slots.len();

    // Compute tokens generated this request from delta since session start
    let mut request_tokens_gen: usize = 0;
    for s in state.slots.values() {
        request_tokens_gen += s.prev_n_decoded.saturating_sub(s.session_start_n_decoded);
    }

    // Request elapsed time
    let request_elapsed_ms = state
        .request_start
        .map(|start| start.elapsed().as_millis() as u64)
        .unwrap_or(0);

    // Context fill percentage
    let ctx_fill_pct = if state.ctx_total > 0 {
        (total_n_decoded as f64 / state.ctx_total as f64) * 100.0
    } else {
        0.0
    };

    // Generation progress from n_remain + max_tokens
    let _n_remain = state.slots.values().filter(|s| s.was_processing).fold(-1i64, |acc, _| {
        // We don't have per-slot n_remain here, use the global tracking
        acc
    });

    let gen_progress_pct = if state.max_tokens > 0 && request_tokens_gen > 0 {
        ((request_tokens_gen as f64 / state.max_tokens as f64) * 100.0).min(100.0)
    } else {
        0.0
    };

    // Determine effective n_remain for display
    let effective_n_remain = if state.max_tokens > 0 {
        state.max_tokens - request_tokens_gen as i64
    } else {
        -1
    };

    // Build per-slot CTX info for individual bars
    let mut slot_ctx: Vec<SlotCtxInfo> = state.slots.iter()
        .map(|(id, s)| {
            let current_session_tokens = s.prev_n_decoded.saturating_sub(s.session_start_n_decoded);
            SlotCtxInfo {
                id: *id,
                n_decoded: s.prev_n_decoded,
                request_tokens: current_session_tokens,
                total_tokens: s.total_tokens_lifetime + current_session_tokens,
                is_processing: s.was_processing,
            }
        })
        .collect();
    slot_ctx.sort_by_key(|s| s.id);

    FusionUpdate {
        alias: state.alias.clone(),
        slot_idx: state.slot_idx,
        port: state.port,
        engine_state: state.engine_state.clone(),
        tps: if state.phase == "PP" { 0.0 } else { instant_tps },
        smoothed_tps: if state.phase == "PP" { 0.0 } else { smoothed },
        prefill_tps: state.prefill_tps,
        prefill_progress: state.prefill_progress,
        phase: state.phase.clone(),
        ctx_used: total_n_decoded,
        ctx_total: state.ctx_total,
        ctx_fill_pct,
        request_tokens_gen,
        request_tokens_prompt: state.request_tokens_prompt,
        request_elapsed_ms,
        request_ttft_ms: state.request_ttft_ms,
        n_remain: effective_n_remain,
        max_tokens: state.max_tokens,
        gen_progress_pct,
        slot_count,
        active_slots,
        slot_ctx,
        parallel: state.parallel,
        unified_kv: state.unified_kv,
        tps_history: state.tps_history.iter().copied().collect(),
    }
}

// ── Log line processing for fusion ───────────────────────────────────

#[allow(dead_code)]
fn process_fusion_log_line(line: &str, state: &mut FusionEngineState) -> bool {
    let mut emitted_progress = false;
    // "new prompt, n_ctx_slot = X, task.n_tokens = Y" → request start + prompt token count
    if let Some(caps) = new_prompt_re().captures(line) {
        if let Some(n_tok_match) = caps.get(1) {
            if let Ok(prompt_tokens) = n_tok_match.as_str().parse::<usize>() {
                state.request_tokens_prompt = prompt_tokens;
                state.request_start = Some(std::time::Instant::now());
                // Reset prefill tracking for fresh request
                state.prefill_tps = 0.0;
                state.prefill_progress = 0.0;
                state.prefill_start_time = None;
                state.phase = "PP".to_string();
                eprintln!(
                    "[FUSION] port={} new request: {} prompt tokens",
                    state.port, prompt_tokens
                );
            }
        }
    }

    // "prompt processing progress ... progress = P" → real-time PP tracking
    // Also matches PERF_PULSE diagnostic lines: "[PERF_PULSE] slot=0 prompt progress: 33%"
    if line.contains("prompt processing progress") || line.contains("prompt progress:") {
        let progress = if let Some(caps) = prompt_progress_re().captures(line) {
            // Raw llama.cpp format: "progress = 0.985294"
            caps.get(1).and_then(|m| m.as_str().parse::<f64>().ok())
        } else {
            // PERF_PULSE format: "prompt progress: 33%"
            line.split("prompt progress:")
                .nth(1)
                .and_then(|s| s.trim().trim_end_matches('%').parse::<f64>().ok())
                .map(|p| p / 100.0)
        };

        if let Some(progress) = progress {
            emitted_progress = true;
            state.prefill_progress = progress;
            // Set phase to PP (authoritative signal from llama.cpp)
            if state.phase.is_empty() {
                state.phase = "PP".to_string();
            }
            // Track running prefill TPS: total_prompt_tokens * progress / elapsed_since_first_progress
            let now = std::time::Instant::now();
            if state.prefill_start_time.is_none() {
                state.prefill_start_time = Some(now);
            }
            if let Some(start) = state.prefill_start_time {
                let elapsed_sec = now.duration_since(start).as_secs_f64();
                if elapsed_sec > 0.01 && state.request_tokens_prompt > 0 {
                    state.prefill_tps = (state.request_tokens_prompt as f64 * progress) / elapsed_sec;
                }
            }
        }
    }

    // "prompt eval time = X ms / Y tokens ... Z tokens per second" → TTFT + PP→TG
    if let Some(caps) = prompt_eval_time_re().captures(line) {
        if let Some(ms_match) = caps.get(1) {
            if let Ok(ttft_ms) = ms_match.as_str().parse::<f64>() {
                state.request_ttft_ms = Some(ttft_ms);
                // Primary: capture prefill TPS from llama.cpp's own measurement (group 3)
                if let Some(tps_match) = caps.get(3) {
                    if let Ok(p_tps) = tps_match.as_str().parse::<f64>() {
                        state.prefill_tps = p_tps;
                    }
                }
                // Fallback: use running estimate from progress lines (already computed above)
                // If still 0, compute from prompt tokens / TTFT
                if state.prefill_tps == 0.0 && state.request_tokens_prompt > 0 && ttft_ms > 0.0 {
                    state.prefill_tps = state.request_tokens_prompt as f64 / (ttft_ms / 1000.0);
                }
                // Finalize progress to 1.0
                if state.prefill_progress < 1.0 {
                    state.prefill_progress = 1.0;
                }
                state.phase = "TG".to_string();
                eprintln!(
                    "[FUSION] port={} TTFT: {:.1}ms, prefill_tps={:.0}, phase → TG",
                    state.port, ttft_ms, state.prefill_tps
                );
            }
        }
    }

    // "prompt processing done" → authoritative PP→TG transition (fallback if prompt_eval_time log missed)
    if line.contains("prompt processing done") && state.phase == "PP" {
        if state.prefill_progress < 1.0 {
            state.prefill_progress = 1.0;
        }
        // Compute prefill TPS from progress-based estimate as last resort
        if state.prefill_tps == 0.0 && state.request_tokens_prompt > 0 {
            if let Some(start) = state.prefill_start_time {
                let elapsed_sec = std::time::Instant::now().duration_since(start).as_secs_f64();
                if elapsed_sec > 0.01 {
                    state.prefill_tps = (state.request_tokens_prompt as f64 * state.prefill_progress) / elapsed_sec;
                }
            }
        }
        state.phase = "TG".to_string();
    }

    // "stop processing: n_tokens = X" → request end
    if stop_processing_re().is_match(line) {
        state.phase = String::new();
        state.request_start = None;
        state.request_tokens_prompt = 0;
        state.request_ttft_ms = None;
        // Keep prefill_tps and prefill_progress — persist for display until next request resets them
        for s in state.slots.values_mut() {
            if s.prev_n_decoded > s.session_start_n_decoded {
                s.total_tokens_lifetime += s.prev_n_decoded - s.session_start_n_decoded;
            }
            s.session_start_n_decoded = s.prev_n_decoded;
        }
    }

    // "all slots are idle" → engine ready transition
    if all_idle_re().is_match(line) && state.engine_state == "LOADING" {
        state.engine_state = "READY".to_string();
        eprintln!("[FUSION] port={} engine READY", state.port);
    }

    emitted_progress
}
