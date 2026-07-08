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
    pub fn wave_ready(&self, busy_slots: usize) -> bool {
        if self.latched_peak <= 1 {
            return true;
        }
        busy_slots + 2 >= self.latched_peak
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
    pub fn note_decode_wave(&mut self, now: Instant, busy_slots: usize, any_decode: bool, any_pp: bool) {
        if self.latched_peak <= 1 || busy_slots <= 1 {
            return;
        }
        if any_decode && !any_pp && self.decode_wall_at.is_none() {
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
    if !tps.is_finite() || tps <= 0.0 {
        0.0
    } else {
        tps.min(MAX_DISPLAY_TPS)
    }
}