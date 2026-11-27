//! GGUF header + metadata + tensor-info parser.
//!
//! Walks the GGUF v2/v3 header in-process (no engine spawn) for `gguf_meta`,
//! `gguf_shape`, `layer_plan`, `companions`, and `vram_profile`.
//!
//! Tensor-info layout (GGUF v2/v3) — there is **no** stored tensor size:
//!   name (u64 len + bytes) + n_dims (u32) + dims[n_dims] (u64) + type (u32) + offset (u64)
//! Tensor data then starts at `align(end_of_tensor_infos, general.alignment)` (default 32).

use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::path::Path;

pub(crate) const GGUF_DEFAULT_ALIGNMENT: u64 = 32;
const MAX_METADATA_STRING: u64 = 10_000_000;
const MAX_TENSOR_NAME: u64 = 10_000;
const MAX_DIMS: u32 = 8;

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

    fn read_string(&mut self, what: &str, max_len: u64) -> Result<String, String> {
        let bytes = self.skip_string(what, max_len)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    /// Advance past `n` bytes without allocating. Bulk payload (tokenizer vocabularies)
    /// is tens of MB; reading it element-by-element cost ~1.6 s per model.
    fn skip_bytes(&mut self, n: u64) -> Result<(), String> {
        let mut buf = [0u8; 16 * 1024];
        let mut left = n;
        while left > 0 {
            let take = left.min(buf.len() as u64) as usize;
            self.inner
                .read_exact(&mut buf[..take])
                .map_err(|e| format!("At offset {}: {}", self.offset, e))?;
            self.offset += take as u64;
            left -= take as u64;
        }
        Ok(())
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

    /// Length-checked string skip: same limits, no allocation.
    fn skip_string_bytes(&mut self, what: &str, max_len: u64) -> Result<(), String> {
        let len = self.read_u64()?;
        if len > max_len {
            return Err(format!(
                "{} length {} at offset {} exceeds sanity limit {}",
                what, len, self.offset, max_len
            ));
        }
        self.skip_bytes(len)
    }
}

pub(crate) fn align_offset(offset: u64, alignment: u64) -> u64 {
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

/// One GGUF KV value, typed. Mirrors the wire types the format defines.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum KvValue {
    Int(i64),
    Float(f64),
    Str(String),
    Bool(bool),
    IntArray(Vec<i64>),
    /// Small string arrays only (`general.tags`). Vocabularies go through `is_bulk_kv`.
    StrArray(Vec<String>),
}

/// KV keys whose value is bulk payload, not metadata: tokenizer vocabularies.
/// They are skipped by length, never materialised.
fn is_bulk_kv(key: &str) -> bool {
    matches!(
        key,
        "tokenizer.ggml.tokens" | "tokenizer.ggml.token_type" | "tokenizer.ggml.merges"
    )
}

/// Read one KV value into a typed `KvValue`, always consuming the stream exactly.
/// Returns `None` for shapes we do not keep (non-integer arrays) after skipping them.
fn read_kv_value<R: Read>(
    r: &mut GgufReader<R>,
    value_type: u32,
    key: &str,
) -> Result<Option<KvValue>, String> {
    if is_bulk_kv(key) {
        skip_value(r, value_type)?;
        return Ok(None);
    }
    Ok(match value_type {
        0 => Some(KvValue::Int(r.read_exact(1)?[0] as i64)),
        1 => Some(KvValue::Int(r.read_exact(1)?[0] as i8 as i64)),
        2 => Some(KvValue::Int(u16::from_le_bytes(r.read_exact(2)?.try_into().unwrap()) as i64)),
        3 => Some(KvValue::Int(i16::from_le_bytes(r.read_exact(2)?.try_into().unwrap()) as i64)),
        4 => Some(KvValue::Int(u32::from_le_bytes(r.read_exact(4)?.try_into().unwrap()) as i64)),
        5 => Some(KvValue::Int(i32::from_le_bytes(r.read_exact(4)?.try_into().unwrap()) as i64)),
        6 => Some(KvValue::Float(
            f32::from_le_bytes(r.read_exact(4)?.try_into().unwrap()) as f64,
        )),
        7 => Some(KvValue::Bool(r.read_exact(1)?[0] != 0)),
        8 => Some(KvValue::Str(r.read_string("Metadata value", MAX_METADATA_STRING)?)),
        9 => {
            let elem_type = r.read_u32()?;
            let count = r.read_u64()?;
            if count > 50_000_000 {
                return Err(format!(
                    "Array count {} at offset {} exceeds sanity limit",
                    count, r.offset
                ));
            }
            if matches!(elem_type, 4 | 5 | 10 | 11) {
                // Huge int arrays (e.g. an Engram token map) are not metadata we keep;
                // skipping them wholesale keeps the scan at header speed.
                if count > 4_096 {
                    let width = fixed_width(elem_type).unwrap_or(4) as u64;
                    r.skip_bytes(count.saturating_mul(width))?;
                    Some(KvValue::IntArray(Vec::new()))
                } else {
                    let mut out = Vec::with_capacity(count as usize);
                    for _ in 0..count {
                        out.push(read_int_value(r, elem_type)?);
                    }
                    Some(KvValue::IntArray(out))
                }
            } else if elem_type == 8 && count <= 1_024 {
                let mut out = Vec::with_capacity(count as usize);
                for _ in 0..count {
                    out.push(r.read_string("String array element", MAX_METADATA_STRING)?);
                }
                Some(KvValue::StrArray(out))
            } else {
                // Float arrays and bulk string arrays are not metadata we keep.
                for _ in 0..count {
                    skip_value(r, elem_type)?;
                }
                None
            }
        }
        10 => Some(KvValue::Int(u64::from_le_bytes(r.read_exact(8)?.try_into().unwrap()) as i64)),
        11 => Some(KvValue::Int(i64::from_le_bytes(r.read_exact(8)?.try_into().unwrap()))),
        12 => Some(KvValue::Float(f64::from_le_bytes(
            r.read_exact(8)?.try_into().unwrap(),
        ))),
        other => return Err(format!("Unsupported KV value type {other} at offset {}", r.offset)),
    })
}

/// One tensor-info record from the header table. No tensor data is touched —
/// `data_offset` is relative to `header_end`, and GGUF stores no tensor size.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TensorInfo {
    pub(crate) name: String,
    pub(crate) dims: Vec<u64>,
    /// `ggml_type` discriminant.
    pub(crate) ggml_type: u32,
    pub(crate) data_offset: u64,
}

/// What a GGUF header walk yields. `gguf_shape` consumes this; the patcher only
/// needs `header_end`, so it reads nothing beyond the KVs it must honour.
#[derive(Debug, Clone, Default)]
pub(crate) struct HeaderFacts {
    pub(crate) tensor_count: u64,
    pub(crate) alignment: u64,
    /// Offset where tensor data starts (after alignment padding).
    pub(crate) header_end: u64,
    /// `general.architecture`, when present.
    pub(crate) architecture: Option<String>,
    /// `<arch>.block_count`, when present.
    pub(crate) block_count: Option<i64>,
    /// Author sampler recommendation from `general.sampling.*`. Kept because the
    /// catalog scan cannot be trusted to deliver these (it missed them for one
    /// s hard model); they are two floats in the header we already walk.
    pub(crate) sampling_temp: Option<f64>,
    pub(crate) sampling_top_p: Option<f64>,
    pub(crate) sampling_top_k: Option<f64>,
    pub(crate) sampling_min_p: Option<f64>,
    /// String KVs for the two keys above only — everything else is skipped, not
    /// materialised.
    pub(crate) kv_strings: HashMap<String, String>,
    /// Integer KVs for the two keys above only.
    pub(crate) kv_ints: HashMap<String, i64>,
    /// `<arch>.ple.layers` array KVs (int elements) — the PLE layer list. Captured
    /// because `gguf_shape` needs the element count; every other array KV is skipped.
    pub(crate) kv_int_arrays: HashMap<String, Vec<i64>>,
    /// `general.architecture` plus every `<arch>.block_count` key seen. `gguf_shape`
    /// uses it to detect a non-registry architecture (e.g. a private `qwen4exp-mtp`,
    /// which shares the `qwen4exp` KV prefix but is not the `qwen4exp` arch).
    pub(crate) arch_keys: Vec<String>,
    /// Every non-bulk KV in the header, typed. The stderr scraper this replaces is
    /// lossy (it delivered 70 of 96 keys for one real model); this map is the file.
    /// The three giant tokenizer arrays stay out — a 129k-entry string array is not
    /// metadata anyone needs, and `skip_value` still consumes it to stay aligned.
    pub(crate) kv_all: HashMap<String, KvValue>,
    pub(crate) tensors: Vec<TensorInfo>,
}

/// Parse a GGUF header from any reader: the metadata KVs of interest plus every
/// tensor-info record, and the offset where tensor data starts.
pub(crate) fn parse_header<R: Read>(reader: R) -> Result<HeaderFacts, String> {
    let mut r = GgufReader::new(reader);

    let magic = r.read_exact(4)?;
    if magic != b"GGUF" {
        return Err("Not a GGUF file".into());
    }

    let version = r.read_u32()?;
    if !(2..=3).contains(&version) {
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

    let mut facts = HeaderFacts {
        tensor_count,
        alignment: GGUF_DEFAULT_ALIGNMENT,
        ..HeaderFacts::default()
    };

    for i in 0..metadata_count {
        let key = r.read_string(&format!("Metadata[{}] key", i), MAX_METADATA_STRING)?;
        let value_type = r.read_u32()?;
        // One read for every KV: keep it typed, then derive the handful of facts the
        // callers need. Nothing is skipped except the bulk tokenizer arrays.
        let Some(value) = read_kv_value(&mut r, value_type, &key)? else {
            continue;
        };
        match (&*key, &value) {
            ("general.alignment", KvValue::Int(n)) => facts.alignment = *n as u64,
            ("general.architecture", KvValue::Str(s)) => {
                facts.architecture = Some(s.clone());
                facts.kv_strings.insert(key.clone(), s.clone());
                facts.arch_keys.push(s.clone());
            }
            (k, KvValue::Int(n)) if k.ends_with(".block_count") => {
                facts.block_count = Some(*n);
                facts.kv_ints.insert(key.clone(), *n);
                facts.arch_keys.push(key.clone());
            }
            // Attention geometry: needed to size the KV cache from metadata. Small ints,
            // and the head size cannot be derived from n_embd / n_head on every arch.
            (k, KvValue::Int(n))
                if k.ends_with(".attention.head_count")
                    || k.ends_with(".attention.head_count_kv")
                    || k.ends_with(".attention.key_length")
                    || k.ends_with(".attention.value_length")
                    || k.ends_with(".embedding_length") =>
            {
                facts.kv_ints.insert(key.clone(), *n);
            }
            (k, KvValue::IntArray(a)) if k.ends_with(".ple.layers") => {
                facts.kv_int_arrays.insert(key.clone(), a.clone());
            }
            (k, _) if k.starts_with("general.sampling.") => {
                // f32 (temp/top_p) and int (top_k) both appear in the wild.
                let as_f64 = match &value {
                    KvValue::Float(f) => Some(*f),
                    KvValue::Int(n) => Some(*n as f64),
                    _ => None,
                };
                if let Some(v) = as_f64 {
                    match k {
                        "general.sampling.temp" => facts.sampling_temp = Some(v),
                        "general.sampling.top_p" => facts.sampling_top_p = Some(v),
                        "general.sampling.top_k" => facts.sampling_top_k = Some(v),
                        "general.sampling.min_p" => facts.sampling_min_p = Some(v),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        facts.kv_all.insert(key, value);
    }

    // The arch KV may be absent or unreadable; fall back to the first
    // `<arch>.block_count` key seen.
    if facts.architecture.is_none() {
        if let Some(key) = facts.kv_ints.keys().find(|k| k.ends_with(".block_count")) {
            facts.architecture = Some(key[..key.len() - ".block_count".len()].to_string());
        }
    }

    facts.tensors.reserve(facts.tensor_count.min(4096) as usize);
    for i in 0..tensor_count {
        let name_len = r.read_u64()?;
        if name_len > MAX_TENSOR_NAME {
            return Err(format!(
                "Tensor[{}] name length {} exceeds sanity limit",
                i, name_len
            ));
        }
        let name_bytes = r.read_exact(name_len as usize)?;
        let name = String::from_utf8_lossy(&name_bytes).into_owned();

        let n_dims = r.read_u32()?;
        if n_dims > MAX_DIMS {
            return Err(format!(
                "Tensor[{}]: n_dims={} exceeds sanity limit (max {})",
                i, n_dims, MAX_DIMS
            ));
        }
        let mut dims = Vec::with_capacity(n_dims as usize);
        for _ in 0..n_dims {
            dims.push(r.read_u64()?);
        }
        // ggml_type — uint32. Previous parser skipped this and then read a
        // non-existent u64 "size", which desynced at Tensor[1].
        let ggml_type = r.read_u32()?;
        let data_offset = r.read_u64()?;

        facts.tensors.push(TensorInfo {
            name,
            dims,
            ggml_type,
            data_offset,
        });
    }

    facts.header_end = align_offset(r.offset, facts.alignment);
    Ok(facts)
}

/// Parse a GGUF header from any reader and return the file offset where tensor
/// data starts (after alignment padding).
fn parse_header_end<R: Read>(reader: R) -> Result<u64, String> {
    parse_header(reader).map(|facts| facts.header_end)
}

fn find_header_end_from_file(model_path: &str) -> Result<u64, String> {
    if !Path::new(model_path).exists() {
        return Err(format!("Model file not found: {}", model_path));
    }
    let f = std::fs::File::open(model_path).map_err(|e| format!("Failed to open file: {}", e))?;
    parse_header_end(f)
}

/// Open a file and walk its header, returning the facts `gguf_shape` needs.
pub(crate) fn parse_header_from_file(path: &Path) -> Result<HeaderFacts, String> {
    if !path.exists() {
        return Err(format!("Model file not found: {}", path.display()));
    }
    let f = std::fs::File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
    // Buffered: the walk does hundreds of thousands of small reads (every KV element,
    // every tensor name/dim). Unbuffered, each one was a syscall and a model took ~1.5 s.
    parse_header(std::io::BufReader::with_capacity(1 << 20, f))
}

pub(crate) fn find_header_end_from_bytes(bytes: &[u8]) -> Result<u64, String> {
    parse_header_end(Cursor::new(bytes))
}



fn read_int_value<R: Read>(r: &mut GgufReader<R>, value_type: u32) -> Result<i64, String> {
    match value_type {
        4 => Ok(r.read_u32()? as i64), // UINT32
        5 => Ok(r.read_u32()? as i32 as i64), // INT32
        10 => Ok(r.read_u64()? as i64), // UINT64
        11 => r.read_u64().map(|v| v as i64), // INT64
        other => Err(format!(
            "Unexpected value type {other} for integer KV at offset {}",
            r.offset
        )),
    }
}



fn skip_value<R: Read>(r: &mut GgufReader<R>, value_type: u32) -> Result<(), String> {
    match value_type {
        0 | 1 | 7 => r.skip_bytes(1),
        2 | 3 => r.skip_bytes(2),
        4..=6 => r.skip_bytes(4),
        8 => r.skip_string_bytes("String", MAX_METADATA_STRING),
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
            // Fixed-width elements skip in one go; only strings need a walk.
            if let Some(width) = fixed_width(elem_type) {
                return r.skip_bytes(count.saturating_mul(width as u64));
            }
            for _ in 0..count {
                skip_value(r, elem_type)?;
            }
            Ok(())
        }
        10..=12 => r.skip_bytes(8),
        other => Err(format!(
            "Unknown GGUF metadata value type {} at offset {}",
            other, r.offset
        )),
    }
}

/// Byte width of a fixed-size GGUF scalar type, if it has one.
fn fixed_width(value_type: u32) -> Option<u32> {
    match value_type {
        0 | 1 | 7 => Some(1),
        2 | 3 => Some(2),
        4..=6 => Some(4),
        10..=12 => Some(8),
        _ => None,
    }
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
