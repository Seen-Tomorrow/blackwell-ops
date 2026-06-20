//! Per-provider FIT scanner + learned-VRAM adapters.
//!
//! Cache partition key is `fit_adapter` (`ggml_master` | `ggml_tom`) — not provider id.
//! Tom's fork rejects `--fit-print` and reports totals on `llama_params_fit_impl: projected to use N MiB`.
//! Master uses `--fit-print on` / `common_memory_breakdown_print` tables.

mod ggml_master;
mod ggml_tom;

use crate::fit_scanner::{FitScanRaw, MemoryBreakdownTable};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FitAdapterId {
    GgmlMaster,
    GgmlTom,
}

impl FitAdapterId {
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

    /// Factory `spawn_profile.fit_adapter` → provider id → template family.
    pub fn resolve(provider_id: &str, spawn_fit_adapter: &str) -> Self {
        if let Some(id) = Self::from_config_str(spawn_fit_adapter) {
            return id;
        }
        if let Some(id) = Self::from_config_str(provider_id) {
            return id;
        }
        if provider_id.eq_ignore_ascii_case("ggml-tom") {
            return Self::GgmlTom;
        }
        Self::GgmlMaster
    }

    pub fn build_scan_args(
        self,
        model_path: &str,
        ctx_tokens: usize,
        kv_quant: &str,
        batch: u32,
        ubatch: u32,
        parallel: u32,
        split_mode: &str,
    ) -> Vec<String> {
        match self {
            Self::GgmlTom => ggml_tom::build_scan_args(
                model_path, ctx_tokens, kv_quant, batch, ubatch, parallel, split_mode,
            ),
            Self::GgmlMaster => ggml_master::build_scan_args(
                model_path, ctx_tokens, kv_quant, batch, ubatch, parallel, split_mode,
            ),
        }
    }

    pub fn parse_scan_output(self, stdout: &str, stderr: &str) -> Option<FitScanRaw> {
        match self {
            Self::GgmlTom => ggml_tom::parse_scan_output(stdout, stderr),
            Self::GgmlMaster => ggml_master::parse_scan_output(stdout, stderr),
        }
    }

    /// Stderr line should be buffered for learned VRAM parsing on this provider.
    pub fn is_vram_learn_line(self, line: &str, stdout_only: bool) -> bool {
        if stdout_only {
            return false;
        }
        match self {
            Self::GgmlTom => ggml_tom::is_vram_learn_line(line),
            Self::GgmlMaster => ggml_master::is_vram_learn_line(line),
        }
    }

    /// One learned-VRAM sample is complete — safe to parse and record.
    pub fn is_vram_learn_complete_line(self, line: &str) -> bool {
        match self {
            Self::GgmlTom => ggml_tom::is_vram_learn_complete_line(line),
            Self::GgmlMaster => ggml_master::is_vram_learn_complete_line(line),
        }
    }

    pub fn parse_vram_learn_tables(self, output: &str) -> Vec<MemoryBreakdownTable> {
        match self {
            Self::GgmlTom => ggml_tom::parse_vram_learn_tables(output),
            Self::GgmlMaster => ggml_master::parse_vram_learn_tables(output),
        }
    }

    /// Whole-model FIT skip (Tom MTP) — no subprocess probes.
    pub fn model_skip_note(self, model_path: &str) -> Option<&'static str> {
        match self {
            Self::GgmlTom => ggml_tom::model_skip_note(model_path),
            Self::GgmlMaster => None,
        }
    }

    /// Per scan-plan point skip (Tom tensor) — no subprocess probes.
    pub fn point_skip_note(self, label: &str, split_mode: &str) -> Option<&'static str> {
        match self {
            Self::GgmlTom => ggml_tom::point_skip_note(label, split_mode),
            Self::GgmlMaster => None,
        }
    }
}