//! Unified Engine Reader — single-pass ConPTY log consumer.
//!
//! Replaces three separate broadcast subscribers (perf_reader, readiness_watcher, fusion_monitor)
//! with one unified task that processes each line once and distributes results via internal channels:
//!   - Log entries → frontend "engine-log-batch" events
//!   - Perf metrics → frontend "engine-perf" events
//!   - Fusion events → fusion HTTP poller (internal mpsc channel)
//!
//! Wrapped in a restart loop — if the task exits (panic, I/O error), it auto-restarts after 1s.

use regex::Regex;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, Mutex as TokioMutex};

use crate::engine_stack::{EngineStack, SlotStatus};
use crate::log_hub::{LogHub, LogEntry, LogBatch};

// ── Fusion Events (internal channel between unified reader → fusion HTTP poller) ──

/// Discrete events extracted from ConPTY log lines for the fusion monitor.
#[derive(Debug, Clone)]
pub enum FusionEvent {
    /// New prompt detected: (prompt_token_count)
    NewPrompt(usize),
    /// Prompt processing progress update: 0.0-1.0
    PromptProgress(f64),
    /// Prompt eval completed: (ttft_ms, prefill_tps)
    PromptEvalDone(f64, f64),
    /// Request ended ("stop processing")
    StopProcessing,
    /// Engine ready ("all slots are idle" or "server is listening")
    EngineReady,
}

// ── Compiled Regex Patterns (perf + fusion combined) ────────────────

static PROMPT_TIMING_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static EVAL_TIMING_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static N_TOKENS_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static CHECKPOINT_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static RESTORED_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static ALL_IDLE_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static KV_CACHE_STATE_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static TIMING_TOTAL_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static STOP_PROCESSING_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();

// Fusion-specific regex patterns (moved from fusion.rs)
#[allow(dead_code)]
static NEW_PROMPT_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
#[allow(dead_code)]
static PROMPT_EVAL_TIME_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
#[allow(dead_code)]
static PROMPT_PROGRESS_RE_FUSION: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();

fn new_prompt_re() -> &'static Regex {
    NEW_PROMPT_RE.get_or_init(|| {
        Regex::new(r"new prompt.*?task\.n_tokens\s*=\s*(\d+)").unwrap()
    })
}

#[allow(dead_code)]
fn prompt_eval_time_re() -> &'static Regex {
    PROMPT_EVAL_TIME_RE.get_or_init(|| {
        Regex::new(
            r"prompt eval time\s*=\s*(\d+\.\d+)\s+ms\s*/\s*(\d+)\s+tokens.*?(\d+\.\d+)\s+tokens per second",
        ).unwrap()
    })
}

#[allow(dead_code)]
fn prompt_progress_re_fusion() -> &'static Regex {
    PROMPT_PROGRESS_RE_FUSION.get_or_init(|| {
        Regex::new(r"prompt processing progress.*?progress\s*=\s*(\d+\.\d+)").unwrap()
    })
}

// ── Perf regex accessors ────────────────────────────────────────────

fn prompt_timing_re() -> &'static Regex {
    PROMPT_TIMING_RE.get_or_init(|| Regex::new(
        r"prompt eval time\s*=\s*(\d+\.\d+)\s+ms\s*/\s*(\d+)\s+tokens.*?(\d+\.\d+)\s+tokens per second"
    ).unwrap())
}

fn eval_timing_re() -> &'static Regex {
    EVAL_TIMING_RE.get_or_init(|| Regex::new(
        r"eval time\s*=\s*(\d+\.\d+)\s+ms\s*/\s*(\d+)\s+tokens.*?(\d+\.\d+)\s+tokens per second"
    ).unwrap())
}

fn n_tokens_re() -> &'static Regex {
    N_TOKENS_RE.get_or_init(|| Regex::new(
        r"\bn_tokens\s*=\s*(\d+)"
    ).unwrap())
}

fn checkpoint_re() -> &'static Regex {
    CHECKPOINT_RE.get_or_init(|| Regex::new(
        r"checkpoint \d+ of \d+.*?pos_min\s*=\s*(\d+).*?pos_max\s*=\s*(\d+).*?n_tokens\s*=\s*(\d+),\s*size\s*=\s*([\d.]+)\s*Mib"
    ).unwrap())
}

fn restored_re() -> &'static Regex {
    RESTORED_RE.get_or_init(|| Regex::new(
        r"restored context checkpoint.*?pos_min\s*=\s*(\d+).*?pos_max\s*=\s*(\d+).*?n_tokens\s*=\s*(\d+),\s*size\s*=\s*([\d.]+)\s*Mib"
    ).unwrap())
}

fn all_idle_re() -> &'static Regex {
    ALL_IDLE_RE.get_or_init(|| Regex::new(
        r"(srv\s+update_slots:\s+)?all slots are idle"
    ).unwrap())
}

fn kv_cache_state_re() -> &'static Regex {
    KV_CACHE_STATE_RE.get_or_init(|| Regex::new(
        r"- cache state:\s*(\d+)\s+prompts,\s*([\d.]+)\s+MiB\s*\(limits:\s*([\d.]+)\s+MiB,\s*(\d+)\s+tokens"
    ).unwrap())
}

fn timing_total_re() -> &'static Regex {
    TIMING_TOTAL_RE.get_or_init(|| Regex::new(
        r"total time\s*=\s*(\d+\.\d+)\s+ms\s*/\s*(\d+)\s+tokens"
    ).unwrap())
}

fn stop_processing_re() -> &'static Regex {
    STOP_PROCESSING_RE.get_or_init(|| Regex::new(
        r"stop processing:\s*n_tokens\s*=\s*(\d+)"
    ).unwrap())
}

// ── Performance Event Emitted to Frontend ──────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct EnginePerfEvent {
    pub slot: usize,
    pub alias: String,
    pub tps: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttft_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fuel_alpha_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fuel_beta_pct: Option<f64>,
    /// Total tokens processed (prompt + eval) — for display in engine card
    #[serde(default)]
    pub n_tokens: usize,
    /// Tokens from prompt phase only — for PROMPT tok display
    #[serde(default)]
    pub prompt_tokens: usize,
    /// KV cache usage percentage (0-100%) - more accurate than token count
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kv_cache_pct: Option<f64>,
    /// Real-time prompt processing progress (0.0-1.0) during eval phase
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_progress: Option<f64>,
}

// ── FuelTank State Per Slot ────────────────────────────────────────

#[derive(Debug, Clone)]
struct FuelTankSlot {
    alpha_started: bool,
    beta_started: bool,
    current_tokens: usize,
    prompt_tokens: usize,
    ctx_size: usize,
    alpha_checkpoint_mib: Option<f64>,
    beta_checkpoint_mib: Option<f64>,
    pub phase: String,
    kv_cache_used_mib: f64,
    kv_cache_limit_mib: f64,
    prompt_progress: f64,
    last_token_count: usize,
    last_token_time: Option<std::time::Instant>,
    rolling_tps_ema: f64,
}

impl FuelTankSlot {
    fn new(ctx_size: usize) -> Self {
        Self {
            alpha_started: false,
            beta_started: false,
            current_tokens: 0,
            prompt_tokens: 0,
            ctx_size,
            alpha_checkpoint_mib: None,
            beta_checkpoint_mib: None,
            phase: "IDLE".to_string(),
            kv_cache_used_mib: 0.0,
            kv_cache_limit_mib: 8192.0,
            prompt_progress: 0.0,
            last_token_count: 0,
            last_token_time: None,
            rolling_tps_ema: 0.0,
        }
    }

    fn token_pct(&self) -> Option<f64> {
        if self.ctx_size == 0 || self.current_tokens == 0 {
            return None;
        }
        Some((self.current_tokens as f64 / self.ctx_size as f64) * 100.0)
    }

    fn checkpoint_pct(&self, mib: Option<f64>) -> Option<f64> {
        let m = mib?;
        if m <= 0.0 { return None; }
        let pct = (m / 4096.0) * 100.0;
        Some(pct.min(100.0))
    }

    fn kv_cache_pct(&self) -> Option<f64> {
        if self.kv_cache_limit_mib <= 0.0 { return None; }
        Some((self.kv_cache_used_mib / self.kv_cache_limit_mib) * 100.0)
    }

    fn interpolate(&self, mib: Option<f64>) -> Option<f64> {
        if let Some(kv_pct) = self.kv_cache_pct() {
            return Some(kv_pct.min(100.0));
        }
        match self.token_pct() {
            None => None,
            Some(token_pct) => {
                if let Some(cp_pct) = self.checkpoint_pct(mib) {
                    Some(token_pct * 0.6 + cp_pct * 0.4)
                } else {
                    Some(token_pct)
                }
            }
        }
    }

    fn alpha_interpolated(&self) -> Option<f64> {
        if !self.alpha_started { return None; }
        self.interpolate(self.alpha_checkpoint_mib)
    }

    fn beta_interpolated(&self) -> Option<f64> {
        if !self.beta_started { return None; }
        self.interpolate(self.beta_checkpoint_mib)
    }
}

// ── Global State (per-slot FuelTank tracking) ──────────────────────

struct PerfState {
    slots: HashMap<usize, FuelTankSlot>,
}

impl PerfState {
    fn new() -> Self {
        Self { slots: HashMap::new() }
    }

    fn get_or_create(&mut self, slot_idx: usize, ctx_size: usize) -> &mut FuelTankSlot {
        self.slots.entry(slot_idx).or_insert_with(|| FuelTankSlot::new(ctx_size))
    }
}

static STATE: Mutex<Option<Arc<TokioMutex<PerfState>>>> = Mutex::new(None);

// ── Unified Reader (single-pass ConPTY consumer) ───────────────────

/// Configuration for the unified reader task.
#[derive(Clone)]
pub struct UnifiedReaderConfig {
    pub log_hub: LogHub,
    pub slot_idx: usize,
    pub alias: String,
    pub ctx_size: usize,
    /// Stack reference for readiness check (marking slot Running)
    pub stack: Arc<TokioMutex<EngineStack>>,
    /// Sender for fusion events → consumed by fusion HTTP poller
    pub fusion_tx: mpsc::UnboundedSender<FusionEvent>,
}

/// Spawn the unified reader with a restart loop.
/// If the task exits (panic, I/O error), it auto-restarts after 1 second.
pub fn spawn_unified_reader(
    rx: mpsc::UnboundedReceiver<String>,
    config: UnifiedReaderConfig,
) {
    tokio::spawn(async move {
        loop {
            eprintln!("[UNIFIED] slot={} reader starting", config.slot_idx);
            unified_reader_loop(rx, config.clone()).await;
            // Channel closed = engine stopped. Don't restart — the sender was dropped on stop_slot/kill_all.
            eprintln!("[UNIFIED] slot={} reader exited permanently (channel closed)", config.slot_idx);
            break;
        }
    });
}

/// Main unified reader loop — single-pass processing of each ConPTY line.
async fn unified_reader_loop(
    mut rx: mpsc::UnboundedReceiver<String>,
    config: UnifiedReaderConfig,
) {
    let UnifiedReaderConfig {
        log_hub, slot_idx, alias, ctx_size, stack, fusion_tx
    } = config;

    // Initialize global state if needed
    {
        let mut guard = STATE.lock().unwrap();
        if guard.is_none() {
            *guard = Some(Arc::new(TokioMutex::new(PerfState::new())));
        }
    }

    eprintln!("[UNIFIED] slot={} reader started (ctx_size={})", slot_idx, ctx_size);

    // Batch accumulation for log display
    let mut batch_buffer: Vec<LogEntry> = Vec::with_capacity(50);
    let mut last_emit = tokio::time::Instant::now();
    let batch_interval = tokio::time::Duration::from_millis(100);

    // Heartbeat timer — emits rolling TPS snapshot every 200ms even during silent periods
    let heartbeat_interval = tokio::time::Duration::from_millis(200);
    let mut heartbeat_timer = tokio::time::interval(heartbeat_interval);

    // Readiness tracking — one-shot check for "server is listening" / "all slots are idle"
    let mut engine_ready = false;

    loop {
        tokio::select! {
            biased; // Prefer recv over heartbeat — prevents both branches from firing simultaneously

            // ── ConPTY output line ──────────────────────────────────────
            result = rx.recv() => {
                let line = match result {
                    Some(l) => l,
                    None => break, // Channel closed — engine stopped
                };

                // Skip empty lines
                if line.is_empty() { continue; }

                // ── \r splitting: llama.cpp uses carriage returns for cursor repositioning.
                // BufReader::lines() only splits on \n, so bare \r merges two logical lines.
                let parts: Vec<&str> = if line.contains('\r') {
                    line.split('\r').collect()
                } else {
                    vec![&line]
                };

                for part in parts {
                    let cleaned = part.trim().to_string();
                    // Filter out meaningless fragments from \r split
                    let is_real_line = cleaned.starts_with('0')
                        || cleaned.contains(" I ") || cleaned.contains(" W ") || cleaned.contains(" E ")
                        || cleaned.len() > 30;
                    if !is_real_line { continue; }

                    // ── Readiness check (inline, one-shot) ──────────────
                    if !engine_ready {
                        let lower = cleaned.to_lowercase();
                        if lower.contains("server is listening on") || lower.contains("all slots are idle") {
                            engine_ready = true;
                            {
                                let s = stack.lock().await;
                                if let Some(mut slot) = s.get_slot(slot_idx) {
                                    slot.status = SlotStatus::Running;
                                };
                            }
                            eprintln!("[READINESS] slot={} engine ready", slot_idx);
                        }
                    }

                    // ── Suppress FUSION poll noise from frontend log display ──
                    let is_poll_noise = (cleaned.contains("done request") && cleaned.contains("/slots"))
                        || cleaned.contains("update_slots: all slots are idle");

                    if !is_poll_noise {
                        let entry = LogEntry {
                            slot: slot_idx,
                            alias: alias.clone(),
                            text: cleaned.clone(),
                            timestamp: chrono::Local::now().format("%H:%M:%S%.3f").to_string(),
                        };
                        batch_buffer.push(entry);
                    }

                    // ── Single-pass line processing ─────────────────────
                    process_line(&cleaned, slot_idx, &alias, ctx_size, &log_hub, &fusion_tx).await;
                }

                // Batch emit every 100ms or when buffer is full
                let should_emit = batch_buffer.len() >= 50 || last_emit.elapsed() >= batch_interval;
                if should_emit && !batch_buffer.is_empty() {
                    let entries: Vec<LogEntry> = std::mem::take(&mut batch_buffer);
                    let _ = log_hub.emit("engine-log-batch", &LogBatch {
                        slot: slot_idx,
                        alias: alias.clone(),
                        entries,
                    });
                    last_emit = tokio::time::Instant::now();
                }
            }

            // ── Heartbeat — emit rolling TPS snapshot during silent periods ──
            _ = heartbeat_timer.tick() => {
                let state_arc = STATE.lock().unwrap().clone();
                if let Some(ref arc) = state_arc {
                    let perf_state = arc.lock().await;
                    if let Some(slot_state) = perf_state.slots.get(&slot_idx) {
                        let now = std::time::Instant::now();
                        let heartbeat_tps = if slot_state.rolling_tps_ema > 0.0 {
                            if let Some(last_time) = slot_state.last_token_time {
                                let elapsed_since_last = now.duration_since(last_time).as_secs_f64();
                                if elapsed_since_last < 2.0 {
                                    let decay_factor = 1.0 - (elapsed_since_last / 2.0);
                                    Some(slot_state.rolling_tps_ema * decay_factor)
                                } else {
                                    None
                                }
                            } else {
                                None
                            }
                        } else {
                            None
                        };

                        if let Some(tps) = heartbeat_tps {
                            let event = EnginePerfEvent {
                                slot: slot_idx, alias: alias.clone(), tps, ttft_ms: None,
                                fuel_alpha_pct: slot_state.alpha_interpolated(),
                                fuel_beta_pct: slot_state.beta_interpolated(),
                                n_tokens: slot_state.current_tokens,
                                prompt_tokens: slot_state.prompt_tokens,
                                kv_cache_pct: slot_state.kv_cache_pct(),
                                prompt_progress: Some(slot_state.prompt_progress),
                            };
                            log_hub.emit("engine-perf", &event);
                        }
                    }
                }
            }
        }
    }

    // Flush remaining batch on channel close
    if !batch_buffer.is_empty() {
        let _ = log_hub.emit("engine-log-batch", &LogBatch {
            slot: slot_idx,
            alias: alias.clone(),
            entries: std::mem::take(&mut batch_buffer),
        });
    }

    eprintln!("[UNIFIED] slot={} reader stopped (channel closed)", slot_idx);
}

/// Process a single log line — single-pass perf + fusion parsing.
async fn process_line(
    line: &str,
    slot_idx: usize,
    alias: &str,
    ctx_size: usize,
    log_hub: &LogHub,
    fusion_tx: &mpsc::UnboundedSender<FusionEvent>,
) {
    let state_arc = STATE.lock().unwrap().clone();

    let mut perf_state = match state_arc {
        Some(ref arc) => arc.lock().await,
        None => return,
    };
    let slot_state = perf_state.get_or_create(slot_idx, ctx_size);

    // ── ALPHA checkpoint: auto-start on "all slots are idle" ───────────
    if !slot_state.alpha_started && all_idle_re().is_match(line) {
        slot_state.alpha_started = true;
        eprintln!("[PERF_PULSE] slot={} ALPHA checkpoint started (engine ready)", slot_idx);

        let event = EnginePerfEvent {
            slot: slot_idx, alias: alias.to_string(), tps: 0.0, ttft_ms: None,
            fuel_alpha_pct: slot_state.alpha_interpolated(), fuel_beta_pct: slot_state.beta_interpolated(),
            n_tokens: slot_state.current_tokens,
            prompt_tokens: slot_state.prompt_tokens,
            kv_cache_pct: slot_state.kv_cache_pct(),
            prompt_progress: Some(slot_state.prompt_progress),
        };
        log_hub.emit("engine-perf", &event);

        // Send fusion event
        let _ = fusion_tx.send(FusionEvent::EngineReady);
    }

    // ── Phase detection from log line patterns ────────────────────────
    if line.contains("prompt processing progress") {
        if slot_state.phase == "IDLE" {
            slot_state.rolling_tps_ema = 0.0;
            slot_state.last_token_count = 0;
            slot_state.last_token_time = None;
        }
        slot_state.phase = "PROMPT_PROCESSING".to_string();

        // Fusion: prompt progress tracking
        if let Some(progress_match) = Regex::new(r"progress\s*=\s*(\d+\.\d+)").unwrap().captures(line) {
            if let Some(progress) = progress_match.get(1).and_then(|m| m.as_str().parse::<f64>().ok()) {
                slot_state.prompt_progress = progress;
                eprintln!("[PERF_PULSE] slot={} prompt progress: {:.0}%", slot_idx, progress * 100.0);

                // Send fusion event
                let _ = fusion_tx.send(FusionEvent::PromptProgress(progress));
            }
        }
    } else if line.contains("prompt processing done") {
        slot_state.last_token_count = slot_state.current_tokens;
        slot_state.last_token_time = Some(std::time::Instant::now());
        slot_state.phase = "GENERATING".to_string();
    }

    // ── Fusion: new prompt detection ──────────────────────────────────
    if let Some(caps) = new_prompt_re().captures(line) {
        if let Some(n_tok_match) = caps.get(1) {
            if let Ok(prompt_tokens) = n_tok_match.as_str().parse::<usize>() {
                eprintln!("[FUSION] slot={} new request: {} prompt tokens", slot_idx, prompt_tokens);
                let _ = fusion_tx.send(FusionEvent::NewPrompt(prompt_tokens));
            }
        }
    }

    // ── Fusion: prompt eval time (TTFT) ───────────────────────────────
    if let Some(caps) = prompt_eval_time_re().captures(line) {
        if caps.len() >= 4 {
            let ttft_ms = caps.get(1).and_then(|m| m.as_str().parse::<f64>().ok()).unwrap_or(0.0);
            let prefill_tps = caps.get(3).and_then(|m| m.as_str().parse::<f64>().ok()).unwrap_or(0.0);
            if ttft_ms > 0.0 {
                eprintln!("[FUSION] slot={} TTFT: {:.1}ms, prefill_tps={:.0}", slot_idx, ttft_ms, prefill_tps);
                let _ = fusion_tx.send(FusionEvent::PromptEvalDone(ttft_ms, prefill_tps));
            }
        }
    }

    // ── Fusion: stop processing ───────────────────────────────────────
    if stop_processing_re().is_match(line) {
        let _ = fusion_tx.send(FusionEvent::StopProcessing);
    }

    // ── KV Cache State tracking ───────────────────────────────────────
    let kv_caps = kv_cache_state_re().captures(line);
    if let Some(caps) = kv_caps {
        if caps.len() >= 4 {
            if let (Some(used), Some(limit)) = (
                caps.get(2).and_then(|m| m.as_str().parse::<f64>().ok()),
                caps.get(3).and_then(|m| m.as_str().parse::<f64>().ok())
            ) {
                slot_state.kv_cache_used_mib = used;
                slot_state.kv_cache_limit_mib = limit;
                eprintln!("[PERF_PULSE] slot={} KV cache: {:.1} MiB / {:.1} MiB ({:.1}%)",
                    slot_idx, used, limit, (used/limit)*100.0);
            }
        }
    }

    // ── Prompt timing extraction ───────────────────────────────────────
    let prompt_caps = prompt_timing_re().captures(line);
    if let Some(caps) = prompt_caps {
        if caps.len() >= 4 {
            let prompt_tokens: usize = match caps.get(2).and_then(|m| m.as_str().parse::<usize>().ok()) {
                Some(n) => n, None => 0,
            };
            let prompt_tps: f64 = match caps.get(3).and_then(|m| m.as_str().parse::<f64>().ok()) {
                Some(v) => v, None => 0.0,
            };

            slot_state.current_tokens += prompt_tokens;
            slot_state.prompt_tokens += prompt_tokens;

            let cp_caps = checkpoint_re().captures(line);
            if let Some(cp) = cp_caps {
                if cp.len() >= 5 {
                    let checkpoint_mib: f64 = match cp.get(4).and_then(|m| m.as_str().parse::<f64>().ok()) {
                        Some(v) => v, None => 0.0,
                    };
                    if slot_state.alpha_started {
                        slot_state.alpha_checkpoint_mib = Some(checkpoint_mib);
                    }
                    if slot_state.beta_started {
                        slot_state.beta_checkpoint_mib = Some(checkpoint_mib);
                    }
                }
            }

            let event = EnginePerfEvent {
                slot: slot_idx, alias: alias.to_string(), tps: prompt_tps, ttft_ms: None,
                fuel_alpha_pct: slot_state.alpha_interpolated(), fuel_beta_pct: slot_state.beta_interpolated(),
                n_tokens: slot_state.current_tokens,
                prompt_tokens: slot_state.prompt_tokens,
                kv_cache_pct: slot_state.kv_cache_pct(),
                prompt_progress: Some(slot_state.prompt_progress),
            };
            log_hub.emit("engine-perf", &event);
        }
    }

    // ── Eval timing extraction (decode phase — real TPS) ───────────────
    let eval_caps = eval_timing_re().captures(line);
    if let Some(caps) = eval_caps {
        if caps.len() >= 4 {
            let eval_tokens: usize = match caps.get(2).and_then(|m| m.as_str().parse::<usize>().ok()) {
                Some(n) => n, None => 0,
            };
            let decode_tps: f64 = match caps.get(3).and_then(|m| m.as_str().parse::<f64>().ok()) {
                Some(v) => v, None => 0.0,
            };

            slot_state.current_tokens += eval_tokens;

            let cp_caps = checkpoint_re().captures(line);
            if let Some(cp) = cp_caps {
                if cp.len() >= 5 {
                    let checkpoint_mib: f64 = match cp.get(4).and_then(|m| m.as_str().parse::<f64>().ok()) {
                        Some(v) => v, None => 0.0,
                    };
                    if slot_state.alpha_started {
                        slot_state.alpha_checkpoint_mib = Some(checkpoint_mib);
                    }
                    if slot_state.beta_started {
                        slot_state.beta_checkpoint_mib = Some(checkpoint_mib);
                    }
                }
            }

            let rest_caps = restored_re().captures(line);
            if let Some(rest) = rest_caps {
                if rest.len() >= 4 {
                    let checkpoint_mib: f64 = match rest.get(3).and_then(|m| m.as_str().parse::<f64>().ok()) {
                        Some(v) => v, None => 0.0,
                    };
                    if slot_state.alpha_started {
                        slot_state.alpha_checkpoint_mib = Some(checkpoint_mib);
                    }
                    if slot_state.beta_started {
                        slot_state.beta_checkpoint_mib = Some(checkpoint_mib);
                    }
                }
            }

            let event = EnginePerfEvent {
                slot: slot_idx, alias: alias.to_string(), tps: decode_tps, ttft_ms: None,
                fuel_alpha_pct: slot_state.alpha_interpolated(), fuel_beta_pct: slot_state.beta_interpolated(),
                n_tokens: slot_state.current_tokens,
                prompt_tokens: slot_state.prompt_tokens,
                kv_cache_pct: slot_state.kv_cache_pct(),
                prompt_progress: Some(slot_state.prompt_progress),
            };
            log_hub.emit("engine-perf", &event);
        }
    }

    // ── Direct n_tokens tracking for incremental updates with rolling TPS ──
    let has_n_tokens = line.contains("n_tokens");
    if has_n_tokens {
        let n_caps = n_tokens_re().captures(line);
        if let Some(caps) = n_caps {
            if caps.len() >= 2 {
                if let Some(n_tokens) = caps.get(1).and_then(|m| m.as_str().parse::<usize>().ok()) {
                    let is_generating = slot_state.phase == "GENERATING";

                    if is_generating {
                        let now = std::time::Instant::now();
                        let delta_tokens = n_tokens.saturating_sub(slot_state.last_token_count);
                        let raw_tps = if delta_tokens > 0 && slot_state.last_token_time.is_some() {
                            let elapsed = now.duration_since(slot_state.last_token_time.unwrap()).as_secs_f64();
                            if elapsed > 0.01 {
                                (delta_tokens as f64) / elapsed
                            } else {
                                0.0
                            }
                        } else {
                            0.0
                        };

                        const EMA_ALPHA: f64 = 0.3;
                        if raw_tps > 0.0 {
                            slot_state.rolling_tps_ema = if slot_state.rolling_tps_ema == 0.0 {
                                raw_tps
                            } else {
                                EMA_ALPHA * raw_tps + (1.0 - EMA_ALPHA) * slot_state.rolling_tps_ema
                            };
                        }

                        slot_state.last_token_count = n_tokens;
                        slot_state.last_token_time = Some(now);
                    }

                    slot_state.current_tokens = n_tokens;

                    let event = EnginePerfEvent {
                        slot: slot_idx, alias: alias.to_string(), tps: if is_generating { slot_state.rolling_tps_ema } else { 0.0 }, ttft_ms: None,
                        fuel_alpha_pct: slot_state.alpha_interpolated(), fuel_beta_pct: slot_state.beta_interpolated(),
                        n_tokens: slot_state.current_tokens,
                        prompt_tokens: slot_state.prompt_tokens,
                        kv_cache_pct: slot_state.kv_cache_pct(),
                        prompt_progress: Some(slot_state.prompt_progress),
                    };
                    log_hub.emit("engine-perf", &event);
                }
            }
        }
    }

    // ── Stop processing tracking (per-request totals) ───────────────────
    let stop_caps = stop_processing_re().captures(line);
    if let Some(caps) = stop_caps {
        if caps.len() >= 2 {
            if let Some(final_tokens) = caps.get(1).and_then(|m| m.as_str().parse::<usize>().ok()) {
                slot_state.current_tokens = final_tokens;
                slot_state.last_token_count = final_tokens;
                slot_state.last_token_time = None;
                slot_state.rolling_tps_ema = 0.0;
                eprintln!("[PERF_PULSE] slot={} request complete: {} total tokens", slot_idx, final_tokens);
            }
        }
    }

    drop(perf_state);
}

// ── Tauri Command: Start BETA Checkpoint Manually ──────────────────

#[tauri::command]
pub async fn cmd_start_beta_fuel_tank(
    slot_idx: usize,
    app: tauri::State<'_, crate::engine::AppContext>,
) -> Result<String, String> {
    let alias = {
        let stack = app.stack.lock().await;
        stack.get_slot(slot_idx).map(|s| s.alias.clone()).unwrap_or_else(|| "unknown".to_string())
    };

    let state_arc: Arc<TokioMutex<PerfState>> = {
        let guard = STATE.lock().map_err(|e| e.to_string())?;
        guard.as_ref()
            .ok_or("Performance reader not initialized")?
            .clone()
    };

    let mut perf_state = state_arc.lock().await;

    let ctx_size = {
        let stack = app.stack.lock().await;
        if stack.get_slot(slot_idx).is_some() { 32768 } else { 32768 }
    };

    let slot_state = perf_state.get_or_create(slot_idx, ctx_size);

    if slot_state.beta_started {
        slot_state.current_tokens = 0;
        slot_state.beta_checkpoint_mib = None;
        eprintln!("[PERF_PULSE] slot={} BETA checkpoint reset (manual)", slot_idx);
    } else {
        slot_state.beta_started = true;
        slot_state.current_tokens = 0;
        eprintln!("[PERF_PULSE] slot={} BETA checkpoint started (manual)", slot_idx);
    }

    let (alpha_pct, current_tokens, prompt_tok) = {
        let alpha_p = perf_state.get_or_create(slot_idx, ctx_size).alpha_interpolated();
        let s = perf_state.slots.get(&slot_idx);
        let tokens = s.map(|sl| sl.current_tokens).unwrap_or(0);
        let ptok = s.map(|sl| sl.prompt_tokens).unwrap_or(0);
        drop(perf_state);
        (alpha_p, tokens, ptok)
    };

    let log_hub_clone = app.log_hub.clone();
    tokio::spawn(async move {
        let event = EnginePerfEvent {
            slot: slot_idx, alias: alias.clone(), tps: 0.0, ttft_ms: None,
            fuel_alpha_pct: alpha_pct,
            fuel_beta_pct: Some(0.0),
            n_tokens: current_tokens,
            prompt_tokens: prompt_tok,
            kv_cache_pct: None,
            prompt_progress: None,
        };
        log_hub_clone.emit("engine-perf", &event);
    });

    Ok(format!("BETA checkpoint started for slot {}", slot_idx))
}
