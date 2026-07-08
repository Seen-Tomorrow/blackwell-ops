//! Canonical fusion log events — provider adapters map stderr/stdout lines into these.

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum LogEvent {
    NewPrompt {
        slot_id: usize,
        task_id: i64,
        prompt_tokens: usize,
        n_ctx_slot: Option<usize>,
    },
    NewSlot {
        slot_id: usize,
        n_ctx: usize,
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
    DraftAcceptance {
        slot_id: usize,
        task_id: i64,
        accept_rate: f64,
        accepted: usize,
        generated: usize,
    },
    StopProcessing {
        slot_id: usize,
        task_id: i64,
        n_tokens: usize,
    },
    CachedPromptTokens {
        slot_id: usize,
        task_id: i64,
        cached_tokens: usize,
    },
    PromptEvalComplete {
        slot_id: usize,
        tokens: usize,
        eval_ms: f64,
    },
    ForcePromptReprocess {
        slot_id: usize,
        task_id: i64,
    },
    /// Tom-style live prefill in update_slots INFO (stdout at -lv 3).
    PromptProcessingProgress {
        slot_id: usize,
        task_id: i64,
        n_tokens: usize,
        progress: f64,
    },
}

/// Strip llama.cpp log prefix (`0.33.442.579 I slot …`) so regexes match engine output.
pub fn strip_log_prefix(line: &str) -> &str {
    if let Some(idx) = line.find("slot ") {
        &line[idx..]
    } else {
        line
    }
}