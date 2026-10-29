//! Architecture capabilities that are data, not code.
//!
//! The list lives in `runtime/arch-capabilities.json` so adding an arch whose
//! flags are denied upstream is a one-file edit. Unknown arches keep the
//! provider defaults.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchRule {
    /// `false` = deny `-sm tensor` for this architecture. Missing = allowed.
    #[serde(default)]
    pub tensor_split: Option<bool>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ArchCapabilitiesFile {
    version: u32,
    #[serde(default)]
    arches: HashMap<String, ArchRule>,
}

static CAPABILITIES: LazyLock<ArchCapabilitiesFile> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../runtime/arch-capabilities.json")).unwrap_or_else(|e| {
        log::warn!("[arch] could not parse arch-capabilities.json: {e}");
        ArchCapabilitiesFile {
            version: 0,
            arches: HashMap::new(),
        }
    })
});

fn arch_key(arch: &str) -> String {
    arch.trim().to_ascii_lowercase()
}

/// Reason when tensor split is denied for this architecture.
pub fn tensor_split_denial(arch: &str) -> Option<String> {
    let rule = CAPABILITIES.arches.get(&arch_key(arch))?;
    (rule.tensor_split == Some(false)).then(|| {
        rule.reason
            .clone()
            .unwrap_or_else(|| format!("tensor split is disabled for architecture '{arch}'"))
    })
}

/// Full capability table for the frontend, same source as the launch guard.
#[tauri::command]
pub fn get_arch_capabilities() -> Value {
    json!({
        "version": CAPABILITIES.version,
        "arches": CAPABILITIES.arches,
    })
}

#[cfg(test)]
mod tests {
    use super::tensor_split_denial;

    #[test]
    fn laguna_denies_tensor_split() {
        let reason = tensor_split_denial("laguna").expect("laguna denied");
        assert!(reason.contains("tensor"));
    }

    #[test]
    fn unknown_architecture_keeps_defaults() {
        assert!(tensor_split_denial("qwen35").is_none());
        assert!(tensor_split_denial("").is_none());
    }
}
