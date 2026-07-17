//! Shared GitHub Releases API — portable App `.7z`, Full Bundle NSIS, provider packs, toolchain.
//!
//! Asset naming (GitHub release files):
//! - Core: `CORE_*` — App `.7z`, Full NSIS Setup, optional `CORE_ggml-master-{profile}.7z`
//! - Plugins: `PLUGIN_{provider}-{profile}.7z`
//! Legacy names without prefix are still accepted for older releases.
//!
//! Full pack embeds NSIS core engines (ggml-master) inside Setup only — it does **not**
//! upload separate CORE runtime packs unless you run pack-provider for ggml-master.

use std::path::{Path, PathBuf};

use reqwest::RequestBuilder;
use serde::Serialize;

pub const GITHUB_REPO: &str = "Seen-Tomorrow/blackwell-ops";

pub const CHANNEL_APP_ONLY: &str = "app_only";
pub const CHANNEL_FULL_BUNDLE: &str = "full_bundle";

/// Release asset kind prefixes (Majestic pack/ship).
pub const CORE_ASSET_PREFIX: &str = "CORE_";
pub const PLUGIN_ASSET_PREFIX: &str = "PLUGIN_";

/// App archive stem after optional CORE_ prefix: `Blackwell-Ops-App-vX.Y.Z.7z`.
pub const APP_7Z_STEM: &str = "Blackwell-Ops-App-";
/// Legacy / alias — same as stem (pre-prefix era).
pub const APP_7Z_PREFIX: &str = APP_7Z_STEM;

/// NSIS core engine provider(s) — runtime packs use CORE_ when shipped separately.
pub fn is_core_engine_provider(provider_id: &str) -> bool {
    provider_id == crate::config::DEFAULT_PROVIDER_ID
}

#[derive(Debug, Clone)]
pub struct ReleaseAsset {
    pub name: String,
    pub download_url: String,
    pub size: u64,
}

#[derive(Debug, Clone)]
pub struct GitHubRelease {
    pub tag_name: String,
    pub body: Option<String>,
    pub assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChannelOffering {
    pub channel: String,
    pub available: bool,
    pub version: String,
    pub tag: String,
    pub size_bytes: u64,
    pub label: String,
    pub summary: String,
    pub release_notes: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOfferings {
    pub current_version: String,
    pub engines_available: bool,
    pub app_only: UpdateChannelOffering,
    pub full_bundle: UpdateChannelOffering,
    /// `app_only` | `full_bundle` | `none`
    pub recommended: String,
    /// True when either channel has something to offer.
    pub any_available: bool,
}

/// True for semver app tags like `v1.0.9` — excludes special tags (`toolchain`, etc.).
pub fn is_version_release_tag(tag: &str) -> bool {
    let trimmed = tag.trim();
    let core = trimmed.strip_prefix('v').unwrap_or(trimmed);
    if core.is_empty() {
        return false;
    }
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() < 2 || parts.len() > 4 {
        return false;
    }
    parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

pub fn tag_to_version(tag: &str) -> &str {
    tag.strip_prefix('v').unwrap_or(tag)
}

/// Strip CORE_/PLUGIN_ for matching legacy logic.
fn strip_asset_kind_prefix(name: &str) -> &str {
    name.strip_prefix(CORE_ASSET_PREFIX)
        .or_else(|| name.strip_prefix(PLUGIN_ASSET_PREFIX))
        .unwrap_or(name)
}

/// Lean App update archive: `CORE_Blackwell-Ops-App-v1.0.12.7z` (or legacy without CORE_).
pub fn is_app_update_archive(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if !lower.ends_with(".7z") {
        return false;
    }
    let body = strip_asset_kind_prefix(name);
    let body_lower = body.to_ascii_lowercase();
    if body.starts_with(APP_7Z_STEM) || body_lower.starts_with("blackwell-ops-app-") {
        return true;
    }
    // Loose match: App + .7z (not provider packs)
    body_lower.contains("app")
        && !body_lower.contains("ggml-")
        && !body_lower.contains("provider")
        && !body_lower.starts_with("plugin_")
}

/// Legacy App-Only NSIS (older releases). Still accepted for transition.
pub fn is_app_only_nsis_installer(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    (lower.contains("app-only") || lower.contains("app only"))
        && lower.contains("setup")
        && lower.ends_with(".exe")
}

/// Any App-channel asset (7z preferred, legacy NSIS fallback).
pub fn is_app_update_asset(name: &str) -> bool {
    is_app_update_archive(name) || is_app_only_nsis_installer(name)
}

/// Full Bundle NSIS — complete install including engine runtimes (`CORE_*Setup*.exe` preferred).
pub fn is_full_bundle_nsis_installer(name: &str) -> bool {
    if is_app_update_asset(name) {
        return false;
    }
    let body = strip_asset_kind_prefix(name);
    let lower = body.to_ascii_lowercase();
    lower.contains("setup") && lower.ends_with(".exe")
}

/// Canonical provider pack name for new uploads.
pub fn provider_pack_asset_name(provider_id: &str, profile: &str) -> String {
    let bare = format!("{provider_id}-{profile}.7z");
    if is_core_engine_provider(provider_id) {
        format!("{CORE_ASSET_PREFIX}{bare}")
    } else {
        format!("{PLUGIN_ASSET_PREFIX}{bare}")
    }
}

/// All names we accept when resolving a provider pack (new + legacy).
pub fn provider_pack_asset_candidates(provider_id: &str, profile: &str) -> Vec<String> {
    let bare_7z = format!("{provider_id}-{profile}.7z");
    let bare_zip = format!("{provider_id}-{profile}.zip");
    vec![
        format!("{CORE_ASSET_PREFIX}{bare_7z}"),
        format!("{PLUGIN_ASSET_PREFIX}{bare_7z}"),
        bare_7z,
        format!("{CORE_ASSET_PREFIX}{bare_zip}"),
        format!("{PLUGIN_ASSET_PREFIX}{bare_zip}"),
        bare_zip,
    ]
}

/// Provider runtime pack: `CORE_|PLUGIN_{provider}-{profile}.7z` (+ legacy unprefixed).
pub fn is_provider_pack_asset(name: &str, provider_id: &str, profile: &str) -> bool {
    provider_pack_asset_candidates(provider_id, profile)
        .iter()
        .any(|c| name.eq_ignore_ascii_case(c))
}

pub fn apply_github_auth(req: RequestBuilder) -> RequestBuilder {
    if let Ok(Some(pat)) = crate::secrets::get_secret("github_pat") {
        let trimmed = pat.trim();
        if !trimmed.is_empty() {
            return req.header("Authorization", format!("Bearer {trimmed}"));
        }
    }
    req
}

fn parse_release(body: &serde_json::Value) -> Option<GitHubRelease> {
    let tag_name = body.get("tag_name")?.as_str()?.to_string();
    let body_text = body.get("body").and_then(|b| b.as_str()).map(String::from);
    let assets = body
        .get("assets")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| {
                    let name = a.get("name")?.as_str()?.to_string();
                    let download_url = a.get("browser_download_url")?.as_str()?.to_string();
                    let size = a.get("size").and_then(|s| s.as_u64()).unwrap_or(0);
                    Some(ReleaseAsset {
                        name,
                        download_url,
                        size,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Some(GitHubRelease {
        tag_name,
        body: body_text,
        assets,
    })
}

async fn github_get_json(url: &str) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let resp = apply_github_auth(
        client
            .get(url)
            .header("User-Agent", "Blackwell-Ops")
            .header("Accept", "application/vnd.github+json"),
    )
    .send()
    .await
    .map_err(|e| format!("GitHub request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API returned {} for {url}", resp.status()));
    }

    resp.json()
        .await
        .map_err(|e| format!("Failed to parse GitHub response: {e}"))
}

pub async fn fetch_release_by_tag(tag: &str) -> Result<GitHubRelease, String> {
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases/tags/{tag}");
    let body = github_get_json(&url).await?;
    parse_release(&body).ok_or_else(|| format!("Invalid release payload for tag '{tag}'"))
}

/// Recent semver releases (newest first).
pub async fn fetch_recent_version_releases(per_page: u32) -> Result<Vec<GitHubRelease>, String> {
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases?per_page={per_page}");
    let body = github_get_json(&url).await?;
    let releases = body
        .as_array()
        .ok_or_else(|| "GitHub releases response was not an array".to_string())?;

    let mut out = Vec::new();
    for release in releases {
        let draft = release.get("draft").and_then(|v| v.as_bool()).unwrap_or(false);
        let prerelease = release
            .get("prerelease")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if draft || prerelease {
            continue;
        }
        let Some(parsed) = parse_release(release) else {
            continue;
        };
        if is_version_release_tag(&parsed.tag_name) {
            out.push(parsed);
        }
    }
    Ok(out)
}

pub async fn fetch_latest_version_release() -> Result<GitHubRelease, String> {
    fetch_recent_version_releases(30)
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| "No semver app release found on GitHub".to_string())
}

pub fn find_asset_by_name(release: &GitHubRelease, name: &str) -> Option<ReleaseAsset> {
    release
        .assets
        .iter()
        .find(|a| a.name == name)
        .cloned()
}

/// Prefer lean App `.7z`, then legacy App-Only NSIS.
pub fn find_app_only_installer(release: &GitHubRelease) -> Option<ReleaseAsset> {
    let seven_z = release
        .assets
        .iter()
        .find(|a| is_app_update_archive(&a.name))
        .cloned();
    if seven_z.is_some() {
        return seven_z;
    }
    release
        .assets
        .iter()
        .find(|a| is_app_only_nsis_installer(&a.name))
        .cloned()
}

pub fn find_full_bundle_installer(release: &GitHubRelease) -> Option<ReleaseAsset> {
    release
        .assets
        .iter()
        .find(|a| is_full_bundle_nsis_installer(&a.name))
        .cloned()
}

pub fn find_provider_pack(
    release: &GitHubRelease,
    provider_id: &str,
    profile: &str,
) -> Option<ReleaseAsset> {
    // Prefer canonical CORE_/PLUGIN_ .7z, then legacy unprefixed, then any match.
    for candidate in provider_pack_asset_candidates(provider_id, profile) {
        if let Some(a) = find_asset_by_name(release, &candidate) {
            return Some(a);
        }
    }
    release
        .assets
        .iter()
        .find(|a| is_provider_pack_asset(&a.name, provider_id, profile))
        .cloned()
}

/// Compare dotted numeric versions (handles patch 10+).
pub fn version_gt(a: &str, b: &str) -> bool {
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

fn empty_offering(channel: &str, label: &str, summary: &str) -> UpdateChannelOffering {
    UpdateChannelOffering {
        channel: channel.to_string(),
        available: false,
        version: String::new(),
        tag: String::new(),
        size_bytes: 0,
        label: label.to_string(),
        summary: summary.to_string(),
        release_notes: None,
    }
}

fn offering_from_hit(
    channel: &str,
    label: &str,
    summary: &str,
    release: &GitHubRelease,
    asset: &ReleaseAsset,
) -> UpdateChannelOffering {
    UpdateChannelOffering {
        channel: channel.to_string(),
        available: true,
        version: tag_to_version(&release.tag_name).to_string(),
        tag: release.tag_name.clone(),
        size_bytes: asset.size,
        label: label.to_string(),
        summary: summary.to_string(),
        release_notes: release.body.clone(),
    }
}

/// Scan recent releases and build App-Only / Full Bundle offerings.
pub async fn fetch_update_offerings(current_version: &str) -> Result<UpdateOfferings, String> {
    let engines_available = crate::profile_binaries::launch_engines_available();
    let releases = fetch_recent_version_releases(40).await?;

    let mut app_hit: Option<(GitHubRelease, ReleaseAsset)> = None;
    let mut full_hit: Option<(GitHubRelease, ReleaseAsset)> = None;

    for release in releases {
        let ver = tag_to_version(&release.tag_name);
        if app_hit.is_none() {
            if let Some(asset) = find_app_only_installer(&release) {
                if version_gt(ver, current_version) {
                    app_hit = Some((release.clone(), asset));
                }
            }
        }
        if full_hit.is_none() {
            if let Some(asset) = find_full_bundle_installer(&release) {
                let newer = version_gt(ver, current_version);
                let need_engines = !engines_available;
                if newer || need_engines {
                    full_hit = Some((release.clone(), asset));
                }
            }
        }
        if app_hit.is_some() && full_hit.is_some() {
            break;
        }
    }

    let app_only = if let Some((release, asset)) = app_hit {
        offering_from_hit(
            CHANNEL_APP_ONLY,
            "App update",
            "Portable UI + templates (~few MB) - keeps your engines",
            &release,
            &asset,
        )
    } else {
        empty_offering(
            CHANNEL_APP_ONLY,
            "App update",
            "Portable UI + templates (~few MB) - keeps your engines",
        )
    };

    let full_bundle = if let Some((release, asset)) = full_hit {
        offering_from_hit(
            CHANNEL_FULL_BUNDLE,
            "Full install",
            "Setup: app + pre-built CUDA engines — first install or engine refresh",
            &release,
            &asset,
        )
    } else {
        empty_offering(
            CHANNEL_FULL_BUNDLE,
            "Full install",
            "Setup: app + pre-built CUDA engines — first install or engine refresh",
        )
    };

    let recommended = if !engines_available && full_bundle.available {
        CHANNEL_FULL_BUNDLE.to_string()
    } else if app_only.available {
        CHANNEL_APP_ONLY.to_string()
    } else if full_bundle.available {
        CHANNEL_FULL_BUNDLE.to_string()
    } else {
        "none".to_string()
    };

    let any_available = app_only.available || full_bundle.available;

    Ok(UpdateOfferings {
        current_version: current_version.to_string(),
        engines_available,
        app_only,
        full_bundle,
        recommended,
        any_available,
    })
}

/// Resolve provider pack URL from the newest semver release that contains the asset.
pub async fn find_provider_pack_offering(
    provider_id: &str,
    profile: &str,
) -> Option<(String, u64)> {
    let releases = fetch_recent_version_releases(40).await.ok()?;
    for release in releases {
        if let Some(asset) = find_provider_pack(&release, provider_id, profile) {
            return Some((release.tag_name.clone(), asset.size));
        }
    }
    None
}

pub async fn resolve_provider_pack_asset(
    provider_id: &str,
    profile: &str,
) -> Result<(String, String, String, u64), String> {
    let releases = fetch_recent_version_releases(40).await?;
    for release in releases {
        if let Some(asset) = find_provider_pack(&release, provider_id, profile) {
            return Ok((
                asset.download_url,
                asset.name,
                release.tag_name,
                asset.size,
            ));
        }
    }
    Err(format!(
        "No provider pack '{provider_id}-{profile}.7z' found on recent GitHub releases"
    ))
}

pub async fn resolve_installer_asset_for_version(
    channel: &str,
    current_version: &str,
) -> Result<(String, String, String, u64), String> {
    let offerings = fetch_update_offerings(current_version).await?;
    let pick = match channel {
        CHANNEL_APP_ONLY => &offerings.app_only,
        CHANNEL_FULL_BUNDLE => &offerings.full_bundle,
        other => return Err(format!("Unknown update channel: {other}")),
    };
    if !pick.available {
        return Err(format!(
            "No {} installer available on GitHub",
            pick.label
        ));
    }

    let releases = fetch_recent_version_releases(40).await?;
    let release = releases
        .into_iter()
        .find(|r| r.tag_name == pick.tag)
        .ok_or_else(|| format!("Release '{}' not found", pick.tag))?;

    let asset = match channel {
        CHANNEL_APP_ONLY => find_app_only_installer(&release),
        CHANNEL_FULL_BUNDLE => find_full_bundle_installer(&release),
        _ => None,
    }
    .ok_or_else(|| format!("Installer asset missing on release '{}'", pick.tag))?;

    Ok((
        asset.download_url,
        asset.name,
        release.tag_name,
        asset.size,
    ))
}

/// Directory for cached app update downloads (resume-capable via download manager).
pub fn app_update_cache_dir() -> PathBuf {
    crate::config::cache_dir().join("app-updates")
}

pub fn provider_pack_cache_dir() -> PathBuf {
    crate::config::cache_dir().join("provider-packs")
}

/// Launch a downloaded NSIS installer for silent in-place upgrade (`/S /UPDATE`).
pub fn launch_nsis_installer(installer_path: &Path, app_handle: &tauri::AppHandle) -> Result<(), String> {
    log::info!(
        "[app-update] Launching NSIS installer at {}",
        installer_path.display()
    );

    // Launch NSIS with no cmd chrome; /S is silent install UI.
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new(installer_path)
        .args(["/S", "/UPDATE"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to launch installer: {e}"))?;

    schedule_app_exit(app_handle, 3);
    Ok(())
}

fn schedule_app_exit(app_handle: &tauri::AppHandle, delay_secs: u64) {
    let app_handle_clone = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;
        log::info!("[app-update] Closing app for update apply");
        app_handle_clone.exit(0);
    });
}

/// Apply lean App `.7z`: extract to staging, merge templates + bin, schedule exe swap + relaunch.
pub fn apply_app_update_archive(
    archive_path: &Path,
    app_handle: &tauri::AppHandle,
) -> Result<(), String> {
    let app_root = crate::config::app_root_dir();
    let stage = app_update_cache_dir().join("stage");
    if stage.exists() {
        std::fs::remove_dir_all(&stage)
            .map_err(|e| format!("Failed to clear app update stage: {e}"))?;
    }
    std::fs::create_dir_all(&stage)
        .map_err(|e| format!("Failed to create app update stage: {e}"))?;

    log::info!(
        "[app-update] Extracting {} -> {}",
        archive_path.display(),
        stage.display()
    );
    crate::archive_util::extract_7z_archive(archive_path, &stage)?;

    // Accept app/ prefix or flat layout
    let payload = if stage.join("app").is_dir() {
        stage.join("app")
    } else {
        stage.clone()
    };

    let new_exe = payload.join("blackwell-ops.exe");
    if !new_exe.is_file() {
        return Err(
            "App update archive missing blackwell-ops.exe (expected under app/ or archive root)"
                .into(),
        );
    }

    // Plugin metadata: preferred app/runtime-catalog/, legacy app/runtime/catalog/
    let catalog_candidates = [
        payload.join("runtime-catalog"),
        payload.join("runtime").join("catalog"),
    ];
    let mut catalog_merged = false;
    for catalog_src in &catalog_candidates {
        if catalog_src.is_dir() || catalog_src.join("plugins.json").is_file() {
            let catalog_dst = app_root.join("runtime-catalog");
            if catalog_src.is_dir() {
                crate::archive_util::copy_dir_merge(catalog_src, &catalog_dst)?;
            }
            catalog_merged = true;
            log::info!(
                "[app-update] Merged plugin catalog -> {}",
                catalog_dst.display()
            );
            break;
        }
    }
    if !catalog_merged {
        log::warn!(
            "[app-update] App archive has no runtime-catalog/plugins.json — engine catalog may be stale"
        );
    }

    let staged_runtime = payload.join("runtime");
    if staged_runtime.is_dir() {
        // Merge core factory templates only — never touch engine profile dirs or optional plugin configs
        for provider_entry in std::fs::read_dir(&staged_runtime)
            .map_err(|e| format!("Failed to read staged runtime: {e}"))?
        {
            let provider_entry = provider_entry.map_err(|e| format!("runtime entry: {e}"))?;
            if !provider_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = provider_entry.file_name();
            if name == "catalog" {
                continue; // legacy path handled above
            }
            let config_src = provider_entry.path().join("config");
            if !config_src.is_dir() {
                continue;
            }
            let config_dst = app_root
                .join("runtime")
                .join(provider_entry.file_name())
                .join("config");
            crate::archive_util::copy_dir_merge(&config_src, &config_dst)?;
            log::info!(
                "[app-update] Merged templates -> {}",
                config_dst.display()
            );
        }
    }

    // Ensure 7z is always available next to the app
    let staged_bin = payload.join("bin");
    if staged_bin.is_dir() {
        let bin_dst = app_root.join("bin");
        crate::archive_util::copy_dir_merge(&staged_bin, &bin_dst)?;
        log::info!("[app-update] Merged bin/ helpers");
    }

    let current_exe = std::env::current_exe()
        .map_err(|e| format!("Failed to resolve current exe: {e}"))?;
    let pid = std::process::id();
    let cache = app_update_cache_dir();
    let helper = cache.join("apply-app-update.cmd");
    let log_path = cache.join("apply-app-update.log");
    // Silent helper: no console UI. Progress goes only to the log file.
    let helper_body = format!(
        "@echo off\r\n\
setlocal\r\n\
set \"PID={pid}\"\r\n\
set \"NEW_EXE={new_exe}\"\r\n\
set \"DEST_EXE={dest_exe}\"\r\n\
set \"LOG={log_path}\"\r\n\
>>\"%LOG%\" echo [%DATE% %TIME%] waiting for PID %PID%\r\n\
:waitloop\r\n\
tasklist /FI \"PID eq %PID%\" 2>NUL | find \"%PID%\" >NUL\r\n\
if not errorlevel 1 (\r\n\
  timeout /t 1 /nobreak >NUL\r\n\
  goto waitloop\r\n\
)\r\n\
timeout /t 1 /nobreak >NUL\r\n\
>>\"%LOG%\" echo [%DATE% %TIME%] replacing executable\r\n\
copy /Y \"%NEW_EXE%\" \"%DEST_EXE%\" >NUL\r\n\
if errorlevel 1 (\r\n\
  >>\"%LOG%\" echo [%DATE% %TIME%] copy failed\r\n\
  exit /b 1\r\n\
)\r\n\
>>\"%LOG%\" echo [%DATE% %TIME%] relaunching\r\n\
start \"\" \"%DEST_EXE%\"\r\n\
>>\"%LOG%\" echo [%DATE% %TIME%] done\r\n\
endlocal\r\n",
        pid = pid,
        new_exe = new_exe.display(),
        dest_exe = current_exe.display(),
        log_path = log_path.display(),
    );
    std::fs::write(&helper, helper_body)
        .map_err(|e| format!("Failed to write update helper: {e}"))?;

    log::info!(
        "[app-update] Scheduling silent exe swap via {} (log: {})",
        helper.display(),
        log_path.display()
    );
    spawn_silent_cmd_script(&helper)?;

    schedule_app_exit(app_handle, 1);
    Ok(())
}

/// Run a `.cmd`/`.bat` with no console window (CREATE_NO_WINDOW).
fn spawn_silent_cmd_script(script: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    std::process::Command::new("cmd.exe")
        .args(["/C", &script.to_string_lossy()])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start update helper: {e}"))?;
    Ok(())
}

/// Extract provider pack.
///
/// - **Plugins** → `runtime/{id}/{profile}/` (only install path)
/// - **Core (ggml-master)** → `runtime-catalog/{id}/{profile}/` so NSIS `runtime/` is not clobbered
///
/// Factory config from the pack still merges into `runtime/{id}/config/` when present.
pub fn apply_provider_pack_archive(
    archive_path: &Path,
    provider_id: &str,
    profile: &str,
) -> Result<PathBuf, String> {
    let app_root = crate::config::app_root_dir();
    let core = is_core_engine_provider(provider_id);

    if core {
        // Extract to temp so we never overwrite NSIS runtime/ggml-master/.
        let stage = app_root
            .join("work")
            .join(format!("catalog-pack-{provider_id}-{profile}"));
        if stage.exists() {
            let _ = std::fs::remove_dir_all(&stage);
        }
        std::fs::create_dir_all(&stage)
            .map_err(|e| format!("create catalog stage {}: {e}", stage.display()))?;

        log::info!(
            "[provider-pack] Extracting CORE pack {} → stage {} (overlay runtime-catalog/)",
            archive_path.display(),
            stage.display()
        );
        crate::archive_util::extract_7z_archive(archive_path, &stage)?;

        let staged_profile = stage
            .join("runtime")
            .join(provider_id)
            .join(profile);
        if !staged_profile.is_dir() {
            let _ = std::fs::remove_dir_all(&stage);
            return Err(format!(
                "CORE pack missing runtime/{provider_id}/{profile}/ inside archive"
            ));
        }

        let dest_profile = app_root
            .join("runtime-catalog")
            .join(provider_id)
            .join(profile);
        if dest_profile.exists() {
            std::fs::remove_dir_all(&dest_profile).map_err(|e| {
                format!("clear previous catalog {}: {e}", dest_profile.display())
            })?;
        }
        std::fs::create_dir_all(dest_profile.parent().unwrap_or(Path::new(".")))
            .map_err(|e| format!("create runtime-catalog parent: {e}"))?;
        copy_dir_recursive(&staged_profile, &dest_profile)?;

        // Optional factory config — merge into live runtime/{id}/config (do not remove NSIS templates).
        let staged_config = stage.join("runtime").join(provider_id).join("config");
        if staged_config.is_dir() {
            let dest_config = app_root.join("runtime").join(provider_id).join("config");
            let _ = crate::archive_util::copy_dir_merge(&staged_config, &dest_config);
        }

        let _ = std::fs::remove_dir_all(&stage);

        let server = dest_profile.join("llama-server.exe");
        if !server.is_file() {
            return Err(format!(
                "CORE catalog pack applied but llama-server.exe missing at {}",
                server.display()
            ));
        }
        log::info!(
            "[provider-pack] CORE catalog overlay ready: {}",
            server.display()
        );
        return Ok(server);
    }

    // Plugins: extract into app root (runtime/{id}/{profile}/).
    log::info!(
        "[provider-pack] Extracting PLUGIN pack {} for {}/{} into {}",
        archive_path.display(),
        provider_id,
        profile,
        app_root.display()
    );
    crate::archive_util::extract_7z_archive(archive_path, &app_root)?;

    let server = app_root
        .join("runtime")
        .join(provider_id)
        .join(profile)
        .join("llama-server.exe");
    if !server.is_file() {
        return Err(format!(
            "Provider pack applied but llama-server.exe missing at {}",
            server.display()
        ));
    }
    Ok(server)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("create {}: {e}", dst.display()))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("read {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| format!("dir entry: {e}"))?;
        let ty = entry
            .file_type()
            .map_err(|e| format!("file_type: {e}"))?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else if ty.is_file() {
            std::fs::copy(entry.path(), &to).map_err(|e| {
                format!("copy {} → {}: {e}", entry.path().display(), to.display())
            })?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_tags_only() {
        assert!(is_version_release_tag("v1.0.9"));
        assert!(!is_version_release_tag("toolchain"));
    }

    #[test]
    fn installer_asset_names() {
        assert!(is_app_update_archive("Blackwell-Ops-App-v1.0.12.7z"));
        assert!(is_app_update_archive("CORE_Blackwell-Ops-App-v1.0.12.7z"));
        assert!(is_app_only_nsis_installer("Blackwell Ops App-Only Setup 1.0.9.exe"));
        assert!(is_app_update_asset("Blackwell-Ops-App-v1.0.12.7z"));
        assert!(is_full_bundle_nsis_installer("Blackwell Ops Setup 1.0.9.exe"));
        assert!(is_full_bundle_nsis_installer("CORE_Blackwell Ops_1.0.10_x64-setup.exe"));
        assert!(is_full_bundle_nsis_installer("Blackwell Ops_1.0.10_x64-setup.exe"));
        assert!(!is_full_bundle_nsis_installer("Blackwell Ops App-Only Setup 1.0.9.exe"));
        assert!(!is_full_bundle_nsis_installer("Blackwell-Ops-App-v1.0.12.7z"));
        assert!(!is_full_bundle_nsis_installer("CORE_Blackwell-Ops-App-v1.0.12.7z"));
        assert!(!is_full_bundle_nsis_installer("blackwell-ops.exe"));
        assert!(is_provider_pack_asset(
            "ggml-master-frontier.7z",
            "ggml-master",
            "frontier"
        ));
        assert!(is_provider_pack_asset(
            "CORE_ggml-master-frontier.7z",
            "ggml-master",
            "frontier"
        ));
        assert!(is_provider_pack_asset(
            "PLUGIN_ggml-tom-stable.7z",
            "ggml-tom",
            "stable"
        ));
        assert_eq!(
            provider_pack_asset_name("ggml-master", "frontier"),
            "CORE_ggml-master-frontier.7z"
        );
        assert_eq!(
            provider_pack_asset_name("ggml-tom", "stable"),
            "PLUGIN_ggml-tom-stable.7z"
        );
    }
}