//! Fusion metrics — per-provider adapters + provider-agnostic brain core.
//!
//! Tuning a new engine fork: add `src/fusion/adapters/<id>.rs`, register in
//! `adapters/mod.rs`, set `spawn_profile.fusion_adapter` in factory JSON (or
//! `apply_spawn_profile_overrides` for derived providers like ggml-tom).

pub mod adapters;
pub mod brain;
pub mod log;
pub mod poller;
pub mod registry;

pub use adapters::FusionAdapterId;
pub use brain::{
    freeze_request_meters_for_port, reset_bench_meters_for_port, start_brain, stop_all_brains,
    stop_brain, FusionConfig,
};
pub use poller::SlotData;
pub use registry::resolve_adapter;

/// Parse a log line with the slot's registered adapter and route to its brain.
pub fn parse_and_route_log_event(slot_idx: usize, line: &str) {
    let adapter = registry::slot_adapter(slot_idx);
    if let Some(ev) = adapter.parse_log_line(line) {
        brain::route_log_event(slot_idx, ev);
    }
}

/// Poll /slots and normalize with the provider adapter.
pub async fn poll_slots_normalized(
    client: &reqwest::Client,
    host: &str,
    port: u16,
    adapter: FusionAdapterId,
) -> Result<Vec<SlotData>, String> {
    let mut slots = poller::poll_slots_on(client, host, port).await?;
    adapter.normalize_slots(&mut slots);
    Ok(slots)
}