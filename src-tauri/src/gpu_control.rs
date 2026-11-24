//! GPU power + clock offset control via native NVML (`nvml.dll`).
//! Mutating calls require administrator rights on Windows (gsudo UAC when not elevated).

use crate::nvml_oc::{self, NvmlOcTarget};
use crate::sidecar_elevate::{self, GSUDO_EXE, UAC_DENIED_MESSAGE};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuControlDeviceInfo {
    pub index: u32,
    pub name: String,
    pub power_limit_w: f32,
    pub power_min_w: f32,
    pub power_max_w: f32,
    pub power_default_w: f32,
    pub core_clock_mhz: u32,
    pub mem_clock_mhz: u32,
    pub max_core_clock_mhz: u32,
    pub max_mem_clock_mhz: u32,
    /// Windows driver model: `TCC` | `WDDM` | empty if unavailable.
    #[serde(default)]
    pub driver_model: String,
    /// Pending driver model after a hot switch (often needs process recycle; may show until reboot).
    #[serde(default)]
    pub driver_model_pending: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuControlPreset {
    pub gpu_index: u32,
    pub power_limit_w: u32,
    pub core_offset_mhz: i32,
    pub mem_offset_mhz: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuControlStepResult {
    pub gpu_index: u32,
    pub step: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuControlApplyResult {
    pub ok: bool,
    pub steps: Vec<GpuControlStepResult>,
    pub elevated: bool,
}

#[tauri::command]
pub fn is_gpu_control_elevated() -> bool {
    sidecar_elevate::is_process_elevated()
}

fn run_nvidia_smi(args: &[&str]) -> Result<std::process::Output, String> {
    let smi = crate::engine_utils::resolve_nvidia_smi_path();
    crate::engine_utils::run_hidden_output(move || {
        let mut cmd = std::process::Command::new(&smi);
        cmd.args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd
    })
    .map_err(|e| format!("nvidia-smi failed: {e}"))
}

fn decode_output(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}{stderr}").trim().to_string();
    if combined.is_empty() {
        "no output".to_string()
    } else {
        combined
    }
}

fn resolve_nvidia_smi_path() -> PathBuf {
    crate::engine_utils::resolve_nvidia_smi_path()
}

fn quote_exe(path: &Path) -> String {
    format!("\"{}\"", path.to_string_lossy().replace('"', ""))
}

fn step_from_output(
    gpu_index: u32,
    step: impl Into<String>,
    out: &sidecar_elevate::PrivilegedOutput,
) -> GpuControlStepResult {
    GpuControlStepResult {
        gpu_index,
        step: step.into(),
        ok: out.success(),
        detail: out.detail_on_fail(),
    }
}

fn sorted_presets(presets: &[GpuControlPreset]) -> Vec<GpuControlPreset> {
    let mut out = presets.to_vec();
    out.sort_by_key(|p| p.gpu_index);
    out
}

fn run_nvml_oc_targets(app: &AppHandle, targets: &[NvmlOcTarget]) -> Result<(), String> {
    if targets.is_empty() {
        return Ok(());
    }
    if sidecar_elevate::is_process_elevated() {
        return nvml_oc::apply_targets(targets);
    }
    sidecar_elevate::stage_bin(app, GSUDO_EXE)?;
    let exe =
        std::env::current_exe().map_err(|e| format!("Failed to locate executable: {e}"))?;
    let specs: Vec<String> = targets.iter().map(nvml_oc::format_target_spec).collect();
    let lines = vec![format!("{} --gpu-oc-apply {}", quote_exe(&exe), specs.join(" "))];
    let out = sidecar_elevate::run_privileged_batch(app, &lines, None)?;
    if !out.success() && sidecar_elevate::is_uac_denied_output(&out) {
        return Err(UAC_DENIED_MESSAGE.into());
    }
    if !out.success() {
        return Err(out
            .detail_on_fail()
            .unwrap_or_else(|| "NVML OC apply failed".into()));
    }
    Ok(())
}

fn normalize_driver_model(raw: &str) -> String {
    let s = raw.trim().to_uppercase();
    if s.contains("TCC") {
        "TCC".into()
    } else if s.contains("WDDM") {
        "WDDM".into()
    } else if s.is_empty() || s == "[N/A]" || s == "N/A" {
        String::new()
    } else {
        s
    }
}

fn parse_gpu_line(line: &str) -> Option<GpuControlDeviceInfo> {
    let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
    // index, name..., power×4, clocks×4, driver_model.current, driver_model.pending
    if parts.len() < 12 {
        return None;
    }

    let index: u32 = parts[0].parse().ok()?;
    let num_trailing = 10;
    let name_end = parts.len().saturating_sub(num_trailing);
    if name_end <= 1 {
        return None;
    }
    let name = parts[1..name_end].join(", ");

    let base = name_end;
    let read_u32 = |i: usize| parts.get(i).and_then(|s| s.parse().ok()).unwrap_or(0);
    let read_f32 = |i: usize| parts.get(i).and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let read_model = |i: usize| normalize_driver_model(parts.get(i).copied().unwrap_or(""));

    Some(GpuControlDeviceInfo {
        index,
        name,
        power_limit_w: read_f32(base),
        power_min_w: read_f32(base + 1),
        power_max_w: read_f32(base + 2),
        power_default_w: read_f32(base + 3),
        core_clock_mhz: read_u32(base + 4),
        mem_clock_mhz: read_u32(base + 5),
        max_core_clock_mhz: read_u32(base + 6),
        max_mem_clock_mhz: read_u32(base + 7),
        driver_model: read_model(base + 8),
        driver_model_pending: read_model(base + 9),
    })
}

#[tauri::command]
pub async fn get_gpu_control_devices() -> Result<Vec<GpuControlDeviceInfo>, String> {
    tokio::task::spawn_blocking(|| {
        let output = run_nvidia_smi(&[
            "--query-gpu=index,name,power.limit,power.min_limit,power.max_limit,power.default_limit,clocks.current.graphics,clocks.current.memory,clocks.max.graphics,clocks.max.memory,driver_model.current,driver_model.pending",
            "--format=csv,noheader,nounits",
        ])?;

        if !output.status.success() {
            return Err(decode_output(&output));
        }

        let mut devices = Vec::new();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Some(info) = parse_gpu_line(line) {
                devices.push(info);
            }
        }

        if devices.is_empty() {
            return Err("No NVIDIA GPUs detected".into());
        }

        devices.sort_by_key(|d| d.index);
        Ok(devices)
    })
    .await
    .map_err(|e| format!("get_gpu_control_devices task failed: {e}"))?
}

/// Hot-switch Windows driver model: `tcc` → `-dm 1`, `wddm` → `-dm 0`.
/// Requires elevation. May fail if a display is attached; some stacks apply without reboot.
#[tauri::command]
pub async fn set_gpu_driver_model(
    app: AppHandle,
    gpu_indices: Vec<u32>,
    mode: String,
) -> Result<GpuControlApplyResult, String> {
    if gpu_indices.is_empty() {
        return Err("No GPU indices".into());
    }
    let mode_l = mode.trim().to_ascii_lowercase();
    let dm = match mode_l.as_str() {
        "tcc" | "1" => 1u32,
        "wddm" | "0" => 0u32,
        _ => return Err(format!("mode must be tcc or wddm, got '{mode}'")),
    };

    tokio::task::spawn_blocking(move || {
        sidecar_elevate::stage_bin(&app, GSUDO_EXE)?;
        let smi = resolve_nvidia_smi_path();
        let smi_q = quote_exe(&smi);
        let mut indices = gpu_indices;
        indices.sort_unstable();
        indices.dedup();

        let lines: Vec<String> = indices
            .iter()
            .map(|i| format!("{smi_q} -i {i} -dm {dm}"))
            .collect();

        let elevated = sidecar_elevate::is_process_elevated();
        let out = sidecar_elevate::run_privileged_batch(&app, &lines, None)?;
        if !out.success() && sidecar_elevate::is_uac_denied_output(&out) {
            return Err(sidecar_elevate::UAC_DENIED_MESSAGE.to_string());
        }

        let label = if dm == 1 { "TCC" } else { "WDDM" };
        let mut steps = Vec::new();
        for &gpu_index in &indices {
            steps.push(step_from_output(
                gpu_index,
                format!("nvidia-smi -i {gpu_index} -dm {dm} ({label})"),
                &out,
            ));
        }
        Ok(GpuControlApplyResult {
            ok: out.success(),
            steps,
            elevated,
        })
    })
    .await
    .map_err(|e| format!("set_gpu_driver_model task failed: {e}"))?
}

#[tauri::command]
pub async fn apply_gpu_control_presets(
    app: AppHandle,
    presets: Vec<GpuControlPreset>,
) -> Result<GpuControlApplyResult, String> {
    if presets.is_empty() {
        return Err("No GPU presets to apply".into());
    }

    tokio::task::spawn_blocking(move || {
        let presets = sorted_presets(&presets);
        let targets: Vec<NvmlOcTarget> = presets
            .iter()
            .map(|p| NvmlOcTarget {
                gpu_index: p.gpu_index,
                power_limit_w: p.power_limit_w,
                core_offset_mhz: p.core_offset_mhz,
                mem_offset_mhz: p.mem_offset_mhz,
            })
            .collect();
        let elevated = sidecar_elevate::is_process_elevated();
        run_nvml_oc_targets(&app, &targets)?;
        let steps = presets
            .iter()
            .map(|p| GpuControlStepResult {
                gpu_index: p.gpu_index,
                step: format!(
                    "nvml OC GPU{}: {}W / +{} core / +{} mem",
                    p.gpu_index, p.power_limit_w, p.core_offset_mhz, p.mem_offset_mhz
                ),
                ok: true,
                detail: None,
            })
            .collect();
        Ok(GpuControlApplyResult {
            ok: true,
            steps,
            elevated,
        })
    })
    .await
    .map_err(|e| format!("apply_gpu_control_presets task failed: {e}"))?
}

#[tauri::command]
pub async fn reset_gpu_control(
    app: AppHandle,
    gpu_indices: Vec<u32>,
) -> Result<GpuControlApplyResult, String> {
    if gpu_indices.is_empty() {
        return Err("No GPU indices to reset".into());
    }

    tokio::task::spawn_blocking(move || {
        let mut indices = gpu_indices;
        indices.sort_unstable();
        indices.dedup();
        let targets: Vec<NvmlOcTarget> = indices
            .iter()
            .map(|&gpu_index| NvmlOcTarget {
                gpu_index,
                power_limit_w: 0,
                core_offset_mhz: 0,
                mem_offset_mhz: 0,
            })
            .collect();
        let elevated = sidecar_elevate::is_process_elevated();
        run_nvml_oc_targets(&app, &targets)?;
        let steps = indices
            .iter()
            .map(|&gpu_index| GpuControlStepResult {
                gpu_index,
                step: format!("nvml OC reset GPU{gpu_index}"),
                ok: true,
                detail: None,
            })
            .collect();
        Ok(GpuControlApplyResult {
            ok: true,
            steps,
            elevated,
        })
    })
    .await
    .map_err(|e| format!("reset_gpu_control task failed: {e}"))?
}