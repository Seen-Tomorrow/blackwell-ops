//! Fusion Log Parser — regex definitions for modern llama.cpp -lv 4 log format.
//!
//! STATUS: WIRED INTO FUSION BRAIN via log_hub.rs → BRAIN_INBOUND_SENDERS registry.
//! Parsed events route to FusionBrain through mpsc channel on each slot's brain task.

#![allow(dead_code)]

use std::sync::OnceLock;

// ── Compiled Regex Patterns (all static, zero runtime compilation) ───

static RE_NEW_PROMPT: OnceLock<regex::Regex> = OnceLock::new();
static RE_SAMPLER_INIT: OnceLock<regex::Regex> = OnceLock::new();
static RE_PRINT_TIMING_PP: OnceLock<regex::Regex> = OnceLock::new();
static RE_PRINT_TIMING_GEN: OnceLock<regex::Regex> = OnceLock::new();

static RE_STOP_PROCESSING: OnceLock<regex::Regex> = OnceLock::new();
static RE_CACHED_PROMPT: OnceLock<regex::Regex> = OnceLock::new();
static RE_PROMPT_EVAL: OnceLock<regex::Regex> = OnceLock::new();
static RE_FORCE_PROMPT_REPROCESS: OnceLock<regex::Regex> = OnceLock::new();

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

fn re_print_timing_pp() -> &'static regex::Regex {
    RE_PRINT_TIMING_PP.get_or_init(|| {
        // Matches: slot print_timing: id 0 | task 2528 | prompt processing, n_tokens = 7984, progress = 0.79, t = 3.78 s / 2109.45 tokens per second
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
        // Final PP summary — authoritative processed token count (may differ from task.n_tokens).
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
        // Multimodal / chunked prefill: live prompt fill before sampler_init (no print_timing PP <3s)
        regex::Regex::new(
            r"slot update_slots:\s+id\s+(\d+)\s*\|\s*task\s*(-?\d+)\s*\|\s*cached n_tokens\s*=\s*(\d+)",
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
    PrintTimingPP {
        slot_id: usize,
        task_id: i64,
        n_tokens: usize,
        progress: f64,
        elapsed_s: f64,
        pp_tps: f64,
    },
    PrintTimingGen {
        slot_id: usize,
        n_decoded: usize,
        gen_tps: f64,
    },
    StopProcessing {
        slot_id: usize,
        task_id: i64,
        n_tokens: usize,
    },
    /// Live prompt fill during chunked/multimodal prefill (`cached n_tokens = N` in update_slots logs).
    CachedPromptTokens {
        slot_id: usize,
        task_id: i64,
        cached_tokens: usize,
    },
    /// Authoritative token count + wall time when prefill completes (`prompt eval time = X ms / N tokens`).
    PromptEvalComplete {
        slot_id: usize,
        tokens: usize,
        eval_ms: f64,
    },
    /// SWA / hybrid cache miss — same task re-prefills without a `new prompt` line.
    ForcePromptReprocess {
        slot_id: usize,
        task_id: i64,
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

    // Sampler init — PP→TG transition signal (DEFINITIVE boundary)
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

    // Print timing — prompt processing progress (REAL-TIME PP data from engine)
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

    // Print timing — generation progress (real-time TG data)
    if let Some(caps) = re_print_timing_gen().captures(line) {
        if let (Ok(slot_id), Ok(n_decoded), Ok(gen_tps)) = (
            caps.get(1)?.as_str().parse::<usize>(),
            caps.get(3)?.as_str().parse::<usize>(),
            caps.get(4)?.as_str().parse::<f64>(),
        ) {
            return Some(LogEvent::PrintTimingGen { slot_id, n_decoded, gen_tps });
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

    // SWA / hybrid: cache invalidated — full re-prefill on an already-busy slot (no new prompt line)
    if let Some(caps) = re_force_prompt_reprocess().captures(line) {
        if let (Ok(slot_id), Ok(task_id)) = (
            caps.get(1)?.as_str().parse::<usize>(),
            caps.get(2)?.as_str().parse::<i64>(),
        ) {
            return Some(LogEvent::ForcePromptReprocess { slot_id, task_id });
        }
    }

    // Cached prompt tokens — multimodal prefill progress (fires many times per request)
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
