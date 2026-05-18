//! Shared engine utilities — provider binary resolution and crash diagnostics.
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

/// Strip ANSI escape sequences from ConPTY output.
pub fn strip_ansi(s: &str) -> String {
    let mut result = s.replace('\x1b', "");
    while let Some(start) = result.find('[') {
        let rest = &result[start + 1..];
        if let Some(end) = rest.find(|c: char| c.is_ascii_alphabetic()) {
            let params = &rest[..end];
            if params.chars().all(|c| c.is_ascii_digit() || c == ';') && !params.is_empty() {
                result = format!("{}{}", &result[..start], &rest[end..]);
                continue;
            }
        }
        break;
    }
    result.trim().to_string()
}

/// Extract a human-readable crash reason from buffered ConPTY output lines.
pub fn extract_crash_reason(lines: &[String], exit_code: u32) -> String {
    for line in lines.iter().rev() {
        let lower = line.to_lowercase();
        if lower.contains("unknown option") || lower.contains("invalid value") || lower.contains("error:") {
            return strip_ansi(line).chars().take(120).collect();
        }
    }
    format!("process exited unexpectedly (code={})", exit_code)
}
