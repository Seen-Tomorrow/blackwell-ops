//! Shared 7-Zip extract helpers — App updates, provider packs, toolchain.

use std::path::{Path, PathBuf};

/// Resolve bundled `7z.exe` (portable `bin/` first, then cargo-dev bin).
pub fn resolve_7z_exe() -> Result<PathBuf, String> {
    crate::foundry_toolchain::resolve_7z_exe()
}

#[cfg(windows)]
fn command_no_window(program: &Path) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = std::process::Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Extract a `.7z` archive into `dest_root` (creates dir; overwrite all).
#[cfg(windows)]
pub fn extract_7z_archive(archive: &Path, dest_root: &Path) -> Result<(), String> {
    let seven_z = resolve_7z_exe()?;
    std::fs::create_dir_all(dest_root)
        .map_err(|e| format!("Failed to create extract dir: {e}"))?;

    let dest = dest_root.to_string_lossy().to_string();
    let output = command_no_window(&seven_z)
        .args([
            "x",
            &archive.to_string_lossy(),
            &format!("-o{dest}"),
            "-y",
            "-aoa",
        ])
        .output()
        .map_err(|e| format!("Failed to run 7-Zip: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "7-Zip extraction failed (exit {:?}): {} {}",
            output.status.code(),
            stderr.trim(),
            stdout.trim()
        )
        .trim()
        .to_string());
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn extract_7z_archive(_archive: &Path, _dest_root: &Path) -> Result<(), String> {
    Err("7-Zip extract is supported on Windows only.".into())
}

/// Recursively copy files from `src` into `dst` (creates dirs, overwrites files).
pub fn copy_dir_merge(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.is_dir() {
        return Err(format!("Not a directory: {}", src.display()));
    }
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create {}: {e}", dst.display()))?;
    for entry in std::fs::read_dir(src)
        .map_err(|e| format!("Failed to read {}: {e}", src.display()))?
    {
        let entry = entry.map_err(|e| format!("read_dir entry: {e}"))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_merge(&from, &to)?;
        } else if from.is_file() {
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
            }
            std::fs::copy(&from, &to).map_err(|e| {
                format!(
                    "Failed to copy {} -> {}: {e}",
                    from.display(),
                    to.display()
                )
            })?;
        }
    }
    Ok(())
}
