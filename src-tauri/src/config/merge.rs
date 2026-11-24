//! Factory-template helpers: version lookup, deduplication, binary resolution, and backup.

use crate::config::*;

pub fn json_val_key(v: &serde_json::Value) -> String {
    if let Some(n) = v.as_f64() {
        if n.fract() == 0.0 && n.is_finite() {
            format!("{}", n as i64)
        } else {
            format!("{n}")
        }
    } else {
        v.to_string()
    }
}

/// Read `templateVersion` from the factory default config for a provider or template type.
pub fn factory_template_version_for_provider(
    provider_id: &str,
    template_type: &str,
    factory_provided: bool,
) -> u32 {
    resolve_merge_template_key(provider_id, template_type, factory_provided)
        .map(|key| crate::templates::get_template_version_for_provider(&key))
        .unwrap_or(1)
}

/// Resolve which runtime folder supplies the factory template.
pub fn resolve_merge_template_key(
    provider_id: &str,
    template_type: &str,
    factory_provided: bool,
) -> Option<String> {
    if factory_provided && crate::templates::load_provider_defaults(provider_id).is_some() {
        return Some(provider_id.to_string());
    }
    template_key_for_type(template_type)
}

/// Drop duplicate/empty param keys — keeps lowest `order` entry per key.
pub fn dedupe_user_params_by_key(
    params: Vec<crate::types::UserEditedTemplateParam>,
) -> Vec<crate::types::UserEditedTemplateParam> {
    let mut sorted = params;
    sorted.sort_by_key(|p| p.order);
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(sorted.len());
    for p in sorted {
        if p.key.is_empty() {
            log::warn!("[config] Dropping param with empty key (order={})", p.order);
            continue;
        }
        if seen.insert(p.key.clone()) {
            out.push(p);
        } else {
            log::warn!("[config] Dropping duplicate param key '{}' (order={})", p.key, p.order);
        }
    }
    out.sort_by_key(|p| p.order);
    out
}

/// Best-effort backup of a customized user config before resetting to a new factory `templateVersion`.
pub fn backup_customized_user_config(provider_id: &str, old_version: u32) {
    let src = provider_user_config_path(provider_id);
    if !src.is_file() {
        return;
    }
    let backup_dir = config_dir().join("backups");
    if let Err(e) = std::fs::create_dir_all(&backup_dir) {
        log::warn!("[config] Failed to create backup dir {}: {e}", backup_dir.display());
        return;
    }
    let dst = backup_dir.join(format!("{provider_id}-v{old_version}.json"));
    if let Err(e) = std::fs::copy(&src, &dst) {
        log::warn!("[config] Failed to backup {} -> {}: {e}", src.display(), dst.display());
    } else {
        log::info!("[config] Backed up customized user config -> {}", dst.display());
    }
}

pub fn resolve_provider_binaries_from_meta(
    p: &mut crate::types::ProviderConfig,
    meta: Option<&crate::types::ProviderConfig>,
) {
    if let Some(m) = meta {
        // Preference is intent-only — copy from disk meta, never invent here.
        p.binary_source_per_env = m.binary_source_per_env.clone();
        p.downloaded_version_per_env = m.downloaded_version_per_env.clone();
    }
    crate::profile_binaries::resolve_provider_binaries(p);
}
