//! Per-port bench session control — STOP aborts in-flight `/completion`.
//!
//! llama-server only observes client disconnect while writing a response.
//! `stream: false` writes nothing until generation finishes, so dropping the
//! socket is invisible. Completions therefore use SSE (`stream: true`).
//!
//! STOP:
//! 1. Latches a watch flag (survives a race with `begin`)
//! 2. `AbortHandle::abort()` on every in-flight request task (drops reqwest)
//! 3. Best-effort `POST /slots/{id}/release` (some forks honour it)

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use tokio::sync::watch;
use tokio::task::AbortHandle;

/// Returned when the user hits STOP (UI treats as cancelled, not a hard failure).
pub const STOPPED_ERR: &str = "Stopped";

struct PortStop {
    tx: watch::Sender<bool>,
    /// Kept alive so `send` cannot fail before waiters subscribe.
    _rx: watch::Receiver<bool>,
    aborts: Mutex<Vec<AbortHandle>>,
}

static BENCH_STOP: LazyLock<Mutex<HashMap<u16, Arc<PortStop>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn fresh_stop() -> Arc<PortStop> {
    let (tx, rx) = watch::channel(false);
    Arc::new(PortStop {
        tx,
        _rx: rx,
        aborts: Mutex::new(Vec::new()),
    })
}

fn get_stop(port: u16) -> Option<Arc<PortStop>> {
    BENCH_STOP.lock().ok()?.get(&port).cloned()
}

fn ensure_stop(port: u16) -> Option<Arc<PortStop>> {
    let mut map = BENCH_STOP.lock().ok()?;
    Some(map.entry(port).or_insert_with(fresh_stop).clone())
}

fn register_abort(port: u16, handle: AbortHandle) {
    if let Some(slot) = get_stop(port) {
        if let Ok(mut aborts) = slot.aborts.lock() {
            aborts.push(handle);
        }
    }
}

fn abort_inflight(slot: &PortStop) {
    if let Ok(mut aborts) = slot.aborts.lock() {
        let n = aborts.len();
        for handle in aborts.drain(..) {
            handle.abort();
        }
        if n > 0 {
            log::info!("[BENCH] aborted {n} in-flight HTTP task(s)");
        }
    }
}

/// Start a bench session on this port. Keeps a STOP that already landed during startup.
pub fn begin(port: u16) {
    let Ok(mut map) = BENCH_STOP.lock() else {
        return;
    };
    if let Some(existing) = map.get(&port) {
        if *existing.tx.borrow() {
            return;
        }
    }
    map.insert(port, fresh_stop());
}

/// User pressed STOP — abort in-flight HTTP and skip remaining runs.
/// Always inserts the flag so a STOP that races `begin` is not a no-op.
pub fn request_stop_after_current(port: u16) -> bool {
    let Some(slot) = ensure_stop(port) else {
        return false;
    };
    slot.tx.send_replace(true);
    abort_inflight(&slot);
    true
}

pub fn stop_after_current_requested(port: u16) -> bool {
    get_stop(port)
        .map(|s| *s.tx.borrow())
        .unwrap_or(false)
}

pub fn end(port: u16) {
    if let Ok(mut map) = BENCH_STOP.lock() {
        if let Some(slot) = map.remove(&port) {
            abort_inflight(&slot);
        }
    }
}

pub fn is_stopped_err(err: &str) -> bool {
    err == STOPPED_ERR || err == "Cancelled"
}

/// Run `fut` on a child task so STOP can `abort()` it from another command.
pub async fn race_stop<T, F>(port: u16, fut: F) -> Result<T, String>
where
    F: Future<Output = Result<T, String>> + Send + 'static,
    T: Send + 'static,
{
    if stop_after_current_requested(port) {
        return Err(STOPPED_ERR.into());
    }
    let handle = tokio::spawn(fut);
    register_abort(port, handle.abort_handle());
    let joined = handle.await;
    if stop_after_current_requested(port) {
        return Err(STOPPED_ERR.into());
    }
    match joined {
        Ok(result) => result,
        Err(e) if e.is_cancelled() => Err(STOPPED_ERR.into()),
        Err(e) => Err(format!("Bench task failed: {e}")),
    }
}

fn extract_server_error_message(body: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    if let Some(msg) = parsed.get("message").and_then(|v| v.as_str()) {
        return Some(msg.to_string());
    }
    parsed
        .pointer("/error/message")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn truncate_detail(msg: &str, max_len: usize) -> String {
    if msg.chars().count() <= max_len {
        return msg.to_string();
    }
    let end = msg
        .char_indices()
        .nth(max_len.saturating_sub(1))
        .map(|(i, _)| i)
        .unwrap_or(msg.len());
    format!("{}…", &msg[..end])
}

/// Turn llama-server HTTP failures into bench-friendly copy (engine-owned failures).
fn friendly_bench_http_error(status: reqwest::StatusCode, server_message: Option<&str>) -> String {
    let code = status.as_u16();
    let msg = server_message.unwrap_or("");
    let lower = msg.to_ascii_lowercase();

    if code == 400 {
        if lower.contains("context") || lower.contains("exceed") {
            return "Prompt exceeded context size".to_string();
        }
        if !msg.is_empty() {
            return format!("Bad request: {}", truncate_detail(msg, 140));
        }
        return "Bad request".to_string();
    }

    if lower.contains("does not match the expected")
        || lower.contains("content-only")
        || lower.contains("chat_peg_parse")
        || lower.contains("unparsed")
    {
        return "Model output didn't match the engine chat parser. Reasoning or chat-heavy models often fail Repetitive bench — try Unique mode or a base instruct model.".to_string();
    }

    if !msg.is_empty() {
        return format!(
            "Engine error (HTTP {}): {}",
            code,
            truncate_detail(msg, 140)
        );
    }

    format!("Engine returned HTTP {code} — see engine log for details")
}

fn is_completion_result(v: &serde_json::Value) -> bool {
    v.get("timings").is_some()
        || v.get("tokens_evaluated").is_some()
        || v.get("tokens_predicted").is_some()
        || v.get("stop").and_then(|s| s.as_bool()) == Some(true)
}

fn take_sse_objects(buf: &mut String, last: &mut Option<serde_json::Value>) {
    while let Some(pos) = buf.find('\n') {
        let mut line = buf[..pos].to_string();
        *buf = buf[pos + 1..].to_string();
        if line.ends_with('\r') {
            line.pop();
        }
        let line = line.trim();
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let data = line.strip_prefix("data:").map(str::trim).unwrap_or(line);
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
            if is_completion_result(&v) {
                *last = Some(v);
            }
        }
    }
}

async fn collect_sse_json(resp: reqwest::Response) -> Result<serde_json::Value, String> {
    let mut buf = String::new();
    let mut last = None;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Request failed: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        take_sse_objects(&mut buf, &mut last);
    }
    take_sse_objects(&mut buf, &mut last);
    if !buf.trim().is_empty() {
        let data = buf.trim().strip_prefix("data:").map(str::trim).unwrap_or(buf.trim());
        if data != "[DONE]" {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                last = Some(v);
            }
        }
    }
    last.ok_or_else(|| "Empty completion stream".into())
}

async fn send_completion(
    client: reqwest::Client,
    url: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let stream = body.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Connection", "close")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let server_msg = extract_server_error_message(&text);
        return Err(friendly_bench_http_error(status, server_msg.as_deref()));
    }
    if stream {
        collect_sse_json(resp).await
    } else {
        resp.json().await.map_err(|e| e.to_string())
    }
}

/// POST JSON to llama-server. Honours STOP by aborting the HTTP request mid-flight.
pub async fn post_json(
    client: &reqwest::Client,
    url: &str,
    body: &serde_json::Value,
    port: u16,
) -> Result<serde_json::Value, String> {
    let client = client.clone();
    let url = url.to_string();
    let body = body.clone();
    race_stop(port, async move { send_completion(client, url, body).await }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_llama_server_error_json() {
        let body = r#"{"code":500,"message":"The model produced output that does not match the expected Content-only format","type":"server_error"}"#;
        let msg = extract_server_error_message(body).unwrap();
        assert!(msg.contains("Content-only"));
    }

    #[test]
    fn chat_parser_mismatch_gets_friendly_copy() {
        let err = friendly_bench_http_error(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            Some("The model produced output that does not match the expected Content-only format"),
        );
        assert!(err.contains("chat parser"));
        assert!(err.contains("Unique mode"));
    }

    #[test]
    fn bare_500_without_body_is_actionable() {
        let err = friendly_bench_http_error(reqwest::StatusCode::INTERNAL_SERVER_ERROR, None);
        assert!(err.contains("HTTP 500"));
        assert!(err.contains("engine log"));
    }

    #[test]
    fn stop_without_begin_is_not_noop() {
        let port = 59_901;
        end(port);
        assert!(!stop_after_current_requested(port));
        assert!(request_stop_after_current(port));
        assert!(stop_after_current_requested(port));
        begin(port);
        assert!(
            stop_after_current_requested(port),
            "begin must not clear a STOP that already landed"
        );
        end(port);
    }

    #[tokio::test]
    async fn race_stop_returns_immediately_when_already_flagged() {
        let port = 59_902;
        end(port);
        begin(port);
        assert!(request_stop_after_current(port));
        let start = std::time::Instant::now();
        let result = race_stop(port, async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok::<(), String>(())
        })
        .await;
        assert!(is_stopped_err(&result.unwrap_err()));
        assert!(start.elapsed() < Duration::from_millis(500));
        end(port);
    }

    #[tokio::test]
    async fn race_stop_wakes_when_stop_arrives_mid_wait() {
        let port = 59_903;
        end(port);
        begin(port);
        let stopper = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            assert!(request_stop_after_current(port));
        });
        let start = std::time::Instant::now();
        let result = race_stop(port, async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok::<(), String>(())
        })
        .await;
        let _ = stopper.await;
        assert!(is_stopped_err(&result.unwrap_err()));
        assert!(start.elapsed() < Duration::from_millis(500));
        end(port);
    }

    #[test]
    fn sse_keeps_last_completion_object() {
        let mut buf = String::from(
            "data: {\"content\":\"a\",\"stop\":false}\n\
             data: {\"tokens_predicted\":64,\"tokens_evaluated\":12,\"timings\":{\"prompt_ms\":10.0,\"predicted_ms\":20.0},\"stop\":true}\n\
             data: [DONE]\n",
        );
        let mut last = None;
        take_sse_objects(&mut buf, &mut last);
        let v = last.expect("final SSE object");
        assert_eq!(v["tokens_predicted"], 64);
        assert_eq!(v["timings"]["predicted_ms"], 20.0);
    }

    #[test]
    fn sse_skips_prompt_progress_events() {
        let mut buf = String::from(
            "data: {\"prompt_progress\":{\"total\":8000,\"processed\":512}}\n\
             data: {\"tokens_evaluated\":8000,\"timings\":{\"prompt_ms\":40.0},\"stop\":true}\n",
        );
        let mut last = None;
        take_sse_objects(&mut buf, &mut last);
        let v = last.expect("completion after progress");
        assert_eq!(v["tokens_evaluated"], 8000);
        assert!(v.get("prompt_progress").is_none());
    }
}

/// RAII guard — drops `bench_cancel::end(port)` when the bench scope exits.
pub struct BenchPortGuard(pub u16);

impl Drop for BenchPortGuard {
    fn drop(&mut self) {
        end(self.0);
    }
}

async fn slot_ids(client: &reqwest::Client, port: u16) -> Vec<u64> {
    let Ok(resp) = client
        .get(format!("http://127.0.0.1:{port}/slots"))
        .send()
        .await
    else {
        return vec![0];
    };
    let Ok(slots) = resp.json::<Vec<serde_json::Value>>().await else {
        return vec![0];
    };
    if slots.is_empty() {
        return vec![0];
    }
    slots
        .iter()
        .enumerate()
        .map(|(i, slot)| slot["id"].as_u64().unwrap_or(i as u64))
        .collect()
}

/// Release every llama-server slot KV cache on a port (prompt-cache clear before bench).
pub async fn release_all_slots(client: &reqwest::Client, port: u16, label: &str) {
    let ids = slot_ids(client, port).await;
    for idx in &ids {
        let _ = client
            .post(format!("http://127.0.0.1:{port}/slots/{idx}/release"))
            .send()
            .await;
    }
    log::debug!("[BENCH] released {} slots {}", ids.len(), label);
}

/// Abort in-flight slot work. Separate short-timeout client — must not share the
/// bench pool that is blocked in `/completion`.
async fn abort_engine_slots(port: u16) {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_millis(800))
        .pool_max_idle_per_host(0)
        .tcp_nodelay(true)
        .build()
    else {
        return;
    };
    let ids = slot_ids(&client, port).await;
    log::info!("[BENCH] STOP aborting {} slot(s) on :{port}", ids.len());
    for idx in ids {
        let _ = client
            .post(format!("http://127.0.0.1:{port}/slots/{idx}/release"))
            .send()
            .await;
        let _ = client
            .post(format!("http://127.0.0.1:{port}/slots/{idx}?action=release"))
            .send()
            .await;
        let _ = client
            .post(format!("http://127.0.0.1:{port}/slots/{idx}?action=erase"))
            .send()
            .await;
    }
}

/// Bench HTTP client. No idle pool — dropped requests must close TCP.
pub fn bench_http_client(_max_parallel: usize) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .pool_max_idle_per_host(0)
        .tcp_nodelay(true)
        .build()
        .map_err(|e| format!("HTTP client: {}", e))
}

#[tauri::command]
pub async fn cmd_cancel_bench(port: u16) -> Result<bool, String> {
    let flagged = request_stop_after_current(port);
    log::info!("[BENCH] STOP port={port} flag={flagged}");
    abort_engine_slots(port).await;
    Ok(flagged)
}