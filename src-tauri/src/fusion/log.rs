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
    /// `spec common_specu: statistics draft-<type>:` — external draft family (DFlash/DSpark).
    SpecMode {
        mode: SpecDraftMode,
    },
}
/// Speculative draft family — derived from the `spec common_specu: statistics draft-*`
/// log line (external DFlash / DSpark heads) or inferred as MTP when only the
/// `print_timing draft acceptance` line is present (baked-in nextn).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpecDraftMode {
    Mtp,
    Dflash,
    Dspark,
    /// Some other draft family (e.g. eagle3) — not surfaced as a known suffix.
    Other,
}

impl SpecDraftMode {
    pub fn from_spec_type(spec_type: &str) -> SpecDraftMode {
        let s = spec_type.trim().to_ascii_lowercase();
        if s.contains("dspark") {
            SpecDraftMode::Dspark
        } else if s.contains("dflash") {
            SpecDraftMode::Dflash
        } else if s.contains("mtp") {
            SpecDraftMode::Mtp
        } else {
            SpecDraftMode::Other
        }
    }

    /// Canonical product suffix for the fusion micro-readout ("MTP"/"DFLASH"/"DSPARK").
    pub fn label(self) -> Option<&'static str> {
        match self {
            SpecDraftMode::Mtp => Some("MTP"),
            SpecDraftMode::Dflash => Some("DFLASH"),
            SpecDraftMode::Dspark => Some("DSPARK"),
            SpecDraftMode::Other => None,
        }
    }
}


/// Strip llama.cpp log prefix (`0.33.442.579 I slot …`) so regexes match engine output.
pub fn strip_log_prefix(line: &str) -> &str {
    if let Some(idx) = line.find("slot ") {
        &line[idx..]
    } else {
        line
    }
}