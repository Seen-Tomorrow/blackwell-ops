//! GPU power + clock offset control via nvidia-smi and bundled Nvidia Inspector CLI.
//! Mutating calls require administrator rights on Windows (gsudo UAC when not elevated).

use crate::sidecar_elevate::{self, PrivilegedOutput, GSUDO_EXE, UAC_DENIED_MESSAGE};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::AppHandle;

const INSPECTOR_EXE: &str = "nvidiaInspector.exe";
const PSTATE_ID: u32 = 0;

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

fn stage_inspector(app: &AppHandle) -> Result<PathBuf, String> {
    sidecar_elevate::stage_bin(app, INSPECTOR_EXE)
}

#[tauri::command]
pub fn is_gpu_control_elevated() -> bool {
    sidecar_elevate::is_process_elevated()
}

fn run_nvidia_smi(args: &[&str]) -> Result<std::process::Output, String> {
    crate::engine_utils::run_hidden_output(|| {
        let mut cmd = std::process::Command::new("nvidia-smi");
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
    if let Ok(output) = crate::engine_utils::run_hidden_output(|| {
        let mut cmd = std::process::Command::new("where");
        cmd.arg("nvidia-smi")
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        cmd
    }) {
        if output.status.success() {
            if let Some(line) = String::from_utf8_lossy(&output.stdout).lines().next() {
                let line = line.trim();
                if !line.is_empty() {
                    return PathBuf::from(line);
                }
            }
        }
    }
    PathBuf::from(r"C:\Windows\System32\nvidia-smi.exe")
}

fn step_from_output(gpu_index: u32, step: impl Into<String>, out: &PrivilegedOutput) -> GpuControlStepResult {
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

fn inspector_mem_args(presets: &[GpuControlPreset]) -> Vec<String> {
    presets
        .iter()
        .map(|p| {
            format!(
                "-setMemoryClockOffset:{},{},{}",
                p.gpu_index, PSTATE_ID, p.mem_offset_mhz
            )
        })
        .collect()
}

fn inspector_core_args(presets: &[GpuControlPreset]) -> Vec<String> {
    presets
        .iter()
        .map(|p| {
            format!(
                "-setBaseClockOffset:{},{},{}",
                p.gpu_index, PSTATE_ID, p.core_offset_mhz
            )
        })
        .collect()
}

fn quote_exe(path: &Path) -> String {
    format!("\"{}\"", path.to_string_lossy().replace('"', ""))
}

fn build_apply_script_lines(
    smi: &Path,
    inspector: &Path,
    presets: &[GpuControlPreset],
) -> Vec<String> {
    let smi_q = quote_exe(smi);
    let insp_q = quote_exe(inspector);
    let mut lines = Vec::new();
    for p in presets {
        lines.push(format!(
            "{smi_q} -i {} -pl {}",
            p.gpu_index, p.power_limit_w
        ));
    }
    let mem = inspector_mem_args(presets).join(" ");
    lines.push(format!("{insp_q} {mem}"));
    let core = inspector_core_args(presets).join(" ");
    lines.push(format!("{insp_q} {core}"));
    lines
}

fn steps_from_batch_apply(out: &PrivilegedOutput, presets: &[GpuControlPreset]) -> Vec<GpuControlStepResult> {
    let mut steps = Vec::new();
    for preset in presets {
        steps.push(step_from_output(
            preset.gpu_index,
            format!(
                "nvidia-smi -pl {} (GPU{})",
                preset.power_limit_w, preset.gpu_index
            ),
            out,
        ));
        steps.push(step_from_output(
            preset.gpu_index,
            format!(
                "inspector mem GPU{} +{} MHz",
                preset.gpu_index, preset.mem_offset_mhz
            ),
            out,
        ));
        steps.push(step_from_output(
            preset.gpu_index,
            format!(
                "inspector core GPU{} +{} MHz",
                preset.gpu_index, preset.core_offset_mhz
            ),
            out,
        ));
    }
    steps
}

fn execute_apply(
    app: &AppHandle,
    inspector: &Path,
    presets: &[GpuControlPreset],
) -> Result<Vec<GpuControlStepResult>, String> {
    let smi = resolve_nvidia_smi_path();
    let presets = sorted_presets(presets);
    if presets.is_empty() {
        return Ok(Vec::new());
    }

    let lines = build_apply_script_lines(&smi, inspector, &presets);
    let cwd = inspector.parent();
    let out = sidecar_elevate::run_privileged_batch(app, &lines, cwd)?;
    if !out.success() && sidecar_elevate::is_uac_denied_output(&out) {
        return Err(UAC_DENIED_MESSAGE.into());
    }
    Ok(steps_from_batch_apply(&out, &presets))
}

fn execute_reset(
    app: &AppHandle,
    inspector: &Path,
    gpu_indices: &[u32],
    default_power: &std::collections::HashMap<u32, u32>,
) -> Result<Vec<GpuControlStepResult>, String> {
    let smi = resolve_nvidia_smi_path();
    let mut indices = gpu_indices.to_vec();
    indices.sort_unstable();
    indices.dedup();

    let zero_presets: Vec<GpuControlPreset> = indices
        .iter()
        .map(|&gpu_index| GpuControlPreset {
            gpu_index,
            power_limit_w: 0,
            core_offset_mhz: 0,
            mem_offset_mhz: 0,
        })
        .collect();

    if indices.is_empty() {
        return Ok(Vec::new());
    }

    let smi_q = quote_exe(&smi);
    let insp_q = quote_exe(inspector);
    let mut lines = Vec::new();
    let mem = inspector_mem_args(&zero_presets).join(" ");
    lines.push(format!("{insp_q} {mem}"));
    let core = inspector_core_args(&zero_presets).join(" ");
    lines.push(format!("{insp_q} {core}"));
    for &gpu_index in &indices {
        if let Some(&default_w) = default_power.get(&gpu_index) {
            if default_w > 0 {
                lines.push(format!("{smi_q} -i {gpu_index} -pl {default_w}"));
            }
        }
    }

    let cwd = inspector.parent();
    let out = sidecar_elevate::run_privileged_batch(app, &lines, cwd)?;
    if !out.success() && sidecar_elevate::is_uac_denied_output(&out) {
        return Err(UAC_DENIED_MESSAGE.into());
    }

    let mut steps = Vec::new();
    for &gpu_index in &indices {
        steps.push(step_from_output(
            gpu_index,
            "inspector mem offset reset",
            &out,
        ));
        steps.push(step_from_output(
            gpu_index,
            "inspector core offset reset",
            &out,
        ));
        if let Some(&default_w) = default_power.get(&gpu_index) {
            if default_w > 0 {
                steps.push(step_from_output(
                    gpu_index,
                    format!("nvidia-smi -pl {default_w} default (GPU{gpu_index})"),
                    &out,
                ));
            }
        }
    }

    Ok(steps)
}

fn parse_gpu_line(line: &str) -> Option<GpuControlDeviceInfo> {
    let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
    if parts.len() < 10 {
        return None;
    }

    let index: u32 = parts[0].parse().ok()?;
    let num_trailing = 8;
    let name_end = parts.len().saturating_sub(num_trailing);
    if name_end <= 1 {
        return None;
    }
    let name = parts[1..name_end].join(", ");

    let base = name_end;
    let read_u32 = |i: usize| parts.get(i).and_then(|s| s.parse().ok()).unwrap_or(0);
    let read_f32 = |i: usize| parts.get(i).and_then(|s| s.parse().ok()).unwrap_or(0.0);

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
    })
}

#[tauri::command]
pub async fn get_gpu_control_devices() -> Result<Vec<GpuControlDeviceInfo>, String> {
    tokio::task::spawn_blocking(|| {
        let output = run_nvidia_smi(&[
            "--query-gpu=index,name,power.limit,power.min_limit,power.max_limit,power.default_limit,clocks.current.graphics,clocks.current.memory,clocks.max.graphics,clocks.max.memory",
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

#[tauri::command]
pub async fn apply_gpu_control_presets(
    app: AppHandle,
    presets: Vec<GpuControlPreset>,
) -> Result<GpuControlApplyResult, String> {
    if presets.is_empty() {
        return Err("No GPU presets to apply".into());
    }

    tokio::task::spawn_blocking(move || {
        sidecar_elevate::stage_bin(&app, GSUDO_EXE)?;
        let inspector = stage_inspector(&app)?;
        let elevated = sidecar_elevate::is_process_elevated();
        let steps = execute_apply(&app, &inspector, &presets)?;
        let ok = steps.iter().all(|s| s.ok);
        Ok(GpuControlApplyResult {
            ok,
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
        sidecar_elevate::stage_bin(&app, GSUDO_EXE)?;
        let inspector = stage_inspector(&app)?;

        let devices_output = run_nvidia_smi(&[
            "--query-gpu=index,power.default_limit",
            "--format=csv,noheader,nounits",
        ])?;
        if !devices_output.status.success() {
            return Err(decode_output(&devices_output));
        }

        let mut default_power: std::collections::HashMap<u32, u32> =
            std::collections::HashMap::new();
        for line in String::from_utf8_lossy(&devices_output.stdout).lines() {
            let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
            if parts.len() >= 2 {
                if let (Ok(idx), Ok(w)) = (parts[0].parse::<u32>(), parts[1].parse::<f32>()) {
                    default_power.insert(idx, w.round() as u32);
                }
            }
        }

        let elevated = sidecar_elevate::is_process_elevated();
        let steps = execute_reset(&app, &inspector, &gpu_indices, &default_power)?;
        let ok = steps.iter().all(|s| s.ok);
        Ok(GpuControlApplyResult {
            ok,
            steps,
            elevated,
        })
    })
    .await
    .map_err(|e| format!("reset_gpu_control task failed: {e}"))?
}