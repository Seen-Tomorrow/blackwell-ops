//! Provider persistence: ProviderConfig, AppConfig, per-provider user config files.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use crate::config::*;
use crate::types::ProviderConfig;

fn default_providers() -> Vec<ProviderConfig> { Vec::new() }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub model_paths: Vec<ModelPathEntry>,
    /// HuggingFace API token — stored in app_config.json. Empty string if not set.
    #[serde(default)]
    pub hf_token: String,
    #[serde(default = "default_providers", skip_serializing)]
    pub providers: Vec<ProviderConfig>,
    /// Where downloads go — derived from the default model path.
    #[serde(default)]
    pub default_download_path: Option<String>,
    /// First-run onboarding checklist finished — persisted so config wipe can replay the wizard.
    #[serde(default)]
    pub setup_completed: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        let entry = default_model_path_entry();
        Self {
            model_paths: vec![entry.clone()],
            hf_token: String::new(),
            providers: Vec::new(),
            default_download_path: Some(entry.path),
            setup_completed: false,
        }
    }
}

// ── Per-Provider User Config Persistence ────────────────────────────

/// Get the user config file path for a provider.
pub fn provider_user_config_path(provider_id: &str) -> PathBuf {
    config_dir().join(format!("{}-user-config.json", provider_id))
}

/// Factory default config JSON on disk (runtime mirror).
pub fn factory_default_config_path(provider_id: &str) -> PathBuf {
    app_root_dir()
        .join("runtime")
        .join(provider_id)
        .join("config")
        .join(format!("{provider_id}-default-config.json"))
}


pub fn apply_factory_layout_defaults(
    provider: &mut crate::types::ProviderConfig,
    factory_key: &str,
) {
    let (factory_group_order, factory_layout, factory_protected) =
        crate::templates::load_factory_layout_supplement(factory_key);
    if provider.group_order.is_empty() && !factory_group_order.is_empty() {
        provider.group_order = factory_group_order
            .into_iter()
            .map(|g| normalize_ui_group(&g))
            .collect();
    }
    if provider.protected_groups.is_empty() && !factory_protected.is_empty() {
        provider.protected_groups = factory_protected
            .into_iter()
            .map(|g| normalize_ui_group(&g))
            .collect();
    }
    if provider.group_display_zone.is_empty() && !factory_layout.group_display_zone.is_empty() {
        provider.group_display_zone = factory_layout.group_display_zone.clone();
    }
    if provider.config_column_count.is_none() && factory_layout.config_column_count > 0 {
        provider.config_column_count = Some(factory_layout.config_column_count.clamp(1, 3));
    }
    if provider.config_column_widths.is_empty() && !factory_layout.config_column_widths.is_empty() {
        provider.config_column_widths = factory_layout.config_column_widths.clone();
    }
    if provider.group_column.is_empty() && !factory_layout.group_column.is_empty() {
        provider.group_column = factory_layout.group_column.clone();
    }
    if provider.above_column_widths.is_empty() && !factory_layout.above_column_widths.is_empty() {
        provider.above_column_widths = factory_layout.above_column_widths.clone();
    }
}

pub fn apply_meta_layout_overrides(
    provider: &mut crate::types::ProviderConfig,
    meta: &crate::types::ProviderConfig,
    factory_key: &str,
) {
    if !meta.group_order.is_empty() {
        provider.group_order = meta.group_order.clone();
    } else {
        apply_factory_layout_defaults(provider, factory_key);
        if !meta.protected_groups.is_empty() {
            provider.protected_groups = meta.protected_groups.clone();
        }
        return;
    }
    if !meta.protected_groups.is_empty() {
        provider.protected_groups = meta.protected_groups.clone();
    } else if provider.protected_groups.is_empty() {
        let (_, _, factory_protected) =
            crate::templates::load_factory_layout_supplement(factory_key);
        if !factory_protected.is_empty() {
            provider.protected_groups = factory_protected
                .into_iter()
                .map(|g| normalize_ui_group(&g))
                .collect();
        }
    }
    if !meta.group_display_zone.is_empty() {
        provider.group_display_zone = meta.group_display_zone.clone();
    }
    if meta.config_column_count.is_some() {
        provider.config_column_count = meta.config_column_count;
    }
    if !meta.config_column_widths.is_empty() {
        provider.config_column_widths = meta.config_column_widths.clone();
    }
    if !meta.group_column.is_empty() {
        provider.group_column = meta.group_column.clone();
    }
    if !meta.above_column_widths.is_empty() {
        provider.above_column_widths = meta.above_column_widths.clone();
    }
    if provider.group_display_zone.is_empty()
        || provider.config_column_count.is_none()
        || provider.config_column_widths.is_empty()
        || provider.group_column.is_empty()
        || provider.above_column_widths.is_empty()
    {
        let (_, factory_layout, _) = crate::templates::load_factory_layout_supplement(factory_key);
        if provider.group_display_zone.is_empty() && !factory_layout.group_display_zone.is_empty() {
            provider.group_display_zone = factory_layout.group_display_zone;
        }
        if provider.config_column_count.is_none() && factory_layout.config_column_count > 0 {
            provider.config_column_count = Some(factory_layout.config_column_count.clamp(1, 3));
        }
        if provider.config_column_widths.is_empty() && !factory_layout.config_column_widths.is_empty() {
            provider.config_column_widths = factory_layout.config_column_widths;
        }
        if provider.group_column.is_empty() && !factory_layout.group_column.is_empty() {
            provider.group_column = factory_layout.group_column;
        }
        if provider.above_column_widths.is_empty() && !factory_layout.above_column_widths.is_empty() {
            provider.above_column_widths = factory_layout.above_column_widths;
        }
    }
}

/// Load all per-provider user configs from disk.
pub fn load_user_providers_meta() -> Vec<crate::types::ProviderConfig> {
    let mut metas = Vec::new();
    let cd = config_dir();

    if !cd.exists() {
        return metas;
    }

    for entry in std::fs::read_dir(&cd).into_iter().flatten() {
        let entry = match entry { Ok(e) => e, Err(_) => continue };
        let path = entry.path();

        // Match *-user-config.json files
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !file_name.ends_with("-user-config.json") {
            continue;
        }

        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(meta) = serde_json::from_str::<crate::types::ProviderConfig>(&content) {
                metas.push(meta);
            } else {
                log::warn!("[config] Failed to parse {}: skipping (check for corrupt JSON)", path.display());
            }
        } else {
            log::warn!("[config] Failed to read {}", path.display());
        }
    }

    log::info!("[config] Loaded {} per-provider user config(s)", metas.len());
    metas
}

/// Save a single provider's user config to its own file.
pub fn save_provider_user_config(provider: &crate::types::ProviderConfig) -> Result<(), String> {
    std::fs::create_dir_all(config_dir()).map_err(|e| format!("Failed to create config dir: {}", e))?;

    let path = provider_user_config_path(&provider.id);
    let json = serde_json::to_string_pretty(provider).map_err(|e| format!("Serialization failed: {}", e))?;
    std::fs::write(&path, &json).map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;

    log::info!("[config] Saved user config for {} -> {}", provider.id, path.display());
    Ok(())
}

/// Reset a provider by deleting its user config file. Next load will use defaults.
pub fn reset_provider_to_defaults(provider_id: &str) -> Result<(), String> {
    let path = provider_user_config_path(provider_id);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Failed to remove {}: {}", path.display(), e))?;
        log::info!("[config] Reset {} — removed user config", provider_id);
    } else {
        log::info!("[config] {} already at defaults (no user config)", provider_id);
    }
    Ok(())
}

/// Persist all providers as individual per-provider config files.
pub fn persist_user_providers_meta(providers: &[ProviderConfig]) -> Result<(), String> {
    for p in providers {
        if p.template_type.is_empty() {
            continue;
        }
        save_provider_user_config(p)?;
    }
    Ok(())
}

