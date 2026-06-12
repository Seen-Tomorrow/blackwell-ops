//! Per-port cancellation for in-flight TG/PP benchmark HTTP requests.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use tokio_util::sync::CancellationToken;

static BENCH_CANCEL: LazyLock<Mutex<HashMap<u16, CancellationToken>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Register (or replace) the active bench cancel token for a port.
pub fn begin(port: u16) -> CancellationToken {
    let token = CancellationToken::new();
    if let Ok(mut map) = BENCH_CANCEL.lock() {
        map.insert(port, token.clone());
    }
    token
}

/// Signal cancel for the bench currently running on this port.
pub fn cancel(port: u16) -> bool {
    let token = BENCH_CANCEL
        .lock()
        .ok()
        .and_then(|map| map.get(&port).cloned());
    if let Some(token) = token {
        token.cancel();
        true
    } else {
        false
    }
}

pub fn end(port: u16) {
    if let Ok(mut map) = BENCH_CANCEL.lock() {
        map.remove(&port);
    }
}

pub fn is_cancelled(token: &CancellationToken) -> bool {
    token.is_cancelled()
}

/// POST JSON to llama-server `/completion` (or similar), aborting when `cancel` fires.
pub async fn post_json_cancellable(
    client: &reqwest::Client,
    url: &str,
    body: &serde_json::Value,
    cancel: &CancellationToken,
) -> Result<serde_json::Value, String> {
    if cancel.is_cancelled() {
        return Err("Cancelled".to_string());
    }

    let request = client
        .post(url)
        .header("Content-Type", "application/json")
        .json(body);

    tokio::select! {
        result = request.send() => {
            let resp = result.map_err(|e| format!("Request failed: {}", e))?;
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
        _ = cancel.cancelled() => Err("Cancelled".to_string()),
    }
}

#[tauri::command]
pub fn cmd_cancel_bench(port: u16) -> Result<bool, String> {
    Ok(cancel(port))
}