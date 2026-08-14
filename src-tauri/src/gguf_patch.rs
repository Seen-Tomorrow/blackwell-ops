//! GGUF metadata patching — download only the header+metadata section from HF
//! via HTTP Range, compare with the local file, and patch in-place when the
//! tensor data region is unchanged.
//!
//! Only handles **metadata-only changes** (jinja template, EULA, etc.).
//! Tensor weight changes still require a full re-download.
//!
//! Uses `llama-server --print-info` to find the header_end offset — avoids
//! writing a fragile GGUF binary parser.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

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

/// Parse the GGUF binary header directly to find where tensor data starts.
///
/// Uses a single-pass approach with a helper struct to avoid recursive closures.
fn find_header_end_from_file(model_path: &str) -> Result<u64, String> {
    use std::io::Read;

    if !Path::new(model_path).exists() {
        return Err(format!("Model file not found: {}", model_path));
    }

    let mut f = std::fs::File::open(model_path)
        .map_err(|e| format!("Failed to open file: {}", e))?;

    let mut offset: u64 = 0;

    // ── Fixed header ──
    let mut magic = [0u8; 4];
    f.read_exact(&mut magic).map_err(|e| e.to_string())?;
    if &magic != b"GGUF" {
        return Err("Not a GGUF file".into());
    }
    offset += 4;

    let mut read_4 = |f: &mut std::fs::File, off: &mut u64| -> Result<u32, String> {
        let mut buf = [0u8; 4];
        f.read_exact(&mut buf).map_err(|e| format!("At offset {}: {}", off, e))?;
        *off += 4;
        Ok(u32::from_le_bytes(buf))
    };
    let mut read_8 = |f: &mut std::fs::File, off: &mut u64| -> Result<u64, String> {
        let mut buf = [0u8; 8];
        f.read_exact(&mut buf).map_err(|e| format!("At offset {}: {}", off, e))?;
        *off += 8;
        Ok(u64::from_le_bytes(buf))
    };

    let _version = read_4(&mut f, &mut offset)?;
    let tensor_count = read_8(&mut f, &mut offset)?;
    let metadata_count = read_8(&mut f, &mut offset)?;

    // ── Metadata KV pairs ──
    for _ in 0..metadata_count {
        // Read key string
        let key_len = read_8(&mut f, &mut offset)?;
        if key_len > 10_000_000 {
            return Err(format!("Key length {} at offset {} exceeds sanity limit", key_len, offset));
        }
        let mut buf = vec![0u8; key_len as usize];
        f.read_exact(&mut buf).map_err(|e| format!("At offset {}: {}", offset, e))?;
        offset += key_len;

        let value_type = read_4(&mut f, &mut offset)?;
        skip_value_raw(&mut f, &mut offset, value_type)?;
    }

    // ── Tensor info entries ──
    for i in 0..tensor_count {
        // Name string
        let name_len = read_8(&mut f, &mut offset)?;
        if name_len > 10_000 {
            return Err(format!("Tensor[{}] name length {} exceeds sanity limit", i, name_len));
        }
        let mut buf = vec![0u8; name_len as usize];
        f.read_exact(&mut buf).map_err(|e| format!("At offset {}: {}", offset, e))?;
        offset += name_len;

        // dim_count = u32 (4 bytes)
        let dim_count = read_4(&mut f, &mut offset)? as u64;
        if dim_count > 100 {
            return Err(format!(
                "Tensor[{}]: dim_count={} exceeds sanity limit (max 100)",
                i, dim_count
            ));
        }
        for _ in 0..dim_count {
            read_8(&mut f, &mut offset)?;
        }
        read_8(&mut f, &mut offset)?; // offset within data section
        read_8(&mut f, &mut offset)?; // size
    }

    Ok(offset)
}

/// Skip one GGUF metadata value. Called from `find_header_end_from_file`.
fn skip_value_raw(
    f: &mut std::fs::File,
    offset: &mut u64,
    value_type: u32,
) -> Result<(), String> {
    use std::io::Read;

    match value_type {
        0 | 1 | 7 => {
            let mut buf = [0u8; 1];
            f.read_exact(&mut buf).map_err(|e| e.to_string())?;
            *offset += 1;
            Ok(())
        }
        2 | 3 => {
            let mut buf = [0u8; 2];
            f.read_exact(&mut buf).map_err(|e| e.to_string())?;
            *offset += 2;
            Ok(())
        }
        4 | 5 | 6 => {
            let mut buf = [0u8; 4];
            f.read_exact(&mut buf).map_err(|e| e.to_string())?;
            *offset += 4;
            Ok(())
        }
        8 => {
            // String
            let mut buf = [0u8; 8];
            f.read_exact(&mut buf).map_err(|e| e.to_string())?;
            *offset += 8;
            let len = u64::from_le_bytes(buf);
            if len > 10_000_000 {
                return Err(format!("String length {} at offset {} exceeds sanity limit", len, *offset));
            }
            let mut buf = vec![0u8; len as usize];
            f.read_exact(&mut buf).map_err(|e| e.to_string())?;
            *offset += len;
            Ok(())
        }
        9 | 13 => {
            // Array: elem_type (u32) + count (u64) + elements
            let mut buf = [0u8; 4];
            f.read_exact(&mut buf).map_err(|e| e.to_string())?;
            *offset += 4;
            let elem_type = u32::from_le_bytes(buf);

            let mut buf = [0u8; 8];
            f.read_exact(&mut buf).map_err(|e| e.to_string())?;
            *offset += 8;
            let count = u64::from_le_bytes(buf);

            for _ in 0..count {
                skip_value_raw(f, offset, elem_type)?;
            }
            Ok(())
        }
        10 | 11 => {
            let mut buf = [0u8; 8];
            f.read_exact(&mut buf).map_err(|e| e.to_string())?;
            *offset += 8;
            Ok(())
        }
        12 => {
            let mut buf = [0u8; 2];
            f.read_exact(&mut buf).map_err(|e| e.to_string())?;
            *offset += 2;
            Ok(())
        }
        _ => {
            let mut buf = [0u8; 4];
            f.read_exact(&mut buf).map_err(|e| e.to_string())?;
            *offset += 4;
            Ok(())
        }
    }
}

/// Download a byte range from a remote URL via HTTP Range request.
async fn download_range(url: &str, start: u64, end: u64) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(url)
        .header("Range", format!("bytes={}-{}", start, end))
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;
    if !resp.status().is_success() && resp.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(format!(
            "HTTP {} (expected 206 Partial Content): {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        ));
    }
    Ok(resp.bytes().await.map_err(|e| format!("Failed to read response: {}", e))?.to_vec())
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
    let local_path = Path::new(local_path);

    let local_size = match std::fs::metadata(local_path) {
        Ok(m) => m.len(),
        Err(e) => return PatchResult::Error(format!("Failed to get file size: {}", e)),
    };

    if local_size != remote_total_size {
        return PatchResult::RequiresFullDownload {
            reason: format!(
                "File size changed: local={}, remote={}. Tensor data was modified.",
                local_size, remote_total_size
            ),
        };
    }

    // 1. Find header_end by parsing the local file directly
    let local_header_end = match find_header_end_from_file(
        &local_path.to_string_lossy()
    ) {
        Ok(offset) => offset,
        Err(e) => return PatchResult::Error(format!("Failed to parse local GGUF header: {}", e)),
    };

    if local_header_end >= local_size {
        return PatchResult::Error("Local file has no tensor data — cannot patch".into());
    }

    // 2. Download remote header section via HTTP Range
    let remote_header = match download_range(remote_url, 0, local_header_end).await {
        Ok(b) => b,
        Err(e) => return PatchResult::Error(format!("Failed to download remote header: {}", e)),
    };

    // 3. Read local header section for comparison
    let mut local_header = vec![0u8; local_header_end as usize];
    {
        let mut f = match std::fs::File::open(local_path) {
            Ok(f) => f,
            Err(e) => return PatchResult::Error(format!("Failed to open local file: {}", e)),
        };
        if let Err(e) = f.read_exact(&mut local_header) {
            return PatchResult::Error(format!("Failed to read local header: {}", e));
        }
    }

    // 4. Compare
    if local_header == remote_header {
        return PatchResult::AlreadyCurrent;
    }

    // 5. Write remote header to temp file and parse its header_end
    let remote_header_end = {
        let tmp_path = Path::new(local_path).with_extension("gguf.remote-header");
        match std::fs::write(&tmp_path, &remote_header) {
            Ok(()) => {
                let result = find_header_end_from_file(
                    &tmp_path.to_string_lossy()
                );
                let _ = std::fs::remove_file(&tmp_path);
                result
            }
            Err(e) => {
                log::warn!("[gguf-patch] Failed to write temp header file: {}", e);
                Err(e.to_string())
            }
        }
    };

    match remote_header_end {
        Ok(remote_end) if remote_end == local_header_end => {
            // Same-length header change — splice in-place
            match patch_in_place(local_path, &remote_header, local_header_end) {
                Ok(()) => PatchResult::Patched {
                    header_bytes_downloaded: remote_header.len() as u64,
                    local_io_bytes: local_header_end,
                },
                Err(e) => PatchResult::Error(format!("Failed to patch in-place: {}", e)),
            }
        }
        Ok(remote_end) => {
            // Different-length header change — need to shift tensor data.
            let mut full_remote = remote_header;
            if remote_end > local_header_end {
                // Download the extra bytes
                match download_range(remote_url, local_header_end, remote_end).await {
                    Ok(b) => full_remote.extend_from_slice(&b),
                    Err(e) => return PatchResult::Error(format!("Failed to download extended header: {}", e)),
                }
            }
            full_remote.truncate(remote_end as usize);

            match patch_with_shift(local_path, &full_remote, local_header_end, remote_end, local_size) {
                Ok(()) => PatchResult::Patched {
                    header_bytes_downloaded: full_remote.len() as u64,
                    local_io_bytes: local_size,
                },
                Err(e) => PatchResult::Error(format!("Failed to patch with shift: {}", e)),
            }
        }
        Err(e) => {
            // Couldn't parse remote header — fall back to same-length assumption.
            log::warn!(
                "[gguf-patch] Failed to parse remote header ({}), assuming same-length patch",
                e
            );
            match patch_in_place(local_path, &remote_header, local_header_end) {
                Ok(()) => PatchResult::Patched {
                    header_bytes_downloaded: remote_header.len() as u64,
                    local_io_bytes: local_header_end,
                },
                Err(e) => PatchResult::Error(format!("Failed to patch in-place: {}", e)),
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
