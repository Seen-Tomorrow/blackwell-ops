//! Post-launch engine stderr parser — ground-truth VRAM/RAM from buffer allocation lines.
//!
//! # Architecture memo — add parsers, do not stretch one regex forever
//!
//! llama.cpp log vocabulary varies by model family. **`ggml_generic_v1`** (this module) targets
//! ggml-org master server stderr shared across many dense/MoE builds. When a new architecture
//! uses different tags, add a sibling parser id (e.g. `ggml_mamba_v1`) and route by detected
//! `general.architecture` / log markers — keep the output shape [`LaunchMemorySnapshot`] stable.
//!
//! ## Reference profile: **QWEN3.6-27B MTP** (session 2026-07-11, dual RTX PRO 6000, layer split)
//!
//! | Phase | Log marker | Example line | Usable fields |
//! |-------|------------|--------------|---------------|
//! | Vision estimate | `srv load_model: [mtmd]` | `estimated worst-case memory usage of mmproj is 2030.57 MiB` | `vision_estimate_mib` |
//! | FIT probe (pre-weight) | `common_memory_breakdown_print` | CUDA self + Host row **before** `fitting params` | `fit_attempts` only — not final |
//! | MTP early estimate | `srv load_model: [spec]` | `estimated memory usage of MTP context is 6548.13 MiB` | `mtp_estimate_mib` (under-counts vs buffers) |
//! | Weights | `load_tensors:` | `CUDA0 model buffer size = 7788.32 MiB` | `buffers[]` category `model` |
//! | KV | `llama_kv_cache:` | `CUDA0 KV buffer size = 16384.00 MiB` | `buffers[]` category `kv` |
//! | Recurrent (hybrid) | `llama_memory_recurrent:` | `CUDA0 RS buffer size = 311.72 MiB` | `buffers[]` category `rs` — **Qwen3.5 only** |
//! | Compute graph | `sched_reserve:` | `CUDA0 compute buffer size = 6360.13 MiB` | `buffers[]` category `compute` |
//! | Pinned host | `sched_reserve:` | `CUDA_Host compute buffer size = 4136.14 MiB` | `host_pinned_mib` — **not GPU** |
//! | MTP draft ctx | `common_speculative_init` + 2nd `llama_kv_cache` | `CUDA1 KV buffer size = 2048.00 MiB` (1 layer) | `mtp_context_mib` sum |
//! | Vision load | `load_hparams: model size:` | `model size: 1757.55 MiB` | `vision_mib` |
//! | CLIP compute | `reserve_compute_meta:` | `CUDA0 compute buffer size = 248.10 MiB` | `buffers[]` category `vision_compute` |
//! | Context cap | `srv load_model:` | `slot context (524288) exceeds training context (262144) - capping` | `effective_ctx` |
//! | Prompt cache ceiling | `srv load_model:` | `prompt cache is enabled, size limit: 8192 MiB` | `prompt_cache_limit_mib` |
//! | Ready | `llama_server:` | `model loaded` | parse trigger — aggregate lines **before** this |
//!
//! **MTP note:** draft context uses mix of GPU1 KV/compute + `CUDA_Host` pinned RAM. FIT/`llama-fit-params`
//! omits spec flags today — learned launch snapshot is authoritative when `--spec-type` is set.
//!
//! **Aggregation:** per-GPU NVML attribution = sum of all non-`CUDA_Host`/`CPU` buffer lines on that device.
//! Host forecast = CPU model buffers + all `CUDA_Host` + optional prompt-cache limit.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::fit_scanner::{parse_all_memory_breakdown_tables, parse_gpu_components, GpuComponentMib};

pub const PARSER_GGML_GENERIC_V1: &str = "ggml_generic_v1";
pub const PROFILE_QWEN36_27B_MTP: &str = "QWEN3.6-27B MTP";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BufferLine {
    pub device: String,
    pub category: String,
    pub mib: f64,
    /// Original log tag (`load_tensors`, `sched_reserve`, …).
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchMemorySnapshot {
    pub parser_id: String,
    /// Human reference profile when heuristics match (e.g. QWEN3.6-27B MTP).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference_profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub architecture: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_ctx: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_ctx: Option<u32>,
    /// Sum of GPU-resident buffers (CUDA* devices).
    pub vram_mib: f64,
    pub gpu_breakdown_mib: Vec<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_components_mib: Option<Vec<GpuComponentMib>>,
    /// CPU + pinned host buffers (MiB).
    pub host_mib: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_components_mib: Option<GpuComponentMib>,
    pub host_pinned_mib: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtp_estimate_mib: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtp_context_mib: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vision_estimate_mib: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vision_mib: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_cache_limit_mib: Option<f64>,
    pub buffers: Vec<BufferLine>,
    pub phase: String,
    pub measured_at: String,
}

/// True when a stderr line should be kept in the launch-learn buffer (ggml master/tom).
pub fn is_launch_memory_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("load_tensors:")
        || lower.contains("llama_kv_cache:")
        || lower.contains("llama_memory_recurrent:")
        || lower.contains("sched_reserve:")
        || lower.contains("reserve_compute_meta:")
        || lower.contains("estimated memory usage of mtp context")
        || lower.contains("estimated worst-case memory usage of mmproj")
        || lower.contains("load_hparams: model size:")
        || lower.contains("prompt cache is enabled")
        || lower.contains("exceeds the training context")
        || lower.contains("common_speculative_init")
        || lower.contains("speculative decoding context initialized")
        || lower.contains("llama_server: model loaded")
        || lower.contains("general.architecture")
        || lower.contains("projected to use")
        || lower.contains("common_memory_breakdown_print")
        || lower.contains("memory breakdown")
}

fn extract_number(s: &str) -> Option<f64> {
    let mut num = String::new();
    let mut seen_digit = false;
    let mut seen_dot = false;
    for ch in s.chars() {
        if ch.is_ascii_digit() {
            num.push(ch);
            seen_digit = true;
        } else if ch == '.' && seen_digit && !seen_dot {
            num.push(ch);
            seen_dot = true;
        } else if seen_digit {
            break;
        }
    }
    if num.is_empty() {
        return None;
    }
    num.parse().ok()
}

fn parse_buffer_size_mib(line: &str) -> Option<f64> {
    let lower = line.to_lowercase();
    let idx = lower.rfind("buffer size =")?;
    extract_number(line[idx..].trim_start_matches(|c: char| !c.is_ascii_digit() && c != '.'))
}

fn device_from_padding_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    for token in ["CUDA_Host", "CUDA0", "CUDA1", "CUDA2", "CUDA3", "CPU"] {
        if trimmed.contains(token) {
            return Some(token.to_string());
        }
    }
    None
}

fn push_buffer(
    buffers: &mut Vec<BufferLine>,
    per_gpu: &mut HashMap<String, f64>,
    host_cpu: &mut f64,
    host_pinned: &mut f64,
    device: &str,
    category: &str,
    mib: f64,
    source: &str,
) {
    buffers.push(BufferLine {
        device: device.to_string(),
        category: category.to_string(),
        mib,
        source: source.to_string(),
    });
    match device {
        "CUDA_Host" => *host_pinned += mib,
        "CPU" => *host_cpu += mib,
        d if d.starts_with("CUDA") => {
            *per_gpu.entry(d.to_string()).or_insert(0.0) += mib;
        }
        _ => {}
    }
}

fn detect_architecture(output: &str) -> Option<String> {
    for line in output.lines() {
        if line.contains("general.architecture") {
            if let Some(rest) = line.split('=').nth(1) {
                let arch = rest.trim().trim_matches(|c| c == '"' || c == '\'');
                if !arch.is_empty() {
                    return Some(arch.to_string());
                }
            }
        }
        if line.contains("print_info: arch") {
            if let Some(rest) = line.split('=').nth(1) {
                let arch = rest.trim();
                if !arch.is_empty() {
                    return Some(arch.to_string());
                }
            }
        }
    }
    None
}

fn detect_reference_profile(arch: Option<&str>, output: &str) -> Option<String> {
    let lower = output.to_lowercase();
    let is_mtp = lower.contains("draft-mtp")
        || lower.contains("estimated memory usage of mtp context")
        || lower.contains("common_speculative_init");
    let is_qwen35 = arch == Some("qwen35") || lower.contains("qwen35") || lower.contains("qwen3.6");
    if is_qwen35 && is_mtp {
        return Some(PROFILE_QWEN36_27B_MTP.to_string());
    }
    None
}

fn parse_ctx_cap(output: &str) -> (Option<u32>, Option<u32>) {
    for line in output.lines() {
        let lower = line.to_lowercase();
        if !lower.contains("exceeds the training context") && !lower.contains("capping") {
            continue;
        }
        let mut nums: Vec<u32> = Vec::new();
        for token in line.split(|c: char| !c.is_ascii_digit()) {
            if let Ok(n) = token.parse::<u32>() {
                if n >= 1024 {
                    nums.push(n);
                }
            }
        }
        if nums.len() >= 2 {
            return (Some(nums[0]), Some(nums[1]));
        }
    }
    (None, None)
}

fn gpu_indices(per_gpu: &HashMap<String, f64>) -> Vec<usize> {
    let mut idxs: Vec<usize> = per_gpu
        .keys()
        .filter_map(|k| k.strip_prefix("CUDA").and_then(|n| n.parse().ok()))
        .collect();
    idxs.sort_unstable();
    idxs
}

fn build_gpu_breakdown(per_gpu: &HashMap<String, f64>) -> Vec<f64> {
    let idxs = gpu_indices(per_gpu);
    if idxs.is_empty() {
        return Vec::new();
    }
    let max_idx = *idxs.last().unwrap();
    let mut out = vec![0.0; max_idx + 1];
    for (dev, mib) in per_gpu {
        if let Some(n) = dev.strip_prefix("CUDA").and_then(|s| s.parse::<usize>().ok()) {
            out[n] += mib;
        }
    }
    out
}

fn components_from_buffers(buffers: &[BufferLine], gpu_count: usize) -> Option<Vec<GpuComponentMib>> {
    if gpu_count == 0 {
        return None;
    }
    let mut model = vec![0.0; gpu_count];
    let mut ctx = vec![0.0; gpu_count];
    let mut compute = vec![0.0; gpu_count];
    for b in buffers {
        let Some(idx) = b.device.strip_prefix("CUDA").and_then(|s| s.parse::<usize>().ok()) else {
            continue;
        };
        if idx >= gpu_count {
            continue;
        }
        match b.category.as_str() {
            "model" => model[idx] += b.mib,
            "kv" => ctx[idx] += b.mib,
            "rs" | "compute" | "vision" | "vision_compute" | "output" => compute[idx] += b.mib,
            _ => {}
        }
    }
    Some(
        (0..gpu_count)
            .map(|i| GpuComponentMib {
                model_mib: model[i],
                ctx_mib: ctx[i],
                compute_mib: compute[i],
            })
            .collect(),
    )
}

/// Parse stderr accumulated through load; prefer region before `model loaded`.
pub fn parse_launch_memory_snapshot(output: &str) -> Option<LaunchMemorySnapshot> {
    let marker = "model loaded";
    let parse_region = if let Some(idx) = output.to_lowercase().find(marker) {
        &output[..idx]
    } else {
        output
    };

    if !parse_region.to_lowercase().contains("buffer size =") {
        return None;
    }

    let mut buffers: Vec<BufferLine> = Vec::new();
    let mut per_gpu: HashMap<String, f64> = HashMap::new();
    let mut host_cpu = 0.0_f64;
    let mut host_pinned = 0.0_f64;
    let mut mtp_estimate_mib = None;
    let mut vision_estimate_mib = None;
    let mut vision_mib = None;
    let mut prompt_cache_limit_mib = None;
    let mut past_spec_init = false;
    let mut mtp_extra_gpu = 0.0_f64;
    let mut mtp_extra_host = 0.0_f64;

    for line in parse_region.lines() {
        let lower = line.to_lowercase();

        if lower.contains("estimated memory usage of mtp context") {
            if let Some(pos) = lower.find(" is ") {
                mtp_estimate_mib = extract_number(&line[pos + 4..]);
            }
        }
        if lower.contains("estimated worst-case memory usage of mmproj") {
            if let Some(pos) = lower.find(" is ") {
                vision_estimate_mib = extract_number(&line[pos + 4..]);
            }
        }
        if lower.contains("load_hparams: model size:") {
            vision_mib = extract_number(line.split(':').last()?);
        }
        if lower.contains("prompt cache is enabled") && lower.contains("size limit:") {
            if let Some(pos) = lower.find("size limit:") {
                prompt_cache_limit_mib = extract_number(&line[pos + 11..]);
            }
        }
        if lower.contains("common_speculative_init") || lower.contains("creating mtp draft context") {
            past_spec_init = true;
        }

        let mib = match parse_buffer_size_mib(line) {
            Some(v) => v,
            None => continue,
        };
        let device = match device_from_padding_line(line) {
            Some(d) => d,
            None => continue,
        };

        let (category, source) = if lower.contains("load_tensors:") && lower.contains("model buffer") {
            ("model", "load_tensors")
        } else if lower.contains("llama_kv_cache:") && lower.contains("kv buffer") {
            ("kv", "llama_kv_cache")
        } else if lower.contains("llama_memory_recurrent:") {
            ("rs", "llama_memory_recurrent")
        } else if lower.contains("reserve_compute_meta:") {
            ("vision_compute", "reserve_compute_meta")
        } else if lower.contains("sched_reserve:") {
            ("compute", "sched_reserve")
        } else if lower.contains("llama_context:") && lower.contains("output buffer") {
            ("output", "llama_context")
        } else {
            continue;
        };

        if past_spec_init {
            if device == "CUDA_Host" {
                mtp_extra_host += mib;
            } else if device.starts_with("CUDA") {
                mtp_extra_gpu += mib;
            }
        }

        push_buffer(
            &mut buffers,
            &mut per_gpu,
            &mut host_cpu,
            &mut host_pinned,
            &device,
            category,
            mib,
            source,
        );
    }

    if per_gpu.is_empty() {
        return None;
    }

    let gpu_breakdown_mib = build_gpu_breakdown(&per_gpu);
    let vram_mib: f64 = gpu_breakdown_mib.iter().sum();
    if vram_mib <= 0.0 {
        return None;
    }

    let arch = detect_architecture(parse_region);
    let (requested_ctx, effective_ctx) = parse_ctx_cap(parse_region);
    let gpu_count = gpu_breakdown_mib.len();
    let gpu_components_mib = components_from_buffers(&buffers, gpu_count);

    let mut host_components_mib = None;
    let tables = parse_all_memory_breakdown_tables(parse_region);
    if let Some(table) = tables.last() {
        if let Some(components) = parse_gpu_components(parse_region) {
            if !components.is_empty() {
                // Prefer breakdown table components when a post-FIT complete table exists.
                let _ = components;
            }
        }
        if table.host_mib.is_some() {
            host_components_mib = parse_host_components_from_table(parse_region);
        }
    }

    let host_mib = host_cpu + host_pinned;
    let mtp_context_mib_final = if past_spec_init && (mtp_extra_gpu + mtp_extra_host) > 0.0 {
        Some(mtp_extra_gpu + mtp_extra_host)
    } else {
        mtp_estimate_mib
    };

    Some(LaunchMemorySnapshot {
        parser_id: PARSER_GGML_GENERIC_V1.to_string(),
        reference_profile: detect_reference_profile(arch.as_deref(), parse_region),
        architecture: arch,
        requested_ctx,
        effective_ctx,
        vram_mib,
        gpu_breakdown_mib,
        gpu_components_mib,
        host_mib,
        host_components_mib,
        host_pinned_mib: host_pinned,
        mtp_estimate_mib,
        mtp_context_mib: mtp_context_mib_final,
        vision_estimate_mib,
        vision_mib,
        prompt_cache_limit_mib,
        buffers,
        phase: "loaded".to_string(),
        measured_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
    })
}

fn parse_host_components_from_table(output: &str) -> Option<GpuComponentMib> {
    let tables = parse_all_memory_breakdown_tables(output);
    let table = tables.last()?;
    let host_self = table.host_mib?;
    // Host row format: `269 = 137 + 0 + 131` embedded in line — scan last host row.
    for line in output.lines().rev() {
        let lower = line.to_lowercase();
        if !lower.contains("host") || lower.contains("cuda") || !line.contains('|') {
            continue;
        }
        if let Some(pos) = line.find('=') {
            let tail = &line[pos..];
            let parts: Vec<&str> = tail.split('+').map(|s| s.trim()).collect();
            if parts.len() >= 3 {
                let model_mib = extract_number(parts[0].split('=').last()?)?;
                let ctx_mib = extract_number(parts[1])?;
                let compute_mib = extract_number(parts[2])?;
                let _ = host_self;
                return Some(GpuComponentMib {
                    model_mib,
                    ctx_mib,
                    compute_mib,
                });
            }
        }
        break;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const QWEN_LOAD_TAIL: &str = r#"0.01.878.440 I load_tensors:          CPU model buffer size =   682.03 MiB
0.01.878.441 I load_tensors:        CUDA0 model buffer size =  7788.32 MiB
0.01.878.442 I load_tensors:        CUDA1 model buffer size =  8598.61 MiB
0.05.518.272 I llama_kv_cache:      CUDA0 KV buffer size = 16384.00 MiB
0.05.696.565 I llama_kv_cache:      CUDA1 KV buffer size = 16384.00 MiB
0.05.861.522 I llama_memory_recurrent:      CUDA0 RS buffer size =   311.72 MiB
0.05.866.530 I llama_memory_recurrent:      CUDA1 RS buffer size =   286.78 MiB
0.06.231.477 I sched_reserve:      CUDA0 compute buffer size =  6360.13 MiB
0.06.231.483 I sched_reserve:      CUDA1 compute buffer size =  6360.13 MiB
0.06.231.485 I sched_reserve:  CUDA_Host compute buffer size =  4136.14 MiB
0.06.513.449 I common_speculative_init_result: creating MTP draft context
0.06.520.882 I llama_kv_cache:      CUDA1 KV buffer size =  2048.00 MiB
0.07.388.241 I sched_reserve:      CUDA1 compute buffer size =  4500.13 MiB
0.07.388.249 I sched_reserve:  CUDA_Host compute buffer size =  4196.14 MiB
0.07.390.092 I load_hparams: model size:         1757.55 MiB
0.08.937.638 I reserve_compute_meta:      CUDA0 compute buffer size =   248.10 MiB
0.08.940.260 W srv    load_model: the slot context (524288) exceeds the training context of the model (262144) - capping
0.10.288.375 I srv    load_model: prompt cache is enabled, size limit: 8192 MiB
0.10.334.874 I srv  llama_server: model loaded
"#;

    #[test]
    fn parses_qwen36_mtp_buffer_inventory() {
        let snap = parse_launch_memory_snapshot(QWEN_LOAD_TAIL).expect("snapshot");
        assert_eq!(snap.parser_id, PARSER_GGML_GENERIC_V1);
        assert_eq!(snap.reference_profile.as_deref(), Some(PROFILE_QWEN36_27B_MTP));
        assert_eq!(snap.gpu_breakdown_mib.len(), 2);
        assert!(snap.vram_mib > 60_000.0);
        assert!(snap.host_pinned_mib > 8000.0);
        assert!(snap.host_mib >= 682.0);
        assert_eq!(snap.effective_ctx, Some(262144));
        assert_eq!(snap.requested_ctx, Some(524288));
        assert_eq!(snap.prompt_cache_limit_mib, Some(8192.0));
        assert!(snap.vision_mib.unwrap() > 1700.0);
    }

    #[test]
    fn launch_memory_line_matcher() {
        assert!(is_launch_memory_line(
            "0.01.878.441 I load_tensors: CUDA0 model buffer size = 7788.32 MiB"
        ));
        assert!(!is_launch_memory_line("0.10.334.904 I srv  update_slots: all slots are idle"));
    }
}