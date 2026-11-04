//! Exact per-block byte sizes, for planning a layer split from metadata.
//!
//! A layer split in llama.cpp moves **whole blocks**, and `-ts` names a fraction of the
//! *layers*, not of the bytes. DeepSeek-V4.1 is the clearest case: its 40 blocks grow from
//! 2.91 GiB to 4.42 GiB, so an even 20/20 split leaves 17 GiB on one card while the byte
//! boundary at 22 layers is within 1.2 GiB. That boundary is a model fact and is readable
//! from the tensor table before anything is launched — this module reports the raw sizes;
//! the balancing decision lives in the frontend planner.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct LayerBytes {
    /// One entry per `blk.N`, in index order. MiB.
    pub per_block_mib: Vec<f64>,
    /// Engram / PLE lookup table — host by design for this architecture.
    pub lookup_mib: f64,
    /// Token embedding, which llama.cpp keeps on the first device.
    pub token_embd_mib: f64,
    /// Output tensor, which rides with the last layers.
    pub output_mib: f64,
    /// Anything else (norms, biases).
    pub other_mib: f64,
    /// Bytes of KV cache one token costs in ONE block, K and V together.
    /// 0 when the header does not describe the attention geometry.
    pub kv_bytes_per_token_per_layer: f64,
}

fn mib(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

/// Sum the tensor table per block, across every shard of the set.
///
/// Reads headers only — the same walk `gguf_meta` and `gguf_shape` already do, so no second
/// parser and no tensor data.
pub fn layer_bytes_from_header(model_path: &str) -> Result<LayerBytes, String> {
    let paths = crate::model_catalog::shard_sibling_paths(model_path);
    let mut per_block: std::collections::BTreeMap<usize, u64> = std::collections::BTreeMap::new();
    let mut lookup = 0u64;
    let mut token_embd = 0u64;
    let mut output = 0u64;
    let mut other = 0u64;

    let mut kv_geometry = 0.0f64;
    for path in &paths {
        let header = crate::gguf_patch::parse_header_from_file(path)?;
        if kv_geometry <= 0.0 {
            kv_geometry = kv_bytes_per_token_per_layer(&header);
        }
        let file_len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        let by_span: std::collections::HashMap<String, u64> =
            offsets_bytes(file_len, header.header_end, &header.tensors)
                .into_iter()
                .collect();
        for tensor in &header.tensors {
            // A known type gives the exact size; an unknown one falls back to its offset span.
            let bytes = crate::gguf_shape::tensor_bytes(tensor)
                .max(by_span.get(&tensor.name).copied().unwrap_or(0));
            if let Some(rest) = tensor.name.strip_prefix("blk.") {
                if let Some((index, _)) = rest.split_once('.') {
                    if let Ok(block) = index.parse::<usize>() {
                        *per_block.entry(block).or_insert(0) += bytes;
                        continue;
                    }
                }
            }
            if tensor.name.contains("per_layer_token_embd") {
                lookup += bytes;
            } else if tensor.name.starts_with("token_embd") {
                token_embd += bytes;
            } else if tensor.name.starts_with("output.") {
                output += bytes;
            } else {
                other += bytes;
            }
        }
    }

    if per_block.is_empty() {
        return Err("no blk.N tensors in header".to_string());
    }

    // Some quantizers leave gaps; a missing block is a zero rather than a shifted index.
    let last = *per_block.keys().last().unwrap_or(&0);
    let per_block_mib = (0..=last)
        .map(|i| mib(*per_block.get(&i).unwrap_or(&0)))
        .collect();

    Ok(LayerBytes {
        per_block_mib,
        lookup_mib: mib(lookup),
        token_embd_mib: mib(token_embd),
        output_mib: mib(output),
        other_mib: mib(other),
        kv_bytes_per_token_per_layer: kv_geometry,
    })
}


/// Bytes one token of KV costs in one block.
///
/// `attention.key_length` / `value_length` are authoritative when present: Qwen3.8-Flash
/// (qwen4exp) has n_embd 2560 with 24 heads, so n_embd / n_head gives 106.7 while the real
/// head size is 256. Deriving the head size from the embedding is how a KV estimate ends up
/// 2.4x off.
fn kv_bytes_per_token_per_layer(header: &crate::gguf_patch::HeaderFacts) -> f64 {
    let Some(arch) = header.architecture.clone() else {
        return 0.0;
    };
    let number = |suffix: &str| -> Option<f64> {
        header.kv_ints.get(&format!("{arch}.{suffix}")).map(|v| *v as f64)
    };
    let heads = number("attention.head_count");
    let heads_kv = number("attention.head_count_kv").or(heads);
    let key_len = number("attention.key_length");
    let value_len = number("attention.value_length");
    let embd = number("embedding_length");
    // f16 per element, two tensors (K and V).
    let bytes = 2.0;
    match (heads_kv, key_len, value_len) {
        (Some(kv), Some(k), Some(v)) => kv * (k + v) * bytes,
        (Some(kv), _, _) => match (embd, heads) {
            (Some(e), Some(h)) if h > 0.0 => {
                let head_dim = e / h;
                kv * (head_dim + head_dim) * bytes
            }
            _ => 0.0,
        },
        _ => 0.0,
    }
}

/// Byte span of every tensor in one shard, from the offsets GGUF already stores.
///
/// 	ensor_bytes needs a block-size table and returns 0 for a type it does not know -
/// Qwen3.8-Flash Q2_0 ships 202 tensors of ggml type 42, which silently removed ~32 GiB of
/// weights from the plan. Offsets cannot be wrong about how big a tensor is: sort them and
/// take the next offset (the last one runs to the end of the data section).
fn offsets_bytes(file_len: u64, header_end: u64, tensors: &[crate::gguf_patch::TensorInfo]) -> Vec<(String, u64)> {
    let data_end = file_len.saturating_sub(header_end);
    let mut by_offset: Vec<(u64, &str)> = tensors
        .iter()
        .map(|t| (t.data_offset, t.name.as_str()))
        .collect();
    by_offset.sort_by_key(|(offset, _)| *offset);
    let mut out = Vec::with_capacity(by_offset.len());
    for (i, (offset, name)) in by_offset.iter().enumerate() {
        let end = by_offset
            .get(i + 1)
            .map(|(next, _)| *next)
            .unwrap_or(data_end);
        out.push(((*name).to_string(), end.saturating_sub(*offset)));
    }
    out
}
#[tauri::command]
pub fn get_model_layer_bytes(model_path: String) -> Result<LayerBytes, String> {
    layer_bytes_from_header(&model_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    /// The planner depends on block boundaries being contiguous and every block accounted
    /// for, so a zero block is a signal worth failing on rather than silently splitting.
    #[test]
    fn blocks_are_contiguous_when_present() {
        let bytes = LayerBytes {
            per_block_mib: vec![1.0; 40],
            lookup_mib: 0.0,
            token_embd_mib: 0.0,
            output_mib: 0.0,
            other_mib: 0.0,
            kv_bytes_per_token_per_layer: 0.0,
        };
        assert_eq!(bytes.per_block_mib.len(), 40);
    }
}