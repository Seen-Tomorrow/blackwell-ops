//! Integrated-mode service skeleton.
//!
//! This binary is hosted by WinSW as `OymLink` under LocalSystem. It writes a
//! heartbeat/status file for the tray app. The link client and SYSTEM PTY are
//! deliberately not wired yet; this is the install/status foundation only.

use serde::Serialize;
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceStatus {
    running: bool,
    pid: u32,
    started_at: u64,
    updated_at: u64,
    mode: &'static str,
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

fn write_status(dir: &PathBuf, started_at: u64) -> Result<(), String> {
    let status = ServiceStatus {
        running: true,
        pid: std::process::id(),
        started_at,
        updated_at: now(),
        mode: "integrated-skeleton",
    };
    std::fs::create_dir_all(dir).map_err(|error| format!("create service data dir: {error}"))?;
    let path = dir.join("service-status.json");
    let temporary = dir.join("service-status.json.tmp");
    let raw = serde_json::to_string_pretty(&status).map_err(|error| error.to_string())?;
    {
        let mut file = std::fs::File::create(&temporary)
            .map_err(|error| format!("create service status: {error}"))?;
        file.write_all(raw.as_bytes())
            .map_err(|error| format!("write service status: {error}"))?;
        file.sync_all().ok();
    }
    std::fs::rename(&temporary, &path).map_err(|error| format!("publish service status: {error}"))
}

fn main() {
    let once = std::env::args().any(|arg| arg == "--once");
    let dir = data_dir();
    let started_at = now();

    loop {
        if let Err(error) = write_status(&dir, started_at) {
            eprintln!("oym-link-service: {error}");
        }
        if once {
            break;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}
