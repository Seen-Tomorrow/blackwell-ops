//! Provider discovery from disk + full config assembly + template-type resolution.

use chrono::{DateTime, Local};
use std::collections::HashMap;
use crate::config::*;
// ── Provider Defaults Loading (disk-based, replaces disk defaults) ─

/// Convert a ProviderDefaultParam from disk defaults into a UserEditedTemplateParam.
pub fn user_edited_param_from_template(tp: &crate::templates::ProviderDefaultParam, order: i32) -> crate::types::UserEditedTemplateParam {
    let sub_params = tp.sub_params.as_ref().and_then(|sp| {
        sp.as_object().map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| {
                    v.as_array().and_then(|arr| {
                        Some((k.clone(), arr.iter().filter_map(|el| el.as_str().map(String::from)).collect()))
                    })
                })
                .collect::<std::collections::HashMap<_, _>>()
        })
    });

    crate::types::UserEditedTemplateParam {
        key: tp.key.clone(),
        label: tp.label.clone(),
        values: tp.values.clone(),
        order,
        hidden: tp.hidden_default,
        user_hidden: false,
        hidden_values: Vec::new(),
        essentials_hidden_values: tp.essentials_hidden_values.clone(),
        flag: tp.flag.clone(),
        flag_pair: tp.flag_pair.clone(),
        ptype: tp.ptype.clone(),
        step: tp.step,
        ui_group: normalize_ui_group(&tp.ui_group),
        note: tp.note.clone(),
        pattern: tp.pattern.clone(),
        default_value: tp.default.clone(),
        user_added_values: Vec::new(),
        factory_default: tp.default.clone(),
        sub_params,
        dock: tp.dock.clone(),
        essential: None,
    }
}

/// Load params for a provider from its disk-based default config.
pub fn params_for_provider(provider_id: &str) -> Vec<crate::types::UserEditedTemplateParam> {
    if let Some(template) = crate::templates::load_provider_defaults(provider_id) {
        template.params.iter()
            .enumerate()
            .map(|(i, tp)| user_edited_param_from_template(tp, i as i32))
            .collect()
    } else {
        log::warn!("[config] No default config found for provider '{}', returning empty params", provider_id);
        Vec::new()
    }
}

/// Fresh-install provider table order — user `display_order` from CONFIG overrides after reorder.
pub fn factory_provider_rank(id: &str) -> i32 {
    match id {
        id if id == DEFAULT_PROVIDER_ID => 0,
        "ggml-tom" => 1,
        _ => 2,
    }
}

/// Discover providers from disk: scan runtime/ directory for default configs.
fn discover_providers() -> Vec<crate::types::ProviderConfig> {
    let mut providers = Vec::new();
    let app_root = app_root_dir();
    let binaries_dir = app_root.join("runtime");

    if !binaries_dir.exists() {
        log::warn!("[config] Runtime directory not found at {}", binaries_dir.display());
        return providers;
    }

    #[derive(serde::Deserialize)]
    struct ProviderIdentity {
        id: String,
        display_name: String,
        git_url: String,
        branch: String,
        template_type: String,
        #[serde(default)]
        build_profile: String,
        /// Template version — bumped in default config JSON when template changes.
        #[serde(default = "default_tv", rename = "templateVersion")]
        template_version: u32,
        /// Optional fork — templates via App update; engines via provider pack (not NSIS core).
        #[serde(default, rename = "optionalDownload")]
        optional_download: bool,
    }

    fn default_tv() -> u32 { 1 }

    for entry in std::fs::read_dir(&binaries_dir).into_iter().flatten().filter_map(|e| e.ok()) {
        if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            continue;
        }

        let pid = entry.file_name().to_string_lossy().to_string();
        if is_phased_out_provider(&pid) {
            continue;
        }
        let config_path = entry.path().join("config").join(format!("{}-default-config.json", pid));

        if !config_path.exists() {
            continue;
        }

        if let Ok(content) = std::fs::read_to_string(&config_path) {
            if let Ok(identity) = serde_json::from_str::<ProviderIdentity>(&content) {
                // Populate binary paths + build info from disk — check which profiles exist
                let mut per_env: HashMap<String, String> = HashMap::new();
                let mut build_info_per_env: HashMap<String, crate::types::BuildInfo> = HashMap::new();
                let mut main_binary = String::new();
                for profile in crate::foundry_toolchain::profile_ids_or_default() {
                    let exe_path = entry.path().join(&profile).join("llama-server.exe");
                    if exe_path.exists() {
                        per_env.insert(profile.to_string(), format!("runtime/{}/{}/llama-server.exe", pid, profile));
                        // Populate build_info from file metadata so UI shows profile as available
                        if let Ok(m) = std::fs::metadata(&exe_path) {
                            let date_str = m.modified().ok()
                                .map(|mt| DateTime::<Local>::from(mt).format("%Y-%m-%d %H:%M").to_string())
                                .unwrap_or_else(|| "unknown".to_string());
                            build_info_per_env.insert(profile.to_string(), crate::types::BuildInfo {
                                version: "disk-scanned".to_string(),
                                build_date: date_str,
                                cuda_version: None,
                                cuda_architectures: None,
                            });
                        }
                        let rel = format!("runtime/{}/{}/llama-server.exe", pid, profile);
                        if profile == DEFAULT_BINARY_PROFILE {
                            main_binary = rel;
                        } else if main_binary.is_empty() {
                            main_binary = rel;
                        }
                    }
                }

                // Catalog plugins: not in PROVIDERS until a pack (or Foundry) installs binaries.
                if identity.optional_download && per_env.is_empty() {
                    log::debug!(
                        "[config] Skipping catalog plugin '{}' (not installed — see UPDATES catalog)",
                        pid
                    );
                    continue;
                }

                let mut discovered = crate::types::ProviderConfig {
                    id: identity.id.clone(),
                    display_name: identity.display_name,
                    binary_path: main_binary,
                    enabled: true,
                    params: serde_json::json!({}),
                    user_edited_template_params: params_for_provider(&identity.id),
                    excluded_param_keys: Vec::new(),
                    group_order: Vec::new(),
                    protected_groups: Vec::new(),
                    custom_capabilities: crate::types::CustomProviderCapabilities::default(),
                    group_display_zone: HashMap::new(),
                    config_column_count: None,
                    config_column_widths: Vec::new(),
                    group_column: HashMap::new(),
                    above_column_widths: Vec::new(),
                    _original_id: None,
                    git_url: identity.git_url,
                    branch: identity.branch,
                    build_profile: identity.build_profile.clone(),
                    template_type: identity.template_type,
                    build_info_per_env,
                    binary_path_per_env: per_env,
                    binary_source_per_env: HashMap::new(),
                    bundled_binary_path_per_env: HashMap::new(),
                    foundry_binary_path_per_env: HashMap::new(),
                    catalog_binary_path_per_env: HashMap::new(),
                    bundled_build_info_per_env: HashMap::new(),
                    foundry_build_info_per_env: HashMap::new(),
                    catalog_build_info_per_env: HashMap::new(),
                    downloaded_version_per_env: std::collections::HashMap::new(),
                    last_pr_per_env: std::collections::HashMap::new(),
                    display_order: providers.len() as i32,
                    factory_provided: true,
                    optional_download: identity.optional_download,
                    template_version: identity.template_version,
                    needs_template_attention: false,
                    launch_profile: crate::templates::load_provider_defaults(&identity.id)
                        .map(|t| crate::types::LaunchProfile::from_spawn_profile(&t.spawn_profile))
                        .unwrap_or_default(),
                };
                apply_factory_layout_defaults(&mut discovered, &identity.id);
                providers.push(discovered);
            }
        }
    }

    providers.sort_by(|a, b| {
        factory_provider_rank(&a.id)
            .cmp(&factory_provider_rank(&b.id))
            .then_with(|| a.display_order.cmp(&b.display_order))
            .then_with(|| a.id.cmp(&b.id))
    });
    for (i, p) in providers.iter_mut().enumerate() {
        p.display_order = i as i32;
    }

    log::info!("[config] Discovered {} provider(s) from disk", providers.len());
    providers
}

/// True when the provider owns its param set (no factory family merge).
pub fn is_custom_template_type(template_type: &str) -> bool {
    let t = template_type.trim();
    t.is_empty() || t.eq_ignore_ascii_case("custom")
}

/// Map template_type to provider ID for loading defaults.
/// `custom` / empty → None (no master param pack).
pub fn template_key_for_type(template_type: &str) -> Option<String> {
    if is_custom_template_type(template_type) {
        return None;
    }
    match template_type {
        "ggml-llama" => Some(DEFAULT_PROVIDER_ID.to_string()),
        _ => None,
    }
}

/// Resolve effective template type: use disk value if set, otherwise auto-detect from provider ID.
/// Explicit custom is preserved (never rewritten to ggml-llama).
pub fn resolve_template_type(provider_id: &str, disk_type: Option<&String>) -> String {
    match disk_type {
        Some(t) if is_custom_template_type(t) => "custom".to_string(),
        Some(t) if !t.is_empty() => t.clone(),
        _ => crate::templates::ProviderTemplate::template_type_for_id(provider_id),
    }
}

/// Backfill dock fields from provider defaults into user-edited params.
pub fn build_config_with_providers_full(mut config: AppConfig) -> AppConfig {
    let metas: Vec<ProviderMeta> = load_user_providers_meta()
        .into_iter()
        .filter(|m| !should_drop_user_meta(m))
        .collect();

    let meta_map: std::collections::HashMap<_, _> = metas.iter()
        .map(|m| (m.id.clone(), m))
        .collect();
    let metas_clone = metas.clone();

    let mut providers = Vec::new();

    // Disk-based provider discovery replaces disk-based discovery
    for provider in discover_providers() {
        let mut p = provider;
        if let Some(meta) = meta_map.get(&p.id) {
            if !meta.binary_path.is_empty() { p.binary_path = meta.binary_path.clone(); }
            if !meta.display_name.is_empty() { p.display_name = meta.display_name.clone(); }
            if !meta.git_url.is_empty() { p.git_url = meta.git_url.clone(); }
            if !meta.branch.is_empty() { p.branch = meta.branch.clone(); }
            if !meta.build_profile.is_empty() { p.build_profile = meta.build_profile.clone(); }

            let effective_template_type = if !meta.template_type.is_empty() {
                meta.template_type.clone()
            } else {
                p.template_type.clone()
            };

            if !meta.user_edited_template_params.is_empty() {
                p.user_edited_template_params = merge_template_for_provider(
                    &p.id,
                    &effective_template_type,
                    true,
                    &meta.user_edited_template_params,
                    &meta.excluded_param_keys,
                );
            }

            // Template version mismatch → set attention flag for UI banner.
            // Merge already applied; banner is advisory — save syncs version or user hits RESET.
            let factory_tv =
                factory_template_version_for_provider(&p.id, &effective_template_type, true);
            p.template_version = factory_tv;
            if meta.template_version != factory_tv {
                log::info!(
                    "[config] Provider '{}' template version changed: user={}, factory={}",
                    p.id,
                    meta.template_version,
                    factory_tv
                );
                p.needs_template_attention = true;
            }
            // Active binary paths + build info resolved after meta merge (see resolve_provider_binaries_from_meta).
            let factory_key = resolve_merge_template_key(&p.id, &effective_template_type, true)
                .unwrap_or_else(|| p.id.clone());
            apply_meta_layout_overrides(&mut p, meta, &factory_key);
            if !meta.last_pr_per_env.is_empty() {
                p.last_pr_per_env = meta.last_pr_per_env.clone();
            }
            // Always override — user's explicit choice survives restart
            p.enabled = meta.enabled;
            p.display_order = meta.display_order;
            if !meta.template_type.is_empty() {
                p.template_type = meta.template_type.clone();
            }
            p.excluded_param_keys = meta.excluded_param_keys.clone();
            p.custom_capabilities = meta.custom_capabilities.clone();
            if !meta.above_column_widths.is_empty() {
                p.above_column_widths = meta.above_column_widths.clone();
            }
        }
        let pid = p.id.clone();
        resolve_provider_binaries_from_meta(&mut p, meta_map.get(&pid).copied());
        if let Some(tmpl) = crate::templates::load_provider_defaults(&p.id) {
            p.launch_profile = crate::types::LaunchProfile::from_spawn_profile(&tmpl.spawn_profile);
        }
        providers.push(p);
    }

    // Custom/user-created providers not found in runtime/ defaults
    for meta in metas_clone {
        if should_drop_user_meta(&meta) {
            continue;
        }
        if !providers.iter().any(|p| p.id == meta.id) {
            let resolved_type = resolve_template_type(&meta.id, Some(&meta.template_type));
            let tmpl_key = template_key_for_type(&resolved_type);
        let user_edited_params = if !meta.user_edited_template_params.is_empty() {
                merge_template_for_provider(
                    &meta.id,
                    &resolved_type,
                    false,
                    &meta.user_edited_template_params,
                    &meta.excluded_param_keys,
                )
            } else if let Some(ref key) = tmpl_key {
                params_for_provider(key)
            } else {
                Vec::new()  // custom type, no template
            };

            // Compare versions against fresh template if one exists
            let (factory_tv, tv_changed) = if let Some(ref key) = tmpl_key {
                let factory_v = crate::templates::get_template_version_for_provider(key);
                (factory_v, factory_v != meta.template_version)
            } else {
                (meta.template_version, false)
            };

            let factory_key = tmpl_key.clone().unwrap_or_else(|| meta.id.clone());
            let mut custom = crate::types::ProviderConfig {
                id: meta.id.clone(),
                display_name: meta.display_name.clone(),
                binary_path: meta.binary_path.clone(),
                enabled: meta.enabled,
                params: serde_json::json!({}),
                user_edited_template_params: user_edited_params,
                excluded_param_keys: meta.excluded_param_keys.clone(),
                group_order: Vec::new(),
                protected_groups: Vec::new(),
                custom_capabilities: meta.custom_capabilities.clone(),
                group_display_zone: HashMap::new(),
                config_column_count: None,
                config_column_widths: Vec::new(),
                group_column: HashMap::new(),
                above_column_widths: meta.above_column_widths.clone(),
                _original_id: None,
                git_url: meta.git_url.clone(),
                branch: meta.branch.clone(),
                build_profile: meta.build_profile.clone(),
                template_type: resolved_type,
                build_info_per_env: HashMap::new(),
                binary_path_per_env: HashMap::new(),
                binary_source_per_env: meta.binary_source_per_env.clone(),
                bundled_binary_path_per_env: HashMap::new(),
                foundry_binary_path_per_env: HashMap::new(),
                catalog_binary_path_per_env: HashMap::new(),
                bundled_build_info_per_env: HashMap::new(),
                foundry_build_info_per_env: HashMap::new(),
                catalog_build_info_per_env: HashMap::new(),
                downloaded_version_per_env: meta.downloaded_version_per_env.clone(),
                last_pr_per_env: meta.last_pr_per_env.clone(),
                display_order: meta.display_order,
                factory_provided: false,
                optional_download: false,
                template_version: if tv_changed { factory_tv } else { meta.template_version },
                needs_template_attention: tv_changed,
                launch_profile: tmpl_key
                    .as_ref()
                    .and_then(|key| crate::templates::load_provider_defaults(key))
                    .map(|t| crate::types::LaunchProfile::from_spawn_profile(&t.spawn_profile))
                    .unwrap_or_default(),
            };
            apply_meta_layout_overrides(&mut custom, &meta, &factory_key);
            resolve_provider_binaries_from_meta(&mut custom, Some(&meta));
            // Custom: launch_profile stays empty (no Full Auto); caps live on custom_capabilities.
            if is_custom_template_type(&custom.template_type) {
                custom.custom_capabilities = meta.custom_capabilities.clone();
            }
            providers.push(custom);
        }
    }

    providers.sort_by(|a, b| a.display_order.cmp(&b.display_order).then_with(|| a.id.cmp(&b.id)));
    for (i, p) in providers.iter_mut().enumerate() {
        p.display_order = i as i32;
    }

    config.providers = providers;

    config
}

/// Re-scan runtime/ and merge user meta — after plugin pack install without app restart.
pub fn refresh_providers_from_disk(config: &mut AppConfig) {
    let snapshot = config.clone();
    *config = build_config_with_providers_full(snapshot);
}
