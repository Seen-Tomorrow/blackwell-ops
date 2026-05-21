//! Performance Monitor — subscribes to LogHub's fan-out channel.
//!
//! Parses engine log lines for performance metrics (TPS, TTFT, KV cache %, phase detection)
//! and emits "engine-perf" events to frontend. Also forwards FusionEvents to the HTTP poller.
//! Does NOT handle batching, dedup, or line processing — those are LogHub's responsibility.

use regex::Regex;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, Mutex as TokioMutex};

use crate::log_hub::LogHub;

// ── Fusion Events (internal channel between unified reader → fusion HTTP poller) ──

/// Discrete events extracted from engine log lines for the fusion monitor.
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
static STOP_PROCESSING_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static PRINT_TIMING_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static INIT_SAMPLER_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();

// Fusion-specific regex patterns (moved from fusion.rs)
#[allow(dead_code)]
static NEW_PROMPT_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static NEW_PROMPT_SRV_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
#[allow(dead_code)]
static PROMPT_EVAL_TIME_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
#[allow(dead_code)]
static PROMPT_PROGRESS_RE_FUSION: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();

fn new_prompt_re() -> &'static Regex {
    NEW_PROMPT_RE.get_or_init(|| {
        Regex::new(r"new prompt.*?task\.n_tokens\s*=\s*(\d+)").unwrap()
    })
}

// Fallback for new llama.cpp format: "srv update: - prompt 000002261B4A2840: 687 tokens"
fn new_prompt_srv_re() -> &'static Regex {
    NEW_PROMPT_SRV_RE.get_or_init(|| {
        Regex::new(r"(?:srv\s+update:\s+-\s+prompt\s+[\da-fA-F]+:\s+(\d+)\s+tokens)").unwrap()
    })
}

#[allow(dead_code)]
fn prompt_eval_time_re() -> &'static Regex {
    PROMPT_EVAL_TIME_RE.get_or_init(|| {
        // Old format: "... 194.46 tokens per second"
        // New format: "... 194.46" (bare number at EOL, no suffix)
        Regex::new(
            r"prompt eval time\s*=\s*(\d+\.\d+)\s+ms\s*/\s*(\d+)\s+tokens(?:.*?(\d+\.\d+)(?:\s+tokens per second|$))",
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
        r"prompt eval time\s*=\s*(\d+\.\d+)\s+ms\s*/\s*(\d+)\s+tokens(?:.*?(\d+\.\d+)(?:\s+tokens per second|$))"
    ).unwrap())
}

fn eval_timing_re() -> &'static Regex {
    EVAL_TIMING_RE.get_or_init(|| Regex::new(
        r"eval time\s*=\s*(\d+\.\d+)\s+ms\s*/\s*(\d+)\s+tokens(?:.*?(\d+\.\d+)(?:\s+tokens per second|$))"
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

fn stop_processing_re() -> &'static Regex {
    STOP_PROCESSING_RE.get_or_init(|| Regex::new(
        r"stop processing:\s*n_tokens\s*=\s*(\d+)"
    ).unwrap())
}

fn print_timing_re() -> &'static Regex {
    PRINT_TIMING_RE.get_or_init(|| Regex::new(
        r"n_decoded\s*=\s*(\d+).*?tg\s*=\s*([\d.]+)\s*t/s"
    ).unwrap())
}

fn init_sampler_re() -> &'static Regex {
    INIT_SAMPLER_RE.get_or_init(|| Regex::new(
        r"init sampler.*?total\s*=\s*(\d+)"
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
    current_tokens: usize,
    prompt_tokens: usize,
    ctx_size: usize,
    alpha_checkpoint_mib: Option<f64>,
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
            current_tokens: 0,
            prompt_tokens: 0,
            ctx_size,
            alpha_checkpoint_mib: None,
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

// ── Perf Monitor (subscribes to LogHub fan-out channel) ─────────────

/// Spawn the performance monitor task.
/// Subscribes to processed log lines from LogHub's fan-out channel,
/// parses for TPS/TTFT/KV cache metrics, and emits "engine-perf" events.
pub fn spawn_perf_monitor(
    slot_idx: usize,
    alias: String,
    ctx_size: usize,
    log_hub: LogHub,
    mut line_rx: mpsc::UnboundedReceiver<String>,
    fusion_tx: mpsc::UnboundedSender<FusionEvent>,
) {
    tokio::spawn(async move {
        // Initialize global state if needed
        {
            let mut guard = STATE.lock().unwrap();
            if guard.is_none() {
                *guard = Some(Arc::new(TokioMutex::new(PerfState::new())));
            }
        }

        eprintln!("[PERF] slot={} monitor started (ctx_size={})", slot_idx, ctx_size);

        // Heartbeat timer — emits rolling TPS snapshot every 200ms even during silent periods
        let heartbeat_interval = tokio::time::Duration::from_millis(200);
        let mut heartbeat_timer = tokio::time::interval(heartbeat_interval);

        loop {
            tokio::select! {
                biased; // Prefer recv over heartbeat

                // ── Processed line from LogHub fan-out ────────────────────
                result = line_rx.recv() => {
                    let line = match result {
                        Some(l) => l,
                        None => break, // Channel closed — engine stopped
                    };

                    if line.is_empty() { continue; }

                    // Single-pass perf + fusion parsing
                    process_line(&line, slot_idx, &alias, ctx_size, &log_hub, &fusion_tx).await;
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

        eprintln!("[PERF] slot={} monitor stopped (channel closed)", slot_idx);
    });
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
            fuel_alpha_pct: slot_state.alpha_interpolated(),
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

    // ── Fusion: new prompt detection (old format) ──────────────────────
    if let Some(caps) = new_prompt_re().captures(line) {
        if let Some(n_tok_match) = caps.get(1) {
            if let Ok(prompt_tokens) = n_tok_match.as_str().parse::<usize>() {
                // Reset counters for new request boundary
                slot_state.prompt_tokens = 0;
                eprintln!("[FUSION] slot={} new request: {} prompt tokens", slot_idx, prompt_tokens);
                let _ = fusion_tx.send(FusionEvent::NewPrompt(prompt_tokens));
            }
        }
    } else if let Some(caps) = new_prompt_srv_re().captures(line) {
        // Fallback for new llama.cpp format: "srv update: - prompt ADDR: N tokens"
        if let Some(n_tok_match) = caps.get(1) {
            if let Ok(prompt_tokens) = n_tok_match.as_str().parse::<usize>() {
                eprintln!("[FUSION] slot={} new request (srv): {} prompt tokens", slot_idx, prompt_tokens);
                let _ = fusion_tx.send(FusionEvent::NewPrompt(prompt_tokens));
            }
        }
    }

    // ── Fusion: prompt eval time (TTFT) ───────────────────────────────
    if let Some(caps) = prompt_eval_time_re().captures(line) {
        // Group 1 = ttft_ms, Group 2 = prompt tokens, Group 3 = prefill TPS (optional in new format)
        let ttft_ms = caps.get(1).and_then(|m| m.as_str().parse::<f64>().ok()).unwrap_or(0.0);
        let prefill_tps = caps.get(3).and_then(|m| m.as_str().parse::<f64>().ok()).unwrap_or(0.0);
        if ttft_ms > 0.0 {
            eprintln!("[FUSION] slot={} TTFT: {:.1}ms, prefill_tps={:.0}", slot_idx, ttft_ms, prefill_tps);
            let _ = fusion_tx.send(FusionEvent::PromptEvalDone(ttft_ms, prefill_tps));
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
        // caps.len() >= 2: at minimum we have ttft_ms (g1) and prompt_tokens (g2); prefill_tps (g3) is optional
        if caps.len() >= 2 {
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
                }
            }

            let event = EnginePerfEvent {
                slot: slot_idx, alias: alias.to_string(), tps: prompt_tps, ttft_ms: None,
                fuel_alpha_pct: slot_state.alpha_interpolated(),
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
        // caps.len() >= 2: at minimum eval_time_ms (g1) and eval_tokens (g2); decode_tps (g3) is optional
        if caps.len() >= 2 {
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
                }
            }

            let event = EnginePerfEvent {
                slot: slot_idx, alias: alias.to_string(), tps: decode_tps, ttft_ms: None,
                fuel_alpha_pct: slot_state.alpha_interpolated(),
                n_tokens: slot_state.current_tokens,
                prompt_tokens: slot_state.prompt_tokens,
                kv_cache_pct: slot_state.kv_cache_pct(),
                prompt_progress: Some(slot_state.prompt_progress),
            };
            log_hub.emit("engine-perf", &event);
        }
    }

    // ── print_timing: tg = X t/s (new llama.cpp decode TPS during generation) ──
    let pt_caps = print_timing_re().captures(line);
    if let Some(caps) = pt_caps {
        if caps.len() >= 3 {
            let n_decoded: usize = match caps.get(1).and_then(|m| m.as_str().parse::<usize>().ok()) {
                Some(n) => n, None => 0,
            };
            let tg_tps: f64 = match caps.get(2).and_then(|m| m.as_str().parse::<f64>().ok()) {
                Some(v) => v, None => 0.0,
            };
            if tg_tps > 0.0 {
                slot_state.rolling_tps_ema = tg_tps;
                slot_state.current_tokens = n_decoded;
                slot_state.last_token_count = n_decoded;
                slot_state.last_token_time = Some(std::time::Instant::now());

                let event = EnginePerfEvent {
                    slot: slot_idx, alias: alias.to_string(), tps: tg_tps, ttft_ms: None,
                    fuel_alpha_pct: slot_state.alpha_interpolated(),
                    n_tokens: slot_state.current_tokens,
                    prompt_tokens: slot_state.prompt_tokens,
                    kv_cache_pct: slot_state.kv_cache_pct(),
                    prompt_progress: Some(slot_state.prompt_progress),
                };
                log_hub.emit("engine-perf", &event);
            }
        }
    }

    // ── Phase transition: init_sampler means prefill is done, generation starting ──
    let is_sampler = line.contains("init_sampler");
    if is_sampler {
        if let Some(sampler_caps) = init_sampler_re().captures(line) {
            if sampler_caps.len() >= 2 {
                if let Some(_total) = sampler_caps.get(1).and_then(|m| m.as_str().parse::<usize>().ok()) {
                    slot_state.phase = "GENERATING".to_string();
                    slot_state.last_token_count = 0;
                    slot_state.last_token_time = Some(std::time::Instant::now());
                }
            }
        } else {
            // Still transition phase even if we can't parse token count
            slot_state.phase = "GENERATING".to_string();
            slot_state.last_token_time = Some(std::time::Instant::now());
        }
    }

    // ── Direct n_tokens tracking for incremental updates with rolling TPS ──
    // Skip lines that are "stop processing" — handled by dedicated handler below
    let is_stop_processing = stop_processing_re().is_match(line);
    let has_n_tokens = line.contains("n_tokens") && !is_stop_processing;
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
                        fuel_alpha_pct: slot_state.alpha_interpolated(),
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
                slot_state.prompt_tokens = 0;
                slot_state.last_token_count = final_tokens;
                slot_state.last_token_time = None;
                slot_state.rolling_tps_ema = 0.0;
                eprintln!("[PERF_PULSE] slot={} request complete: {} total tokens", slot_idx, final_tokens);
            }
        }
    }

    drop(perf_state);
}
