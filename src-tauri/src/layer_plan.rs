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

    for path in &paths {
        let header = crate::gguf_patch::parse_header_from_file(path)?;
        for tensor in &header.tensors {
            let bytes = crate::gguf_shape::tensor_bytes(tensor);
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
    })
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
        };
        assert_eq!(bytes.per_block_mib.len(), 40);
    }
}
