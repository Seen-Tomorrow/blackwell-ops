//! Binary update module — fetch, download, and activate provider binary updates from GitHub releases.

use serde::Serialize;
use std::path::PathBuf;
use tauri::{Emitter, Manager};

/// Feature flag: set to true to enable binary update checks via GitHub API.
/// Currently disabled because releases are not yet uploaded. Set to true when ready.
const BINARY_UPDATES_ENABLED: bool = false;

/// Bundled providers that ship with bundled binaries.
#[allow(dead_code)]
const BUNDLED_PROVIDERS: &[&str] = &[crate::config::DEFAULT_PROVIDER_ID, "ik"];

#[derive(Debug, Clone, Serialize)]
pub struct AppUpdateInfo {
    pub available: bool,
    pub version: String,
    pub current_version: String,
    pub release_notes: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderBinaryUpdates {
    pub provider_id: String,
    pub updates: Vec<BinaryUpdateInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StartupUpdateStatus {
    pub app_update: AppUpdateInfo,
    pub binary_updates: Vec<ProviderBinaryUpdates>,
}

/// Profile metadata for display in UI.
const PROFILES: &[(&str, &str)] = &[
    ("vanguard", "Vanguard (VS2026 + CUDA 13.2)"),
    ("stable", "Stable (VS2022 + CUDA 12.8)"),
    ("fresh", "Fresh (VS2022 + CUDA 13.1)"),
];

/// GitHub repo hosting binary release assets.
const GITHUB_REPO: &str = "Seen-Tomorrow/blackwell-ops";

/// Compare two semver strings properly (handles patch 10+).
fn version_gt(a: &str, b: &str) -> bool {
    let parts_a: Vec<u32> = a.split('.').filter_map(|s| s.parse().ok()).collect();
    let parts_b: Vec<u32> = b.split('.').filter_map(|s| s.parse().ok()).collect();

    // Pad shorter version with zeros (e.g., "0.7" → [0, 7, 0])
    let max_len = std::cmp::max(parts_a.len(), parts_b.len());
    for i in 0..max_len {
        let va = *parts_a.get(i).unwrap_or(&0);
        let vb = *parts_b.get(i).unwrap_or(&0);
        if va > vb { return true; }
        if va < vb { return false; }
    }
    false  // Equal versions → not greater
}

#[derive(Debug, Clone, Serialize)]
pub struct BinaryUpdateInfo {
    pub profile: String,
    pub profile_label: String,
    pub installed_version: Option<String>,
    pub latest_version: String,
    pub available: bool,
}

/// Fetch the latest GitHub release and compare against installed versions.
#[tauri::command]
pub async fn check_binary_updates(provider_id: String) -> Result<Vec<BinaryUpdateInfo>, String> {
    if !BINARY_UPDATES_ENABLED {
        log::warn!("[binary-update] Binary update checks disabled (feature flag off). Skipping for '{}'.", provider_id);
        return Ok(Vec::new());
    }

    let client = reqwest::Client::new();
    
    // Fetch latest release from GitHub API
    let url = format!("https://api.github.com/repos/{}/releases/latest", GITHUB_REPO);
    let resp = client.get(&url)
        .header("User-Agent", "Blackwell-Ops")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch release info: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API returned {} — check repo or network", resp.status()));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| format!("Failed to parse release: {}", e))?;
    let latest_tag = body.get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or("No tag_name in release response")?;

    // Strip "v" prefix if present (e.g., "v0.7.7" → "0.7.7")
    let latest_version = latest_tag.strip_prefix('v').unwrap_or(latest_tag);

    // Build update info for each profile
    let mut results = Vec::new();
    
    for &(profile, label) in PROFILES {
        let asset_name = format!("{}-{}.zip", provider_id, profile);
        
        // Check if this asset exists in the release
        let has_asset = body.get("assets")
            .and_then(|a| a.as_array())
            .map_or(false, |arr| arr.iter().any(|a| 
                a.get("name").and_then(|n| n.as_str()) == Some(&asset_name)
            ));

        if !has_asset {
            continue;  // Skip profiles not available in this release
        }

        results.push(BinaryUpdateInfo {
            profile: profile.to_string(),
            profile_label: label.to_string(),
            installed_version: None,  // Will be filled by frontend from build_info_per_env
            latest_version: latest_version.to_string(),
            available: true,  // If asset exists and we don't know installed version, assume update available
        });
    }

    Ok(results)
}

/// Download and activate a binary update for a specific provider/profile.
#[tauri::command]
pub async fn download_binary_update(
    app_handle: tauri::AppHandle,
    provider_id: String,
    profile: String,
) -> Result<(), String> {
    if !BINARY_UPDATES_ENABLED {
        return Err("Binary updates are disabled".to_string());
    }

    let client = reqwest::Client::new();

    // Fetch latest release to get the asset URL
    let url = format!("https://api.github.com/repos/{}/releases/latest", GITHUB_REPO);
    let resp = client.get(&url)
        .header("User-Agent", "Blackwell-Ops")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch release: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API returned {}", resp.status()));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| format!("Failed to parse: {}", e))?;
    
    // Capture the release tag for version tracking (used later for comparison)
    let latest_tag = body.get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let asset_name = format!("{}-{}.zip", provider_id, profile);

    // Find the download URL for this asset
    let download_url = body.get("assets")
        .and_then(|a| a.as_array())
        .and_then(|arr| arr.iter().find(|a| 
            a.get("name").and_then(|n| n.as_str()) == Some(&asset_name)
        ))
        .and_then(|a| a.get("browser_download_url"))
        .and_then(|u| u.as_str())
        .ok_or_else(|| format!("Asset '{}' not found in latest release", asset_name))?;

    // Emit download start event
    let _ = app_handle.emit("binary-update:download-start", &BinaryUpdateEvent {
        provider_id: provider_id.clone(),
        profile: profile.clone(),
        status: "downloading".to_string(),
        message: format!("Downloading {}...", asset_name),
    });

    // Download the zip file
    let download_resp = client.get(download_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download {}: {}", asset_name, e))?;

    if !download_resp.status().is_success() {
        return Err(format!("Download failed with status {}", download_resp.status()));
    }

    let bytes = download_resp.bytes().await.map_err(|e| format!("Failed to read download: {}", e))?;
    let total_size = bytes.len();

    // Emit progress
    let _ = app_handle.emit("binary-update:download-progress", &BinaryUpdateEvent {
        provider_id: provider_id.clone(),
        profile: profile.clone(),
        status: "downloading".to_string(),
        message: format!("Downloaded {} MB", total_size / 1_048_576),
    });

    // Extract directly into runtime/{id}/{profile}/ (portable, replaces bundled binary)
    let update_dir = crate::config::app_root_dir()
        .join("runtime")
        .join(&provider_id)
        .join(&profile);

    // Check if the target binary is currently in use by a running engine
    let current_binary = update_dir.join("llama-server.exe");
    if current_binary.exists() {
        log::warn!("[binary-update] Target binary exists at {} — ensure no engine is using it before overwriting", current_binary.display());
        // Emit event to frontend asking user for confirmation
        let _ = app_handle.emit("binary-update:confirm-overwrite", &BinaryUpdateEvent {
            provider_id: provider_id.clone(),
            profile: profile.clone(),
            status: "confirm".to_string(),
            message: format!("{} is currently installed. Stop any running engine before updating?", profile),
        });
    }

    std::fs::create_dir_all(&update_dir).map_err(|e| format!("Failed to create update dir: {}", e))?;

    // Write zip to temp file
    let temp_zip = update_dir.join(format!("{}.zip", profile));
    std::fs::write(&temp_zip, &bytes).map_err(|e| format!("Failed to write zip: {}", e))?;

    // Extract using PowerShell's Expand-Archive (built-in on Windows)
    let _ = app_handle.emit("binary-update:download-progress", &BinaryUpdateEvent {
        provider_id: provider_id.clone(),
        profile: profile.clone(),
        status: "extracting".to_string(),
        message: "Extracting binaries...".to_string(),
    });

    // Don't delete old files — an engine might be using them. Expand-Archive -Force overwrites in-place.
    let extract_result = std::process::Command::new("powershell")
        .args([
            "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-Command", &format!(
                "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                temp_zip.display(),
                update_dir.display()
            ),
        ])
        .output()
        .map_err(|e| format!("Failed to run extraction: {}", e))?;

    if !extract_result.status.success() {
        let stderr = String::from_utf8_lossy(&extract_result.stderr);
        return Err(format!("Extraction failed: {}", stderr));
    }

    // Clean up temp zip
    let _ = std::fs::remove_file(&temp_zip);

    // Find the extracted llama-server.exe — it might be in a subdirectory (zip may contain top-level folder)
    let server_exe = find_extracted_binary(&update_dir, "llama-server.exe")
        .ok_or_else(|| format!("llama-server.exe not found after extraction"))?;

    // Validate the binary exists and is accessible
    if !server_exe.exists() {
        return Err(format!("Binary validation failed: {} not found", server_exe.display()));
    }

    // Get version info from the new binary
    let build_info = crate::engine::get_binary_build_info(server_exe.to_string_lossy().to_string())
        .await
        .unwrap_or_else(|_| {
            log::warn!("Could not read build info from updated binary");
            crate::types::BuildInfo {
                version: String::new(),
                build_date: String::new(),
                cuda_version: None,
            }
        });

    // Emit success event with new path and build info
    let _ = app_handle.emit("binary-update:download-complete", &BinaryUpdateEvent {
        provider_id: provider_id.clone(),
        profile: profile.clone(),
        status: "complete".to_string(),
        message: format!("Updated to {}", build_info.version),
    });

    // Update the provider config — set per-env path to point to new binary
    let cfg_state = app_handle.state::<std::sync::Mutex<crate::config::AppConfig>>();
    let mut cfg = cfg_state.lock().map_err(|e| format!("Failed to lock config: {}", e))?;

    if let Some(provider) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
        // Set per-env path as relative (portable)
        let rel = crate::config::to_relative_path(&server_exe);
        provider.binary_path_per_env.insert(profile.clone(), rel);

        // Track which GitHub release tag was downloaded (for version comparison)
        let latest_tag_for_log = latest_tag.clone();
        provider.downloaded_version_per_env.insert(profile.clone(), latest_tag);

        // Also update build info for this env
        provider.build_info_per_env.insert(profile.clone(), build_info);

        log::info!("[binary-update] Updated {} [{}]: {} (release: {})", provider_id, profile, server_exe.display(), latest_tag_for_log);
    } else {
        return Err(format!("Provider '{}' not found in config", provider_id));
    }

    // Persist the updated config
    crate::config::persist_user_providers_meta(&cfg.providers)
        .map_err(|e| format!("Failed to persist provider meta after update: {}", e))?;

    Ok(())
}

/// Recursively search for a binary file in the extraction directory.
fn find_extracted_binary(dir: &std::path::Path, filename: &str) -> Option<PathBuf> {
    // Check direct children first
    if dir.join(filename).exists() {
        return Some(dir.join(filename));
    }

    // Check one level deep (zip may have top-level folder)
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.file_type().map_or(false, |ft| ft.is_dir()) {
                let candidate = entry.path().join(filename);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }

    None
}

#[derive(Debug, Clone, Serialize)]
pub struct BinaryUpdateEvent {
    pub provider_id: String,
    pub profile: String,
    pub status: String,  // "downloading", "extracting", "complete", "error"
    pub message: String,
}

/// Get profile metadata for UI display.
#[tauri::command]
pub fn get_profile_labels() -> Vec<serde_json::Value> {
    PROFILES.iter().map(|(id, label)| {
        serde_json::json!({ "id": id, "label": label })
    }).collect()
}

/// Check for app update via GitHub releases API.
#[tauri::command]
pub async fn check_app_update(app_handle: tauri::AppHandle) -> Result<AppUpdateInfo, String> {
    if !BINARY_UPDATES_ENABLED {
        log::warn!("[binary-update] App update checks disabled (feature flag off). Skipping.");
        let current_version = app_handle.package_info().version.to_string();
        return Ok(AppUpdateInfo {
            available: false,
            version: current_version.clone(),
            current_version,
            release_notes: None,
        });
    }

    let client = reqwest::Client::new();
    let current_version = app_handle.package_info().version.to_string();

    // Fetch latest release from GitHub API
    let url = format!("https://api.github.com/repos/{}/releases/latest", GITHUB_REPO);
    let resp = client.get(&url)
        .header("User-Agent", "Blackwell-Ops")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch release info: {}", e))?;

    if !resp.status().is_success() {
        log::warn!("[app-update] GitHub API returned {}", resp.status());
        return Ok(AppUpdateInfo {
            available: false,
            version: current_version.clone(),
            current_version,
            release_notes: None,
        });
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| format!("Failed to parse release: {}", e))?;
    let latest_tag = body.get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or("No tag_name in release response")?;

    // Strip "v" prefix for comparison (e.g., "v0.7.8" → "0.7.8")
    let latest_version = latest_tag.strip_prefix('v').unwrap_or(latest_tag);

    // Compare versions properly (handles patch 10+)
    let available = version_gt(latest_version, &current_version);

    let release_notes = body.get("body").and_then(|b| b.as_str()).map(String::from);

    Ok(AppUpdateInfo {
        available,
        version: latest_tag.to_string(),
        current_version,
        release_notes,
    })
}

/// Download and install the latest app update.
#[tauri::command]
pub async fn install_app_update(app_handle: tauri::AppHandle) -> Result<(), String> {
    if !BINARY_UPDATES_ENABLED {
        return Err("App updates are disabled".to_string());
    }

    let client = reqwest::Client::new();

    // Fetch latest release to find the Windows installer asset
    let url = format!("https://api.github.com/repos/{}/releases/latest", GITHUB_REPO);
    let resp = client.get(&url)
        .header("User-Agent", "Blackwell-Ops")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch release: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API returned {}", resp.status()));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| format!("Failed to parse: {}", e))?;

    // Find the Windows NSIS installer asset (e.g., "Blackwell Ops Setup 0.7.8.exe")
    let download_url = body.get("assets")
        .and_then(|a| a.as_array())
        .and_then(|arr| arr.iter().find(|a| {
            a.get("name").and_then(|n| n.as_str()).map_or(false, |name| {
                name.contains("Setup") && name.ends_with(".exe")
            })
        }))
        .and_then(|a| a.get("browser_download_url"))
        .and_then(|u| u.as_str())
        .ok_or_else(|| "No Windows installer found in latest release".to_string())?;

    // Emit download start event
    let _ = app_handle.emit("app-update:download-start", &serde_json::json!({
        "status": "downloading",
        "message": "Downloading update...",
    }));

    // Download the installer to a temp file
    let download_resp = client.get(download_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download: {}", e))?;

    if !download_resp.status().is_success() {
        return Err(format!("Download failed with status {}", download_resp.status()));
    }

    let bytes = download_resp.bytes().await.map_err(|e| format!("Failed to read download: {}", e))?;

    // Write to temp directory with unique filename (avoids conflicts from failed installs)
    let temp_dir = std::env::temp_dir();
    let installer_name = format!("Blackwell_Ops_Setup_{}.exe", chrono::Utc::now().format("%Y%m%d%H%M%S"));
    let installer_path = temp_dir.join(installer_name);
    std::fs::write(&installer_path, &bytes).map_err(|e| format!("Failed to write installer: {}", e))?;

    // Emit download complete event
    let _ = app_handle.emit("app-update:download-complete", &serde_json::json!({
        "status": "complete",
        "message": "Update downloaded. Installing...",
    }));

    log::info!("[app-update] Launching installer at {}", installer_path.display());

    // Launch the installer silently (NSIS /S flag for silent install)
    std::process::Command::new("cmd")
        .args(["/C", &format!("start \"\" /wait \"{}\" /S", installer_path.display())])
        .spawn()
        .map_err(|e| format!("Failed to launch installer: {}", e))?;

    // Don't delete the temp file — Windows will clean it up. Deleting too early corrupts the install.
    log::info!("[app-update] Installer left at {} for Windows cleanup", installer_path.display());

    // Close old instance after a short delay so NSIS can replace files in use
    let app_handle_clone = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        log::info!("[app-update] Closing old instance to allow installer to complete");
        app_handle_clone.exit(0);
    });

    Ok(())
}

/// Combined startup check — app update + binary updates for all Bundled providers.
#[tauri::command]
pub async fn get_startup_updates(app_handle: tauri::AppHandle) -> Result<StartupUpdateStatus, String> {
    if !BINARY_UPDATES_ENABLED {
        log::warn!("[binary-update] All update checks disabled (feature flag off). Returning empty results.");
        return Ok(StartupUpdateStatus {
            app_update: AppUpdateInfo {
                available: false,
                version: String::new(),
                current_version: String::new(),
                release_notes: None,
            },
            binary_updates: Vec::new(),
        });
    }

    // Run all checks in parallel (app + each provider's binary updates)
    let app_update_future = check_app_update(app_handle.clone());
    let ggml_future = check_binary_updates(crate::config::DEFAULT_PROVIDER_ID.to_string());
    let ik_future = check_binary_updates("ik".to_string());

    let (app_result, ggml_result, ik_result) = tokio::join!(app_update_future, ggml_future, ik_future);

    // Process app update result
    let app_update = match app_result {
        Ok(info) => info,
        Err(e) => {
            log::warn!("[startup-updates] App update check failed: {}", e);
            AppUpdateInfo {
                available: false,
                version: String::new(),
                current_version: String::new(),
                release_notes: None,
            }
        }
    };

    // Process binary updates results
    let mut binary_updates = Vec::new();

    for (provider_id, result) in [(crate::config::DEFAULT_PROVIDER_ID, ggml_result), ("ik", ik_result)] {
        match result {
            Ok(updates) => {
                if !updates.is_empty() {
                    binary_updates.push(ProviderBinaryUpdates {
                        provider_id: provider_id.to_string(),
                        updates,
                    });
                }
            }
            Err(e) => {
                log::warn!("[startup-updates] Binary check failed for {}: {}", provider_id, e);
            }
        }
    }

    Ok(StartupUpdateStatus {
        app_update,
        binary_updates,
    })
}

/// Revert a provider profile's binary path back to the bundled default.
#[tauri::command]
pub async fn revert_binary_to_bundled(
    app_handle: tauri::AppHandle,
    provider_id: String,
    profile: String,
) -> Result<(), String> {
    let cfg_state = app_handle.state::<std::sync::Mutex<crate::config::AppConfig>>();
    let mut cfg = cfg_state.lock().map_err(|e| format!("Failed to lock config: {}", e))?;

    if let Some(provider) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
        // Remove per-env override — resolution chain will fall back to bundled binary
        provider.binary_path_per_env.remove(&profile);
        // Also clear stale download version tracking — we're using bundled now
        provider.downloaded_version_per_env.remove(&profile);

        log::info!("[binary-update] Reverted {} [{}] to bundled default", provider_id, profile);
    } else {
        return Err(format!("Provider '{}' not found in config", provider_id));
    }

    crate::config::persist_user_providers_meta(&cfg.providers)
        .map_err(|e| format!("Failed to persist after revert: {}", e))?;

    Ok(())
}
