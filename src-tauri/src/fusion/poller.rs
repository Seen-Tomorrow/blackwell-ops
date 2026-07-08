//! Fusion Poller — HTTP polling for /slots and /metrics endpoints.
//! Zero logic, zero state. Just fetch + deserialize.

// ── /slots deserialization types ─────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct SlotData {
    pub id: usize,
    #[serde(default)]
    pub is_processing: bool,
    #[serde(default)]
    pub next_token: Vec<TokenInfo>,
    // NOTE: n_prompt_tokens = prompt.tokens.size() in server (grows during eval), NOT task.n_tokens.
    // Use NewPrompt log + n_prompt_tokens_processed for prefill progress; do not use this as progress total.
    #[serde(default)]
    pub n_prompt_tokens: usize,
    #[serde(default)]
    pub n_prompt_tokens_processed: usize,
    #[serde(default)]
    pub n_prompt_tokens_cache: usize,
    #[serde(default)]
    #[allow(dead_code)]
    pub n_ctx: usize,
    // Additional useful fields from full /slots response (not yet heavily used in fusion but valuable for phase, gen progress, compaction awareness, etc.)
    #[serde(default)]
    pub id_task: Option<i64>,
    #[serde(default)]
    pub speculative: bool,
    // IK engine /slots uses numeric state+command instead of is_processing + prompt token fields.
    #[serde(default)]
    #[allow(dead_code)]
    pub state: i32,
    #[serde(default)]
    #[allow(dead_code)]
    pub command: i32,
}



#[derive(serde::Deserialize)]
pub struct TokenInfo {
    pub n_decoded: usize,
    #[allow(dead_code)]
    pub has_next_token: bool,
    // n_remain is very useful: tokens remaining in this generation request (negative often means unlimited / until stop)
    #[serde(default)]
    pub n_remain: i64,
    #[serde(default)]
    #[allow(dead_code)]
    pub has_new_line: bool,
}

/// Lightweight liveness probe — no JSON body parse beyond status=ok.
pub async fn poll_health_ok(client: &reqwest::Client, port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/health");
    let Ok(resp) = client.get(&url).send().await else {
        return false;
    };
    if !resp.status().is_success() {
        return false;
    }
    let Ok(body) = resp.json::<serde_json::Value>().await else {
        return false;
    };
    body["status"].as_str() == Some("ok")
}

/// Poll /slots endpoint. Returns per-slot snapshots or error.
pub async fn poll_slots(client: &reqwest::Client, port: u16) -> Result<Vec<SlotData>, String> {
    poll_slots_on(client, "localhost", port).await
}

/// Poll /slots on a specific host (readiness probes use 127.0.0.1 to match engine bind + /health).
pub async fn poll_slots_on(
    client: &reqwest::Client,
    host: &str,
    port: u16,
) -> Result<Vec<SlotData>, String> {
    let url = format!("http://{host}:{port}/slots");
    let resp = client.get(&url).send().await.map_err(|e| format!("HTTP error: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Status {}", resp.status()));
    }

    let slots: Vec<SlotData> = resp
        .json::<Vec<SlotData>>()
        .await
        .map_err(|e| format!("JSON parse: {}", e))?;
    Ok(slots)
}

// ── /metrics deserialization types ───────────────────────────────────

#[derive(Debug, Clone)]
pub struct MetricsSnapshot {
    pub prompt_tokens_total: usize,
    pub prompt_seconds_total: f64,
    pub predicted_tokens_total: usize,
    pub prompt_tps_gauge: f64,
    pub requests_processing: usize,
    // Additional potentially useful gauges/counters from full /metrics (llama.cpp server exposes several; we capture what is present for future richer fusion/perf viz)
    #[allow(dead_code)]
    pub predicted_tps_gauge: f64,  // generation t/s gauge (often "llamacpp:predicted_tokens_seconds" or "tokens_predicted_seconds")
    #[allow(dead_code)]
    pub n_decode_total: usize,     // total decode steps (busy indicator)
    #[allow(dead_code)]
    pub n_busy_slots_total: usize, // cumulative busy slot count
}

/// Poll /metrics endpoint. Returns parsed Prometheus counters or error.
pub async fn poll_metrics(client: &reqwest::Client, port: u16) -> Result<MetricsSnapshot, String> {
    let url = format!("http://localhost:{}/metrics", port);
    let resp = client.get(&url).send().await.map_err(|e| format!("HTTP error: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Status {}", resp.status()));
    }

    let text = resp.text().await.map_err(|e| format!("Read text: {}", e))?;
    parse_prometheus_text(&text)
}

/// Parse Prometheus text format into MetricsSnapshot.
fn parse_prometheus_text(text: &str) -> Result<MetricsSnapshot, String> {
    let mut prompt_tokens_total: Option<usize> = None;
    let mut prompt_seconds_total: Option<f64> = None;
    let mut predicted_tokens_total: Option<usize> = None;
    let mut prompt_tps_gauge: Option<f64> = None;
    let mut requests_processing: Option<usize> = None;
    let mut predicted_tps_gauge: Option<f64> = None;
    let mut n_decode_total: Option<usize> = None;
    let mut n_busy_slots_total: Option<usize> = None;

    for line in text.lines() {
        if line.starts_with('#') || line.is_empty() {
            continue;
        }

        // Format: "llamacpp:key_name value" — split on last space
        if let Some(space_idx) = line.rfind(' ') {
            let key = &line[..space_idx];
            let val_str = &line[space_idx + 1..];

            match key {
                "llamacpp:prompt_tokens_total" => {
                    prompt_tokens_total = parse_usize(val_str);
                }
                "llamacpp:prompt_seconds_total" => {
                    prompt_seconds_total = parse_f64(val_str);
                }
                "llamacpp:tokens_predicted_total" => {
                    predicted_tokens_total = parse_usize(val_str);
                }
                "llamacpp:prompt_tokens_seconds" => {
                    prompt_tps_gauge = parse_f64(val_str);
                }
                "llamacpp:requests_processing" => {
                    requests_processing = parse_usize(val_str);
                }
                // Gen TPS gauge (name varies slightly across versions)
                "llamacpp:predicted_tokens_seconds" | "llamacpp:tokens_predicted_seconds" => {
                    predicted_tps_gauge = parse_f64(val_str);
                }
                "llamacpp:n_decode_total" => {
                    n_decode_total = parse_usize(val_str);
                }
                "llamacpp:n_busy_slots_total" => {
                    n_busy_slots_total = parse_usize(val_str);
                }
                _ => {}
            }
        }
    }

    Ok(MetricsSnapshot {
        prompt_tokens_total: prompt_tokens_total.unwrap_or(0),
        prompt_seconds_total: prompt_seconds_total.unwrap_or(0.0),
        predicted_tokens_total: predicted_tokens_total.unwrap_or(0),
        prompt_tps_gauge: prompt_tps_gauge.unwrap_or(0.0),
        requests_processing: requests_processing.unwrap_or(0),
        predicted_tps_gauge: predicted_tps_gauge.unwrap_or(0.0),
        n_decode_total: n_decode_total.unwrap_or(0),
        n_busy_slots_total: n_busy_slots_total.unwrap_or(0),
    })
}

fn parse_usize(s: &str) -> Option<usize> {
    s.trim().parse::<usize>().ok()
}

fn parse_f64(s: &str) -> Option<f64> {
    s.trim().parse::<f64>().ok()
}
