//! DEV-only automation queue: drop a JSON job in a folder, the app runs it.
//!
//! Why a folder instead of an HTTP control port: the launch path needs `AppContext`, and the
//! app already owns engine spawning, port locks, logging and the learned store. A file queue
//! lets a test script drive *that* code instead of re-implementing it (or scraping the UI),
//! adds no dependency and no listening socket, and cannot run in a release build.
//!
//! Layout under `{app_root}/config/automation`:
//!
//! ```text
//! queue/<id>.json      a script writes a job here
//! running/<id>.json    claimed by the app (rename is the lock)
//! done/<id>.json       job as received, kept for debugging
//! results/<id>.json    { ok, result } or { ok: false, error }
//! ```
//!
//! Job: `{ "id": "...", "action": "launch" | "stop" | "status", "config": EngineConfig,
//! "hold_ms": 8000, "slot": 0, "timeout_ms": 180000 }`.
//! `hold_ms` launches, waits for RUNNING, holds, then stops — one job measures one
//! configuration end to end, which is what the journal comparison wants.
//!
//! Poll with `scripts/engine-test.py` rather than watching files by hand.

use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[derive(Debug, Deserialize)]
struct Job {
    id: String,
    action: String,
    #[serde(default)]
    config: Option<crate::types::EngineConfig>,
    #[serde(default)]
    hold_ms: Option<u64>,
    #[serde(default)]
    slot: Option<usize>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    /// Free-form parameters for actions that take more than a slot/config.
    #[serde(default)]
    params: Option<Value>,
}

fn base_dir() -> PathBuf {
    crate::config::app_root_dir()
        .join("config")
        .join("automation")
}

fn write_result(dir: &std::path::Path, id: &str, outcome: Result<Value, String>) {
    let body = match outcome {
        Ok(value) => json!({ "ok": true, "result": value }),
        Err(error) => json!({ "ok": false, "error": error }),
    };
    let path = dir.join("results").join(format!("{id}.json"));
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(&body) {
        let _ = std::fs::write(path, text);
    }
}

/// Start the watcher. Release builds return immediately: this is a development tool.
pub fn spawn(app: AppHandle) {
    if !cfg!(debug_assertions) {
        return;
    }
    let dir = base_dir();
    for sub in ["queue", "running", "done", "results"] {
        let _ = std::fs::create_dir_all(dir.join(sub));
    }
    tauri::async_runtime::spawn(async move {
        loop {
            if let Ok(entries) = std::fs::read_dir(dir.join("queue")) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("json") {
                        continue;
                    }
                    let Some(name) = path.file_name().map(|n| n.to_owned()) else {
                        continue;
                    };
                    let running = dir.join("running").join(&name);
                    // The rename is the claim: a job can never be picked up twice.
                    if std::fs::rename(&path, &running).is_err() {
                        continue;
                    }
                    let text = std::fs::read_to_string(&running).unwrap_or_default();
                    let job: Job = match serde_json::from_str(&text) {
                        Ok(job) => job,
                        Err(err) => {
                            let id = format!("{}.bad", name.to_string_lossy());
                            write_result(&dir, &id, Err(format!("job parse: {err}")));
                            let _ = std::fs::rename(&running, dir.join("done").join(&name));
                            continue;
                        }
                    };
                    log::info!("[automation] job {} action={}", job.id, job.action);
                    let outcome = run_job(&app, &job).await;
                    log::info!(
                        "[automation] job {} done ok={}",
                        job.id,
                        outcome.is_ok()
                    );
                    write_result(&dir, &job.id, outcome);
                    let _ = std::fs::rename(&running, dir.join("done").join(&name));
                }
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    });
}

async fn run_job(app: &AppHandle, job: &Job) -> Result<Value, String> {
    match job.action.as_str() {
        "launch" => {
            let config = job
                .config
                .clone()
                .ok_or_else(|| "launch needs a config".to_string())?;
            let started = std::time::Instant::now();
            let entry = crate::engine::launch_engine(
                config,
                None,
                app.state::<crate::AppContext>(),
            )
            .await
            .map_err(|err| format!("{err:?}"))?;

            let timeout = Duration::from_millis(job.timeout_ms.unwrap_or(180_000));
            let ready = wait_for_running(app, entry.idx, timeout).await;
            let mut result = json!({
                "slot": entry.idx,
                "port": entry.port,
                "alias": entry.alias,
                "model_path": entry.model_path,
                "ready": ready,
                "startup_ms": started.elapsed().as_millis() as u64,
            });

            if let Some(hold_ms) = job.hold_ms {
                if ready {
                    tokio::time::sleep(Duration::from_millis(hold_ms)).await;
                }
                // Always stop: a failed readiness check must not leave an engine behind.
                let stopped = crate::engine::stop_engine_slot(
                    entry.idx,
                    app.state::<crate::AppContext>(),
                )
                .await;
                result["stopped"] = json!(stopped.is_ok());
                if let Err(err) = stopped {
                    result["stop_error"] = json!(err);
                }
            }
            if ready {
                Ok(result)
            } else {
                Err(format!("engine did not reach RUNNING within {:?}: {result}", timeout))
            }
        }
        "snapshot" => {
            // DEV loop: capture, change a knob, capture, then diff on the CLI.
            let path = crate::nvram_snapshot::capture(app, None, "manual").await?;
            Ok(json!({ "path": path.display().to_string() }))
        }
        "stop" => {
            let slot = job
                .slot
                .ok_or_else(|| "stop needs a slot".to_string())?;
            crate::engine::stop_engine_slot(slot, app.state::<crate::AppContext>())
                .await
                .map(|message| json!({ "message": message }))
                .map_err(|err| err.to_string())
        }
        "status" => {
            let ctx = app.state::<crate::AppContext>();
            let stack = ctx.stack.lock().await;
            let slots: Vec<Value> = stack
                .slots
                .iter()
                .enumerate()
                .filter_map(|(idx, slot)| {
                    let slot = slot.as_ref()?;
                    let slot = slot.lock();
                    Some(json!({
                        "slot": idx,
                        "alias": slot.alias,
                        "status": format!("{:?}", slot.status),
                        "port": slot.port,
                        "pid": slot.pid,
                    }))
                })
                .collect();
            Ok(json!({ "slots": slots }))
        }
        "cold" => {
            let params = job
                .params
                .clone()
                .ok_or_else(|| "cold needs params".to_string())?;
            let field = |name: &str| params.get(name).cloned().unwrap_or(Value::Null);
            let model_path = field("model_path")
                .as_str()
                .ok_or_else(|| "cold needs model_path".to_string())?
                .to_string();
            let ctx = field("ctx").as_u64().unwrap_or(32768);
            let kv_quant = field("kv_quant").as_str().unwrap_or("q8_0").to_string();
            let split = field("split").as_str().unwrap_or("none").to_string();
            let batch = field("batch").as_u64().unwrap_or(0) as u32;
            let ubatch = field("ubatch").as_u64().unwrap_or(0) as u32;
            let exclude = field("exclude_model").as_str().map(str::to_string);
            crate::vram_profile::cold_forecast(
                &model_path,
                ctx,
                &kv_quant,
                &split,
                batch,
                ubatch,
                exclude.as_deref(),
            )
            .and_then(|forecast| serde_json::to_value(forecast).map_err(|e| e.to_string()))
        }
        "param" => {
            let params = job
                .params
                .clone()
                .ok_or_else(|| "param needs params".to_string())?;
            let get = |name: &str| params.get(name).and_then(|v| v.as_str()).unwrap_or("").to_string();
            crate::config::commands::set_provider_param_value(get("provider_id"), get("key"), get("value"))
                .map(|_| json!({ "message": "stored" }))
                .map_err(|e| e.to_string())
        }
        other => Err(format!("unknown action: {other}")),
    }
}

async fn wait_for_running(app: &AppHandle, slot_idx: usize, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        // Read the status inside its own scope: the slot handle borrows the stack guard.
        let status = {
            let ctx = app.state::<crate::AppContext>();
            let stack = ctx.stack.lock().await;
            stack
                .get_slot(slot_idx)
                .map(|slot| format!("{:?}", slot.status))
        };
        match status.as_deref() {
            Some(s) if s.contains("Running") => return true,
            Some(s) if s.contains("Idle") || s.contains("Failed") => return false,
            _ => {}
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}
/// Persist a UI snapshot (the forecast glass, the plan panel) for agent inspection.
///
/// The automation queue can drive engines but cannot see the screen; without this, every
/// question about "what does the badge show" costs a human screenshot. DEV builds write the
/// payload to `config/automation/ui/<name>.json`; release builds ignore it.
#[tauri::command]
pub fn record_ui_state(name: String, state: Value) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Ok(());
    }
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let dir = base_dir().join("ui");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let body = serde_json::json!({
        "at": chrono::Utc::now().to_rfc3339(),
        "state": state,
    });
    let text = serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{safe}.json")), text).map_err(|e| e.to_string())
}
