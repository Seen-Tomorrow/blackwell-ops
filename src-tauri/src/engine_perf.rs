//! Engine Performance Pulse — reads llama-server output via ConPTY mpsc channel.
//! Combined stdout+stderr stream from pseudo-console (line-buffered at source).

use regex::Regex;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::{Mutex as TokioMutex, mpsc};

use crate::log_hub::{LogHub, LogEntry, LogBatch};

// ── Compiled Regex Patterns ────────────────────────────────────────

static PROMPT_TIMING_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static EVAL_TIMING_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static N_TOKENS_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static CHECKPOINT_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static RESTORED_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static ALL_IDLE_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static PROMPT_PROGRESS_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static PROMPT_DONE_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static KV_CACHE_STATE_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static TIMING_TOTAL_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static STOP_PROCESSING_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();

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
        r"srv\s+update_slots:\s+all slots are idle"
    ).unwrap())
}

fn prompt_progress_re() -> &'static Regex {
    PROMPT_PROGRESS_RE.get_or_init(|| Regex::new(
        r"prompt processing progress|prompt processing done"
    ).unwrap())
}

fn prompt_done_re() -> &'static Regex {
    PROMPT_DONE_RE.get_or_init(|| Regex::new(
        r"prompt processing done"
    ).unwrap())
}

/// Parse KV cache state: "- cache state: 8 prompts, 31.857 MiB (limits: 8192.000 MiB, 131072 tokens, 725923 est)"
fn kv_cache_state_re() -> &'static Regex {
    KV_CACHE_STATE_RE.get_or_init(|| Regex::new(
        r"- cache state:\s*(\d+)\s+prompts,\s*([\d.]+)\s+MiB\s*\(limits:\s*([\d.]+)\s+MiB,\s*(\d+)\s+tokens"
    ).unwrap())
}

/// Parse total timing: "total time = 1228.60 ms / 370 tokens"
fn timing_total_re() -> &'static Regex {
    TIMING_TOTAL_RE.get_or_init(|| Regex::new(
        r"total time\s*=\s*(\d+\.\d+)\s+ms\s*/\s*(\d+)\s+tokens"
    ).unwrap())
}

/// Parse stop processing: "stop processing: n_tokens = 369, truncated = 0"
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
    prompt_tokens: usize,  // Tokens from prompt phase only
    ctx_size: usize,
    alpha_checkpoint_mib: Option<f64>,
    beta_checkpoint_mib: Option<f64>,
    /// Current inference phase for frontend display
    pub phase: String,
    /// KV cache tracking - actual memory usage vs limits
    kv_cache_used_mib: f64,
    kv_cache_limit_mib: f64,
    /// Real-time prompt processing progress (0.0-1.0) during eval
    prompt_progress: f64,
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
            kv_cache_limit_mib: 8192.0, // Default limit from logs
            prompt_progress: 0.0,
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

    /// KV cache based percentage - more accurate than token count alone
    fn kv_cache_pct(&self) -> Option<f64> {
        if self.kv_cache_limit_mib <= 0.0 { return None; }
        Some((self.kv_cache_used_mib / self.kv_cache_limit_mib) * 100.0)
    }

    fn interpolate(&self, mib: Option<f64>) -> Option<f64> {
        // Use KV cache percentage as primary metric (handles compaction correctly)
        if let Some(kv_pct) = self.kv_cache_pct() {
            return Some(kv_pct.min(100.0));
        }
        
        // Fallback to token-based calculation
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

// ── Background Reader (consumes from ConPTY mpsc channel) ──────────

/// Start the performance pulse reader for a slot, consuming lines from the ConPTY mpsc channel.
pub async fn start_perf_reader_from_channel(
    log_hub: LogHub,
    slot_idx: usize,
    alias: String,
    mut rx: mpsc::Receiver<String>,
    ctx_size: usize,
) {
    // Initialize global state if needed
    {
        let mut guard = STATE.lock().unwrap();
        if guard.is_none() {
            *guard = Some(Arc::new(TokioMutex::new(PerfState::new())));
        }
    }

    eprintln!("[PERF_PULSE] slot={} reader started (ctx_size={})", slot_idx, ctx_size);

    // Batch accumulation for log display
    let mut batch_buffer: Vec<LogEntry> = Vec::with_capacity(50);
    let mut last_emit = tokio::time::Instant::now();
    let batch_interval = tokio::time::Duration::from_millis(100);

    while let Some(line) = rx.recv().await {
        if !line.is_empty() {
            // Replace ESC byte (0x1B) with safe placeholder for JSON transport.
            let safe_text = line.replace('\x1b', "%%ESC%%");
            // Emit to log display batch
            let entry = LogEntry {
                slot: slot_idx,
                alias: alias.clone(),
                text: safe_text,
                timestamp: chrono::Local::now().format("%H:%M:%S%.3f").to_string(),
            };
            batch_buffer.push(entry);

            // Parse for perf metrics
            let hub = log_hub.clone();
            process_perf_line(slot_idx, &alias, &line, ctx_size, hub).await;
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

    // Flush remaining batch on channel close
    if !batch_buffer.is_empty() {
        let _ = log_hub.emit("engine-log-batch", &LogBatch {
            slot: slot_idx,
            alias: alias.clone(),
            entries: std::mem::take(&mut batch_buffer),
        });
    }

    eprintln!("[PERF_PULSE] slot={} reader stopped (channel closed)", slot_idx);
}

/// Process a single log line for performance metrics.
async fn process_perf_line(
    slot_idx: usize,
    alias: &str,
    line: &str,
    ctx_size: usize,
    log_hub: LogHub,
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
    }

    // ── Phase detection from log line patterns (replaces broken ttft_ms logic) ──
    if line.contains("prompt processing progress") {
        slot_state.phase = "PROMPT_PROCESSING".to_string();
    } else if line.contains("prompt processing done") {
        slot_state.phase = "GENERATING".to_string();
    }

    // ── KV Cache State tracking (handles compaction correctly) ───────────
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

    // ── Direct n_tokens tracking for incremental updates ───────────────
    let is_processing = line.contains("processing task") || line.contains("prompt processing done");
    if is_processing {
        let n_caps = n_tokens_re().captures(line);
        if let Some(caps) = n_caps {
            if caps.len() >= 2 {
                if let Some(n_tokens) = caps.get(1).and_then(|m| m.as_str().parse::<usize>().ok()) {
                    slot_state.current_tokens = n_tokens;

                    let event = EnginePerfEvent {
                        slot: slot_idx, alias: alias.to_string(), tps: 0.0, ttft_ms: None,
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

    // ── Real-time prompt progress tracking (0.0-1.0 scale) ───────────────
    if line.contains("prompt processing progress") {
        if let Some(progress_match) = Regex::new(r"progress\s*=\s*(\d+\.\d+)").unwrap().captures(line) {
            if let Some(progress) = progress_match.get(1).and_then(|m| m.as_str().parse::<f64>().ok()) {
                slot_state.prompt_progress = progress;
                eprintln!("[PERF_PULSE] slot={} prompt progress: {:.0}%", slot_idx, progress * 100.0);
            }
        }
    }

    // ── Stop processing tracking (per-request totals) ───────────────────
    let stop_caps = stop_processing_re().captures(line);
    if let Some(caps) = stop_caps {
        if caps.len() >= 2 {
            if let Some(final_tokens) = caps.get(1).and_then(|m| m.as_str().parse::<usize>().ok()) {
                slot_state.current_tokens = final_tokens;
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
