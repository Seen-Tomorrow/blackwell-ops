//! Application-wide `log` backend.
//!
//! Until now the logger was installed under `#[cfg(debug_assertions)]`, so a release
//! build registered **no backend at all** and every `log::info!/warn!/error!` in the
//! crate was a silent no-op that never even formatted its arguments. REL was not
//! quieter than DEV — it was blind. That is why the 2026-10-02 crash had to be
//! reconstructed from a session log and a stale panic file: the lines that would have
//! explained it were discarded at the call site.
//!
//! Three sinks, ordered by how much they can be trusted after a process dies:
//!
//! 1. **Rolling file** — `config/logs/runtime.log`. Survives the crash, which is the
//!    only moment this really matters.
//! 2. **In-app console** — the standing `Debug` category, so REL shows it with no
//!    terminal attached. Rate-limited: a view, not the record.
//! 3. **stdout** — debug builds only. A release build is `windows_subsystem =
//!    "windows"` and has no console to write to.

use std::cell::Cell;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use log::{Level, LevelFilter, Log, Metadata, Record};

use crate::output_console::{
    emit_blackwell_output_console_line, BlackwellOutputConsoleCategory,
    BlackwellOutputConsoleLineStyle,
};

/// Rotate `runtime.log` → `runtime.log.1` past this size. One generation is enough:
/// this is a support artifact, not an archive.
const ROLL_BYTES: u64 = 5 * 1024 * 1024;

/// Console lines are a view; the file is the record. A `warn!` sitting in a polled path
/// (the WMI RAM fallback fires once per `scan_system_info`) must not become one IPC
/// emit per call. Dropped lines are still in the file.
const CONSOLE_WINDOW_LINES: u32 = 20;
const CONSOLE_WINDOW: Duration = Duration::from_secs(1);

thread_local! {
    /// `emit_blackwell_output_console_line` calls `log::info!` on both of its
    /// no-app-handle paths (`output_console.rs:423` and `:430`). Without this guard the
    /// console sink re-enters this logger and the two recurse until the stack dies.
    static IN_LOGGER: Cell<bool> = const { Cell::new(false) };
}

/// Marks this thread as inside the logger for the scope, restored on unwind.
struct EnterGuard;

impl EnterGuard {
    fn new() -> Self {
        IN_LOGGER.with(|c| c.set(true));
        EnterGuard
    }
}

impl Drop for EnterGuard {
    fn drop(&mut self) {
        IN_LOGGER.with(|c| c.set(false));
    }
}

struct State {
    file: Option<File>,
    bytes_written: u64,
    /// `None` until the first console line, because `Instant::now()` is not const.
    console_window_start: Option<Instant>,
    console_lines_in_window: u32,
}

static STATE: Mutex<State> = Mutex::new(State {
    file: None,
    bytes_written: 0,
    console_window_start: None,
    console_lines_in_window: 0,
});

struct RuntimeLog;

/// `[2026-10-02T09:12:22Z WARN  blackwell_ops::telemetry] message`
///
/// Deliberately identical to the previous env_logger shape: greps and muscle memory
/// built against the DEV console output keep working.
fn format_line(record: &Record) -> String {
    let ts = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ");
    format!(
        "[{ts} {:<5} {}] {}",
        level_tag(record.level()),
        record.target(),
        record.args()
    )
}

fn level_tag(level: Level) -> &'static str {
    match level {
        Level::Error => "ERROR",
        Level::Warn => "WARN",
        Level::Info => "INFO",
        Level::Debug => "DEBUG",
        Level::Trace => "TRACE",
    }
}

fn runtime_log_path() -> PathBuf {
    crate::config::config_dir().join("logs").join("runtime.log")
}

/// (Re)open the append handle. Caller holds `STATE`.
fn open_file(state: &mut State) -> bool {
    let path = runtime_log_path();
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    state.file = OpenOptions::new().create(true).append(true).open(&path).ok();
    state.bytes_written = state
        .file
        .as_ref()
        .and_then(|f| f.metadata().ok())
        .map(|m| m.len())
        .unwrap_or(0);
    state.file.is_some()
}

/// Close, shift to `.1`, reopen. Caller holds `STATE`.
fn roll_file(state: &mut State) -> bool {
    let path = runtime_log_path();
    drop(state.file.take());
    let rotated = path.with_extension("log.1");
    // A failed rename (`.1` open elsewhere) must not stop logging; lose the rotation.
    let _ = fs::rename(&path, &rotated);
    open_file(state)
}

fn write_to_file(line: &str) {
    // Poison-tolerant: a panic elsewhere must not silence the one sink that outlives
    // the process.
    let mut state = STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if state.file.is_none() && !open_file(&mut state) {
        return;
    }
    let cost = line.len() as u64 + 1;
    if state.bytes_written.saturating_add(cost) > ROLL_BYTES && !roll_file(&mut state) {
        return;
    }
    let Some(file) = state.file.as_mut() else {
        return;
    };
    // Flushed per line on purpose. Buffered here, the tail — the part that explains a
    // crash — is exactly what the OS drops.
    if writeln!(file, "{line}").is_ok() && file.flush().is_ok() {
        state.bytes_written = state.bytes_written.saturating_add(cost);
    } else {
        // Disk full, removable media gone, file replaced: retry with a fresh handle.
        state.file = None;
    }
}

/// True once the console budget for the current window is spent.
fn console_budget_spent() -> bool {
    let mut state = STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();
    let start = match state.console_window_start {
        Some(start) => start,
        None => {
            state.console_window_start = Some(now);
            state.console_lines_in_window = 0;
            now
        }
    };
    // `saturating_`, never `-`: a bare `Instant - Duration` panics on overflow, and in
    // REL `panic = "abort"` turns that into the 0xC0000409 blink-close.
    if now.saturating_duration_since(start) >= CONSOLE_WINDOW {
        state.console_window_start = Some(now);
        state.console_lines_in_window = 0;
    }
    if state.console_lines_in_window >= CONSOLE_WINDOW_LINES {
        return true;
    }
    state.console_lines_in_window += 1;
    false
}

fn emit_to_console(record: &Record, line: &str) {
    if console_budget_spent() {
        return;
    }
    let style = match record.level() {
        Level::Error => BlackwellOutputConsoleLineStyle::Error,
        Level::Warn => BlackwellOutputConsoleLineStyle::Warning,
        _ => BlackwellOutputConsoleLineStyle::Normal,
    };
    // Guard first: the emit path logs on two branches, and that log call lands here.
    let _entered = EnterGuard::new();
    emit_blackwell_output_console_line(BlackwellOutputConsoleCategory::Debug, line, style);
}

impl Log for RuntimeLog {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = format_line(record);
        if cfg!(debug_assertions) {
            // Not `println!` — that panics when stdout is closed, which a detached or
            // redirected launch can do even in a debug build.
            let _ = writeln!(std::io::stdout(), "{line}");
        }
        write_to_file(&line);
        emit_to_console(record, &line);
    }

    fn flush(&self) {
        let mut state = STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(file) = state.file.as_mut() {
            let _ = file.flush();
        }
    }
}

/// `RUST_LOG` accepts a single level (`warn`), not env_logger's per-target syntax.
/// Default is `Info` in debug and `Warn` in release: silent for users, overridable for
/// a support session, and never blind.
fn resolve_level() -> LevelFilter {
    std::env::var("RUST_LOG")
        .ok()
        .and_then(|raw| raw.trim().parse::<LevelFilter>().ok())
        .unwrap_or(if cfg!(debug_assertions) {
            LevelFilter::Info
        } else {
            LevelFilter::Warn
        })
}

/// Install the backend. Call before anything can log; a second call is a no-op.
pub fn init() {
    if log::set_boxed_logger(Box::new(RuntimeLog)).is_ok() {
        log::set_max_level(resolve_level());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// If the guard stayed set on unwind, that thread would silently stop logging to
    /// the console for the rest of the session — no error, no missing-output signal,
    /// just a Debug tab that stops updating. The panic below is the case that matters.
    #[test]
    fn reentrancy_guard_is_released_on_unwind() {
        assert!(!IN_LOGGER.with(|c| c.get()));

        let caught = std::panic::catch_unwind(|| {
            let _entered = EnterGuard::new();
            assert!(IN_LOGGER.with(|c| c.get()));
            panic!("simulated failure inside the console sink");
        });

        assert!(caught.is_err());
        assert!(!IN_LOGGER.with(|c| c.get()));
    }

    /// The release default must not be `Off`: "REL registers no backend" is exactly
    /// the blindness this module exists to remove.
    #[test]
    fn default_level_is_never_off() {
        // RUST_LOG is process-global state; only assert the shape we guarantee when it
        // is unset, which is the shipped configuration.
        if std::env::var_os("RUST_LOG").is_none() {
            assert!(resolve_level() >= LevelFilter::Warn);
            assert_ne!(resolve_level(), LevelFilter::Off);
        }
    }
}
