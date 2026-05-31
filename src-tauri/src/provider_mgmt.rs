//! Provider management commands — CRUD for backend providers.
//!
//! Extracted from engine.rs for modularity.

use crate::engine::AppContext;

/// Persist a single provider's config to disk.
fn persist_single_provider(provider: &crate::types::ProviderConfig) -> Result<(), String> {
    let meta = crate::config::ProviderMeta::from_config(provider);
    crate::config::save_provider_user_config(&meta)
}

#[tauri::command]
pub async fn list_providers(app: tauri::State<'_, AppContext>) -> Result<Vec<crate::types::ProviderConfig>, String> {
    let providers = {
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        cfg.providers.clone()
    };

    Ok(providers)
}

#[tauri::command]
pub async fn save_provider(provider: crate::types::ProviderConfig, app: tauri::State<'_, AppContext>) -> Result<(), String> {
    log::debug!("[SAVE_PROVIDER] ENTER id='{}' param_count={}", provider.id, provider.user_edited_template_params.len());
    let mut cfg = app.config.lock().map_err(|e| e.to_string())?;

    if let Some(original_id) = &provider._original_id {
        if original_id != &provider.id {
            cfg.providers.retain(|p| p.id != *original_id);
        }
    }

    let mut save_provider = provider.clone();
    if save_provider.template_type.is_empty() {
        save_provider.template_type = crate::templates::ProviderTemplate::template_type_for_id(&save_provider.id);
    }

    for ep in &mut save_provider.user_edited_template_params {
        ep.ui_group = crate::config::normalize_ui_group(&ep.ui_group);
        let existing_keys: std::collections::HashSet<String> = ep.values.iter()
            .map(|v| serde_json::to_string(v).unwrap_or_default())
            .collect();
        for uv in ep.user_added_values.clone().iter() {
            let uv_str = serde_json::to_string(uv).unwrap_or_default();
            if !existing_keys.contains(&uv_str) && !uv_str.is_empty() {
                ep.values.push(uv.clone());
            }
        }
    }

    // Merge flag_pair from provider defaults for params missing it (schema migration)
    if let Some(tmpl_key) = crate::config::template_key_for_type(&save_provider.template_type) {
        let default_params = crate::config::params_for_provider(&tmpl_key);
        let defaults_map: std::collections::HashMap<&str, &crate::types::UserEditedTemplateParam> = default_params.iter()
            .map(|p| (p.key.as_str(), p))
            .collect();
        for ep in &mut save_provider.user_edited_template_params {
            if ep.flag_pair.is_empty() {
                if let Some(def) = defaults_map.get(ep.key.as_str()) {
                    ep.flag_pair = def.flag_pair.clone();
                }
            }
        }

        // Full schema evolution merge — backfill all structural fields from template
        save_provider.user_edited_template_params =
            crate::config::merge_template_into_user_params(&save_provider.template_type, &save_provider.user_edited_template_params);
    }

    save_provider.group_order = save_provider.group_order.iter().map(|g| crate::config::normalize_ui_group(g)).collect();

    if save_provider.user_edited_template_params.is_empty() {
        let user_config_path = crate::config::provider_user_config_path(&save_provider.id);
        if !user_config_path.exists() {
            // New provider — populate defaults (correct behavior)
            if let Some(tmpl_key) = crate::config::template_key_for_type(&save_provider.template_type) {
                save_provider.user_edited_template_params = crate::config::params_for_provider(&tmpl_key);
            }
        } else {
            // Existing provider sent empty params — likely a frontend bug. Restore from disk instead of wiping.
            log::warn!("[save_provider] {} sent 0 params but config exists — preserving existing", save_provider.id);
            if let Some(meta) = crate::config::load_user_providers_meta().iter().find(|m| m.id == save_provider.id) {
                save_provider.user_edited_template_params = meta.user_edited_template_params.clone();
            }
        }
    }

    let provider_id = save_provider.id.clone();

    if let Some(existing) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
        *existing = save_provider;
    } else {
        cfg.providers.push(save_provider);
    }

    // Persist only this provider's config (targeted write, not all providers)
    let updated = cfg.providers.iter().find(|p| p.id == provider_id).cloned();
    drop(cfg);

    if let Some(provider) = &updated {
        persist_single_provider(provider)?;
    }

    Ok(())
}

#[tauri::command]
pub async fn remove_provider(id: String, app: tauri::State<'_, AppContext>) -> Result<(), String> {
    let mut cfg = app.config.lock().map_err(|e| e.to_string())?;

    let before = cfg.providers.len();
    cfg.providers.retain(|p| p.id != id);

    if cfg.providers.len() == before {
        return Err(format!("Provider '{}' not found", id));
    }

    // Remove provider's user config file (targeted deletion)
    drop(cfg);
    crate::config::reset_provider_to_defaults(&id)?;

    Ok(())
}

/// Toggle `hidden` on every param belonging to a given UI group within a provider.
/// Returns the new hidden state (`true` = all hidden, `false` = all visible).
#[tauri::command]
pub async fn toggle_group_hidden(provider_id: String, group_id: String, app: tauri::State<'_, AppContext>) -> Result<bool, String> {
    let mut cfg = app.config.lock().map_err(|e| e.to_string())?;

    let prov = cfg.providers.iter_mut()
        .find(|p| p.id == provider_id)
        .ok_or(format!("Provider '{}' not found", provider_id))?;

    // Determine current state: if any param in the group is visible, we'll hide all. Otherwise unhide all.
    let mut new_hidden = true;
    for ep in &prov.user_edited_template_params {
        if ep.ui_group == group_id {
            if !ep.hidden {
                new_hidden = false;
                break;
            }
        }
    }

    // Flip: if any visible → hide all. If all hidden → unhide all.
    new_hidden = !new_hidden;

    for ep in &mut prov.user_edited_template_params {
        if ep.ui_group == group_id {
            ep.hidden = new_hidden;
        }
    }

    // Persist only this provider's config (targeted write)
    let updated_provider = cfg.providers.iter().find(|p| p.id == provider_id).cloned();
    drop(cfg);

    if let Some(provider) = &updated_provider {
        persist_single_provider(provider)?;
    }

    Ok(new_hidden)
}
