//! Shared ggml-org / master-style stderr log parsers (-lv 4 belt).

use std::sync::OnceLock;

use crate::fusion::log::{strip_log_prefix, LogEvent};

static RE_NEW_PROMPT: OnceLock<regex::Regex> = OnceLock::new();
static RE_NEW_PROMPT_CTX: OnceLock<regex::Regex> = OnceLock::new();
static RE_NEW_SLOT: OnceLock<regex::Regex> = OnceLock::new();
static RE_SAMPLER_INIT: OnceLock<regex::Regex> = OnceLock::new();
static RE_PRINT_TIMING_PP: OnceLock<regex::Regex> = OnceLock::new();
static RE_PRINT_TIMING_GEN: OnceLock<regex::Regex> = OnceLock::new();
static RE_DRAFT_ACCEPTANCE: OnceLock<regex::Regex> = OnceLock::new();
static RE_STOP_PROCESSING: OnceLock<regex::Regex> = OnceLock::new();
static RE_CACHED_PROMPT: OnceLock<regex::Regex> = OnceLock::new();
static RE_PROMPT_EVAL: OnceLock<regex::Regex> = OnceLock::new();
static RE_FORCE_PROMPT_REPROCESS: OnceLock<regex::Regex> = OnceLock::new();

pub fn parse_line(line: &str) -> Option<LogEvent> {
    let line = strip_log_prefix(line);

    if let Some(caps) = re_new_prompt_ctx().captures(line) {
        if let (Ok(slot_id), Ok(task_id), Ok(n_ctx_slot), Ok(prompt_tokens)) = (
            caps.get(1)?.as_str().parse::<usize>(),
            caps.get(2)?.as_str().parse::<i64>(),
            caps.get(3)?.as_str().parse::<usize>(),
            caps.get(4)?.as_str().parse::<usize>(),
        ) {
            return Some(LogEvent::NewPrompt {
                slot_id,
                task_id,
                prompt_tokens,
                n_ctx_slot: Some(n_ctx_slot),
            });
        }
    }
    if let Some(caps) = re_new_prompt().captures(line) {
        if let (Ok(slot_id), Ok(task_id), Ok(prompt_tokens)) = (
            caps.get(1)?.as_str().parse::<usize>(),
            caps.get(2)?.as_str().parse::<i64>(),
            caps.get(3)?.as_str().parse::<usize>(),
        ) {
            return Some(LogEvent::NewPrompt {
                slot_id,
                task_id,
                prompt_tokens,
                n_ctx_slot: None,
            });
        }
    }

    if let Some(caps) = re_new_slot().captures(line) {
        if let (Ok(slot_id), Ok(n_ctx)) = (
            caps.get(1)?.as_str().parse::<usize>(),
            caps.get(3)?.as_str().parse::<usize>(),
        ) {
            return Some(LogEvent::NewSlot { slot_id, n_ctx });
        }
    }

    if let Some(caps) = re_sampler_init().captures(line) {
        if let (Ok(slot_id), Ok(total_tokens)) = (
            caps.get(1)?.as_str().parse::<usize>(),
            caps.get(3)?.as_str().parse::<usize>(),
        ) {
            return Some(LogEvent::SamplerInit {
                slot_id,
                total_tokens,
            });
        }
    }

    if let Some(caps) = re_print_timing_pp().captures(line) {
        if let (Ok(slot_id), Ok(task_id), Ok(n_tokens), Ok(progress), Ok(elapsed_s), Ok(pp_tps)) = (
            caps.get(1)?.as_str().parse::<usize>(),
            caps.get(2)?.as_str().parse::<i64>(),
            caps.get(3)?.as_str().parse::<usize>(),
            caps.get(4)?.as_str().parse::<f64>(),
            caps.get(5)?.as_str().parse::<f64>(),
            caps.get(6)?.as_str().parse::<f64>(),
        ) {
            return Some(LogEvent::PrintTimingPP {
                slot_id,
                task_id,
                n_tokens,
                progress,
                elapsed_s,
                pp_tps,
            });
        }
    }

    if let Some(caps) = re_draft_acceptance().captures(line) {
        if let (Ok(slot_id), Ok(task_id), Ok(accept_rate), Ok(accepted), Ok(generated)) = (
            caps.get(1)?.as_str().parse::<usize>(),
            caps.get(2)?.as_str().parse::<i64>(),
            caps.get(3)?.as_str().parse::<f64>(),
            caps.get(4)?.as_str().parse::<usize>(),
            caps.get(5)?.as_str().parse::<usize>(),
        ) {
            return Some(LogEvent::DraftAcceptance {
                slot_id,
                task_id,
                accept_rate,
                accepted,
                generated,
            });
        }
    }

    if let Some(caps) = re_print_timing_gen().captures(line) {
        if let (Ok(slot_id), Ok(n_decoded), Ok(gen_tps)) = (
            caps.get(1)?.as_str().parse::<usize>(),
            caps.get(3)?.as_str().parse::<usize>(),
            caps.get(4)?.as_str().parse::<f64>(),
        ) {
            return Some(LogEvent::PrintTimingGen {
                slot_id,
                n_decoded,
                gen_tps,
            });
        }
    }

    if let Some(caps) = re_prompt_eval().captures(line) {
        if let (Ok(slot_id), Ok(eval_ms), Ok(tokens)) = (
            caps.get(1)?.as_str().parse::<usize>(),
            caps.get(2)?.as_str().parse::<f64>(),
            caps.get(3)?.as_str().parse::<usize>(),
        ) {
            return Some(LogEvent::PromptEvalComplete {
                slot_id,
                tokens,
                eval_ms,
            });
        }
    }

    if let Some(caps) = re_force_prompt_reprocess().captures(line) {
        if let (Ok(slot_id), Ok(task_id)) = (
            caps.get(1)?.as_str().parse::<usize>(),
            caps.get(2)?.as_str().parse::<i64>(),
        ) {
            return Some(LogEvent::ForcePromptReprocess { slot_id, task_id });
        }
    }

    if let Some(caps) = re_cached_prompt().captures(line) {
        if let (Ok(slot_id), Ok(task_id), Ok(cached_tokens)) = (
            caps.get(1)?.as_str().parse::<usize>(),
            caps.get(2)?.as_str().parse::<i64>(),
            caps.get(3)?.as_str().parse::<usize>(),
        ) {
            return Some(LogEvent::CachedPromptTokens {
                slot_id,
                task_id,
                cached_tokens,
            });
        }
    }

    if let Some(caps) = re_stop_processing().captures(line) {
        if let (Ok(slot_id), Ok(task_id), Ok(n_tokens)) = (
            caps.get(1)?.as_str().parse::<usize>(),
            caps.get(2)?.as_str().parse::<i64>(),
            caps.get(3)?.as_str().parse::<usize>(),
        ) {
            return Some(LogEvent::StopProcessing {
                slot_id,
                task_id,
                n_tokens,
            });
        }
    }

    None
}

fn re_new_prompt() -> &'static regex::Regex {
    RE_NEW_PROMPT.get_or_init(|| {
        regex::Regex::new(
            r"slot update_slots:\s+id\s+(\d+)\s*\|\s*task\s*(-?\d+)\s*\|\s*new prompt.*?task\.n_tokens\s*=\s*(\d+)",
        )
        .unwrap()
    })
}

fn re_new_prompt_ctx() -> &'static regex::Regex {
    RE_NEW_PROMPT_CTX.get_or_init(|| {
        regex::Regex::new(
            r"slot update_slots:\s+id\s+(\d+)\s*\|\s*task\s*(-?\d+)\s*\|\s*new prompt,\s*n_ctx_slot\s*=\s*(\d+).*?task\.n_tokens\s*=\s*(\d+)",
        )
        .unwrap()
    })
}

fn re_new_slot() -> &'static regex::Regex {
    RE_NEW_SLOT.get_or_init(|| {
        regex::Regex::new(
            r"slot update_slots:\s+id\s+(\d+)\s*\|\s*task\s*(-?\d+)\s*\|\s*new slot,\s*n_ctx\s*=\s*(\d+)",
        )
        .unwrap()
    })
}

fn re_sampler_init() -> &'static regex::Regex {
    RE_SAMPLER_INIT.get_or_init(|| {
        regex::Regex::new(
            r"slot init_sampler:\s+id\s+(\d+)\s*\|\s*task\s*(-?\d+)\s*\|\s*init sampler.*?total\s*=\s*(\d+)",
        )
        .unwrap()
    })
}

fn re_print_timing_pp() -> &'static regex::Regex {
    RE_PRINT_TIMING_PP.get_or_init(|| {
        regex::Regex::new(
            r"slot print_timing:\s+id\s+(\d+)\s*\|\s*task\s*(-?\d+)\s*\|\s*prompt processing,\s+n_tokens\s*=\s*(\d+),\s*progress\s*=\s*([\d.]+),\s*t\s*=\s*([\d.]+)\s*s\s*/\s*([\d.]+)\s*tokens per second",
        )
        .unwrap()
    })
}

fn re_print_timing_gen() -> &'static regex::Regex {
    RE_PRINT_TIMING_GEN.get_or_init(|| {
        regex::Regex::new(
            r"slot print_timing:\s+id\s+(\d+)\s*\|\s*task\s*(-?\d+)\s*\|\s*n_decoded\s*=\s*(\d+),\s*tg\s*=\s*([\d.]+)\s*t/s",
        )
        .unwrap()
    })
}

fn re_draft_acceptance() -> &'static regex::Regex {
    RE_DRAFT_ACCEPTANCE.get_or_init(|| {
        regex::Regex::new(
            r"slot print_timing:\s+id\s+(\d+)\s*\|\s*task\s*(-?\d+)\s*\|\s*draft acceptance\s*=\s*([\d.]+)\s*\(\s*(\d+)\s+accepted\s*/\s*(\d+)\s+generated\s*\)",
        )
        .unwrap()
    })
}

fn re_stop_processing() -> &'static regex::Regex {
    RE_STOP_PROCESSING.get_or_init(|| {
        regex::Regex::new(
            r"slot release:\s+id\s+(\d+)\s*\|\s*task\s*(-?\d+)\s*\|\s*stop processing:\s*n_tokens\s*=\s*(\d+)",
        )
        .unwrap()
    })
}

fn re_prompt_eval() -> &'static regex::Regex {
    RE_PROMPT_EVAL.get_or_init(|| {
        regex::Regex::new(
            r"slot print_timing:\s+id\s+(\d+)\s*\|\s*task\s*-?\d+\s*\|\s*prompt eval time\s*=\s*([\d.]+)\s*ms\s*/\s*(\d+)\s*tokens",
        )
        .unwrap()
    })
}

fn re_force_prompt_reprocess() -> &'static regex::Regex {
    RE_FORCE_PROMPT_REPROCESS.get_or_init(|| {
        regex::Regex::new(
            r"slot update_slots:\s+id\s+(\d+)\s*\|\s*task\s*(-?\d+)\s*\|\s*forcing full prompt re-processing",
        )
        .unwrap()
    })
}

fn re_cached_prompt() -> &'static regex::Regex {
    RE_CACHED_PROMPT.get_or_init(|| {
        regex::Regex::new(
            r"slot update_slots:\s+id\s+(\d+)\s*\|\s*task\s*(-?\d+)\s*\|\s*cached n_tokens\s*=\s*(\d+)",
        )
        .unwrap()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_new_prompt_with_n_ctx_slot() {
        let line = "0.33.442.579 I slot update_slots: id 1 | task 42 | new prompt, n_ctx_slot = 32768, n_keep = 0, task.n_tokens = 12000";
        let ev = parse_line(line).expect("new prompt");
        match ev {
            LogEvent::NewPrompt {
                slot_id,
                task_id,
                prompt_tokens,
                n_ctx_slot,
            } => {
                assert_eq!(slot_id, 1);
                assert_eq!(task_id, 42);
                assert_eq!(prompt_tokens, 12000);
                assert_eq!(n_ctx_slot, Some(32768));
            }
            other => panic!("unexpected event: {:?}", other),
        }
    }
}