//! Shared GitHub Releases API — channel manifests, App `.7z`, Full NSIS, engine packs, toolchain.
//!
//! Layout is frozen in `docs/RELEASE-CHANNELS.md`: rolling channel tags (`app`, `full`,
//! `engines`, `toolchain`) whose `channel.json` manifest is the only client interface. Asset
//! filenames are cosmetic — nothing in this module parses them.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use parking_lot::Mutex as PlMutex;
use std::time::{Duration, Instant};

use reqwest::RequestBuilder;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::release_channels::{
    EngineChannelManifest, ProductChannelManifest, MANIFEST_ASSET, TAG_APP, TAG_ENGINES, TAG_FULL,
};

pub const GITHUB_REPO: &str = "Seen-Tomorrow/blackwell-ops";

pub const CHANNEL_APP_ONLY: &str = "app_only";
pub const CHANNEL_FULL_BUNDLE: &str = "full_bundle";

/// NSIS core engine provider(s) — the seeded engine, overlaid by catalog packs.
pub fn is_core_engine_provider(provider_id: &str) -> bool {
    provider_id == crate::config::DEFAULT_PROVIDER_ID
}

#[derive(Debug, Clone)]
pub struct ReleaseAsset {
    pub name: String,
    pub download_url: String,
    pub size: u64,
    /// `assets[].digest` from the release API — `sha256:<hex>`, or `None` for an asset
    /// uploaded before GitHub started computing digests.
    pub digest: Option<String>,
}

/// A release asset selected for download, flattened out of its release.
///
/// Carries `digest` alongside the bytes so the download path can verify what it
/// fetched without a second round-trip (the digest already arrived in the same
/// cached release JSON).
#[derive(Debug, Clone)]
pub struct ResolvedAsset {
    pub download_url: String,
    pub name: String,
    pub release_tag: String,
    pub size: u64,
    pub digest: Option<String>,
    /// Channel version/build the asset belongs to (app semver, engine build id).
    pub version: Option<String>,
}

#[derive(Debug, Clone)]
pub struct GitHubRelease {
    pub tag_name: String,
    pub assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    let assets = body
        .get("assets")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| {
                    let name = a.get("name")?.as_str()?.to_string();
                    let download_url = a.get("browser_download_url")?.as_str()?.to_string();
                    let size = a.get("size").and_then(|s| s.as_u64()).unwrap_or(0);
                    let digest = a
                        .get("digest")
                        .and_then(|d| d.as_str())
                        .map(String::from);
                    Some(ReleaseAsset {
                        name,
                        download_url,
                        size,
                        digest,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Some(GitHubRelease { tag_name, assets })
}

// ── Single GitHub REST gateway ─────────────────────────────────────────────
// Every api.github.com call goes through `github_get_json_cached`: persistent
// disk cache (survives rebuilds/restarts) + ETag/304 + per-URL single-flight +
// a short force-dedup window + an hourly budget. This is what keeps call volume
// sane — the old in-memory-only cache was wiped on every restart, so 100 rebuilds
// per day re-hit the API 100 times.

/// TTLs per resource class. The releases list is shared by every pack/offering check.
/// Channel tags change on every ship; 10 min keeps a post-ship refresh snappy while a
/// background check does not hit the API at poll rate. `force` bypasses it.
const CHANNEL_TAG_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
/// `channel.json` content cache. Separate from the tag cache: a manifest can be replaced
/// (rollback) without the tag/release metadata changing.
const CHANNEL_MANIFEST_TTL: Duration = Duration::from_secs(5 * 60);
const LATEST_TAG_CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// `force` re-fetches issued within this window share one round-trip (the Updates tab
/// fires 3 parallel force calls; without this they'd be 3 separate API hits).
const FORCE_DEDUP_WINDOW: Duration = Duration::from_secs(60);
/// Hard hourly cap on real API calls. Background (non-force) fetches serve stale cache
/// once we're within 2 of the cap; user-initiated force fetches always proceed.
const BUDGET_MAX_PER_HOUR: usize = 45;
/// A failed fetch is not cached by GitHub, so without this every poll (5-15 s) retried it.
/// Ordinary failures back off 10 minutes; 403/429 rate limits back off 15 minutes.
const FAILURE_BACKOFF: Duration = Duration::from_secs(10 * 60);
const RATE_LIMIT_BACKOFF: Duration = Duration::from_secs(15 * 60);

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
    /// url -> (failed_at, cooldown, message): suppress retries of a known-bad endpoint.
    failures: HashMap<String, (Instant, Duration, String)>,
}

static GATEWAY_MEM: LazyLock<PlMutex<GatewayMem>> = LazyLock::new(|| {
    PlMutex::new(GatewayMem {
        locks: HashMap::new(),
        recent: HashMap::new(),
        budget: Vec::new(),
        failures: HashMap::new(),
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

    // 3b. Failure cooldown: a URL that just failed (offline, 403, 429) must not be retried
    // at poll rate. Serve stale cache when we have one; otherwise fail fast.
    {
        let g = GATEWAY_MEM.lock();
        if let Some((at, cooldown, msg)) = g.failures.get(&url) {
            if at.elapsed() < *cooldown {
                if let Some(e) = read_github_cache(&url) {
                    dev_github_log("[github] FAILURE COOLDOWN — serving stale cache");
                    return Ok(e.body);
                }
                return Err(format!("{msg} (retry later)"));
            }
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
        match github_get_json_conditional(&url, prior.as_ref().and_then(|e| e.etag.clone())).await {
            Ok(v) => v,
            Err(e) => {
                let lower = e.to_ascii_lowercase();
                let cooldown = if e.contains("403")
                    || e.contains("429")
                    || lower.contains("rate limit")
                {
                    RATE_LIMIT_BACKOFF
                } else {
                    FAILURE_BACKOFF
                };
                {
                    let mut g = GATEWAY_MEM.lock();
                    g.failures.insert(url.clone(), (Instant::now(), cooldown, e.clone()));
                }
                if let Some(entry) = prior {
                    dev_github_log(&format!(
                        "[github] LIVE FAILED ({e}) — serving stale cache"
                    ));
                    return Ok(entry.body);
                }
                return Err(e);
            }
        };

    // 6. Persist: 200 → new body+etag; 304 → prior body, refreshed TTL.
    let entry = GitHubCacheEntry {
        fetched_at: now_unix_secs(),
        etag: new_etag.or_else(|| prior.and_then(|e| e.etag)),
        body: body.clone(),
    };
    write_github_cache(&url, &entry);
    {
        let mut g = GATEWAY_MEM.lock();
        g.failures.remove(&url);
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

/// One release by tag. Channel tags are rolling, so the response is cached briefly.
pub async fn fetch_release_by_tag(tag: &str) -> Result<GitHubRelease, String> {
    fetch_release_by_tag_ex(tag, false).await
}

pub async fn fetch_release_by_tag_ex(tag: &str, force: bool) -> Result<GitHubRelease, String> {
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases/tags/{tag}");
    let body = github_get_json_cached(&url, CHANNEL_TAG_CACHE_TTL, force).await?;
    parse_release(&body).ok_or_else(|| format!("Invalid release payload for tag '{tag}'"))
}

/// Fetch and parse `<tag>/channel.json` — the only way the client learns about artifacts.
async fn fetch_channel_manifest_value(
    tag: &str,
    force: bool,
) -> Result<(GitHubRelease, serde_json::Value), String> {
    if !crate::release_channels::has_tag(tag) {
        return Err(format!(
            "'{tag}' is not a release channel — see src-tauri/release-channels.json"
        ));
    }
    let release = fetch_release_by_tag_ex(tag, force).await?;
    let asset = find_asset_by_name(&release, MANIFEST_ASSET).ok_or_else(|| {
        format!("Channel '{tag}' has no {MANIFEST_ASSET} — publish it with the release tool")
    })?;
    let body = fetch_asset_json(&asset.download_url, force).await?;
    Ok((release, body))
}

pub async fn fetch_product_manifest(
    tag: &str,
    force: bool,
) -> Result<ProductChannelManifest, String> {
    let (_release, body) = fetch_channel_manifest_value(tag, force).await?;
    let manifest: ProductChannelManifest = serde_json::from_value(body)
        .map_err(|e| format!("Channel '{tag}': invalid {MANIFEST_ASSET}: {e}"))?;
    manifest.validate(tag)?;
    Ok(manifest)
}

pub async fn fetch_engine_manifest(force: bool) -> Result<EngineChannelManifest, String> {
    let (_release, body) = fetch_channel_manifest_value(TAG_ENGINES, force).await?;
    let manifest: EngineChannelManifest = serde_json::from_value(body)
        .map_err(|e| format!("Channel '{TAG_ENGINES}': invalid {MANIFEST_ASSET}: {e}"))?;
    manifest.validate(TAG_ENGINES)?;
    Ok(manifest)
}

/// Fetch a release-asset JSON. Deliberately unauthenticated: release downloads redirect to a
/// signed object URL, and an Authorization header there is rejected. Disk-cached; `force`
/// bypasses the TTL.
async fn fetch_asset_json(url: &str, force: bool) -> Result<serde_json::Value, String> {
    if !force {
        if let Some(entry) = read_github_cache(url) {
            if cache_age(&entry) < CHANNEL_MANIFEST_TTL {
                return Ok(entry.body);
            }
        }
    }
    let resp = GITHUB_CLIENT
        .get(url)
        .header("User-Agent", "Blackwell-Ops")
        .send()
        .await
        .map_err(|e| format!("Failed to download {url}: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("Download returned {status} for {url}"));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse {url}: {e}"))?;
    write_github_cache(
        url,
        &GitHubCacheEntry {
            fetched_at: now_unix_secs(),
            etag: None,
            body: body.clone(),
        },
    );
    Ok(body)
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

/// Latest published release notes for a provider's upstream repo (FOUNDRY changelog).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoReleaseNotes {
    pub repo: String,
    pub tag: String,
    pub name: String,
    pub html_url: String,
    pub body: String,
    pub published_at: String,
}

/// Latest release (tag/name/Markdown body/html_url) for an arbitrary GitHub repo.
/// Shares the cached api.github.com gateway; no token is required for public repos.
pub async fn fetch_repo_latest_release(repo: &str) -> Result<RepoReleaseNotes, String> {
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let body = github_get_json_cached(&url, LATEST_TAG_CACHE_TTL, false).await?;
    let tag = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("No tag_name in latest release for {repo}"))?
        .to_string();
    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&tag)
        .to_string();
    let html_url = body
        .get("html_url")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| format!("https://github.com/{repo}/releases"));
    let release_body = body
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let published_at = body
        .get("published_at")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    Ok(RepoReleaseNotes {
        repo: repo.to_string(),
        tag,
        name,
        html_url,
        body: release_body,
        published_at,
    })
}

pub fn find_asset_by_name(release: &GitHubRelease, name: &str) -> Option<ReleaseAsset> {
    release
        .assets
        .iter()
        .find(|a| a.name == name)
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

fn offering_text(channel: &str) -> (&'static str, &'static str) {
    match channel {
        CHANNEL_APP_ONLY => (
            "App update",
            "Portable UI + templates (~few MB) - keeps your engines",
        ),
        _ => (
            "Full install",
            "Setup: app + pre-built CUDA engines — first install or engine refresh",
        ),
    }
}

fn empty_offering(channel: &str) -> UpdateChannelOffering {
    let (label, summary) = offering_text(channel);
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

/// Build an offering from a channel manifest. Only a strictly newer version is offered: the
/// old "no engines → offer an older Full setup" path is gone (engines come from `engines`).
fn offering_from_manifest(
    channel: &str,
    tag: &str,
    manifest: &ProductChannelManifest,
    current_version: &str,
) -> UpdateChannelOffering {
    let latest = &manifest.latest;
    if !version_gt(&latest.version, current_version) {
        return empty_offering(channel);
    }
    let (label, summary) = offering_text(channel);
    UpdateChannelOffering {
        channel: channel.to_string(),
        available: true,
        version: latest.version.clone(),
        tag: tag.to_string(),
        size_bytes: latest.size_bytes,
        label: label.to_string(),
        summary: summary.to_string(),
        release_notes: latest.notes.clone(),
    }
}

/// Read the `app` and `full` manifests and build the two update offerings.
pub async fn fetch_update_offerings(current_version: &str) -> Result<UpdateOfferings, String> {
    fetch_update_offerings_ex(current_version, false).await
}

pub async fn fetch_update_offerings_ex(
    current_version: &str,
    force: bool,
) -> Result<UpdateOfferings, String> {
    let app_manifest = fetch_product_manifest(TAG_APP, force).await;
    let full_manifest = fetch_product_manifest(TAG_FULL, force).await;
    if let (Err(app_err), Err(_)) = (&app_manifest, &full_manifest) {
        return Err(app_err.clone());
    }

    let app_only = match &app_manifest {
        Ok(m) => offering_from_manifest(CHANNEL_APP_ONLY, TAG_APP, m, current_version),
        Err(e) => {
            log::warn!("[app-update] app channel unavailable: {e}");
            empty_offering(CHANNEL_APP_ONLY)
        }
    };
    let full_bundle = match &full_manifest {
        Ok(m) => offering_from_manifest(CHANNEL_FULL_BUNDLE, TAG_FULL, m, current_version),
        Err(e) => {
            log::warn!("[app-update] full channel unavailable: {e}");
            empty_offering(CHANNEL_FULL_BUNDLE)
        }
    };

    let recommended = if app_only.available {
        CHANNEL_APP_ONLY.to_string()
    } else if full_bundle.available {
        CHANNEL_FULL_BUNDLE.to_string()
    } else {
        "none".to_string()
    };

    let any_available = app_only.available || full_bundle.available;
    Ok(UpdateOfferings {
        current_version: current_version.to_string(),
        engines_available: crate::profile_binaries::launch_engines_available(),
        app_only,
        full_bundle,
        recommended,
        any_available,
    })
}

fn channel_tag_for(channel: &str) -> Result<&'static str, String> {
    match channel {
        CHANNEL_APP_ONLY => Ok(TAG_APP),
        CHANNEL_FULL_BUNDLE => Ok(TAG_FULL),
        other => Err(format!("Unknown update channel: {other}")),
    }
}

/// Resolve the installer named by a channel manifest to a download URL + pinned digest.
pub async fn resolve_installer_asset_for_version(
    channel: &str,
    _current_version: &str,
) -> Result<ResolvedAsset, String> {
    let tag = channel_tag_for(channel)?;
    let manifest = fetch_product_manifest(tag, false).await?;
    let latest = &manifest.latest;
    let release = fetch_release_by_tag(tag).await?;
    let asset = find_asset_by_name(&release, &latest.asset).ok_or_else(|| {
        format!(
            "Channel '{tag}' lists '{}' but the release has no such asset",
            latest.asset
        )
    })?;

    Ok(ResolvedAsset {
        download_url: asset.download_url,
        name: asset.name,
        release_tag: tag.to_string(),
        size: asset.size.max(latest.size_bytes),
        digest: Some(latest.sha256.clone()),
        version: Some(latest.version.clone()),
    })
}

/// Resolve an engine pack.
///
/// The `engines` channel manifest is authoritative: an engine can be published at any time,
/// independent of an app build. The embedded `engines.json` is the build-time record and the
/// **offline/repair fallback** — if the channel cannot be read, the pack this build pins by
/// name and digest is still installable.
pub async fn resolve_provider_pack_asset(
    provider_id: &str,
    profile: &str,
) -> Result<ResolvedAsset, String> {
    let release = match fetch_release_by_tag(TAG_ENGINES).await {
        Ok(r) => Some(r),
        Err(e) => {
            log::warn!("[engine-pack] '{TAG_ENGINES}' release unavailable: {e}");
            None
        }
    };
    let manifest = match fetch_engine_manifest(false).await {
        Ok(m) => Some(m),
        Err(e) => {
            log::warn!("[engine-pack] '{TAG_ENGINES}' manifest unavailable: {e}");
            None
        }
    };

    if let (Some(manifest), Some(release)) = (manifest.as_ref(), release.as_ref()) {
        let entry = manifest.entry(provider_id, profile).ok_or_else(|| {
            format!(
                "Engine {provider_id}/{profile} is not published on the '{TAG_ENGINES}' channel."
            )
        })?;
        if let Some(def) = crate::engine_packs::engine_pack(provider_id, profile) {
            if def.asset != entry.asset {
                log::info!(
                    "[engine-pack] {provider_id}/{profile}: channel has {} (build {}), \
                     build-time record has {} — using the channel",
                    entry.asset,
                    entry.build,
                    def.asset
                );
            }
        }
        let asset = find_asset_by_name(release, &entry.asset).ok_or_else(|| {
            format!(
                "Channel '{TAG_ENGINES}' lists '{}' but the release has no such asset",
                entry.asset
            )
        })?;
        return Ok(ResolvedAsset {
            download_url: asset.download_url,
            name: asset.name,
            release_tag: TAG_ENGINES.to_string(),
            size: asset.size.max(entry.size_bytes),
            digest: Some(entry.sha256.clone()),
            version: Some(entry.build.clone()),
        });
    }

    // Offline / repair fallback: the digests compiled into this build.
    let def = crate::engine_packs::engine_pack(provider_id, profile).ok_or_else(|| {
        format!(
            "Engine {provider_id}/{profile}: the '{TAG_ENGINES}' channel is unavailable and this \
             build pins no pack for it."
        )
    })?;
    let release = release.ok_or_else(|| {
        format!("Engine {provider_id}/{profile}: the '{TAG_ENGINES}' release is unavailable")
    })?;
    log::info!(
        "[engine-pack] fallback to build-time pin {} ({}) for {provider_id}/{profile}",
        def.asset,
        def.label
    );
    let asset = find_asset_by_name(&release, &def.asset).ok_or_else(|| {
        format!(
            "Engine pack '{}' for {provider_id}/{profile} is no longer published",
            def.asset
        )
    })?;

    Ok(ResolvedAsset {
        download_url: asset.download_url,
        name: asset.name,
        release_tag: TAG_ENGINES.to_string(),
        size: asset.size.max(def.size_bytes),
        digest: Some(def.sha256.clone()),
        version: Some(def.build.clone()),
    })
}

/// Directory for cached app update downloads (resume-capable via download manager).
pub fn app_update_cache_dir() -> PathBuf {
    crate::config::cache_dir().join("app-updates")
}

pub fn provider_pack_cache_dir() -> PathBuf {
    crate::config::cache_dir().join("provider-packs")
}

/// Launch a downloaded Full Bundle NSIS installer for silent in-place upgrade.
///
/// Must NOT spawn the Setup while this process still holds `blackwell-ops.exe` open.
/// Tauri's CheckIfAppIsRunning kills/aborts under `/S` when the app is live, which is
/// exactly the race `schedule_app_exit(3)` used to create: download finishes, installer
/// starts, app still running → silent Abort → user sees "downloaded, never installed".
///
/// Pattern matches App `.7z` apply: write a helper that waits for our PID, then runs
/// Setup with `/S /UPDATE /R` and **`/D=<app_root>` last** (NSIS requires `/D=` last and
/// unquoted so paths with spaces like `Blackwell OPS portable` still work). Without `/D=`,
/// a pure portable tree with no registry entry installs to the default folder and the
/// folder the user is actually running never changes.
pub fn launch_nsis_installer(installer_path: &Path, app_handle: &tauri::AppHandle) -> Result<(), String> {
    if !installer_path.is_file() {
        return Err(format!(
            "NSIS installer not found: {}",
            installer_path.display()
        ));
    }

    let app_root = crate::config::app_root_dir();
    let pid = std::process::id();
    let cache = app_update_cache_dir();
    std::fs::create_dir_all(&cache)
        .map_err(|e| format!("Failed to create app update cache: {e}"))?;
    let helper = cache.join("apply-full-update.cmd");
    let log_path = cache.join("apply-full-update.log");

    // NSIS: /D= must be the last argument and must NOT be quoted.
    // Quote SETUP/LOG/paths that are not /D=.
    let helper_body = format!(
        "@echo off\r\n\
setlocal EnableExtensions\r\n\
set \"PID={pid}\"\r\n\
set \"SETUP={setup}\"\r\n\
set \"LOG={log}\"\r\n\
set \"DEST={dest}\"\r\n\
>>\"%LOG%\" echo [%DATE% %TIME%] Full NSIS helper start\r\n\
>>\"%LOG%\" echo [%DATE% %TIME%] waiting for app PID %PID%\r\n\
:waitloop\r\n\
tasklist /FI \"PID eq %PID%\" 2>NUL | find \"%PID%\" >NUL\r\n\
if not errorlevel 1 (\r\n\
  timeout /t 1 /nobreak >NUL\r\n\
  goto waitloop\r\n\
)\r\n\
timeout /t 1 /nobreak >NUL\r\n\
if not exist \"%SETUP%\" (\r\n\
  >>\"%LOG%\" echo [%DATE% %TIME%] ERROR setup missing: %SETUP%\r\n\
  exit /b 2\r\n\
)\r\n\
>>\"%LOG%\" echo [%DATE% %TIME%] launching NSIS /S /UPDATE /R /D=%DEST%\r\n\
rem /D= MUST be last and unquoted (NSIS parser). Spaces in DEST are intentional.\r\n\
rem Do not use `start` — it re-parses args and breaks /D= paths with spaces.\r\n\
\"%SETUP%\" /S /UPDATE /R /D=%DEST%\r\n\
set \"EC=%ERRORLEVEL%\"\r\n\
>>\"%LOG%\" echo [%DATE% %TIME%] NSIS exit code %EC%\r\n\
if not \"%EC%\"==\"0\" exit /b %EC%\r\n\
>>\"%LOG%\" echo [%DATE% %TIME%] done\r\n\
endlocal\r\n\
exit /b 0\r\n",
        pid = pid,
        setup = installer_path.display(),
        log = log_path.display(),
        dest = app_root.display(),
    );
    std::fs::write(&helper, helper_body)
        .map_err(|e| format!("Failed to write Full install helper: {e}"))?;

    log::info!(
        "[app-update] Scheduling Full NSIS after exit via {} → {} (log: {})",
        helper.display(),
        installer_path.display(),
        log_path.display()
    );
    spawn_silent_cmd_script(&helper)?;
    schedule_app_exit(app_handle, 1);
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

/// Replace `app_root/foundry/patches` from a staged App update payload.
///
/// Full replace, never a merge: a vendor patch that was renamed or retired upstream must
/// not survive in the install, or Foundry keeps applying a stale diff against a moved tree
/// (and an empty patch set builds *unpatched* silently — SSE fusion then falls back to
/// polling). Returns the number of `*.patch` files installed; `0` means the archive carried
/// none, and the existing directory is left untouched.
fn install_foundry_patches_from_payload(payload: &Path, app_root: &Path) -> Result<usize, String> {
    let staged = payload.join("foundry").join("patches");
    if !staged.is_dir() {
        return Ok(0);
    }

    let mut patches = 0usize;
    for entry in std::fs::read_dir(&staged)
        .map_err(|e| format!("read staged foundry patches {}: {e}", staged.display()))?
    {
        let entry = entry.map_err(|e| format!("staged foundry patch entry: {e}"))?;
        if entry.path().extension().and_then(|x| x.to_str()) == Some("patch") {
            patches += 1;
        }
    }
    if patches == 0 {
        return Ok(0);
    }

    let dest = app_root.join("foundry").join("patches");
    if dest.exists() {
        std::fs::remove_dir_all(&dest).map_err(|e| {
            format!(
                "Failed to clear {} before foundry patch update: {e}",
                dest.display()
            )
        })?;
    }
    copy_dir_recursive(&staged, &dest)?;
    Ok(patches)
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

    // Plugin metadata ships at app/runtime-catalog/ (same tree as engine overlays).
    let catalog_src = payload.join("runtime-catalog");
    if catalog_src.join("plugins.json").is_file() {
        let catalog_dst = app_root.join("runtime-catalog");
        crate::archive_util::copy_dir_merge(&catalog_src, &catalog_dst)?;
        log::info!(
            "[app-update] Merged plugin catalog -> {}",
            catalog_dst.display()
        );
    } else {
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

    // Foundry vendor patches. The App archive carries the product patch set (the same
    // files NSIS stages as a resource), but an app-only update never reached app-root
    // patches otherwise: they stayed frozen at installer vintage, so a rebased/renamed
    // patch never shipped and Foundry kept applying the stale one. Replace wholesale.
    match install_foundry_patches_from_payload(&payload, &app_root) {
        Ok(0) => log::warn!(
            "[app-update] App archive has no foundry/patches/*.patch — installed vendor patches left untouched"
        ),
        Ok(n) => log::info!("[app-update] Replaced foundry/patches ({n} vendor patch(es))"),
        Err(e) => return Err(e),
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
    fn version_gt_is_numeric_per_part() {
        assert!(version_gt("1.1.13", "1.1.9"));
        assert!(version_gt("1.2.0", "1.1.99"));
        assert!(!version_gt("1.1.13", "1.1.13"));
        assert!(!version_gt("1.1.9", "1.1.13"));
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
    fn offering_requires_a_strictly_newer_version() {
        let manifest: ProductChannelManifest = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "channel": "app",
            "latest": {
                "version": "1.1.13",
                "asset": "APP_UPDATE_Blackwell-Ops-v1.1.13.7z",
                "sizeBytes": 1024,
                "sha256": "c".repeat(64),
                "notes": "notes"
            },
            "releases": []
        }))
        .unwrap();

        let newer = offering_from_manifest(CHANNEL_APP_ONLY, TAG_APP, &manifest, "1.1.12");
        assert!(newer.available);
        assert_eq!(newer.version, "1.1.13");
        assert_eq!(newer.tag, TAG_APP);
        assert_eq!(newer.release_notes.as_deref(), Some("notes"));

        // Same version and a downgrade are both "no update" — the old need-engines path that
        // offered an older Full setup is gone.
        assert!(!offering_from_manifest(CHANNEL_APP_ONLY, TAG_APP, &manifest, "1.1.13").available);
        assert!(!offering_from_manifest(CHANNEL_APP_ONLY, TAG_APP, &manifest, "1.2.0").available);
    }

    #[test]
    fn channel_manifest_must_name_a_real_asset() {
        let empty = empty_offering(CHANNEL_APP_ONLY);
        assert!(!empty.available);
        assert!(empty.version.is_empty());

        let manifest = fetch_manifest_fixture();
        let release = GitHubRelease {
            tag_name: TAG_APP.into(),
            assets: vec![],
        };
        assert!(find_asset_by_name(&release, &manifest.latest.asset).is_none());
    }

    fn fetch_manifest_fixture() -> ProductChannelManifest {
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "channel": "app",
            "latest": {
                "version": "1.1.13",
                "asset": "APP_UPDATE_Blackwell-Ops-v1.1.13.7z",
                "sizeBytes": 1024,
                "sha256": "d".repeat(64)
            }
        }))
        .unwrap()
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

    fn patch_fixture(tag: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "bw-foundry-pat-{tag}-{}-{}",
            std::process::id(),
            now_unix_secs()
        ));
        let payload = root.join("payload");
        let app = root.join("app");
        std::fs::create_dir_all(payload.join("foundry").join("patches")).unwrap();
        std::fs::create_dir_all(app.join("foundry").join("patches")).unwrap();
        (root, payload, app)
    }

    #[test]
    fn app_update_replaces_foundry_patches_wholesale() {
        let (root, payload, app) = patch_fixture("replace");
        let installed = app.join("foundry").join("patches");
        let staged = payload.join("foundry").join("patches");
        std::fs::write(installed.join("retired.patch"), "old").unwrap();
        std::fs::write(installed.join("extra.patch"), "old").unwrap();
        std::fs::write(staged.join("current.patch"), "new").unwrap();

        let n = install_foundry_patches_from_payload(&payload, &app).unwrap();

        assert_eq!(n, 1);
        // Full replace: every previously installed file must be gone, not merged over.
        assert!(!installed.join("retired.patch").exists());
        assert!(!installed.join("extra.patch").exists());
        assert_eq!(
            std::fs::read_to_string(installed.join("current.patch")).unwrap(),
            "new"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn app_update_without_patches_keeps_installed_set() {
        let (root, payload, app) = patch_fixture("none");
        let installed = app.join("foundry").join("patches");
        std::fs::write(installed.join("installed.patch"), "kept").unwrap();
        // A staged dir with no *.patch is "nothing to install", not "wipe the set".
        std::fs::write(
            payload.join("foundry").join("patches").join("readme.txt"),
            "x",
        )
        .unwrap();

        let n = install_foundry_patches_from_payload(&payload, &app).unwrap();

        assert_eq!(n, 0);
        assert_eq!(
            std::fs::read_to_string(installed.join("installed.patch")).unwrap(),
            "kept"
        );
        std::fs::remove_dir_all(&root).ok();
    }
}