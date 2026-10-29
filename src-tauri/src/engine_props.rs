//! Read-only engine introspection for client-facing capabilities.
//!
//! The engine's `/props` exposes the loaded chat template's actual
//! `reasoning_effort_levels` (llama.cpp v0.8). The Fusion display shows these so
//! the operator knows which `reasoning_effort` values a client can send; the
//! launch `--reasoning-budget` remains a separate, global cap.

use std::time::Duration;

use serde_json::{json, Value};

fn parse_reasoning_caps(body: &Value) -> Value {
    let caps = body.get("chat_template_caps");
    let supported = caps
        .and_then(|c| c.get("supports_reasoning_effort"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let levels = caps
        .and_then(|c| c.get("reasoning_effort_levels"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    json!({ "supported": supported, "levels": levels })
}

/// Query the live engine's `/props` for the chat-template effort levels.
#[tauri::command]
pub async fn get_engine_reasoning_levels(port: u16) -> Result<Value, String> {
    if port == 0 {
        return Err("No engine port".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;

    let response = client
        .get(format!("http://127.0.0.1:{port}/props"))
        .send()
        .await
        .map_err(|e| format!("GET /props: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("GET /props returned {}", response.status()));
    }

    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("GET /props body: {e}"))?;
    Ok(parse_reasoning_caps(&body))
}

#[cfg(test)]
mod tests {
    use super::parse_reasoning_caps;
    use serde_json::json;

    #[test]
    fn parses_template_effort_levels() {
        let caps = parse_reasoning_caps(&json!({
            "chat_template_caps": {
                "supports_reasoning_effort": true,
                "reasoning_effort_levels": ["low", "high", "max"]
            }
        }));
        assert_eq!(caps["supported"], true);
        assert_eq!(caps["levels"], json!(["low", "high", "max"]));
    }

    #[test]
    fn missing_caps_is_empty_not_an_error() {
        let caps = parse_reasoning_caps(&json!({}));
        assert_eq!(caps["supported"], false);
        assert_eq!(caps["levels"], json!([]));
    }
}
