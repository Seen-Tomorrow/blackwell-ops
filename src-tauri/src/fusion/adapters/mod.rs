//! Per-provider fusion adapters — log parsers + /slots normalization.
//!
//! ## Adding or tuning an adapter
//!
//! 1. Create `adapters/<name>.rs` implementing:
//!    - `parse_log_line` — map stderr/stdout lines → `LogEvent` (extend `parse_ggml` when possible)
//!    - `normalize_slots` — fix `/slots` JSON quirks before the brain sees them
//!    - `slots_expose_prompt_processed` — `false` when `n_prompt_tokens_processed` is absent (Tom)
//! 2. Register the id in `FusionAdapterId` + `from_config_str`.
//! 3. Set `spawn_profile.fusion_adapter` in factory JSON, or `apply_spawn_profile_overrides` for
//!    providers that share a family template (ggml-tom → `ggml_tom`, `-lv 3`).
//! 4. Add a unit test in the adapter module with a real log line from that engine.
//!
//! Brain logic stays in `brain.rs`; adapters only translate provider I/O into canonical events.

mod parse_ggml;
pub mod ggml_master;
pub mod ggml_tom;

use crate::fusion::log::LogEvent;
use crate::fusion::poller::SlotData;

/// Stable adapter id — factory `spawn_profile.fusion_adapter` or registry fallback.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FusionAdapterId {
    GgmlMaster,
    GgmlTom,
}

impl FusionAdapterId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GgmlMaster => "ggml_master",
            Self::GgmlTom => "ggml_tom",
        }
    }

    pub fn from_config_str(s: &str) -> Option<Self> {
        match s.trim().to_lowercase().as_str() {
            "ggml_master" | "ggml-master" | "ggml_llama" | "ggml-llama" => Some(Self::GgmlMaster),
            "ggml_tom" | "ggml-tom" => Some(Self::GgmlTom),
            _ => None,
        }
    }

    pub fn parse_log_line(self, line: &str) -> Option<LogEvent> {
        match self {
            Self::GgmlMaster => ggml_master::parse_log_line(line),
            Self::GgmlTom => ggml_tom::parse_log_line(line),
        }
    }

    pub fn normalize_slots(self, slots: &mut [SlotData]) {
        match self {
            Self::GgmlMaster => ggml_master::normalize_slots(slots),
            Self::GgmlTom => ggml_tom::normalize_slots(slots),
        }
    }

    pub fn slots_expose_prompt_processed(self) -> bool {
        match self {
            Self::GgmlMaster => ggml_master::slots_expose_prompt_processed(),
            Self::GgmlTom => ggml_tom::slots_expose_prompt_processed(),
        }
    }
}