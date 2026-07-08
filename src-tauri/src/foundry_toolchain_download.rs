//! One-click Foundry toolchain download from the pinned GitHub `toolchain` release.

use futures_util::StreamExt;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::AsyncWriteExt;

use crate::foundry_toolchain::{
    self, TOOLCHAIN_ARCHIVE_NAME, TOOLCHAIN_GITHUB_REPO, TOOLCHAIN_RELEASE_TAG,
    TOOLCHAIN_RUNTIME_ARCHIVE_NAME,
};

static DOWNLOAD_BUSY: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
pub struct ToolchainDownloadEvent {
    pub pack: String,
    pub phase: String,
    pub message: String,
    pub percent: Option<u8>,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
}

fn emit(app: &tauri::AppHandle, event: ToolchainDownloadEvent) {
    crate::ipc_meter::emit_tracked(app, "toolchain-download-event", event);
}

fn pack_archive_name(pack: &str) -> Result<&'static str, String> {
    match pack.trim().to_lowercase().as_str() {
        "full" => Ok(TOOLCHAIN_ARCHIVE_NAME),
        "runtime" => Ok(TOOLCHAIN_RUNTIME_ARCHIVE_NAME),
        other => Err(format!(
            "Unknown toolchain pack '{}'. Expected 'full' or 'runtime'.",
            other
        )),
    }
}

async fn fetch_release_asset_url(client: &reqwest::Client, asset_name: &str) -> Result<String, String> {
    let url = format!(
        "https://api.github.com/repos/{}/releases/tags/{}",
        TOOLCHAIN_GITHUB_REPO, TOOLCHAIN_RELEASE_TAG
    );
    let resp = client
        .get(&url)
        .header("User-Agent", "Blackwell-Ops")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch toolchain release: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "GitHub release '{}' not found (HTTP {}). Upload toolchain assets first.",
            TOOLCHAIN_RELEASE_TAG,
            resp.status()
        ));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse release JSON: {}", e))?;

    body.get("assets")
        .and_then(|a| a.as_array())
        .and_then(|arr| {
            arr.iter().find(|a| {
                a.get("name")
                    .and_then(|n| n.as_str())
                    .map(|n| n == asset_name)
                    .unwrap_or(false)
            })
        })
        .and_then(|a| a.get("browser_download_url"))
        .and_then(|u| u.as_str())
        .map(|u| u.to_string())
        .ok_or_else(|| {
            format!(
                "Asset '{}' not found on release '{}'.",
                asset_name, TOOLCHAIN_RELEASE_TAG
            )
        })
}

#[cfg(windows)]
fn resolve_7z_exe() -> Result<PathBuf, String> {
    let candidates = [
        PathBuf::from(r"C:\Program Files\7-Zip\7z.exe"),
        PathBuf::from(r"C:\Program Files (x86)\7-Zip\7z.exe"),
    ];
    for path in candidates {
        if path.is_file() {
            return Ok(path);
        }
    }
    if let Ok(output) = std::process::Command::new("where.exe").arg("7z").output() {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            if let Some(first) = text.lines().map(str::trim).find(|l| !l.is_empty()) {
                let path = PathBuf::from(first);
                if path.is_file() {
                    return Ok(path);
                }
            }
        }
    }
    Err(
        "7-Zip not found. Install 7-Zip (7z.exe on PATH) or extract the archive manually."
            .into(),
    )
}

#[cfg(not(windows))]
fn resolve_7z_exe() -> Result<PathBuf, String> {
    Err("Portable Foundry toolchain download is supported on Windows only.".into())
}

#[cfg(windows)]
fn extract_7z_archive(archive: &Path, dest_root: &Path) -> Result<(), String> {
    let seven_z = resolve_7z_exe()?;
    std::fs::create_dir_all(dest_root)
        .map_err(|e| format!("Failed to create extract dir: {}", e))?;

    let dest = dest_root.to_string_lossy().to_string();
    let output = std::process::Command::new(&seven_z)
        .args([
            "x",
            &archive.to_string_lossy(),
            &format!("-o{}", dest),
            "-y",
        ])
        .output()
        .map_err(|e| format!("Failed to run 7-Zip: {}", e))?;

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
fn extract_7z_archive(_archive: &Path, _dest_root: &Path) -> Result<(), String> {
    Err("Portable Foundry toolchain download is supported on Windows only.".into())
}

async fn download_stream_to_file(
    app: &tauri::AppHandle,
    pack: &str,
    url: &str,
    dest: &Path,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Download failed with HTTP {}", resp.status()));
    }

    let total_bytes = resp.content_length().unwrap_or(0);
    let mut stream = resp.bytes_stream();
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("Failed to create download file: {}", e))?;

    let mut downloaded_bytes: u64 = 0;
    let mut last_emit_pct: u8 = 255;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Failed to write download: {}", e))?;
        downloaded_bytes += chunk.len() as u64;

        let percent = if total_bytes > 0 {
            Some(((downloaded_bytes.saturating_mul(100)) / total_bytes).min(100) as u8)
        } else {
            None
        };

        let should_emit = match percent {
            Some(p) => p / 5 != last_emit_pct / 5 || p >= 100,
            None => downloaded_bytes / (32 * 1024 * 1024) != last_emit_pct as u64,
        };
        if should_emit {
            last_emit_pct = percent.unwrap_or((downloaded_bytes / (32 * 1024 * 1024)) as u8);
            emit(
                app,
                ToolchainDownloadEvent {
                    pack: pack.to_string(),
                    phase: "downloading".into(),
                    message: if total_bytes > 0 {
                        format!(
                            "Downloading… {} / {} MB",
                            downloaded_bytes / 1_048_576,
                            total_bytes / 1_048_576
                        )
                    } else {
                        format!("Downloading… {} MB", downloaded_bytes / 1_048_576)
                    },
                    percent,
                    downloaded_bytes,
                    total_bytes,
                },
            );
        }
    }

    file.flush()
        .await
        .map_err(|e| format!("Failed to flush download: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn foundry_download_toolchain(
    app_handle: tauri::AppHandle,
    pack: String,
) -> Result<(), String> {
    if DOWNLOAD_BUSY.swap(true, Ordering::SeqCst) {
        return Err("A toolchain download is already in progress.".into());
    }

    let result: Result<(), String> = async {
        let pack_key = pack.trim().to_lowercase();
        let archive_name = pack_archive_name(&pack_key)?;
        let client = reqwest::Client::new();
        let download_url = fetch_release_asset_url(&client, archive_name).await?;

        let app_root = crate::config::app_root_dir();
        let dl_dir = app_root.join(".toolchain-download");
        std::fs::create_dir_all(&dl_dir)
            .map_err(|e| format!("Failed to create download dir: {}", e))?;

        let archive_path = dl_dir.join(archive_name);
        if archive_path.exists() {
            let _ = std::fs::remove_file(&archive_path);
        }

        emit(
            &app_handle,
            ToolchainDownloadEvent {
                pack: pack_key.clone(),
                phase: "downloading".into(),
                message: format!("Starting download of {}…", archive_name),
                percent: Some(0),
                downloaded_bytes: 0,
                total_bytes: 0,
            },
        );

        download_stream_to_file(&app_handle, &pack_key, &download_url, &archive_path).await?;

        emit(
            &app_handle,
            ToolchainDownloadEvent {
                pack: pack_key.clone(),
                phase: "extracting".into(),
                message: "Extracting… this can take several minutes on slower disks.".into(),
                percent: None,
                downloaded_bytes: 0,
                total_bytes: 0,
            },
        );

        let _ = foundry_toolchain::ensure_manifest_on_disk();
        extract_7z_archive(&archive_path, &app_root)?;

        let _ = std::fs::remove_file(&archive_path);

        emit(
            &app_handle,
            ToolchainDownloadEvent {
                pack: pack_key.clone(),
                phase: "complete".into(),
                message: "Toolchain install complete.".into(),
                percent: Some(100),
                downloaded_bytes: 0,
                total_bytes: 0,
            },
        );

        Ok(())
    }
    .await;

    DOWNLOAD_BUSY.store(false, Ordering::SeqCst);

    if let Err(ref e) = result {
        emit(
            &app_handle,
            ToolchainDownloadEvent {
                pack: pack.trim().to_lowercase(),
                phase: "error".into(),
                message: e.clone(),
                percent: None,
                downloaded_bytes: 0,
                total_bytes: 0,
            },
        );
    }

    result
}