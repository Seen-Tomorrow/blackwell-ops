//! Foundry batch spawning, pipe draining, and child-PID tracking.
//!
//! Leaf module of the Foundry build service. Owns the std::process + OS-thread
//! pipe-drain path (not tokio::process) and the global child-PID registry used
//! for cancel/teardown. `foundry_kill_all_children` is re-exported from `mod.rs`
//! so `crate::reactor_foundry::foundry_kill_all_children` keeps working.

use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock as StdLazyLock, Mutex};

use super::{BUILD_CANCELLED, CHILD_PIDS, BuildState, emit_build_batch};

// ── PID Tracking ─────────────────────────────────────────────────────

pub(crate) fn with_child_pids<F, R>(f: F) -> Option<R>
where
    F: FnOnce(&mut Vec<u32>) -> R,
{
    match CHILD_PIDS.lock() {
        Ok(mut guard) => Some(f(&mut *guard)),
        Err(e) => {
            log::error!("[foundry] child PID registry poisoned: {e}");
            None
        }
    }
}
pub(crate) fn try_lock_log_buf(buf: &std::sync::Mutex<Vec<String>>) -> Option<std::sync::MutexGuard<'_, Vec<String>>> {
    buf.lock()
        .map_err(|e| {
            log::error!("[foundry] log buffer mutex poisoned: {e}");
            e
        })
        .ok()
}
/// OS-thread line drain for one pipe (stdout or stderr).
/// Must not use `tokio::process` + CREATE_NO_WINDOW on Windows release — that path
/// intermittently wedges (os error 6 / silent pipes). Same pattern as `fit_scanner`.
pub(crate) fn drain_pipe_lines_blocking(
    pipe: impl std::io::Read + Send + 'static,
    log_buffer: Arc<Mutex<Vec<String>>>,
    stderr_capture: Option<Arc<Mutex<Vec<String>>>>,
    as_err: bool,
) {
    use std::io::{BufRead, BufReader};
    let reader = BufReader::new(pipe);
    for line in reader.lines().flatten() {
        if line.trim().is_empty() {
            continue;
        }
        if let Some(mut buf) = try_lock_log_buf(&log_buffer) {
            if as_err {
                buf.push(format!("[ERR] {line}"));
            } else {
                buf.push(line.clone());
            }
        }
        if as_err {
            if let Some(ref cap) = stderr_capture {
                if let Some(mut err_buf) = try_lock_log_buf(cap) {
                    err_buf.push(line);
                }
            }
        }
    }
}
/// Spawn Foundry batch (`cmd /c …`) with CREATE_NO_WINDOW, stream logs, honour cancel.
///
/// Uses **std::process** + dedicated OS threads for pipes — not `tokio::process`.
/// Project history: tokio + CREATE_NO_WINDOW is intermittent on Windows **release**
/// (FIT/gguf/taskkill already moved off it). Symptom: child PID exists, zero output forever.
///
/// `raw_cmd_tail` is the full `/d /s /c ""batch""` string from
/// [`crate::sidecar_elevate::cmd_script_launch`] — attached via `raw_arg` so install
/// paths with spaces are not destroyed by `cmd /s` quote stripping.
pub(crate) async fn run_foundry_batch_streaming(
    program: &std::path::Path,
    raw_cmd_tail: &str,
    cwd: &std::path::Path,
    app_handle: &tauri::AppHandle,
    state: &BuildState,
    timeout: Option<std::time::Duration>,
) -> Result<(Option<std::process::ExitStatus>, Vec<String>), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut child_cmd = Command::new(program);
    child_cmd
        .raw_arg(raw_cmd_tail)
        .current_dir(cwd)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = child_cmd
        .spawn()
        .map_err(|e| format!("Failed to start foundry batch ({}): {e}", program.display()))?;

    let pid = child.id();
    track_pid(pid);

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture foundry batch stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture foundry batch stderr".to_string())?;

    let log_buffer: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let log_buffer_flush = log_buffer.clone();
    let stderr_capture: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_for_stream = stderr_capture.clone();

    let out_thread = std::thread::spawn({
        let log_buffer = log_buffer.clone();
        move || drain_pipe_lines_blocking(stdout, log_buffer, None, false)
    });
    let err_thread = std::thread::spawn({
        let log_buffer = log_buffer.clone();
        move || drain_pipe_lines_blocking(stderr, log_buffer, Some(stderr_for_stream), true)
    });

    let flush_done = Arc::new(AtomicBool::new(false));
    let flush_done_inner = flush_done.clone();
    let app_handle_flush = app_handle.clone();
    let state_flush = state.clone();
    let _flush_handle = tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_millis(250));
        loop {
            if flush_done_inner.load(Ordering::SeqCst) {
                break;
            }
            interval.tick().await;
            if let Some(mut buf) = try_lock_log_buf(&log_buffer_flush) {
                let batch = buf.drain(..).collect::<Vec<String>>();
                if !batch.is_empty() {
                    emit_build_batch(&app_handle_flush, &state_flush, batch);
                }
            }
        }
    });

    let deadline = timeout.map(|t| std::time::Instant::now() + t);
    let status = tokio::task::spawn_blocking(move || {
        loop {
            if BUILD_CANCELLED.load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(None);
            }
            if let Some(deadline) = deadline {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "Foundry batch timed out after {}s — killed.",
                        timeout.map(|t| t.as_secs()).unwrap_or(0)
                    ));
                }
            }
            match child.try_wait() {
                Ok(Some(status)) => return Ok(Some(status)),
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Foundry batch wait failed (child error).".to_string());
                }
            }
        }
    })
    .await
    .map_err(|e| format!("foundry batch wait task failed: {e}"))??;

    flush_done.store(true, Ordering::SeqCst);
    let _ = out_thread.join();
    let _ = err_thread.join();

    // Final flush of any remaining lines
    if let Some(mut buf) = try_lock_log_buf(&log_buffer) {
        let batch = buf.drain(..).collect::<Vec<String>>();
        if !batch.is_empty() {
            emit_build_batch(app_handle, state, batch);
        }
    }

    let stderr_lines = try_lock_log_buf(&stderr_capture)
        .map(|mut buf| buf.drain(..).collect::<Vec<String>>())
        .unwrap_or_default();

    Ok((status, stderr_lines))
}
pub(crate) fn track_pid(pid: u32) {
    with_child_pids(|pids| pids.push(pid));
}
/// Kill any in-flight Foundry child processes (cmake, ninja, git, etc.).
pub fn foundry_kill_all_children() {
    kill_all_children();
}
pub(crate) fn kill_all_children() {
    let pids = with_child_pids(|pids| std::mem::take(pids)).unwrap_or_default();
    for pid in pids {
        let _ = std::process::Command::new("taskkill")
            .args(&["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(0x08000000)
            .status();
    }
}
pub(crate) fn clear_pids() {
    let _ = with_child_pids(|pids| pids.clear());
}
