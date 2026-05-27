//! Shared engine utilities — provider binary resolution, GPU mask, process killing, etc.
//!
//! Extracted from engine.rs / engine_stack.rs / fit_scanner.rs for use by multiple modules without circular deps.

use std::path::PathBuf;
use std::process::Stdio;

use crate::config::AppConfig;
use crate::types::EngineConfig;

/// Resolve binary path for a provider ID. Handles both relative and absolute paths.
pub fn find_provider_binary(cfg: &AppConfig, provider_id: &str, binary_profile: &str) -> PathBuf {
    for p in &cfg.providers {
        if p.id == provider_id {
            // Per-env path first (vanguard/stable/fresh). Empty profile defaults to vanguard.
            let profile_to_try = if binary_profile.is_empty() { "vanguard" } else { binary_profile };
            if let Some(path) = p.binary_path_per_env.get(profile_to_try) {
                return crate::config::resolve_path(path);
            }
            // Fallback to main binary_path
            if !p.binary_path.is_empty() {
                return crate::config::resolve_path(&p.binary_path);
            }
        }
    }

    if let Some(first) = cfg.providers.first() {
        crate::config::resolve_path(&first.binary_path)
    } else {
        log::warn!("[find_provider_binary] No providers configured");
        PathBuf::new()
    }
}

/// Compute CUDA_VISIBLE_DEVICES mask from config + detected GPU count.
/// Split mode → all GPUs joined by comma. Single GPU → parsed index from "GPU-N".
pub fn compute_gpu_mask(config: &EngineConfig, gpu_count: usize, test_has_split: bool) -> String {
    let split_mode = config.get_param_str("split").unwrap_or_default();
    let device = config.get_param_str("device").unwrap_or_else(|| "GPU-0".to_string());
    compute_gpu_mask_from_params(&device, &split_mode, gpu_count, test_has_split)
}

/// Compute CUDA_VISIBLE_DEVICES mask from raw device + split_mode strings.
pub fn compute_gpu_mask_from_params(device: &str, split_mode: &str, gpu_count: usize, test_has_split: bool) -> String {
    let split_active = (!split_mode.is_empty() && split_mode.to_uppercase() != "NONE") || test_has_split;

    if split_active {
        (0..gpu_count).map(|i| i.to_string()).collect::<Vec<_>>().join(",")
    } else {
        let idx = device.strip_prefix("GPU-")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0);
        if idx < gpu_count { idx.to_string() } else { "0".to_string() }
    }
}

/// Kill process listening on a given port via PowerShell taskkill.
pub async fn kill_process_by_port(port: u16) -> Result<(), String> {
    let ps_script = format!(
        r"$pids = netstat -ano | Select-String ':{0} ' | ForEach-Object {{ ($_ -split '\s+')[-1] }}; $pids | Where-Object {{ $_.Length -gt 0 }} | ForEach-Object {{ taskkill /F /PID $_ }}",
        port
    );

    let output = tokio::process::Command::new("powershell")
        .args(&["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &ps_script])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .output()
        .await
        .map_err(|e| format!("Failed to kill process on port {}: {}", port, e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.contains("could not be found") && !stderr.contains("ERROR") {
            log::warn!("Kill port {} stderr: {}", port, stderr);
        }
    }

    Ok(())
}

/// Extract model name from full path (last component without .gguf).
pub fn extract_model_name(path: &str) -> String {
    PathBuf::from(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .trim_end_matches(".gguf")
        .to_string()
}

/// Strip ANSI escape sequences from a string.
pub fn strip_ansi(s: &str) -> String {
    s.chars().scan(false, |in_esc, ch| {
        if *in_esc {
            if ch == 'm' { *in_esc = false; }
            None
        } else if ch == '\x1b' || ch == '\u{001B}' {
            *in_esc = true;
            None
        } else {
            Some(ch)
        }
    }).collect()
}
