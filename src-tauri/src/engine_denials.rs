//! One place where the app denies a **knob value** the engine cannot honour.
//!
//! The table is `runtime/engine-denials.json`, embedded at build time. A rule names a
//! knob, the values it denies (all of them when `values` is empty), and the conditions
//! under which the denial applies — currently the model architecture. Everything not
//! named keeps working: a rule removes one slider position for one model family, never
//! a whole engine.
//!
//! Why this exists instead of scattered `if`s: every denial is a claim about the engine
//! binary that will drift. Keeping them in one data file means a stale rule is a
//! one-line edit, and the operator sees it fire in BOC (see `engine::spawn` and
//! `fit_scanner`) instead of wondering why a knob does nothing.
//!
//! Nothing here learns or guesses: a denied pair is refused before the process starts,
//! with the rule id and the reason in the error text.

use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

/// One denial rule.
#[derive(Debug, Clone, Deserialize)]
pub struct DenialRule {
    /// Stable id — quoted in BOC and in the spawn error, so a rule can be traced.
    pub id: String,
    /// Config knob the rule constrains (`split`, `kv_quant`, …).
    pub knob: String,
    /// Denied values of that knob. Empty/missing denies every value of the knob.
    #[serde(default)]
    pub values: Vec<String>,
    /// Architectures the rule applies to. Empty/missing applies to every model.
    #[serde(default)]
    pub architectures: Vec<String>,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
struct DenialsFile {
    version: u32,
    #[serde(default)]
    denials: Vec<DenialRule>,
}

impl DenialsFile {
    fn empty() -> Self {
        Self {
            version: 0,
            denials: Vec::new(),
        }
    }
}

static DENIALS: LazyLock<DenialsFile> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../runtime/engine-denials.json")).unwrap_or_else(|e| {
        // A malformed table must not brick every launch: log loudly and deny nothing.
        log::warn!("[denials] could not parse engine-denials.json: {e}");
        DenialsFile::empty()
    })
});

/// A matched denial, ready to be shown to the operator.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Denial {
    pub rule: String,
    pub knob: String,
    pub value: String,
    pub architecture: String,
    pub reason: String,
}

impl Denial {
    /// Operator-facing sentence — the only text BOC and the spawn error show.
    pub fn message(&self) -> String {
        format!(
            "{}={} is not supported for architecture '{}' (rule {}): {}",
            self.knob, self.value, self.architecture, self.rule, self.reason
        )
    }
}

fn normalise(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

/// True when any rule constrains this knob — lets a caller skip an expensive model
/// shape read when nothing can deny the parameter it holds.
pub fn knob_has_rules(knob: &str) -> bool {
    let knob = normalise(knob);
    DENIALS.denials.iter().any(|rule| normalise(&rule.knob) == knob)
}

/// Denial for `knob=value` on a model of `architecture`, or `None` when allowed.
///
/// `architecture` may be empty (unknown model): only rules without an architecture
/// constraint apply then, so an unknown model keeps the provider defaults.
pub fn evaluate(knob: &str, value: &str, architecture: &str) -> Option<Denial> {
    let knob = normalise(knob);
    let value = normalise(value);
    let arch = normalise(architecture);

    DENIALS
        .denials
        .iter()
        .find(|rule| {
            normalise(&rule.knob) == knob
                && (rule.values.is_empty() || rule.values.iter().any(|v| normalise(v) == value))
                && (rule.architectures.is_empty()
                    || rule.architectures.iter().any(|a| normalise(a) == arch))
        })
        .map(|rule| Denial {
            rule: rule.id.clone(),
            knob: knob.clone(),
            value: value.clone(),
            architecture: arch.clone(),
            reason: rule.reason.clone(),
        })
}

/// Whole table for the frontend, so a control can disable exactly the denied value.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DenialsView {
    pub version: u32,
    pub denials: Vec<DenialRuleView>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DenialRuleView {
    pub id: String,
    pub knob: String,
    pub values: Vec<String>,
    pub architectures: Vec<String>,
    pub reason: String,
}

#[tauri::command]
pub fn get_engine_denials() -> DenialsView {
    DenialsView {
        version: DENIALS.version,
        denials: DENIALS
            .denials
            .iter()
            .map(|rule| DenialRuleView {
                id: rule.id.clone(),
                knob: rule.knob.clone(),
                values: rule.values.clone(),
                architectures: rule.architectures.clone(),
                reason: rule.reason.clone(),
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::evaluate;

    #[test]
    fn fp8_kv_is_denied_only_on_the_architectures_llama_excludes() {
        for arch in ["deepseek4", "deepseek41", "qwen4exp", "glm-dsa", "minimax-m3"] {
            let denial = evaluate("kv_quant", "f8_e4m3", arch)
                .unwrap_or_else(|| panic!("{arch} must refuse an FP8 KV cache"));
            assert_eq!(denial.rule, "fp8-kv-arch");
            assert!(denial.message().contains("f8_e4m3"), "{}", denial.message());
        }
        // Other architectures keep the option, and the other KV values are never touched.
        assert!(evaluate("kv_quant", "f8_e4m3", "laguna").is_none());
        assert!(evaluate("kv_quant", "f8_e4m3", "ornith").is_none());
        assert!(evaluate("kv_quant", "q8_0", "qwen4exp").is_none());
        assert!(evaluate("kv_quant", "q4_0", "deepseek4").is_none());
    }

    #[test]
    fn tensor_split_denial_survives_the_move_into_the_shared_table() {
        assert_eq!(
            evaluate("split", "tensor", "laguna").map(|d| d.rule),
            Some("tensor-split-laguna".into())
        );
        assert!(evaluate("split", "layer", "laguna").is_none());
        assert!(evaluate("split", "tensor", "qwen35").is_none());
    }

    #[test]
    fn matching_is_case_and_whitespace_insensitive_and_unknown_models_pass() {
        assert!(evaluate(" KV_QUANT ", "F8_E4M3", " Qwen4Exp ").is_some());
        // Empty architecture = unknown model: an arch-scoped rule must not fire.
        assert!(evaluate("kv_quant", "f8_e4m3", "").is_none());
    }
}
