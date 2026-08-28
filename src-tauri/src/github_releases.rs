//! Shared GitHub Releases API — portable App `.7z`, Full Bundle NSIS, provider packs, toolchain.
//!
//! Asset naming (GitHub release files):
//! - Core: `CORE_*` — App `.7z`, Full NSIS Setup, optional `CORE_ggml-master-{profile}.7z`
//! - Plugins: `PLUGIN_{provider}-{profile}.7z`
//! Legacy names without prefix are still accepted for older releases.
//!
//! Full pack embeds NSIS core engines (ggml-master) inside Setup only — it does **not**
//! upload separate CORE runtime packs unless you run pack-provider for ggml-master.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use parking_lot::Mutex as PlMutex;
use std::time::{Duration, Instant};

use reqwest::RequestBuilder;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;


pub const GITHUB_REPO: &str = "Seen-Tomorrow/blackwell-ops";

pub const CHANNEL_APP_ONLY: &str = "app_only";
pub const CHANNEL_FULL_BUNDLE: &str = "full_bundle";

/// Release asset kind prefixes (Majestic pack/ship).
pub const CORE_ASSET_PREFIX: &str = "CORE_";
pub const PLUGIN_ASSET_PREFIX: &str = "PLUGIN_";

/// App archive stem after optional CORE_ prefix: `Blackwell-Ops-App-vX.Y.Z.7z`.
pub const APP_7Z_STEM: &str = "Blackwell-Ops-App-";

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

fn github_pat_present() -> bool {
    crate::secrets::get_secret("github_pat")
        .ok()
        .flatten()
        .map(|p| !p.trim().is_empty())
        .unwrap_or(false)
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

// ── Single GitHub REST gateway ─────────────────────────────────────────────
// Every api.github.com call goes through `github_get_json_cached`: persistent
// disk cache (survives rebuilds/restarts) + ETag/304 + per-URL single-flight +
// a short force-dedup window + an hourly budget. This is what keeps call volume
// sane — the old in-memory-only cache was wiped on every restart, so 100 rebuilds
// per day re-hit the API 100 times.

/// TTLs per resource class. The releases list is shared by every pack/offering check.
const RELEASES_CACHE_TTL: Duration = Duration::from_secs(30 * 60);
const TAG_CACHE_TTL: Duration = Duration::from_secs(60 * 60);
const LATEST_TAG_CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// `force` re-fetches issued within this window share one round-trip (the Updates tab
/// fires 3 parallel force calls; without this they'd be 3 separate API hits).
const FORCE_DEDUP_WINDOW: Duration = Duration::from_secs(60);
/// Hard hourly cap on real API calls. Background (non-force) fetches serve stale cache
/// once we're within 2 of the cap; user-initiated force fetches always proceed.
const BUDGET_MAX_PER_HOUR: usize = 45;

fn github_cache_dir() -> PathBuf {
    crate::config::cache_dir().join("github")
}

fn now_unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Sanitize a URL into a stable on-disk cache filename.
fn github_cache_file(url: &str) -> PathBuf {
    let key: String = url
        .chars()
        .map(|c| match c {
            '/' | '?' | '&' | '=' | ':' | '{' | '}' | ' ' | '#' => '_',
            c => c,
        })
        .collect();
    github_cache_dir().join(format!("gh_{key}.json"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GitHubCacheEntry {
    fetched_at: u64,
    etag: Option<String>,
    body: serde_json::Value,
}

fn read_github_cache(url: &str) -> Option<GitHubCacheEntry> {
    let s = std::fs::read_to_string(github_cache_file(url)).ok()?;
    serde_json::from_str(&s).ok()
}

fn write_github_cache(url: &str, entry: &GitHubCacheEntry) {
    if std::fs::create_dir_all(github_cache_dir()).is_err() {
        return;
    }
    if let Ok(s) = serde_json::to_string(entry) {
        let _ = std::fs::write(github_cache_file(url), s);
    }
}

fn cache_age(e: &GitHubCacheEntry) -> Duration {
    Duration::from_secs(now_unix_secs().saturating_sub(e.fetched_at))
}

/// In-memory single-flight locks (per URL) + recent-fetch dedup window + hourly budget.
struct GatewayMem {
    locks: HashMap<String, Arc<Mutex<()>>>,
    recent: HashMap<String, (Instant, serde_json::Value)>,
    budget: Vec<Instant>,
}

static GATEWAY_MEM: LazyLock<PlMutex<GatewayMem>> = LazyLock::new(|| {
    PlMutex::new(GatewayMem {
        locks: HashMap::new(),
        recent: HashMap::new(),
        budget: Vec::new(),
    })
});

/// Shared HTTP client (connection pooling — the old code built a new client per call).
static GITHUB_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});

fn budget_remaining() -> usize {
    let mut g = GATEWAY_MEM.lock();
    // Windows Instant is boot-relative: `now - 1h` panics when uptime < 1h
    // ("overflow when subtracting duration from instant") and REL aborts (panic=abort).
    let now = Instant::now();
    let window = Duration::from_secs(3600);
    g.budget
        .retain(|t| now.saturating_duration_since(*t) < window);
    BUDGET_MAX_PER_HOUR.saturating_sub(g.budget.len())
}

fn budget_record() {
    let mut g = GATEWAY_MEM.lock();
    g.budget.push(Instant::now());
}

fn dev_github_log(msg: &str) {
    // DEV terminal (env_logger). Always info in debug so live vs cache is visible
    // before rate-limit 403s show up in the webview.
    if cfg!(debug_assertions) {
        log::info!("{msg}");
    } else {
        log::debug!("{msg}");
    }
}

/// The single chokepoint for api.github.com. `force` = revalidate (bypass TTL) but still
/// dedups within `FORCE_DEDUP_WINDOW` and yields to stale cache when the hourly budget
/// is nearly exhausted (background calls only).
async fn github_get_json_cached(
    url: &str,
    ttl: Duration,
    force: bool,
) -> Result<serde_json::Value, String> {
    let url = url.to_string();

    // 1. Fresh disk cache (non-force) → 0 API calls. Survives rebuilds/restarts.
    if !force {
        if let Some(e) = read_github_cache(&url) {
            if cache_age(&e) < ttl {
                dev_github_log(&format!(
                    "[github] DISK CACHE HIT (age {}s < ttl {}s)",
                    cache_age(&e).as_secs(),
                    ttl.as_secs()
                ));
                return Ok(e.body);
            }
        }
    }

    // 2. Force-dedup window: a fetch for this URL finished recently → share it.
    {
        let g = GATEWAY_MEM.lock();
        if let Some((at, body)) = g.recent.get(&url) {
            if at.elapsed() < FORCE_DEDUP_WINDOW {
                dev_github_log(&format!(
                    "[github] DEDUP HIT (age {}s < {}s)",
                    at.elapsed().as_secs(),
                    FORCE_DEDUP_WINDOW.as_secs()
                ));
                return Ok(body.clone());
            }
        }
    }

    // 3. Single-flight per URL: waiters re-check after the winner finishes.
    let lock = {
        let mut g = GATEWAY_MEM.lock();
        g.locks.entry(url.clone()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
    };
    let _guard = lock.lock().await;

    // Re-check disk cache + dedup after waiting (another caller may have fetched).
    if !force {
        if let Some(e) = read_github_cache(&url) {
            if cache_age(&e) < ttl {
                return Ok(e.body);
            }
        }
    }
    if let Some((at, body)) = GATEWAY_MEM.lock().recent.get(&url) {
        if at.elapsed() < FORCE_DEDUP_WINDOW {
            return Ok(body.clone());
        }
    }

    // 4. Budget: background (non-force) calls yield to stale cache when near the cap.
    if !force && budget_remaining() <= 2 {
        if let Some(e) = read_github_cache(&url) {
            dev_github_log("[github] BUDGET LOW — serving stale cache");
            return Ok(e.body);
        }
    }

    // 5. Conditional GET (ETag): 304 refreshes TTL cheaply, 200 stores the new body.
    let prior = read_github_cache(&url);
    let (body, new_etag) =
        github_get_json_conditional(&url, prior.as_ref().and_then(|e| e.etag.clone())).await?;

    // 6. Persist: 200 → new body+etag; 304 → prior body, refreshed TTL.
    let entry = GitHubCacheEntry {
        fetched_at: now_unix_secs(),
        etag: new_etag.or_else(|| prior.and_then(|e| e.etag)),
        body: body.clone(),
    };
    write_github_cache(&url, &entry);
    {
        let mut g = GATEWAY_MEM.lock();
        g.recent.insert(url.clone(), (Instant::now(), body.clone()));
    }

    Ok(body)
}

/// Conditional GET with ETag + PAT (401/403 → anon retry). Returns (body, etag). On 304
/// the body is the prior cached body. Records against the hourly budget (304s count too).
async fn github_get_json_conditional(
    url: &str,
    etag: Option<String>,
) -> Result<(serde_json::Value, Option<String>), String> {
    let mut attempt_auth = github_pat_present();

    loop {
        let mut req = GITHUB_CLIENT
            .get(url)
            .header("User-Agent", "Blackwell-Ops")
            .header("Accept", "application/vnd.github+json");
        if attempt_auth {
            req = apply_github_auth(req);
        }
        if let Some(tag) = &etag {
            req = req.header("If-None-Match", tag.clone());
        }

        dev_github_log(&format!(
            "[github] LIVE GET {url}{}",
            if attempt_auth { " (auth)" } else { " (anon)" }
        ));

        let resp = req
            .send()
            .await
            .map_err(|e| format!("GitHub request failed: {e}"))?;

        let status = resp.status();

        if status.as_u16() == 304 {
            let prior_body = read_github_cache(url)
                .map(|e| e.body)
                .ok_or_else(|| "GitHub 304 but no prior cache body".to_string())?;
            let new_etag = resp
                .headers()
                .get("ETag")
                .and_then(|v| v.to_str().ok())
                .map(String::from);
            budget_record();
            return Ok((prior_body, new_etag));
        }

        if (status.as_u16() == 401 || status.as_u16() == 403) && attempt_auth {
            log::warn!(
                "[github] PAT rejected ({status}) for {url} — retrying anonymous once"
            );
            attempt_auth = false;
            continue;
        }
        if !status.is_success() {
            return Err(format!("GitHub API returned {status} for {url}"));
        }

        let new_etag = resp
            .headers()
            .get("ETag")
            .and_then(|v| v.to_str().ok())
            .map(String::from);
        let body = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse GitHub response: {e}"))?;
        budget_record();
        return Ok((body, new_etag));
    }
}

pub async fn fetch_release_by_tag(tag: &str) -> Result<GitHubRelease, String> {
    // Serve from the shared releases list first (0 API calls for recent semver tags).
    if let Ok(releases) = fetch_recent_version_releases(40).await {
        if let Some(rel) = releases.into_iter().find(|r| r.tag_name == tag) {
            return Ok(rel);
        }
    }
    // Not in the list (e.g. the `toolchain` tag) → conditional cached fetch (1h TTL).
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases/tags/{tag}");
    let body = github_get_json_cached(&url, TAG_CACHE_TTL, false).await?;
    parse_release(&body).ok_or_else(|| format!("Invalid release payload for tag '{tag}'"))
}

/// Latest release `tag_name` for an arbitrary GitHub repo (e.g. the DEV-only pi
/// update check for `earendil-works/pi`). Cached per-repo for 6h on disk.
pub async fn fetch_latest_release_tag(repo: &str) -> Result<String, String> {
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let body = github_get_json_cached(&url, LATEST_TAG_CACHE_TTL, false).await?;
    body.get("tag_name")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| format!("No tag_name in latest release for {repo}"))
}

/// Recent semver releases (newest first). Shared 30m TTL + single-flight.
pub async fn fetch_recent_version_releases(per_page: u32) -> Result<Vec<GitHubRelease>, String> {
    fetch_recent_version_releases_ex(per_page, false).await
}

/// `force` revalidates against GitHub (bypasses the disk TTL) but still dedups within
/// the shared gateway window. Every pack/offering check shares one releases-list fetch
/// plus the persistent disk cache (keyed by the full URL, incl. `per_page`).
pub async fn fetch_recent_version_releases_ex(
    per_page: u32,
    force: bool,
) -> Result<Vec<GitHubRelease>, String> {
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases?per_page={per_page}");
    let body = github_get_json_cached(&url, RELEASES_CACHE_TTL, force).await?;
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
    fetch_update_offerings_ex(current_version, false).await
}

pub async fn fetch_update_offerings_ex(
    current_version: &str,
    force: bool,
) -> Result<UpdateOfferings, String> {
    let engines_available = crate::profile_binaries::launch_engines_available();
    let releases = fetch_recent_version_releases_ex(40, force).await?;

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
/// Prefer matching against an already-fetched releases list (see `find_provider_pack_in`).
#[allow(dead_code)]
pub async fn find_provider_pack_offering(
    provider_id: &str,
    profile: &str,
) -> Option<(String, u64)> {
    find_provider_pack_offering_ex(provider_id, profile, false).await
}

#[allow(dead_code)]
pub async fn find_provider_pack_offering_ex(
    provider_id: &str,
    profile: &str,
    force: bool,
) -> Option<(String, u64)> {
    let releases = fetch_recent_version_releases_ex(40, force).await.ok()?;
    find_provider_pack_in(&releases, provider_id, profile)
}

/// In-memory pack lookup (no network) — use after one shared releases fetch.
pub fn find_provider_pack_in(
    releases: &[GitHubRelease],
    provider_id: &str,
    profile: &str,
) -> Option<(String, u64)> {
    for release in releases {
        if let Some(asset) = find_provider_pack(release, provider_id, profile) {
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

/// Exit after delay — always tears down engines first (`AppHandle::exit` skips CloseRequested).
fn schedule_app_exit(app_handle: &tauri::AppHandle, delay_secs: u64) {
    use crate::output_console::{
        emit_blackwell_output_console_debug_line, emit_blackwell_output_console_engines_line,
        BlackwellOutputConsoleLineStyle,
    };

    let app_handle_clone = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let msg = format!(
            "[app-update] Exit scheduled in {delay_secs}s — tearing down engines first (no bare exit)"
        );
        log::info!("{msg}");
        emit_blackwell_output_console_engines_line(
            &msg,
            BlackwellOutputConsoleLineStyle::Highlight,
        );
        emit_blackwell_output_console_debug_line(&msg);

        // Kill engines immediately so VRAM/ports free while UI shows "restarting…".
        // Job object is the safety net if exit races ahead of taskkill.
        crate::engine::teardown_all_for_app_exit(&app_handle_clone).await;
        if delay_secs > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;
        }
        log::info!("[app-update] Closing app for update apply");
        crate::session_log::append_session_line("[app-update] finish_process_exit after teardown");
        crate::app_lifecycle::finish_process_exit(&app_handle_clone).await;
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

    // pi-subagents extension (pi-ext). Staged by pack-app-update.ps1 only when the
    // extension actually changed, so its presence here means "install the new tree".
    // Replaces {app_root}/pi-ext wholesale rather than merging: a merge would leave
    // pruned/removed modules behind from the previous version. Materializing into
    // app_root is what pi_code's sync_bundled_subagents reads on next session launch,
    // and that sync also self-heals the pi-home copy (version stamp + shadow-link
    // scrub), so no extra work is needed here.
    let staged_piext = payload.join("pi-ext");
    if staged_piext.join("pi-subagents").join("package.json").is_file() {
        let piext_dst = app_root.join("pi-ext");
        if piext_dst.exists() {
            std::fs::remove_dir_all(&piext_dst).map_err(|e| {
                format!(
                    "Failed to clear {} before pi-ext update: {e}. Close any running pi from Blackwell and retry.",
                    piext_dst.display()
                )
            })?;
        }
        crate::archive_util::copy_dir_merge(&staged_piext, &piext_dst)?;
        log::info!(
            "[app-update] Installed pi-ext → {} (pi-subagents refreshed)",
            piext_dst.display()
        );
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
/// Space-safe: app install dirs may contain spaces (`Blackwell OPS portable`, etc.).
fn spawn_silent_cmd_script(script: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut cmd = std::process::Command::new(crate::sidecar_elevate::system_cmd_exe());
    crate::sidecar_elevate::apply_cmd_script_raw_arg(&mut cmd, script);
    cmd.creation_flags(CREATE_NO_WINDOW)
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

    #[test]
    fn core_engine_pack_eligible_custom_not_without_catalog() {
        assert!(is_core_engine_provider("ggml-master"));
        assert!(!is_core_engine_provider("ds4"));
        assert!(!is_core_engine_provider("my-custom-fork"));
        // Core always eligible for pack checks regardless of plugins.json.
        assert!(crate::binary_update::is_pack_update_eligible("ggml-master"));
        // Non-catalog custom must not be treated as core.
        // (Full catalog membership needs plugins.json on disk — covered by runtime path.)
    }

    #[test]
    fn find_provider_pack_in_scans_list_without_network() {
        let empty = find_provider_pack_in(&[], "ggml-master", "frontier");
        assert!(empty.is_none());

        let release = GitHubRelease {
            tag_name: "v1.0.99".into(),
            body: None,
            assets: vec![ReleaseAsset {
                name: "CORE_ggml-master-frontier.7z".into(),
                download_url: "https://example.invalid/x.7z".into(),
                size: 42,
            }],
        };
        let hit = find_provider_pack_in(&[release], "ggml-master", "frontier");
        assert_eq!(hit, Some(("v1.0.99".into(), 42)));
        let miss = find_provider_pack_in(
            &[GitHubRelease {
                tag_name: "v1.0.99".into(),
                body: None,
                assets: vec![],
            }],
            "ds4",
            "frontier",
        );
        assert!(miss.is_none());
    }

    #[test]
    fn cache_file_sanitizes_url() {
        let url =
            "https://api.github.com/repos/Seen-Tomorrow/blackwell-ops/releases?per_page=40";
        let file = github_cache_file(url);
        let name = file
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap()
            .to_string();
        // No path/query chars leak into the on-disk filename.
        assert!(!name.contains('/'));
        assert!(!name.contains('?'));
        assert!(!name.contains('='));
        assert!(name.starts_with("gh_"));
        // Distinct URLs (per_page) must not collide on the same cache file.
        let url2 =
            "https://api.github.com/repos/Seen-Tomorrow/blackwell-ops/releases?per_page=50";
        assert_ne!(github_cache_file(url), github_cache_file(url2));
    }

    #[test]
    fn budget_reaches_zero_at_cap() {
        // Saturating: once BUDGET_MAX_PER_HOUR calls are recorded in the window,
        // remaining reports 0 regardless of any pre-existing entries.
        for _ in 0..BUDGET_MAX_PER_HOUR {
            budget_record();
        }
        assert_eq!(budget_remaining(), 0);
    }

    #[test]
    fn cache_round_trip_persists_body_and_etag() {
        // Fixed test-only URL (never used by the app) so the on-disk file is stable
        // across runs and can be cleaned up.
        let url =
            "https://api.github.com/repos/test/blackwell-ops-test/__cache_round_trip__";
        let path = github_cache_file(url);
        let entry = GitHubCacheEntry {
            fetched_at: now_unix_secs(),
            etag: Some("\"abc123\"".into()),
            body: serde_json::json!({ "tag_name": "v9.9.9" }),
        };
        write_github_cache(url, &entry);
        let read = read_github_cache(url).expect("cache entry should persist to disk");
        assert_eq!(read.etag.as_deref(), Some("\"abc123\""));
        assert_eq!(read.body["tag_name"], "v9.9.9");
        assert!(cache_age(&read) < Duration::from_secs(5));
        let _ = std::fs::remove_file(&path);
    }
}