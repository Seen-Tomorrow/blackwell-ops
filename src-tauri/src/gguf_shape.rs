//! Header-only facts about a GGUF file, read from the **tensor-info table**.
//!
//! `gguf_scan.rs` spawns `llama-server` and scrapes stderr, so it never sees tensor
//! *names* — which is where the signals that actually distinguish a speculative
//! draft live (`blk.N.nextn.*`, `markov_w1.weight`, trunk tensors). This module walks
//! the same header `gguf_patch.rs` already walks (via `gguf_patch::parse_header`, not a
//! second parser) and reports structure only. No tensor data touched, no engine spawned.
//!
//! Facts only — the role decision lives in the classifier (step 2), not here.
//! See `docs/SPEC-ADAPTERS.md` §2.3.
#![allow(dead_code)] // Step 1 is additive — nothing consumes GgufShape until step 2.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::gguf_patch;

/// Header-only facts about a GGUF file, read from the tensor-info table.
/// No tensor data touched, no engine spawned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    /// DSpark sentinel — a tensor name contains "markov_w1".
    #[serde(default, rename = "hasMarkovW1")]
    pub has_markov_w1: bool,
    /// Full layer stack present (an external MTP draft is a truncated copy).
    #[serde(default, rename = "hasTrunk")]
    pub has_trunk: bool,
    /// An embedding/output tensor is present. Replaces the broken
    /// `vocab_size == 0` heuristic the stderr scraper produces.
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
    /// Offset where tensor data starts (alignment-padded).
    #[serde(default)]
    pub header_end: u64,
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

        if name.to_ascii_lowercase().contains("markov_w1") {
            has_markov_w1 = true;
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

    GgufShape {
        architecture,
        block_count,
        nextn_layers,
        has_markov_w1,
        has_trunk,
        has_vocab,
        shard_count,
        tensor_count: facts.tensor_count,
        alignment: facts.alignment,
        header_end: facts.header_end,
    }
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
    base.has_markov_w1 |= split.has_markov_w1;
    base.has_trunk |= split.has_trunk;
    base.has_vocab |= split.has_vocab;
    base.tensor_count = base.tensor_count.saturating_add(split.tensor_count);
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
mod tests {
    use super::*;
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
    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = crate::config::app_root_dir().join(format!(
            "gguf-shape-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
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
        assert!(!shape.has_markov_w1);
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
        assert!(shape.has_markov_w1, "markov_w1.weight is the DSpark sentinel");
        assert_eq!(shape.architecture, "dflash");
        assert_eq!(shape.block_count, 1);

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

    #[test]
    fn serde_uses_camel_case_for_multi_word_fields() {
        let shape = GgufShape {
            architecture: "qwen35".into(),
            block_count: 48,
            nextn_layers: 2,
            has_markov_w1: false,
            has_trunk: true,
            has_vocab: true,
            shard_count: 1,
            tensor_count: 7,
            alignment: 32,
            header_end: 1024,
        };
        let json = serde_json::to_string(&shape).expect("serialize");
        for key in [
            "\"nextnLayers\":2",
            "\"hasMarkovW1\":false",
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
