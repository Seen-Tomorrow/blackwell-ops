//! Shared engine utilities — provider binary resolution.
//!
//! Extracted from engine.rs for use by multiple modules without circular deps.

use std::path::PathBuf;

use crate::config::AppConfig;

/// Find the binary path for a given provider ID.
/// Checks registered providers first, then falls back to default llama_path.
pub fn find_provider_binary(cfg: &AppConfig, provider_id: &str) -> PathBuf {
    // Check registered providers first
    for p in &cfg.providers {
        if p.id == provider_id && !p.binary_path.is_empty() {
            return PathBuf::from(&p.binary_path);
        }
    }

    // Ultimate fallback — use the first registered provider's binary or default path
    if let Some(first) = cfg.providers.first() {
        PathBuf::from(&first.binary_path)
    } else {
        cfg.llama_path.clone()
    }
}
