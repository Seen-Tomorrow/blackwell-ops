//! Per-slot tracking — the engine's KV occupancy / decode baseline / prompt snapshot map.
//!
//! Extracted from `brain.rs` (Option 2 decomposition). Owns only `SlotTrackState` rows and the
//! self-contained slot queries that touch nothing else. The few brain methods that need to
//! *write* both slot state AND meter state (`begin_request_on_slot`, `rebaseline_decode_if_stale`,
//! `aggregate_prefill_work_tokens`) stay on `FusionBrain` and access `SlotBank.states` directly.

use std::collections::HashMap;
use std::time::Instant;

use crate::fusion::poller::SlotData;

/// Per-slot KV budget when engine has not reported `n_ctx` yet (llama.cpp: n_ctx_seq = n_ctx / n_parallel).
pub fn default_ctx_per_slot(ctx_total: usize, parallel: i64) -> usize {
    let slots = parallel.max(1) as usize;
    if slots <= 1 {
        ctx_total
    } else if ctx_total > 0 {
        ctx_total / slots
    } else {
        0
    }
}

/// Live TG extension on the busy slot only — fill numerator is log-primary (`log_prompt_fill` + gen delta).
pub fn apply_log_primary_ctx_live(s: &mut SlotTrackState, n_decoded: usize, slot_busy: bool) {
    if !slot_busy {
        return;
    }
    let gen_delta = n_decoded.saturating_sub(s.request_start_n_decoded);
    let live = s.log_prompt_fill.saturating_add(gen_delta);
    if live == 0 {
        return;
    }
    if live > s.session_n_decoded {
        s.session_n_decoded = live;
    }
    if live > s.total_tokens_lifetime {
        s.total_tokens_lifetime = live;
    }
}

// ── Per-slot tracking state (from /slots polling) ────────────────────

#[derive(Debug)]
pub struct SlotTrackState {
    pub prev_n_decoded: usize,
    pub session_n_decoded: usize,
    pub prev_timestamp: Instant,
    pub request_start_n_decoded: usize,
    pub was_processing: bool,
    pub current_task_id: Option<i64>,
    pub total_tokens_lifetime: usize,
    // Current prompt snapshot (for prefill progress + accurate ctx fill including cached history)
    pub current_prompt_tokens: usize,
    pub current_prompt_processed: usize,
    pub current_prompt_cache: usize,
    /// Per-slot PP fill from stderr (`print_timing` / `cached n_tokens`) when /slots omits prompt fields.
    pub log_prompt_fill: usize,
    /// Per-slot KV budget from engine (`/slots` n_ctx or log `n_ctx_slot`).
    pub n_ctx_slot: usize,
    /// Throttle per-slot `cached n_tokens` log lines (global throttle starved compaction on other slots).
    pub last_cached_log_at: Option<Instant>,
    pub last_cached_log_tokens: usize,
    /// Running peak `n_prompt_tokens` (prompt.tokens.size() grows during eval → final prompt size).
    /// Used as a per-slot request total when the engine has no log belt (`prefill_tokens_total == 0`).
    pub peak_prompt_tokens: usize,
}

impl SlotTrackState {
    fn new() -> Self {
        Self {
            prev_n_decoded: 0,
            session_n_decoded: 0,
            prev_timestamp: Instant::now(),
            request_start_n_decoded: 0,
            was_processing: false,
            current_task_id: None,
            total_tokens_lifetime: 0,
            current_prompt_tokens: 0,
            current_prompt_processed: 0,
            current_prompt_cache: 0,
            log_prompt_fill: 0,
            n_ctx_slot: 0,
            last_cached_log_at: None,
            last_cached_log_tokens: 0,
            peak_prompt_tokens: 0,
        }
    }
}

/// Owns the per-slot `SlotTrackState` rows plus self-contained slot queries.
/// Mutable access to the map is via `states` (pub) for the few brain methods that
/// interleave slot + meter writes; the read helpers below are pure over the map.
pub struct SlotBank {
    pub states: HashMap<usize, SlotTrackState>,
}

impl SlotBank {
    pub fn new() -> Self {
        Self {
            states: HashMap::new(),
        }
    }

    /// Get-or-insert the slot row, returning a direct `&mut SlotTrackState` (avoids leaking the Entry type).
    pub fn entry(&mut self, slot_id: usize) -> &mut SlotTrackState {
        self.states.entry(slot_id).or_insert_with(SlotTrackState::new)
    }

    /// Pin per-slot KV budget from engine (`/slots` n_ctx or log `n_ctx_slot`). Returns true when changed.
    pub fn pin_ctx_capacity(&mut self, slot_id: usize, n_ctx: usize) -> bool {
        if n_ctx == 0 {
            return false;
        }
        let s = self.states.entry(slot_id).or_insert_with(SlotTrackState::new);
        if s.n_ctx_slot != n_ctx {
            s.n_ctx_slot = n_ctx;
            true
        } else {
            false
        }
    }

    /// Authoritative KV occupancy — `stop processing`, compaction, sampler total (exact set).
    pub fn pin_ctx_fill(&mut self, slot_id: usize, n_tokens: usize) -> bool {
        let s = self.states.entry(slot_id).or_insert_with(SlotTrackState::new);
        s.log_prompt_fill = n_tokens;
        s.session_n_decoded = n_tokens;
        s.current_prompt_processed = n_tokens;
        if n_tokens > s.total_tokens_lifetime {
            s.total_tokens_lifetime = n_tokens;
        }
        true
    }

    /// Live in-request growth only (monotonic) — PP chunks / TG decode between authoritative pins.
    pub fn bump_ctx_from_log(&mut self, slot_id: usize, prompt_fill: usize, n_decoded: usize) -> bool {
        if prompt_fill == 0 && n_decoded == 0 {
            return false;
        }
        let used = if prompt_fill > 0 {
            let gen_delta = n_decoded.saturating_sub(
                self.states
                    .get(&slot_id)
                    .map(|s| s.request_start_n_decoded)
                    .unwrap_or(0),
            );
            prompt_fill.saturating_add(gen_delta)
        } else {
            n_decoded
        };
        let s = self.states.entry(slot_id).or_insert_with(SlotTrackState::new);
        if prompt_fill > 0 {
            s.log_prompt_fill = prompt_fill;
            s.current_prompt_processed = prompt_fill;
        }
        if used > s.session_n_decoded {
            s.session_n_decoded = used;
        }
        if used > s.total_tokens_lifetime {
            s.total_tokens_lifetime = used;
        }
        true
    }

    pub fn busy_slot_count(&self, slots: &[SlotData]) -> usize {
        slots.iter().filter(|s| s.is_processing).count()
    }

    /// Per-request decode progress — `n_decoded > request_start_n_decoded` (not raw `n_decoded > 0`).
    /// Do not gate on `n_remain <= 0`: unlimited chat uses negative `n_remain`; MTP can report 0 while finishing.
    pub fn slot_has_request_decode(&self, slot: &SlotData) -> bool {
        if !slot.is_processing || slot.next_token.is_empty() {
            return false;
        }
        let t = &slot.next_token[0];
        let baseline = self.states.get(&slot.id).map(|st| st.request_start_n_decoded).unwrap_or(0);
        t.n_decoded > baseline
    }

    pub fn slots_have_active_generation(&self, slots: &[SlotData]) -> bool {
        slots.iter().any(|s| self.slot_has_request_decode(s))
    }

    /// Sum `n_prompt_tokens_processed` across busy slots (64× concurrent prefill).
    pub fn aggregate_prefill_work_tokens(&self, slots: &[SlotData], fallback: usize) -> usize {
        let mut sum = 0usize;
        for slot in slots {
            if slot.is_processing {
                sum = sum.saturating_add(slot.n_prompt_tokens_processed);
            }
        }
        if sum > 0 {
            sum
        } else {
            fallback
        }
    }
}

impl Default for SlotBank {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fusion::meter::session_avg_tps;
    use crate::fusion::poller::TokenInfo;

    fn slot(id: usize, proc: bool, prompt: usize, processed: usize, decoded: usize) -> SlotData {
        SlotData {
            id,
            is_processing: proc,
            next_token: vec![TokenInfo {
                n_decoded: decoded,
                has_next_token: proc,
                n_remain: -1,
                has_new_line: false,
            }],
            n_prompt_tokens: prompt,
            n_prompt_tokens_processed: processed,
            n_prompt_tokens_cache: 0,
            n_ctx: 0,
            id_task: Some(1),
            speculative: false,
            state: 0,
            command: 0,
        }
    }

    #[test]
    fn slot_bank_tracks_ctx_and_decode_baseline() {
        let mut bank = SlotBank::new();
        assert!(bank.pin_ctx_capacity(0, 192000));
        // no-op on repeat (capacity unchanged)
        assert!(!bank.pin_ctx_capacity(0, 192000));

        let mut s = bank.entry(0);
        s.request_start_n_decoded = 10;
        s.peak_prompt_tokens = 0;
        assert!(bank.pin_ctx_fill(0, 500));
        assert_eq!(bank.states[&0].session_n_decoded, 500);

        // decode progress: n_decoded > request_start
        assert!(bank.slot_has_request_decode(&slot(0, true, 0, 0, 20)));
        assert!(!bank.slot_has_request_decode(&slot(0, true, 0, 0, 5)));
        assert!(!bank.slot_has_request_decode(&slot(0, false, 0, 0, 20)));
    }

    #[test]
    fn slot_bank_aggregates_busy_prefill() {
        let bank = SlotBank::new();
        let slots = vec![slot(0, true, 512, 256, 0), slot(1, true, 640, 300, 0), slot(2, false, 100, 50, 0)];
        assert_eq!(bank.busy_slot_count(&slots), 2);
        assert_eq!(bank.aggregate_prefill_work_tokens(&slots, 0), 556);
        // fallback when nothing busy
        assert_eq!(bank.aggregate_prefill_work_tokens(&[slot(9, false, 0, 0, 0)], 7), 7);
    }

    #[test]
    fn session_avg_tps_respects_min_wall() {
        // 1000 tokens over 1000ms = 1000 tok/s
        assert!((session_avg_tps(1000, 1000, 500) - 1000.0).abs() < 0.001);
        // below min wall → 0 (filters elapsed≈0 spikes)
        assert_eq!(session_avg_tps(1000, 400, 500), 0.0);
        // zero tokens → 0
        assert_eq!(session_avg_tps(0, 1000, 500), 0.0);
    }
}
