//! ggml-org master — full /slots PP fields, -lv 4 stderr belt.

use crate::fusion::log::LogEvent;
use crate::fusion::poller::SlotData;

pub fn parse_log_line(line: &str) -> Option<LogEvent> {
    super::parse_ggml::parse_line(line)
}

pub fn normalize_slots(_slots: &mut [SlotData]) {}

pub fn slots_expose_prompt_processed() -> bool {
    true
}