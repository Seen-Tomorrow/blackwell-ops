//! `ModelMetadata` straight from a GGUF header — no engine spawn.
//!
//! The catalog used to spawn `llama-server -ngl 0` and scrape stderr for this
//! (`gguf_scan`). That path is lossy (one real model came back with 70 of 96 KVs,
//! zero layers, and the wrong expert counts), needs a CUDA runtime, and burns a 15 s
//! window. `gguf_patch` already walks the same header in-process, so this module
//! derives the fields from what it reads.
//!
//! What cannot come from a header: `raw_print_info` (the engine's own print_info
//! block). It stays empty here, which is the one known delta against the scraper.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::gguf_patch::{self, KvValue};
use crate::types::{BaseModelInfo, ModelMetadata};

/// Typed KV map plus the tensor table of a (merged) shard set.
struct Header<'a> {
    kv: &'a HashMap<String, KvValue>,
    arch: String,
    tensors: &'a [gguf_patch::TensorInfo],
}

impl<'a> Header<'a> {
    fn int(&self, key: &str) -> Option<i64> {
        match self.kv.get(key)? {
            KvValue::Int(n) => Some(*n),
            KvValue::Float(f) => Some(*f as i64),
            _ => None,
        }
    }

    fn f64(&self, key: &str) -> Option<f64> {
        match self.kv.get(key)? {
            KvValue::Float(f) => Some(*f),
            KvValue::Int(n) => Some(*n as f64),
            _ => None,
        }
    }

    fn text(&self, key: &str) -> String {
        match self.kv.get(key) {
            Some(KvValue::Str(s)) => s.clone(),
            Some(other) => stringify(other),
            None => String::new(),
        }
    }

    fn str_vec(&self, key: &str) -> Vec<String> {
        match self.kv.get(key) {
            Some(KvValue::StrArray(v)) => v.clone(),
            _ => Vec::new(),
        }
    }

    /// `<arch>.<suffix>` integer — the shape of every per-architecture KV.
    fn arch_int(&self, suffix: &str) -> u32 {
        self.int(&format!("{}.{}", self.arch, suffix))
            .filter(|n| *n >= 0)
            .map(|n| n as u32)
            .unwrap_or(0)
    }

    fn arch_text(&self, suffix: &str) -> String {
        self.text(&format!("{}.{}", self.arch, suffix))
    }
}

/// Render a KV to the string form the catalog stores in `rawKvs`.
fn stringify(v: &KvValue) -> String {
    match v {
        KvValue::Int(n) => n.to_string(),
        // llama prints KVs with %f, so the scraper's values look like "1.000000".
        KvValue::Float(f) => format!("{f:.6}"),
        KvValue::Str(s) => s.clone(),
        KvValue::Bool(b) => b.to_string(),
        KvValue::IntArray(a) => format!("{a:?}"),
        KvValue::StrArray(a) => format!("{a:?}"),
    }
}

/// llama.cpp's `ggml_type_name` — the scraper stores these exact spellings.
fn ggml_type_name(t: u32) -> &'static str {
    match t {
        0 => "f32",
        1 => "f16",
        2 => "q4_0",
        3 => "q4_1",
        6 => "q5_0",
        7 => "q5_1",
        8 => "q8_0",
        9 => "q8_1",
        10 => "q2_K",
        11 => "q3_K",
        12 => "q4_K",
        13 => "q5_K",
        14 => "q6_K",
        15 => "q8_K",
        16 => "iq2_xxs",
        17 => "iq2_xs",
        18 => "iq3_xxs",
        19 => "iq1_s",
        20 => "iq4_nl",
        21 => "iq3_s",
        22 => "iq2_s",
        23 => "iq4_xs",
        24 => "i8",
        25 => "i16",
        26 => "i32",
        27 => "i64",
        28 => "f64",
        29 => "iq1_m",
        30 => "bf16",
        34 => "tq1_0",
        35 => "tq2_0",
        39 => "mxfp4",
        _ => "unknown",
    }
}

/// `llama_model_ftype_name` without the "mostly " prefix — matches `print_info`.
fn file_type_name(t: i64) -> String {
    let s = match t {
        0 => "all F32",
        1 => "mostly F16",
        2 => "mostly Q4_0",
        3 => "mostly Q4_1",
        7 => "mostly Q8_0",
        8 => "mostly Q5_0",
        9 => "mostly Q5_1",
        10 => "mostly Q2_K",
        11 => "mostly Q3_K - Small",
        12 => "mostly Q3_K - Medium",
        13 => "mostly Q3_K - Large",
        14 => "mostly Q4_K - Small",
        15 => "mostly Q4_K - Medium",
        16 => "mostly Q5_K - Small",
        17 => "mostly Q5_K - Medium",
        18 => "mostly Q6_K",
        19 => "mostly IQ2_XXS",
        20 => "mostly IQ2_XS",
        21 => "mostly Q2_K - Small",
        22 => "mostly IQ3_XS",
        23 => "mostly IQ3_XXS",
        24 => "mostly IQ1_S",
        25 => "mostly IQ4_NL",
        26 => "mostly IQ3_S",
        27 => "mostly IQ3_M",
        28 => "mostly IQ2_S",
        29 => "mostly IQ2_M",
        30 => "mostly IQ4_XS",
        31 => "mostly IQ1_M",
        32 => "mostly BF16",
        36 => "mostly TQ1_0",
        37 => "mostly TQ2_0",
        38 => "mostly MXFP4",
        _ => "",
    };
    s.trim_start_matches("mostly ").to_string()
}

/// Human parameter count, same shape the engine prints ("228.69 B").
fn params_label(total: f64) -> String {
    if total >= 1e12 {
        format!("{:.2} T", total / 1e12)
    } else if total >= 1e9 {
        format!("{:.2} B", total / 1e9)
    } else if total >= 1e6 {
        format!("{:.2} M", total / 1e6)
    } else {
        format!("{total:.0}")
    }
}

fn unix_secs(t: std::time::SystemTime) -> u64 {
    t.duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Catalog-style label for a ggml tensor type (q4_K -> Q4_K, iq2_xxs -> IQ2_XXS).
fn tensor_type_label(ty: &str) -> String {
    let upper = ty.to_uppercase().replace(' ', "_");
    upper
}

/// Rough BPW band per quant family. Unknown tags never second-guess.
fn type_matches_bpw(label: &str, bpw: f32) -> bool {
    let n = label.to_lowercase().replace(" - ", "_").replace(['-', ' '], "_");
    let (lo, hi) = if n.contains("iq1") { (1.5_f32, 2.6) }
    else if n.contains("iq2") { (2.0, 3.2) }
    else if n.contains("iq3") { (2.5, 3.8) }
    else if n.contains("iq4") { (3.5, 4.8) }
    else if n.contains("q2") { (2.2, 3.5) }
    else if n.contains("q3") { (3.0, 4.5) }
    else if n.contains("q4") { (4.0, 6.2) }
    else if n.contains("q5") { (5.0, 7.0) }
    else if n.contains("q6") { (5.8, 7.8) }
    else if n.contains("q8") { (7.5, 10.0) }
    else if n.contains("f16") || n.contains("bf16") || n.contains("fp16") { (15.0, 17.5) }
    else if n.contains("f32") { (30.0, 34.0) }
    else if n.contains("nvfp4") || n.contains("mxfp4") { (3.5, 6.5) }
    else { return true };
    bpw >= lo && bpw <= hi
}

/// Correct `file_type_str` against what the tensors actually are.
///
/// `general.file_type` is one enum the converter set, and it lies often enough to
/// matter: this model's IQ2 pack declares Q8_0. Rule 1: the majority non-activation
/// tensor type wins. Rule 2: if the label still disagrees with the measured BPW, the
/// filename quant wins when it fits better. Ported from the scraper this reader replaced.
fn refine_file_type(
    meta: &mut ModelMetadata,
    model_path: &str,
    bytes_by_type: &HashMap<String, u64>,
) {
    // Majority by BYTES, not by tensor count: a dynamic quant keeps a handful of huge
    // IQ2 expert tensors and hundreds of small Q8_0 ones, so counting would answer
    // "Q8_0" for a 2-bit pack. Bytes answer what the model actually spends on.
    let skip = ["f32", "f16", "bf16"];
    let non_act: Vec<(&String, &u64)> = bytes_by_type
        .iter()
        .filter(|(k, _)| !skip.iter().any(|s| k.eq_ignore_ascii_case(s)))
        .collect();
    if let Some((ty, bytes)) = non_act.iter().max_by_key(|(_, b)| **b) {
        let total: u64 = non_act.iter().map(|(_, b)| **b).sum();
        if total > 0 && **bytes * 2 >= total {
            let pretty = tensor_type_label(ty);
            if !pretty.is_empty() && !pretty.eq_ignore_ascii_case(meta.file_type_str.trim()) {
                meta.file_type_str = pretty;
            }
        }
    }
    // The quant names the author published; the header enum is what the converter wrote.
    // Prefer the filename when it fits the measured weight-body BPW, then the majority
    // type when that fits, and only then whatever the KV claimed.
    if meta.bpw > 0.5 {
        let fname = Path::new(model_path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        let from_name = crate::model_catalog::extract_quant(fname);
        let named_ok = from_name != "GGUF"
            && !crate::model_catalog::is_shard_noise_quant(&from_name)
            && type_matches_bpw(&from_name, meta.bpw);
        let claimed_ok = type_matches_bpw(meta.file_type_str.trim(), meta.bpw);
        if named_ok && !claimed_ok {
            meta.file_type_str = from_name;
        }
    }
}
/// Build the catalog metadata for a model file from its header alone.
///
/// Sharded sets are merged first: the first shard carries the KVs, but the tensors
/// (and therefore params, bpw, vocab, nextn) are spread across all of them.
pub fn metadata_from_header(model_path: &str) -> Result<ModelMetadata, String> {
    let siblings = crate::model_catalog::shard_sibling_paths(model_path);
    let paths: Vec<PathBuf> = if siblings.len() > 1 {
        siblings
    } else {
        vec![PathBuf::from(model_path)]
    };

    let mut kv: HashMap<String, KvValue> = HashMap::new();
    let mut tensors: Vec<gguf_patch::TensorInfo> = Vec::new();
    let mut arch = String::new();
    for p in &paths {
        let facts = gguf_patch::parse_header_from_file(p)?;
        if arch.is_empty() {
            arch = facts.architecture.clone().unwrap_or_default();
        }
        for (k, v) in facts.kv_all {
            kv.entry(k).or_insert(v);
        }
        tensors.extend(facts.tensors);
    }

    // A file with no architecture KV cannot be derived from at all.
    if arch.is_empty() {
        return Err("no general.architecture in header".to_string());
    }

    let h = Header {
        kv: &kv,
        arch: arch.clone(),
        tensors: &tensors,
    };

    let mut elements: f64 = 0.0;
    let mut tensor_counts: HashMap<String, u32> = HashMap::new();
    let mut bytes_by_type: HashMap<String, u64> = HashMap::new();
    let mut vocab_size = 0_u32;
    let mut nextn_idx: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
    for t in h.tensors {
        // The lookup table (Engram / PLE) is a separate, swappable artifact — it must
        // not colour the quant label or the bits-per-weight of the weight body.
        let is_lookup = t.name.contains("per_layer_token_embd");
        let n: u64 = t.dims.iter().product();
        if !is_lookup {
            *bytes_by_type
                .entry(ggml_type_name(t.ggml_type).to_string())
                .or_insert(0) += crate::gguf_shape::tensor_bytes(t);
        }
        if !is_lookup {
            elements += n as f64;
        }
        *tensor_counts
            .entry(ggml_type_name(t.ggml_type).to_string())
            .or_insert(0) += 1;
        // token_embd.weight is [n_embd, n_vocab].
        if t.name == "token_embd.weight" && t.dims.len() == 2 {
            vocab_size = t.dims[1] as u32;
        }
        if t.name.contains(".nextn.") {
            if let Some(idx) = t
                .name
                .strip_prefix("blk.")
                .and_then(|rest| rest.split('.').next())
                .and_then(|idx| idx.parse::<u32>().ok())
            {
                nextn_idx.insert(idx);
            }
        }
    }
    let nextn_predict_layers = nextn_idx.len() as u32;
    // llama.cpp's `n_layer` excludes nextn blocks; `block_count` includes them.
    let n_layer = h.arch_int("block_count").saturating_sub(nextn_predict_layers);

    let file_size_bytes: u64 = paths
        .iter()
        .filter_map(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .sum();
    let file_created = std::fs::metadata(Path::new(model_path))
        .and_then(|m| m.created())
        .map(unix_secs)
        .unwrap_or(0);

    let tensor_bytes: f64 = h
        .tensors
        .iter()
        .filter(|t| !t.name.contains("per_layer_token_embd"))
        .map(|t| crate::gguf_shape::tensor_bytes(t) as f64)
        .sum();
    let bpw = if elements > 0.0 {
        (tensor_bytes * 8.0 / elements) as f32
    } else {
        0.0
    };

    let base_model_count = h.int("general.base_model.count").unwrap_or(0).max(0);
    let mut base_models = Vec::new();
    for i in 0..base_model_count {
        let name = h.text(&format!("general.base_model.{i}.name"));
        let organization = h.text(&format!("general.base_model.{i}.organization"));
        let repo_url = h.text(&format!("general.base_model.{i}.repo_url"));
        if name.is_empty() && repo_url.is_empty() {
            continue;
        }
        base_models.push(BaseModelInfo {
            name,
            organization,
            repo_url,
        });
    }

    let mut raw_kvs = HashMap::with_capacity(h.kv.len());
    for (k, v) in h.kv.iter() {
        raw_kvs.insert(k.clone(), stringify(v));
    }

    let n_head = h.arch_int("attention.head_count");
    let n_head_kv = {
        let direct = h.arch_int("attention.head_count_kv");
        if direct > 0 {
            direct
        } else {
            let gqa = h.arch_int("attention.group_count");
            if gqa > 1 {
                n_head / gqa
            } else {
                n_head
            }
        }
    };

    let mut meta = ModelMetadata {
        architecture: arch.clone(),
        // Verbatim `general.size_label` (e.g. "748B-A16B"): the engine sometimes
        // re-derives "122B.A10B" from params, but the file's own label is the truth.
        model_type_label: h.text("general.size_label"),
        n_layer,
        n_ctx_train: h.arch_int("context_length"),
        n_embd: h.arch_int("embedding_length"),
        n_head,
        n_head_kv,
        n_expert: h.arch_int("expert_count"),
        n_expert_used: h.arch_int("expert_used_count"),
        rope_freq_base: h.f64(&format!("{arch}.rope.freq_base")).unwrap_or(0.0) as f32,
        rope_dim: h.arch_int("rope.dimension_count"),
        feed_forward_length: h.arch_int("feed_forward_length"),
        expert_feed_forward_length: h.arch_int("expert_feed_forward_length"),
        file_type_str: h
            .int("general.file_type")
            .map(file_type_name)
            .unwrap_or_default(),
        bpw: (bpw * 100.0).round() / 100.0,
        tensor_counts,
        total_params_str: params_label(elements),
        vocab_size,
        general_name: h.text("general.name"),
        rope_scaling_type: h.arch_text("rope.scaling.type"),
        tokenizer_model: h.text("tokenizer.ggml.model"),
        file_size_bytes,
        scan_timestamp: unix_secs(std::time::SystemTime::now()),
        file_created,
        nextn_predict_layers,
        raw_kvs,
        // The engine's own print_info block has no header equivalent.
        raw_print_info: HashMap::new(),
        general_author: h.text("general.author"),
        general_repo_url: h.text("general.repo_url"),
        general_basename: h.text("general.basename"),
        general_quantized_by: h.text("general.quantized_by"),
        general_license: h.text("general.license"),
        general_tags: h.str_vec("general.tags"),
        base_models,
        chat_template: h.text("tokenizer.chat_template"),
    };

    refine_file_type(&mut meta, model_path, &bytes_by_type);
    Ok(meta)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_type_labels_match_the_engine_wording() {
        assert_eq!(file_type_name(21), "Q2_K - Small");
        assert_eq!(file_type_name(7), "Q8_0");
        assert_eq!(file_type_name(15), "Q4_K - Medium");
        assert_eq!(file_type_name(9999), "");
    }

    #[test]
    fn params_label_uses_engine_units() {
        assert_eq!(params_label(308.78e9), "308.78 B");
        assert_eq!(params_label(3.93e9), "3.93 B");
        assert_eq!(params_label(1.2e12), "1.20 T");
    }

    #[test]
    fn stringify_matches_the_scraper_format() {
        assert_eq!(stringify(&KvValue::Float(1.0)), "1.000000");
        assert_eq!(stringify(&KvValue::Int(20)), "20");
        assert_eq!(stringify(&KvValue::Str("deepseek41".into())), "deepseek41");
        assert_eq!(stringify(&KvValue::IntArray(vec![1, 2])), "[1, 2]");
    }
}
