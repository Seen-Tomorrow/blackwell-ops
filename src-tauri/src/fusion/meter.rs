//! Hero meter lanes — single-slot (stderr belt + burst) vs parallel aggregate (poll-only).

use std::time::Instant;

use serde::Serialize;

const MAX_DISPLAY_TPS: f64 = 200_000.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
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
        if any_decode && !pp_block && self.decode_wall_at.is_none() {
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
}
