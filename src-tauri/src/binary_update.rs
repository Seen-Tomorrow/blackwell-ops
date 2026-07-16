//! Release updates — App `.7z` / Full NSIS, and per-provider runtime packs via download_manager.
//! Provider packs land in portable `runtime/{id}/{profile}/` (same tree as Full Bundle).

use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use tauri::Manager;

#[cfg(debug_assertions)]
static DEV_UPDATE_VERSION_OVERRIDE: Mutex<Option<String>> = Mutex::new(None);

/// Version used for GitHub update comparison — real package version unless dev override is set.
fn effective_update_version(app_handle: &tauri::AppHandle) -> String {
    #[cfg(debug_assertions)]
    if let Ok(guard) = DEV_UPDATE_VERSION_OVERRIDE.lock() {
        if let Some(v) = guard.as_ref() {
            return v.clone();
        }
    }
    app_handle.package_info().version.to_string()
}

#[cfg(debug_assertions)]
fn decrement_patch_version(version: &str) -> Option<String> {
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() < 3 {
        return None;
    }
    let major: u32 = parts[0].parse().ok()?;
    let minor: u32 = parts[1].parse().ok()?;
    let patch: u32 = parts[2].parse().ok()?;
    if patch == 0 {
        return None;
    }
    Some(format!("{major}.{minor}.{}", patch - 1))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevUpdateVersionOverrideStatus {
    pub enabled: bool,
    pub real_version: String,
    pub effective_version: String,
    pub override_version: Option<String>,
}

fn dev_update_override_status(app_handle: &tauri::AppHandle) -> DevUpdateVersionOverrideStatus {
    let real_version = app_handle.package_info().version.to_string();
    #[cfg(debug_assertions)]
    let override_version = DEV_UPDATE_VERSION_OVERRIDE
        .lock()
        .ok()
        .and_then(|g| g.clone());
    #[cfg(not(debug_assertions))]
    let override_version: Option<String> = None;
    let effective_version = override_version
        .clone()
        .unwrap_or_else(|| real_version.clone());
    DevUpdateVersionOverrideStatus {
        enabled: override_version.is_some(),
        real_version,
        effective_version,
        override_version,
    }
}

#[tauri::command]
pub fn get_dev_update_version_override(
    app_handle: tauri::AppHandle,
) -> DevUpdateVersionOverrideStatus {
    dev_update_override_status(&app_handle)
}

/// Dev-only: pretend the app is on `version` for update checks (`null` clears).
#[tauri::command]
pub fn set_dev_update_version_override(version: Option<String>) -> Result<(), String> {
    #[cfg(not(debug_assertions))]
    return Err("Dev update version override is only available in debug builds".into());
    #[cfg(debug_assertions)]
    {
        let mut guard = DEV_UPDATE_VERSION_OVERRIDE
            .lock()
            .map_err(|e| format!("Lock failed: {e}"))?;
        *guard = version
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        Ok(())
    }
}

/// Dev-only: toggle fake version one patch behind real (for updater UI testing).
#[tauri::command]
pub fn toggle_dev_update_version_fake(
    app_handle: tauri::AppHandle,
) -> Result<DevUpdateVersionOverrideStatus, String> {
    #[cfg(not(debug_assertions))]
    return Err("Dev update version override is only available in debug builds".into());
    #[cfg(debug_assertions)]
    {
        let real_version = app_handle.package_info().version.to_string();
        let mut guard = DEV_UPDATE_VERSION_OVERRIDE
            .lock()
            .map_err(|e| format!("Lock failed: {e}"))?;
        if guard.is_some() {
            *guard = None;
        } else {
            let fake = decrement_patch_version(&real_version)
                .ok_or_else(|| format!("Cannot decrement patch for version {real_version}"))?;
            *guard = Some(fake);
        }
        drop(guard);
        Ok(dev_update_override_status(&app_handle))
    }
}

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
#[serde(rename_all = "camelCase")]
pub struct StartupUpdateStatus {
    pub app_update: AppUpdateInfo,
    pub update_offerings: crate::github_releases::UpdateOfferings,
    pub binary_updates: Vec<ProviderBinaryUpdates>,
}

/// Profile metadata for display in UI.
const PROFILES: &[(&str, &str)] = &[
    ("frontier", "Frontier (VS2026 + CUDA 13.3)"),
    ("stable", "Stable (VS2022 + CUDA 12.8)"),
];

#[derive(Debug, Clone, Serialize)]
pub struct BinaryUpdateInfo {
    pub profile: String,
    pub profile_label: String,
    pub installed_version: Option<String>,
    pub latest_version: String,
    pub available: bool,
}

/// Scan recent releases for `{provider}-{profile}.7z` packs.
#[tauri::command]
pub async fn check_binary_updates(provider_id: String) -> Result<Vec<BinaryUpdateInfo>, String> {
    if !BINARY_UPDATES_ENABLED {
        log::debug!(
            "[binary-update] Update checks disabled (feature flag off). Skipping for '{}'.",
            provider_id
        );
        return Ok(Vec::new());
    }

    let releases = crate::github_releases::fetch_recent_version_releases(40).await?;
    let mut results = Vec::new();

    for &(profile, label) in PROFILES {
        let mut found: Option<(String, String)> = None; // version, tag
        for release in &releases {
            if crate::github_releases::find_provider_pack(release, &provider_id, profile).is_some()
            {
                let ver = crate::github_releases::tag_to_version(&release.tag_name).to_string();
                found = Some((ver, release.tag_name.clone()));
                break;
            }
        }
        let Some((latest_version, _tag)) = found else {
            continue;
        };

        results.push(BinaryUpdateInfo {
            profile: profile.to_string(),
            profile_label: label.to_string(),
            installed_version: None,
            latest_version,
            available: true,
        });
    }

    Ok(results)
}

/// Enqueue provider pack download through the shared download manager (resume + 7z extract).
#[tauri::command]
pub async fn download_binary_update(
    app_handle: tauri::AppHandle,
    manager: tauri::State<'_, std::sync::Arc<tokio::sync::RwLock<crate::download_manager::DownloadManager>>>,
    provider_id: String,
    profile: String,
) -> Result<String, String> {
    if !BINARY_UPDATES_ENABLED {
        return Err("Binary updates are disabled".to_string());
    }

    // Refuse if this provider already has a running engine (file locks on Windows).
    {
        let ctx = app_handle.state::<crate::engine::AppContext>();
        let stack = ctx.stack.lock().await;
        if stack.provider_has_active_engine(&provider_id) {
            return Err(format!(
                "Stop the running {provider_id} engine before updating profile '{profile}'."
            ));
        }
    }

    crate::ipc_meter::emit_tracked(
        &app_handle,
        "binary-update:download-start",
        &BinaryUpdateEvent {
            provider_id: provider_id.clone(),
            profile: profile.clone(),
            status: "downloading".to_string(),
            message: format!("Downloading {provider_id}-{profile}.7z…"),
        },
    );

    let mut dm = manager.write().await;
    let task_id = dm
        .start_provider_pack_download(
            app_handle.clone(),
            provider_id,
            profile,
            std::sync::Arc::clone(&*manager),
        )
        .await?;
    drop(dm);

    crate::ipc_meter::emit_tracked(
        &app_handle,
        "download-event",
        serde_json::json!({
            "type": "queued",
            "taskId": task_id,
            "taskKind": "provider",
        }),
    );

    Ok(task_id)
}

/// After 7z extract: point provider at `runtime/.../llama-server.exe` and record release tag.
pub fn activate_provider_pack(
    app_handle: &tauri::AppHandle,
    provider_id: &str,
    profile: &str,
    server_exe: &Path,
    release_tag: &str,
) -> Result<(), String> {
    let cfg_state = app_handle.state::<std::sync::Mutex<crate::config::AppConfig>>();
    let mut cfg = cfg_state
        .lock()
        .map_err(|e| format!("Failed to lock config: {e}"))?;

    if let Some(provider) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
        let rel = crate::config::to_relative_path(&server_exe.to_path_buf());
        provider
            .binary_path_per_env
            .insert(profile.to_string(), rel.clone());
        provider
            .downloaded_version_per_env
            .insert(profile.to_string(), release_tag.to_string());
        provider
            .binary_source_per_env
            .insert(profile.to_string(), crate::profile_binaries::SOURCE_BUNDLED.to_string());

        if let Some(info) = std::fs::metadata(server_exe)
            .ok()
            .and_then(|m| m.modified().ok())
            .map(|mt| {
                let build_date = chrono::DateTime::<chrono::Local>::from(mt)
                    .format("%Y-%m-%d %H:%M")
                    .to_string();
                crate::types::BuildInfo {
                    version: release_tag.trim_start_matches('v').to_string(),
                    build_date,
                    cuda_version: None,
                    cuda_architectures: None,
                }
            })
        {
            provider
                .build_info_per_env
                .insert(profile.to_string(), info);
        }

        log::info!(
            "[binary-update] Activated {} [{}]: {} (release: {})",
            provider_id,
            profile,
            server_exe.display(),
            release_tag
        );
    } else {
        // New fork: templates may have just landed; discovery on next reload will pick it up.
        log::warn!(
            "[binary-update] Provider '{provider_id}' not in live config yet — pack extracted to disk"
        );
    }

    crate::config::persist_user_providers_meta(&cfg.providers)
        .map_err(|e| format!("Failed to persist provider meta after update: {e}"))?;

    Ok(())
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

fn offerings_to_legacy_app_update(offerings: &crate::github_releases::UpdateOfferings) -> AppUpdateInfo {
    let pick = if offerings.app_only.available {
        &offerings.app_only
    } else if offerings.full_bundle.available {
        &offerings.full_bundle
    } else {
        return AppUpdateInfo {
            available: false,
            version: offerings.current_version.clone(),
            current_version: offerings.current_version.clone(),
            release_notes: None,
        };
    };
    AppUpdateInfo {
        available: true,
        version: pick.tag.clone(),
        current_version: offerings.current_version.clone(),
        release_notes: pick.release_notes.clone(),
    }
}

fn empty_update_offerings(current_version: String) -> crate::github_releases::UpdateOfferings {
    crate::github_releases::UpdateOfferings {
        current_version: current_version.clone(),
        engines_available: crate::profile_binaries::launch_engines_available(),
        app_only: crate::github_releases::UpdateChannelOffering {
            channel: crate::github_releases::CHANNEL_APP_ONLY.to_string(),
            available: false,
            version: String::new(),
            tag: String::new(),
            size_bytes: 0,
            label: "App update".to_string(),
            summary: "Portable UI + templates (~few MB) — keeps your engines".to_string(),
            release_notes: None,
        },
        full_bundle: crate::github_releases::UpdateChannelOffering {
            channel: crate::github_releases::CHANNEL_FULL_BUNDLE.to_string(),
            available: false,
            version: String::new(),
            tag: String::new(),
            size_bytes: 0,
            label: "Full install".to_string(),
            summary: "Setup: app + pre-built CUDA engines — first install or engine refresh"
                .to_string(),
            release_notes: None,
        },
        recommended: "none".to_string(),
        any_available: false,
    }
}

async fn resolve_update_offerings(
    app_handle: &tauri::AppHandle,
) -> Result<crate::github_releases::UpdateOfferings, String> {
    let current_version = effective_update_version(app_handle);
    if !BINARY_UPDATES_ENABLED {
        return Ok(empty_update_offerings(current_version));
    }
    crate::github_releases::fetch_update_offerings(&current_version)
        .await
        .map_err(|e| {
            log::warn!("[app-update] {e}");
            e
        })
}

/// Dual-channel update offerings (App-Only + Full Bundle).
#[tauri::command]
pub async fn get_update_offerings(
    app_handle: tauri::AppHandle,
) -> Result<crate::github_releases::UpdateOfferings, String> {
    resolve_update_offerings(&app_handle).await
}

/// Legacy single-channel check — maps to recommended offering.
#[tauri::command]
pub async fn check_app_update(app_handle: tauri::AppHandle) -> Result<AppUpdateInfo, String> {
    let offerings = resolve_update_offerings(&app_handle).await?;
    Ok(offerings_to_legacy_app_update(&offerings))
}

/// Enqueue App `.7z` or Full Bundle NSIS download (`channel`: `app_only` | `full_bundle`).
#[tauri::command]
pub async fn install_app_update(
    app_handle: tauri::AppHandle,
    manager: tauri::State<'_, std::sync::Arc<tokio::sync::RwLock<crate::download_manager::DownloadManager>>>,
    channel: Option<String>,
) -> Result<String, String> {
    if !BINARY_UPDATES_ENABLED {
        return Err("App updates are disabled".to_string());
    }

    let current_version = effective_update_version(&app_handle);
    let offerings = crate::github_releases::fetch_update_offerings(&current_version).await?;
    let channel_key = channel.unwrap_or_else(|| offerings.recommended.clone());
    if channel_key == "none" {
        return Err("No update available for this channel".to_string());
    }

    let mut dm = manager.write().await;
    let task_id = dm
        .start_app_update_download(
            app_handle.clone(),
            channel_key,
            current_version,
            std::sync::Arc::clone(&*manager),
        )
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
        let current_version = app_handle.package_info().version.to_string();
        return Ok(StartupUpdateStatus {
            app_update: AppUpdateInfo {
                available: false,
                version: String::new(),
                current_version: current_version.clone(),
                release_notes: None,
            },
            update_offerings: empty_update_offerings(current_version),
            binary_updates: Vec::new(),
        });
    }

    let offerings_future = resolve_update_offerings(&app_handle);
    let ggml_future = check_binary_updates(crate::config::DEFAULT_PROVIDER_ID.to_string());
    let tom_future = check_binary_updates("ggml-tom".to_string());

    let (offerings_result, ggml_result, tom_result) =
        tokio::join!(offerings_future, ggml_future, tom_future);

    let update_offerings = match offerings_result {
        Ok(o) => o,
        Err(e) => {
            log::warn!("[startup-updates] Update offerings check failed: {e}");
            empty_update_offerings(app_handle.package_info().version.to_string())
        }
    };
    let app_update = offerings_to_legacy_app_update(&update_offerings);

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
        update_offerings,
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