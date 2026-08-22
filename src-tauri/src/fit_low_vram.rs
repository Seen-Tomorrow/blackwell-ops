//! Free-aware low-VRAM FIT path (manual RE-PROBE LOW VRAM).
//! Isolated from library spine scans — see docs/LOW-VRAM-REPROBE.md.

use crate::fit_scanner::{run_fit_process_blocking, FitScanRaw};
use regex::Regex;
use std::sync::LazyLock;
use std::time::Duration;

/// Host self MiB above this is treated as weight-class spill (not fit-print buffer).
pub const HOST_BUFFER_CEILING_MIB: f64 = 2.5 * 1024.0;

static LIST_DEVICES_FREE_RE: LazyLock<Regex> = LazyLock::new(|| {
    // CUDA0: NVIDIA … (97886 MiB, 95357 MiB free)
    Regex::new(r"(?i)CUDA\d+[^:]*:\s*.*?\(\s*([\d.]+)\s*MiB\s*,\s*([\d.]+)\s*MiB\s+free\s*\)")
        .expect("list-devices free regex")
});

static FITTED_NGL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|\s)-ngl\s+(-?\d+)").expect("fitted ngl regex")
});

/// Parse per-device free MiB from `llama-fit-params --list-devices` stdout/stderr.
pub fn parse_list_devices_free_mib(output: &str) -> Vec<f64> {
    LIST_DEVICES_FREE_RE
        .captures_iter(output)
        .filter_map(|c| c.get(2)?.as_str().parse::<f64>().ok())
        .filter(|v| *v >= 0.0)
        .collect()
}

/// Parse last fitted `-ngl N` from fit-on stdout/stderr (−1 = all layers).
pub fn parse_fitted_ngl(output: &str) -> Option<i32> {
    let mut last = None;
    for c in FITTED_NGL_RE.captures_iter(output) {
        if let Ok(n) = c.get(1)?.as_str().parse::<i32>() {
            last = Some(n);
        }
    }
    last
}

/// Map FIT free vs NVML free → `--fit-target` so usable ≈ nvmlFree − headroom.
pub fn fit_target_mib_from_free(fit_free_mib: f64, nvml_free_mib: f64) -> u32 {
    let nvml = nvml_free_mib.max(0.0);
    let fit_free = fit_free_mib.max(0.0);
    let headroom = (nvml * 0.03).max(1024.0);
    let want_usable = (nvml - headroom).max(0.0);
    let target = (fit_free - want_usable).max(1024.0);
    target.round().clamp(1024.0, 512_000.0) as u32
}

/// Free-aware FIT args — **no** `-ngl 999` (allows real host weight spill).
pub fn build_low_vram_fit_command(
    model_path: &str,
    ctx_tokens: usize,
    kv_quant: &str,
    batch: u32,
    ubatch: u32,
    split_mode: &str,
    fit_target_mib: u32,
) -> Vec<String> {
    let mut args = vec![
        "-m".into(),
        model_path.into(),
        "--fit".into(),
        "on".into(),
        "--fit-ctx".into(),
        ctx_tokens.to_string(),
        "--fit-target".into(),
        fit_target_mib.to_string(),
        "--cache-type-k".into(),
        kv_quant.to_lowercase(),
        "--cache-type-v".into(),
        kv_quant.to_lowercase(),
        "--ctx-size".into(),
        ctx_tokens.to_string(),
        "--batch-size".into(),
        batch.to_string(),
        "--ubatch-size".into(),
        ubatch.to_string(),
        "--flash-attn".into(),
        "on".into(),
    ];
    if !split_mode.is_empty() && split_mode.to_lowercase() != "none" {
        args.extend(["--split-mode".into(), split_mode.to_lowercase()]);
    }
    args
}

/// Quick `--list-devices` free read (same CUDA_VISIBLE as the probe).
pub fn list_devices_free_mib(
    fit_binary: &str,
    cuda_visible_devices: &str,
) -> Result<Vec<f64>, String> {
    let output = run_fit_process_blocking(
        fit_binary,
        &["--list-devices".into()],
        cuda_visible_devices,
        Duration::from_secs(15),
    )?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}\n{stderr}");
    let frees = parse_list_devices_free_mib(&combined);
    if frees.is_empty() {
        return Err("low-vram: --list-devices returned no CUDA free lines".into());
    }
    Ok(frees)
}

/// Whether host_mib looks like weight spill vs fit-print buffer.
pub fn host_is_weight_class(host_mib: Option<f64>) -> bool {
    host_mib.map(|h| h > HOST_BUFFER_CEILING_MIB).unwrap_or(false)
}

/// Attach fitted ngl onto a raw scan result when present in logs.
pub fn enrich_raw_with_fitted_ngl(raw: &mut FitScanRaw, combined_logs: &str) {
    if let Some(ngl) = parse_fitted_ngl(combined_logs) {
        raw.fitted_ngl = Some(ngl);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_list_devices_free() {
        const OUT: &str = r#"
Available devices:
  CUDA0: NVIDIA RTX PRO 6000 Blackwell Workstation Edition (97886 MiB, 56353 MiB free)
  CUDA1: NVIDIA RTX PRO 6000 Blackwell Workstation Edition (97886 MiB, 95357 MiB free)
"#;
        let f = parse_list_devices_free_mib(OUT);
        assert_eq!(f.len(), 2);
        assert!((f[0] - 56353.0).abs() < 0.1);
        assert!((f[1] - 95357.0).abs() < 0.1);
    }

    #[test]
    fn fit_target_pulls_budget_to_nvml() {
        let t = fit_target_mib_from_free(95_000.0, 55_000.0);
        assert!(t > 30_000 && t < 50_000, "target={t}");
    }

    #[test]
    fn fit_target_floor_when_free_matches() {
        let t = fit_target_mib_from_free(50_000.0, 50_000.0);
        // headroom 1500, want 48500, target = 1500
        assert_eq!(t, 1500);
    }

    #[test]
    fn parses_fitted_ngl() {
        assert_eq!(
            parse_fitted_ngl("printing fitted CLI args:\n-c 131072 -ngl 40 -b 512\n"),
            Some(40)
        );
        assert_eq!(parse_fitted_ngl("-c 524288 -ngl -1\n"), Some(-1));
    }

    #[test]
    fn low_vram_args_skip_ngl_999() {
        let args = build_low_vram_fit_command("m.gguf", 131072, "f16", 512, 512, "none", 20_000);
        let joined = args.join(" ");
        assert!(joined.contains("--fit"));
        assert!(joined.contains("on"));
        assert!(joined.contains("--fit-target"));
        assert!(joined.contains("20000"));
        assert!(!joined.contains("999"));
        assert!(!joined.contains("--fit-print"));
    }
}
