//! Header-only facts about a GGUF file, read from the **tensor-info table**.
//!
//! Tensor *names* are where the signals that distinguish a speculative draft live
//! (`blk.N.nextn.*`, `markov_w1.weight`, trunk tensors), and they exist only in the
//! header. This module walks the same header `gguf_patch.rs` already walks (via
//! `gguf_patch::parse_header`, not a second parser) and reports structure only. No
//! tensor data touched, no engine spawned.
//!
//! Facts only — the role decision lives in the classifier (step 2), not here.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::gguf_patch;

/// Header-only facts about a GGUF file, read from the tensor-info table.
/// No tensor data touched, no engine spawned.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct GgufShape {
    /// Architecture name (e.g. "qwen35", "dflash", "dflash-draft").
    #[serde(default)]
    pub architecture: String,
    /// `<arch>.block_count` KV — the discriminator between a target and a draft.
    #[serde(default)]
    pub block_count: u32,
    /// max N over `blk.N.nextn.*` tensor names; 0 = no nextn tensors seen.
    #[serde(default, rename = "nextnLayers")]
    pub nextn_layers: u32,
    /// DFlash family head variant (`"dflash" | "dflash2" | "dspark" | "lilicorr"`),
    /// mirroring `llama_model_dflash::load_arch_hparams` (llama.cpp PR #32016).
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "dflashVariant")]
    pub dflash_variant: Option<String>,
    /// `<arch>.embedding_length` KV — hard physics check for pairing a draft with a target.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "embeddingLength")]
    pub embedding_length: Option<u32>,
    /// Max target layer index declared in `<arch>.target_layers` on a DFlash-family draft.
    /// Must be strictly less than the target model's layer count.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "dflashMaxTargetLayer")]
    pub dflash_max_target_layer: Option<u32>,
    /// `<arch>.hyper_connection.count` when > 0 (DeepSeek-V4/V4.1 targets and their DSpark drafts).
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "hyperConnectionCount")]
    pub hyper_connection_count: Option<u32>,
    /// Full layer stack present (an external MTP draft is a truncated copy).
    #[serde(default, rename = "hasTrunk")]
    pub has_trunk: bool,
    /// An embedding/output tensor is present. Replaces the broken
    /// `vocab_size == 0` heuristic the old stderr scrape produced.
    #[serde(default, rename = "hasVocab")]
    pub has_vocab: bool,
    /// 1 for a single file; >1 for a shard set.
    #[serde(default)]
    pub shard_count: u32,
    /// Tensor count from the header (this split only).
    #[serde(default)]
    pub tensor_count: u64,
    /// `general.alignment`, or the GGUF default of 32.
    #[serde(default)]
    pub alignment: u64,
    /// The header declares an architecture the llama.cpp registry does not know —
    /// `general.architecture` and every `<arch>.block_count` prefix disagree (e.g.
    /// the private `mtp-q2_0.gguf`: `general.architecture = qwen4exp-mtp`, KVs under
    /// `qwen4exp.*`). Such a file is private-format material: no engine load, no
    /// draft role. See `spec_draft::classify_draft_role` tier 0.
    #[serde(default, rename = "archMismatch")]
    pub arch_mismatch: bool,
    /// Offset where tensor data starts (alignment-padded).
    #[serde(default)]
    pub header_end: u64,
    /// Bytes of the host-resident lookup table (`per_layer_token_embd.weight`).
    /// DeepSeek Engram and Qwen PLE both land on that one tensor name, and llama.cpp
    /// marks it `TENSOR_READ_LAZY`: it lives on the host by design, never in VRAM.
    #[serde(default, rename = "lookupTableBytes")]
    pub lookup_table_bytes: u64,
    /// Dims of the lookup table tensor. This is the table's **identity across
    /// precisions and publishers**: DeepSeek-V4.1 ships 256 x 768,022,850 at IQ4_NL,
    /// Q5_K, Q6_K and MXFP8, and Qwen3.8-Flash-Next ships 160 x 320,001,536 at four
    /// other precisions — same geometry, different quant.
    #[serde(default, rename = "lookupDims", skip_serializing_if = "Option::is_none")]
    pub lookup_dims: Option<Vec<u64>>,
    /// `general.type` when the file declares one (`model`, `mmproj`, `adapter`).
    /// Absent on PLE/Engram tables and on some converter output — never required.
    #[serde(default, rename = "generalType", skip_serializing_if = "Option::is_none")]
    pub general_type: Option<String>,
    /// `split.no` — this file's 0-based index inside a sharded set.
    #[serde(default, rename = "splitNo", skip_serializing_if = "Option::is_none")]
    pub split_no: Option<u32>,
    /// `split.count` — how many files the set declares. Authoritative over the
    /// `-0000i-of-0000N` filename, which is what the old completeness check read.
    #[serde(default, rename = "splitCount", skip_serializing_if = "Option::is_none")]
    pub split_count: Option<u32>,
    /// `split.tensors.count` — tensors across the whole set. A set is complete when
    /// the registered tensors match this, which survives renamed/renumbered shards.
    #[serde(default, rename = "tensorsDeclared", skip_serializing_if = "Option::is_none")]
    pub tensors_declared: Option<u64>,
    /// Author sampler recommendation from `general.sampling.*`, when the file has one.
    /// Read in-process so the M DEFAULTS preset never depends on the catalog scan.
    #[serde(default, rename = "samplingTemp")]
    pub sampling_temp: Option<f64>,
    #[serde(default, rename = "samplingTopP")]
    pub sampling_top_p: Option<f64>,
    #[serde(default, rename = "samplingTopK")]
    pub sampling_top_k: Option<f64>,
    #[serde(default, rename = "samplingMinP")]
    pub sampling_min_p: Option<f64>,
}

/// Tensor names that mean an embedding/output head is present.
const VOCAB_TENSOR_NAMES: [&str; 4] = [
    "token_embd.weight",
    "token_embd_nosp.weight",
    "output.weight",
    "tok_embd.weight",
];

/// Read one GGUF file's shape.
pub fn read_shape(path: &Path) -> Result<GgufShape, String> {
    let facts = gguf_patch::parse_header_from_file(path)?;
    Ok(shape_from_facts(&facts, 1))
}

/// Convenience wrapper over the `&str` paths this repo passes around.
pub fn read_shape_for_path(model_path: &str) -> Result<GgufShape, String> {
    read_shape(&PathBuf::from(model_path))
}

/// Merge the shape of a split (sharded) GGUF set.
///
/// Each split carries **only its own tensor-info list**, so a sharded draft needs
/// every split's header read — a nextn tensor may live in split 3 of 5. Upstream
/// `#26814` skips sharded drafts; we do not. Still header-only.
pub fn read_shape_sharded(paths: &[PathBuf]) -> Result<GgufShape, String> {
    if paths.is_empty() {
        return Err("No shard paths given".into());
    }
    let mut merged: Option<GgufShape> = None;
    for path in paths {
        let facts = gguf_patch::parse_header_from_file(path)?;
        let shape = shape_from_facts(&facts, 1);
        match merged {
            None => merged = Some(shape),
            Some(ref mut base) => merge_into(base, shape),
        }
    }
    let mut shape = merged.expect("non-empty paths yields a merged shape");
    shape.shard_count = paths.len() as u32;
    Ok(shape)
}

fn shape_from_facts(facts: &gguf_patch::HeaderFacts, shard_count: u32) -> GgufShape {
    let architecture = facts
        .architecture
        .clone()
        .or_else(|| facts.kv_strings.get("general.architecture").cloned())
        .unwrap_or_default();

    let block_count = facts
        .block_count
        .or_else(|| {
            facts
                .kv_ints
                .iter()
                .find(|(key, _)| key.ends_with(".block_count"))
                .map(|(_, value)| *value)
        })
        .unwrap_or(0) as u32;

    let mut nextn_layers = 0u32;
    let mut nextn_seen = false;
    let mut has_markov_w1 = false;
    let mut has_selector_hidden = false;
    let mut has_trunk = false;
    let mut has_vocab = false;

    for tensor in &facts.tensors {
        let name = tensor.name.as_str();

        if name.contains(".nextn.") {
            nextn_seen = true;
            if let Some(n) = blk_index(name) {
                nextn_layers = nextn_layers.max(n.saturating_add(1));
            }
        } else if name.contains("nextn") {
            // nextn evidence without the `blk.N.` prefix — N unknown.
            nextn_seen = true;
        }

        let name_lower = name.to_ascii_lowercase();
        if name_lower.contains("markov_w1") {
            has_markov_w1 = true;
        }
        if name_lower == "selector_hidden.weight" {
            has_selector_hidden = true;
        }

        // A tensor at layer N >= 1 means the stack is not truncated to layer 0,
        // which is what a truncated draft copy looks like. `output.weight` /
        // `output_norm.weight` are the other full-stack markers.
        if let Some(n) = blk_index(name) {
            if n >= 1 {
                has_trunk = true;
            }
        } else if name == "output.weight" || name == "output_norm.weight" {
            has_trunk = true;
        }

        if VOCAB_TENSOR_NAMES.iter().any(|v| name.eq_ignore_ascii_case(v)) {
            has_vocab = true;
        }
    }

    if nextn_seen && nextn_layers == 0 {
        nextn_layers = 1;
    }

    // A registry-known arch has ONE name: `general.architecture` and every
    // `<arch>.block_count` prefix agree. They disagree only for private formats —
    // the private MTP material declares `general.architecture = qwen4exp-mtp` while
    // its KVs sit under `qwen4exp.` (the converter reuses the base arch's keys).
    // A file with no `general.architecture` at all is not judged here — the
    // block_count fallback already names it.
    let arch_mismatch = !architecture.is_empty()
        && facts.arch_keys.iter().any(|key| {
            key != "general.architecture"
                && key
                    .strip_suffix(".block_count")
                    .is_some_and(|a| a != architecture)
        });

    // Split bookkeeping: the file's own statement of where it belongs. Present on
    // metadata-only shards AND on a standalone PLE/Engram table (which declares
    // `split.no` = its slot in the set it was cut from), absent on single-file models
    // and on drafts/projectors. Filenames are not consulted — see `shard_sets`.
    let int_kv = |key: &str| match facts.kv_all.get(key) {
        Some(gguf_patch::KvValue::Int(n)) if *n >= 0 => Some(*n as u64),
        _ => None,
    };
    let general_type = match facts.kv_all.get("general.type") {
        Some(gguf_patch::KvValue::Str(s)) if !s.trim().is_empty() => Some(s.clone()),
        _ => None,
    };
    let lookup_dims = facts
        .tensors
        .iter()
        .find(|t| t.name.contains(LOOKUP_TABLE_TENSOR))
        .map(|t| t.dims.clone());

    let has_lilicorr = facts
        .kv_all
        .keys()
        .any(|k| k == "lilicorr.hidden_size" || k.ends_with(".lilicorr.hidden_size"));
    let arch_lower = architecture.trim().to_ascii_lowercase();
    let dflash_variant = if has_markov_w1 {
        Some("dspark".to_string())
    } else if has_selector_hidden {
        Some("dflash2".to_string())
    } else if has_lilicorr {
        Some("lilicorr".to_string())
    } else if arch_lower == "dflash" || arch_lower == "dflash-draft" {
        Some("dflash".to_string())
    } else {
        None
    };

    let embedding_length = facts
        .kv_ints
        .iter()
        .find(|(k, _)| k.ends_with(".embedding_length"))
        .and_then(|(_, &v)| u32::try_from(v).ok())
        .filter(|&v| v > 0);
    let dflash_max_target_layer = facts
        .kv_all
        .iter()
        .find(|(k, _)| k.ends_with(".target_layers"))
        .and_then(|(_, v)| match v {
            gguf_patch::KvValue::IntArray(arr) => arr
                .iter()
                .filter_map(|&n| u32::try_from(n).ok())
                .max(),
            _ => None,
        });
    let hyper_connection_count = facts
        .kv_all
        .iter()
        .find(|(k, _)| k.ends_with(".hyper_connection.count"))
        .and_then(|(_, v)| match v {
            gguf_patch::KvValue::Int(n) => u32::try_from(*n).ok(),
            _ => None,
        })
        .filter(|&v| v > 0);

    GgufShape {
        architecture,
        block_count,
        nextn_layers,
        dflash_variant,
        embedding_length,
        dflash_max_target_layer,
        hyper_connection_count,
        has_trunk,
        has_vocab,
        shard_count,
        tensor_count: facts.tensor_count,
        alignment: facts.alignment,
        arch_mismatch,
        header_end: facts.header_end,
        lookup_table_bytes: facts
            .tensors
            .iter()
            .filter(|t| t.name.contains(LOOKUP_TABLE_TENSOR))
            .map(tensor_bytes)
            .sum(),
        lookup_dims,
        general_type,
        split_no: int_kv("split.no").map(|n| n as u32),
        split_count: int_kv("split.count").map(|n| n as u32),
        tensors_declared: int_kv("split.tensors.count"),
        sampling_temp: facts.sampling_temp,
        sampling_top_p: facts.sampling_top_p,
        sampling_top_k: facts.sampling_top_k,
        sampling_min_p: facts.sampling_min_p,
    }
}

/// Tensor name shared by every host-resident lookup table llama.cpp knows about:
/// DeepSeek Engram, Qwen PLE, gemma3n/gemma4 per-layer embeddings.
const LOOKUP_TABLE_TENSOR: &str = "per_layer_token_embd";

/// Bytes a tensor occupies, from its GGML type block layout.
///
/// GGUF stores no size, so this mirrors `ggml_type_size / ggml_blck_size`. An unknown
/// type contributes 0 rather than a guess: under-reporting a lookup table is safer
/// than charging VRAM for bytes we cannot account for.
pub(crate) fn tensor_bytes(t: &gguf_patch::TensorInfo) -> u64 {
    let (block, size) = match t.ggml_type {
        0 => (1, 4),      // F32
        1 => (1, 2),      // F16
        2 => (32, 18),    // Q4_0
        3 => (32, 20),    // Q4_1
        6 => (32, 22),    // Q5_0
        7 => (32, 24),    // Q5_1
        8 => (32, 34),    // Q8_0
        9 => (32, 36),    // Q8_1
        10 => (256, 84),  // Q2_K
        11 => (256, 110), // Q3_K
        12 => (256, 144), // Q4_K
        13 => (256, 176), // Q5_K
        14 => (256, 210), // Q6_K
        15 => (256, 292), // Q8_K
        16 => (256, 66),  // IQ2_XXS
        17 => (256, 74),  // IQ2_XS
        18 => (256, 98),  // IQ3_XXS
        19 => (256, 50),  // IQ1_S
        20 => (32, 18),   // IQ4_NL
        21 => (256, 110), // IQ3_S
        22 => (256, 82),  // IQ2_S
        23 => (256, 136), // IQ4_XS
        24 => (1, 1),     // I8
        25 => (1, 2),     // I16
        26 => (1, 4),     // I32
        27 => (1, 8),     // I64
        28 => (1, 8),     // F64
        29 => (256, 56),  // IQ1_M
        30 => (1, 2),     // BF16
        34 => (256, 54),  // TQ1_0
        35 => (256, 66),  // TQ2_0
        39 => (32, 17),   // MXFP4
        _ => return 0,
    };
    let n_el: u64 = t.dims.iter().product();
    n_el.div_ceil(block).saturating_mul(size)
}

/// OR/max the facts of one split into the running merge.
fn merge_into(base: &mut GgufShape, split: GgufShape) {
    if base.architecture.is_empty() {
        base.architecture = split.architecture;
    }
    if base.block_count == 0 {
        base.block_count = split.block_count;
    }
    base.nextn_layers = base.nextn_layers.max(split.nextn_layers);
    base.dflash_variant = match (base.dflash_variant.take(), split.dflash_variant) {
        (Some(a), Some(b)) if a == "dflash" && b != "dflash" => Some(b),
        (Some(a), _) => Some(a),
        (None, b) => b,
    };
    base.embedding_length = base.embedding_length.or(split.embedding_length);
    base.dflash_max_target_layer = match (base.dflash_max_target_layer, split.dflash_max_target_layer) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    };
    base.hyper_connection_count = base.hyper_connection_count.or(split.hyper_connection_count);
    base.has_trunk |= split.has_trunk;
    base.has_vocab |= split.has_vocab;
    base.arch_mismatch |= split.arch_mismatch;
    base.tensor_count = base.tensor_count.saturating_add(split.tensor_count);
    base.lookup_table_bytes = base
        .lookup_table_bytes
        .saturating_add(split.lookup_table_bytes);
    // Split bookkeeping describes the SET, not one file: a metadata-only shard carries
    // it and the data shards repeat it. Keep the first non-empty answer.
    base.general_type = base.general_type.take().or(split.general_type);
    base.split_no = base.split_no.or(split.split_no);
    base.split_count = base.split_count.or(split.split_count);
    base.tensors_declared = base.tensors_declared.or(split.tensors_declared);
    base.lookup_dims = base.lookup_dims.take().or(split.lookup_dims);
    // Sampling KVs are declared once (first shard); keep the first shard that has them.
    base.sampling_temp = base.sampling_temp.or(split.sampling_temp);
    base.sampling_top_p = base.sampling_top_p.or(split.sampling_top_p);
    base.sampling_top_k = base.sampling_top_k.or(split.sampling_top_k);
    base.sampling_min_p = base.sampling_min_p.or(split.sampling_min_p);
}

/// Parse the `N` out of a `blk.N.` tensor-name prefix.
fn blk_index(name: &str) -> Option<u32> {
    let rest = name.strip_prefix("blk.")?;
    let digits_end = rest.find('.')?;
    if digits_end == 0 {
        return None;
    }
    rest[..digits_end].parse::<u32>().ok()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn lookup_table_bytes_follow_the_type_block_layout() {
        // Q5_K is 256 elements per 176-byte block. The DeepSeek-V4.1 Engram table is
        // {256, 768M rows}: 768e6 x 176 B = 128,907.7 MiB, which is what llama.cpp
        // reports at load ("size = 128910 MiB").
        let t = gguf_patch::TensorInfo {
            name: "per_layer_token_embd.weight".to_string(),
            dims: vec![256, 768_000_000],
            ggml_type: 13,
            data_offset: 0,
        };
        assert_eq!(tensor_bytes(&t), 768_000_000 * 176);
        // Row-major dims are multiplied, so the shape order cannot change the total.
        let flipped = gguf_patch::TensorInfo {
            dims: vec![768_000_000, 256],
            ..t.clone()
        };
        assert_eq!(tensor_bytes(&flipped), tensor_bytes(&t));
    }

    #[test]
    fn unknown_tensor_type_contributes_nothing() {
        let t = gguf_patch::TensorInfo {
            name: "x.weight".to_string(),
            dims: vec![1024],
            ggml_type: 9999,
            data_offset: 0,
        };
        assert_eq!(tensor_bytes(&t), 0);
    }

    use std::io::Write;

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

    fn kv_str(buf: &mut Vec<u8>, key: &str, value: &str) {
        push_str(buf, key);
        push_u32(buf, 8); // STRING
        push_str(buf, value);
    }

    fn kv_u32(buf: &mut Vec<u8>, key: &str, value: u32) {
        push_str(buf, key);
        push_u32(buf, 4); // UINT32
        push_u32(buf, value);
    }

    fn kv_int_array(buf: &mut Vec<u8>, key: &str, values: &[u32]) {
        push_str(buf, key);
        push_u32(buf, 9); // ARRAY
        push_u32(buf, 4); // element type: UINT32
        push_u64(buf, values.len() as u64);
        for v in values {
            push_u32(buf, *v);
        }
    }

    /// One tensor-info record: name + n_dims + dims + type + offset.
    fn tensor(buf: &mut Vec<u8>, name: &str, dims: &[u64]) {
        push_str(buf, name);
        push_u32(buf, dims.len() as u32);
        for d in dims {
            push_u64(buf, *d);
        }
        push_u32(buf, 0); // GGML_TYPE_F32
        push_u64(buf, 0); // offset within the data section
    }

    /// GGUF v3 with `tensor_count` KVs, `tensor_names` tensor records, padded to
    /// the default alignment and followed by a dummy payload so the file is not
    /// header-only.
    fn build_gguf(arch: &str, block_count: u32, tensor_names: &[&str]) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"GGUF");
        push_u32(&mut buf, 3); // version
        push_u64(&mut buf, tensor_names.len() as u64);
        push_u64(&mut buf, 2); // metadata_count

        kv_str(&mut buf, "general.architecture", arch);
        kv_u32(&mut buf, &format!("{arch}.block_count"), block_count);

        for name in tensor_names {
            tensor(&mut buf, name, &[4, 2]);
        }

        let aligned = gguf_patch::align_offset(buf.len() as u64, gguf_patch::GGUF_DEFAULT_ALIGNMENT);
        buf.resize(aligned as usize, 0);
        buf.extend_from_slice(&[0u8; 64]);
        buf
    }

    /// Scratch under `target/debug` — the workspace is writable from this session's
    /// integrity level, `std::env::temp_dir()` is not guaranteed to be.
    pub(crate) fn scratch_dir(tag: &str) -> PathBuf {
        let dir = crate::config::app_root_dir().join(format!(
            "gguf-shape-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    /// Write a minimal GGUF v3 for other modules' tests (see `build_gguf`).
    pub(crate) fn write_minimal_gguf(dir: &Path, name: &str, arch: &str, block_count: u32, tensor_names: &[&str]) -> PathBuf {
        write_gguf(dir, name, &build_gguf(arch, block_count, tensor_names))
    }

    fn write_gguf(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        let mut f = std::fs::File::create(&path).expect("create gguf");
        f.write_all(bytes).expect("write gguf");
        f.flush().expect("flush gguf");
        path
    }

    #[test]
    fn target_with_baked_mtp_reports_nextn_and_trunk() {
        let dir = scratch_dir("baked");
        let bytes = build_gguf(
            "qwen35",
            48,
            &[
                "token_embd.weight",
                "output_norm.weight",
                "blk.0.attn_q.weight",
                "blk.47.attn_q.weight",
                "blk.0.nextn.head_attn_q.weight",
                "blk.0.nextn.e_h.n_head.0.ffn_down.weight",
                "blk.0.nextn.h_i.weight",
            ],
        );
        let path = write_gguf(&dir, "target-mtp.gguf", &bytes);

        let shape = read_shape(&path).expect("shape");
        assert_eq!(shape.architecture, "qwen35");
        assert_eq!(shape.block_count, 48);
        assert!(shape.nextn_layers > 0, "baked MTP must report nextn");
        assert!(shape.has_trunk);
        assert!(shape.has_vocab);
        assert_eq!(shape.dflash_variant, None);
        assert_eq!(shape.shard_count, 1);
        assert_eq!(shape.tensor_count, 7);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn external_mtp_draft_is_truncated_with_one_block() {
        let dir = scratch_dir("ext-mtp");
        // A draft keeps the *target* arch; block_count is the discriminator.
        let bytes = build_gguf(
            "qwen35",
            1,
            &[
                "token_embd.weight",
                "blk.0.nextn.head_attn_q.weight",
                "blk.0.nextn.e_h.n_head.0.ffn_down.weight",
            ],
        );
        let path = write_gguf(&dir, "draft-mtp.gguf", &bytes);

        let shape = read_shape(&path).expect("shape");
        assert!(shape.nextn_layers > 0, "draft must report nextn");
        assert_eq!(shape.block_count, 1);
        assert!(!shape.has_trunk, "a truncated draft has no full stack");
        assert!(shape.has_vocab);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dspark_draft_sets_the_markov_sentinel() {
        let dir = scratch_dir("dspark");
        let bytes = build_gguf(
            "dflash",
            1,
            &[
                "token_embd.weight",
                "markov_w1.weight",
                "dflash.0.attn_q.weight",
            ],
        );
        let path = write_gguf(&dir, "draft-dspark.gguf", &bytes);

        let shape = read_shape(&path).expect("shape");
        assert_eq!(
            shape.dflash_variant.as_deref(),
            Some("dspark"),
            "markov_w1.weight is the DSpark sentinel"
        );
        assert_eq!(shape.architecture, "dflash");
        assert_eq!(shape.block_count, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dflash2_draft_detects_selector_hidden_weight() {
        let dir = scratch_dir("dflash2");
        let bytes = build_gguf(
            "dflash",
            1,
            &[
                "token_embd.weight",
                "selector_hidden.weight",
                "dflash.0.attn_q.weight",
            ],
        );
        let path = write_gguf(&dir, "draft-dflash2.gguf", &bytes);

        let shape = read_shape(&path).expect("shape");
        assert_eq!(shape.dflash_variant.as_deref(), Some("dflash2"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plain_dflash_draft_defaults_to_dflash_variant() {
        let dir = scratch_dir("dflash1");
        let bytes = build_gguf("dflash", 1, &["token_embd.weight", "dflash.0.attn_q.weight"]);
        let path = write_gguf(&dir, "draft-dflash.gguf", &bytes);

        let shape = read_shape(&path).expect("shape");
        assert_eq!(shape.dflash_variant.as_deref(), Some("dflash"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dflash_geometry_reads_embedding_target_layers_and_hyper_connections() {
        let dir = scratch_dir("dflash-geom");
        let mut buf = Vec::new();
        buf.extend_from_slice(b"GGUF");
        push_u32(&mut buf, 3);
        push_u64(&mut buf, 1); // 1 tensor
        push_u64(&mut buf, 5); // 5 KVs
        kv_str(&mut buf, "general.architecture", "dflash");
        kv_u32(&mut buf, "dflash.block_count", 1);
        kv_u32(&mut buf, "dflash.embedding_length", 4096);
        kv_int_array(&mut buf, "dflash.target_layers", &[3, 15, 27, 47]);
        kv_u32(&mut buf, "dflash.hyper_connection.count", 4);
        push_str(&mut buf, "markov_w1.weight");
        push_u32(&mut buf, 1);
        push_u64(&mut buf, 16);
        push_u32(&mut buf, 0);
        push_u64(&mut buf, 0);
        let path = write_gguf(&dir, "dspark-v4.gguf", &buf);

        let shape = read_shape(&path).expect("shape");
        assert_eq!(shape.dflash_variant.as_deref(), Some("dspark"));
        assert_eq!(shape.embedding_length, Some(4096));
        assert_eq!(shape.dflash_max_target_layer, Some(47));
        assert_eq!(shape.hyper_connection_count, Some(4));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plain_target_has_no_nextn_but_keeps_its_trunk() {
        let dir = scratch_dir("plain");
        let bytes = build_gguf(
            "qwen3",
            4,
            &[
                "token_embd.weight",
                "output.weight",
                "blk.0.attn_q.weight",
                "blk.1.attn_q.weight",
                "blk.2.attn_q.weight",
                "blk.3.attn_q.weight",
            ],
        );
        let path = write_gguf(&dir, "target-plain.gguf", &bytes);

        let shape = read_shape(&path).expect("shape");
        assert_eq!(shape.nextn_layers, 0, "no nextn tensors to find");
        assert!(shape.has_trunk);
        assert!(shape.has_vocab);
        assert_eq!(shape.block_count, 4);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sharded_draft_merges_nextn_from_a_later_split() {
        let dir = scratch_dir("sharded");
        let first = build_gguf("qwen35", 1, &["token_embd.weight", "blk.0.attn_q.weight"]);
        let second = build_gguf("qwen35", 1, &["blk.0.nextn.head_attn_q.weight"]);

        let p0 = write_gguf(&dir, "model-00001-of-00002.gguf", &first);
        let p1 = write_gguf(&dir, "model-00002-of-00002.gguf", &second);

        let shape = read_shape_sharded(&[p0, p1]).expect("merged shape");
        assert_eq!(shape.shard_count, 2);
        assert!(shape.nextn_layers > 0, "nextn lives only in split 2");
        assert_eq!(shape.architecture, "qwen35");
        assert_eq!(shape.block_count, 1);
        assert!(shape.has_vocab, "vocab tensor lives only in split 1");
        assert_eq!(shape.tensor_count, 3);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_gguf_file_is_an_error_not_a_panic() {
        let dir = scratch_dir("bad-magic");
        let path = write_gguf(&dir, "not-a-gguf.gguf", b"PK\x03\x04 this is a zip");
        let err = read_shape(&path).unwrap_err();
        assert!(err.contains("Not a GGUF"), "unexpected error: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn truncated_file_is_an_error_not_a_panic() {
        let dir = scratch_dir("truncated");
        let mut bytes = build_gguf("qwen3", 4, &["token_embd.weight", "blk.0.attn_q.weight"]);
        bytes.truncate(30); // cuts into the metadata table
        let path = write_gguf(&dir, "cut.gguf", &bytes);
        let err = read_shape(&path).unwrap_err();
        assert!(!err.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_is_an_error_not_a_panic() {
        let dir = scratch_dir("missing");
        let path = dir.join("does-not-exist.gguf");
        let err = read_shape(&path).unwrap_err();
        assert!(err.contains("not found"), "unexpected error: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn header_end_matches_the_patcher_and_is_alignment_padded() {
        let bytes = build_gguf(
            "qwen35",
            48,
            &[
                "token_embd.weight",
                "blk.0.attn_q.weight",
                "blk.0.nextn.head_attn_q.weight",
            ],
        );
        let dir = scratch_dir("header-end");
        let path = write_gguf(&dir, "shape.gguf", &bytes);

        let shape = read_shape(&path).expect("shape");
        assert_eq!(shape.alignment, gguf_patch::GGUF_DEFAULT_ALIGNMENT);
        assert_eq!(shape.header_end % shape.alignment, 0, "header_end not padded");
        assert_eq!(
            shape.header_end,
            gguf_patch::find_header_end_from_bytes(&bytes).expect("patcher parse"),
            "the shape reader and the patcher must agree on header_end"
        );
        assert!(shape.header_end < bytes.len() as u64);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn honors_general_alignment_kv() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"GGUF");
        push_u32(&mut buf, 3);
        push_u64(&mut buf, 0); // no tensors
        push_u64(&mut buf, 1); // one KV
        kv_u32(&mut buf, "general.alignment", 64);

        let dir = scratch_dir("alignment");
        let path = write_gguf(&dir, "aligned.gguf", &buf);

        let shape = read_shape(&path).expect("shape");
        assert_eq!(shape.alignment, 64);
        assert_eq!(shape.header_end % 64, 0);
        assert_eq!(shape.header_end, gguf_patch::align_offset(48, 64));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nextn_without_blk_prefix_counts_as_one_layer() {
        let dir = scratch_dir("nextn-noprefix");
        let bytes = build_gguf("qwen35", 1, &["token_embd.weight", "nextn.h_i.weight"]);
        let path = write_gguf(&dir, "nextn-noprefix.gguf", &bytes);

        let shape = read_shape(&path).expect("shape");
        assert_eq!(shape.nextn_layers, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn output_weight_alone_marks_a_full_stack() {
        let dir = scratch_dir("output-only");
        let bytes = build_gguf("dflash-draft", 1, &["output.weight"]);
        let path = write_gguf(&dir, "output-only.gguf", &bytes);

        let shape = read_shape(&path).expect("shape");
        assert!(shape.has_trunk);
        assert!(shape.has_vocab);
        assert_eq!(shape.architecture, "dflash-draft");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Private MTP material: `general.architecture = qwen4exp-mtp`, KVs under
    /// `qwen4exp.`. The arch strings disagree — a private format, flagged.
    #[test]
    fn arch_mismatch_flags_private_formats() {
        let dir = scratch_dir("arch-mismatch");
        let mut buf = Vec::new();
        buf.extend_from_slice(b"GGUF");
        push_u32(&mut buf, 3);
        push_u64(&mut buf, 0);
        push_u64(&mut buf, 2);
        kv_str(&mut buf, "general.architecture", "qwen4exp-mtp");
        kv_u32(&mut buf, "qwen4exp.block_count", 1);

        let path = write_gguf(&dir, "private-mtp.gguf", &buf);
        let shape = read_shape(&path).expect("shape");
        assert!(shape.arch_mismatch, "general.architecture != KV prefix");

        // A normal file (build_gguf: both sides = arch) is never flagged.
        let bytes = build_gguf("qwen4exp", 48, &["token_embd.weight"]);
        let path = write_gguf(&dir, "normal.gguf", &bytes);
        assert!(!read_shape(&path).expect("shape").arch_mismatch);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn serde_uses_camel_case_for_multi_word_fields() {
        let shape = GgufShape {
            architecture: "qwen35".into(),
            block_count: 48,
            nextn_layers: 2,
            dflash_variant: Some("dflash2".into()),
            has_trunk: true,
            has_vocab: true,
            shard_count: 1,
            tensor_count: 7,
            alignment: 32,
            arch_mismatch: false,
            header_end: 1024,
            lookup_table_bytes: 0,
            sampling_temp: None,
            sampling_top_p: None,
            sampling_top_k: None,
            sampling_min_p: None,
            ..Default::default()
        };
        let json = serde_json::to_string(&shape).expect("serialize");
        for key in [
            "\"nextnLayers\":2",
            "\"archMismatch\":false",
            "\"dflashVariant\":\"dflash2\"",
            "\"hasTrunk\":true",
            "\"hasVocab\":true",
            "\"block_count\":48",
            "\"tensor_count\":7",
            "\"shard_count\":1",
            "\"alignment\":32",
            "\"header_end\":1024",
        ] {
            assert!(json.contains(key), "missing {key} in {json}");
        }

        // A partially-populated object still deserializes.
        let partial: GgufShape = serde_json::from_str("{\"architecture\":\"qwen35\"}").expect("deserialize");
        assert_eq!(partial.architecture, "qwen35");
        assert_eq!(partial.block_count, 0);
        assert_eq!(partial.nextn_layers, 0);
        assert!(!partial.has_trunk);
    }
}
