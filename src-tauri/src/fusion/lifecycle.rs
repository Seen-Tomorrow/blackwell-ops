//! Request lifecycle — phase, request clock, TTFT split and the freeze policy.
//!
//! This is the behaviour every fusion brain shares. It owns no data source: it never reads
//! `/slots`, `/metrics`, stderr or the telemetry stream. A brain hands it the numbers it already
//! has and reads back the values the `FusionUpdate` is built from, so the freeze/latch rules
//! cannot drift between the polling brain and the SSE brain.
//!
//! Ported from `FusionBrain`; the policy is behaviour, not data — do not re-derive it.

use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::fusion::meter;

/// Per-request + session TG AVG floor: suppress elapsed≈0 spikes (500 ms filters the 200k flash).
pub const MIN_TG_PER_REQUEST_AVG_MS: u64 = 500;
/// Agent bursts (file reads) gap `/slots` briefly — don't flash IDLE or zero CTX.
pub const INTER_REQUEST_GAP_HOLD_MS: u64 = 1200;

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum InferencePhase {
    #[default]
    Idle,
    PP, // Prompt Processing (prefill)
    Tg, // Token Generation
}

/// What the freeze policy needs from the brain that owns the meters.
pub struct FreezeInput {
    /// Generated tokens of this request visible right now (0 on an empty-slot freeze).
    pub live_tokens: usize,
    /// Highest token count the brain latched this request/wave (burst / instant fallback).
    pub peak_tokens: usize,
    /// Busy slots on the tick that froze.
    pub last_busy_slot_count: usize,
    /// ParallelMeter's latched peak (survives the idle observe_wave that zeroes it).
    pub latched_peak: usize,
    /// When the parallel decode wall opened, if it is open.
    pub decode_wall_at: Option<Instant>,
    /// Start of the TG burst session average (fallback wall anchor).
    pub tg_burst_started_at: Option<Instant>,
}

/// What the freeze pinned: `last_gen` | `peak_gen` | `wall` | `none`.

#[derive(Default)]
pub struct RequestLifecycle {
    /// Display phase (PP/TG/IDLE) for the update.
    pub phase: InferencePhase,
    /// Authoritative request start.
    pub request_start: Option<Instant>,
    /// Frozen wall-clock when request ends.
    pub request_elapsed_frozen_ms: u64,
    /// Set on definitive request end.
    pub request_closed: bool,
    pub ttft_ms: Option<f64>,
    pub prefill_ms: Option<f64>,
    pub decode_ttft_ms: Option<f64>,
    /// TG clock: starts at the first generated token, not at phase detection.
    pub tg_start_time: Option<Instant>,
    /// "Last known" hero value — persists across phase transitions.
    pub last_gen_tps: f64,
    /// Pinned hero AVG when `request_closed` (immune to post-end elapsed growth).
    pub frozen_request_gen_tps: f64,
    /// Pinned per-slot TG after freeze (system ÷ concurrent peak).
    pub frozen_gen_tps_per_slot: f64,
    /// Concurrent peak captured at freeze.
    pub frozen_concurrent_slots: usize,
    /// Peak per-request gen tokens this wave.
    pub peak_gen_tokens_request: usize,
    /// Peak live gen TPS this wave — multi-slot drain undercounts `last_gen` near the end.
    pub peak_gen_tps_request: f64,
    /// Peak concurrent slots this request/wave.
    pub sticky_wave_peak: usize,
}

impl RequestLifecycle {
    /// Authoritative request start — clears per-request timing for a new request.
    ///
    /// Returns true on a *true boundary* (closed → open, or first start), so the caller bumps
    /// `meter_seq` then — not on every multi-slot `NewPrompt` of the same request.
    pub fn begin_request(&mut self) -> bool {
        let boundary = self.request_closed || self.request_start.is_none();
        self.request_closed = false;
        self.frozen_request_gen_tps = 0.0;
        self.frozen_gen_tps_per_slot = 0.0;
        self.frozen_concurrent_slots = 0;
        self.sticky_wave_peak = 0;
        self.peak_gen_tokens_request = 0;
        self.peak_gen_tps_request = 0.0;
        self.request_start = Some(Instant::now());
        self.request_elapsed_frozen_ms = 0;
        self.ttft_ms = None;
        self.prefill_ms = None;
        self.decode_ttft_ms = None;
        boundary
    }

    /// Definitive request end: freeze the elapsed clock and close the request.
    pub fn close(&mut self) {
        if let Some(start) = self.request_start.take() {
            self.request_elapsed_frozen_ms = start.elapsed().as_millis() as u64;
        }
        self.tg_start_time = None;
        self.request_closed = true;
        // Keep last_gen_tps — frozen hero AVG after request end (do not zero).
    }

    /// Freeze policy — pins the hero value and the concurrent denominator at request end.
    ///
    /// Live rate wins when there is one. Multi-slot waves pin the *peak* (end-of-wave drain
    /// lowers `last_gen` as lanes finish one by one); solo requests pin `last_gen`; with no live
    /// rate at all the pin falls back to tokens ÷ wall from the best available anchor.
    ///
    /// Returns the pin source for the DEV `[fusion-stats]` line.
    pub fn freeze(&mut self, input: FreezeInput) -> &'static str {
        let tokens = input
            .live_tokens
            .max(self.peak_gen_tokens_request)
            .max(input.peak_tokens);
        if tokens > self.peak_gen_tokens_request {
            self.peak_gen_tokens_request = tokens;
        }

        let mut pin_src: &'static str = "none";
        let live_pin = if self.sticky_wave_peak > 1 {
            self.last_gen_tps.max(self.peak_gen_tps_request)
        } else {
            self.last_gen_tps
        };
        if live_pin > 0.0 {
            self.frozen_request_gen_tps = meter::clamp_display_tps(live_pin);
            pin_src = if self.peak_gen_tps_request > self.last_gen_tps + 0.05
                && self.sticky_wave_peak > 1
            {
                "peak_gen"
            } else {
                "last_gen"
            };
        } else {
            let wall_start = if self.sticky_wave_peak > 1 {
                input
                    .decode_wall_at
                    .or(self.tg_start_time)
                    .or(input.tg_burst_started_at)
            } else {
                self.tg_start_time.or(input.tg_burst_started_at)
            };
            if let Some(start) = wall_start {
                let elapsed_ms = start.elapsed().as_millis().max(1) as u64;
                if tokens > 0 && elapsed_ms >= MIN_TG_PER_REQUEST_AVG_MS {
                    self.frozen_request_gen_tps = meter::clamp_display_tps(
                        (tokens as f64) / (elapsed_ms as f64 / 1000.0),
                    );
                    pin_src = "wall";
                }
            }
        }
        if self.frozen_request_gen_tps > 0.0 {
            self.last_gen_tps = self.frozen_request_gen_tps;
        }

        // sticky_wave_peak survives idle observe_wave zeroing of ParallelMeter.
        let peak = self
            .sticky_wave_peak
            .max(input.latched_peak)
            .max(input.last_busy_slot_count)
            .max(1);
        self.frozen_concurrent_slots = peak;
        self.frozen_gen_tps_per_slot = meter::per_slot_tps(self.frozen_request_gen_tps, peak);

        pin_src
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn open_request() -> RequestLifecycle {
        let mut r = RequestLifecycle::default();
        r.begin_request();
        r
    }

    #[test]
    fn first_begin_is_a_boundary_second_is_not() {
        let mut r = RequestLifecycle::default();
        assert!(r.begin_request(), "first start must bump the meter");
        assert!(!r.begin_request(), "a second slot's NewPrompt is not a boundary");
        r.close();
        assert!(r.begin_request(), "closed → open is a boundary again");
    }

    #[test]
    fn close_freezes_elapsed_and_blocks_reopen() {
        let mut r = open_request();
        r.request_start = Some(Instant::now() - Duration::from_millis(250));
        r.close();
        assert!(r.request_closed);
        assert_eq!(r.request_start, None);
        assert!(r.request_elapsed_frozen_ms >= 249, "got {}", r.request_elapsed_frozen_ms);
    }

    #[test]
    fn freeze_pins_the_peak_for_a_parallel_wave() {
        let mut r = open_request();
        r.last_gen_tps = 100.0;
        r.peak_gen_tps_request = 140.0;
        r.sticky_wave_peak = 4;
        let pin = r.freeze(FreezeInput {
            live_tokens: 800,
            peak_tokens: 800,
            last_busy_slot_count: 4,
            latched_peak: 4,
            decode_wall_at: None,
            tg_burst_started_at: None,
        });
        assert_eq!(pin, "peak_gen", "multi-slot drains last_gen, so pin the peak");
        assert_eq!(r.frozen_request_gen_tps, 140.0);
        assert_eq!(r.frozen_concurrent_slots, 4);
        assert!((r.frozen_gen_tps_per_slot - 35.0).abs() < 1e-9);
        assert_eq!(r.last_gen_tps, 140.0);
    }

    #[test]
    fn freeze_pins_last_gen_for_a_solo_request() {
        let mut r = open_request();
        r.last_gen_tps = 639.0;
        let pin = r.freeze(FreezeInput {
            live_tokens: 4096,
            peak_tokens: 4096,
            last_busy_slot_count: 1,
            latched_peak: 1,
            decode_wall_at: None,
            tg_burst_started_at: None,
        });
        assert_eq!(pin, "last_gen");
        assert_eq!(r.frozen_request_gen_tps, 639.0);
        assert_eq!(r.frozen_concurrent_slots, 1);
    }

    #[test]
    fn freeze_falls_back_to_wall_when_no_live_rate() {
        let mut r = open_request();
        r.tg_start_time = Some(Instant::now() - Duration::from_millis(1000));
        let pin = r.freeze(FreezeInput {
            live_tokens: 2000,
            peak_tokens: 2000,
            last_busy_slot_count: 1,
            latched_peak: 1,
            decode_wall_at: None,
            tg_burst_started_at: None,
        });
        assert_eq!(pin, "wall");
        assert!(
            (r.frozen_request_gen_tps - 2000.0).abs() < 50.0,
            "got {}",
            r.frozen_request_gen_tps
        );
    }

    #[test]
    fn freeze_credits_at_least_the_tokens_already_latched() {
        let mut r = open_request();
        r.peak_gen_tokens_request = 5000;
        r.freeze(FreezeInput {
            live_tokens: 0, // empty-slot freeze (bench HTTP path)
            peak_tokens: 4096,
            last_busy_slot_count: 0,
            latched_peak: 1,
            decode_wall_at: None,
            tg_burst_started_at: None,
        });
        assert_eq!(r.peak_gen_tokens_request, 5000, "never rewinds the token latch");
    }
}
