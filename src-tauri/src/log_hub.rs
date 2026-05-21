use serde::Serialize;
use tokio::sync::mpsc;
use tauri::AppHandle;
use tauri::Emitter;

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

/// Batched log event emitted to frontend every 25ms instead of per-line.
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
            eprintln!("[LOG_HUB] emit failed: {}", e);
        }
    }

    /// Spawns the slot's log reader task.
    /// Reads stderr pipe, processes lines (noise suppression),
    /// batches and emits "engine-log-batch" to frontend every 10ms or MAX_BATCH_SIZE entries,
    /// detects readiness ("server is listening" / "all slots idle"),
    /// and returns a fan-out channel for subscribers (e.g., PerfMonitor).
    pub fn spawn_slot_reader(
        &self,
        slot_idx: usize,
        alias: String,
        stderr: std::process::ChildStderr,
        on_ready: impl Fn() + Send + Sync + 'static,
    ) -> mpsc::UnboundedReceiver<String> {
        let app_handle = self.app_handle.clone();

        // Internal channel: pipe readers → main processing loop
        let (line_tx, line_rx) = mpsc::unbounded_channel::<String>();
        // Fan-out channel: processed lines → subscribers (PerfMonitor)
        let (fanout_tx, fanout_rx) = mpsc::unbounded_channel::<String>();

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
                            eprintln!("[LOG_HUB] slot={} stderr read error: {}", slot_idx, e);
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
            alias.clone(),
            line_rx,
            fanout_tx,
            on_ready,
        ));

        eprintln!("[LOG_HUB] slot={} reader started", slot_idx);
        fanout_rx
    }

    /// Main processing loop: consumes raw lines from pipe readers, applies pipeline, batches to frontend.
    async fn process_lines(
        app_handle: AppHandle,
        slot_idx: usize,
        alias: String,
        mut line_rx: mpsc::UnboundedReceiver<String>,
        fanout_tx: mpsc::UnboundedSender<String>,
        on_ready: impl Fn() + Send + Sync + 'static,
    ) {
        let mut batch_buffer: Vec<LogEntry> = Vec::with_capacity(MAX_BATCH_SIZE);
        let mut last_emit = tokio::time::Instant::now();
        let batch_interval = tokio::time::Duration::from_millis(BATCH_INTERVAL_MS);

        // Readiness tracking — one-shot check for "server is listening" / "all slots idle"
        let mut engine_ready = false;

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

                    // ── Readiness check (one-shot) ──────────────
                    if !engine_ready {
                        let lower = cleaned.to_lowercase();
                        if lower.contains("server is listening on") || lower.contains("all slots are idle") {
                            engine_ready = true;
                            on_ready();
                            eprintln!("[READINESS] slot={} engine ready", slot_idx);
                        }
                    }

                    // ── Suppress llama.cpp server idle poll noise ──
                    let is_poll_noise = cleaned.contains("done request")
                        || cleaned.contains("update_slots: all slots are idle");

                    if !is_poll_noise {
                        batch_buffer.push(LogEntry {
                            slot: slot_idx,
                            alias: alias.clone(),
                            text: cleaned.clone(),
                        });
                    }

                    // ── Fan-out to subscribers (PerfMonitor) ────────────
                    let _ = fanout_tx.send(cleaned);

                    // Batch emit every 10ms or when buffer is full
                    if batch_buffer.len() >= MAX_BATCH_SIZE || last_emit.elapsed() >= batch_interval {
                        let entries = std::mem::take(&mut batch_buffer);
                        if !entries.is_empty() {
                            let batch = LogBatch { slot: slot_idx, alias: alias.clone(), entries };

                            if let Err(e) = app_handle.emit_to("main", "engine-log-batch", &batch) {
                                eprintln!("[LOG_HUB] emit_to(main) failed: {}, trying broadcast", e);
                                let _ = app_handle.emit("engine-log-batch", &batch);
                            }
                        }
                        last_emit = tokio::time::Instant::now();
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

        eprintln!("[LOG_HUB] slot={} reader stopped (channel closed)", slot_idx);
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

    // SANITY-BOX — emit a Rust-side log entry to the frontend sanity box
    pub fn emit_sanity_log(&self, level: &str, text: &str) {
        #[derive(Serialize)]
        struct SanityPayload {
            source: &'static str,
            level: String,
            text: String,
            timestamp: String,
        }
        let payload = SanityPayload {
            source: "rust",
            level: level.to_string(),
            text: text.to_string(),
            timestamp: chrono::Local::now().format("%H:%M:%S%.3f").to_string(),
        };
        let _ = self.app_handle.emit("sanity-log", &payload);
    }
}
