//! Pure-Rust Hugging Face Xet CAS delta-update client.
//!
//! Replaces the legacy metadata-only GGUF header shifter with true chunk-level
//! delta reconstruction backed by Hugging Face's Content Addressable Storage (Xet).
//!
//! How it works (zero duplicate chunk cache on disk — the local `.gguf` IS the store):
//! 1. Resolve `X-Xet-Hash` via no-redirect `HEAD` on HF `resolve/main/<path>`.
//! 2. Fetch a short-lived `xet-read-token` (`{ casUrl, accessToken, exp }`) for the repo.
//! 3. Fetch the remote file's reconstruction recipe (`GET /v1/reconstructions/<xet_hash>`),
//!    which lists ordered `(xorb_hash, chunk_range, unpacked_length)` terms and signed
//!    CloudFront CDN byte-range URLs (`fetch_info`).
//! 4. Match against the local file's existing recipe (from `config/cache/xet_recipes.json`,
//!    or discovered automatically from recent repo commits for pre-existing files on disk).
//! 5. Copy every unchanged term directly from the local file on disk (0 network bytes),
//!    download only the changed compressed Xorb ranges in parallel (LZ4 / BG4-LZ4),
//!    verify final SHA-256 against the remote LFS OID, and atomically swap into place.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::output_console::{
    emit_blackwell_output_console_utils_line, BlackwellOutputConsoleLineStyle,
};

const MAX_CONCURRENT_XORB_FETCHES: usize = 6;
const MAX_RECIPE_CACHE_ENTRIES: usize = 250;

fn xet_log(msg: impl AsRef<str>, style: BlackwellOutputConsoleLineStyle) {
    let msg = msg.as_ref();
    log::info!("{msg}");
    emit_blackwell_output_console_utils_line(msg, style);
}

fn fmt_bytes(n: u64) -> String {
    const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MIB: f64 = 1024.0 * 1024.0;
    const KIB: f64 = 1024.0;
    let f = n as f64;
    if f >= GIB {
        format!("{:.2} GiB", f / GIB)
    } else if f >= MIB {
        format!("{:.2} MiB", f / MIB)
    } else if f >= KIB {
        format!("{:.1} KiB", f / KIB)
    } else {
        format!("{n} B")
    }
}

// ── Wire / CAS types ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkRange {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReconstructionTerm {
    pub hash: String,
    pub unpacked_length: u64,
    pub range: ChunkRange,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FetchRangeInfo {
    pub range: ChunkRange,
    pub url: String,
    pub url_range: ByteRange,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReconstructionResponse {
    #[serde(default)]
    pub offset_into_first_range: u64,
    pub terms: Vec<ReconstructionTerm>,
    #[serde(default)]
    pub fetch_info: HashMap<String, Vec<FetchRangeInfo>>,
}

#[derive(Debug, Clone, Deserialize)]
struct XetReadTokenResponse {
    #[serde(rename = "casUrl")]
    cas_url: String,
    #[serde(rename = "accessToken")]
    access_token: String,
    exp: u64,
}

/// Result returned to the frontend for a Xet delta update attempt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XetDeltaReport {
    /// `"already_current"` | `"updated"` | `"fallback_full"`
    pub status: String,
    /// Compressed bytes actually fetched over the network.
    pub bytes_downloaded: u64,
    /// Uncompressed bytes reused straight from the local file on disk.
    pub bytes_reused: u64,
    /// Final file size in bytes.
    pub total_bytes: u64,
    /// True when final SHA-256 matched the expected remote LFS OID.
    pub sha256_verified: bool,
    /// Human-readable reason when `status == "fallback_full"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

// ── In-memory xet-read-token cache (per repo + revision) ────────────────────

#[derive(Clone)]
struct CachedToken {
    cas_url: String,
    access_token: String,
    exp: u64,
}

fn token_cache() -> &'static Mutex<HashMap<String, CachedToken>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedToken>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn hf_auth_header() -> Option<String> {
    let token = crate::secrets::get_secret("hf_token").ok().flatten()?;
    let trimmed = token.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(format!("Bearer {trimmed}"))
    }
}

fn build_http_client(follow_redirects: bool) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(120));
    if !follow_redirects {
        b = b.redirect(reqwest::redirect::Policy::none());
    }
    b.build().map_err(|e| format!("HTTP client error: {e}"))
}

/// Extract `(repo_id, revision, path_in_repo)` from a standard HF resolve URL.
pub fn parse_hf_resolve_url(url: &str) -> Option<(String, String, String)> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    if !matches!(
        host.as_str(),
        "huggingface.co" | "www.huggingface.co" | "hf.co" | "www.hf.co"
    ) {
        return None;
    }
    let segs: Vec<&str> = parsed.path_segments()?.filter(|s| !s.is_empty()).collect();
    let resolve_idx = segs.iter().position(|&s| s == "resolve")?;
    if resolve_idx < 2 || segs.len() <= resolve_idx + 2 {
        return None;
    }
    let repo_id = segs[..resolve_idx].join("/");
    let revision = segs[resolve_idx + 1].to_string();
    let path_in_repo = segs[resolve_idx + 2..].join("/");
    Some((repo_id, revision, path_in_repo))
}

/// Resolve `X-Xet-Hash` via a no-redirect HEAD request on a Hugging Face resolve URL.
/// Returns `Ok(None)` if the file is not backed by Xet (legacy LFS).
async fn resolve_xet_hash(url: &str) -> Result<Option<String>, String> {
    let client = build_http_client(false)?;
    let mut req = client.head(url);
    if let Some(auth) = hf_auth_header() {
        req = req.header(reqwest::header::AUTHORIZATION, auth);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("HEAD {url} failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() && !status.is_redirection() {
        return Err(format!("HEAD {url} returned HTTP {status}"));
    }
    let hash = resp
        .headers()
        .get("x-xet-hash")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Ok(hash)
}

async fn fetch_xet_read_token(repo_id: &str, revision: &str) -> Result<CachedToken, String> {
    let key = format!("{repo_id}@{revision}");
    let now = now_unix_secs();
    if let Ok(guard) = token_cache().lock() {
        if let Some(cached) = guard.get(&key) {
            if cached.exp > now.saturating_add(60) {
                return Ok(cached.clone());
            }
        }
    }

    let url = format!("https://huggingface.co/api/models/{repo_id}/xet-read-token/{revision}");
    let client = build_http_client(true)?;
    let mut req = client.get(&url);
    if let Some(auth) = hf_auth_header() {
        req = req.header(reqwest::header::AUTHORIZATION, auth);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("xet-read-token request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "xet-read-token HTTP {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        ));
    }
    let parsed: XetReadTokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("xet-read-token JSON parse error: {e}"))?;
    let token = CachedToken {
        cas_url: parsed.cas_url.trim_end_matches('/').to_string(),
        access_token: parsed.access_token,
        exp: parsed.exp,
    };
    if let Ok(mut guard) = token_cache().lock() {
        guard.insert(key, token.clone());
    }
    Ok(token)
}

async fn fetch_reconstruction(
    token: &CachedToken,
    xet_hash: &str,
) -> Result<ReconstructionResponse, String> {
    let url = format!("{}/v1/reconstructions/{xet_hash}", token.cas_url);
    let client = build_http_client(true)?;
    let resp = client
        .get(&url)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", token.access_token),
        )
        .send()
        .await
        .map_err(|e| format!("CAS reconstruction request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "CAS reconstruction HTTP {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        ));
    }
    resp.json::<ReconstructionResponse>()
        .await
        .map_err(|e| format!("CAS reconstruction JSON parse error: {e}"))
}

// ── Xorb chunk decoding (Scheme 0 = None, 1 = LZ4 Frame, 2 = BG4 + LZ4) ─────

/// Reverse Xet's ByteGrouping4 transform: `[B0... | B1... | B2... | B3...]` → interleaved bytes.
pub(crate) fn bg4_ungroup(grouped: &[u8]) -> Vec<u8> {
    let n = grouped.len();
    let mut out = vec![0u8; n];
    let q = n / 4;
    let rem = n % 4;

    let mut offsets = [0usize; 4];
    let mut cur = 0usize;
    for g in 0..4 {
        offsets[g] = cur;
        cur += q + usize::from(g < rem);
    }

    for i in 0..q {
        let base = i * 4;
        out[base] = grouped[offsets[0] + i];
        out[base + 1] = grouped[offsets[1] + i];
        out[base + 2] = grouped[offsets[2] + i];
        out[base + 3] = grouped[offsets[3] + i];
    }
    for g in 0..rem {
        out[q * 4 + g] = grouped[offsets[g] + q];
    }
    out
}

/// Decode a sequence of serialized Xorb chunks from `raw_bytes`, starting at chunk index
/// `range_start`, and return the concatenated uncompressed bytes for chunks in
/// `[wanted_start, wanted_end)`.
pub(crate) fn decode_xorb_chunks(
    raw_bytes: &[u8],
    range_start: u32,
    wanted_start: u32,
    wanted_end: u32,
) -> Result<Vec<u8>, String> {
    if wanted_end <= wanted_start {
        return Ok(Vec::new());
    }
    if wanted_start < range_start {
        return Err(format!(
            "Xorb decode range underflow: wanted_start={wanted_start} < range_start={range_start}"
        ));
    }

    let mut cursor = 0usize;
    let mut chunk_idx = range_start;
    let mut out = Vec::new();

    while chunk_idx < wanted_end {
        if cursor + 8 > raw_bytes.len() {
            return Err(format!(
                "Truncated Xorb chunk header at chunk {chunk_idx} (offset {cursor}, len {})",
                raw_bytes.len()
            ));
        }
        let ver = raw_bytes[cursor];
        if ver != 0 {
            return Err(format!("Unsupported Xorb chunk header version {ver}"));
        }
        let comp_size = (raw_bytes[cursor + 1] as usize)
            | ((raw_bytes[cursor + 2] as usize) << 8)
            | ((raw_bytes[cursor + 3] as usize) << 16);
        let comp_type = raw_bytes[cursor + 4];
        let uncomp_size = (raw_bytes[cursor + 5] as usize)
            | ((raw_bytes[cursor + 6] as usize) << 8)
            | ((raw_bytes[cursor + 7] as usize) << 16);
        cursor += 8;

        if cursor + comp_size > raw_bytes.len() {
            return Err(format!(
                "Truncated Xorb chunk payload at chunk {chunk_idx} (need {comp_size}, left {})",
                raw_bytes.len() - cursor
            ));
        }
        let payload = &raw_bytes[cursor..cursor + comp_size];
        cursor += comp_size;

        if chunk_idx >= wanted_start {
            match comp_type {
                0 => {
                    if payload.len() != uncomp_size {
                        return Err(format!(
                            "Raw Xorb chunk size mismatch: payload={} header={uncomp_size}",
                            payload.len()
                        ));
                    }
                    out.extend_from_slice(payload);
                }
                1 => {
                    let mut dec = lz4_flex::frame::FrameDecoder::new(payload);
                    let mut buf = Vec::with_capacity(uncomp_size);
                    dec.read_to_end(&mut buf)
                        .map_err(|e| format!("LZ4 frame decode error at chunk {chunk_idx}: {e}"))?;
                    if buf.len() != uncomp_size {
                        return Err(format!(
                            "LZ4 chunk size mismatch at chunk {chunk_idx}: got {} expected {uncomp_size}",
                            buf.len()
                        ));
                    }
                    out.extend_from_slice(&buf);
                }
                2 => {
                    let mut dec = lz4_flex::frame::FrameDecoder::new(payload);
                    let mut grouped = Vec::with_capacity(uncomp_size);
                    dec.read_to_end(&mut grouped)
                        .map_err(|e| format!("BG4-LZ4 decode error at chunk {chunk_idx}: {e}"))?;
                    if grouped.len() != uncomp_size {
                        return Err(format!(
                            "BG4-LZ4 chunk size mismatch at chunk {chunk_idx}: got {} expected {uncomp_size}",
                            grouped.len()
                        ));
                    }
                    let ungrouped = bg4_ungroup(&grouped);
                    out.extend_from_slice(&ungrouped);
                }
                other => {
                    return Err(format!("Unsupported Xorb compression type {other}"));
                }
            }
        }

        chunk_idx += 1;
    }

    Ok(out)
}

// ── Local Xet recipe cache (in-memory + persisted JSON, never blocks Tokio) ──

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedRecipeEntry {
    path: String,
    file_size: u64,
    mtime_secs: u64,
    xet_hash: String,
    terms: Vec<ReconstructionTerm>,
}

fn recipe_cache_path() -> PathBuf {
    crate::config::cache_dir().join("xet_recipes.json")
}

fn norm_path_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn file_meta_sig(path: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some((meta.len(), mtime))
}

static RECIPE_CACHE: OnceLock<Mutex<HashMap<String, CachedRecipeEntry>>> = OnceLock::new();

fn recipe_cache() -> &'static Mutex<HashMap<String, CachedRecipeEntry>> {
    RECIPE_CACHE.get_or_init(|| {
        let map = std::fs::read_to_string(recipe_cache_path())
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<CachedRecipeEntry>>(&s).ok())
            .unwrap_or_default()
            .into_iter()
            .map(|e| (e.path.clone(), e))
            .collect();
        Mutex::new(map)
    })
}

fn read_cached_recipe(path: &Path) -> Option<CachedRecipeEntry> {
    let (size, mtime) = file_meta_sig(path)?;
    let key = norm_path_key(path);
    let guard = recipe_cache().lock().ok()?;
    let entry = guard.get(&key)?;
    (entry.file_size == size && entry.mtime_secs == mtime).then(|| entry.clone())
}

fn write_cached_recipe(path: &Path, xet_hash: &str, terms: &[ReconstructionTerm]) {
    let Some((size, mtime)) = file_meta_sig(path) else {
        return;
    };
    let key = norm_path_key(path);
    let snapshot: Vec<CachedRecipeEntry> = {
        let Ok(mut guard) = recipe_cache().lock() else {
            return;
        };
        guard.insert(
            key.clone(),
            CachedRecipeEntry {
                path: key,
                file_size: size,
                mtime_secs: mtime,
                xet_hash: xet_hash.to_string(),
                terms: terms.to_vec(),
            },
        );
        while guard.len() > MAX_RECIPE_CACHE_ENTRIES {
            if let Some(oldest) = guard.keys().next().cloned() {
                guard.remove(&oldest);
            } else {
                break;
            }
        }
        guard.values().cloned().collect()
    };
    // Persist off the async executor so large JSON writes never stall UI IPC.
    std::thread::spawn(move || {
        let _ = crate::fs_util::write_json_atomic(&recipe_cache_path(), &snapshot);
    });
}

/// In-memory cache of dry-run estimates keyed by `(norm_path, size, mtime, new_xet_hash)`.
/// Prevents repeated commit-history probes when the user clicks Refresh twice.
static ESTIMATE_CACHE: OnceLock<Mutex<HashMap<(String, u64, u64, String), XetDeltaEstimate>>> =
    OnceLock::new();

fn estimate_cache() -> &'static Mutex<HashMap<(String, u64, u64, String), XetDeltaEstimate>> {
    ESTIMATE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Clear in-memory Xet recipe and dry-run estimate caches (used by DEV first-run reset).
#[cfg(debug_assertions)]
pub fn clear_in_memory_caches() {
    if let Ok(mut guard) = recipe_cache().lock() {
        guard.clear();
    }
    if let Ok(mut guard) = estimate_cache().lock() {
        guard.clear();
    }
}

/// Background hook called after a fresh HF download completes so future updates
/// already have the local file's Xet recipe cached (0 extra discovery calls).
pub async fn record_recipe_for_completed_download(dest_path: String, download_url: String) {
    let Some((repo_id, revision, _)) = parse_hf_resolve_url(&download_url) else {
        return;
    };
    let path = PathBuf::from(&dest_path);
    if !path.is_file() {
        return;
    }
    let Ok(Some(xet_hash)) = resolve_xet_hash(&download_url).await else {
        return;
    };
    let Ok(token) = fetch_xet_read_token(&repo_id, &revision).await else {
        return;
    };
    let Ok(rec) = fetch_reconstruction(&token, &xet_hash).await else {
        return;
    };
    write_cached_recipe(&path, &xet_hash, &rec.terms);
    log::info!(
        "[xet] cached recipe for {} ({} terms)",
        dest_path,
        rec.terms.len()
    );
}

// ── Pre-existing file discovery (find prior commit matching local size) ─────

#[derive(Deserialize)]
struct HfCommit {
    id: String,
}

/// Fetch recent commit SHAs for `repo_id` ONCE so multi-shard checks don't repeat it.
async fn fetch_repo_commits(repo_id: &str) -> Vec<String> {
    let commits_url = format!("https://huggingface.co/api/models/{repo_id}/commits/main?limit=50");
    let Ok(client) = build_http_client(true) else {
        return Vec::new();
    };
    let mut req = client.get(&commits_url);
    if let Some(auth) = hf_auth_header() {
        req = req.header(reqwest::header::AUTHORIZATION, auth);
    }
    let Ok(resp) = req.send().await else {
        return Vec::new();
    };
    if !resp.status().is_success() {
        return Vec::new();
    }
    resp.json::<Vec<HfCommit>>()
        .await
        .map(|v| v.into_iter().map(|c| c.id).collect())
        .unwrap_or_default()
}

/// For models that were already on disk before Xet recipe caching existed, inspect
/// recent commits of the repo in parallel (bounded concurrency) to find the exact
/// prior `X-Xet-Hash` matching the local file's size (and different from `new_xet_hash`).
async fn discover_prior_recipe_from_commits(
    repo_id: &str,
    path_in_repo: &str,
    local_size: u64,
    new_xet_hash: &str,
    token: &CachedToken,
    prefetched_commits: Option<&[String]>,
) -> Option<(String, Vec<ReconstructionTerm>)> {
    let owned_commits;
    let commits: &[String] = match prefetched_commits {
        Some(c) => c,
        None => {
            owned_commits = fetch_repo_commits(repo_id).await;
            &owned_commits
        }
    };
    if commits.len() <= 1 {
        return None;
    }
    let no_redir = build_http_client(false).ok()?;
    let auth = hf_auth_header();

    // Probe commits in small parallel waves (skipping commit[0] = HEAD), stopping on first match.
    for wave in commits[1..].iter().take(36).cloned().collect::<Vec<_>>().chunks(6) {
        let wave_owned: Vec<String> = wave.to_vec();
        let probes: Vec<Option<String>> = stream::iter(wave_owned)
            .map(|cid| {
                let client = no_redir.clone();
                let auth_c = auth.clone();
                let rev_url = format!("https://huggingface.co/{repo_id}/resolve/{cid}/{path_in_repo}");
                let new_h = new_xet_hash.to_string();
                async move {
                    let mut hreq = client.head(&rev_url);
                    if let Some(a) = auth_c {
                        hreq = hreq.header(reqwest::header::AUTHORIZATION, a);
                    }
                    let hresp = hreq.send().await.ok()?;
                    let old_hash = hresp
                        .headers()
                        .get("x-xet-hash")
                        .and_then(|v| v.to_str().ok())
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty() && s != &new_h)?;
                    let linked_size = hresp
                        .headers()
                        .get("x-linked-size")
                        .or_else(|| hresp.headers().get(reqwest::header::CONTENT_LENGTH))
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.parse::<u64>().ok());
                    if linked_size.is_some_and(|s| s != local_size) {
                        return None;
                    }
                    Some(old_hash)
                }
            })
            .buffer_unordered(6)
            .collect()
            .await;

        for old_hash in probes.into_iter().flatten() {
            if let Ok(old_rec) = fetch_reconstruction(token, &old_hash).await {
                let total: u64 = old_rec.terms.iter().map(|t| t.unpacked_length).sum();
                if total == local_size {
                    return Some((old_hash, old_rec.terms));
                }
            }
        }
    }
    None
}

// ── Term-level diff & delta reconstruction ──────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct TermKey {
    xorb_hash: String,
    start: u32,
    end: u32,
    unpacked_length: u64,
}

impl TermKey {
    fn from_term(t: &ReconstructionTerm) -> Self {
        Self {
            xorb_hash: t.hash.clone(),
            start: t.range.start,
            end: t.range.end,
            unpacked_length: t.unpacked_length,
        }
    }
}

/// Build lookup table from exact term identity → byte offset in the old local file.
fn index_local_terms(old_terms: &[ReconstructionTerm]) -> HashMap<TermKey, u64> {
    let mut map = HashMap::with_capacity(old_terms.len());
    let mut offset = 0u64;
    for t in old_terms {
        map.entry(TermKey::from_term(t)).or_insert(offset);
        offset += t.unpacked_length;
    }
    map
}

/// Find the `FetchRangeInfo` covering `[start, end)` for `xorb_hash`.
fn find_fetch_info<'a>(
    fetch_info: &'a HashMap<String, Vec<FetchRangeInfo>>,
    xorb_hash: &str,
    start: u32,
    end: u32,
) -> Option<&'a FetchRangeInfo> {
    fetch_info.get(xorb_hash)?.iter().find(|fi| {
        fi.range.start <= start && fi.range.end >= end
    })
}

/// Result of a lightweight Xet delta dry-run (0 weight bytes downloaded).
#[derive(Debug, Clone)]
pub struct XetDeltaEstimate {
    pub total_bytes: u64,
    pub reused_bytes: u64,
    pub fetch_bytes: u64,
    pub is_xet: bool,
}

/// Batched dry-run Xet delta estimate for multiple shards of the same repo.
/// Fetches the repo's Xet read-token and commit history ONCE, then estimates
/// shards concurrently (up to 4 at a time) so 16-shard models finish in seconds.
pub async fn estimate_xet_deltas_batch(
    repo_id: &str,
    items: &[(String, String)],
) -> Vec<Option<XetDeltaEstimate>> {
    if items.is_empty() {
        return Vec::new();
    }
    let token = fetch_xet_read_token(repo_id, "main").await.ok();
    let needs_commit_probe = items
        .iter()
        .any(|(p, _)| {
            let path = Path::new(p);
            path.is_file() && read_cached_recipe(path).is_none()
        });
    let commits: Option<Arc<Vec<String>>> = if needs_commit_probe {
        Some(Arc::new(fetch_repo_commits(repo_id).await))
    } else {
        None
    };

    let indexed: Vec<(usize, String, String)> = items
        .iter()
        .enumerate()
        .map(|(i, (p, u))| (i, p.clone(), u.clone()))
        .collect();

    let results: Vec<(usize, Option<XetDeltaEstimate>)> = stream::iter(indexed)
        .map(|(idx, p, u)| {
            let tok = token.clone();
            let com = commits.clone();
            async move {
                let est = estimate_xet_delta_with_context(
                    &p,
                    &u,
                    tok.as_ref(),
                    com.as_deref().map(|v| v.as_slice()),
                )
                .await;
                (idx, est)
            }
        })
        .buffer_unordered(4)
        .collect()
        .await;

    let mut out = vec![None; items.len()];
    for (idx, est) in results {
        out[idx] = est;
    }
    out
}

async fn estimate_xet_delta_with_context(
    local_path: &str,
    remote_url: &str,
    prefetched_token: Option<&CachedToken>,
    prefetched_commits: Option<&[String]>,
) -> Option<XetDeltaEstimate> {
    let path = Path::new(local_path);
    if !path.is_file() {
        return None;
    }
    let (repo_id, revision, path_in_repo) = parse_hf_resolve_url(remote_url)?;
    let (local_size, local_mtime) = file_meta_sig(path)?;

    let new_xet_hash = match resolve_xet_hash(remote_url).await.ok()? {
        Some(h) => h,
        None => {
            return Some(XetDeltaEstimate {
                total_bytes: local_size,
                reused_bytes: 0,
                fetch_bytes: local_size,
                is_xet: false,
            });
        }
    };

    let cache_key = (norm_path_key(path), local_size, local_mtime, new_xet_hash.clone());
    if let Ok(guard) = estimate_cache().lock() {
        if let Some(hit) = guard.get(&cache_key) {
            return Some(hit.clone());
        }
    }

    let owned_token;
    let token = match prefetched_token {
        Some(t) => t,
        None => {
            owned_token = fetch_xet_read_token(&repo_id, &revision).await.ok()?;
            &owned_token
        }
    };

    let local_recipe = match read_cached_recipe(path) {
        Some(cached) => Some((cached.xet_hash, cached.terms)),
        None => {
            let found = discover_prior_recipe_from_commits(
                &repo_id,
                &path_in_repo,
                local_size,
                &new_xet_hash,
                token,
                prefetched_commits,
            )
            .await;
            if let Some((ref old_hash, ref old_terms)) = found {
                write_cached_recipe(path, old_hash, old_terms);
            }
            found
        }
    };

    if let Some((ref old_hash, _)) = local_recipe {
        if old_hash == &new_xet_hash {
            let est = XetDeltaEstimate {
                total_bytes: local_size,
                reused_bytes: local_size,
                fetch_bytes: 0,
                is_xet: true,
            };
            if let Ok(mut guard) = estimate_cache().lock() {
                guard.insert(cache_key, est.clone());
            }
            return Some(est);
        }
    }

    let new_rec = fetch_reconstruction(token, &new_xet_hash).await.ok()?;
    let total_bytes: u64 = new_rec.terms.iter().map(|t| t.unpacked_length).sum();
    let local_index = local_recipe
        .as_ref()
        .map(|(_, terms)| index_local_terms(terms))
        .unwrap_or_default();

    let mut reused_bytes = 0u64;
    for term in &new_rec.terms {
        if local_index.contains_key(&TermKey::from_term(term)) {
            reused_bytes += term.unpacked_length;
        }
    }
    let fetch_bytes = total_bytes.saturating_sub(reused_bytes);
    let est = XetDeltaEstimate {
        total_bytes,
        reused_bytes,
        fetch_bytes,
        is_xet: true,
    };
    if let Ok(mut guard) = estimate_cache().lock() {
        guard.insert(cache_key, est.clone());
    }
    Some(est)
}

/// Live progress & cancellation hook for `xet_delta_update_with_progress`.
#[derive(Clone)]
pub struct XetProgressHook {
    /// Called with `(done_bytes, total_bytes, optional_status_message)`.
    pub on_progress: Arc<dyn Fn(u64, u64, Option<String>) + Send + Sync>,
    /// Returns `true` if the user cancelled the download.
    pub is_cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
    /// Returns `true` while the user has paused the download.
    pub is_paused: Arc<dyn Fn() -> bool + Send + Sync>,
}

/// Perform a Xet chunk-level delta update of `local_path` against `remote_url`,
/// with optional live progress & cancellation callbacks.
///
/// Reuses every matching Xorb term directly from `local_path` on disk and downloads
/// only the changed compressed chunks from Hugging Face CAS CDN.
pub async fn xet_delta_update_with_progress(
    local_path: &str,
    remote_url: &str,
    expected_sha256: Option<&str>,
    hook: Option<XetProgressHook>,
) -> Result<XetDeltaReport, String> {
    let path = Path::new(local_path);
    if !path.is_file() {
        return Ok(XetDeltaReport {
            status: "fallback_full".into(),
            bytes_downloaded: 0,
            bytes_reused: 0,
            total_bytes: 0,
            sha256_verified: false,
            reason: Some("Local file does not exist — full download required".into()),
        });
    }

    let Some((repo_id, revision, path_in_repo)) = parse_hf_resolve_url(remote_url) else {
        return Ok(XetDeltaReport {
            status: "fallback_full".into(),
            bytes_downloaded: 0,
            bytes_reused: 0,
            total_bytes: 0,
            sha256_verified: false,
            reason: Some("Not a Hugging Face resolve URL — using standard download".into()),
        });
    };

    xet_log(
        format!("[xet-delta] start  file={local_path}"),
        BlackwellOutputConsoleLineStyle::Highlight,
    );

    let Some(new_xet_hash) = resolve_xet_hash(remote_url).await? else {
        xet_log(
            "[xet-delta] remote file has no X-Xet-Hash (legacy LFS) — fallback to standard download",
            BlackwellOutputConsoleLineStyle::Warning,
        );
        return Ok(XetDeltaReport {
            status: "fallback_full".into(),
            bytes_downloaded: 0,
            bytes_reused: 0,
            total_bytes: 0,
            sha256_verified: false,
            reason: Some("Remote file is not Xet-backed".into()),
        });
    };

    let token = fetch_xet_read_token(&repo_id, &revision).await?;
    let local_size = std::fs::metadata(path)
        .map_err(|e| format!("Failed to stat local file: {e}"))?
        .len();

    // Load local recipe (cache first, else discover from recent repo commits).
    let local_recipe = match read_cached_recipe(path) {
        Some(cached) => Some((cached.xet_hash, cached.terms)),
        None => {
            xet_log(
                "[xet-delta] no local recipe cached yet — probing recent repo commits…",
                BlackwellOutputConsoleLineStyle::Normal,
            );
            let found = discover_prior_recipe_from_commits(
                &repo_id,
                &path_in_repo,
                local_size,
                &new_xet_hash,
                &token,
                None,
            )
            .await;
            if let Some((ref old_hash, ref old_terms)) = found {
                write_cached_recipe(path, old_hash, old_terms);
            }
            found
        }
    };

    if let Some((ref old_hash, _)) = local_recipe {
        if old_hash == &new_xet_hash {
            xet_log(
                "[xet-delta] X-Xet-Hash identical — already up to date",
                BlackwellOutputConsoleLineStyle::Success,
            );
            return Ok(XetDeltaReport {
                status: "already_current".into(),
                bytes_downloaded: 0,
                bytes_reused: local_size,
                total_bytes: local_size,
                sha256_verified: true,
                reason: None,
            });
        }
    }

    let new_rec = fetch_reconstruction(&token, &new_xet_hash).await?;
    let total_bytes: u64 = new_rec.terms.iter().map(|t| t.unpacked_length).sum();

    let local_index = local_recipe
        .as_ref()
        .map(|(_, terms)| index_local_terms(terms))
        .unwrap_or_default();

    // Plan each term: ReuseLocal(old_offset) vs FetchRemote(FetchRangeInfo).
    enum TermPlan {
        ReuseLocal {
            dest_offset: u64,
            src_offset: u64,
            len: u64,
        },
        FetchRemote {
            dest_offset: u64,
            term: ReconstructionTerm,
            fetch: FetchRangeInfo,
        },
    }

    let mut plans = Vec::with_capacity(new_rec.terms.len());
    let mut bytes_reused = 0u64;
    let mut remote_unpacked = 0u64;
    let mut dest_offset = 0u64;

    for term in &new_rec.terms {
        let key = TermKey::from_term(term);
        if let Some(&src_offset) = local_index.get(&key) {
            plans.push(TermPlan::ReuseLocal {
                dest_offset,
                src_offset,
                len: term.unpacked_length,
            });
            bytes_reused += term.unpacked_length;
        } else {
            let Some(fetch) = find_fetch_info(
                &new_rec.fetch_info,
                &term.hash,
                term.range.start,
                term.range.end,
            ) else {
                return Err(format!(
                    "Missing CAS fetch_info for xorb {} [{}, {})",
                    term.hash, term.range.start, term.range.end
                ));
            };
            plans.push(TermPlan::FetchRemote {
                dest_offset,
                term: term.clone(),
                fetch: fetch.clone(),
            });
            remote_unpacked += term.unpacked_length;
        }
        dest_offset += term.unpacked_length;
    }

    let reuse_pct = if total_bytes > 0 {
        (bytes_reused as f64 / total_bytes as f64) * 100.0
    } else {
        0.0
    };
    xet_log(
        format!(
            "[xet-delta] plan: {} terms ({} reused [{:.2}%], {} to fetch)",
            new_rec.terms.len(),
            fmt_bytes(bytes_reused),
            reuse_pct,
            fmt_bytes(remote_unpacked),
        ),
        BlackwellOutputConsoleLineStyle::Highlight,
    );
    if let Some(ref h) = hook {
        let msg = if bytes_reused > 0 {
            Some(format!(
                "Xet delta · {} reused ({:.0}%)",
                fmt_bytes(bytes_reused),
                reuse_pct
            ))
        } else {
            Some("Xet delta · fetching chunks…".to_string())
        };
        (h.on_progress)(bytes_reused, total_bytes, msg);
    }

    // Prepare temporary output file in the same directory so rename is atomic on NTFS.
    let part_path = PathBuf::from(format!("{local_path}.xet.part"));
    {
        let f = std::fs::File::create(&part_path)
            .map_err(|e| format!("Failed to create {}: {e}", part_path.display()))?;
        f.set_len(total_bytes)
            .map_err(|e| format!("Failed to preallocate {} bytes: {e}", total_bytes))?;
    }

    // 1. Copy all reused local terms sequentially from old file -> part file.
    if bytes_reused > 0 {
        let src_path = path.to_path_buf();
        let dst_path = part_path.clone();
        let copy_jobs: Vec<(u64, u64, u64)> = plans
            .iter()
            .filter_map(|p| match *p {
                TermPlan::ReuseLocal {
                    dest_offset,
                    src_offset,
                    len,
                } => Some((dest_offset, src_offset, len)),
                _ => None,
            })
            .collect();

        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let mut src = std::fs::File::open(&src_path)
                .map_err(|e| format!("Failed to open local file for reuse: {e}"))?;
            let mut dst = std::fs::OpenOptions::new()
                .write(true)
                .open(&dst_path)
                .map_err(|e| format!("Failed to open part file for reuse: {e}"))?;
            let mut buf = vec![0u8; 4 * 1024 * 1024];
            for (d_off, s_off, len) in copy_jobs {
                src.seek(SeekFrom::Start(s_off))
                    .map_err(|e| format!("Seek src failed: {e}"))?;
                dst.seek(SeekFrom::Start(d_off))
                    .map_err(|e| format!("Seek dst failed: {e}"))?;
                let mut left = len;
                while left > 0 {
                    let take = left.min(buf.len() as u64) as usize;
                    src.read_exact(&mut buf[..take])
                        .map_err(|e| format!("Read src failed: {e}"))?;
                    dst.write_all(&buf[..take])
                        .map_err(|e| format!("Write dst failed: {e}"))?;
                    left -= take as u64;
                }
            }
            Ok(())
        })
        .await
        .map_err(|e| format!("Local copy task panicked: {e}"))??;
    }

    // 2. Fetch and decode only the unmatched remote terms in parallel.
    let remote_jobs: Vec<(u64, ReconstructionTerm, FetchRangeInfo)> = plans
        .into_iter()
        .filter_map(|p| match p {
            TermPlan::FetchRemote {
                dest_offset,
                term,
                fetch,
            } => Some((dest_offset, term, fetch)),
            _ => None,
        })
        .collect();

    let http_client = build_http_client(true)?;
    let part_path_arc = Arc::new(part_path.clone());
    let write_lock = Arc::new(Mutex::new(()));
    let progress_done = Arc::new(AtomicU64::new(bytes_reused));

    let results: Vec<Result<u64, String>> = stream::iter(remote_jobs)
        .map(|(d_off, term, fetch)| {
            let client = http_client.clone();
            let dst_path = Arc::clone(&part_path_arc);
            let lock = Arc::clone(&write_lock);
            let prog = Arc::clone(&progress_done);
            let hook_clone = hook.clone();
            async move {
                if let Some(ref h) = hook_clone {
                    while (h.is_paused)() {
                        if (h.is_cancelled)() {
                            return Err("Cancelled".to_string());
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    }
                    if (h.is_cancelled)() {
                        return Err("Cancelled".to_string());
                    }
                }
                let unpacked_len = term.unpacked_length;
                let range_hdr = format!("bytes={}-{}", fetch.url_range.start, fetch.url_range.end);
                let resp = client
                    .get(&fetch.url)
                    .header(reqwest::header::RANGE, &range_hdr)
                    .send()
                    .await
                    .map_err(|e| format!("Xorb fetch failed: {e}"))?;
                if !resp.status().is_success()
                    && resp.status() != reqwest::StatusCode::PARTIAL_CONTENT
                {
                    return Err(format!("Xorb fetch HTTP {}", resp.status()));
                }
                let compressed = resp
                    .bytes()
                    .await
                    .map_err(|e| format!("Xorb read failed: {e}"))?;
                let dl_len = compressed.len() as u64;

                let decoded = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
                    let bytes = decode_xorb_chunks(
                        &compressed,
                        fetch.range.start,
                        term.range.start,
                        term.range.end,
                    )?;
                    if bytes.len() as u64 != term.unpacked_length {
                        return Err(format!(
                            "Decoded term length mismatch: got {} expected {}",
                            bytes.len(),
                            term.unpacked_length
                        ));
                    }
                    Ok(bytes)
                })
                .await
                .map_err(|e| format!("Xorb decode task panicked: {e}"))??;

                tokio::task::spawn_blocking(move || -> Result<(), String> {
                    let _g = lock.lock().map_err(|_| "Write lock poisoned".to_string())?;
                    let mut dst = std::fs::OpenOptions::new()
                        .write(true)
                        .open(&*dst_path)
                        .map_err(|e| format!("Open part file for write failed: {e}"))?;
                    dst.seek(SeekFrom::Start(d_off))
                        .map_err(|e| format!("Seek part file failed: {e}"))?;
                    dst.write_all(&decoded)
                        .map_err(|e| format!("Write decoded term failed: {e}"))?;
                    Ok(())
                })
                .await
                .map_err(|e| format!("Xorb write task panicked: {e}"))??;

                let done = prog.fetch_add(unpacked_len, Ordering::Relaxed) + unpacked_len;
                if let Some(ref h) = hook_clone {
                    (h.on_progress)(done.min(total_bytes), total_bytes, None);
                }

                Ok(dl_len)
            }
        })
        .buffer_unordered(MAX_CONCURRENT_XORB_FETCHES)
        .collect()
        .await;

    let mut bytes_downloaded = 0u64;
    for res in results {
        match res {
            Ok(n) => bytes_downloaded += n,
            Err(e) => {
                let _ = std::fs::remove_file(&part_path);
                xet_log(
                    format!("[xet-delta] ERROR {e}"),
                    BlackwellOutputConsoleLineStyle::Error,
                );
                return Err(e);
            }
        }
    }

    // 3. Optional SHA-256 verification against HF LFS OID.
    let sha256_verified = if let Some(expected) = expected_sha256.filter(|s| s.len() == 64) {
        if let Some(ref h) = hook {
            (h.on_progress)(total_bytes, total_bytes, Some("Verifying SHA-256…".to_string()));
        }
        let verify_path = part_path.clone();
        let expected_lower = expected.to_ascii_lowercase();
        let actual = tokio::task::spawn_blocking(move || -> Result<String, String> {
            let mut f = std::fs::File::open(&verify_path)
                .map_err(|e| format!("Failed to open part for SHA-256 verify: {e}"))?;
            let mut hasher = Sha256::new();
            let mut buf = vec![0u8; 4 * 1024 * 1024];
            loop {
                let n = f
                    .read(&mut buf)
                    .map_err(|e| format!("SHA-256 read error: {e}"))?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
            }
            Ok(hex::encode(hasher.finalize()))
        })
        .await
        .map_err(|e| format!("SHA-256 task panicked: {e}"))??;

        if actual != expected_lower {
            let _ = std::fs::remove_file(&part_path);
            let msg = format!(
                "SHA-256 mismatch after Xet delta (expected {}…, got {}…)",
                &expected_lower[..12],
                &actual[..12]
            );
            xet_log(
                format!("[xet-delta] ERROR {msg}"),
                BlackwellOutputConsoleLineStyle::Error,
            );
            return Err(msg);
        }
        true
    } else {
        false
    };

    // 4. Atomic swap on Windows: old -> .bak, part -> final, remove .bak.
    let bak_path = PathBuf::from(format!("{local_path}.xet.bak"));
    let _ = std::fs::remove_file(&bak_path);
    std::fs::rename(path, &bak_path)
        .map_err(|e| format!("Failed to stage old file backup: {e}"))?;
    if let Err(e) = std::fs::rename(&part_path, path) {
        let _ = std::fs::rename(&bak_path, path);
        return Err(format!("Failed to promote Xet-updated file: {e}"));
    }
    let _ = std::fs::remove_file(&bak_path);

    write_cached_recipe(path, &new_xet_hash, &new_rec.terms);

    xet_log(
        format!(
            "[xet-delta] DONE  downloaded={}  reused={} ({:.2}% saved)  sha256={}",
            fmt_bytes(bytes_downloaded),
            fmt_bytes(bytes_reused),
            reuse_pct,
            if sha256_verified { "OK" } else { "skipped" },
        ),
        BlackwellOutputConsoleLineStyle::Success,
    );

    Ok(XetDeltaReport {
        status: "updated".into(),
        bytes_downloaded,
        bytes_reused,
        total_bytes,
        sha256_verified,
        reason: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bg4_group(input: &[u8]) -> Vec<u8> {
        let mut g = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
        for (i, &b) in input.iter().enumerate() {
            g[i % 4].push(b);
        }
        let mut out = Vec::with_capacity(input.len());
        for buf in g {
            out.extend_from_slice(&buf);
        }
        out
    }

    fn encode_xorb_chunk(raw: &[u8], comp_type: u8) -> Vec<u8> {
        let payload = match comp_type {
            0 => raw.to_vec(),
            1 => {
                let mut enc = lz4_flex::frame::FrameEncoder::new(Vec::new());
                enc.write_all(raw).unwrap();
                enc.finish().unwrap()
            }
            2 => {
                let grouped = bg4_group(raw);
                let mut enc = lz4_flex::frame::FrameEncoder::new(Vec::new());
                enc.write_all(&grouped).unwrap();
                enc.finish().unwrap()
            }
            _ => unreachable!(),
        };
        let cs = payload.len();
        let us = raw.len();
        let mut out = Vec::with_capacity(8 + cs);
        out.push(0); // version
        out.push((cs & 0xff) as u8);
        out.push(((cs >> 8) & 0xff) as u8);
        out.push(((cs >> 16) & 0xff) as u8);
        out.push(comp_type);
        out.push((us & 0xff) as u8);
        out.push(((us >> 8) & 0xff) as u8);
        out.push(((us >> 16) & 0xff) as u8);
        out.extend_from_slice(&payload);
        out
    }

    #[test]
    fn bg4_round_trips_aligned_and_unaligned_lengths() {
        for len in [0usize, 1, 2, 3, 4, 5, 7, 16, 17, 1023, 4096] {
            let data: Vec<u8> = (0..len).map(|i| ((i * 37 + 11) & 0xff) as u8).collect();
            let grouped = bg4_group(&data);
            assert_eq!(bg4_ungroup(&grouped), data, "failed for len={len}");
        }
    }

    #[test]
    fn decode_xorb_chunks_handles_raw_lz4_bg4_and_subrange_slicing() {
        let c0: Vec<u8> = b"chunk zero raw payload!".to_vec();
        let c1: Vec<u8> = (0..512).map(|i| (i % 13) as u8).collect();
        let c2: Vec<u8> = (0..515).map(|i| ((i * 7) & 0xff) as u8).collect();

        let mut xorb = Vec::new();
        xorb.extend_from_slice(&encode_xorb_chunk(&c0, 0));
        xorb.extend_from_slice(&encode_xorb_chunk(&c1, 1));
        xorb.extend_from_slice(&encode_xorb_chunk(&c2, 2));

        // Decode all 3 chunks [10, 13)
        let all = decode_xorb_chunks(&xorb, 10, 10, 13).expect("decode all");
        let mut expected_all = Vec::new();
        expected_all.extend_from_slice(&c0);
        expected_all.extend_from_slice(&c1);
        expected_all.extend_from_slice(&c2);
        assert_eq!(all, expected_all);

        // Decode middle+last subrange [11, 13)
        let sub = decode_xorb_chunks(&xorb, 10, 11, 13).expect("decode sub");
        let mut expected_sub = Vec::new();
        expected_sub.extend_from_slice(&c1);
        expected_sub.extend_from_slice(&c2);
        assert_eq!(sub, expected_sub);
    }

    #[test]
    fn parse_hf_resolve_url_extracts_repo_revision_and_path() {
        let url = "https://huggingface.co/unsloth/Inkling-2-Mini-GGUF/resolve/main/Q8_0/model-00001-of-00002.gguf";
        let (repo, rev, path) = parse_hf_resolve_url(url).expect("parse");
        assert_eq!(repo, "unsloth/Inkling-2-Mini-GGUF");
        assert_eq!(rev, "main");
        assert_eq!(path, "Q8_0/model-00001-of-00002.gguf");
    }

    #[test]
    fn index_local_terms_computes_exact_byte_offsets() {
        let terms = vec![
            ReconstructionTerm {
                hash: "aaa".into(),
                unpacked_length: 100,
                range: ChunkRange { start: 0, end: 1 },
            },
            ReconstructionTerm {
                hash: "bbb".into(),
                unpacked_length: 250,
                range: ChunkRange { start: 4, end: 9 },
            },
        ];
        let idx = index_local_terms(&terms);
        assert_eq!(idx.get(&TermKey::from_term(&terms[0])), Some(&0));
        assert_eq!(idx.get(&TermKey::from_term(&terms[1])), Some(&100));
    }
}
