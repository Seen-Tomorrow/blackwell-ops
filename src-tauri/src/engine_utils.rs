//! Shared engine utilities — provider binary resolution.
//!
//! Extracted from engine.rs for use by multiple modules without circular deps.

use std::path::PathBuf;

use crate::config::AppConfig;

/// Resolve binary path for a provider ID.
pub fn find_provider_binary(cfg: &AppConfig, provider_id: &str, binary_profile: &str) -> PathBuf {
    for p in &cfg.providers {
        if p.id == provider_id {
            // Per-env path first (vanguard/stable/fresh)
            if !binary_profile.is_empty() {
                if let Some(path) = p.binary_path_per_env.get(binary_profile) {
                    return PathBuf::from(path);
                }
            }
            // Fallback to main binary_path
            if !p.binary_path.is_empty() {
                return PathBuf::from(&p.binary_path);
            }
        }
    }

    if let Some(first) = cfg.providers.first() {
        PathBuf::from(&first.binary_path)
    } else {
        cfg.llama_path.clone()
    }
}
