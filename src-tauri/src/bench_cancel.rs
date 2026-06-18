//! Per-port bench session control — graceful stop after the in-flight request batch completes.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};

static BENCH_STOP_AFTER: LazyLock<Mutex<HashMap<u16, AtomicBool>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Start a bench session on this port (clears any prior stop request).
pub fn begin(port: u16) {
    if let Ok(mut map) = BENCH_STOP_AFTER.lock() {
        map.insert(port, AtomicBool::new(false));
    }
}

/// User pressed STOP — finish the current HTTP request(s), then exit before the next run.
pub fn request_stop_after_current(port: u16) -> bool {
    let Ok(map) = BENCH_STOP_AFTER.lock() else {
        return false;
    };
    if let Some(flag) = map.get(&port) {
        flag.store(true, Ordering::Relaxed);
        true
    } else {
        false
    }
}

pub fn stop_after_current_requested(port: u16) -> bool {
    let Ok(map) = BENCH_STOP_AFTER.lock() else {
        return false;
    };
    map.get(&port)
        .map(|f| f.load(Ordering::Relaxed))
        .unwrap_or(false)
}

pub fn end(port: u16) {
    if let Ok(mut map) = BENCH_STOP_AFTER.lock() {
        map.remove(&port);
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

/// POST JSON to llama-server `/completion` — runs to completion (no mid-flight abort).
pub async fn post_json(
    client: &reqwest::Client,
    url: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let resp = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Connection", "close")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let server_msg = extract_server_error_message(&body);
        return Err(friendly_bench_http_error(status, server_msg.as_deref()));
    }
    resp.json().await.map_err(|e| e.to_string())
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
}

/// Bench HTTP client — enough idle connections for parallel completion feeds.
pub fn bench_http_client(max_parallel: usize) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .pool_max_idle_per_host(max_parallel.max(8))
        .tcp_nodelay(true)
        .build()
        .map_err(|e| format!("HTTP client: {}", e))
}

#[tauri::command]
pub fn cmd_cancel_bench(port: u16) -> Result<bool, String> {
    Ok(request_stop_after_current(port))
}