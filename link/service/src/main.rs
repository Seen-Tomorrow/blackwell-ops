//! Integrated-mode link service host.
//!
//! Hosted by WinSW as `OymLink` under LocalSystem. The service consumes a
//! one-shot bootstrap from the paired desktop app, stores a machine-scoped
//! token, runs the normal link CLI as a hidden child, and keeps it alive.
//!
//! The service does not expose a PTY to the desktop app yet; the link client is
//! still the normal `oym-link.exe`, so a remote session has the service account
//! only after the CLI is launched from this process.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceStatus {
    running: bool,
    pid: u32,
    child_pid: Option<u32>,
    connected: bool,
    session_active: bool,
    network_enabled: bool,
    started_at: u64,
    updated_at: u64,
    mode: &'static str,
    error: Option<String>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("OYM_SERVICE_DATA_DIR") {
        return PathBuf::from(dir);
    }
    if let Some(program_data) = std::env::var_os("PROGRAMDATA") {
        return PathBuf::from(program_data).join("OYM").join("Link");
    }
    std::env::temp_dir().join("oym-link-service")
}

fn write_status(
    dir: &Path,
    started_at: u64,
    child_pid: Option<u32>,
    connected: bool,
    session_active: bool,
    network_enabled: bool,
    error: Option<String>,
) {
    let status = ServiceStatus {
        running: true,
        pid: std::process::id(),
        child_pid,
        connected,
        session_active,
        network_enabled,
        started_at,
        updated_at: now(),
        mode: "integrated",
        error,
    };
    let _ = std::fs::create_dir_all(dir);
    let path = dir.join("service-status.json");
    let temporary = dir.join("service-status.json.tmp");
    if let Ok(raw) = serde_json::to_string_pretty(&status) {
        if std::fs::write(&temporary, raw).is_ok() {
            let _ = std::fs::rename(&temporary, &path);
        }
    }
}

fn consume_bootstrap(base: &Path) -> Result<Option<(Value, String)>, String> {
    let path = base.join("service-bootstrap.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read service bootstrap: {error}")),
    };
    let value: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("parse service bootstrap: {error}"))?;
    let identity = value
        .get("identity")
        .cloned()
        .ok_or_else(|| "service bootstrap has no identity".to_string())?;
    let token = value
        .get("token")
        .and_then(Value::as_str)
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| "service bootstrap has no token".to_string())?
        .to_string();
    let _ = std::fs::remove_file(&path);
    Ok(Some((identity, token)))
}

fn prepare(base: &Path) -> Result<PathBuf, String> {
    let data = base.join("service-data");
    std::fs::create_dir_all(&data)
        .map_err(|error| format!("create service data dir: {error}"))?;

    if let Some((identity, token)) = consume_bootstrap(base)? {
        std::fs::write(
            data.join("identity.json"),
            serde_json::to_string_pretty(&identity).map_err(|error| error.to_string())?,
        )
        .map_err(|error| format!("write service identity: {error}"))?;
        std::fs::write(data.join("device.token"), token)
            .map_err(|error| format!("write service token: {error}"))?;
    }

    if !data.join("identity.json").is_file() || !data.join("device.token").is_file() {
        return Err(
            "service has no device identity; reinstall it from the paired OYM Link app".into(),
        );
    }
    Ok(data)
}

fn cli_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("OYM_LINK_CLI") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }
    let exe = std::env::current_exe().map_err(|error| format!("service exe: {error}"))?;
    let base = exe
        .parent()
        .ok_or_else(|| "service exe has no parent".to_string())?;
    for candidate in [base.join("oym-link.exe"), base.join("runtime").join("oym-link.exe")] {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err("oym-link.exe not found next to the service (reinstall the service)".into())
}

fn spawn_link(cli: &Path, data: &Path, log_path: &Path) -> Result<Child, String> {
    let token = data.join("device.token");
    let stdout = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|error| format!("open service log: {error}"))?;
    let stderr = stdout
        .try_clone()
        .map_err(|error| format!("clone service log: {error}"))?;
    let mut command = Command::new(cli);
    command
        .arg("--quiet")
        .arg("--data-dir")
        .arg(data)
        .env("OYM_DATA_DIR", data)
        .env("OYM_DEVICE_TOKEN_FILE", token)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .spawn()
        .map_err(|error| format!("start link client: {error}"))
}

fn read_log_tail(path: &Path) -> String {
    let raw = std::fs::read_to_string(path).unwrap_or_default();
    let trimmed = raw.trim();
    if trimmed.chars().count() <= 2000 {
        return trimmed.to_string();
    }
    trimmed
        .chars()
        .rev()
        .take(2000)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

/// Job object with KILL_ON_JOB_CLOSE: if the service is stopped or crashes, the
/// link child cannot be orphaned in Session 0.
#[cfg(windows)]
struct Job(*mut core::ffi::c_void);

#[cfg(windows)]
fn create_job() -> Option<Job> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if handle.is_null() {
        return None;
    }
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let ok = unsafe {
        SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if ok == 0 {
        unsafe { CloseHandle(handle) };
        return None;
    }
    Some(Job(handle))
}

#[cfg(windows)]
fn assign_job(job: &Job, child_pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };
    let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, child_pid) };
    if process.is_null() {
        return;
    }
    unsafe {
        AssignProcessToJobObject(job.0, process);
        CloseHandle(process);
    }
}

fn read_link_status(data: &Path) -> (bool, bool) {
    let raw = match std::fs::read_to_string(data.join("link-status.json")) {
        Ok(raw) => raw,
        Err(_) => return (false, false),
    };
    let value: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(_) => return (false, false),
    };
    let updated = value
        .get("updatedAt")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let fresh = now().saturating_sub(updated) < 15;
    let connected = fresh
        && value
            .get("connected")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    let session = connected
        && value
            .get("sessionActive")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    (connected, session)
}

fn main() {
    let base = data_dir();
    let started_at = now();
    let once = std::env::args().any(|arg| arg == "--once");
    let _ = std::fs::write(base.join("service-child.log"), "");
    #[cfg(windows)]
    let job = create_job();
    let mut child: Option<Child> = None;
    let mut child_pid: Option<u32> = None;
    let mut last_error: Option<String> = None;

    loop {
        let network_off = base.join("control").join("network-off").is_file();
        if network_off {
            if let Some(mut process) = child.take() {
                let _ = process.kill();
                let _ = process.wait();
            }
            child_pid = None;
            last_error = None;
        } else if child.is_none() {
            match prepare(&base).and_then(|data| cli_path().map(|cli| (data, cli))) {
                Ok((data, cli)) => match spawn_link(&cli, &data, &base.join("service-child.log")) {
                    Ok(next) => {
                        child_pid = Some(next.id());
                        #[cfg(windows)]
                        if let (Some(job), Some(pid)) = (job.as_ref(), child_pid) {
                            assign_job(job, pid);
                        }
                        child = Some(next);
                    }
                    Err(error) => last_error = Some(error),
                },
                Err(error) => last_error = Some(error),
            }
        }

        if let Some(process) = child.as_mut() {
            match process.try_wait() {
                Ok(Some(status)) => {
                    let log = read_log_tail(&base.join("service-child.log"));
                    last_error = Some(if log.is_empty() {
                        format!("link client exited: {status}")
                    } else {
                        format!("link client exited: {status}\n{log}")
                    });
                    child = None;
                    child_pid = None;
                }
                Ok(None) => {}
                Err(error) => {
                    last_error = Some(format!("link client status: {error}"));
                    child = None;
                    child_pid = None;
                }
            }
        }

        let data = base.join("service-data");
        let (connected, session_active) = read_link_status(&data);
        if connected {
            last_error = None;
        }
        write_status(
            &base,
            started_at,
            child_pid,
            connected,
            session_active,
            !network_off,
            last_error.clone(),
        );

        if once {
            if let Some(process) = child.as_mut() {
                let _ = process.kill();
                let _ = process.wait();
            }
            break;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}
