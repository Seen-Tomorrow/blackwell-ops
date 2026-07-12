//! DEV session file log — engine stderr/stdout + launch metadata under `config/logs/sessions/`.
//! Active when `cfg!(debug_assertions)` (default ON) unless disabled via UI or `BLACKWELL_SESSION_LOG=0`.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

const SESSION_LOG_ENV: &str = "BLACKWELL_SESSION_LOG";
const MAX_SESSIONS: usize = 5;
const MAX_STREAM_BYTES: u64 = 50 * 1024 * 1024;

static RUNTIME_ENABLED: AtomicBool = AtomicBool::new(cfg!(debug_assertions));
static STATE: OnceLock<Mutex<SessionState>> = OnceLock::new();

#[derive(Default)]
struct SessionState {
    session_dir: Option<PathBuf>,
    slots: HashMap<usize, SlotWriters>,
}

struct SlotWriters {
    #[allow(dead_code)]
    alias: String,
    stderr: Option<BufWriter<File>>,
    stdout: Option<BufWriter<File>>,
    stderr_bytes: u64,
    stdout_bytes: u64,
    stderr_capped: bool,
    stdout_capped: bool,
}

#[derive(Serialize)]
pub struct SessionLogStatus {
    pub dev_build: bool,
    pub active: bool,
    pub env_forced: bool,
    pub runtime_enabled: bool,
    pub session_dir: Option<String>,
}

pub fn dev_build() -> bool {
    cfg!(debug_assertions)
}

fn env_enabled() -> bool {
    std::env::var(SESSION_LOG_ENV)
        .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
}

fn env_disabled() -> bool {
    std::env::var(SESSION_LOG_ENV)
        .map(|v| matches!(v.as_str(), "0" | "false" | "FALSE" | "no" | "NO"))
        .unwrap_or(false)
}

pub fn is_active() -> bool {
    dev_build() && (env_enabled() || RUNTIME_ENABLED.load(Ordering::Relaxed))
}

pub fn set_runtime_enabled(enabled: bool) {
    if !dev_build() {
        return;
    }
    if !enabled {
        if let Some(dir) = current_dir() {
            write_session_log_file(&dir, "[session_log] runtime disabled — file capture paused");
        }
    }
    RUNTIME_ENABLED.store(enabled, Ordering::Relaxed);
    if enabled {
        let _ = ensure_session();
    }
}

pub fn runtime_enabled() -> bool {
    RUNTIME_ENABLED.load(Ordering::Relaxed)
}

pub fn env_forced() -> bool {
    dev_build() && (env_enabled() || env_disabled())
}

pub fn status() -> SessionLogStatus {
    SessionLogStatus {
        dev_build: dev_build(),
        active: is_active(),
        env_forced: env_forced(),
        runtime_enabled: runtime_enabled(),
        session_dir: current_dir().map(|p| p.to_string_lossy().to_string()),
    }
}

fn state() -> &'static Mutex<SessionState> {
    STATE.get_or_init(|| Mutex::new(SessionState::default()))
}

fn sessions_root() -> PathBuf {
    crate::config::config_dir().join("logs").join("sessions")
}

fn prune_old_sessions(root: &std::path::Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut dirs: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Ok(meta) = entry.metadata().and_then(|m| m.modified()) {
                dirs.push((meta, path));
            }
        }
    }
    if dirs.len() <= MAX_SESSIONS {
        return;
    }
    dirs.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in dirs.into_iter().skip(MAX_SESSIONS) {
        let _ = fs::remove_dir_all(path);
    }
}

fn ensure_session() -> Option<PathBuf> {
    if !is_active() {
        return None;
    }
    let mut guard = state().lock().ok()?;
    if let Some(dir) = guard.session_dir.clone() {
        return Some(dir);
    }

    let root = sessions_root();
    if let Err(e) = fs::create_dir_all(&root) {
        log::warn!("[session_log] mkdir {}: {e}", root.display());
        return None;
    }
    prune_old_sessions(&root);

    let stamp = chrono::Local::now().format("%Y-%m-%d_%H%M%S");
    let dir = root.join(format!("session-{stamp}"));
    if let Err(e) = fs::create_dir_all(&dir) {
        log::warn!("[session_log] mkdir {}: {e}", dir.display());
        return None;
    }

    let meta = serde_json::json!({
        "started_at": chrono::Local::now().to_rfc3339(),
        "app_pid": std::process::id(),
        "build": if cfg!(debug_assertions) { "debug" } else { "release" },
        "session_log_env": env_enabled(),
        "runtime_enabled": runtime_enabled(),
    });
    let meta_path = dir.join("session.json");
    if let Err(e) = fs::write(&meta_path, serde_json::to_string_pretty(&meta).unwrap_or_default()) {
        log::warn!("[session_log] write {}: {e}", meta_path.display());
    }

    guard.session_dir = Some(dir.clone());
    log::info!("[session_log] session dir: {}", dir.display());
    drop(guard);
    write_session_log_file(&dir, &format!("[session_log] started → {}", dir.display()));
    Some(dir)
}

pub fn init() {
    if !dev_build() {
        return;
    }
    if env_disabled() {
        RUNTIME_ENABLED.store(false, Ordering::Relaxed);
    } else if env_enabled() {
        RUNTIME_ENABLED.store(true, Ordering::Relaxed);
    }
    if is_active() {
        ensure_session();
    }
}

pub fn current_dir() -> Option<PathBuf> {
    let guard = state().lock().ok()?;
    guard.session_dir.clone()
}

fn open_append(path: &std::path::Path) -> Option<BufWriter<File>> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
        .map(BufWriter::new)
}

fn slot_dir(session_dir: &std::path::Path, slot_idx: usize, alias: &str) -> PathBuf {
    let safe_alias: String = alias
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    session_dir.join(format!("slot-{slot_idx}_{safe_alias}"))
}

fn ensure_slot_writers(guard: &mut SessionState, session_dir: &PathBuf, slot_idx: usize, alias: &str) {
    if guard.slots.contains_key(&slot_idx) {
        return;
    }
    let dir = slot_dir(session_dir, slot_idx, alias);
    let _ = fs::create_dir_all(&dir);
    guard.slots.insert(
        slot_idx,
        SlotWriters {
            alias: alias.to_string(),
            stderr: open_append(&dir.join("stderr.log")),
            stdout: open_append(&dir.join("stdout.log")),
            stderr_bytes: 0,
            stdout_bytes: 0,
            stderr_capped: false,
            stdout_capped: false,
        },
    );
}

fn write_stream(
    writers: &mut SlotWriters,
    stdout: bool,
    line: &str,
) {
    let plain = crate::engine_utils::strip_ansi(line);
    let payload = format!("{plain}\n");
    let bytes = payload.len() as u64;

    if stdout {
        if writers.stdout_capped {
            return;
        }
        if writers.stdout_bytes + bytes > MAX_STREAM_BYTES {
            writers.stdout_capped = true;
            if let Some(w) = writers.stdout.as_mut() {
                let _ = writeln!(w, "[session_log] stdout.log capped at {MAX_STREAM_BYTES} bytes");
                let _ = w.flush();
            }
            return;
        }
        writers.stdout_bytes += bytes;
        if let Some(w) = writers.stdout.as_mut() {
            let _ = w.write_all(payload.as_bytes());
        }
    } else {
        if writers.stderr_capped {
            return;
        }
        if writers.stderr_bytes + bytes > MAX_STREAM_BYTES {
            writers.stderr_capped = true;
            if let Some(w) = writers.stderr.as_mut() {
                let _ = writeln!(w, "[session_log] stderr.log capped at {MAX_STREAM_BYTES} bytes");
                let _ = w.flush();
            }
            return;
        }
        writers.stderr_bytes += bytes;
        if let Some(w) = writers.stderr.as_mut() {
            let _ = w.write_all(payload.as_bytes());
        }
    }
}

fn write_session_log_file(session_dir: &std::path::Path, line: &str) -> bool {
    let path = session_dir.join("session.log");
    match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut f) => {
            let ts = chrono::Local::now().format("%H:%M:%S%.3f");
            let _ = writeln!(f, "[{ts}] {line}");
            let _ = f.flush();
            true
        }
        Err(e) => {
            log::warn!("[session_log] append session.log: {e}");
            false
        }
    }
}

pub fn append_session_line(line: &str) -> bool {
    if !is_active() {
        return false;
    }
    let Some(session_dir) = ensure_session() else {
        return false;
    };
    write_session_log_file(&session_dir, line)
}

pub fn append_crash_line(line: &str) {
    if !append_session_line(line) {
        return;
    }
    let Some(session_dir) = ensure_session() else {
        return;
    };
    let path = session_dir.join("app-crash.log");
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{line}");
        let _ = f.flush();
    }
}

pub fn record_launch(slot_idx: usize, alias: &str, pid: u32, port: u16, launch_cmd: &str) {
    if !is_active() {
        return;
    }
    let Some(session_dir) = ensure_session() else {
        return;
    };
    let mut guard = match state().lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    ensure_slot_writers(&mut guard, &session_dir, slot_idx, alias);
    drop(guard);

    let dir = slot_dir(&session_dir, slot_idx, alias);
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let cmd_body = format!(
        "# slot={slot_idx} alias={alias} pid={pid} port={port}\n# recorded {ts}\n{launch_cmd}\n"
    );
    if let Err(e) = fs::write(dir.join("launch.cmd.txt"), cmd_body) {
        log::warn!("[session_log] launch.cmd.txt: {e}");
    }
    append_session_line(&format!(
        "[launch] slot={slot_idx} alias={alias} pid={pid} port={port}"
    ));
}

pub fn write_engine_line(slot_idx: usize, alias: &str, stdout: bool, line: &str) {
    if !is_active() || line.is_empty() {
        return;
    }
    let Some(session_dir) = ensure_session() else {
        return;
    };
    let mut guard = match state().lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    ensure_slot_writers(&mut guard, &session_dir, slot_idx, alias);
    if let Some(writers) = guard.slots.get_mut(&slot_idx) {
        write_stream(writers, stdout, line);
    }
}

pub fn note_pipe_closed(slot_idx: usize, alias: &str, pid: u32, model_ready: bool) {
    append_session_line(&format!(
        "[pipe_eof] slot={slot_idx} alias={alias} pid={pid} ready={model_ready}"
    ));
    if !is_active() {
        return;
    }
    let mut guard = match state().lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(writers) = guard.slots.get_mut(&slot_idx) {
        let trailer = format!(
            "[session_log] pipe closed slot={slot_idx} pid={pid} ready={model_ready}\n"
        );
        if let Some(w) = writers.stderr.as_mut() {
            let _ = w.write_all(trailer.as_bytes());
            let _ = w.flush();
        }
        if let Some(w) = writers.stdout.as_mut() {
            let _ = w.write_all(trailer.as_bytes());
            let _ = w.flush();
        }
    }
}

pub fn note_slot_cleared(slot_idx: usize, alias: &str) {
    append_session_line(&format!("[slot_cleared] slot={slot_idx} alias={alias}"));
    let mut guard = match state().lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(mut writers) = guard.slots.remove(&slot_idx) {
        if let Some(w) = writers.stderr.as_mut() {
            let _ = writeln!(w, "[session_log] slot cleared");
            let _ = w.flush();
        }
        if let Some(w) = writers.stdout.as_mut() {
            let _ = writeln!(w, "[session_log] slot cleared");
            let _ = w.flush();
        }
    }
}

#[tauri::command]
pub fn get_session_log_status() -> SessionLogStatus {
    status()
}

#[tauri::command]
pub fn set_session_log_enabled(enabled: bool) -> SessionLogStatus {
    set_runtime_enabled(enabled);
    status()
}