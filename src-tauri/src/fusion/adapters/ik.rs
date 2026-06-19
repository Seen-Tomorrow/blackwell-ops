//! IK engine — numeric /slots state+command; logs match ggml master format.

use crate::fusion::log::LogEvent;
use crate::fusion::poller::SlotData;

const IK_SLOT_STATE_PROCESSING: i32 = 1;
const IK_SLOT_COMMAND_LOAD_PROMPT: i32 = 1;

pub fn parse_log_line(line: &str) -> Option<LogEvent> {
    super::parse_ggml::parse_line(line)
}

pub fn normalize_slots(slots: &mut [SlotData]) {
    for slot in slots.iter_mut() {
        if !slot.is_processing
            && (slot.state == IK_SLOT_STATE_PROCESSING
                || (slot.state == 0 && slot.command == IK_SLOT_COMMAND_LOAD_PROMPT))
        {
            slot.is_processing = true;
        }
    }
}

pub fn slots_expose_prompt_processed() -> bool {
    true
}