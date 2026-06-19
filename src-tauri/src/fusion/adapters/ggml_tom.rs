//! TheTom turboquant fork — /slots omits PP fields; live PP on stdout INFO at -lv 3.

use std::sync::OnceLock;

use crate::fusion::log::{strip_log_prefix, LogEvent};
use crate::fusion::poller::SlotData;

static RE_PROMPT_PROCESSING_PROGRESS: OnceLock<regex::Regex> = OnceLock::new();

pub fn parse_log_line(line: &str) -> Option<LogEvent> {
    let stripped = strip_log_prefix(line);
    if let Some(caps) = re_prompt_processing_progress().captures(stripped) {
        if let (Ok(slot_id), Ok(task_id), Ok(n_tokens), Ok(progress)) = (
            caps.get(1)?.as_str().parse::<usize>(),
            caps.get(2)?.as_str().parse::<i64>(),
            caps.get(3)?.as_str().parse::<usize>(),
            caps.get(4)?.as_str().parse::<f64>(),
        ) {
            return Some(LogEvent::PromptProcessingProgress {
                slot_id,
                task_id,
                n_tokens,
                progress,
            });
        }
    }
    super::parse_ggml::parse_line(line)
}

pub fn normalize_slots(_slots: &mut [SlotData]) {}

pub fn slots_expose_prompt_processed() -> bool {
    false
}

fn re_prompt_processing_progress() -> &'static regex::Regex {
    RE_PROMPT_PROCESSING_PROGRESS.get_or_init(|| {
        regex::Regex::new(
            r"slot update_slots:\s+id\s+(\d+)\s*\|\s*task\s*(-?\d+)\s*\|\s*prompt processing progress,\s*n_tokens\s*=\s*(\d+).*?progress\s*=\s*([\d.]+)",
        )
        .unwrap()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_tom_prompt_processing_progress() {
        let line = "0.33.442.579 I slot update_slots: id 0 | task 1351 | prompt processing progress, n_tokens = 1024, batch.n_tokens = 1024, progress = 0.031250";
        let ev = parse_log_line(line).expect("tom pp progress");
        match ev {
            LogEvent::PromptProcessingProgress {
                slot_id,
                task_id,
                n_tokens,
                progress,
            } => {
                assert_eq!(slot_id, 0);
                assert_eq!(task_id, 1351);
                assert_eq!(n_tokens, 1024);
                assert!((progress - 0.03125).abs() < 0.0001);
            }
            other => panic!("unexpected event: {:?}", other),
        }
    }
}