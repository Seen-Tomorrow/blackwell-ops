//! File-level role classification for a GGUF file.
//!
//! The catalog has to answer "what is this file" for a library the user migrated in
//! from anywhere, so the Hub's per-repo naming (`engram/`, `dspark/`, `mmproj-*`) is
//! not available and must not be required. Every rule here reads only the file:
//!
//! 1. `general.type` — `mmproj` / `adapter` when a converter writes it (it is *not*
//!    written for MTP heads or PLE tables, so it is a bonus signal, never a gate).
//! 2. `general.architecture` — `clip` is a vision projector. An arch can never
//!    identify a *draft*: an MTP head and its trunk share `qwen4exp`, and DFlash2 and
//!    DSpark share `dflash`.
//! 3. The tensor table — the only signal that separates those cases:
//!    `per_layer_token_embd` alone is a lookup table; `nextn` / `markov_w1` is a
//!    speculative head; `blk.N` plus a vocab tensor is a trunk.
//! 4. `split.no` / `split.count` — bookkeeping, not identity, but it also tells a
//!    metadata-only shard (0 tensors) apart from a genuinely empty file.
//! 5. Filenames last, and flagged as such.
//!
//! A file with no `general.architecture` is *not* an error: every PLE/Engram table in
//! the wild declares none (DeepSeek-V4.1 and Qwen3.8-Flash-Next both ship 6 KVs and
//! one tensor), so an arch-less file is classified from its tensors.

use serde::{Deserialize, Serialize};

use crate::gguf_shape::GgufShape;

/// What a GGUF file is for. This is the local, file-level answer — distinct from the
/// Hub-side `GgufRole` (`types::GgufRole`), which describes a download artifact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileRole {
    /// Launchable model weights: a trunk, a single-file model, or one shard of a set.
    Model,
    /// A speculative head (MTP / DFlash / DSpark) — launchable only attached to a model.
    Draft,
    /// A `per_layer_token_embd` lookup table (DeepSeek Engram, Qwen PLE).
    PleTable,
    /// A vision projector (`clip` arch / `general.type = mmproj`).
    Mmproj,
    /// A LoRA adapter.
    Adapter,
    /// Unclassifiable with confidence — shown, never launched.
    Unknown,
}

impl FileRole {
    pub fn as_str(self) -> &'static str {
        match self {
            FileRole::Model => "model",
            FileRole::Draft => "draft",
            FileRole::PleTable => "ple",
            FileRole::Mmproj => "mmproj",
            FileRole::Adapter => "adapter",
            FileRole::Unknown => "unknown",
        }
    }

    /// Inverse of [`FileRole::as_str`] — for rows that crossed the IPC boundary.
    pub fn from_wire(role: &str) -> Option<Self> {
        match role {
            "model" => Some(FileRole::Model),
            "draft" => Some(FileRole::Draft),
            "ple" => Some(FileRole::PleTable),
            "mmproj" => Some(FileRole::Mmproj),
            "adapter" => Some(FileRole::Adapter),
            "unknown" => Some(FileRole::Unknown),
            _ => None,
        }
    }

    /// Attachable pieces: they belong in the extras pool, not in the model grid.
    /// Drafts stay listed as models because the existing filter and draft picker read
    /// them from the catalog; PLE tables and projectors were never models.
    pub fn is_attachment(self) -> bool {
        matches!(self, FileRole::PleTable | FileRole::Mmproj | FileRole::Adapter)
    }
}

/// Which evidence produced the role. Surfaced so the UI can say *how* a file was
/// classified, and so a low-confidence guess is visible instead of silent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoleEvidence {
    /// `general.type` KV.
    HeaderType,
    /// `general.architecture` KV.
    Architecture,
    /// Tensor-name table.
    TensorSignature,
    /// Split bookkeeping (metadata-only shard).
    SplitBookkeeping,
    /// `classify_draft_role` naming/shape hint.
    DraftHint,
    /// Filename pattern — weakest tier.
    Filename,
    /// Nothing matched.
    None,
}

impl RoleEvidence {
    pub fn as_str(self) -> &'static str {
        match self {
            RoleEvidence::HeaderType => "header_type",
            RoleEvidence::Architecture => "architecture",
            RoleEvidence::TensorSignature => "tensor_signature",
            RoleEvidence::SplitBookkeeping => "split_bookkeeping",
            RoleEvidence::DraftHint => "draft_hint",
            RoleEvidence::Filename => "filename",
            RoleEvidence::None => "none",
        }
    }

    /// True for tiers that do not depend on a publisher's naming choices.
    pub fn is_strong(self) -> bool {
        !matches!(self, RoleEvidence::Filename | RoleEvidence::None)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleVerdict {
    pub role: FileRole,
    pub evidence: RoleEvidence,
}

impl RoleVerdict {
    pub fn is_confident(self) -> bool {
        self.evidence.is_strong()
    }
}

/// Classify one file. `draft_hint` is `spec_draft::catalog_draft_role_hint`'s output;
/// pass `""` when the caller has none.
pub fn classify(shape: Option<&GgufShape>, draft_hint: &str, path: &str) -> RoleVerdict {
    let v = |role, evidence| RoleVerdict { role, evidence };

    // 1. Explicit header type — the converter's own statement.
    if let Some(shape) = shape {
        if let Some(t) = shape.general_type.as_deref() {
            match t.trim().to_ascii_lowercase().as_str() {
                "mmproj" => return v(FileRole::Mmproj, RoleEvidence::HeaderType),
                "adapter" | "lora" => return v(FileRole::Adapter, RoleEvidence::HeaderType),
                _ => {}
            }
        }
        // 2. Vision projector arch. `clip` is the only arch mmproj files carry.
        if shape.architecture.eq_ignore_ascii_case("clip") {
            return v(FileRole::Mmproj, RoleEvidence::Architecture);
        }
    }

    // 3. Drafts, before the trunk rules: an MTP head contains `blk.N` tensors and a
    //    vocab tensor, so it would otherwise pass as a model.
    if !draft_hint.is_empty() && crate::spec_draft::is_external_draft_role_hint(draft_hint) {
        return v(FileRole::Draft, RoleEvidence::DraftHint);
    }
    // A baked-in-MTP main ALSO carries nextn tensors — it is a model that can draft with
    // itself, not a draft head. The distinguishing fact is the trunk stack: a head has no
    // blocks of its own (real head: 34 tensors, 0 trunk blocks), a baked-in main has the
    // full stack (real: 866 tensors, 65 blocks).
    if let Some(shape) = shape {
        let draft_tensors = shape.nextn_layers > 0 || shape.has_markov_w1;
        if draft_tensors && shape.block_count <= 1 {
            return v(FileRole::Draft, RoleEvidence::TensorSignature);
        }
    }

    // 4. Lookup table: `per_layer_token_embd` and no trunk, no vocab. This is the
    //    Engram/PLE-only file — no architecture KV, often exactly one tensor.
    if let Some(shape) = shape {
        if shape.lookup_table_bytes > 0 && !shape.has_trunk && !shape.has_vocab {
            return v(FileRole::PleTable, RoleEvidence::TensorSignature);
        }
    }

    // 5. Model: a trunk, or a metadata-only shard of one (0 tensors, split bookkeeping).
    if let Some(shape) = shape {
        if shape.has_trunk || shape.has_vocab {
            return v(FileRole::Model, RoleEvidence::TensorSignature);
        }
        if shape.tensor_count == 0 && shape.split_count.is_some() {
            return v(FileRole::Model, RoleEvidence::SplitBookkeeping);
        }
    }

    // 6. Filename, last resort — only for files the header could not classify.
    let lower = path.to_ascii_lowercase();
    if lower.contains("mmproj") || lower.contains("imatrix") {
        return v(FileRole::Mmproj, RoleEvidence::Filename);
    }

    v(FileRole::Unknown, RoleEvidence::None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape() -> GgufShape {
        GgufShape::default()
    }

    /// Real header: DeepSeek-V4.1 Engram / ISTA `DeepSeek-V4.1-Flash-Engram-IQ4_NL.gguf`.
    /// 6 KVs, no architecture, one tensor, split.no=5 of 6.
    #[test]
    fn engram_table_without_architecture_is_a_lookup_table() {
        let s = GgufShape {
            tensor_count: 1,
            lookup_table_bytes: 1_000,
            lookup_dims: Some(vec![256, 768_022_850]),
            split_no: Some(5),
            split_count: Some(6),
            tensors_declared: Some(1043),
            ..shape()
        };
        let verdict = classify(Some(&s), "", r"C:\m\engram.gguf");
        assert_eq!(verdict.role, FileRole::PleTable);
        assert_eq!(verdict.evidence, RoleEvidence::TensorSignature);
        assert!(verdict.is_confident());
    }

    /// Real header: the PLE shard of a Qwen3.8-Flash-Next set — 160 x 320,001,536,
    /// split.no=1 of 4, no architecture KV.
    #[test]
    fn qwen_ple_shard_is_a_lookup_table() {
        let s = GgufShape {
            tensor_count: 1,
            lookup_table_bytes: 2,
            lookup_dims: Some(vec![160, 320_001_536]),
            split_no: Some(1),
            split_count: Some(4),
            ..shape()
        };
        assert_eq!(
            classify(Some(&s), "", r"C:\m\qwen-00002-of-00004.gguf").role,
            FileRole::PleTable
        );
    }

    /// A shard-1 metadata carrier: zero tensors but split bookkeeping present.
    #[test]
    fn metadata_only_shard_is_a_model() {
        let s = GgufShape {
            architecture: "deepseek41".into(),
            tensor_count: 0,
            split_no: Some(0),
            split_count: Some(6),
            tensors_declared: Some(1043),
            ..shape()
        };
        let verdict = classify(Some(&s), "", r"C:\m\shard-00001-of-00006.gguf");
        assert_eq!(verdict.role, FileRole::Model);
        assert_eq!(verdict.evidence, RoleEvidence::SplitBookkeeping);
    }

    /// A model that carries its PLE inside the set still classifies as a model.
    #[test]
    fn model_with_embedded_lookup_table_is_still_a_model() {
        let s = GgufShape {
            architecture: "qwen4exp".into(),
            has_trunk: true,
            has_vocab: true,
            tensor_count: 300,
            lookup_table_bytes: 27_000_000_000,
            ..shape()
        };
        assert_eq!(
            classify(Some(&s), "", r"C:\m\model-00002-of-00004.gguf").role,
            FileRole::Model
        );
    }

    /// mmproj: `general.type = mmproj` and arch `clip` both seen in the wild.
    #[test]
    fn projector_uses_header_type_then_arch() {
        let by_type = GgufShape {
            general_type: Some("mmproj".into()),
            architecture: "clip".into(),
            ..shape()
        };
        assert_eq!(
            classify(Some(&by_type), "", "x.gguf").evidence,
            RoleEvidence::HeaderType
        );
        let by_arch = GgufShape {
            architecture: "clip".into(),
            ..shape()
        };
        assert_eq!(
            classify(Some(&by_arch), "", "x.gguf").evidence,
            RoleEvidence::Architecture
        );
    }

    /// Draft hints win over the trunk rules: an MTP head carries `blk.N` + vocab.
    #[test]
    fn draft_hint_beats_trunk_evidence() {
        let s = GgufShape {
            architecture: "qwen4exp".into(),
            has_trunk: true,
            has_vocab: true,
            tensor_count: 34,
            ..shape()
        };
        let verdict = classify(Some(&s), "external_mtp", "mtp-head.gguf");
        assert_eq!(verdict.role, FileRole::Draft);
    }

    /// Without a hint, `nextn` tensors still identify a head.
    #[test]
    fn nextn_tensors_identify_a_draft() {
        let s = GgufShape {
            nextn_layers: 1,
            has_trunk: true,
            ..shape()
        };
        assert_eq!(classify(Some(&s), "", "x.gguf").role, FileRole::Draft);
    }

    /// A main that carries its own MTP layers is a MODEL, not a draft head.
    #[test]
    fn baked_in_mtp_main_is_a_model() {
        let s = GgufShape {
            architecture: "qwen4exp".into(),
            block_count: 65,
            nextn_layers: 65,
            has_trunk: true,
            has_vocab: true,
            tensor_count: 866,
            ..shape()
        };
        assert_eq!(
            classify(Some(&s), "", "Qwen3.6-27B-MTP-pi-tune-Q4_K_M.gguf").role,
            FileRole::Model
        );
    }

    /// A real MTP head: nextn tensors and no trunk blocks of its own.
    #[test]
    fn mtp_head_without_blocks_is_a_draft() {
        let s = GgufShape {
            architecture: "qwen4exp".into(),
            block_count: 0,
            nextn_layers: 49,
            has_trunk: true,
            has_vocab: true,
            tensor_count: 34,
            ..shape()
        };
        assert_eq!(
            classify(Some(&s), "", r"C:\m\mtp\Mtp-Qwen3.8-Flash-Next-Q8_0.gguf").role,
            FileRole::Draft
        );
    }
    /// No shape at all: filename tier only, and it is flagged as weak.
    #[test]
    fn filename_is_flagged_as_weak_evidence() {
        let verdict = classify(None, "", r"C:\m\mmproj-F16.gguf");
        assert_eq!(verdict.role, FileRole::Mmproj);
        assert!(!verdict.is_confident());
    }

    /// The attachment rule drives which files leave the model grid.
    #[test]
    fn only_tables_and_projectors_are_attachments() {
        assert!(FileRole::PleTable.is_attachment());
        assert!(FileRole::Mmproj.is_attachment());
        assert!(!FileRole::Model.is_attachment());
        assert!(!FileRole::Draft.is_attachment());
    }
}
