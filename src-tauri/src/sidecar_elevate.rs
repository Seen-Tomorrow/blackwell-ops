//! Privileged command execution via bundled gsudo (Windows).
//! Sidecar binaries live in `bin/` (gsudo, nvidiaInspector, …) and stage to `{app_root}/bin/`.

use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Output, Stdio};
use tauri::{AppHandle, Manager};

pub const GSUDO_EXE: &str = "gsudo.exe";
/// gsudo: Win32 ERROR_CANCELLED (1223) or user-dismissed UAC (999).
const GSUDO_UAC_DENIED: i32 = 1223;
const GSUDO_UAC_CANCELLED: i32 = 999;
pub const UAC_DENIED_MESSAGE: &str = "USER did not approve the UAC prompt";

pub fn is_uac_denied_output(result: &PrivilegedOutput) -> bool {
    let code = result.exit_code();
    if code == GSUDO_UAC_DENIED || code == GSUDO_UAC_CANCELLED {
        return true;
    }
    let blob = format!("{} {}", result.stderr, result.stdout).to_lowercase();
    blob.contains("canceled by the user") || blob.contains("operation was canceled")
}

pub struct PrivilegedOutput {
    pub status: ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

impl PrivilegedOutput {
    pub fn success(&self) -> bool {
        self.status.success()
    }

    pub fn exit_code(&self) -> i32 {
        self.status.code().unwrap_or(-1)
    }

    pub fn detail_on_fail(&self) -> Option<String> {
        if self.success() {
            return None;
        }
        let mut parts = vec![format!("exit {}", self.exit_code())];
        let stderr = self.stderr.trim();
        let stdout = self.stdout.trim();
        if !stderr.is_empty() {
            parts.push(stderr.to_string());
        } else if !stdout.is_empty() {
            parts.push(stdout.to_string());
        }
        Some(parts.join(" — "))
    }
}

impl From<Output> for PrivilegedOutput {
    fn from(output: Output) -> Self {
        Self {
            status: output.status,
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        }
    }
}

pub fn portable_bin_dir() -> PathBuf {
    crate::config::app_root_dir().join("bin")
}

fn path_for_cmd(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    let stripped = raw.strip_prefix(r"\\?\").unwrap_or(raw.as_ref());
    PathBuf::from(stripped)
}

fn copy_if_newer(source: &Path, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let needs_copy = match (source.metadata(), dest.metadata()) {
        (Ok(src), Ok(dst)) => {
            src.modified()
                .ok()
                .zip(dst.modified().ok())
                .is_none_or(|(s, d)| s > d)
                || src.len() != dst.len()
        }
        (Ok(_), Err(_)) => true,
        _ => !dest.is_file(),
    };
    if needs_copy {
        std::fs::copy(source, dest)
            .map_err(|e| format!("copy {} → {}: {e}", source.display(), dest.display()))?;
    }
    Ok(())
}

/// Resolve a bundled binary from Tauri resources, dev manifest `src-tauri/bin/`, or staged app `bin/`.
pub fn resolve_bundle_bin(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let rel = format!("bin/{name}");
    if let Ok(p) = app
        .path()
        .resolve(&rel, tauri::path::BaseDirectory::Resource)
    {
        if p.is_file() {
            return Ok(p);
        }
    }

    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("bin")
        .join(name);
    if manifest.is_file() {
        return Ok(manifest);
    }

    let portable = portable_bin_dir().join(name);
    if portable.is_file() {
        return Ok(portable);
    }

    Err(format!(
        "{name} not found — place it in src-tauri/bin/ (see bin/README.txt)"
    ))
}

/// Copy bundled sidecar into `{app_root}/bin/` (portable; survives moving the app folder).
pub fn stage_bin(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let bundle = resolve_bundle_bin(app, name)?;
    let dest = portable_bin_dir().join(name);
    copy_if_newer(&bundle, &dest)?;
    if !dest.is_file() {
        return Err(format!("staged {name} missing at {}", dest.display()));
    }
    Ok(dest)
}

pub fn stage_gsudo(app: &AppHandle) -> Result<PathBuf, String> {
    stage_bin(app, GSUDO_EXE)
}

/// `net session` succeeds only for elevated administrators on Windows.
#[cfg(windows)]
pub fn is_process_elevated() -> bool {
    crate::engine_utils::run_hidden_output(|| {
        let mut cmd = std::process::Command::new("net");
        cmd.arg("session")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd
    })
    .map(|o| o.status.success())
    .unwrap_or(false)
}

#[cfg(not(windows))]
pub fn is_process_elevated() -> bool {
    false
}

fn spawn_privileged(
    gsudo: Option<&Path>,
    program: &Path,
    args: &[String],
    cwd: Option<&Path>,
) -> Result<PrivilegedOutput, String> {
    let program = path_for_cmd(program);
    let output = crate::engine_utils::run_hidden_output(|| {
        let mut cmd = if let Some(gsudo_path) = gsudo {
            let gsudo_path = path_for_cmd(gsudo_path);
            // -w = wait for exit code. Do NOT pass -n/--new — that opens a visible console.
            let mut c = std::process::Command::new(&gsudo_path);
            c.arg("-w").arg(&program).args(args);
            c
        } else {
            let mut c = std::process::Command::new(&program);
            c.args(args);
            c
        };
        if let Some(dir) = cwd {
            cmd.current_dir(path_for_cmd(dir));
        }
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        cmd
    })
    .map_err(|e| {
        if gsudo.is_some() {
            format!("gsudo launch failed: {e}")
        } else {
            format!("{} failed: {e}", program.display())
        }
    })?;

    let result = PrivilegedOutput::from(output);
    if gsudo.is_some() && is_uac_denied_output(&result) {
        return Err(UAC_DENIED_MESSAGE.into());
    }
    Ok(result)
}

/// Run `program` with admin rights. Uses gsudo when not elevated.
pub fn run_privileged(
    app: &AppHandle,
    program: &Path,
    args: &[String],
) -> Result<PrivilegedOutput, String> {
    let cwd = program.parent().filter(|p| p.is_dir());
    if is_process_elevated() {
        return spawn_privileged(None, program, args, cwd);
    }
    let gsudo = stage_gsudo(app)?;
    spawn_privileged(Some(&gsudo), program, args, cwd)
}

/// Run multiple commands under a single elevation (one UAC prompt via one gsudo → cmd script).
pub fn run_privileged_batch(
    app: &AppHandle,
    command_lines: &[String],
    cwd: Option<&Path>,
) -> Result<PrivilegedOutput, String> {
    if command_lines.is_empty() {
        return Err("no privileged commands to run".into());
    }

    let script_path = crate::config::config_dir().join(format!(
        "gpu-priv-{}.cmd",
        std::process::id()
    ));

    let mut script = String::from("@echo off\r\nsetlocal\r\n");
    if let Some(dir) = cwd.filter(|p| p.is_dir()) {
        script.push_str(&format!(
            "cd /d \"{}\"\r\n",
            path_for_cmd(dir).display()
        ));
    }
    for line in command_lines {
        script.push_str(line);
        script.push_str("\r\nif errorlevel 1 exit /b 1\r\n");
    }
    script.push_str("endlocal\r\n");

    std::fs::write(&script_path, script).map_err(|e| format!("write priv script: {e}"))?;

    let cmd = PathBuf::from(r"C:\Windows\System32\cmd.exe");
    let script_arg = path_for_cmd(&script_path).to_string_lossy().to_string();
    let result = run_privileged(app, &cmd, &["/c".to_string(), script_arg]);
    let _ = std::fs::remove_file(&script_path);
    result
}