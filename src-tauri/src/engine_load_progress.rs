//! Subscribe to llama-server `GET /models/sse` during LOADING and forward progress to the UI.
//!
//! Event shape (router + single-model foundry patch):
//! ```json
//! {"model":"...","event":"status_change","data":{"status":"loading","progress":{"stages":["text_model"],"current":"text_model","value":0.42}}}
//! {"model":"...","event":"status_change","data":{"status":"loaded",...}}
//! ```
//!
//! Product launches use `-m` (single-model). Upstream only registers `/models/sse` in router mode;
//! our foundry `server.cpp` patch exposes the same route for single-model cold boot (HTTP starts
//! before `load_model`). Until that binary is rebuilt, connect attempts 404 and this task exits
//! quietly — stderr phase parsing remains the fallback.

use crate::engine_stack::SlotStatus;
use crate::log_hub::LogHub;
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const CONNECT_RETRY_MS: u64 = 150;
const CONNECT_GIVE_UP_AFTER: Duration = Duration::from_secs(120);
const READ_IDLE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone)]
pub struct LoadProgressEvent {
    pub slot: usize,
    pub port: u16,
    pub status: String,
    pub stage: String,
    pub stages: Vec<String>,
    pub value: f64,
    pub raw_event: String,
}

fn still_loading(slot_arc: &Arc<Mutex<crate::engine_stack::EngineSlot>>) -> bool {
    matches!(slot_arc.lock().status, SlotStatus::Loading)
}

fn parse_sse_json_line(line: &str) -> Option<Value> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with(':') {
        return None;
    }
    let payload = if let Some(rest) = trimmed.strip_prefix("data:") {
        rest.trim()
    } else {
        trimmed
    };
    if payload.is_empty() || payload == "[DONE]" {
        return None;
    }
    serde_json::from_str(payload).ok()
}

fn extract_progress(v: &Value) -> Option<LoadProgressEvent> {
    // Accept both top-level and nested data envelopes.
    let event_name = v.get("event").and_then(|x| x.as_str()).unwrap_or("");
    let data = v.get("data").cloned().unwrap_or_else(|| v.clone());
    let status = data
        .get("status")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();

    // progress may live under data.progress or top-level progress / load_progress
    let progress = data
        .get("progress")
        .cloned()
        .or_else(|| v.get("progress").cloned())
        .or_else(|| v.get("load_progress").cloned());

    let mut stage = String::new();
    let mut stages: Vec<String> = Vec::new();
    let mut value = -1.0_f64;

    if let Some(p) = progress {
        if let Some(n) = p.as_f64() {
            // bare number: {"load_progress": 0.42}
            value = n;
        } else if p.is_object() {
            if let Some(n) = p.get("value").and_then(|x| x.as_f64()) {
                value = n;
            }
            if let Some(s) = p.get("current").and_then(|x| x.as_str()) {
                stage = s.to_string();
            } else if let Some(s) = p.get("stage").and_then(|x| x.as_str()) {
                stage = s.to_string();
            }
            if let Some(arr) = p.get("stages").and_then(|x| x.as_array()) {
                stages = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect();
            }
        }
    }

    // Interesting if we have a status transition or a numeric progress sample.
    let interesting = !status.is_empty()
        || value >= 0.0
        || event_name == "status_change"
        || event_name == "model_status";
    if !interesting {
        return None;
    }

    Some(LoadProgressEvent {
        slot: 0, // filled by caller
        port: 0,
        status,
        stage,
        stages,
        value,
        raw_event: event_name.to_string(),
    })
}

fn emit_progress(log_hub: &LogHub, slot: usize, port: u16, mut ev: LoadProgressEvent) {
    ev.slot = slot;
    ev.port = port;
    let value = if ev.value.is_finite() && ev.value >= 0.0 {
        Some(ev.value.clamp(0.0, 1.0))
    } else {
        None
    };
    let payload = serde_json::json!({
        "slot": slot,
        "port": port,
        "status": ev.status,
        "stage": ev.stage,
        "stages": ev.stages,
        "value": value,
        "event": ev.raw_event,
    });
    log_hub.emit("engine-load-progress", &payload);
}

/// Spawn a background task that retries SSE connect while the slot is LOADING.
pub fn spawn_models_sse_progress(
    port: u16,
    alias: String,
    slot_idx: usize,
    log_hub: LogHub,
    slot_arc: Arc<Mutex<crate::engine_stack::EngineSlot>>,
    cancel: Arc<AtomicBool>,
) {
    tokio::spawn(async move {
        let client = match reqwest::Client::builder()
            .connect_timeout(Duration::from_millis(400))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[load-sse] client init failed port={port}: {e}");
                return;
            }
        };

        let url = format!("http://127.0.0.1:{port}/models/sse");
        let started = std::time::Instant::now();
        let mut warned_404 = false;
        let mut warned_503 = false;

        while still_loading(&slot_arc)
            && !cancel.load(Ordering::Relaxed)
            && started.elapsed() < CONNECT_GIVE_UP_AFTER
        {
            if !still_loading(&slot_arc) {
                return;
            }

            let resp = match client
                .get(&url)
                .header("Accept", "text/event-stream")
                .header("Cache-Control", "no-cache")
                .send()
                .await
            {
                Ok(r) => r,
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(CONNECT_RETRY_MS)).await;
                    continue;
                }
            };

            let status = resp.status();
            if status.as_u16() == 404 {
                // Upstream single-model without foundry patch — quiet exit.
                if !warned_404 {
                    warned_404 = true;
                    log::info!(
                        "[load-sse] /models/sse 404 on :{port} (single-model without progress route) — stderr fallback"
                    );
                }
                return;
            }
            if status.as_u16() == 503 {
                // Pre-allowlist builds: middleware returns "Loading model" until is_ready.
                // Retry — post-patch /models/sse is whitelisted during load.
                if !warned_503 {
                    warned_503 = true;
                    log::info!(
                        "[load-sse] /models/sse 503 on :{port} while loading — retrying (middleware may block until patched)"
                    );
                }
                tokio::time::sleep(Duration::from_millis(CONNECT_RETRY_MS)).await;
                continue;
            }
            if !status.is_success() {
                tokio::time::sleep(Duration::from_millis(CONNECT_RETRY_MS)).await;
                continue;
            }

            log_hub.emit_console_line(
                crate::output_console::BlackwellOutputConsoleCategory::Debug,
                &format!("[{alias}] load-progress SSE connected :{port}"),
                crate::output_console::BlackwellOutputConsoleLineStyle::Normal,
            );

            let mut stream = resp.bytes_stream();
            let mut buf = String::new();

            loop {
                if cancel.load(Ordering::Relaxed) || !still_loading(&slot_arc) {
                    return;
                }

                let next = tokio::time::timeout(READ_IDLE_TIMEOUT, stream.next()).await;
                let chunk = match next {
                    Ok(Some(Ok(bytes))) => bytes,
                    Ok(Some(Err(_))) => break, // reconnect
                    Ok(None) => break,
                    Err(_) => {
                        // idle timeout — keep waiting while loading
                        continue;
                    }
                };

                buf.push_str(&String::from_utf8_lossy(&chunk));
                while let Some(pos) = buf.find('\n') {
                    let mut line = buf[..pos].to_string();
                    buf = buf[pos + 1..].to_string();
                    if line.ends_with('\r') {
                        line.pop();
                    }
                    if let Some(v) = parse_sse_json_line(&line) {
                        if let Some(ev) = extract_progress(&v) {
                            let terminal = ev.status == "loaded"
                                || ev.status == "failed"
                                || ev.status == "unloaded";
                            emit_progress(&log_hub, slot_idx, port, ev);
                            if terminal {
                                return;
                            }
                        }
                    }
                }
            }

            // stream dropped while still loading — retry connect
            tokio::time::sleep(Duration::from_millis(CONNECT_RETRY_MS)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status_change_progress() {
        let v: Value = serde_json::from_str(
            r#"{"model":"m","event":"status_change","data":{"status":"loading","progress":{"stages":["text_model"],"current":"text_model","value":0.42}}}"#,
        )
        .unwrap();
        let ev = extract_progress(&v).expect("progress");
        assert_eq!(ev.status, "loading");
        assert_eq!(ev.stage, "text_model");
        assert!((ev.value - 0.42).abs() < 1e-6);
        assert_eq!(ev.stages, vec!["text_model".to_string()]);
    }

    #[test]
    fn parses_loaded() {
        let v: Value = serde_json::from_str(
            r#"{"model":"m","event":"status_change","data":{"status":"loaded","info":{}}}"#,
        )
        .unwrap();
        let ev = extract_progress(&v).expect("loaded");
        assert_eq!(ev.status, "loaded");
    }

    #[test]
    fn parses_bare_load_progress_number() {
        let v: Value = serde_json::from_str(r#"{"load_progress":0.5}"#).unwrap();
        let ev = extract_progress(&v).expect("num");
        assert!((ev.value - 0.5).abs() < 1e-6);
    }
}
