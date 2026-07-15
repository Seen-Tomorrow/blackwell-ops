//! Binary update module — fetch, download, and activate provider binary updates from GitHub releases.
//! App updates download the NSIS installer only (not standalone `blackwell-ops.exe`).

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Feature flag: set to true to enable binary update checks via GitHub API.
/// Keep in sync with `BINARY_UPDATES_ENABLED` in `src/lib/foundry_constants.ts`.
pub const BINARY_UPDATES_ENABLED: bool = true;

/// Bundled providers that ship with bundled binaries.
#[allow(dead_code)]
const BUNDLED_PROVIDERS: &[&str] = &[crate::config::DEFAULT_PROVIDER_ID, "ggml-tom"];

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
    ("frontier", "Frontier (VS2026 + CUDA 13.3)"),
    ("stable", "Stable (VS2022 + CUDA 12.8)"),
];

/// Compare two semver strings properly (handles patch 10+).
fn version_gt(a: &str, b: &str) -> bool {
    let parts_a: Vec<u32> = a.split('.').filter_map(|s| s.parse().ok()).collect();
    let parts_b: Vec<u32> = b.split('.').filter_map(|s| s.parse().ok()).collect();

    let max_len = std::cmp::max(parts_a.len(), parts_b.len());
    for i in 0..max_len {
        let va = *parts_a.get(i).unwrap_or(&0);
        let vb = *parts_b.get(i).unwrap_or(&0);
        if va > vb {
            return true;
        }
        if va < vb {
            return false;
        }
    }
    false
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
        log::debug!(
            "[binary-update] Binary update checks disabled (feature flag off). Skipping for '{}'.",
            provider_id
        );
        return Ok(Vec::new());
    }

    let release = crate::github_releases::fetch_latest_version_release().await?;
    let latest_tag = &release.tag_name;
    let latest_version = latest_tag.strip_prefix('v').unwrap_or(latest_tag);

    let mut results = Vec::new();

    for &(profile, label) in PROFILES {
        let asset_name = format!("{provider_id}-{profile}.zip");
        if crate::github_releases::find_asset_by_name(&release, &asset_name).is_none() {
            continue;
        }

        results.push(BinaryUpdateInfo {
            profile: profile.to_string(),
            profile_label: label.to_string(),
            installed_version: None,
            latest_version: latest_version.to_string(),
            available: true,
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

    let release = crate::github_releases::fetch_latest_version_release().await?;
    let latest_tag = release.tag_name.clone();
    let asset_name = format!("{provider_id}-{profile}");

    let asset = crate::github_releases::find_asset_by_name(&release, &asset_name)
        .ok_or_else(|| format!("Asset '{asset_name}' not found in release {latest_tag}"))?;

    crate::ipc_meter::emit_tracked(
        &app_handle,
        "binary-update:download-start",
        &BinaryUpdateEvent {
            provider_id: provider_id.clone(),
            profile: profile.clone(),
            status: "downloading".to_string(),
            message: format!("Downloading {asset_name}..."),
        },
    );

    let client = reqwest::Client::new();
    let download_resp = crate::github_releases::apply_github_auth(client.get(&asset.download_url))
        .send()
        .await
        .map_err(|e| format!("Failed to download {asset_name}: {e}"))?;

    if !download_resp.status().is_success() {
        return Err(format!(
            "Download failed with status {}",
            download_resp.status()
        ));
    }

    let bytes = download_resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read download: {e}"))?;
    let total_size = bytes.len();

    crate::ipc_meter::emit_tracked(
        &app_handle,
        "binary-update:download-progress",
        &BinaryUpdateEvent {
            provider_id: provider_id.clone(),
            profile: profile.clone(),
            status: "downloading".to_string(),
            message: format!("Downloaded {} MB", total_size / 1_048_576),
        },
    );

    let update_dir = crate::config::app_root_dir()
        .join("runtime")
        .join(&provider_id)
        .join(&profile);

    let current_binary = update_dir.join("llama-server.exe");
    if current_binary.exists() {
        log::warn!(
            "[binary-update] Target binary exists at {} — ensure no engine is using it before overwriting",
            current_binary.display()
        );
        crate::ipc_meter::emit_tracked(
            &app_handle,
            "binary-update:confirm-overwrite",
            &BinaryUpdateEvent {
                provider_id: provider_id.clone(),
                profile: profile.clone(),
                status: "confirm".to_string(),
                message: format!(
                    "{profile} is currently installed. Stop any running engine before updating?"
                ),
            },
        );
    }

    std::fs::create_dir_all(&update_dir)
        .map_err(|e| format!("Failed to create update dir: {e}"))?;

    let temp_zip = update_dir.join(format!("{profile}.zip"));
    std::fs::write(&temp_zip, &bytes).map_err(|e| format!("Failed to write zip: {e}"))?;

    crate::ipc_meter::emit_tracked(
        &app_handle,
        "binary-update:download-progress",
        &BinaryUpdateEvent {
            provider_id: provider_id.clone(),
            profile: profile.clone(),
            status: "extracting".to_string(),
            message: "Extracting binaries...".to_string(),
        },
    );

    let extract_result = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &format!(
                "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                temp_zip.display(),
                update_dir.display()
            ),
        ])
        .output()
        .map_err(|e| format!("Failed to run extraction: {e}"))?;

    if !extract_result.status.success() {
        let stderr = String::from_utf8_lossy(&extract_result.stderr);
        return Err(format!("Extraction failed: {stderr}"));
    }

    let _ = std::fs::remove_file(&temp_zip);

    let server_exe = find_extracted_binary(&update_dir, "llama-server.exe")
        .ok_or_else(|| "llama-server.exe not found after extraction".to_string())?;

    if !server_exe.exists() {
        return Err(format!(
            "Binary validation failed: {} not found",
            server_exe.display()
        ));
    }

    let build_info = crate::engine::get_binary_build_info(server_exe.to_string_lossy().to_string())
        .await
        .unwrap_or_else(|_| {
            log::warn!("Could not read build info from updated binary");
            crate::types::BuildInfo {
                version: String::new(),
                build_date: String::new(),
                cuda_version: None,
                cuda_architectures: None,
            }
        });

    crate::ipc_meter::emit_tracked(
        &app_handle,
        "binary-update:download-complete",
        &BinaryUpdateEvent {
            provider_id: provider_id.clone(),
            profile: profile.clone(),
            status: "complete".to_string(),
            message: format!("Updated to {}", build_info.version),
        },
    );

    let cfg_state = app_handle.state::<std::sync::Mutex<crate::config::AppConfig>>();
    let mut cfg = cfg_state
        .lock()
        .map_err(|e| format!("Failed to lock config: {e}"))?;

    if let Some(provider) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
        let rel = crate::config::to_relative_path(&server_exe);
        provider.binary_path_per_env.insert(profile.clone(), rel);
        provider
            .downloaded_version_per_env
            .insert(profile.clone(), latest_tag.clone());
        provider.build_info_per_env.insert(profile.clone(), build_info);

        log::info!(
            "[binary-update] Updated {} [{}]: {} (release: {})",
            provider_id,
            profile,
            server_exe.display(),
            latest_tag
        );
    } else {
        return Err(format!("Provider '{provider_id}' not found in config"));
    }

    crate::config::persist_user_providers_meta(&cfg.providers)
        .map_err(|e| format!("Failed to persist provider meta after update: {e}"))?;

    Ok(())
}

fn find_extracted_binary(dir: &Path, filename: &str) -> Option<PathBuf> {
    if dir.join(filename).exists() {
        return Some(dir.join(filename));
    }

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
    pub status: String,
    pub message: String,
}

#[tauri::command]
pub fn get_profile_labels() -> Vec<serde_json::Value> {
    PROFILES
        .iter()
        .map(|(id, label)| serde_json::json!({ "id": id, "label": label }))
        .collect()
}

/// Check for app update via GitHub semver releases (NSIS installer present).
#[tauri::command]
pub async fn check_app_update(app_handle: tauri::AppHandle) -> Result<AppUpdateInfo, String> {
    if !BINARY_UPDATES_ENABLED {
        log::debug!("[binary-update] App update checks disabled (feature flag off). Skipping.");
        let current_version = app_handle.package_info().version.to_string();
        return Ok(AppUpdateInfo {
            available: false,
            version: current_version.clone(),
            current_version,
            release_notes: None,
        });
    }

    let current_version = app_handle.package_info().version.to_string();

    let release = match crate::github_releases::fetch_latest_version_release().await {
        Ok(r) => r,
        Err(e) => {
            log::warn!("[app-update] {e}");
            return Ok(AppUpdateInfo {
                available: false,
                version: current_version.clone(),
                current_version,
                release_notes: None,
            });
        }
    };

    if crate::github_releases::find_nsis_installer_asset(&release).is_none() {
        log::warn!(
            "[app-update] Release '{}' has no NSIS installer asset",
            release.tag_name
        );
        return Ok(AppUpdateInfo {
            available: false,
            version: current_version.clone(),
            current_version,
            release_notes: None,
        });
    }

    let latest_tag = &release.tag_name;
    let latest_version = latest_tag.strip_prefix('v').unwrap_or(latest_tag);
    let available = version_gt(latest_version, &current_version);

    Ok(AppUpdateInfo {
        available,
        version: latest_tag.to_string(),
        current_version,
        release_notes: release.body,
    })
}

/// Enqueue NSIS installer download via the shared download manager (pause/resume/progress).
#[tauri::command]
pub async fn install_app_update(
    app_handle: tauri::AppHandle,
    manager: tauri::State<'_, std::sync::Arc<tokio::sync::RwLock<crate::download_manager::DownloadManager>>>,
) -> Result<String, String> {
    if !BINARY_UPDATES_ENABLED {
        return Err("App updates are disabled".to_string());
    }

    let mut dm = manager.write().await;
    let task_id = dm
        .start_app_update_download(app_handle.clone(), std::sync::Arc::clone(&*manager))
        .await?;
    drop(dm);

    crate::ipc_meter::emit_tracked(
        &app_handle,
        "download-event",
        serde_json::json!({
            "type": "queued",
            "taskId": task_id,
            "taskKind": "app",
        }),
    );

    Ok(task_id)
}

#[tauri::command]
pub async fn get_startup_updates(app_handle: tauri::AppHandle) -> Result<StartupUpdateStatus, String> {
    if !BINARY_UPDATES_ENABLED {
        log::debug!("[binary-update] All update checks disabled (feature flag off). Returning empty results.");
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

    let app_update_future = check_app_update(app_handle.clone());
    let ggml_future = check_binary_updates(crate::config::DEFAULT_PROVIDER_ID.to_string());
    let tom_future = check_binary_updates("ggml-tom".to_string());

    let (app_result, ggml_result, tom_result) =
        tokio::join!(app_update_future, ggml_future, tom_future);

    let app_update = match app_result {
        Ok(info) => info,
        Err(e) => {
            log::warn!("[startup-updates] App update check failed: {e}");
            AppUpdateInfo {
                available: false,
                version: String::new(),
                current_version: String::new(),
                release_notes: None,
            }
        }
    };

    let mut binary_updates = Vec::new();

    for (provider_id, result) in [
        (crate::config::DEFAULT_PROVIDER_ID, ggml_result),
        ("ggml-tom", tom_result),
    ] {
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
                log::warn!("[startup-updates] Binary check failed for {provider_id}: {e}");
            }
        }
    }

    Ok(StartupUpdateStatus {
        app_update,
        binary_updates,
    })
}

#[tauri::command]
pub async fn revert_binary_to_bundled(
    app_handle: tauri::AppHandle,
    provider_id: String,
    profile: String,
) -> Result<(), String> {
    let cfg_state = app_handle.state::<std::sync::Mutex<crate::config::AppConfig>>();
    let mut cfg = cfg_state
        .lock()
        .map_err(|e| format!("Failed to lock config: {e}"))?;

    if let Some(provider) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
        crate::profile_binaries::set_profile_source(
            provider,
            &profile,
            crate::profile_binaries::SOURCE_BUNDLED,
        )?;
        provider.downloaded_version_per_env.remove(&profile);
        crate::profile_binaries::resolve_after_source_change(provider);

        log::info!("[binary-update] Reverted {provider_id} [{profile}] to bundled default");
    } else {
        return Err(format!("Provider '{provider_id}' not found in config"));
    }

    crate::config::persist_user_providers_meta(&cfg.providers)
        .map_err(|e| format!("Failed to persist after revert: {e}"))?;

    Ok(())
}