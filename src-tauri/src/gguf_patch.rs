//! GGUF metadata patching — download only the header+metadata section from HF
//! via HTTP Range, compare with the local file, and patch in-place when the
//! tensor data region is unchanged.
//!
//! Only handles **metadata-only changes** (jinja template, EULA, etc.).
//! Tensor weight changes still require a full re-download.
//!
//! Tensor-info layout (GGUF v2/v3) — there is **no** stored tensor size:
//!   name (u64 len + bytes) + n_dims (u32) + dims[n_dims] (u64) + type (u32) + offset (u64)
//! Tensor data then starts at `align(end_of_tensor_infos, general.alignment)` (default 32).

use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::Path;

use crate::output_console::{
    emit_blackwell_output_console_utils_line, BlackwellOutputConsoleLineStyle,
};

fn patch_log(msg: impl AsRef<str>, style: BlackwellOutputConsoleLineStyle) {
    let msg = msg.as_ref();
    log::info!("{}", msg);
    emit_blackwell_output_console_utils_line(msg, style);
}

fn fmt_bytes(n: u64) -> String {
    if n >= 1_048_576 {
        format!("{} ({:.2} MB)", n, n as f64 / 1_048_576.0)
    } else if n >= 1024 {
        format!("{} ({:.1} KB)", n, n as f64 / 1024.0)
    } else {
        format!("{} B", n)
    }
}

const GGUF_DEFAULT_ALIGNMENT: u64 = 32;
const MAX_METADATA_STRING: u64 = 10_000_000;
const MAX_TENSOR_NAME: u64 = 10_000;
const MAX_DIMS: u32 = 8;

/// Result of a GGUF patch attempt.
#[derive(Debug)]
pub enum PatchResult {
    /// File is already up to date — no patch needed.
    AlreadyCurrent,
    /// Patched successfully.
    Patched { header_bytes_downloaded: u64, local_io_bytes: u64 },
    /// Cannot patch — change involves tensor data or other non-metadata regions.
    RequiresFullDownload { reason: String },
    /// Error.
    Error(String),
}

struct GgufReader<R> {
    inner: R,
    offset: u64,
}

impl<R: Read> GgufReader<R> {
    fn new(inner: R) -> Self {
        Self { inner, offset: 0 }
    }

    fn read_exact(&mut self, n: usize) -> Result<Vec<u8>, String> {
        let mut buf = vec![0u8; n];
        self.inner
            .read_exact(&mut buf)
            .map_err(|e| format!("At offset {}: {}", self.offset, e))?;
        self.offset += n as u64;
        Ok(buf)
    }

    fn read_u32(&mut self) -> Result<u32, String> {
        let buf = self.read_exact(4)?;
        Ok(u32::from_le_bytes(buf.try_into().unwrap()))
    }

    fn read_u64(&mut self) -> Result<u64, String> {
        let buf = self.read_exact(8)?;
        Ok(u64::from_le_bytes(buf.try_into().unwrap()))
    }

    /// GGUF v2/v3 string: u64 length + UTF-8 bytes (not required to be valid UTF-8 to skip).
    fn skip_string(&mut self, what: &str, max_len: u64) -> Result<Vec<u8>, String> {
        let len = self.read_u64()?;
        if len > max_len {
            return Err(format!(
                "{} length {} at offset {} exceeds sanity limit {}",
                what, len, self.offset, max_len
            ));
        }
        self.read_exact(len as usize)
    }
}

fn align_offset(offset: u64, alignment: u64) -> u64 {
    if alignment == 0 {
        return offset;
    }
    let rem = offset % alignment;
    if rem == 0 {
        offset
    } else {
        offset + (alignment - rem)
    }
}

/// Parse a GGUF header from any reader and return the file offset where tensor
/// data starts (after alignment padding).
fn parse_header_end<R: Read>(reader: R) -> Result<u64, String> {
    let mut r = GgufReader::new(reader);

    let magic = r.read_exact(4)?;
    if magic != b"GGUF" {
        return Err("Not a GGUF file".into());
    }

    let version = r.read_u32()?;
    if version < 2 || version > 3 {
        return Err(format!(
            "Unsupported GGUF version {} (need v2 or v3; v1 uses u32 counts)",
            version
        ));
    }

    let tensor_count = r.read_u64()?;
    let metadata_count = r.read_u64()?;
    if tensor_count > 2_000_000 {
        return Err(format!("Tensor count {} exceeds sanity limit", tensor_count));
    }
    if metadata_count > 1_000_000 {
        return Err(format!("Metadata count {} exceeds sanity limit", metadata_count));
    }

    let mut alignment = GGUF_DEFAULT_ALIGNMENT;

    for i in 0..metadata_count {
        let key_bytes = r.skip_string(&format!("Metadata[{}] key", i), MAX_METADATA_STRING)?;
        let key = String::from_utf8_lossy(&key_bytes);
        let value_type = r.read_u32()?;
        if key == "general.alignment" {
            alignment = read_alignment_value(&mut r, value_type)?;
        } else {
            skip_value(&mut r, value_type)?;
        }
    }

    for i in 0..tensor_count {
        let name_len = r.read_u64()?;
        if name_len > MAX_TENSOR_NAME {
            return Err(format!(
                "Tensor[{}] name length {} exceeds sanity limit",
                i, name_len
            ));
        }
        r.read_exact(name_len as usize)?;

        let n_dims = r.read_u32()?;
        if n_dims > MAX_DIMS {
            return Err(format!(
                "Tensor[{}]: n_dims={} exceeds sanity limit (max {})",
                i, n_dims, MAX_DIMS
            ));
        }
        for _ in 0..n_dims {
            let _dim = r.read_u64()?;
        }
        // ggml_type — uint32. Previous parser skipped this and then read a
        // non-existent u64 "size", which desynced at Tensor[1].
        let _ggml_type = r.read_u32()?;
        let _data_offset = r.read_u64()?;
    }

    Ok(align_offset(r.offset, alignment))
}

fn find_header_end_from_file(model_path: &str) -> Result<u64, String> {
    if !Path::new(model_path).exists() {
        return Err(format!("Model file not found: {}", model_path));
    }
    let f = std::fs::File::open(model_path).map_err(|e| format!("Failed to open file: {}", e))?;
    parse_header_end(f)
}

fn find_header_end_from_bytes(bytes: &[u8]) -> Result<u64, String> {
    parse_header_end(Cursor::new(bytes))
}

fn read_alignment_value<R: Read>(r: &mut GgufReader<R>, value_type: u32) -> Result<u64, String> {
    match value_type {
        4 => Ok(r.read_u32()? as u64), // UINT32
        5 => Ok(r.read_u32()? as u64), // INT32
        10 => r.read_u64(),            // UINT64
        11 => r.read_u64(),            // INT64
        other => {
            skip_value(r, other)?;
            Ok(GGUF_DEFAULT_ALIGNMENT)
        }
    }
}

fn skip_value<R: Read>(r: &mut GgufReader<R>, value_type: u32) -> Result<(), String> {
    match value_type {
        0 | 1 | 7 => {
            r.read_exact(1)?;
            Ok(())
        }
        2 | 3 => {
            r.read_exact(2)?;
            Ok(())
        }
        4 | 5 | 6 => {
            r.read_exact(4)?;
            Ok(())
        }
        8 => {
            r.skip_string("String", MAX_METADATA_STRING)?;
            Ok(())
        }
        9 => {
            // Array: elem_type (u32) + count (u64) + elements
            let elem_type = r.read_u32()?;
            let count = r.read_u64()?;
            if count > 50_000_000 {
                return Err(format!(
                    "Array count {} at offset {} exceeds sanity limit",
                    count, r.offset
                ));
            }
            for _ in 0..count {
                skip_value(r, elem_type)?;
            }
            Ok(())
        }
        10 | 11 | 12 => {
            r.read_exact(8)?;
            Ok(())
        }
        other => Err(format!(
            "Unknown GGUF metadata value type {} at offset {}",
            other, r.offset
        )),
    }
}

/// Jinja/metadata growth stays well under this. A requant is gigabytes.
const MAX_METADATA_SIZE_DELTA: u64 = 16 * 1024 * 1024;
/// Never Range-GET more than this while classifying or patching a header.
const MAX_HEADER_PROBE: u64 = 32 * 1024 * 1024;

/// How many leading bytes to fetch. `None` = size delta is a weight change — do not download.
pub fn header_probe_end(local_size: u64, remote_size: u64, local_header_end: u64) -> Option<u64> {
    if remote_size == 0 || local_header_end == 0 {
        return None;
    }
    let delta = remote_size.abs_diff(local_size);
    if delta > MAX_METADATA_SIZE_DELTA {
        return None;
    }
    if remote_size == local_size {
        return Some(local_header_end.min(remote_size).min(MAX_HEADER_PROBE));
    }
    let slack = delta.saturating_add(1_048_576);
    Some(
        local_header_end
            .saturating_add(slack)
            .min(remote_size)
            .min(MAX_HEADER_PROBE),
    )
}

/// Decide whether a size/header delta is metadata-only or a weight change.
pub fn classify_from_headers(
    local_size: u64,
    remote_size: u64,
    local_header_end: u64,
    remote_header_end: u64,
    headers_byte_equal: bool,
) -> crate::types::QuantUpdateKind {
    if local_header_end >= local_size || remote_header_end >= remote_size {
        return crate::types::QuantUpdateKind::Full;
    }
    let local_tensors = local_size - local_header_end;
    let remote_tensors = remote_size - remote_header_end;
    if local_tensors != remote_tensors {
        return crate::types::QuantUpdateKind::Full;
    }
    if headers_byte_equal && local_size == remote_size {
        crate::types::QuantUpdateKind::Current
    } else {
        crate::types::QuantUpdateKind::Header
    }
}

/// Classify a local GGUF vs a remote file. Uses HTTP Range for the header only.
pub async fn classify_update(
    local_path: &str,
    remote_url: &str,
    remote_total_size: u64,
    remote_oid: &str,
    local_oid: Option<&str>,
    verbose: bool,
) -> Result<crate::types::QuantUpdateKind, String> {
    if !remote_oid.is_empty() && local_oid == Some(remote_oid) {
        return Ok(crate::types::QuantUpdateKind::Current);
    }
    if let Some(cached) = read_kind_cache(local_path, remote_oid, remote_total_size) {
        return Ok(cached);
    }

    let local_size = std::fs::metadata(local_path)
        .map_err(|e| format!("Failed to get file size: {e}"))?
        .len();
    if local_size.abs_diff(remote_total_size) > MAX_METADATA_SIZE_DELTA {
        return Ok(crate::types::QuantUpdateKind::Full);
    }
    let local_header_end = find_header_end_from_file(local_path)?;
    if local_header_end >= local_size {
        return Ok(crate::types::QuantUpdateKind::Full);
    }

    let Some(probe_end) = header_probe_end(local_size, remote_total_size, local_header_end) else {
        if verbose {
            patch_log(
                format!(
                    "[gguf-patch] size delta {} — treating as full (no header probe)",
                    fmt_bytes(local_size.abs_diff(remote_total_size))
                ),
                BlackwellOutputConsoleLineStyle::Warning,
            );
        }
        return Ok(crate::types::QuantUpdateKind::Full);
    };

    let remote_prefix = download_range(remote_url, 0, probe_end, verbose).await?;
    let compare_len = (local_header_end as usize).min(remote_prefix.len());
    let headers_equal = remote_prefix.len() >= local_header_end as usize
        && {
            let mut local_header = vec![0u8; local_header_end as usize];
            let mut f = std::fs::File::open(local_path).map_err(|e| e.to_string())?;
            f.read_exact(&mut local_header).map_err(|e| e.to_string())?;
            local_header == remote_prefix[..compare_len]
        };

    let remote_header_end = match find_header_end_from_bytes(&remote_prefix) {
        Ok(end) => end,
        Err(_) if probe_end < remote_total_size && probe_end < MAX_HEADER_PROBE => {
            let grown = (probe_end + 4_194_304).min(remote_total_size).min(MAX_HEADER_PROBE);
            let more = download_range(remote_url, 0, grown, verbose).await?;
            find_header_end_from_bytes(&more).unwrap_or(local_header_end)
        }
        Err(_) => local_header_end,
    };

    let kind = classify_from_headers(
        local_size,
        remote_total_size,
        local_header_end,
        remote_header_end,
        headers_equal,
    );
    write_kind_cache(local_path, remote_oid, remote_total_size, &kind);
    Ok(kind)
}

fn kind_cache_path() -> std::path::PathBuf {
    crate::config::cache_dir().join("gguf_update_kind.json")
}

#[derive(serde::Serialize, serde::Deserialize)]
struct KindCacheEntry {
    path: String,
    local_mtime: u64,
    local_size: u64,
    remote_oid: String,
    remote_size: u64,
    kind: crate::types::QuantUpdateKind,
}

fn file_mtime_secs(path: &str) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn read_kind_cache(path: &str, remote_oid: &str, remote_size: u64) -> Option<crate::types::QuantUpdateKind> {
    let raw = std::fs::read_to_string(kind_cache_path()).ok()?;
    let entries: Vec<KindCacheEntry> = serde_json::from_str(&raw).ok()?;
    let mtime = file_mtime_secs(path);
    let size = std::fs::metadata(path).ok()?.len();
    entries.into_iter().find(|e| {
        e.path == path
            && e.local_mtime == mtime
            && e.local_size == size
            && e.remote_oid == remote_oid
            && e.remote_size == remote_size
    }).map(|e| e.kind)
}

fn write_kind_cache(path: &str, remote_oid: &str, remote_size: u64, kind: &crate::types::QuantUpdateKind) {
    let mut entries: Vec<KindCacheEntry> = std::fs::read_to_string(kind_cache_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let mtime = file_mtime_secs(path);
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    entries.retain(|e| e.path != path);
    entries.push(KindCacheEntry {
        path: path.to_string(),
        local_mtime: mtime,
        local_size: size,
        remote_oid: remote_oid.to_string(),
        remote_size,
        kind: kind.clone(),
    });
    if entries.len() > 200 {
        let drop_n = entries.len() - 200;
        entries.drain(0..drop_n);
    }
    if let Ok(json) = serde_json::to_string_pretty(&entries) {
        let _ = std::fs::create_dir_all(crate::config::cache_dir());
        let _ = std::fs::write(kind_cache_path(), json);
    }
}

/// Download `[start, end)` from a remote URL via HTTP Range (Range is inclusive).
async fn download_range(url: &str, start: u64, end: u64, verbose: bool) -> Result<Vec<u8>, String> {
    if end <= start {
        return Ok(Vec::new());
    }
    let last_inclusive = end - 1;
    let range = format!("bytes={}-{}", start, last_inclusive);
    if verbose {
        patch_log(
            format!(
                "[gguf-patch] HTTP Range GET {}  ({})",
                range,
                fmt_bytes(end - start)
            ),
            BlackwellOutputConsoleLineStyle::Command,
        );
    }
    let client = reqwest::Client::new();
    let resp = client
        .get(url)
        .header("Range", &range)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;
    let status = resp.status();
    if !status.is_success() && status != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(format!(
            "HTTP {} (expected 206 Partial Content): {}",
            status,
            resp.text().await.unwrap_or_default()
        ));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?
        .to_vec();
    if verbose {
        patch_log(
            format!(
                "[gguf-patch] HTTP {} — received {}",
                status.as_u16(),
                fmt_bytes(bytes.len() as u64)
            ),
            BlackwellOutputConsoleLineStyle::Normal,
        );
    }
    Ok(bytes)
}

/// Patch a local GGUF file with new metadata from HF.
///
/// - `local_path` — path to the local .gguf file
/// - `remote_url` — HF download URL for the same quant
/// - `remote_total_size` — total file size of the remote file (from HF API)
pub async fn patch_metadata(
    local_path: &str,
    remote_url: &str,
    remote_total_size: u64,
) -> PatchResult {
    patch_log(
        format!("[gguf-patch] start  path={}", local_path),
        BlackwellOutputConsoleLineStyle::Highlight,
    );
    patch_log(
        format!("[gguf-patch] remote={}", remote_url),
        BlackwellOutputConsoleLineStyle::Normal,
    );

    let local_path = Path::new(local_path);

    let local_size = match std::fs::metadata(local_path) {
        Ok(m) => m.len(),
        Err(e) => {
            let msg = format!("Failed to get file size: {}", e);
            patch_log(format!("[gguf-patch] ERROR {}", msg), BlackwellOutputConsoleLineStyle::Error);
            return PatchResult::Error(msg);
        }
    };

    patch_log(
        format!(
            "[gguf-patch] sizes  local={}  remote={}",
            fmt_bytes(local_size),
            fmt_bytes(remote_total_size)
        ),
        BlackwellOutputConsoleLineStyle::Normal,
    );

    // 1. Find header_end by parsing the local file directly
    patch_log(
        "[gguf-patch] parsing local GGUF header…",
        BlackwellOutputConsoleLineStyle::Normal,
    );
    let local_header_end = match find_header_end_from_file(&local_path.to_string_lossy()) {
        Ok(offset) => {
            patch_log(
                format!(
                    "[gguf-patch] local header_end={}  (tensor data starts here)",
                    fmt_bytes(offset)
                ),
                BlackwellOutputConsoleLineStyle::Normal,
            );
            offset
        }
        Err(e) => {
            let msg = format!("Failed to parse local GGUF header: {}", e);
            patch_log(format!("[gguf-patch] ERROR {}", msg), BlackwellOutputConsoleLineStyle::Error);
            return PatchResult::Error(msg);
        }
    };

    if local_header_end >= local_size {
        let msg = "Local file has no tensor data — cannot patch";
        patch_log(format!("[gguf-patch] ERROR {}", msg), BlackwellOutputConsoleLineStyle::Error);
        return PatchResult::Error(msg.into());
    }

    // 2. Download remote header section via HTTP Range (capped — never the size delta)
    let Some(probe_end) = header_probe_end(local_size, remote_total_size, local_header_end) else {
        let reason = format!(
            "File size delta {} exceeds metadata budget — full re-download",
            fmt_bytes(local_size.abs_diff(remote_total_size))
        );
        patch_log(
            format!("[gguf-patch] cannot patch — {reason}"),
            BlackwellOutputConsoleLineStyle::Warning,
        );
        return PatchResult::RequiresFullDownload { reason };
    };
    let remote_header = match download_range(remote_url, 0, probe_end, true).await {
        Ok(b) => b,
        Err(e) => {
            let msg = format!("Failed to download remote header: {}", e);
            patch_log(format!("[gguf-patch] ERROR {}", msg), BlackwellOutputConsoleLineStyle::Error);
            return PatchResult::Error(msg);
        }
    };

    // 3. Read local header section for comparison
    patch_log(
        "[gguf-patch] reading local header for byte compare…",
        BlackwellOutputConsoleLineStyle::Normal,
    );
    let mut local_header = vec![0u8; local_header_end as usize];
    {
        let mut f = match std::fs::File::open(local_path) {
            Ok(f) => f,
            Err(e) => {
                let msg = format!("Failed to open local file: {}", e);
                patch_log(format!("[gguf-patch] ERROR {}", msg), BlackwellOutputConsoleLineStyle::Error);
                return PatchResult::Error(msg);
            }
        };
        if let Err(e) = f.read_exact(&mut local_header) {
            let msg = format!("Failed to read local header: {}", e);
            patch_log(format!("[gguf-patch] ERROR {}", msg), BlackwellOutputConsoleLineStyle::Error);
            return PatchResult::Error(msg);
        }
    }

    // 4. Compare prefix (local header length) — full remote header may be longer
    let remote_prefix = if remote_header.len() >= local_header_end as usize {
        &remote_header[..local_header_end as usize]
    } else {
        remote_header.as_slice()
    };
    if local_header == remote_prefix && local_size == remote_total_size {
        patch_log(
            "[gguf-patch] headers identical — already current, no write",
            BlackwellOutputConsoleLineStyle::Success,
        );
        return PatchResult::AlreadyCurrent;
    }

    patch_log(
        "[gguf-patch] headers differ — classifying tensor-blob size",
        BlackwellOutputConsoleLineStyle::Highlight,
    );

    // 5. Parse remote header in-memory (same GGUF walker as the local file)
    let remote_header_end = match find_header_end_from_bytes(&remote_header) {
        Ok(end) => Ok(end),
        Err(e) if probe_end < remote_total_size => {
            patch_log(
                format!("[gguf-patch] remote header truncated ({e}) — fetching more"),
                BlackwellOutputConsoleLineStyle::Warning,
            );
            Err(e)
        }
        Err(e) => Err(e),
    };

    match remote_header_end {
        Ok(remote_end) if remote_end == local_header_end => {
            if local_size != remote_total_size {
                let reason = format!(
                    "Header length same but file size changed: local={} remote={}",
                    local_size, remote_total_size
                );
                patch_log(
                    format!("[gguf-patch] cannot patch — {reason}"),
                    BlackwellOutputConsoleLineStyle::Warning,
                );
                return PatchResult::RequiresFullDownload { reason };
            }
            let splice = if remote_header.len() >= local_header_end as usize {
                &remote_header[..local_header_end as usize]
            } else {
                remote_header.as_slice()
            };
            patch_log(
                format!(
                    "[gguf-patch] same-length header ({}) — splicing in-place",
                    fmt_bytes(remote_end)
                ),
                BlackwellOutputConsoleLineStyle::Normal,
            );
            match patch_in_place(local_path, splice, local_header_end) {
                Ok(()) => {
                    patch_log(
                        "[gguf-patch] patched in-place",
                        BlackwellOutputConsoleLineStyle::Success,
                    );
                    PatchResult::Patched {
                        header_bytes_downloaded: remote_header.len() as u64,
                        local_io_bytes: local_header_end,
                    }
                }
                Err(e) => {
                    let msg = format!("Failed to patch in-place: {}", e);
                    patch_log(format!("[gguf-patch] ERROR {}", msg), BlackwellOutputConsoleLineStyle::Error);
                    PatchResult::Error(msg)
                }
            }
        }
        Ok(remote_end) => {
            let kind = classify_from_headers(
                local_size,
                remote_total_size,
                local_header_end,
                remote_end,
                false,
            );
            if kind == crate::types::QuantUpdateKind::Full {
                let reason = format!(
                    "Tensor blob size changed: local={} remote={}",
                    local_size - local_header_end,
                    remote_total_size.saturating_sub(remote_end)
                );
                patch_log(
                    format!("[gguf-patch] cannot patch — {reason}"),
                    BlackwellOutputConsoleLineStyle::Warning,
                );
                return PatchResult::RequiresFullDownload { reason };
            }
            patch_log(
                format!(
                    "[gguf-patch] header length changed  local={}  remote={} — shifting tensor data",
                    fmt_bytes(local_header_end),
                    fmt_bytes(remote_end)
                ),
                BlackwellOutputConsoleLineStyle::Warning,
            );
            let mut full_remote = remote_header;
            if remote_end > probe_end {
                match download_range(remote_url, probe_end, remote_end, true).await {
                    Ok(b) => full_remote.extend_from_slice(&b),
                    Err(e) => {
                        let msg = format!("Failed to download extended header: {}", e);
                        patch_log(format!("[gguf-patch] ERROR {}", msg), BlackwellOutputConsoleLineStyle::Error);
                        return PatchResult::Error(msg);
                    }
                }
            }
            full_remote.truncate(remote_end as usize);

            match patch_with_shift(local_path, &full_remote, local_header_end, remote_end, local_size) {
                Ok(()) => {
                    patch_log(
                        "[gguf-patch] patched with tensor-data shift",
                        BlackwellOutputConsoleLineStyle::Success,
                    );
                    PatchResult::Patched {
                        header_bytes_downloaded: full_remote.len() as u64,
                        local_io_bytes: local_size,
                    }
                }
                Err(e) => {
                    let msg = format!("Failed to patch with shift: {}", e);
                    patch_log(format!("[gguf-patch] ERROR {}", msg), BlackwellOutputConsoleLineStyle::Error);
                    PatchResult::Error(msg)
                }
            }
        }
        Err(e) => {
            patch_log(
                format!(
                    "[gguf-patch] remote header parse failed ({}) — falling back to same-length splice",
                    e
                ),
                BlackwellOutputConsoleLineStyle::Warning,
            );
            match patch_in_place(local_path, &remote_header, local_header_end) {
                Ok(()) => {
                    patch_log(
                        "[gguf-patch] patched in-place (fallback)",
                        BlackwellOutputConsoleLineStyle::Success,
                    );
                    PatchResult::Patched {
                        header_bytes_downloaded: remote_header.len() as u64,
                        local_io_bytes: local_header_end,
                    }
                }
                Err(e) => {
                    let msg = format!("Failed to patch in-place: {}", e);
                    patch_log(format!("[gguf-patch] ERROR {}", msg), BlackwellOutputConsoleLineStyle::Error);
                    PatchResult::Error(msg)
                }
            }
        }
    }
}



/// Splice new header bytes into the local file in-place.
fn patch_in_place(path: &Path, new_header: &[u8], header_len: u64) -> Result<(), String> {
    use std::io::Write;

    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|e| format!("Failed to open for writing: {}", e))?;

    f.write_all(new_header).map_err(|e| format!("Failed to write header: {}", e))?;
    f.flush().map_err(|e| format!("Failed to flush: {}", e))?;

    log::info!(
        "[gguf-patch] Patched {} bytes of header in-place",
        header_len
    );
    Ok(())
}

/// Write a new file with remote header + old tensor data (shifted to new offset).
fn patch_with_shift(
    path: &Path,
    new_header: &[u8],
    old_header_end: u64,
    _new_header_end: u64,
    total_size: u64,
) -> Result<(), String> {
    use std::io::Write;

    let tmp_path = path.with_extension("gguf.patch-tmp");
    let tensor_data_size = total_size - old_header_end;

    let mut reader = std::fs::File::open(path).map_err(|e| format!("Failed to open for reading: {}", e))?;
    let mut writer = std::fs::File::create(&tmp_path).map_err(|e| format!("Failed to create temp file: {}", e))?;

    writer.write_all(new_header).map_err(|e| format!("Failed to write new header: {}", e))?;

    reader.seek(SeekFrom::Start(old_header_end)).map_err(|e| e.to_string())?;

    let mut buf = vec![0u8; 4_194_304]; // 4 MB buffer
    let mut remaining = tensor_data_size;
    while remaining > 0 {
        let to_read = buf.len().min(remaining as usize);
        let n = reader.read(&mut buf[..to_read]).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n]).map_err(|e| format!("Failed to write tensor data: {}", e))?;
        remaining -= n as u64;
    }

    writer.flush().map_err(|e| format!("Failed to flush: {}", e))?;
    drop(writer);

    std::fs::rename(&tmp_path, path).map_err(|e| format!("Failed to rename temp file: {}", e))?;

    log::info!(
        "[gguf-patch] Shifted tensor data (old header_end={}, tensor_size={})",
        old_header_end,
        tensor_data_size
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn push_u32(buf: &mut Vec<u8>, v: u32) {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    fn push_u64(buf: &mut Vec<u8>, v: u64) {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    fn push_str(buf: &mut Vec<u8>, s: &str) {
        push_u64(buf, s.len() as u64);
        buf.extend_from_slice(s.as_bytes());
    }

    /// Minimal GGUF v3: 2 metadata KVs + 2 tensors. Layout matches ggml/docs/gguf.md.
    fn build_minimal_gguf() -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"GGUF");
        push_u32(&mut buf, 3); // version
        push_u64(&mut buf, 2); // tensor_count
        push_u64(&mut buf, 2); // metadata_count

        // general.architecture: string
        push_str(&mut buf, "general.architecture");
        push_u32(&mut buf, 8); // STRING
        push_str(&mut buf, "qwen3");

        // tokenizer.ggml.tokens: array[string] (the kind that used to blow up skip)
        push_str(&mut buf, "tokenizer.ggml.tokens");
        push_u32(&mut buf, 9); // ARRAY
        push_u32(&mut buf, 8); // elem STRING
        push_u64(&mut buf, 2);
        push_str(&mut buf, "hello");
        push_str(&mut buf, "world");

        // Tensor 0: token_embd.weight  [4, 2]  F32  offset 0
        push_str(&mut buf, "token_embd.weight");
        push_u32(&mut buf, 2); // n_dims
        push_u64(&mut buf, 4);
        push_u64(&mut buf, 2);
        push_u32(&mut buf, 0); // GGML_TYPE_F32
        push_u64(&mut buf, 0); // offset in data section

        // Tensor 1: blk.0.attn_q.weight  [2]  F32  offset 32
        push_str(&mut buf, "blk.0.attn_q.weight");
        push_u32(&mut buf, 1);
        push_u64(&mut buf, 2);
        push_u32(&mut buf, 0);
        push_u64(&mut buf, 32);

        let aligned = align_offset(buf.len() as u64, GGUF_DEFAULT_ALIGNMENT);
        buf.resize(aligned as usize, 0);

        // dummy tensor payload so the file is not header-only
        buf.extend_from_slice(&[0u8; 64]);
        buf
    }

    #[test]
    fn parses_two_tensors_without_fake_size_field() {
        let bytes = build_minimal_gguf();
        let header_end = find_header_end_from_bytes(&bytes).expect("parse");
        assert_eq!(header_end % GGUF_DEFAULT_ALIGNMENT, 0);
        assert!(header_end > 0);
        assert!(header_end < bytes.len() as u64);
    }

    #[test]
    fn tensor1_name_is_not_misread_as_huge_length() {
        let bytes = build_minimal_gguf();
        // The old bug: after tensor 0, read u64 offset + u64 size (no type).
        // That consumes tensor 1's name length as "size", then Tensor[1] explodes.
        let header_end = find_header_end_from_bytes(&bytes).unwrap();
        // Re-parse via file path too.
        let dir = std::env::temp_dir();
        let path = dir.join("gguf_patch_minimal_test.gguf");
        std::fs::write(&path, &bytes).unwrap();
        let from_file = find_header_end_from_file(path.to_str().unwrap()).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(from_file, header_end);
    }

    #[test]
    fn rejects_unknown_magic() {
        let err = find_header_end_from_bytes(b"XXXX").unwrap_err();
        assert!(err.contains("Not a GGUF"));
    }

    #[test]
    fn parses_probe_path_if_set() {
        let Ok(path) = std::env::var("GGUF_PATCH_PROBE_PATH") else {
            return;
        };
        let header_end = find_header_end_from_file(&path)
            .unwrap_or_else(|e| panic!("failed to parse {path}: {e}"));
        eprintln!("[gguf-patch] {path} header_end={header_end}");
        assert!(header_end > 24);
        let size = std::fs::metadata(&path).unwrap().len();
        assert!(header_end < size, "header_end {header_end} >= file size {size}");
    }

    #[test]
    fn classify_same_tensors_different_header_is_header() {
        assert_eq!(
            classify_from_headers(1000, 1100, 100, 200, false),
            crate::types::QuantUpdateKind::Header
        );
    }

    #[test]
    fn classify_tensor_blob_change_is_full() {
        assert_eq!(
            classify_from_headers(1000, 2000, 100, 100, false),
            crate::types::QuantUpdateKind::Full
        );
    }

    #[test]
    fn classify_identical_is_current() {
        assert_eq!(
            classify_from_headers(1000, 1000, 100, 100, true),
            crate::types::QuantUpdateKind::Current
        );
    }

    #[test]
    fn header_probe_refuses_gigabyte_size_delta() {
        let local = 17_000_000_000u64;
        let remote = 20_000_000_000u64;
        assert_eq!(header_probe_end(local, remote, 11_000_000), None);
    }

    #[test]
    fn header_probe_allows_small_template_growth() {
        let end = header_probe_end(17_000_000_000, 17_000_050_000, 11_000_000).unwrap();
        assert!(end <= 32 * 1024 * 1024);
        assert!(end >= 11_000_000);
    }

    #[test]
    fn honors_general_alignment() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"GGUF");
        push_u32(&mut buf, 3);
        push_u64(&mut buf, 0); // no tensors
        push_u64(&mut buf, 1); // one KV
        push_str(&mut buf, "general.alignment");
        push_u32(&mut buf, 4); // UINT32
        push_u32(&mut buf, 64);
        let expected = align_offset(buf.len() as u64, 64);
        assert_eq!(find_header_end_from_bytes(&buf).unwrap(), expected);
        assert_eq!(expected % 64, 0);
    }
}
