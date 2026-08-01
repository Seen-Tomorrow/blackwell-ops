//! Provider persistence: ProviderMeta, AppConfig, per-provider user config files.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use crate::config::*;
use crate::types::ProviderConfig;


// ── Provider Metadata (persisted to disk) ───────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderMeta {
    pub id: String,
    pub display_name: String,
    pub binary_path: String,
    #[serde(default = "crate::types::default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub git_url: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub build_profile: String,
    #[serde(default)]
    pub template_type: String,
    #[serde(default, rename = "userEditedTemplateParams")]
    pub user_edited_template_params: Vec<crate::types::UserEditedTemplateParam>,
    /// Factory param keys removed by admin — merge will not re-append from template.
    #[serde(default, rename = "excludedParamKeys", skip_serializing_if = "Vec::is_empty")]
    pub excluded_param_keys: Vec<String>,
    /// Custom group order set by user (overrides template insertion order). Empty = use template order.
    #[serde(default, rename = "groupOrder")]
    pub group_order: Vec<String>,
    /// Groups flagged protected (factory structure lock for users).
    #[serde(default, rename = "protectedGroups", skip_serializing_if = "Vec::is_empty")]
    pub protected_groups: Vec<String>,
    /// Custom providers — fusion / metrics / verbose opt-ins.
    #[serde(
        default,
        rename = "customCapabilities",
        skip_serializing_if = "crate::types::CustomProviderCapabilities::is_default"
    )]
    pub custom_capabilities: crate::types::CustomProviderCapabilities,
    #[serde(default, rename = "groupDisplayZone", skip_serializing_if = "HashMap::is_empty")]
    pub group_display_zone: HashMap<String, String>,
    #[serde(default, rename = "configColumnCount", skip_serializing_if = "Option::is_none")]
    pub config_column_count: Option<u8>,
    #[serde(default, rename = "configColumnWidths", skip_serializing_if = "Vec::is_empty")]
    pub config_column_widths: Vec<f64>,
    #[serde(default, rename = "groupColumn", skip_serializing_if = "HashMap::is_empty")]
    pub group_column: HashMap<String, u32>,
    #[serde(default, rename = "aboveColumnWidths", skip_serializing_if = "Vec::is_empty")]
    pub above_column_widths: Vec<f64>,
    /// Per-environment build info captured from binary --version + file mtime.
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "buildInfoPerEnv")]
    pub build_info_per_env: HashMap<String, crate::types::BuildInfo>,
    /// Active launch path per profile (resolved).
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "binaryPathPerEnv")]
    pub binary_path_per_env: HashMap<String, String>,
    /// User preference: `foundry` | `bundled`.
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "binarySourcePerEnv")]
    pub binary_source_per_env: HashMap<String, String>,
    /// Per-environment downloaded release version — tracks which GitHub release tag was installed via update.
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "downloadedVersionPerEnv")]
    pub downloaded_version_per_env: HashMap<String, String>,
    /// Last cherry-picked PR number per environment (for badge display)
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "lastPrPerEnv")]
    pub last_pr_per_env: HashMap<String, String>,
    /// Display order in provider list (0 = first). Auto-assigned on save if not set.
    #[serde(default)]
    pub display_order: i32,
    /// True when the provider was discovered from runtime/ directory (bundled or downloaded).
    #[serde(default)]
    pub factory_provided: bool,
    /// Template version from default config — synced to user meta on merge.
    #[serde(default = "crate::types::default_template_version", rename = "templateVersion")]
    pub template_version: u32,
}

impl ProviderMeta {
    /// Convert a runtime ProviderConfig into persistence format (ProviderMeta).
    pub fn from_config(p: &ProviderConfig) -> Self {
        ProviderMeta {
            id: p.id.clone(),
            display_name: p.display_name.clone(),
            binary_path: to_relative_path(&PathBuf::from(&p.binary_path)),
            enabled: p.enabled,
            git_url: p.git_url.clone(),
            branch: p.branch.clone(),
            build_profile: p.build_profile.clone(),
            user_edited_template_params: p.user_edited_template_params.clone(),
            excluded_param_keys: p.excluded_param_keys.clone(),
            group_order: p.group_order.clone(),
            protected_groups: p.protected_groups.clone(),
            custom_capabilities: p.custom_capabilities.clone(),
            group_display_zone: p.group_display_zone.clone(),
            config_column_count: p.config_column_count,
            config_column_widths: p.config_column_widths.clone(),
            group_column: p.group_column.clone(),
            above_column_widths: p.above_column_widths.clone(),
            template_type: p.template_type.clone(),
            build_info_per_env: p.build_info_per_env.clone(),
            binary_path_per_env: p.binary_path_per_env.iter().map(|(k, v)| (k.clone(), to_relative_path(&PathBuf::from(v)))).collect(),
            binary_source_per_env: p.binary_source_per_env.clone(),
            downloaded_version_per_env: p.downloaded_version_per_env.clone(),
            last_pr_per_env: p.last_pr_per_env.clone(),
            display_order: p.display_order,
            factory_provided: p.factory_provided,
            template_version: p.template_version,
        }
    }
}

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

#[cfg(debug_assertions)]
fn dev_factory_default_config_source_path(provider_id: &str) -> Option<PathBuf> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("runtime")
        .join(provider_id)
        .join("config")
        .join(format!("{provider_id}-default-config.json"));
    if path.exists() {
        Some(path)
    } else {
        None
    }
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
    meta: &ProviderMeta,
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
pub fn load_user_providers_meta() -> Vec<ProviderMeta> {
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
            // Try loading as single ProviderMeta first, then fallback to array
            if let Ok(meta) = serde_json::from_str::<ProviderMeta>(&content) {
                metas.push(meta);
            } else if let Ok(arr) = serde_json::from_str::<Vec<ProviderMeta>>(&content) {
                // Legacy format: array in single file — migrate to individual files
                for m in arr {
                    let individual_path = provider_user_config_path(&m.id);
                    if !individual_path.exists() {
                        if let Ok(json) = serde_json::to_string_pretty(&m) {
                            let _ = std::fs::write(&individual_path, json);
                        }
                    }
                    metas.push(m);
                }
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
pub fn save_provider_user_config(meta: &ProviderMeta) -> Result<(), String> {
    std::fs::create_dir_all(config_dir()).map_err(|e| format!("Failed to create config dir: {}", e))?;

    let path = provider_user_config_path(&meta.id);
    let json = serde_json::to_string_pretty(meta).map_err(|e| format!("Serialization failed: {}", e))?;
    std::fs::write(&path, &json).map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;

    log::info!("[config] Saved user config for {} -> {}", meta.id, path.display());
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
        let meta = ProviderMeta::from_config(p);
        save_provider_user_config(&meta)?;
    }
    Ok(())
}

