//! DEV-only lifecycle for the external `vram-ballast.exe`.
//!
//! The ballast must be another process for the engine to feel it, so the app spawns one child per
//! selected card and keeps the handles; each tool also watches our PID and releases on its own if
//! the app dies. Nothing here runs in a release build: the commands reject, and the UI block that
//! drives them is DEV-gated in the renderer.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::engine::AppContext;

struct RunningBallast {
    child: Child,
    device: u32,
    target_mib: u64,
}

static BALLASTS: Mutex<Vec<RunningBallast>> = Mutex::new(Vec::new());

/// One card to ballast. `target_mib` is what must stay FREE on that card.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BallastTarget {
    pub device: u32,
    pub target_mib: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BallastDeviceStatus {
    pub device: u32,
    pub target_mib: u64,
    /// NVML free on the card right now - what the glass, the guard and the calibration read.
    pub nvml_free_mib: u64,
    pub alive: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BallastStatus {
    pub running: bool,
    pub devices: Vec<BallastDeviceStatus>,
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
            "vram-ballast.exe is not next to the app ({}). Build it with: cargo build --bin vram-ballast --features dev-ballast",
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

fn device_status(device: u32, target_mib: u64, alive: bool) -> BallastDeviceStatus {
    BallastDeviceStatus {
        device,
        target_mib,
        nvml_free_mib: nvml_free_for(device).unwrap_or(0),
        alive,
    }
}

fn snapshot(running: &[RunningBallast]) -> BallastStatus {
    let devices: Vec<BallastDeviceStatus> = running
        .iter()
        .map(|r| device_status(r.device, r.target_mib, true))
        .collect();
    let note = if devices.is_empty() {
        "idle".to_string()
    } else {
        format!("holding {} card(s)", devices.len())
    };
    BallastStatus {
        running: !devices.is_empty(),
        devices,
        note,
    }
}

/// Spawn one ballast per selected card. Replaces any previous set.
#[tauri::command]
pub async fn vram_ballast_start(
    _app: tauri::State<'_, AppContext>,
    devices: Vec<BallastTarget>,
) -> Result<BallastStatus, String> {
    if !dev_supported() {
        return Err("the VRAM ballast is a DEV tool".to_string());
    }
    if devices.is_empty() {
        return Err("arm at least one GPU first".to_string());
    }
    let mut seen: Vec<u32> = Vec::new();
    for target in &devices {
        if target.target_mib < 1024 {
            return Err("pick a target of at least 1 GiB".to_string());
        }
        if seen.contains(&target.device) {
            return Err(format!("GPU-{} is listed twice", target.device));
        }
        seen.push(target.device);
    }

    // One set at a time: a second ballast on the same card would fight the first for the remainder.
    stop_running()?;

    let exe = ballast_exe()?;
    let parent_pid = std::process::id().to_string();
    let mut spawned: Vec<RunningBallast> = Vec::with_capacity(devices.len());
    for target in &devices {
        let mut cmd = Command::new(&exe);
        cmd.args([
                "--target-free",
                &target.target_mib.to_string(),
                "--device",
                &target.device.to_string(),
                "--parent-pid",
                &parent_pid,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::engine_utils::apply_create_no_window(&mut cmd);
        let child = match cmd.spawn()
        {
            Ok(child) => child,
            Err(e) => {
                kill_all(&mut spawned);
                return Err(format!("failed to start the ballast for GPU-{}: {e}", target.device));
            }
        };
        spawned.push(RunningBallast {
            child,
            device: target.device,
            target_mib: target.target_mib,
        });
    }

    // Give the tool a moment to fail fast (bad target, missing driver, no such device). The fill
    // itself runs on after this returns; the UI follows it with the status poll.
    std::thread::sleep(Duration::from_millis(400));
    let failed = spawned.iter_mut().find_map(|r| match r.child.try_wait() {
        Ok(Some(status)) => Some((r.device, r.target_mib, status.to_string())),
        _ => None,
    });
    if let Some((device, target_mib, status)) = failed {
        kill_all(&mut spawned);
        return Err(format!(
            "the ballast for GPU-{device} exited immediately ({status}); run vram-ballast.exe --target-free {target_mib} --device {device} in a shell to see why"
        ));
    }

    let status = snapshot(&spawned);
    let mut guard = BALLASTS.lock().map_err(|e| e.to_string())?;
    *guard = spawned;
    Ok(status)
}

fn kill_all(running: &mut Vec<RunningBallast>) {
    for r in running.iter_mut() {
        let _ = r.child.kill();
        let _ = r.child.wait();
    }
    running.clear();
}

fn stop_running() -> Result<(), String> {
    let mut taken = {
        let mut guard = BALLASTS.lock().map_err(|e| e.to_string())?;
        std::mem::take(&mut *guard)
    };
    kill_all(&mut taken);
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
        devices: Vec::new(),
        note: "released".to_string(),
    })
}

#[tauri::command]
pub async fn vram_ballast_status() -> Result<BallastStatus, String> {
    if !dev_supported() {
        return Err("the VRAM ballast is a DEV tool".to_string());
    }
    let mut guard = BALLASTS.lock().map_err(|e| e.to_string())?;
    // A killed or crashed child must disappear from the readout instead of reporting forever.
    guard.retain_mut(|r| !matches!(r.child.try_wait(), Ok(Some(_))));
    Ok(snapshot(&guard))
}
