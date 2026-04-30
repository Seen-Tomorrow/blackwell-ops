use serde::Serialize;
use std::collections::VecDeque;
use tokio::sync::mpsc;
use tauri::AppHandle;
use tauri::Emitter;

#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub slot: usize,
    pub alias: String,
    pub text: String,
    pub timestamp: String,
}

/// System-level event (launch debug, errors) — separate from engine stdout.
#[derive(Debug, Clone, Serialize)]
pub struct SystemEvent {
    pub slot: usize,
    pub alias: String,
    pub text: String,
    pub timestamp: String,
}

/// Batched log event emitted to frontend every 100ms instead of per-line.
#[derive(Debug, Clone, Serialize)]
pub struct LogBatch {
    pub slot: usize,
    pub alias: String,
    pub entries: Vec<LogEntry>,
}

const BATCH_INTERVAL_MS: u64 = 100;
const MAX_BATCH_SIZE: usize = 50;

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

    /// Emit an event to a specific window.
    pub fn emit_to(&self, target: &str, event: &str, payload: impl serde::Serialize + Clone) {
        let _ = self.app_handle.emit_to(target, event, payload);
    }

    /// Starts a log reader that streams stdout/stderr lines through a throttled batch pipeline.
    /// Instead of emitting every line immediately (firehose), it batches entries
    /// and emits them every 100ms to prevent UI lag.
    pub async fn start_log_reader(
        &self,
        slot_idx: usize,
        alias: String,
        stdout: Option<tokio::process::ChildStdout>,
        stderr: Option<tokio::process::ChildStderr>,
    ) {
        let app_handle = self.app_handle.clone();
        let batch_alias = alias.clone();

        // Channel for log reader -> batcher (bounded to prevent memory growth)
        let (tx, rx) = mpsc::unbounded_channel::<LogEntry>();

        // Spawn a dedicated reader task per stream — each sends to the same channel.
        // This avoids complex select! logic with mutable refs and is more reliable.
        if let Some(out) = stdout {
            let tx_clone = tx.clone();
            tokio::spawn(Self::read_stream(slot_idx, alias.clone(), out, tx_clone));
        }

        if let Some(err) = stderr {
            let tx_clone = tx.clone();
            tokio::spawn(Self::read_stream(slot_idx, alias.clone(), err, tx_clone));
        }

        // Batch accumulation task — emits every 100ms or when buffer hits MAX_BATCH_SIZE
        tokio::spawn(Self::batch_loop(
            app_handle,
            slot_idx,
            batch_alias,
            rx,
        ));
    }

    /// Reads lines from a single stream (stdout or stderr) and sends them to the channel.
    async fn read_stream(
        slot: usize,
        alias: String,
        stream: impl tokio::io::AsyncRead + Unpin + Send + 'static,
        tx: mpsc::UnboundedSender<LogEntry>,
    ) {
        use tokio::io::{AsyncBufReadExt, BufReader};

        let reader = BufReader::new(stream);
        let mut lines = reader.lines();
        eprintln!("[LOG_HUB] slot={} stream reader started", slot);

        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if !line.is_empty() {
                        // Replace ESC byte (0x1B) with safe placeholder for JSON transport.
                        // Tauri's serde JSON serialization corrupts raw control characters.
                        let text = line.replace('\x1b', "%%ESC%%");
                        let entry = LogEntry {
                            slot,
                            alias: alias.clone(),
                            text,
                            timestamp: chrono::Local::now().format("%H:%M:%S%.3f").to_string(),
                        };
                        let _ = tx.send(entry);
                    }
                },
                Ok(None) => { break; },
                Err(_) => { break; }
            }
        }
    }

    /// Batcher loop: accumulates log entries and emits batched updates at fixed intervals.
    async fn batch_loop(
        app_handle: AppHandle,
        slot: usize,
        alias: String,
        mut rx: mpsc::UnboundedReceiver<LogEntry>,
    ) {
        let mut buffer: VecDeque<LogEntry> = VecDeque::with_capacity(MAX_BATCH_SIZE);
        let interval = tokio::time::Duration::from_millis(BATCH_INTERVAL_MS);
        let mut last_emit = tokio::time::Instant::now();

        loop {
            tokio::select! {
                // Wait for next log entry or interval tick
                biased; // Prefer receiving entries to keep latency low
                
                Some(entry) = rx.recv() => {
                    buffer.push_back(entry);
                    
                    // Emit immediately if batch is full
                    if buffer.len() >= MAX_BATCH_SIZE {
                        Self::emit_batch(&app_handle, slot, &alias, &mut buffer).await;
                    }
                }

                _ = tokio::time::sleep_until(last_emit + interval) => {
                    // Interval elapsed — emit whatever we have
                    if !buffer.is_empty() {
                        Self::emit_batch(&app_handle, slot, &alias, &mut buffer).await;
                    }
                    last_emit = tokio::time::Instant::now();
                }
            }
        }
    }

    /// Emits accumulated batch as a single Tauri event and clears the buffer.
    async fn emit_batch(
        app_handle: &AppHandle,
        slot: usize,
        alias: &str,
        buffer: &mut VecDeque<LogEntry>,
    ) {
        let count = buffer.len();
        let entries: Vec<LogEntry> = buffer.drain(..).collect();
        
        if !entries.is_empty() {
            eprintln!("[LOG_HUB] emit_batch called for slot={}, entries={}", slot, count);
            let batch = LogBatch {
                slot,
                alias: alias.to_string(),
                entries,
            };
            
            if let Err(e) = app_handle.emit_to("main", "engine-log-batch", &batch) {
                eprintln!("[LOG_HUB] emit_to(main) failed: {}, trying broadcast", e);
                if let Err(e2) = app_handle.emit("engine-log-batch", &batch) {
                    log::error!("Broadcast also failed for slot {}: {}", slot, e2);
                } else {
                    eprintln!("[LOG_HUB] broadcast succeeded");
                }
            } else {
                eprintln!("[LOG_HUB] emit_to(main) succeeded");
            }
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
