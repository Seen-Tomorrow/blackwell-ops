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
        let msg = if status.as_u16() == 400 {
            format!(
                "Server rejected ({}). Prompt may exceed engine n_ctx — try smaller target or increase context window.",
                status
            )
        } else {
            format!("Server returned error: {}", status)
        };
        return Err(msg);
    }
    resp.json().await.map_err(|e| e.to_string())
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