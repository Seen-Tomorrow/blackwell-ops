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
