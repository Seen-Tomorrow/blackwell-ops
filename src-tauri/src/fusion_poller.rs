//! Fusion Poller — HTTP polling for /slots and /metrics endpoints.
//! Zero logic, zero state. Just fetch + deserialize.

// ── /slots deserialization types ─────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct SlotData {
    pub id: usize,
    pub n_ctx: usize,
    #[serde(default)]
    pub is_processing: bool,
    #[serde(default)]
    pub next_token: Vec<TokenInfo>,
}

#[derive(serde::Deserialize)]
pub struct TokenInfo {
    pub n_decoded: usize,
    #[allow(dead_code)]
    pub has_next_token: bool,
}

/// Poll /slots endpoint. Returns per-slot snapshots or error.
pub async fn poll_slots(client: &reqwest::Client, port: u16) -> Result<Vec<SlotData>, String> {
    let url = format!("http://localhost:{}/slots", port);
    let resp = client.get(&url).send().await.map_err(|e| format!("HTTP error: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Status {}", resp.status()));
    }

    resp.json::<Vec<SlotData>>().await.map_err(|e| format!("JSON parse: {}", e))
}

// ── /metrics deserialization types ───────────────────────────────────

#[derive(Debug, Clone)]
pub struct MetricsSnapshot {
    pub prompt_tokens_total: usize,
    pub prompt_seconds_total: f64,
    pub predicted_tokens_total: usize,
    pub predicted_seconds_total: f64,
    pub predicted_tps_gauge: f64,
    pub prompt_tps_gauge: f64,
    pub requests_processing: usize,
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
    let mut predicted_seconds_total: Option<f64> = None;
    let mut predicted_tps_gauge: Option<f64> = None;
    let mut prompt_tps_gauge: Option<f64> = None;
    let mut requests_processing: Option<usize> = None;

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
                "llamacpp:tokens_predicted_seconds_total" => {
                    predicted_seconds_total = parse_f64(val_str);
                }
                "llamacpp:predicted_tokens_seconds" => {
                    predicted_tps_gauge = parse_f64(val_str);
                }
                "llamacpp:prompt_tokens_seconds" => {
                    prompt_tps_gauge = parse_f64(val_str);
                }
                "llamacpp:requests_processing" => {
                    requests_processing = parse_usize(val_str);
                }
                _ => {}
            }
        }
    }

    Ok(MetricsSnapshot {
        prompt_tokens_total: prompt_tokens_total.unwrap_or(0),
        prompt_seconds_total: prompt_seconds_total.unwrap_or(0.0),
        predicted_tokens_total: predicted_tokens_total.unwrap_or(0),
        predicted_seconds_total: predicted_seconds_total.unwrap_or(0.0),
        predicted_tps_gauge: predicted_tps_gauge.unwrap_or(0.0),
        prompt_tps_gauge: prompt_tps_gauge.unwrap_or(0.0),
        requests_processing: requests_processing.unwrap_or(0),
    })
}

fn parse_usize(s: &str) -> Option<usize> {
    s.trim().parse::<usize>().ok()
}

fn parse_f64(s: &str) -> Option<f64> {
    s.trim().parse::<f64>().ok()
}
