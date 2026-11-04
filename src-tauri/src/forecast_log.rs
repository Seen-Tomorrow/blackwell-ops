//! Append-only prelaunch forecast vs post-launch measured VRAM.
//! Path: `{cache}/forecast-log.jsonl` — join rows on `launch_id` / `learn_key`.

use serde_json::{json, Value};
use std::fs::OpenOptions;
use std::io::Write;

use crate::types::EngineConfig;

fn log_path() -> std::path::PathBuf {
    crate::config::cache_dir().join("forecast-log.jsonl")
}

fn append_row(row: &Value) {
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) else {
        log::warn!("[forecast_log] open {} failed", path.display());
        return;
    };
    let Ok(line) = serde_json::to_string(row) else {
        return;
    };
    let _ = writeln!(f, "{line}");
    let _ = f.flush();
}

/// Stamp from `extra_params.__forecast` at spawn.
pub fn record_prelaunch(
    config: &EngineConfig,
    learn_key: &str,
    slot_idx: usize,
    pid: u32,
    port: u16,
) {
    let mut snap = config
        .extra_params
        .get("__forecast")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !snap.is_object() {
        snap = json!({});
    }
    if let Some(obj) = snap.as_object_mut() {
        obj.insert("kind".into(), json!("prelaunch"));
        obj.insert("learn_key".into(), json!(learn_key));
        obj.insert("alias".into(), json!(config.alias));
        obj.insert("model_path".into(), json!(config.model_path));
        obj.insert("provider_id".into(), json!(config.backend_type));
        obj.insert("slot".into(), json!(slot_idx));
        obj.insert("pid".into(), json!(pid));
        obj.insert("port".into(), json!(port));
        if !obj.contains_key("at") {
            obj.insert("at".into(), json!(chrono::Utc::now().to_rfc3339()));
        }
    }
    let est = snap
        .get("estimate_gb")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let src = snap
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    crate::session_log::append_session_line(&format!(
        "[forecast] prelaunch source={src} estimate_gb={est:.3} alias={}",
        config.alias
    ));
    append_row(&snap);
}

/// Post-launch learned / FIT table — same file, join on learn_key + time.
pub fn record_measured(learn_key: &str, vram_mib: f64, host_mib: Option<f64>, phase: &str) {
    if vram_mib <= 0.0 {
        return;
    }
    append_row(&json!({
        "kind": "measured",
        "at": chrono::Utc::now().to_rfc3339(),
        "learn_key": learn_key,
        "phase": phase,
        "vram_mib": vram_mib,
        "vram_gb": vram_mib / 1024.0,
        "host_mib": host_mib,
    }));
}
/// Append a row of a caller-defined kind, stamping kind and t.
///
/// The file already joins FIT (prelaunch) with the launch (measured) on learn_key.
/// Our layer plan is a third opinion on the same launch, so it rides the same journal with
/// kind: "plan" — same file, same join, no second source of truth.
fn append_kind(mut row: Value, kind: &str) -> Value {
    if let Some(obj) = row.as_object_mut() {
        obj.insert("kind".into(), json!(kind));
        obj.entry("at".to_string())
            .or_insert_with(|| json!(chrono::Utc::now().to_rfc3339()));
    }
    append_row(&row);
    row
}

/// The layer plan we computed for a configuration (per device, MiB), recorded for comparison
/// against the FIT estimate and the measured launch.
#[tauri::command]
pub fn record_plan_forecast(row: Value) {
    let _ = append_kind(row, "plan");
}

/// A standalone FIT probe (not a launch): the tool's estimate for one configuration.
#[tauri::command]
pub fn record_fit_forecast(row: Value) {
    let _ = append_kind(row, "fit_probe");
}

/// Rows for one model, newest last — used by the plan/forecast comparison.
#[tauri::command]
pub fn read_forecast_journal(model_path: Option<String>, limit: Option<usize>) -> Vec<Value> {
    let path = log_path();
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let slashed = |value: &str| value.replace('\\', "/");
    let wanted = model_path.as_deref().map(slashed);
    let mut out: Vec<Value> = text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|row| match (&wanted, row.get("model_path").and_then(|v| v.as_str())) {
            (Some(want), Some(model)) => slashed(model) == *want,
            _ => true,
        })
        .collect();
    let keep = limit.unwrap_or(usize::MAX);
    if out.len() > keep {
        out = out.split_off(out.len() - keep);
    }
    out
}