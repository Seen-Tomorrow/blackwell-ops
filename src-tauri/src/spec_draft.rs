//! Speculative-decoding draft model classification and pairing helpers.

use std::path::Path;

use crate::types::ModelMetadata;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DraftRole {
    None,
    MtpEmbedded,
    ExternalDflash,
    ExternalEagle3,
    ExternalMtp,
}

impl DraftRole {
    pub fn as_str(self) -> &'static str {
        match self {
            DraftRole::None => "none",
            DraftRole::MtpEmbedded => "mtp_embedded",
            DraftRole::ExternalDflash => "external_dflash",
            DraftRole::ExternalEagle3 => "external_eagle3",
            DraftRole::ExternalMtp => "external_mtp",
        }
    }

    pub fn is_external_draft_only(self) -> bool {
        matches!(self, DraftRole::ExternalDflash | DraftRole::ExternalEagle3 | DraftRole::ExternalMtp)
    }
}

fn metadata_has_target_layers(meta: &ModelMetadata) -> bool {
    meta.raw_kvs.keys().any(|k| {
        let lower = k.to_lowercase();
        lower.contains("target_layers") || lower.contains("target_layer_ids")
    })
}

pub fn classify_draft_role(meta: &ModelMetadata, model_path: &str) -> DraftRole {
    // Path/folder/filename identity first — DFlash repos always include "dflash" in the tree.
    let path_role = draft_role_from_path_heuristics(model_path);
    if path_role != DraftRole::None {
        return path_role;
    }

    let arch = meta.architecture.trim().to_lowercase();
    if arch == "dflash" {
        return DraftRole::ExternalDflash;
    }
    if arch == "eagle3" {
        return DraftRole::ExternalEagle3;
    }
    // target_layers beats nextn_predict_layers — external DFlash GGUFs often carry both.
    if metadata_has_target_layers(meta) && arch != "eagle3" {
        return DraftRole::ExternalDflash;
    }
    // Standalone MTP head: has nextn layers AND path signals a separate head file.
    if meta.nextn_predict_layers > 0 && signal_contains_mtp_head(model_path) {
        return DraftRole::ExternalMtp;
    }
    // Head-only GGUF: has nextn layers but no vocabulary (embedding-free head file).
    // Full models always carry a tokenizer + vocab; standalone heads don't.
    if meta.nextn_predict_layers > 0 && meta.vocab_size == 0 && !meta.architecture.is_empty() {
        return DraftRole::ExternalMtp;
    }
    // Small-file MTP head: has nextn layers AND the file is tiny compared to a full model
    // of the same architecture (e.g., <10 GiB for a multi-hundred-GB MoE model).
    // This catches head exports that carry a full tokenizer but are clearly not the main model.
    if meta.nextn_predict_layers > 0 && meta.file_size_bytes > 0 && meta.file_size_bytes < 10_737_418_240 {
        return DraftRole::ExternalMtp;
    }
    if meta.nextn_predict_layers > 0 {
        return DraftRole::MtpEmbedded;
    }
    DraftRole::None
}

fn compact_alnum_lower(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

fn signal_contains_dflash(signal: &str) -> bool {
    let lower = signal.to_lowercase();
    if lower.contains("dflash") {
        return true;
    }
    if compact_alnum_lower(signal).contains("dflash") {
        return true;
    }
    // D-Flash, D_Flash, D.Flash, "D Flash"
    lower.contains("d-flash")
        || lower.contains("d_flash")
        || lower.contains("d.flash")
        || lower.contains("d flash")
}

fn signal_contains_eagle3(signal: &str) -> bool {
    let lower = signal.to_lowercase();
    lower.contains("eagle3") || compact_alnum_lower(signal).contains("eagle3")
}

/// Detect standalone MTP head signals — explicit "head" tokens only.
///
/// Deliberately NOT matching bare "-MTP-" or "MTP-GGUF": MTP-enabled *main* models use
/// those in their folder/file names (e.g. "Qwen3.6-27B-MTP-GGUF/..."), which are baked-in
/// MTP, not separate head files. Standalone heads are caught reliably by the
/// vocab_size==0 / tiny-file metadata heuristics in `classify_draft_role` — the path signal
/// is only a pre-scan convenience for names that explicitly say "head".
fn signal_contains_mtp_head(signal: &str) -> bool {
    let lower = signal.to_lowercase();
    let alnum = compact_alnum_lower(signal);
    // Exact mtp-head / mtp_head / mtphead tokens
    if lower.contains("mtp-head") || lower.contains("mtp_head") || alnum.contains("mtphead") {
        return true;
    }
    // head-mtp / head_mtp / headmtp
    if lower.contains("head-mtp") || lower.contains("head_mtp") || alnum.contains("headmtp") {
        return true;
    }
    // File literally named "X.mtp.gguf" (literal dot before mtp, not a dash) — a clear
    // head-export naming. "-mtp.gguf" is ambiguous and intentionally not matched.
    lower.ends_with(".mtp.gguf")
}

fn path_segment_signals(model_path: &str) -> impl Iterator<Item = &str> {
    model_path.split(['/', '\\']).filter(|s| !s.is_empty())
}

fn draft_role_from_path_heuristics(model_path: &str) -> DraftRole {
    for segment in path_segment_signals(model_path) {
        if signal_contains_dflash(segment) {
            return DraftRole::ExternalDflash;
        }
        if signal_contains_eagle3(segment) {
            return DraftRole::ExternalEagle3;
        }
        if signal_contains_mtp_head(segment) {
            return DraftRole::ExternalMtp;
        }
    }
    if signal_contains_dflash(model_path) {
        return DraftRole::ExternalDflash;
    }
    if signal_contains_eagle3(model_path) {
        return DraftRole::ExternalEagle3;
    }
    if signal_contains_mtp_head(model_path) {
        return DraftRole::ExternalMtp;
    }
    DraftRole::None
}

/// Catalog-time draft identity from path + display name + HF id (no GGUF scan required).
pub fn draft_identity_from_catalog_signals(
    path: &str,
    name: &str,
    hf_model_id: Option<&str>,
    source_path_label: Option<&str>,
) -> Option<DraftRole> {
    let mut signals: Vec<&str> = Vec::new();
    signals.push(path);
    signals.push(name);
    signals.extend(path_segment_signals(path));
    if let Some(label) = source_path_label {
        if !label.is_empty() {
            signals.push(label);
        }
    }
    if let Some(hf) = hf_model_id {
        signals.push(hf);
    }

    for signal in signals {
        if signal_contains_dflash(signal) {
            return Some(DraftRole::ExternalDflash);
        }
        if signal_contains_eagle3(signal) {
            return Some(DraftRole::ExternalEagle3);
        }
        if signal_contains_mtp_head(signal) {
            return Some(DraftRole::ExternalMtp);
        }
    }
    None
}

/// Best draft role for a catalog row — path/name signals win over GGUF header quirks.
pub fn resolve_catalog_draft_role(
    path: &str,
    name: &str,
    hf_model_id: Option<&str>,
    source_path_label: Option<&str>,
    meta: Option<&ModelMetadata>,
) -> String {
    if let Some(role) = draft_identity_from_catalog_signals(path, name, hf_model_id, source_path_label) {
        return role.as_str().to_string();
    }
    if let Some(m) = meta {
        let role = classify_draft_role(m, path);
        if role != DraftRole::None {
            return role.as_str().to_string();
        }
    }
    DraftRole::None.as_str().to_string()
}

pub fn is_launchable_target(meta: Option<&ModelMetadata>, model_path: &str) -> bool {
    match meta {
        Some(m) => !classify_draft_role(m, model_path).is_external_draft_only(),
        None => !draft_role_from_path_heuristics(model_path).is_external_draft_only(),
    }
}

pub fn spec_type_needs_external_draft(spec_type: &str) -> bool {
    let lower = spec_type.trim().to_lowercase();
    // External MTP heads are loaded via --spec-draft-model, same as DFlash.
    lower.contains("dflash") || lower.contains("eagle3") || lower.contains("external-mtp") || {
        lower.starts_with("draft-")
            && lower != "draft-mtp"
            && lower != "draft-simple"
    }
}

pub fn resolve_spec_draft_model_path(
    model_path: &str,
    value: &str,
    pattern: &str,
) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("off") {
        return None;
    }

    if trimmed.eq_ignore_ascii_case("auto") || trimmed.eq_ignore_ascii_case("on") {
        return scan_sibling_draft(model_path, pattern);
    }

    if trimmed.ends_with(".gguf") {
        let candidate = Path::new(trimmed);
        if candidate.is_absolute() && candidate.is_file() {
            return Some(trimmed.to_string());
        }
        if let Some(parent) = Path::new(model_path).parent() {
            let joined = parent.join(trimmed);
            if joined.is_file() {
                return Some(joined.to_string_lossy().to_string());
            }
        }
        if candidate.is_file() {
            return Some(trimmed.to_string());
        }
    }

    None
}

fn scan_sibling_draft(model_path: &str, pattern: &str) -> Option<String> {
    let parent = Path::new(model_path).parent()?;
    let entries = std::fs::read_dir(parent).ok()?;
    let pattern_lower = pattern.trim().to_lowercase();

    for entry in entries.flatten() {
        let fname = entry.file_name();
        let fname_str = fname.to_string_lossy();
        let fname_lower = fname_str.to_lowercase();
        if !fname_lower.ends_with(".gguf") {
            continue;
        }
        if matches_glob_pattern(&fname_lower, &pattern_lower) {
            return Some(fname.to_string_lossy().to_string());
        }
    }
    None
}

fn matches_glob_pattern(name: &str, pattern: &str) -> bool {
    if pattern.is_empty() || pattern == "*" {
        return true;
    }
    if let Some(inner) = pattern.strip_prefix('*').and_then(|s| s.strip_suffix('*')) {
        return !inner.is_empty() && name.contains(inner);
    }
    if let Some(suffix) = pattern.strip_prefix('*') {
        return name.ends_with(suffix);
    }
    if let Some(prefix) = pattern.strip_suffix('*') {
        return name.starts_with(prefix);
    }
    name == pattern
}

pub fn finalize_draft_role(meta: &mut ModelMetadata, model_path: &str) {
    let role = classify_draft_role(meta, model_path);
    meta.draft_role = role.as_str().to_string();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_meta(architecture: &str, nextn: u32) -> ModelMetadata {
        ModelMetadata {
            architecture: architecture.into(),
            nextn_predict_layers: nextn,
            ..empty_meta()
        }
    }

    fn empty_meta() -> ModelMetadata {
        ModelMetadata {
            architecture: String::new(),
            model_type_label: String::new(),
            n_layer: 0,
            n_ctx_train: 0,
            n_embd: 0,
            n_head: 0,
            n_head_kv: 0,
            n_expert: 0,
            n_expert_used: 0,
            rope_freq_base: 0.0,
            rope_dim: 0,
            feed_forward_length: 0,
            expert_feed_forward_length: 0,
            file_type_str: String::new(),
            bpw: 0.0,
            tensor_counts: std::collections::HashMap::new(),
            total_params_str: String::new(),
            vocab_size: 0,
            general_name: String::new(),
            rope_scaling_type: String::new(),
            tokenizer_model: String::new(),
            file_size_bytes: 0,
            scan_timestamp: 0,
            file_created: 0,
            nextn_predict_layers: 0,
            draft_role: String::new(),
            raw_kvs: std::collections::HashMap::new(),
            raw_print_info: std::collections::HashMap::new(),
            general_author: String::new(),
            general_repo_url: String::new(),
            general_basename: String::new(),
            general_quantized_by: String::new(),
            general_license: String::new(),
            general_tags: Vec::new(),
            base_models: Vec::new(),
            chat_template: String::new(),
        }
    }

    #[test]
    fn dflash_arch_classifies_external() {
        let meta = minimal_meta("dflash", 0);
        assert_eq!(
            classify_draft_role(&meta, r"C:\models\draft.gguf"),
            DraftRole::ExternalDflash
        );
    }

    #[test]
    fn mtp_layers_classify_embedded() {
        let meta = ModelMetadata {
            architecture: "qwen35".into(),
            nextn_predict_layers: 1,
            vocab_size: 128000,
            ..empty_meta()
        };
        assert_eq!(
            classify_draft_role(&meta, r"C:\models\target.gguf"),
            DraftRole::MtpEmbedded
        );
    }

    #[test]
    fn spec_type_needs_external_draft_detects_dflash() {
        assert!(spec_type_needs_external_draft("draft-dflash"));
        assert!(!spec_type_needs_external_draft("draft-mtp"));
    }

    #[test]
    fn dflash_path_segment_wins_over_mtp_nextn() {
        let mut meta = ModelMetadata {
            architecture: "qwen3".into(),
            nextn_predict_layers: 1,
            vocab_size: 152000,
            ..empty_meta()
        };
        meta.raw_kvs.insert("dflash.target_layers".to_string(), "[]".to_string());
        let path = r"C:\models\unsloth\Qwen3.5-4B-GGUF\DFlash\Qwen3.5-4B-Q4_K_M.gguf";
        assert_eq!(classify_draft_role(&meta, path), DraftRole::ExternalDflash);
    }

    #[test]
    fn target_layers_classifies_dflash_even_with_nextn() {
        let mut meta = minimal_meta("qwen35", 2);
        meta.raw_kvs
            .insert("dflash.target_layer_ids".to_string(), "[0,1]".to_string());
        assert_eq!(
            classify_draft_role(&meta, r"C:\models\qwen35-main.gguf"),
            DraftRole::ExternalDflash
        );
    }

    #[test]
    fn catalog_signals_check_each_path_segment() {
        let path = r"E:\LLM\vendor\Qwen3-4B\spec\DFlash\draft.gguf";
        assert_eq!(
            draft_identity_from_catalog_signals(path, "Qwen3-4B", None, None),
            Some(DraftRole::ExternalDflash)
        );
    }

    #[test]
    fn standalone_mtp_head_path_classifies_external() {
        let meta = minimal_meta("deepseek", 2);
        let path = r"C:\models\DeepSeek-v4-0732-mtp-head-q4.gguf";
        assert_eq!(classify_draft_role(&meta, path), DraftRole::ExternalMtp);
    }

    #[test]
    fn mtp_head_signal_beats_embedded_nextn() {
        let meta = minimal_meta("llama", 1);
        let path = r"C:\drafts\mtp_head\draft-q4.gguf";
        assert_eq!(classify_draft_role(&meta, path), DraftRole::ExternalMtp);
    }

    #[test]
    fn mtp_head_path_heuristic_returns_external_mtp() {
        assert_eq!(
            draft_role_from_path_heuristics(r"C:\models\mtp-head.gguf"),
            DraftRole::ExternalMtp
        );
        assert_eq!(
            draft_role_from_path_heuristics(r"C:\models\mtp_head\draft.bin"),
            DraftRole::ExternalMtp
        );
    }

    #[test]
    fn mtp_head_detected_via_catalog_signals() {
        let path = r"C:\models\DeepSeek-v4-mtp-head-q4.gguf";
        assert_eq!(
            draft_identity_from_catalog_signals(path, "MTP Head", None, None),
            Some(DraftRole::ExternalMtp)
        );
    }

    #[test]
    fn external_mtp_is_external_draft_only() {
        assert!(DraftRole::ExternalMtp.is_external_draft_only());
    }

    #[test]
    fn external_mtp_spec_type_needs_draft() {
        assert!(spec_type_needs_external_draft("draft-dflash"));
        assert!(spec_type_needs_external_draft("external-mtp"));
    }

    #[test]
    fn non_mtp_main_models_remain_launchable() {
        let meta = minimal_meta("deepseek", 0);
        assert!(is_launchable_target(Some(&meta), r"C:\models\main.gguf"));
    }

    #[test]
    fn external_mtp_is_not_launchable_as_main() {
        let meta = minimal_meta("deepseek", 2);
        assert!(!is_launchable_target(Some(&meta), r"C:\models\mtp-head-q4.gguf"));
    }

    #[test]
    fn head_only_gguf_without_vocab_classifies_external() {
        let meta = ModelMetadata {
            architecture: "deepseek".into(),
            nextn_predict_layers: 2,
            vocab_size: 0,
            ..empty_meta()
        };
        assert_eq!(
            classify_draft_role(&meta, r"C:\models\DeepSeek-V4-Flash-Q4.gguf"),
            DraftRole::ExternalMtp
        );
    }

    #[test]
    fn full_model_with_vocab_stays_mtp_embedded() {
        let meta = ModelMetadata {
            architecture: "deepseek".into(),
            nextn_predict_layers: 2,
            vocab_size: 128000,
            ..empty_meta()
        };
        assert_eq!(
            classify_draft_role(&meta, r"C:\models\full-deepseek.gguf"),
            DraftRole::MtpEmbedded
        );
    }

    #[test]
    fn mtp_gguf_main_model_stays_embedded_not_external() {
        // "-MTP-GGUF" folder naming means "main model with MTP baked in", NOT a head file.
        // Regression: bare "mtp-gguf"/"-mtp-" path signals must not misclassify these.
        let meta = ModelMetadata {
            architecture: "qwen35".into(),
            nextn_predict_layers: 1,
            vocab_size: 248320,
            file_size_bytes: 17_909_097_600,
            ..empty_meta()
        };
        let path = r"C:\models\unsloth\Qwen3.6-27B-MTP-GGUF\Qwen3.6-27B-UD-Q4_K_XL.gguf";
        assert_eq!(classify_draft_role(&meta, path), DraftRole::MtpEmbedded);
        assert!(is_launchable_target(Some(&meta), path));
    }

    #[test]
    fn deepseek_mtp_head_still_external_via_vocab_heuristic() {
        // Even though "-MTP-Q8_0.gguf" has no explicit "head" token in the name, the
        // vocab==0 (embedding-free head) heuristic must still classify it external.
        let meta = ModelMetadata {
            architecture: "deepseek4".into(),
            nextn_predict_layers: 1,
            vocab_size: 0,
            file_size_bytes: 4_734_696_224,
            ..empty_meta()
        };
        let path = r"C:\models\ddh0\DeepSeek-V4-Flash-GGUF\DeepSeek-V4-Flash-MTP-Q8_0.gguf";
        assert_eq!(classify_draft_role(&meta, path), DraftRole::ExternalMtp);
        assert!(!is_launchable_target(Some(&meta), path));
    }
}