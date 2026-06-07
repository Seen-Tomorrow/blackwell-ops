//! Shared engine utilities — provider binary resolution, GPU mask, process killing, etc.
//!
//! Extracted from engine.rs / engine_stack.rs / fit_scanner.rs for use by multiple modules without circular deps.

use std::path::PathBuf;
use std::process::Stdio;

use crate::config::AppConfig;
use crate::types::EngineConfig;

/// Resolve binary path for a provider ID. Self-healing: if a stored path doesn't exist on disk,
/// it falls through to the next candidate and logs a warning about the stale entry.
pub fn find_provider_binary(cfg: &AppConfig, provider_id: &str, binary_profile: &str) -> Result<PathBuf, String> {
    let profile_to_try = if binary_profile.is_empty() { "vanguard" } else { binary_profile };

    for p in &cfg.providers {
        if p.id == provider_id {
            // Per-env path first — skip stale entries that no longer exist on disk.
            if let Some(path_str) = p.binary_path_per_env.get(profile_to_try) {
                let resolved = crate::config::resolve_path(path_str);
                if resolved.exists() {
                    return Ok(resolved);
                }
                log::warn!(
                    "[find_provider_binary] Stale per-env path for '{}' [{}]: {} — falling back",
                    provider_id, profile_to_try, resolved.display()
                );
            }
            // Fallback to main binary_path
            if !p.binary_path.is_empty() {
                let resolved = crate::config::resolve_path(&p.binary_path);
                if resolved.exists() {
                    return Ok(resolved);
                }
                log::warn!(
                    "[find_provider_binary] Stale binary_path for '{}': {} — trying fallback",
                    provider_id, resolved.display()
                );
            }
        }
    }

    // Last resort: first provider's binary_path
    if let Some(first) = cfg.providers.first() {
        let resolved = crate::config::resolve_path(&first.binary_path);
        if resolved.exists() {
            return Ok(resolved);
        }
        log::warn!(
            "[find_provider_binary] Fallback provider '{}' binary missing: {}",
            first.id, resolved.display()
        );
    }

    Err(format!("No valid binary found for provider '{}'", provider_id))
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

/// Fast kill by PID — avoids slow netstat scan when we already know the process.
pub async fn kill_process_by_pid(pid: u32) -> Result<(), String> {
    let output = tokio::process::Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .output()
        .await
        .map_err(|e| format!("Failed to kill pid {}: {}", pid, e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.contains("not found") && !stderr.contains("ERROR") {
            log::warn!("Kill pid {} stderr: {}", pid, stderr);
        }
    }

    Ok(())
}

/// Fast check — true if something is accepting TCP connections on 127.0.0.1:port.
pub async fn is_port_in_use(port: u16) -> bool {
    let addr = format!("127.0.0.1:{}", port);
    tokio::time::timeout(
        std::time::Duration::from_millis(150),
        tokio::net::TcpStream::connect(&addr),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false)
}

/// Kill process listening on a given port via PowerShell taskkill.
/// Slow — spawns PowerShell + netstat. Use only as last-resort orphan cleanup.
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

/// Human-readable Windows child process exit code (NTSTATUS / Win32).
pub fn describe_process_exit_code(code: i32) -> String {
    match code {
        -1073741819 => format!(
            "{code} (ACCESS_VIOLATION 0xC0000005 — llama-server crashed in native/CUDA code; often GPU VRAM pressure or driver fault at high engine count)"
        ),
        -1073740791 => format!(
            "{code} (STACK_BUFFER_OVERRUN 0xC0000409 — security cookie failure / stack corruption in native code)"
        ),
        -1073741510 => format!("{code} (0xC000013A — process terminated by Ctrl+C/break)"),
        c if c < 0 => format!("{c} (0x{:08X} NTSTATUS)", c as u32),
        c => c.to_string(),
    }
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
