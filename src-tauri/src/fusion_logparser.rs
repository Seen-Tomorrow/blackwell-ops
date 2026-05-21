//! Fusion Log Parser — regex definitions for modern llama.cpp -lv 4 log format.
//!
//! STATUS: Written but NOT wired into any pipeline.
//! To enable: wire parse_line() output into FusionBrain in fusion_brain.rs.

use std::sync::OnceLock;

// ── Compiled Regex Patterns (all static, zero runtime compilation) ───

static RE_NEW_PROMPT: OnceLock<regex::Regex> = OnceLock::new();
static RE_SAMPLER_INIT: OnceLock<regex::Regex> = OnceLock::new();
static RE_PRINT_TIMING_GEN: OnceLock<regex::Regex> = OnceLock::new();
static RE_PRINT_TIMING_PROMPT_EVAL: OnceLock<regex::Regex> = OnceLock::new();
static RE_STOP_PROCESSING: OnceLock<regex::Regex> = OnceLock::new();

fn re_new_prompt() -> &'static regex::Regex {
    RE_NEW_PROMPT.get_or_init(|| {
        regex::Regex::new(
            r"slot update_slots:\s+id\s+(\d+)\s*\|\s*task\s*(-?\d+)\s*\|\s*new prompt.*?task\.n_tokens\s*=\s*(\d+)",
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

fn re_print_timing_gen() -> &'static regex::Regex {
    RE_PRINT_TIMING_GEN.get_or_init(|| {
        regex::Regex::new(
            r"slot print_timing:\s+id\s+(\d+)\s*\|\s*task\s*(-?\d+)\s*\|\s*n_decoded\s*=\s*(\d+),\s*tg\s*=\s*([\d.]+)\s*t/s",
        )
        .unwrap()
    })
}

fn re_print_timing_prompt_eval() -> &'static regex::Regex {
    RE_PRINT_TIMING_PROMPT_EVAL.get_or_init(|| {
        regex::Regex::new(
            r"prompt eval time\s*=\s*([\d.]+)\s*ms\s*/\s*(\d+)\s*tokens.*?([\d.]+)\s*tokens per second",
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

// ── Parsed Log Events ───────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum LogEvent {
    NewPrompt {
        slot_id: usize,
        task_id: i64,
        prompt_tokens: usize,
    },
    SamplerInit {
        slot_id: usize,
        total_tokens: usize,
    },
    PrintTimingGen {
        n_decoded: usize,
        gen_tps: f64,
    },
    PrintTimingPromptEval {
        ttft_ms: f64,
        prefill_tps: f64,
    },
    StopProcessing {
        slot_id: usize,
        task_id: i64,
        n_tokens: usize,
    },
}

// ── Pure parser function — no side effects, no I/O, no global state ──

/// Parse a single log line. Returns first matching event or None.
pub fn parse_line(line: &str) -> Option<LogEvent> {
    // New prompt detection
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
            });
        }
    }

    // Sampler init — PP→TG transition signal
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

    // Print timing — generation progress (real-time TG data)
    if let Some(caps) = re_print_timing_gen().captures(line) {
        if let (Ok(n_decoded), Ok(gen_tps)) = (
            caps.get(3)?.as_str().parse::<usize>(),
            caps.get(4)?.as_str().parse::<f64>(),
        ) {
            return Some(LogEvent::PrintTimingGen { n_decoded, gen_tps });
        }
    }

    // Print timing — prompt eval (delayed prefill stats at request end)
    if let Some(caps) = re_print_timing_prompt_eval().captures(line) {
        if let (Ok(ttft_ms), Ok(prefill_tps)) = (
            caps.get(1)?.as_str().parse::<f64>(),
            caps.get(3)?.as_str().parse::<f64>(),
        ) {
            return Some(LogEvent::PrintTimingPromptEval { ttft_ms, prefill_tps });
        }
    }

    // Stop processing — request end boundary
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
