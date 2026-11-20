//! DEV-only lifecycle for the external `vram-ballast.exe`.
//!
//! The ballast must be another process for the engine to feel it, so the app spawns the standalone
//! binary and keeps the handle; the tool also watches our PID and releases on its own if the app
//! dies. Nothing here runs in a release build: the commands reject, and the UI block that drives
//! them is DEV-gated in the renderer.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;

use crate::engine::AppContext;

struct RunningBallast {
    child: Child,
    device: u32,
    target_mib: u64,
}

static BALLAST: Mutex<Option<RunningBallast>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
pub struct BallastStatus {
    pub running: bool,
    pub supported: bool,
    pub device: u32,
    pub target_mib: u64,
    /// NVML free on the card right now - what the glass, the guard and the calibration read.
    pub nvml_free_mib: u64,
    pub note: String,
}

fn dev_supported() -> bool {
    cfg!(debug_assertions)
}

fn ballast_exe() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("cannot locate the app binary: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "app binary has no parent directory".to_string())?;
    let path = dir.join("vram-ballast.exe");
    if !path.exists() {
        return Err(format!(
            "vram-ballast.exe is not next to the app ({}). Build it with: cargo build --bin vram-ballast",
            path.display()
        ));
    }
    Ok(path)
}

fn nvml_free_for(index: u32) -> Option<u64> {
    crate::nvml_metrics::scan().and_then(|samples| {
        samples
            .iter()
            .find(|s| s.index == index)
            .map(|s| s.memory_free_mib)
    })
}

#[tauri::command]
pub async fn vram_ballast_start(
    _app: tauri::State<'_, AppContext>,
    target_free_mib: u64,
    device_index: Option<u32>,
) -> Result<BallastStatus, String> {
    if !dev_supported() {
        return Err("the VRAM ballast is a DEV tool".to_string());
    }
    if target_free_mib < 1024 {
        return Err("pick a target of at least 1 GiB".to_string());
    }
    let device = device_index.unwrap_or(0);

    // One at a time: a second ballast would fight the first for the same card.
    stop_running()?;

    let exe = ballast_exe()?;
    let mut child = Command::new(&exe)
        .args([
            "--target-free",
            &target_free_mib.to_string(),
            "--device",
            &device.to_string(),
            "--parent-pid",
            &std::process::id().to_string(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to start the ballast: {e}"))?;

    // Give it a moment to fail fast (bad target, missing driver, no such device).
    std::thread::sleep(std::time::Duration::from_millis(1200));
    if let Ok(Some(status)) = child.try_wait() {
        return Err(format!(
            "the ballast exited immediately ({status}); run vram-ballast.exe --target-free {} --device {} in a shell to see why",
            target_free_mib, device
        ));
    }

    let mut guard = BALLAST.lock().map_err(|e| e.to_string())?;
    *guard = Some(RunningBallast {
        child,
        device,
        target_mib: target_free_mib,
    });
    Ok(status_for(device, target_free_mib, true, "holding"))
}

fn stop_running() -> Result<(), String> {
    let running = {
        let mut guard = BALLAST.lock().map_err(|e| e.to_string())?;
        guard.take()
    };
    if let Some(mut running) = running {
        let _ = running.child.kill();
        let _ = running.child.wait();
    }
    Ok(())
}

#[tauri::command]
pub async fn vram_ballast_stop() -> Result<BallastStatus, String> {
    if !dev_supported() {
        return Err("the VRAM ballast is a DEV tool".to_string());
    }
    stop_running()?;
    Ok(BallastStatus {
        running: false,
        supported: true,
        device: 0,
        target_mib: 0,
        nvml_free_mib: nvml_free_for(0).unwrap_or(0),
        note: "released".to_string(),
    })
}

#[tauri::command]
pub async fn vram_ballast_status(
    device_index: Option<u32>,
) -> Result<BallastStatus, String> {
    if !dev_supported() {
        return Err("the VRAM ballast is a DEV tool".to_string());
    }
    let guard = BALLAST.lock().map_err(|e| e.to_string())?;
    match guard.as_ref() {
        Some(running) => Ok(status_for(running.device, running.target_mib, true, "holding")),
        None => Ok(status_for(device_index.unwrap_or(0), 0, false, "idle")),
    }
}

fn status_for(device: u32, target_mib: u64, running: bool, note: &str) -> BallastStatus {
    let free = nvml_free_for(device).unwrap_or(0);
    let note = if running && target_mib > 0 && free > 0 {
        let delta = free as i64 - target_mib as i64;
        format!("{note} - NVML free {free} MiB, target {target_mib} MiB ({delta:+})")
    } else {
        note.to_string()
    };
    BallastStatus {
        running,
        supported: true,
        device,
        target_mib,
        nvml_free_mib: free,
        note,
    }
}
