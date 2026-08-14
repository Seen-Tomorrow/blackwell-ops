//! GGUF metadata patching — download only the header+metadata section from HF
//! via HTTP Range, compare with the local file, and patch in-place when the
//! tensor data region is unchanged.
//!
//! Only handles **metadata-only changes** (jinja template, EULA, etc.).
//! Tensor weight changes still require a full re-download.

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

// ── GGUF binary reader ────────────────────────────────────────────────

struct GgufReader<R: Read + Seek> {
    reader: R,
    offset: u64,
    file_size: u64,
}

impl<R: Read + Seek> GgufReader<R> {
    fn new(mut reader: R) -> Result<Self, String> {
        let file_size = reader.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
        reader.rewind().map_err(|e| e.to_string())?;
        Ok(Self { reader, offset: 0, file_size })
    }

    fn remaining(&self) -> u64 {
        self.file_size.saturating_sub(self.offset)
    }

    fn current_pos(&mut self) -> Result<u64, String> {
        let pos = self.reader.seek(SeekFrom::Current(0)).map_err(|e| e.to_string())?;
        self.offset = pos;
        Ok(pos)
    }

    fn read_bytes(&mut self, len: usize) -> Result<Vec<u8>, String> {
        if (len as u64) > self.remaining() {
            return Err(format!(
                "Requested {} bytes at offset {} but only {} remain in file",
                len, self.offset, self.remaining()
            ));
        }
        let mut buf = vec![0u8; len];
        self.reader.read_exact(&mut buf).map_err(|e| {
            format!("Failed to read {} bytes at offset {}: {}", len, self.offset, e)
        })?;
        self.offset += len as u64;
        Ok(buf)
    }

    fn read_u32(&mut self) -> Result<u32, String> {
        let buf = self.read_bytes(4)?;
        Ok(u32::from_le_bytes(buf.try_into().unwrap()))
    }

    fn read_u64(&mut self) -> Result<u64, String> {
        let buf = self.read_bytes(8)?;
        Ok(u64::from_le_bytes(buf.try_into().unwrap()))
    }

    fn read_string(&mut self) -> Result<String, String> {
        let len = self.read_u64()?;
        if len > self.remaining() {
            return Err(format!(
                "String length {} at offset {} exceeds remaining file size {}",
                len, self.offset - 8, self.remaining()
            ));
        }
        let buf = self.read_bytes(len as usize)?;
        Ok(String::from_utf8_lossy(&buf).to_string())
    }

    fn skip_value(&mut self, value_type: u32) -> Result<(), String> {
        match value_type {
            0 | 1 | 7 => { self.read_bytes(1)?; } // uint8, int8, bool
            2 | 3 => { self.read_bytes(2)?; }      // uint16, int16
            4 | 5 | 6 => { self.read_bytes(4)?; }  // uint32, int32, float32
            8 => { let _ = self.read_string(); }   // string
            9 | 10 | 11 => { self.read_bytes(8)?; } // uint64, int64, float64
            12 => { self.read_bytes(2)?; }          // float16
            13 => {                                 // array
                let elem_type = self.read_u32()?;
                let count = self.read_u64()?;
                for _ in 0..count {
                    self.skip_value(elem_type)?;
                }
            }
            _ => {
                // Unknown type — skip 4 bytes (default word size) and hope for the best.
                // Real GGUF files occasionally use undocumented types; don't hard-fail.
                log::warn!("[gguf-patch] Unknown GGUF value type {} at offset {}, skipping 4 bytes", value_type, self.offset);
                self.read_bytes(4)?;
            }
        }
        Ok(())
    }
}

/// Parse the GGUF header and return the byte offset where tensor data starts.
///
/// Everything from 0 to `header_end` is header+metadata+tensor_info.
/// Everything from `header_end` onward is padding + tensor data.
fn find_header_end<R: Read + Seek>(reader: R) -> Result<u64, String> {
    let mut gr = GgufReader::new(reader)?;

    // Magic + version
    let magic = gr.read_bytes(4)?;
    if &magic != b"GGUF" {
        return Err("Not a GGUF file (magic mismatch)".into());
    }
    let _version = gr.read_u32()?;
    let tensor_count = gr.read_u64()?;
    let metadata_count = gr.read_u64()?;

    // Skip metadata KV pairs
    for _ in 0..metadata_count {
        let _key = gr.read_string()?;
        let value_type = gr.read_u32()?;
        gr.skip_value(value_type)?;
    }

    // Tensor info entries — use tensor_count from header, no guessing needed.
    for _ in 0..tensor_count {
        let _name = gr.read_string()?;
        let dim_count = gr.read_u64()?;
        for _ in 0..dim_count {
            gr.read_u64()?;
        }
        let _tensor_offset = gr.read_u64()?;
        let _tensor_size = gr.read_u64()?;
    }

    // We've passed all tensor info entries. The current position is at the
    // start of padding/tensor-data region. Return it.
    gr.current_pos()
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

    // 1. Parse local file to find header_end offset
    let local_file = match std::fs::File::open(local_path) {
        Ok(f) => f,
        Err(e) => return PatchResult::Error(format!("Failed to open local file: {}", e)),
    };
    let local_size = match local_file.metadata() {
        Ok(m) => m.len(),
        Err(e) => return PatchResult::Error(format!("Failed to get file size: {}", e)),
    };

    let local_header_end = match find_header_end(local_file) {
        Ok(offset) => offset,
        Err(e) => return PatchResult::Error(format!("Failed to parse local GGUF header: {}", e)),
    };

    if local_header_end >= local_size {
        return PatchResult::Error("Local file has no tensor data — cannot patch".into());
    }

    if local_size != remote_total_size {
        // File sizes differ — definitely not a metadata-only change.
        // (Tensor data size would change if any weight was modified.)
        return PatchResult::RequiresFullDownload {
            reason: format!(
                "File size changed: local={}, remote={}. Tensor data was modified.",
                local_size, remote_total_size
            ),
        };
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

    // 5. Parse remote header to find its end offset
    //    We need to know if the remote header section is the same size as local.
    let remote_cursor = std::io::Cursor::new(&remote_header);
    let remote_header_end = match find_header_end(remote_cursor) {
        Ok(offset) => offset,
        Err(e) => return PatchResult::Error(format!("Failed to parse remote GGUF header: {}", e)),
    };

    if remote_header_end == local_header_end {
        // Same-length header change — splice in-place
        match patch_in_place(local_path, &remote_header, local_header_end) {
            Ok(()) => PatchResult::Patched {
                header_bytes_downloaded: remote_header.len() as u64,
                local_io_bytes: local_header_end,
            },
            Err(e) => PatchResult::Error(format!("Failed to patch in-place: {}", e)),
        }
    } else {
        // Different-length header change — need to shift tensor data.
        // We need to download the full remote header (at its actual size).
        // We already downloaded up to local_header_end; we need the rest.
        let extra_remote = if remote_header_end > local_header_end {
            // Remote header is larger — download the extra bytes
            match download_range(remote_url, local_header_end, remote_header_end).await {
                Ok(b) => b,
                Err(e) => return PatchResult::Error(format!("Failed to download extended remote header: {}", e)),
            }
        } else {
            Vec::new() // Remote header is smaller — we already downloaded enough
        };

        let mut full_remote_header = remote_header;
        if remote_header_end > local_header_end {
            full_remote_header.extend_from_slice(&extra_remote);
        }
        // Truncate to actual remote header size
        full_remote_header.truncate(remote_header_end as usize);

        // Shift tensor data and write new file
        match patch_with_shift(local_path, &full_remote_header, local_header_end, remote_header_end, local_size) {
            Ok(()) => PatchResult::Patched {
                header_bytes_downloaded: full_remote_header.len() as u64,
                local_io_bytes: local_size, // read + write the entire file
            },
            Err(e) => PatchResult::Error(format!("Failed to patch with shift: {}", e)),
        }
    }
}

/// Splice new header bytes into the local file in-place.
/// The header section is exactly the same byte length as the old one.
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
    new_header_end: u64,
    total_size: u64,
) -> Result<(), String> {
    use std::io::Write;

    let tmp_path = path.with_extension("gguf.patch-tmp");

    let tensor_data_size = total_size - old_header_end;

    let mut reader = std::fs::File::open(path).map_err(|e| format!("Failed to open for reading: {}", e))?;
    let mut writer = std::fs::File::create(&tmp_path).map_err(|e| format!("Failed to create temp file: {}", e))?;

    // Write new header
    writer.write_all(new_header).map_err(|e| format!("Failed to write new header: {}", e))?;

    // Stream tensor data from old file at old offset
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

    // Rename temp file over original
    std::fs::rename(&tmp_path, path).map_err(|e| format!("Failed to rename temp file: {}", e))?;

    log::info!(
        "[gguf-patch] Shifted tensor data (old header_end={}, new={}, tensor_size={})",
        old_header_end,
        new_header_end,
        tensor_data_size
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// Build a minimal valid GGUF file with known header_end.
    fn make_minimal_gguf() -> Vec<u8> {
        let mut buf = Vec::new();

        // Magic + version (v3)
        buf.extend_from_slice(b"GGUF");
        buf.extend_from_slice(&3u32.to_le_bytes()); // version
        buf.extend_from_slice(&0u64.to_le_bytes()); // tensor_count = 0
        buf.extend_from_slice(&0u64.to_le_bytes()); // metadata_count = 0

        // No metadata, no tensors → header_end = 24
        buf
    }

    #[test]
    fn find_header_end_empty_file() {
        let gguf = make_minimal_gguf();
        let cursor = Cursor::new(&gguf);
        let end = find_header_end(cursor).unwrap();
        assert_eq!(end, 24, "Empty GGUF should have header_end = 24");
    }

    #[test]
    fn find_header_end_with_metadata() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"GGUF");
        buf.extend_from_slice(&3u32.to_le_bytes()); // version
        buf.extend_from_slice(&0u64.to_le_bytes()); // tensor_count
        buf.extend_from_slice(&1u64.to_le_bytes()); // metadata_count = 1

        // One metadata KV: key = "test", value = string "hello"
        let key = "test";
        buf.extend_from_slice(&(key.len() as u64).to_le_bytes());
        buf.extend_from_slice(key.as_bytes());
        buf.extend_from_slice(&8u32.to_le_bytes()); // value_type = string
        let val = "hello";
        buf.extend_from_slice(&(val.len() as u64).to_le_bytes());
        buf.extend_from_slice(val.as_bytes());

        // No tensors → header_end should be at current position
        let expected_end = buf.len() as u64;
        let cursor = Cursor::new(&buf);
        let end = find_header_end(cursor).unwrap();
        assert_eq!(end, expected_end, "Header end should be after metadata");
    }

    #[test]
    fn not_gguf_rejected() {
        let buf = b"NOTG GUF!";
        let cursor = Cursor::new(buf);
        assert!(find_header_end(cursor).is_err());
    }

    #[test]
    fn header_end_with_tensors() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"GGUF");
        buf.extend_from_slice(&3u32.to_le_bytes()); // version
        buf.extend_from_slice(&1u64.to_le_bytes()); // tensor_count = 1
        buf.extend_from_slice(&0u64.to_le_bytes()); // metadata_count = 0

        // One tensor info entry
        let name = "weight_0";
        buf.extend_from_slice(&(name.len() as u64).to_le_bytes());
        buf.extend_from_slice(name.as_bytes());
        buf.extend_from_slice(&2u64.to_le_bytes()); // dim_count = 2
        buf.extend_from_slice(&4u64.to_le_bytes()); // dim[0] = 4
        buf.extend_from_slice(&4u64.to_le_bytes()); // dim[1] = 4
        buf.extend_from_slice(&0u64.to_le_bytes()); // offset (not used for header_end)
        buf.extend_from_slice(&64u64.to_le_bytes()); // size = 64

        let expected_end = buf.len() as u64;
        let cursor = Cursor::new(&buf);
        let end = find_header_end(cursor).unwrap();
        assert_eq!(end, expected_end, "Header end should be after tensor info");
    }
}
