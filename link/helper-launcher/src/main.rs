//! GUI-subsystem launcher for the OYM Help SFX.
//!
//! 7zS extracts to a new %TEMP%\7zS*.tmp and runs this exe without a console.
//! It copies the payload to %LOCALAPPDATA%\OYM\Help (stable path for firewall
//! rules) and starts the tray app from there.

#![cfg_attr(windows, windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::process::Command;

fn copy_dir(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(destination)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let target = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn main() {
    let Some(source) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    else {
        return;
    };
    let Some(destination) = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|dir| dir.join("OYM").join("Help"))
    else {
        return;
    };

    if source != destination {
        let _ = copy_dir(&source, &destination);
    }

    let app = destination.join("OYM-Help.exe");
    if app.is_file() {
        let _ = Command::new(app).spawn();
    }
}
