//! Cold forecast: what a model will cost before anything of it has ever launched.
//!
//! Three measured facts make this possible, all established against real launches on this box:
//!
//! 1. Weights are exact from the GGUF (tensor offsets), so they need no learning at all.
//! 2. KV cache is linear in ctx. Its per-token size comes from the header geometry, and the
//!    fraction of blocks that actually carry a cache is an architecture property - a hybrid
//!    model may keep KV in 12 of 48 blocks - so it is measured once per architecture from any
//!    launch and reused.
//! 3. Compute-graph buffers (`sched_reserve`) are **affine in ctx** and depend only on the
//!    graph shape, not the weights: a 15.9 GB Q4_K_M and a 10.2 GB IQ3_XXS of the same
//!    architecture measured identical compute buffers (7,411 MiB at 64K, 21,075 at 256K).
//!    So a few launches of *any* sibling model give `compute = a + b * ctx` for the shape.
//!
//! A shape is `(architecture, block count, split, batch, ubatch)`. KV quant is part of the KV
//! ratio key because it scales those bytes directly.
//!
//! This module reads the learned store directly rather than duplicating its typed model: the
//! only fields it needs are the key tokens and the buffer lines, and going through JSON keeps
//! the profile independent of that store's internal shape.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;

use crate::gguf_patch::{parse_header_from_file, HeaderFacts};
use crate::layer_plan::layer_bytes_from_header;

const MIB: f64 = 1024.0 * 1024.0;

/// Geometry of one model, read once from its header.
#[derive(Clone)]
struct ShapeInfo {
    arch: String,
    layers: u32,
    /// Bytes one token costs in one *attention* block, K and V together, f16.
    kv_bytes_per_token_per_layer: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProfilePoint {
    pub ctx: u64,
    pub compute_mib: f64,
    pub model: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ColdBasis {
    pub arch: String,
    pub layers: u32,
    pub split: String,
    pub batch: u32,
    pub ubatch: u32,
    /// The launches the affine fit came from.
    pub points: Vec<ProfilePoint>,
    pub intercept_mib: f64,
    pub slope_mib_per_token: f64,
    /// Fraction of blocks that carry a KV cache, measured per architecture.
    pub kv_layer_ratio: f64,
    pub kv_samples: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct ColdForecast {
    pub weights_mib: f64,
    pub kv_mib: f64,
    pub compute_mib: f64,
    pub total_mib: f64,
    pub basis: ColdBasis,
}

/// Least-squares `y = a + b*x`; `None` when the points cannot determine a slope.
fn fit_affine(points: &[(f64, f64)]) -> Option<(f64, f64)> {
    let n = points.len() as f64;
    if points.len() < 2 {
        return None;
    }
    let sx: f64 = points.iter().map(|(x, _)| x).sum();
    let sy: f64 = points.iter().map(|(_, y)| y).sum();
    let sxx: f64 = points.iter().map(|(x, _)| x * x).sum();
    let sxy: f64 = points.iter().map(|(x, y)| x * y).sum();
    let denom = n * sxx - sx * sx;
    if denom.abs() < 1e-9 {
        return None;
    }
    let slope = (n * sxy - sx * sy) / denom;
    let intercept = (sy - slope * sx) / n;
    Some((intercept, slope))
}

fn shape_info(path: &str, cache: &mut BTreeMap<String, Option<ShapeInfo>>) -> Option<ShapeInfo> {
    if let Some(hit) = cache.get(path) {
        return hit.clone();
    }
    let info = parse_header_from_file(Path::new(path)).ok().and_then(|header| {
        let arch = header.architecture.clone()?;
        let layers = header.block_count?;
        if layers <= 0 {
            return None;
        }
        Some(ShapeInfo {
            arch,
            layers: layers as u32,
            kv_bytes_per_token_per_layer: kv_geometry(&header),
        })
    });
    cache.insert(path.to_string(), info.clone());
    info
}

/// Bytes one token costs in one attention block, from the header's own numbers.
fn kv_geometry(header: &HeaderFacts) -> f64 {
    let Some(arch) = header.architecture.as_deref() else {
        return 0.0;
    };
    let number = |suffix: &str| -> Option<f64> {
        header
            .kv_ints
            .get(&format!("{arch}.{suffix}"))
            .map(|v| *v as f64)
    };
    let heads = number("attention.head_count");
    let heads_kv = number("attention.head_count_kv").or(heads);
    let key_len = number("attention.key_length");
    let value_len = number("attention.value_length");
    match (heads_kv, key_len, value_len) {
        (Some(kv), Some(k), Some(v)) => kv * (k + v) * 2.0,
        (Some(kv), _, _) => match (number("embedding_length"), heads) {
            (Some(embd), Some(h)) if h > 0.0 => {
                let head_dim = embd / h;
                kv * (head_dim + head_dim) * 2.0
            }
            _ => 0.0,
        },
        _ => 0.0,
    }
}

fn model_path_from_key(key: &str) -> &str {
    key.split('|').next().unwrap_or("")
}

fn key_token<'a>(key: &'a str, name: &str) -> Option<&'a str> {
    key.split('|')
        .find_map(|token| token.strip_prefix(name))
        .map(str::trim)
}

fn cuda_compute_mib(entry: &serde_json::Value) -> f64 {
    entry
        .get("launch_snapshot")
        .and_then(|s| s.get("buffers"))
        .and_then(|b| b.as_array())
        .map(|lines| {
            lines
                .iter()
                .filter(|line| {
                    let device = line.get("device").and_then(|d| d.as_str()).unwrap_or("");
                    let rest = device.strip_prefix("CUDA").unwrap_or("");
                    !rest.is_empty()
                        && rest.bytes().all(|b| b.is_ascii_digit())
                        && line.get("category").and_then(|c| c.as_str()) == Some("compute")
                })
                .filter_map(|line| line.get("mib").and_then(|m| m.as_f64()))
                .sum()
        })
        .unwrap_or(0.0)
}

fn cuda_kv_mib(entry: &serde_json::Value) -> f64 {
    entry
        .get("launch_snapshot")
        .and_then(|s| s.get("buffers"))
        .and_then(|b| b.as_array())
        .map(|lines| {
            lines
                .iter()
                .filter(|line| {
                    let device = line.get("device").and_then(|d| d.as_str()).unwrap_or("");
                    let rest = device.strip_prefix("CUDA").unwrap_or("");
                    !rest.is_empty()
                        && rest.bytes().all(|b| b.is_ascii_digit())
                        && line.get("category").and_then(|c| c.as_str()) == Some("kv")
                })
                .filter_map(|line| line.get("mib").and_then(|m| m.as_f64()))
                .sum()
        })
        .unwrap_or(0.0)
}

fn median(values: &mut Vec<f64>) -> f64 {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = values.len() / 2;
    if values.len() % 2 == 0 && values.len() >= 2 {
        (values[mid - 1] + values[mid]) / 2.0
    } else {
        values.get(mid).copied().unwrap_or(0.0)
    }
}

fn store_entries() -> serde_json::Map<String, serde_json::Value> {
    let path = crate::config::cache_dir().join("learned-vram.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return serde_json::Map::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return serde_json::Map::new();
    };
    value
        .get("entries")
        .and_then(|e| e.as_object())
        .cloned()
        .unwrap_or_default()
}

/// Forecast a model that has never launched, from any recorded launches of the same shape.
///
/// `exclude_model` is for validation: it hides one model's own launches so the forecast has to
/// come from its siblings, which is the situation a genuinely cold model is in.
pub fn cold_forecast(
    model_path: &str,
    ctx: u64,
    kv_quant: &str,
    split: &str,
    batch: u32,
    ubatch: u32,
    exclude_model: Option<&str>,
) -> Result<ColdForecast, String> {
    let bytes = layer_bytes_from_header(model_path)?;
    let weights_mib = bytes.per_block_mib.iter().sum::<f64>()
        + bytes.token_embd_mib
        + bytes.output_mib
        + bytes.other_mib;

    let mut cache: BTreeMap<String, Option<ShapeInfo>> = BTreeMap::new();
    let target = shape_info(model_path, &mut cache)
        .ok_or_else(|| "cannot read model shape from the header".to_string())?;

    let split_norm = split.trim().to_lowercase();
    let kv_norm = kv_quant.trim().to_lowercase();
    let excluded = exclude_model.map(|m| m.replace('\\', "/").to_lowercase());

    let entries = store_entries();
    let mut points: Vec<(f64, f64)> = Vec::new();
    let mut point_rows: Vec<ProfilePoint> = Vec::new();
    let mut kv_ratios: Vec<f64> = Vec::new();

    for (key, entry) in entries.iter() {
        let model = model_path_from_key(key);
        if let Some(exclude) = excluded.as_deref() {
            if model.replace('\\', "/").to_lowercase() == exclude {
                continue;
            }
        }
        let Some(info) = shape_info(model, &mut cache) else {
            continue;
        };
        if info.arch != target.arch || info.layers != target.layers {
            continue;
        }
        let Some(entry_ctx) = key_token(key, "ctx=").and_then(|v| v.parse::<u64>().ok()) else {
            continue;
        };
        if key_token(key, "split=") != Some(split_norm.as_str()) {
            continue;
        }
        let entry_batch = key_token(key, "batch=")
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0);
        let entry_ubatch = key_token(key, "ubatch=")
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0);
        // 0 means "the caller cannot state it" - wildcard, not a literal mismatch.
        if batch != 0 && entry_batch != batch {
            continue;
        }
        if ubatch != 0 && entry_ubatch != ubatch {
            continue;
        }

        let compute = cuda_compute_mib(entry);
        if compute > 0.0 {
            points.push((entry_ctx as f64, compute));
            point_rows.push(ProfilePoint {
                ctx: entry_ctx,
                compute_mib: compute,
                model: model.to_string(),
            });
        }

        // KV ratio: measured KV / (geometry x ctx x blocks). A hybrid architecture keeps KV in
        // only some blocks and this is how that shows up without hardcoding it.
        if key_token(key, "kv=") == Some(kv_norm.as_str()) && info.kv_bytes_per_token_per_layer > 0.0
        {
            let measured = cuda_kv_mib(entry);
            let expected = info.kv_bytes_per_token_per_layer * entry_ctx as f64 * info.layers as f64 / MIB;
            if measured > 0.0 && expected > 0.0 {
                kv_ratios.push(measured / expected);
            }
        }
    }

    if points.len() < 2 {
        return Err(format!(
            "need two launches of the shape to fit compute buffers, found {}",
            points.len()
        ));
    }
    let (intercept, slope) =
        fit_affine(&points).ok_or_else(|| "compute points are degenerate".to_string())?;

    let kv_layer_ratio = if kv_ratios.is_empty() { 0.0 } else { median(&mut kv_ratios) };
    if kv_layer_ratio <= 0.0 {
        return Err("no KV measurement for this architecture/kv quant".to_string());
    }
    let kv_mib =
        target.kv_bytes_per_token_per_layer * ctx as f64 * target.layers as f64 * kv_layer_ratio / MIB;
    let compute_mib = (intercept + slope * ctx as f64).max(0.0);

    Ok(ColdForecast {
        weights_mib,
        kv_mib,
        compute_mib,
        total_mib: weights_mib + kv_mib + compute_mib,
        basis: ColdBasis {
            arch: target.arch,
            layers: target.layers,
            split: split_norm,
            batch,
            ubatch,
            points: point_rows,
            intercept_mib: intercept,
            slope_mib_per_token: slope,
            kv_layer_ratio,
            kv_samples: kv_ratios.len(),
        },
    })
}

/// Cold forecast for the app: what a never-launched model should cost at this configuration.
#[tauri::command]
pub fn get_cold_forecast(
    model_path: String,
    ctx: u64,
    kv_quant: String,
    split: String,
    batch: u32,
    ubatch: u32,
    exclude_model: Option<String>,
) -> Result<ColdForecast, String> {
    tokio::task::block_in_place(|| {
        cold_forecast(
            &model_path,
            ctx,
            &kv_quant,
            &split,
            batch,
            ubatch,
            exclude_model.as_deref(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::fit_affine;

    #[test]
    fn affine_fit_matches_the_measured_curve() {
        // Measured on the test box: compute buffers at batch 8192, split=layer.
        let points = [(65536.0, 7411.0), (131072.0, 11859.0), (262144.0, 21075.0), (524288.0, 39507.0)];
        let (intercept, slope) = fit_affine(&points).unwrap();
        assert!(intercept > 2000.0 && intercept < 3500.0, "intercept {intercept}");
        // ~70 MiB per 1k tokens.
        assert!(slope > 0.05 && slope < 0.09, "slope {slope}");
        for (ctx, measured) in points {
            let predicted = intercept + slope * ctx;
            let error = (predicted - measured).abs();
            assert!(error < measured * 0.02, "ctx {ctx}: predicted {predicted} vs {measured}");
        }
    }

    #[test]
    fn a_single_point_cannot_determine_a_slope() {
        assert!(fit_affine(&[(65536.0, 7411.0)]).is_none());
        assert!(fit_affine(&[]).is_none());
    }
}
