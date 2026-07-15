//! Shared GitHub Releases API helpers — app NSIS installers, toolchain archives, provider zips.
//!
//! App releases are tagged `v1.0.9` style. Special tags (e.g. `toolchain`) are excluded from
//! "latest app" resolution so they never shadow semver releases on `/releases/latest`.
//! Only the full NSIS `*Setup*.exe` is downloaded for in-app updates — not standalone exe.

use std::path::{Path, PathBuf};

use reqwest::RequestBuilder;

pub const GITHUB_REPO: &str = "Seen-Tomorrow/blackwell-ops";

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

/// NSIS installer uploaded to GitHub — not the standalone `blackwell-ops.exe`.
pub fn is_nsis_installer_asset(name: &str) -> bool {
    name.contains("Setup") && name.ends_with(".exe")
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

/// Fetch a release by exact tag (e.g. `toolchain`, `v1.0.9`).
pub async fn fetch_release_by_tag(tag: &str) -> Result<GitHubRelease, String> {
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases/tags/{tag}");
    let body = github_get_json(&url).await?;
    parse_release(&body).ok_or_else(|| format!("Invalid release payload for tag '{tag}'"))
}

/// Newest semver-tagged release — skips `toolchain` and other non-version tags.
pub async fn fetch_latest_version_release() -> Result<GitHubRelease, String> {
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases?per_page=30");
    let body = github_get_json(&url).await?;
    let releases = body
        .as_array()
        .ok_or_else(|| "GitHub releases response was not an array".to_string())?;

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
            return Ok(parsed);
        }
    }

    Err("No semver app release found on GitHub".to_string())
}

pub fn find_asset_by_name(release: &GitHubRelease, name: &str) -> Option<ReleaseAsset> {
    release
        .assets
        .iter()
        .find(|a| a.name == name)
        .cloned()
}

/// Windows NSIS in-place updater — the only app artifact we ship on GitHub.
pub fn find_nsis_installer_asset(release: &GitHubRelease) -> Option<ReleaseAsset> {
    release
        .assets
        .iter()
        .find(|a| is_nsis_installer_asset(&a.name))
        .cloned()
}

/// Directory for cached NSIS installer downloads (resume-capable via download manager).
pub fn app_update_cache_dir() -> PathBuf {
    crate::config::cache_dir().join("app-updates")
}

/// Resolve the NSIS installer asset on the latest semver GitHub release.
pub async fn resolve_app_installer_asset() -> Result<(String, String, String, u64), String> {
    let release = fetch_latest_version_release().await?;
    let asset = find_nsis_installer_asset(&release).ok_or_else(|| {
        format!(
            "No NSIS installer (*Setup*.exe) on release '{}'. Upload the NSIS bundle, not standalone exe.",
            release.tag_name
        )
    })?;
    Ok((
        asset.download_url,
        asset.name,
        release.tag_name,
        asset.size,
    ))
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
        assert!(is_version_release_tag("1.0.9"));
        assert!(is_version_release_tag("v0.7.10"));
        assert!(!is_version_release_tag("toolchain"));
        assert!(!is_version_release_tag("v1.0"));
        assert!(!is_version_release_tag("v1.0.9-beta"));
    }

    #[test]
    fn nsis_installer_names() {
        assert!(is_nsis_installer_asset("Blackwell Ops Setup 1.0.9.exe"));
        assert!(!is_nsis_installer_asset("blackwell-ops.exe"));
        assert!(!is_nsis_installer_asset("ggml-master-frontier.zip"));
    }
}