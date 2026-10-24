//! Hero meter lanes — single-slot (stderr belt + burst) vs parallel aggregate (poll-only).

use std::time::Instant;

use serde::{Deserialize, Serialize};

const MAX_DISPLAY_TPS: f64 = 200_000.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FusionMeterLane {
    Single,
    Parallel,
}

/// Parallel 8–64× bench: one wall clock, summed tokens — stderr `print_timing` is per-slot.
#[derive(Clone, Debug, Default)]
pub struct ParallelMeter {
    latched_peak: usize,
    decode_wall_at: Option<Instant>,
    prefill_wall_at: Option<Instant>,
}

impl ParallelMeter {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn lane(&self, busy_slots: usize) -> FusionMeterLane {
        if self.latched_peak > 1 || busy_slots > 1 {
            FusionMeterLane::Parallel
        } else {
            FusionMeterLane::Single
        }
    }

    pub fn is_parallel(&self, busy_slots: usize) -> bool {
        self.lane(busy_slots) == FusionMeterLane::Parallel
    }

    /// Track peak concurrent requests/slots (latched for the wave).
    pub fn observe_wave(&mut self, requests_processing: usize, busy_slots: usize) {
        let peak = requests_processing.max(busy_slots);
        if peak > self.latched_peak {
            self.latched_peak = peak;
        }
        if requests_processing == 0 && busy_slots == 0 {
            self.latched_peak = 0;
            self.decode_wall_at = None;
            self.prefill_wall_at = None;
        }
    }

    /// Hysteresis — /slots busy can trail /metrics by a tick during launch/teardown.
    /// `tolerant` (no-log-belt engines): trust the latched peak without the +2 margin, so a
    /// staggered multi-slot wave (polls never see all slots busy at once) still opens the TG/PP
    /// windows instead of staying locked on a peak that no single poll reproduces.
    pub fn wave_ready(&self, busy_slots: usize, tolerant: bool) -> bool {
        if self.latched_peak <= 1 {
            return true;
        }
        if tolerant {
            busy_slots > 0
        } else {
            busy_slots + 2 >= self.latched_peak
        }
    }

    pub fn latched_peak(&self) -> usize {
        self.latched_peak
    }

    pub fn note_prefill_wave(&mut self, now: Instant, busy_slots: usize) {
        if self.latched_peak > 1 && busy_slots > 1 && self.prefill_wall_at.is_none() {
            self.prefill_wall_at = Some(now);
        }
    }

    /// Start decode wall when every busy slot has left PP (matches bench aggregate window).
    /// `tolerant` (no-log-belt engines): trust the latched wave peak even when a single poll only
    /// sees one busy slot, and start decode once ANY decode is observed — without stderr log lines
    /// there is no exact "all PP done" signal, so the wall must not be locked by a straggler PP row.
    pub fn note_decode_wave(
        &mut self,
        now: Instant,
        busy_slots: usize,
        any_decode: bool,
        any_pp: bool,
        tolerant: bool,
        all_lanes_decoding: bool,
    ) {
        if self.latched_peak <= 1 {
            return;
        }
        let concurrent = if tolerant { busy_slots.max(1) } else { busy_slots };
        if concurrent < 2 && !tolerant {
            return;
        }
        let pp_block = if tolerant {
            // Without a log belt, only block decode-wall start while a slot is still clearly mid-prefill
            // (decode on the same slot means it has left PP). A lone straggler PP row must not hold the
            // wall forever, so allow start once decode is observed and the peak wave is known.
            false
        } else {
            any_pp
        };
        // Every processing lane must have produced a token: a queued lane is neither prefilling
        // nor decoding, so `!any_pp` alone lets the wall open mid-ramp and dilutes the average.
        if any_decode && !pp_block && all_lanes_decoding && self.decode_wall_at.is_none() {
            self.decode_wall_at = Some(now);
        }
    }

    pub fn decode_wall_at(&self) -> Option<Instant> {
        self.decode_wall_at
    }

    pub fn prefill_wall_at(&self) -> Option<Instant> {
        self.prefill_wall_at
    }

    pub fn wall_tps(tokens: usize, start: Option<Instant>, min_ms: u64) -> f64 {
        let Some(start) = start else {
            return 0.0;
        };
        let ms = start.elapsed().as_millis() as u64;
        if ms >= min_ms && tokens > 0 {
            clamp_display_tps((tokens as f64 / ms as f64) * 1000.0)
        } else {
            0.0
        }
    }
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
/// it once during warmup, so its numbers exclude it. See
/// `docs/ENGINE-TELEMETRY-SSE-HANDOFF.md`.
pub const PREFILL_SETUP_MS: f64 = 54.0;

/// Prefill tok/s with the per-request setup deducted — the figure comparable to llama-bench.
///
/// The deduction is capped at 65 % of the measured window: a very short prompt is mostly setup,
/// and subtracting the full constant there would invent a throughput the engine never produced.
///
/// Shared by the poll brain and the SSE brain; do not re-derive it on either path.
pub fn steady_prefill_tps(tokens: f64, slot_ms: f64) -> f64 {
    if tokens <= 0.0 || slot_ms <= 0.0 {
        return 0.0;
    }
    let deduction = PREFILL_SETUP_MS.min(slot_ms * 0.65);
    clamp_display_tps(tokens / (slot_ms - deduction) * 1000.0)
}

/// Prefill tok/s from the library's own prompt-eval clock (`t_p_eval_ms`).
///
/// No setup deduction: the timestamp is already inside the library, so this number excludes the
/// server's HTTP/slot floor and the 54 ms calibration. It does **not** remove llama-server's
/// context-checkpoint copies — measured on b11842 they land inside `t_p_eval` too (42 157-token
/// A/B: 7 661 slot / 7 734 lib with checkpoints, 8 914 with `-ctxcp 0`, so lib only closes ~1 %
/// of a ~14 % gap). Only `-ctxcp 0` removes that cost; this figure is the uncalibrated cross-check
/// shown as the small companion readout.
pub fn lib_prefill_tps(tokens: u64, lib_ms: f64) -> f64 {
    if tokens == 0 || lib_ms <= 0.0 {
        return 0.0;
    }
    clamp_display_tps(tokens as f64 / (lib_ms / 1000.0))
}

/// Session-average tok/s from cumulative tokens + cumulative wall ms (hero AVG mode).
/// Pure — no brain state. Returns 0 until the wall exceeds `min_ms` (filters elapsed≈0 spikes).
pub fn session_avg_tps(total_tokens: u64, total_ms: u64, min_ms: u64) -> f64 {
    if total_ms >= min_ms && total_tokens > 0 {
        clamp_display_tps((total_tokens as f64 / total_ms as f64) * 1000.0)
    } else {
        0.0
    }
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
    fn decode_wall_waits_for_the_last_lane() {
        let now = Instant::now();
        let mut meter = ParallelMeter::default();
        meter.observe_wave(32, 32);

        // Ramp: some lanes decode while others still prefill. Starting the wall here is what
        // diluted the x32 average for minutes, so it must stay closed.
        meter.note_decode_wave(now, 32, true, false, false, false);
        assert!(meter.decode_wall_at().is_none(), "wall must not open mid-ramp");

        // Last lane produced its first token: this is the moment the clock may start.
        meter.note_decode_wave(now, 32, true, false, false, true);
        assert!(meter.decode_wall_at().is_some(), "wall opens when every lane decodes");
    }

    #[test]
    fn steady_pp_deducts_setup_from_a_512_prefill() {
        // 513 tokens in 161.6 ms is the measured shape; llama-bench reports ~4895 on the same run.
        let tps = steady_prefill_tps(513.0, 161.6);
        assert!((tps - 4768.0).abs() < 100.0, "got {tps}");
    }

    #[test]
    fn steady_pp_long_prompts_barely_move() {
        // 4097 tokens in 883.8 ms: the 54 ms is noise at this size.
        let tps = steady_prefill_tps(4097.0, 883.8);
        assert!((tps - 4942.0).abs() < 250.0, "got {tps}");
    }

    #[test]
    fn steady_pp_short_prompts_cannot_explode() {
        // 11 tokens in 85 ms is mostly setup; the deduction is capped so the figure stays sane.
        let tps = steady_prefill_tps(11.0, 85.0);
        assert!(tps > 0.0 && tps < 1000.0, "got {tps}");
    }

    #[test]
    fn steady_pp_zero_inputs_are_zero() {
        assert_eq!(steady_prefill_tps(0.0, 100.0), 0.0);
        assert_eq!(steady_prefill_tps(100.0, 0.0), 0.0);
    }

    #[test]
    fn lib_pp_reads_straight_off_the_library_clock() {
        // 16 223 tokens / 2 286.49 ms is the measured 16K shape: 7 095 tok/s, no setup deduction.
        let tps = lib_prefill_tps(16_223, 2286.49);
        assert!((tps - 7095.0).abs() < 1.0, "got {tps}");
        // Same request on the slot clock (2 440 ms incl. two checkpoint copies) is ~6 % lower —
        // the gap between the two readouts is exactly the point of showing both.
        let slot = steady_prefill_tps(16_223.0, 2440.0);
        assert!(slot < tps, "slot {slot} must sit below lib {tps}");
    }

    #[test]
    fn lib_pp_zero_inputs_are_zero() {
        assert_eq!(lib_prefill_tps(0, 100.0), 0.0);
        assert_eq!(lib_prefill_tps(100, 0.0), 0.0);
    }
}
