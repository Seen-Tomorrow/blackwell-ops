use serde::Serialize;
use tokio::sync::mpsc;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;

use crate::output_console::BlackwellOutputConsoleCategory;
use crate::output_console::BlackwellOutputConsoleLineStyle;

/// A single log line emitted to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub slot: usize,
    pub alias: String,
    pub text: String,
}

/// System-level event (launch debug, errors) — separate from engine stdout.
#[derive(Debug, Clone, Serialize)]
pub struct SystemEvent {
    pub slot: usize,
    pub alias: String,
    pub text: String,
    pub timestamp: String,
}

/// Batched log event emitted to frontend.
#[derive(Debug, Clone, Serialize)]
pub struct LogBatch {
    pub slot: usize,
    pub alias: String,
    pub entries: Vec<LogEntry>,
}

const BATCH_INTERVAL_MS: u64 = 10;
const MAX_BATCH_SIZE: usize = 10;

pub struct LogHub {
    app_handle: AppHandle,
}

impl Clone for LogHub {
    fn clone(&self) -> Self {
        Self { app_handle: self.app_handle.clone() }
    }
}

impl LogHub {
    pub fn new(app_handle: AppHandle) -> Self {
        Self { app_handle }
    }

    /// Emit a generic event to all frontend windows.
    pub fn emit(&self, event: &str, payload: impl serde::Serialize + Clone) {
        if let Err(e) = self.app_handle.emit(event, payload) {
            log::warn!("[LOG_HUB] emit failed: {}", e);
        }
    }

    /// Emit a line to the Blackwell Output Console via the specified category.
    pub fn emit_console_line(
        &self,
        category: BlackwellOutputConsoleCategory,
        text: &str,
        style: BlackwellOutputConsoleLineStyle,
    ) {
        if let Some(ctx) = self.app_handle.try_state::<crate::engine::AppContext>() {
            ctx.blackwell_output_console_manager.emit_line_to_category(category, text.to_string(), style);
        }
    }

    /// Spawns the slot's log reader task.
    /// Reads stderr pipe, batches and emits "engine-log-batch" to frontend,
    /// detects readiness ("server is listening" / "all slots idle"),
    /// and routes fusion-relevant events to FusionBrain via parse_line → route_log_event.
    pub fn spawn_slot_reader(
        &self,
        slot_idx: usize,
        alias: String,
        stderr: std::process::ChildStderr,
        on_ready: impl Fn() + Send + Sync + 'static,
    ) {
        let app_handle = self.app_handle.clone();

        // Internal channel: pipe readers → main processing loop
        let (line_tx, line_rx) = mpsc::unbounded_channel::<String>();

        // Spawn blocking reader for stderr (llama.cpp sends everything here)
        tokio::task::spawn_blocking({
            let tx = line_tx;
            move || {
                use std::io::{BufRead, BufReader};
                let reader = BufReader::new(stderr);
                for line_result in reader.lines() {
                    match line_result {
                        Ok(line) => {
                            if !line.is_empty() {
                                let _ = tx.send(line);
                            }
                        }
                        Err(e) => {
                            // Log hub stderr read error now routed to Blackwell Output Console
                            break;
                        }
                    }
                }
            }
        });

        // Main processing loop: line pipeline + batching + readiness detection
        tokio::spawn(Self::process_lines(
            app_handle,
            slot_idx,
            alias,
            line_rx,
            on_ready,
        ));

        // Log hub reader started now routed to Blackwell Output Console
    }

    /// Main processing loop: consumes raw lines from pipe readers, applies pipeline, batches to frontend.
    async fn process_lines(
        app_handle: AppHandle,
        slot_idx: usize,
        alias: String,
        mut line_rx: mpsc::UnboundedReceiver<String>,
        on_ready: impl Fn() + Send + Sync + 'static,
    ) {
        let mut batch_buffer: Vec<LogEntry> = Vec::with_capacity(MAX_BATCH_SIZE);
        let mut last_emit = tokio::time::Instant::now();
        let batch_interval = tokio::time::Duration::from_millis(BATCH_INTERVAL_MS);

        // Readiness tracking — one-shot check for "server is listening" / "all slots idle"
        let mut engine_ready = false;

        let mut flush_interval = tokio::time::interval(batch_interval);

        loop {
            tokio::select! {
                biased;

                // ── Raw line from pipe reader ─────────────────────────────
                result = line_rx.recv() => {
                    let raw_line = match result {
                        Some(l) => l,
                        None => break, // Channel closed — engine stopped
                    };

                    if raw_line.is_empty() { continue; }

                    let cleaned = raw_line.trim().to_string();
                    if cleaned.is_empty() { continue; }

                    // ── Readiness check (one-shot) ──────────────
                    if !engine_ready {
                        if cleaned.contains("server is listening on") || cleaned.contains("all slots are idle") {
                            engine_ready = true;
                            on_ready();
                            // Engine ready now routed to Blackwell Output Console

                            // Route ready status to Blackwell Output Console (ENGINES category)
                            if let Some(ctx) = app_handle.try_state::<crate::engine::AppContext>() {
                                ctx.blackwell_output_console_manager.emit_line_to_category(
                                    BlackwellOutputConsoleCategory::Engines,
                                    format!("[{}] Engine ready (server is listening)", alias),
                                    BlackwellOutputConsoleLineStyle::Success,
                                );
                            }
                        }
                    }

                    // ── Parse for fusion-relevant log events (stderr → brain) ──────
                    if let Some(log_event) = crate::fusion_logparser::parse_line(&cleaned) {
                        crate::fusion_brain::route_log_event(slot_idx, log_event);
                    }

                    // Skip idle poll chatter — no value during steady state
                    if Self::is_idle_chatter(&cleaned) { continue; }

                    // ── Push to batch buffer for frontend emit ──────
                    batch_buffer.push(LogEntry {
                        slot: slot_idx,
                        alias: alias.clone(),
                        text: cleaned.clone(),
                    });

                    // Batch emit when buffer is full or interval elapsed
                    if Self::flush_batch(&app_handle, slot_idx, &alias, &mut batch_buffer, &mut last_emit, &batch_interval) {
                        // flushed
                    }
                }

                // ── Timer tick — flush stale partial buffer ──────────────
                _ = flush_interval.tick() => {
                    if Self::flush_batch(&app_handle, slot_idx, &alias, &mut batch_buffer, &mut last_emit, &batch_interval) {
                        // flushed
                    }
                }
            }
        }

        // Flush remaining batch on channel close
        if !batch_buffer.is_empty() {
            let _ = app_handle.emit("engine-log-batch", &LogBatch {
                slot: slot_idx,
                alias: alias.clone(),
                entries: std::mem::take(&mut batch_buffer),
            });
        }

        // Log hub reader stopped now routed to Blackwell Output Console
    }

    /// Check if a line is idle poll chatter with no informational value.
    fn is_idle_chatter(line: &str) -> bool {
        line.contains("update_slots: all slots are idle")
            || (line.contains("log_server_r:") && line.contains("done request"))
    }

    /// Flush batch buffer if full or interval elapsed. Returns true if flushed.
    fn flush_batch(
        app_handle: &AppHandle,
        slot_idx: usize,
        alias: &str,
        batch_buffer: &mut Vec<LogEntry>,
        last_emit: &mut tokio::time::Instant,
        batch_interval: &tokio::time::Duration,
    ) -> bool {
        if batch_buffer.len() >= MAX_BATCH_SIZE || last_emit.elapsed() >= *batch_interval {
            let entries = std::mem::take(batch_buffer);
            if !entries.is_empty() {
                let batch = LogBatch { slot: slot_idx, alias: alias.to_string(), entries };
                if let Err(e) = app_handle.emit_to("main", "engine-log-batch", &batch) {
                    // Log hub emit_to failed now routed to Blackwell Output Console
                    let _ = app_handle.emit("engine-log-batch", &batch);
                }
            }
            *last_emit = tokio::time::Instant::now();
            true
        } else {
            false
        }
    }

    /// Emit a system-level event (launch debug, errors) visible in the frontend.
    pub async fn emit_system_event(&self, slot: usize, alias: &str, text: &str) {
        let event = SystemEvent {
            slot,
            alias: alias.to_string(),
            text: format!("[SYSTEM] {}", text),
            timestamp: chrono::Local::now().format("%H:%M:%S%.3f").to_string(),
        };

        if let Err(e) = self.app_handle.emit("engine-system", &event) {
            log::warn!("Failed to emit engine-system event: {}", e);
        }
    }
}
