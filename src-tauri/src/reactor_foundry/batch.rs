//! Foundry batch spawning, pipe draining, and child-PID tracking.
//!
//! Leaf module of the Foundry build service. Owns the std::process + OS-thread
//! pipe-drain path (not tokio::process) and the global child-PID registry used
//! for cancel/teardown. `foundry_kill_all_children` is re-exported from `mod.rs`
//! so `crate::reactor_foundry::foundry_kill_all_children` keeps working.

use std::collections::VecDeque;
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use super::{BUILD_CANCELLED, CHILD_PIDS, BuildState, emit_build_batch, progress};

/// Outcome of one configure/build batch.
///
/// `failure_excerpt` is the actionable stdout block: ninja prints `FAILED:` and the
/// compiler diagnostics on **stdout**, so a failure with empty stderr used to reach the
/// UI as a bare "Build failed." while the real line scrolled away in the log.
pub(crate) struct BatchResult {
    pub(crate) status: Option<std::process::ExitStatus>,
    pub(crate) stderr_lines: Vec<String>,
    pub(crate) failure_excerpt: Vec<String>,
}

/// Keep the failing target plus its first diagnostics, skip the compiler command line
/// (hundreds of chars, never the answer), and stop when the next edge starts.
const FAILURE_BLOCK_MAX_LINES: usize = 10;
const FAILURE_BLOCK_MAX_LINE_CHARS: usize = 320;
const FAILURE_BLOCK_MAX_CHARS: usize = 1600;
/// Last stdout lines kept as a fallback when a failure printed no `FAILED:` block.
const STDOUT_TAIL_LINES: usize = 12;

/// Streaming collector for ninja `FAILED:` blocks (pure, so it is testable).
#[derive(Default)]
pub(crate) struct FailureBlock {
    lines: Vec<String>,
    chars: usize,
    /// Candidate lines left in the current block; 0 = outside a block.
    remaining: usize,
}

impl FailureBlock {
    /// Feed one stdout line. Starts on `FAILED:`, ends at the next edge counter.
    pub(crate) fn push(&mut self, line: &str) {
        let trimmed = line.trim();
        if trimmed.starts_with("FAILED:") {
            self.remaining = FAILURE_BLOCK_MAX_LINES;
        } else if self.remaining == 0 {
            return;
        } else if progress::inspect_edge(line).is_some() {
            self.remaining = 0;
            return;
        }
        if trimmed.is_empty() {
            return;
        }
        self.remaining = self.remaining.saturating_sub(1);
        if trimmed.len() > FAILURE_BLOCK_MAX_LINE_CHARS || self.chars >= FAILURE_BLOCK_MAX_CHARS {
            return;
        }
        self.chars += trimmed.len();
        self.lines.push(trimmed.to_string());
    }

    pub(crate) fn take(&mut self) -> Vec<String> {
        self.remaining = 0;
        self.chars = 0;
        std::mem::take(&mut self.lines)
    }
}

/// Last non-empty stdout lines, fallback for failures that print no ninja block.
fn push_tail(tail: &mut VecDeque<String>, line: &str) {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.len() > FAILURE_BLOCK_MAX_LINE_CHARS {
        return;
    }
    tail.push_back(trimmed.to_string());
    while tail.len() > STDOUT_TAIL_LINES {
        tail.pop_front();
    }
}

/// Per-pipe captures; all optional so the configure and compile stages share one path.
#[derive(Default)]
pub(crate) struct DrainCapture {
    /// stderr: every line, for flake detection and the error message.
    pub stderr_lines: Option<Arc<Mutex<Vec<String>>>>,
    /// stdout: ninja `FAILED:` block, for the error message.
    pub failure: Option<Arc<Mutex<FailureBlock>>>,
    /// stdout: tail fallback when no `FAILED:` block was printed.
    pub tail: Option<Arc<Mutex<VecDeque<String>>>>,
}

// ── PID Tracking ─────────────────────────────────────────────────────

/// Join batch-script lines the way `cmd.exe` requires: **CRLF**.
///
/// LF-only batch files are not merely untidy — `cmd.exe` misparses them. Once a line
/// grows past the parser's buffer (our `set "PATH=…"` lines do), the following lines
/// lose their leading characters (`echo` → `ho`, `set` → `t`, `call` → `ll`) and the
/// script dies with exit 1. Measured against the real foundry configure batch: the LF
/// copy aborted in 0.1 s, the identical bytes as CRLF configured in 3.1 s.
///
/// Never join batch content with `"\n"`.
pub(crate) fn batch_script_text(lines: &[String]) -> String {
    let mut out = lines.join("\r\n");
    out.push_str("\r\n");
    out
}

pub(crate) fn with_child_pids<F, R>(f: F) -> Option<R>
where
    F: FnOnce(&mut Vec<u32>) -> R,
{
    match CHILD_PIDS.lock() {
        Ok(mut guard) => Some(f(&mut guard)),
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
/// Returns `true` if a stderr line is genuinely an error worth tagging `[ERR]`.
/// CMake and other build tools print informational lines to stderr (configure
/// command echoes, progress, etc.) that must NOT be styled as errors.
fn is_genuine_error_line(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    // Known-benign vendor probe lines — suppress entirely (Issue 2).
    if lower.contains("could not find openssl")
        || (lower.contains("openssl not found") && lower.contains("https support disabled"))
    {
        return false; // filtered out
    }
    // CMake configure command echo (starts with "cmake" and contains -D flags).
    if lower.starts_with("cmake") && lower.contains("-d") {
        return false;
    }
    // CMake "The following … were found" / "were NOT found" summary lines are
    // informational, not errors.
    if lower.starts_with("the following") {
        return false;
    }
    // CMake warning lines — warn, not error.
    if lower.contains("cmake warning") || lower.starts_with("warning:") {
        return false;
    }
    // CMake "Could NOT find" lines for optional deps are warnings, not errors.
    if lower.contains("could not find") {
        return false;
    }
    // Lines that explicitly say "error" or "failed" or "fatal" are real errors.
    lower.contains("error")
        || lower.contains("fatal")
        || lower.contains("failed")
        || lower.contains("exception")
}

/// Returns `true` if the line should be suppressed entirely (not shown in the log).
fn is_suppressed_vendor_noise(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    let trimmed = lower.trim_start();
    // cpp-httplib probes OpenSSL unconditionally, even when LLAMA_OPENSSL=OFF. Its
    // warning header prints to stderr; the useful child line is filtered below too.
    lower.contains("could not find openssl")
        || (lower.contains("openssl not found") && lower.contains("https support disabled"))
        || (lower.contains("cmake warning") && lower.contains("cpp-httplib"))
        // Upstream echo prints CMAKE_BUILD_TYPE=<val> via message() → stderr.
        // Empty for MSVC + multi-config (Ninja Multi-Config), where the real build
        // type comes from `cmake --build --config Release`, not this cache var.
        || lower.trim() == "cmake_build_type=release"
        || lower.trim() == "cmake_build_type="
        // CMake's FindThreads probe always walks through pthread on Windows: it tests
        // libc pthread, hunts pthread_create twice, fails all three, then prints
        // "Found Threads: TRUE". Five log lines that can never differ, every configure.
        || trimmed.starts_with("-- performing test cmake_have_libc_pthread")
        || trimmed.starts_with("-- looking for pthread_create")
        // GGML_CCACHE defaults ON upstream; we do not ship ccache, so every configure
        // warns about it. Installing one is a toolchain decision, not a build failure.
        || lower.contains("ccache not found")
}

/// OS-thread line drain for one pipe (stdout or stderr).
/// Must not use `tokio::process` + CREATE_NO_WINDOW on Windows release — that path
/// intermittently wedges (os error 6 / silent pipes). Same pattern as `fit_scanner`.
pub(crate) fn drain_pipe_lines_blocking(
    pipe: impl std::io::Read + Send + 'static,
    log_buffer: Arc<Mutex<Vec<String>>>,
    capture: DrainCapture,
    as_err: bool,
) {
    use std::io::{BufRead, BufReader};
    let reader = BufReader::new(pipe);
    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        // Suppress known-benign vendor probe noise (OpenSSL probe from cpp-httplib).
        if is_suppressed_vendor_noise(&line) {
            continue;
        }
        // Ninja `[N/M]` edge counters — the only real progress signal in the compile
        // stage. Recorded here because every streamed line already passes through.
        progress::record_line(&line);
        if let Some(failure) = &capture.failure {
            if let Ok(mut block) = failure.lock() {
                block.push(&line);
            }
        }
        if let Some(tail) = &capture.tail {
            if let Ok(mut tail) = tail.lock() {
                push_tail(&mut tail, &line);
            }
        }
        if let Some(mut buf) = try_lock_log_buf(&log_buffer) {
            if as_err {
                if is_genuine_error_line(&line) {
                    buf.push(format!("[ERR] {line}"));
                } else {
                    buf.push(line.clone());
                }
            } else {
                buf.push(line.clone());
            }
        }
        if as_err {
            if let Some(ref cap) = capture.stderr_lines {
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
) -> Result<BatchResult, String> {
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

    // Optional sccache keeps its cache inside the portable app tree. Respect an explicit
    // SCCACHE_DIR from the user's environment — this is only the portable default.
    if std::env::var_os("SCCACHE_DIR").is_none() {
        let sccache_dir = crate::config::cache_dir().join("sccache");
        let _ = std::fs::create_dir_all(&sccache_dir);
        child_cmd.env("SCCACHE_DIR", &sccache_dir);
    }
    // Auto-detected cache must never turn a working compiler into a failed build:
    // if the sccache server cannot be reached, compile locally instead.
    if std::env::var_os("SCCACHE_IGNORE_SERVER_IO_ERROR").is_none() {
        child_cmd.env("SCCACHE_IGNORE_SERVER_IO_ERROR", "1");
    }

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
    let failure_block: Arc<Mutex<FailureBlock>> = Arc::new(Mutex::new(FailureBlock::default()));
    let failure_for_stream = failure_block.clone();
    let stdout_tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    let tail_for_stream = stdout_tail.clone();

    let out_thread = std::thread::spawn({
        let log_buffer = log_buffer.clone();
        move || {
            drain_pipe_lines_blocking(
                stdout,
                log_buffer,
                DrainCapture {
                    failure: Some(failure_for_stream),
                    tail: Some(tail_for_stream),
                    ..Default::default()
                },
                false,
            )
        }
    });
    let err_thread = std::thread::spawn({
        let log_buffer = log_buffer.clone();
        move || {
            drain_pipe_lines_blocking(
                stderr,
                log_buffer,
                DrainCapture {
                    stderr_lines: Some(stderr_for_stream),
                    ..Default::default()
                },
                true,
            )
        }
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

    let failure_excerpt = if status.as_ref().map(|s| !s.success()).unwrap_or(false) {
        collect_failure_excerpt(&failure_block, &stdout_tail)
    } else {
        Vec::new()
    };

    Ok(BatchResult {
        status,
        stderr_lines,
        failure_excerpt,
    })
}

/// User-facing failure detail: the stdout `FAILED:` excerpt when there is one, else
/// stderr. Both stages share this so neither can regress to a bare "failed.".
pub(crate) fn failure_detail(excerpt: &[String], stderr: &str) -> String {
    if !excerpt.is_empty() {
        excerpt.join("\n")
    } else {
        stderr.trim().to_string()
    }
}

/// The `FAILED:` block if ninja printed one, else the stdout tail. Both drains have
/// been joined by the caller, so the locks are uncontended here.
fn collect_failure_excerpt(
    failure: &Mutex<FailureBlock>,
    tail: &Mutex<VecDeque<String>>,
) -> Vec<String> {
    let block = failure.lock().map(|mut b| b.take()).unwrap_or_default();
    if !block.is_empty() {
        return block;
    }
    tail.lock().map(|t| t.iter().cloned().collect()).unwrap_or_default()
}
pub(crate) fn track_pid(pid: u32) {
    with_child_pids(|pids| pids.push(pid));
}
/// Kill any in-flight Foundry child processes (cmake, ninja, git, etc.).
pub fn foundry_kill_all_children() {
    kill_all_children();
}
pub(crate) fn kill_all_children() {
    let pids = with_child_pids(std::mem::take).unwrap_or_default();
    for pid in pids {
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(0x08000000)
            .status();
    }
}
pub(crate) fn clear_pids() {
    let _ = with_child_pids(|pids| pids.clear());
}

#[cfg(test)]
mod script_tests {
    use super::batch_script_text;

    #[test]
    fn batch_text_is_crlf_only() {
        let text = batch_script_text(&["@echo off".to_string(), "echo hi".to_string()]);
        assert_eq!(text, "@echo off\r\necho hi\r\n");
        // The regression that matters: no bare LF anywhere.
        assert!(!text.replace("\r\n", "").contains('\n'));
        assert!(text.ends_with("\r\n"));
    }
}

#[cfg(test)]
mod noise_tests {
    use super::is_suppressed_vendor_noise;

    #[test]
    fn suppresses_build_type_and_httplib_noise() {
        assert!(is_suppressed_vendor_noise("CMAKE_BUILD_TYPE=Release"));
        assert!(is_suppressed_vendor_noise("CMAKE_BUILD_TYPE="));
        assert!(is_suppressed_vendor_noise(
            "CMake Warning at vendor/cpp-httplib/CMakeLists.txt:154 (message):"
        ));
        assert!(!is_suppressed_vendor_noise("CMAKE_BUILD_TYPE=Release is required"));
        assert!(!is_suppressed_vendor_noise("error: cpp-httplib failed to build"));
    }

    #[test]
    fn suppresses_windows_thread_probe_family() {
        // FindThreads always walks the pthread path on Windows, fails every check, then
        // succeeds via Win32. Five lines per configure that can never say anything new.
        assert!(is_suppressed_vendor_noise(
            "-- Performing Test CMAKE_HAVE_LIBC_PTHREAD"
        ));
        assert!(is_suppressed_vendor_noise(
            "-- Performing Test CMAKE_HAVE_LIBC_PTHREAD - Failed"
        ));
        assert!(is_suppressed_vendor_noise(
            "-- Looking for pthread_create in pthreads"
        ));
        assert!(is_suppressed_vendor_noise(
            "-- Looking for pthread_create in pthread - not found"
        ));
        // The useful outcome line stays.
        assert!(!is_suppressed_vendor_noise("-- Found Threads: TRUE"));
        // Other feature tests are NOT hidden — only the pthread family is known-benign.
        assert!(!is_suppressed_vendor_noise(
            "-- Performing Test CMAKE_HAVE_SOME_OTHER_THING - Failed"
        ));
        assert!(!is_suppressed_vendor_noise("-- Looking for fopen"));
    }

    #[test]
    fn suppresses_ccache_warning() {
        assert!(is_suppressed_vendor_noise(
            "-- Warning: ccache not found - consider installing it for faster compilation \
             or disable this warning with GGML_CCACHE=OFF"
        ));
        assert!(!is_suppressed_vendor_noise("-- Found CUDAToolkit: 13.4"));
    }
}

#[cfg(test)]
mod failure_capture_tests {
    use super::{FailureBlock, STDOUT_TAIL_LINES, push_tail};
    use std::collections::VecDeque;

    const FAILED: &str =
        r"FAILED: src/CMakeFiles/llama.dir/Release/llama-quant.cpp.obj ";
    const ERROR: &str =
        r"src\llama-quant.cpp(1674): error C2131: expression did not evaluate to a constant";
    const NOTE: &str =
        r"src\llama-quant.cpp(1674): note: failure was caused by reading a value";

    /// The regression this exists for: the real error is on stdout, so an empty
    /// stderr used to surface as a bare "Build failed." with a stale progress label.
    #[test]
    fn keeps_the_failing_edge_and_its_diagnostics() {
        let command = format!(
            r"C:\toolchain\sccache.exe C:\toolchain\cl.exe /nologo {}",
            "x".repeat(400)
        );
        let mut block = FailureBlock::default();
        block.push(r"[379/499] Building CUDA object ...\mmq-instance-nvfp4.cu.obj");
        block.push(FAILED);
        block.push(&command);
        block.push(ERROR);
        block.push(NOTE);
        block.push(r"[380/499] Building CXX object tools\server\x.cpp.obj");
        block.push("line after the block must not be kept");

        let lines = block.take();
        assert_eq!(lines.len(), 3);
        assert!(lines[0].starts_with("FAILED:"));
        assert!(lines[0].ends_with("llama-quant.cpp.obj"));
        assert!(lines[1].contains("error C2131"));
        assert!(lines[2].contains("note:"));
    }

    #[test]
    fn skips_the_compiler_command_line() {
        let mut block = FailureBlock::default();
        block.push(FAILED);
        block.push(&"C".repeat(super::FAILURE_BLOCK_MAX_LINE_CHARS + 80));
        block.push(ERROR);

        let lines = block.take();
        assert_eq!(lines.len(), 2, "long command line must be dropped: {lines:?}");
    }

    #[test]
    fn ignores_lines_before_any_failed_marker() {
        let mut block = FailureBlock::default();
        block.push(r"[12/20] Building CXX object a.obj");
        block.push(ERROR);
        assert!(block.take().is_empty());
    }

    #[test]
    fn tail_keeps_only_the_last_lines() {
        let mut tail = VecDeque::new();
        for i in 0..(STDOUT_TAIL_LINES + 8) {
            push_tail(&mut tail, &format!("line {i}"));
        }
        assert_eq!(tail.len(), STDOUT_TAIL_LINES);
        assert_eq!(tail.front().map(String::as_str), Some("line 8"));
        assert_eq!(tail.back().map(String::as_str), Some("line 19"));
    }

    #[test]
    fn tail_skips_blank_and_absurdly_long_lines() {
        let mut tail = VecDeque::new();
        push_tail(&mut tail, "   ");
        push_tail(&mut tail, &"x".repeat(super::FAILURE_BLOCK_MAX_LINE_CHARS + 1));
        push_tail(&mut tail, "real line");
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0], "real line");
    }

    #[test]
    fn failure_detail_prefers_the_stdout_excerpt() {
        let excerpt = vec![
            "FAILED: a.obj".to_string(),
            "a.cpp(1): error C2131: x".to_string(),
        ];
        let text = super::failure_detail(&excerpt, "stderr echo noise");
        assert!(text.contains("FAILED: a.obj"));
        assert!(text.contains("error C2131"));
        assert!(!text.contains("stderr echo noise"));
    }

    #[test]
    fn failure_detail_falls_back_to_stderr_then_empty() {
        assert_eq!(super::failure_detail(&[], "cl.exe failed"), "cl.exe failed");
        assert_eq!(super::failure_detail(&[], "  "), "");
    }

    /// End-to-end over a real pipe: the drain must both stream every line to the log
    /// and keep the `FAILED:` block for the error message.
    #[test]
    fn drain_extracts_the_failed_block_from_stdout() {
        use super::drain_pipe_lines_blocking;
        use std::io::Cursor;
        use std::sync::{Arc, Mutex};

        let stream = format!(
            concat!(
                "[378/499] Building CUDA object ggml\\...\\mmq-instance-nvfp4.cu.obj\r\n",
                "FAILED: src/CMakeFiles/llama.dir/Release/llama-quant.cpp.obj \r\n",
                "C:\\toolchain\\sccache.exe C:\\toolchain\\cl.exe /nologo {}\r\n",
                "src\\llama-quant.cpp(1674): error C2131: expression did not evaluate to a constant\r\n",
                "[379/499] Building CXX object tools\\server\\x.cpp.obj\r\n",
            ),
            "x".repeat(400)
        );
        let log = Arc::new(Mutex::new(Vec::new()));
        let failure = Arc::new(Mutex::new(FailureBlock::default()));
        let tail = Arc::new(Mutex::new(VecDeque::new()));

        drain_pipe_lines_blocking(
            Cursor::new(stream),
            log.clone(),
            super::DrainCapture {
                failure: Some(failure.clone()),
                tail: Some(tail.clone()),
                ..Default::default()
            },
            false,
        );

        let excerpt = failure.lock().expect("failure lock").take();
        assert_eq!(excerpt.len(), 2, "got: {excerpt:?}");
        assert_eq!(
            excerpt[0],
            r"FAILED: src/CMakeFiles/llama.dir/Release/llama-quant.cpp.obj"
        );
        assert!(excerpt[1].contains("error C2131"));
        assert_eq!(log.lock().expect("log lock").len(), 5);
    }
}
