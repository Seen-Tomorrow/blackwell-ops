//! Per-app Windows Job Object for engine processes.
//!
//! Engines are assigned to a private job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
//! When the app process dies for any reason (update `exit(0)`, crash, Task Manager),
//! the OS closes the job handle and terminates every assigned llama-server.
//!
//! This is not process-group parenting and not `CREATE_BREAKAWAY_FROM_JOB` — it is a
//! dedicated job owned by this process only (safe for multi-instance).

use std::sync::OnceLock;

use crate::output_console::{
    emit_blackwell_output_console_debug_line, emit_blackwell_output_console_engines_line,
    BlackwellOutputConsoleLineStyle,
};

/// Human-readable init result for REL console (set once by [`init_engine_job`]).
static JOB_STATUS_LINE: OnceLock<String> = OnceLock::new();

/// Initialize the engine kill-on-close job (idempotent). Call once at app setup.
pub fn init_engine_job() {
    #[cfg(windows)]
    {
        if ENGINE_JOB.get().is_some() {
            return;
        }
        match create_kill_on_close_job() {
            Ok(handle) => {
                if ENGINE_JOB.set(handle).is_ok() {
                    let msg = format!(
                        "[engine-job] OK — KILL_ON_JOB_CLOSE job ready (handle=0x{:X}). \
                         Engines assigned at spawn die with this app process.",
                        handle as usize
                    );
                    log::info!("{msg}");
                    let _ = JOB_STATUS_LINE.set(msg);
                } else {
                    // Another thread won the race — close the unused handle.
                    close_handle(handle);
                }
            }
            Err(e) => {
                let msg = format!(
                    "[engine-job] FAILED — engines will NOT auto-die with app (explicit taskkill only): {e}"
                );
                log::warn!("{msg}");
                let _ = JOB_STATUS_LINE.set(msg);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = JOB_STATUS_LINE.set(
            "[engine-job] Non-Windows build — job object not used; stop is PID kill only".into(),
        );
    }
}

/// Emit job status to Blackwell Output Console after the console app handle is registered.
/// Safe to call once at end of setup (init may have run earlier).
pub fn emit_engine_job_status_to_console() {
    let line = JOB_STATUS_LINE
        .get()
        .map(|s| s.as_str())
        .unwrap_or("[engine-job] Status unknown — init_engine_job was not called");
    let style = if line.contains("FAILED") {
        BlackwellOutputConsoleLineStyle::Error
    } else if line.contains("OK") {
        BlackwellOutputConsoleLineStyle::Success
    } else {
        BlackwellOutputConsoleLineStyle::Warning
    };
    emit_blackwell_output_console_engines_line(line, style);
    emit_blackwell_output_console_debug_line(line);
    emit_blackwell_output_console_debug_line(format!(
        "[engine-job] app_pid={} job_active={}",
        std::process::id(),
        is_job_active()
    ));
}

/// True when the kill-on-close job was created successfully.
pub fn is_job_active() -> bool {
    #[cfg(windows)]
    {
        ENGINE_JOB.get().is_some()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Assign a spawned engine PID to the app job. Emits Engines + Debug console lines.
pub fn assign_engine_to_job(pid: u32, alias: &str, slot_idx: usize, port: u16) {
    #[cfg(windows)]
    {
        if pid == 0 {
            return;
        }
        let Some(&job) = ENGINE_JOB.get() else {
            let msg = format!(
                "[engine-job] SKIP assign slot={slot_idx} alias={alias} pid={pid} port={port} \
                 — job not active (engines will rely on explicit teardown / orphan reaper)"
            );
            log::warn!("{msg}");
            emit_blackwell_output_console_engines_line(
                &msg,
                BlackwellOutputConsoleLineStyle::Warning,
            );
            emit_blackwell_output_console_debug_line(&msg);
            return;
        };
        match assign_pid_to_job(job, pid) {
            Ok(()) => {
                let msg = format!(
                    "[engine-job] Assigned slot={slot_idx} alias={alias} pid={pid} port={port} \
                     → kill-on-close job (dies if app exits without taskkill)"
                );
                log::info!("{msg}");
                emit_blackwell_output_console_engines_line(
                    &msg,
                    BlackwellOutputConsoleLineStyle::Normal,
                );
                emit_blackwell_output_console_debug_line(format!(
                    "[engine-job] assign OK pid={pid} job=0x{:X} app_pid={}",
                    job as usize,
                    std::process::id()
                ));
            }
            Err(e) => {
                // Nested-job / access edge cases under cargo — explicit kill paths still cover exit.
                let msg = format!(
                    "[engine-job] Assign FAILED slot={slot_idx} alias={alias} pid={pid} port={port}: {e} \
                     — relying on teardown taskkill + startup orphan reaper"
                );
                log::warn!("{msg}");
                emit_blackwell_output_console_engines_line(
                    &msg,
                    BlackwellOutputConsoleLineStyle::Warning,
                );
                emit_blackwell_output_console_debug_line(&msg);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (pid, alias, slot_idx, port);
    }
}

#[cfg(windows)]
static ENGINE_JOB: OnceLock<isize> = OnceLock::new();

#[cfg(windows)]
fn create_kill_on_close_job() -> Result<isize, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() || job == INVALID_HANDLE_VALUE {
            return Err(format!("CreateJobObjectW failed (err={})", GetLastError()));
        }

        let mut info = std::mem::zeroed::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            let err = GetLastError();
            CloseHandle(job);
            return Err(format!("SetInformationJobObject failed (err={err})"));
        }

        Ok(job as isize)
    }
}

#[cfg(windows)]
fn assign_pid_to_job(job: isize, pid: u32) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    unsafe {
        let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if process.is_null() || process == INVALID_HANDLE_VALUE {
            return Err(format!("OpenProcess failed (err={})", GetLastError()));
        }
        let ok = AssignProcessToJobObject(job as _, process);
        let err = if ok == 0 { GetLastError() } else { 0 };
        CloseHandle(process);
        if ok == 0 {
            return Err(format!("AssignProcessToJobObject err={err}"));
        }
        Ok(())
    }
}

#[cfg(windows)]
fn close_handle(handle: isize) {
    use windows_sys::Win32::Foundation::CloseHandle;
    unsafe {
        CloseHandle(handle as _);
    }
}
