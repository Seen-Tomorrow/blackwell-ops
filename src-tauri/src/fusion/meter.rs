//! Hero meter lanes and pure TPS math shared by `SseBrain` and `RequestLifecycle`.

use serde::{Deserialize, Serialize};

const MAX_DISPLAY_TPS: f64 = 200_000.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FusionMeterLane {
    Single,
    Parallel,
}

pub fn clamp_display_tps(tps: f64) -> f64 {
    if !tps.is_finite() || tps <= 0.0 || tps >= MAX_DISPLAY_TPS {
        0.0
    } else {
        tps
    }
}

/// Fixed per-request setup the server charges before a prompt starts moving tokens.
///
/// Measured on b11841: 54 ms for IQ3_XXS, 46-55 ms for Q4_K_M / Q6_K, quant-independent, split
/// as ~18 ms HTTP/slot floor plus ~40 ms first-prefill setup inside `t_p_eval`. llama-bench pays
/// it once during warmup, so its numbers exclude it. See `docs/ENGINE-TELEMETRY-SSE-HANDOFF.md`.
pub const PREFILL_SETUP_MS: f64 = 54.0;

/// Prefill tok/s with the per-request setup deducted — the figure comparable to llama-bench.
///
/// The deduction is capped at 65 % of the measured window: a very short prompt is mostly setup,
/// and subtracting the full constant there would invent a throughput the engine never produced.
pub fn steady_prefill_tps(tokens: f64, slot_ms: f64) -> f64 {
    if tokens <= 0.0 || slot_ms <= 0.0 {
        return 0.0;
    }
    let deduction = PREFILL_SETUP_MS.min(slot_ms * 0.65);
    clamp_display_tps(tokens / (slot_ms - deduction) * 1000.0)
}

/// System TG tok/s ÷ concurrent slots — “per agent” rate under multi-slot load.
/// Returns 0 when there's nothing to divide (no system rate, or ≤1 slot).
pub fn per_slot_tps(system: f64, concurrent: usize) -> f64 {
    if system <= 0.0 || concurrent <= 1 {
        return 0.0;
    }
    clamp_display_tps(system / concurrent as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_rejects_ceiling_spike() {
        assert_eq!(clamp_display_tps(200_000.0), 0.0);
        assert_eq!(clamp_display_tps(1_000_000.0), 0.0);
        assert!(clamp_display_tps(21_049.0) > 0.0);
    }

    #[test]
    fn steady_pp_deducts_setup_from_a_512_prefill() {
        let tps = steady_prefill_tps(513.0, 161.6);
        assert!((tps - 4768.0).abs() < 100.0, "got {tps}");
    }

    #[test]
    fn steady_pp_long_prompts_barely_move() {
        let tps = steady_prefill_tps(4097.0, 883.8);
        assert!((tps - 4942.0).abs() < 250.0, "got {tps}");
    }

    #[test]
    fn steady_pp_short_prompts_cannot_explode() {
        let tps = steady_prefill_tps(11.0, 85.0);
        assert!(tps > 0.0 && tps < 1000.0, "got {tps}");
    }

    #[test]
    fn steady_pp_zero_inputs_are_zero() {
        assert_eq!(steady_prefill_tps(0.0, 100.0), 0.0);
        assert_eq!(steady_prefill_tps(100.0, 0.0), 0.0);
    }
}
