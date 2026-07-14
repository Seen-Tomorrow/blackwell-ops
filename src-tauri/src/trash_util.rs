//! Cross-platform Recycle Bin / Trash helpers.
//!
//! Wraps the `trash` crate (Windows Recycle Bin, macOS Trash, FreeDesktop on Linux/BSD).
//! Import `crate::trash_util` from any command or backend module.

use std::path::{Path, PathBuf};

/// Ensure a path exists on disk before sending it to the OS trash.
pub fn require_exists(path: &Path) -> Result<PathBuf, String> {
    if !path.exists() {
        return Err(format!("Path not found: {}", path.display()));
    }
    Ok(path.to_path_buf())
}

/// Move one file or folder to the OS Recycle Bin / Trash.
pub fn move_to_trash(path: impl AsRef<Path>) -> Result<(), String> {
    let path = path.as_ref();
    require_exists(path)?;
    trash::delete(path).map_err(|e| format!("Failed to move to Recycle Bin: {e}"))
}

/// Move multiple paths to the OS Recycle Bin / Trash. Stops on the first failure.
pub fn move_all_to_trash(paths: impl IntoIterator<Item = impl AsRef<Path>>) -> Result<(), String> {
    for path in paths {
        move_to_trash(path)?;
    }
    Ok(())
}