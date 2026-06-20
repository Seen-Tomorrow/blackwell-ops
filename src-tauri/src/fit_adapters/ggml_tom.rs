//! TheTom turboquant fork — no `--fit-print`; totals on `llama_params_fit_impl` lines.
//!
//! Skips: MTP models (whole scan) and tensor split points until `llama-fit-params` gains support.

use std::sync::OnceLock;

use crate::fit_scanner::{parse_fit_breakdown, parse_gpu_components, FitScanRaw, MemoryBreakdownTable};

pub const TOM_MTP_SKIP_NOTE: &str =
    "MTP model — Tom does not load draft/MTP models yet";

pub const TOM_TENSOR_SKIP_NOTE: &str =
    "Tensor split — Tom llama-fit-params does not support SPLIT_MODE_TENSOR yet; no FIT data until tool update";

/// MTP / draft model — GGUF meta (`nextn_predict_layers`), HF repo, or path heuristics.
pub fn is_mtp_model(model_path: &str) -> bool {
    if crate::model_cache::get_cached(model_path)
        .map(|m| m.nextn_predict_layers > 0)
        .unwrap_or(false)
    {
        return true;
    }

    if let Some(hf) = crate::model_cache::get_hf_metadata(model_path) {
        let id_lower = hf.hf_model_id.to_lowercase();
        let repo_lower = hf.repo_name.to_lowercase();
        if id_lower.contains("mtp") || repo_lower.contains("mtp") {
            return true;
        }
    }

    let path_lower = model_path.replace('\\', "/").to_lowercase();
    path_lower.contains("mtp-gguf") || path_lower.contains("-mtp-")
}

/// Whole-model skip (MTP).
pub fn model_skip_note(model_path: &str) -> Option<&'static str> {
    if is_mtp_model(model_path) {
        Some(TOM_MTP_SKIP_NOTE)
    } else {
        None
    }
}

/// Per-point skip (tensor split labels only).
pub fn point_skip_note(label: &str, split_mode: &str) -> Option<&'static str> {
    if split_mode.eq_ignore_ascii_case("tensor")
        || label.starts_with("split_tensor_")
    {
        Some(TOM_TENSOR_SKIP_NOTE)
    } else {
        None
    }
}

pub fn build_scan_args(
    model_path: &str,
    ctx_tokens: usize,
    kv_quant: &str,
    batch: u32,
    ubatch: u32,
    parallel: u32,
    split_mode: &str,
) -> Vec<String> {
    crate::fit_scanner::build_fit_command_base(
        model_path,
        ctx_tokens,
        kv_quant,
        batch,
        ubatch,
        parallel,
        split_mode,
        false,
    )
}

/// Tom stderr line eligible for learned-VRAM buffering.
pub fn is_vram_learn_line(line: &str) -> bool {
    line.to_lowercase().contains("llama_params_fit_impl")
}

/// Tom: complete when `projected to use N MiB of device memory` is printed.
pub fn is_vram_learn_complete_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("llama_params_fit_impl")
        && lower.contains("projected to use")
        && lower.contains("device memory")
        && parse_tom_projected_line_mib(line).is_some()
}

/// Every projected device-memory total in order (MoE --fit may emit several).
pub fn parse_vram_learn_tables(output: &str) -> Vec<MemoryBreakdownTable> {
    output
        .lines()
        .filter_map(|line| {
            let mib = parse_tom_projected_line_mib(line)?;
            Some(MemoryBreakdownTable {
                gpu_self_mib: vec![mib],
                host_mib: None,
            })
        })
        .collect()
}

/// Tom: `llama_params_fit_impl: projected to use 15480 MiB of device memory vs. ...`
fn parse_tom_projected_total_mib(output: &str) -> Option<f64> {
    output
        .lines()
        .filter_map(parse_tom_projected_line_mib)
        .last()
}

/// `llama_params_fit_impl` device-memory total only — never CUDA init / GPU capacity lines.
fn parse_tom_projected_line_mib(line: &str) -> Option<f64> {
    let lower = line.to_lowercase();
    if !lower.contains("llama_params_fit_impl")
        || !lower.contains("projected to use")
        || !lower.contains("device memory")
        || !lower.contains("mib")
    {
        return None;
    }
    parse_tom_projected_line_mib_core(line)
}

fn parse_tom_projected_line_mib_core(line: &str) -> Option<f64> {
    let caps = re_tom_projected().captures(line)?;
    let v = caps.get(1)?.as_str().replace(',', "").parse::<f64>().ok()?;
    if v > 0.0 { Some(v) } else { None }
}

fn re_tom_projected() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?i)projected\s+to\s+use\s+([\d.,]+)\s*MiB")
            .expect("tom projected regex")
    })
}

pub fn parse_scan_output(stdout: &str, stderr: &str) -> Option<FitScanRaw> {
    let combined = format!("{stdout}\n{stderr}");

    let vram_mib = parse_tom_projected_total_mib(&combined)?;

    if vram_mib <= 0.0 {
        return None;
    }

    let (gpu_breakdown_mib, host_mib) = parse_fit_breakdown(&combined);
    let gpu_components_mib = parse_gpu_components(&combined);

    Some(FitScanRaw {
        vram_mib,
        gpu_breakdown_mib,
        host_mib,
        gpu_components_mib,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOM_FIT: &str = r#"llama_params_fit_impl: projected memory use with initial parameters [MiB]:
llama_params_fit_impl:   - CUDA0 (NVIDIA RTX PRO 6000 Blackwell Workstation Edition):  97886 total,   7313 used,  87965 free vs. target of   1024
llama_params_fit_impl: projected to use 15480 MiB of device memory vs. 190564 MiB of free device memory
"#;

    #[test]
    fn parses_tom_projected_total_not_gpu_vram() {
        const CUDA_INIT: &str =
            "ggml_cuda_init: found 2 CUDA devices (Total VRAM: 195773 MiB):\n  Device 0: VRAM: 97886 MiB\n";
        let raw = parse_scan_output("", &format!("{CUDA_INIT}{TOM_FIT}")).expect("tom fit");
        assert!((raw.vram_mib - 15480.0).abs() < 0.1);
    }

    #[test]
    fn cuda_init_vram_alone_is_not_fit_total() {
        const CUDA_INIT: &str =
            "ggml_cuda_init: found 1 CUDA devices (Total VRAM: 97886 MiB):\n  Device 0: VRAM: 97886 MiB\n";
        assert!(parse_scan_output("", CUDA_INIT).is_none());
    }

    #[test]
    fn tensor_point_skip_note() {
        assert!(point_skip_note("split_tensor_64k", "tensor").is_some());
        assert!(point_skip_note("base", "none").is_none());
    }

    #[test]
    fn is_mtp_model_detects_mtp_gguf_path() {
        assert!(is_mtp_model(
            r"C:\models\unsloth\Qwen3.6-27B-MTP-GGUF\Qwen3.6-27B-UD-IQ2_XXS.gguf"
        ));
    }
}