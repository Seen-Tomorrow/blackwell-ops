//! Shared GitHub Releases API — App-Only vs Full Bundle NSIS installers, toolchain archives.
//!
//! App-Only: `*App-Only*Setup*.exe` — UI + provider template JSONs, no engine binaries.
//! Full Bundle: `*Setup*.exe` without `App-Only` — complete install with bundled engines.

use std::path::{Path, PathBuf};

use reqwest::RequestBuilder;
use serde::Serialize;

pub const GITHUB_REPO: &str = "Seen-Tomorrow/blackwell-ops";

pub const CHANNEL_APP_ONLY: &str = "app_only";
pub const CHANNEL_FULL_BUNDLE: &str = "full_bundle";

pub const APP_ONLY_ASSET_MARKER: &str = "App-Only";

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

/// App-Only NSIS — templates + app, no bundled engine profiles.
pub fn is_app_only_nsis_installer(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains(&APP_ONLY_ASSET_MARKER.to_ascii_lowercase())
        && lower.contains("setup")
        && lower.ends_with(".exe")
}

/// Full Bundle NSIS — complete install including engine runtimes.
pub fn is_full_bundle_nsis_installer(name: &str) -> bool {
    if is_app_only_nsis_installer(name) {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    lower.contains("setup") && lower.ends_with(".exe")
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

pub fn find_app_only_installer(release: &GitHubRelease) -> Option<ReleaseAsset> {
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
            "App-Only",
            "UI, templates & fixes — keeps your engines",
            &release,
            &asset,
        )
    } else {
        empty_offering(
            CHANNEL_APP_ONLY,
            "App-Only",
            "UI, templates & fixes — keeps your engines",
        )
    };

    let full_bundle = if let Some((release, asset)) = full_hit {
        offering_from_hit(
            CHANNEL_FULL_BUNDLE,
            "Full Bundle",
            "App + pre-built CUDA engines — first install or engine refresh",
            &release,
            &asset,
        )
    } else {
        empty_offering(
            CHANNEL_FULL_BUNDLE,
            "Full Bundle",
            "App + pre-built CUDA engines — first install or engine refresh",
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

/// Directory for cached NSIS installer downloads (resume-capable via download manager).
pub fn app_update_cache_dir() -> PathBuf {
    crate::config::cache_dir().join("app-updates")
}

/// Launch a downloaded NSIS installer for silent in-place upgrade (`/S /UPDATE`).
pub fn launch_nsis_installer(installer_path: &Path, app_handle: &tauri::AppHandle) -> Result<(), String> {
    log::info!(
        "[app-update] Launching NSIS installer at {}",
        installer_path.display()
    );

    std::process::Command::new("cmd")
        .args([
            "/C",
            &format!(
                "start \"\" /wait \"{}\" /S /UPDATE",
                installer_path.display()
            ),
        ])
        .spawn()
        .map_err(|e| format!("Failed to launch installer: {e}"))?;

    let app_handle_clone = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        log::info!("[app-update] Closing old instance to allow installer to complete");
        app_handle_clone.exit(0);
    });

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
        assert!(is_app_only_nsis_installer("Blackwell Ops App-Only Setup 1.0.9.exe"));
        assert!(is_full_bundle_nsis_installer("Blackwell Ops Setup 1.0.9.exe"));
        assert!(is_full_bundle_nsis_installer("Blackwell Ops_1.0.10_x64-setup.exe"));
        assert!(!is_full_bundle_nsis_installer("Blackwell Ops App-Only Setup 1.0.9.exe"));
        assert!(!is_full_bundle_nsis_installer("blackwell-ops.exe"));
    }
}