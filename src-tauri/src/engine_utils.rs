//! Shared engine utilities — provider binary resolution, GPU mask, process killing, etc.
//!
//! Extracted from engine.rs / engine_stack.rs / fit_scanner.rs for use by multiple modules without circular deps.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use crate::config::AppConfig;
use crate::types::EngineConfig;

/// Resolve binary path for a provider ID. Self-healing: if a stored path doesn't exist on disk,
/// it falls through to the next candidate and logs a warning about the stale entry.
pub fn find_provider_binary(cfg: &AppConfig, provider_id: &str, binary_profile: &str) -> Result<PathBuf, String> {
    let profile_to_try = if binary_profile.is_empty() {
        crate::config::DEFAULT_BINARY_PROFILE
    } else {
        binary_profile
    };

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

/// Quote an executable path for debug/CMD display — safe when install dir contains spaces.
pub fn format_debug_executable(path: &Path) -> String {
    let rendered = path.display().to_string();
    format!("\"{}\"", rendered.replace('"', "\\\""))
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

/// Ask llama-server to shut down via CTRL+C on its console (prints memory breakdown on exit).
#[cfg(windows)]
pub fn request_console_ctrl_c(pid: u32) -> bool {
    use windows_sys::Win32::System::Console::{
        AttachConsole, FreeConsole, GenerateConsoleCtrlEvent, SetConsoleCtrlHandler, CTRL_C_EVENT,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_INFORMATION,
    };
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};

    unsafe extern "system" fn swallow_ctrl_c(_ctrl_type: u32) -> i32 {
        1
    }

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid);
        if handle == INVALID_HANDLE_VALUE {
            log::debug!("[stop] pid {pid} already exited — skip AttachConsole");
            return false;
        }
        let mut exit_code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut exit_code) != 0;
        CloseHandle(handle);
        const STILL_ACTIVE: u32 = 259;
        if !ok || exit_code != STILL_ACTIVE {
            log::debug!("[stop] pid {pid} not running (exit={exit_code}) — skip AttachConsole");
            return false;
        }

        if AttachConsole(pid) == 0 {
            log::debug!("[stop] AttachConsole failed for pid {pid} — will force-kill");
            return false;
        }
        let _ = SetConsoleCtrlHandler(Some(swallow_ctrl_c), 1);
        let sent = GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0) != 0;
        let _ = SetConsoleCtrlHandler(None, 0);
        FreeConsole();
        if !sent {
            log::warn!("[stop] GenerateConsoleCtrlEvent failed for pid {pid}");
        }
        sent
    }
}

#[cfg(not(windows))]
pub fn request_console_ctrl_c(_pid: u32) -> bool {
    false
}

/// Reap a child handle after the OS process is already gone (or being killed).
pub fn reap_child_handle(child: &mut std::process::Child) -> bool {
    for _ in 0..40 {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    let _ = child.kill();
    for _ in 0..20 {
        if let Ok(Some(_)) = child.try_wait() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    false
}

/// Stop a no-console engine: brief CTRL+C attempt, then taskkill by PID, then reap handle.
/// Release builds spawn with CREATE_NO_WINDOW — AttachConsole usually fails, so taskkill is the reliable path.
/// Never scans or kills by port — foreign listeners (LM Studio, other Blackwell instances) must not be touched.
pub async fn stop_child_fast(
    mut child: std::process::Child,
    pid: Option<u32>,
) -> bool {
    if let Some(p) = pid {
        if request_console_ctrl_c(p) {
            for _ in 0..10 {
                match child.try_wait() {
                    Ok(Some(_)) => return true,
                    Ok(None) => {
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                    Err(_) => break,
                }
            }
        }
        let _ = kill_process_by_pid(p).await;
    }

    tokio::task::spawn_blocking(move || reap_child_handle(&mut child))
        .await
        .unwrap_or(false)
}

/// Fast kill by PID — avoids slow netstat scan when we already know the process.
pub async fn kill_process_by_pid(pid: u32) -> Result<(), String> {
    let output = tokio::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
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

/// Windows: PID listening on TCP `port` (LISTENING rows only — ignores client connections).
pub async fn get_listening_pid(port: u16) -> Option<u32> {
    tokio::task::spawn_blocking(move || get_listening_pid_blocking(port))
        .await
        .ok()
        .flatten()
}

fn get_listening_pid_blocking(port: u16) -> Option<u32> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let output = std::process::Command::new("netstat")
        .args(["-ano", "-p", "tcp"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if !line.contains("LISTENING") {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 5 {
            continue;
        }
        let local_port = parse_netstat_local_port(parts[1])?;
        if local_port != port {
            continue;
        }
        return parts.last()?.parse().ok();
    }
    None
}

fn parse_netstat_local_port(local: &str) -> Option<u16> {
    if let Some(rest) = local.strip_prefix('[') {
        if let Some((_, after)) = rest.split_once("]:") {
            return after.parse().ok();
        }
    }
    local.rsplit(':').next()?.parse().ok()
}

/// Full path to a process executable (Windows).
pub fn get_process_image_path(pid: u32) -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let script = format!(
        "(Get-Process -Id {pid} -ErrorAction SilentlyContinue).Path"
    );
    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        return None;
    }
    Some(PathBuf::from(path))
}

/// Compare two paths to the same executable (canonical when possible).
pub fn same_executable_path(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => false,
    }
}

/// True when `path` points at a provider llama-server under our foundry or mirrored runtime tree.
pub fn is_managed_llama_server_image(path: &Path) -> bool {
    let file_ok = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.eq_ignore_ascii_case("llama-server.exe"))
        .unwrap_or(false);
    if !file_ok {
        return false;
    }

    let Ok(canonical) = std::fs::canonicalize(path) else {
        let lossy = path.to_string_lossy().to_lowercase();
        return lossy.contains("foundry") || lossy.contains("\\runtime\\");
    };

    let Ok(app_root) = std::fs::canonicalize(crate::config::app_root_dir()) else {
        return false;
    };
    if !canonical.starts_with(&app_root) {
        return false;
    }

    let rel = canonical
        .strip_prefix(&app_root)
        .unwrap_or(&canonical)
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase();

    rel.contains("foundry/") || rel.starts_with("runtime/")
}

/// Check if a Windows process is still alive by PID.
/// Uses `PROCESS_QUERY_INFORMATION` only — do NOT add `PROCESS_VM_READ` (denied on child processes).
pub fn is_process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_INFORMATION,
    };

    if pid == 0 {
        return false;
    }

    let handle = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid) };
    if handle == INVALID_HANDLE_VALUE {
        // ERROR_INVALID_PARAMETER (87) — PID does not exist. ERROR_ACCESS_DENIED (5) — exists but protected.
        let err = unsafe { GetLastError() };
        return err == windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED;
    }

    let mut exit_code: u32 = 0;
    let success = unsafe { GetExitCodeProcess(handle, &mut exit_code) } != 0;
    unsafe { CloseHandle(handle) };

    if !success {
        return true;
    }

    const STILL_ACTIVE: u32 = 259;
    exit_code == STILL_ACTIVE
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

fn split_cuda_arch_list(raw: &str) -> Vec<String> {
    raw.split(';')
        .map(|s| s.trim().trim_matches('"').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Parse `-DCMAKE_CUDA_ARCHITECTURES="86;89;120"` (or unquoted) from cmake flag text.
pub fn parse_cuda_architectures_from_cmake(cmake_flags: &str) -> Vec<String> {
    if let Ok(re) = regex::Regex::new(r#"(?i)CMAKE_CUDA_ARCHITECTURES\s*=\s*"([^"]+)""#) {
        if let Some(caps) = re.captures(cmake_flags) {
            return split_cuda_arch_list(&caps[1]);
        }
    }
    if let Ok(re) = regex::Regex::new(r#"(?i)CMAKE_CUDA_ARCHITECTURES\s*=\s*([0-9A-Za-z;]+)"#) {
        if let Some(caps) = re.captures(cmake_flags) {
            return split_cuda_arch_list(&caps[1]);
        }
    }
    Vec::new()
}

/// Attach parsed CUDA arch list when missing (preserves existing stored values).
pub fn enrich_build_info_cuda_arch(
    mut info: crate::types::BuildInfo,
    cmake_flags: &str,
) -> crate::types::BuildInfo {
    let missing = info
        .cuda_architectures
        .as_ref()
        .map(|v| v.is_empty())
        .unwrap_or(true);
    if missing {
        let arches = parse_cuda_architectures_from_cmake(cmake_flags);
        if !arches.is_empty() {
            info.cuda_architectures = Some(arches);
        }
    }
    info
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
