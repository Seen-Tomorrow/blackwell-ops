//! ggml-org master — `--fit-print on` stdout table + stderr breakdown belt.

use crate::fit_scanner::{
    parse_all_memory_breakdown_tables, parse_fit_breakdown, parse_fit_output, parse_fit_print_stdout,
    parse_gpu_components, parse_projected_vram, FitScanRaw, MemoryBreakdownTable,
};

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
        true,
    )
}

pub fn parse_scan_output(stdout: &str, stderr: &str) -> Option<FitScanRaw> {
    if let Some(raw) = parse_fit_print_stdout(stdout) {
        return Some(raw);
    }

    let combined = format!("{stdout}\n{stderr}");
    // Prefer the last memory-breakdown table over early "projected to use" lines from multi-pass --fit on.
    let vram_mib = crate::fit_scanner::parse_engine_memory_breakdown_mib(&combined)
        .or_else(|| parse_fit_output(&combined))
        .or_else(|| parse_projected_vram(&combined))?;

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

pub fn is_vram_learn_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("common_memory_breakdown_print") || lower.contains("memory breakdown")
}

pub fn is_vram_learn_complete_line(line: &str) -> bool {
    crate::fit_scanner::is_complete_memory_breakdown_table_line(line)
}

pub fn parse_vram_learn_tables(output: &str) -> Vec<MemoryBreakdownTable> {
    parse_all_memory_breakdown_tables(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn master_fit_print_stdout() {
        const OUT: &str = "CUDA0 20386 2197 505\nHost 994 0 52\n";
        let raw = parse_scan_output(OUT, "").expect("master fit-print");
        assert_eq!(raw.vram_mib, 23088.0);
    }

    #[test]
    fn master_fit_print_meta_is_not_doubled() {
        // fit-print Meta ≈ full estimate (same class as none) — must NOT ×N like LEARN shards.
        const OUT: &str = "Meta 10238 2176 1136\nHost 994 0 84\n";
        const ERR: &str =
            "llama_prepare_model_devices: creating a Meta device for tensor parallelism from 2 devices:\n";
        let raw = parse_scan_output(OUT, ERR).expect("meta fit-print");
        let once = 10238.0 + 2176.0 + 1136.0;
        assert!((raw.vram_mib - once).abs() < 0.1);
        assert_eq!(raw.gpu_breakdown_mib.as_ref().map(|g: &Vec<f64>| g.len()), Some(1));
    }
}
