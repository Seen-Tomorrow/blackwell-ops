//! ggml-org server builds that emit NO per-request stderr log belt (silent verbosity).
//!
//! Some llama-server builds / model architectures stop logging after boot — no
//! `slot update_slots: new prompt`, no `print_timing`, no `cached n_tokens`, no
//! `init sampler`. Only the HTTP `/slots` (full PP fields) and `/metrics` streams
//! are available.
//!
//! This adapter tells the brain:
//!   * `/slots` exposes `n_prompt_tokens_processed` (real-time prefill progress)
//!   * there is NO stderr log belt → the brain must derive PP totals + progress
//!     and the multi-slot TG decode window purely from HTTP polling.

use crate::fusion::log::LogEvent;
use crate::fusion::poller::SlotData;

pub fn parse_log_line(_line: &str) -> Option<LogEvent> {
    None
}

pub fn normalize_slots(_slots: &mut [SlotData]) {}

pub fn slots_expose_prompt_processed() -> bool {
    true
}

/// This engine never emits the stderr `print_timing` / `new prompt` belt.
pub fn has_log_belt() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fusion::adapters::FusionAdapterId;

    #[test]
    fn quiet_adapter_parses_no_logs_and_exposes_slots() {
        let line = "0.33.442.579 I slot print_timing: id 0 | task 6 | prompt processing, n_tokens = 1024, progress = 0.50, t = 1.0 s / 1024.0 tokens per second";
        assert!(parse_log_line(line).is_none());
        assert!(slots_expose_prompt_processed());
        assert!(!has_log_belt());
    }

    #[test]
    fn quiet_adapter_resolves_from_config() {
        assert_eq!(
            FusionAdapterId::from_config_str("ggml_quiet"),
            Some(FusionAdapterId::GgmlQuiet)
        );
        assert_eq!(
            FusionAdapterId::from_config_str("slots-only"),
            Some(FusionAdapterId::GgmlQuiet)
        );
        // Master lines must not be claimed by the quiet adapter.
        assert!(FusionAdapterId::GgmlQuiet
            .parse_log_line("0.33.442.579 I slot print_timing: id 0 | task 6 | prompt eval time = 25.51 ms / 513 tokens")
            .is_none());
    }
}
