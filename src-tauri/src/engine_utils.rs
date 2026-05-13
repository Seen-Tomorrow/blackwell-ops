//! Shared engine utilities — provider binary resolution.
//!
//! Extracted from engine.rs for use by multiple modules without circular deps.

use std::path::PathBuf;

use crate::config::AppConfig;

/// Find the binary path for a given provider ID and optional build profile.
/// Checks registered providers first, then falls back to default llama_path.
/// When binary_profile is set (vanguard/fresh/stable), resolves per-profile path.
pub fn find_provider_binary(cfg: &AppConfig, provider_id: &str, binary_profile: &str) -> PathBuf {
    // Check registered providers first
    for p in &cfg.providers {
        if p.id == provider_id && !p.binary_path.is_empty() {
            let path = if !binary_profile.is_empty() {
                // Future: resolve per-profile directory (e.g., C:\reactor_foundry\engines\{provider}\{profile}\...)
                // For now, all profiles share the same binary path ("current" key)
                PathBuf::from(&p.binary_path)
            } else {
                PathBuf::from(&p.binary_path)
            };
            return path;
        }
    }

    // Ultimate fallback — use the first registered provider's binary or default path
    if let Some(first) = cfg.providers.first() {
        PathBuf::from(&first.binary_path)
    } else {
        cfg.llama_path.clone()
    }
}
