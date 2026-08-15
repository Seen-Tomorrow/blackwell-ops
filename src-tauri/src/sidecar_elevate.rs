//! Privileged command execution via bundled gsudo (Windows).
//! Sidecar binaries live in `bin/` (gsudo, nvidiaInspector, …) and stage to `{app_root}/bin/`.

use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Output, Stdio};
use tauri::{AppHandle, Manager};

pub const GSUDO_EXE: &str = "gsudo.exe";
pub const SEVEN_ZIP_EXE: &str = "7z.exe";
pub const SEVEN_ZIP_DLL: &str = "7z.dll";
/// MinGit layout: `bin/git/cmd/git.exe` (+ mingw64/, usr/).
pub const GIT_ROOT_DIR: &str = "git";
pub const GIT_EXE_REL: &str = "git/cmd/git.exe";
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

pub fn stage_7z(app: &AppHandle) -> Result<PathBuf, String> {
    // Stage the exe (primary). The DLL must live next to it.
    let exe = stage_bin(app, SEVEN_ZIP_EXE)?;
    let _ = stage_bin(app, SEVEN_ZIP_DLL);
    Ok(exe)
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.is_dir() {
        return Err(format!("not a directory: {}", src.display()));
    }
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("create {}: {e}", dst.display()))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("read {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| format!("read dir entry: {e}"))?;
        let ty = entry
            .file_type()
            .map_err(|e| format!("file_type {}: {e}", entry.path().display()))?;
        let dest_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dest_path)?;
        } else if ty.is_file() {
            copy_if_newer(&entry.path(), &dest_path)?;
        }
    }
    Ok(())
}

fn resolve_bundle_git_root(app: &AppHandle) -> Result<PathBuf, String> {
    let marker = GIT_EXE_REL;
    if let Ok(p) = app
        .path()
        .resolve(&format!("bin/{marker}"), tauri::path::BaseDirectory::Resource)
    {
        if p.is_file() {
            return p.parent()
                .and_then(|cmd| cmd.parent())
                .map(|root| root.to_path_buf())
                .ok_or_else(|| format!("invalid git bundle layout at {}", p.display()));
        }
    }

    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("bin")
        .join("git")
        .join("cmd")
        .join("git.exe");
    if manifest.is_file() {
        return manifest
            .parent()
            .and_then(|cmd| cmd.parent())
            .map(|root| root.to_path_buf())
            .ok_or_else(|| format!("invalid git bundle layout at {}", manifest.display()));
    }

    let staged = portable_bin_dir()
        .join(GIT_ROOT_DIR)
        .join("cmd")
        .join("git.exe");
    if staged.is_file() {
        return staged
            .parent()
            .and_then(|cmd| cmd.parent())
            .map(|root| root.to_path_buf())
            .ok_or_else(|| format!("invalid staged git layout at {}", staged.display()));
    }

    Err(
        "Portable Git (MinGit) not found — run scripts/stage-mingit.ps1 and place output under src-tauri/bin/git/ (see bin/README.txt)".into(),
    )
}

/// Stage bundled MinGit tree into `{app_root}/bin/git/`.
pub fn stage_git(app: &AppHandle) -> Result<PathBuf, String> {
    let bundle_root = resolve_bundle_git_root(app)?;
    let dest_root = portable_bin_dir().join(GIT_ROOT_DIR);
    let dest_exe = dest_root.join("cmd").join("git.exe");
    if !dest_exe.is_file() {
        if dest_root.exists() {
            std::fs::remove_dir_all(&dest_root)
                .map_err(|e| format!("remove stale git stage {}: {e}", dest_root.display()))?;
        }
        copy_dir_all(&bundle_root, &dest_root)?;
    }
    if !dest_exe.is_file() {
        return Err(format!(
            "staged git.exe missing at {} after copy from {}",
            dest_exe.display(),
            bundle_root.display()
        ));
    }
    Ok(dest_exe)
}

pub fn resolve_git_exe(app: &AppHandle) -> Result<PathBuf, String> {
    let staged = portable_bin_dir()
        .join(GIT_ROOT_DIR)
        .join("cmd")
        .join("git.exe");
    if staged.is_file() {
        return Ok(staged);
    }
    stage_git(app)
}

/// MinGit needs mingw64/usr on PATH for HTTPS clone and submodule helpers.
pub fn apply_portable_git_env(cmd: &mut std::process::Command, git_exe: &Path) {
    let Some(cmd_dir) = git_exe.parent() else {
        return;
    };
    let Some(git_root) = cmd_dir.parent() else {
        return;
    };
    let mut prefix = vec![
        cmd_dir.to_path_buf(),
        git_root.join("mingw64/bin"),
        git_root.join("usr/bin"),
    ];
    let existing = std::env::var("PATH").unwrap_or_default();
    if !existing.is_empty() {
        prefix.push(PathBuf::from(existing));
    }
    let joined = prefix
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(";");
    cmd.env("PATH", joined);
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

/// System32 `cmd.exe` (not PATH `cmd`) — used for Foundry batch and other hidden scripts.
pub fn system_cmd_exe() -> PathBuf {
    PathBuf::from(r"C:\Windows\System32\cmd.exe")
}

/// Windows Terminal launcher `wt.exe` (UWP app execution alias).
///
/// Returns `Some(path)` when Windows Terminal is installed. Used to open visible
/// console windows in the modern terminal instead of legacy conhost —
/// `CREATE_NEW_CONSOLE` / `Start-Process cmd.exe` force the old console host and
/// bypass the Windows "default terminal = Windows Terminal" setting.
///
/// The WindowsApps `wt.exe` is a 0-byte App Execution Alias, not a regular PE.
/// `CreateProcess` / `cmd start` on that path work and keep argv. **`gsudo wt
/// <args>` does not** — gsudo's UWP activation drops arguments. Elevate `cmd`
/// (or an already-admin process) and launch `wt` from there.
///
/// `wt.exe` returns immediately; it accepts the command as argv
/// (e.g. `wt.exe cmd /c call "session.bat"`). A child started from an elevated
/// process is elevated too.
#[cfg(windows)]
pub fn wt_exe() -> Option<PathBuf> {
    // Alias first — this is the documented launch path and the one that works
    // from a GUI / already-elevated CreateProcess. Do not prefer
    // `C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_*\wt.exe`: that
    // real PE is AppX-protected and often fails CreateProcess for unpackaged
    // callers (would break the working non-elevated spawn).
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let mut p = PathBuf::from(local);
        p.push("Microsoft");
        p.push("WindowsApps");
        p.push("wt.exe");
        // Alias is a reparse point; `is_file()` is true on current Windows, but
        // `exists()` still matches if the metadata type is reported oddly.
        if p.is_file() || p.exists() {
            return Some(p);
        }
    }

    let unpackaged = PathBuf::from(r"C:\Program Files\Windows Terminal\wt.exe");
    if unpackaged.is_file() {
        return Some(unpackaged);
    }

    if let Ok(out) = crate::engine_utils::run_hidden_output(|| {
        let mut cmd = std::process::Command::new("where.exe");
        cmd.arg("wt");
        cmd
    }) {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = s.lines().next() {
                let found = PathBuf::from(line.trim());
                if found.is_file() || found.exists() {
                    return Some(found);
                }
            }
        }
    }
    None
}

/// Batch that an elevated `cmd` runs to open Windows Terminal with argv intact.
///
/// `start "" "wt.exe" cmd /c call "session.bat"` — empty title is required so
/// `start` does not treat the wt path as a window title.
pub fn wt_start_bridge_bat_body(wt: &Path, session_bat: &Path) -> String {
    let wt_s = path_for_cmd(wt).to_string_lossy().replace('"', "");
    let session_s = path_for_cmd(session_bat).to_string_lossy().replace('"', "");
    format!(
        "@echo off\r\n\
         REM Blackwell managed — gsudo elevates this helper; start opens WT\r\n\
         start \"\" \"{wt_s}\" cmd /c call \"{session_s}\"\r\n"
    )
}

/// Non-Windows stub.
#[cfg(not(windows))]
pub fn wt_exe() -> Option<PathBuf> {
    None
}

/// Build the `/d /s /c ""<batch>""` tail for `cmd.exe`.
///
/// **Why double quotes:** `cmd /s /c` always strips the first and last `"` from the
/// remainder after `/c`. A single quoted path from CreateProcess becomes unquoted
/// after that strip, so install dirs with spaces break:
/// `C:\AI-MASTER\Blackwell OPS portable\...\_build_cfg.bat` →
/// `'C:\AI-MASTER\Blackwell' is not recognized as an internal or external command`.
///
/// Literal command line must be:
/// `cmd.exe /d /s /c ""C:\path with spaces\script.bat""`
/// After `/s` strip: `"C:\path with spaces\script.bat"` — one token.
///
/// Attach with [`CommandExt::raw_arg`] (see [`apply_cmd_script_raw_arg`]) so Rust's
/// normal argv quoting does not turn inner quotes into `\"` escapes that cmd would
/// leave literal.
pub fn cmd_script_raw_tail(batch_path: &Path) -> String {
    let batch = path_for_cmd(batch_path)
        .to_string_lossy()
        .replace('"', "");
    // /d = skip AutoRun registry; /s = strip outer quotes for /c (we pair with "")
    format!(r#"/d /s /c ""{}"""#, batch)
}

/// Append Foundry/script launch args so paths with spaces work under `cmd /s /c`.
#[cfg(windows)]
pub fn apply_cmd_script_raw_arg(cmd: &mut std::process::Command, batch_path: &Path) {
    use std::os::windows::process::CommandExt;
    cmd.raw_arg(cmd_script_raw_tail(batch_path));
}

#[cfg(not(windows))]
pub fn apply_cmd_script_raw_arg(cmd: &mut std::process::Command, batch_path: &Path) {
    let batch = path_for_cmd(batch_path).to_string_lossy().to_string();
    cmd.args(["/d", "/s", "/c", &batch]);
}

/// Launch `cmd /c <batch>` **without** elevation (plain cmd, no gsudo).
///
/// Foundry configure/build **must** stay non-elevated: wrapping cmake in gsudo breaks
/// CMake 4.3 CUDA link-line probing (nvcc ABI check) and forces a UAC prompt for every build.
/// gsudo is for GPU control (nvidia-smi / Inspector) and optional elevated pi console
/// (`pi_code_launch` with `elevated: true`) — not Foundry.
///
/// Prefer [`apply_cmd_script_raw_arg`] when building a `Command` directly so spaced
/// install paths (e.g. `Blackwell OPS portable`) work. This tuple form returns the
/// program plus a **single** raw_arg tail — do **not** pass the tail through `.args()`.
pub fn cmd_script_launch(batch_path: &Path) -> (PathBuf, String) {
    (system_cmd_exe(), cmd_script_raw_tail(batch_path))
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

    // Same space-safe /c quoting as Foundry: config_dir can live under "…\Blackwell OPS\…".
    let result = run_privileged_cmd_script(app, &script_path);
    let _ = std::fs::remove_file(&script_path);
    result
}

/// Run a `.cmd`/`.bat` via System32 `cmd` with admin rights when needed.
/// Uses space-safe `/d /s /c ""path""` quoting (see [`cmd_script_raw_tail`]).
pub fn run_privileged_cmd_script(
    app: &AppHandle,
    batch_path: &Path,
) -> Result<PrivilegedOutput, String> {
    let cmd_exe = system_cmd_exe();
    let raw = cmd_script_raw_tail(batch_path);
    // One argv after cmd.exe so CreateProcess / gsudo keep the double-quoted /c form intact.
    if is_process_elevated() {
        return spawn_privileged_raw(None, &cmd_exe, &raw, None);
    }
    let gsudo = stage_gsudo(app)?;
    spawn_privileged_raw(Some(&gsudo), &cmd_exe, &raw, None)
}

fn spawn_privileged_raw(
    gsudo: Option<&Path>,
    program: &Path,
    raw_arg: &str,
    cwd: Option<&Path>,
) -> Result<PrivilegedOutput, String> {
    let program = path_for_cmd(program);
    let output = crate::engine_utils::run_hidden_output(|| {
        let mut cmd = if let Some(gsudo_path) = gsudo {
            let gsudo_path = path_for_cmd(gsudo_path);
            let mut c = std::process::Command::new(&gsudo_path);
            // -w = wait. Pass program then a single raw /d /s /c ""path"" tail.
            c.arg("-w").arg(&program);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                c.raw_arg(raw_arg);
            }
            #[cfg(not(windows))]
            {
                c.arg(raw_arg);
            }
            c
        } else {
            let mut c = std::process::Command::new(&program);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                c.raw_arg(raw_arg);
            }
            #[cfg(not(windows))]
            {
                c.arg(raw_arg);
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn cmd_script_raw_tail_double_quotes_paths_with_spaces() {
        let p = PathBuf::from(
            r"C:\AI-MASTER\Blackwell OPS portable\foundry\work\_build_cfg_frontier.bat",
        );
        let tail = cmd_script_raw_tail(&p);
        assert_eq!(
            tail,
            r#"/d /s /c ""C:\AI-MASTER\Blackwell OPS portable\foundry\work\_build_cfg_frontier.bat"""#
        );
    }

    #[test]
    fn cmd_script_launch_returns_system32_cmd() {
        let (prog, tail) = cmd_script_launch(Path::new(r"C:\Blackwell Ops\x.bat"));
        assert_eq!(prog, PathBuf::from(r"C:\Windows\System32\cmd.exe"));
        assert!(tail.starts_with(r#"/d /s /c """#));
        assert!(tail.ends_with('"'));
    }

    #[test]
    fn wt_start_bridge_bat_starts_quoted_wt_and_session() {
        let body = wt_start_bridge_bat_body(
            Path::new(r"C:\Users\GHOST-TOWER\AppData\Local\Microsoft\WindowsApps\wt.exe"),
            Path::new(r"C:\AI-MASTER\Blackwell OPS portable\config\external-tools\pi-home\launch-session.cmd"),
        );
        assert!(body.contains(
            r#"start "" "C:\Users\GHOST-TOWER\AppData\Local\Microsoft\WindowsApps\wt.exe" cmd /c call "C:\AI-MASTER\Blackwell OPS portable\config\external-tools\pi-home\launch-session.cmd""#
        ));
    }
}