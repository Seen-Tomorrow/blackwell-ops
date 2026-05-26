//! Shared engine utilities — provider binary resolution.
//!
//! Extracted from engine.rs for use by multiple modules without circular deps.

use std::path::PathBuf;

use crate::config::AppConfig;

/// Resolve binary path for a provider ID. Handles both relative and absolute paths.
pub fn find_provider_binary(cfg: &AppConfig, provider_id: &str, binary_profile: &str) -> PathBuf {
    for p in &cfg.providers {
        if p.id == provider_id {
            // Per-env path first (vanguard/stable/fresh). Empty profile defaults to vanguard.
            let profile_to_try = if binary_profile.is_empty() { "vanguard" } else { binary_profile };
            if let Some(path) = p.binary_path_per_env.get(profile_to_try) {
                return crate::config::resolve_path(path);
            }
            // Fallback to main binary_path
            if !p.binary_path.is_empty() {
                return crate::config::resolve_path(&p.binary_path);
            }
        }
    }

    if let Some(first) = cfg.providers.first() {
        crate::config::resolve_path(&first.binary_path)
    } else {
        PathBuf::new()
    }
}
