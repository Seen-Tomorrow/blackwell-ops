//! Provider management commands — CRUD for backend providers.
//!
//! Extracted from engine.rs for modularity.

use crate::engine::AppContext;

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
        let lower_id = save_provider.id.to_lowercase();
        if lower_id.contains("ik") {
            save_provider.template_type = "ik-llama".to_string();
        } else {
            save_provider.template_type = "ggml-llama".to_string();
        }
    }

    for ep in &mut save_provider.user_edited_template_params {
        ep.ui_group = crate::config::normalize_ui_group(&ep.ui_group);
        let existing_keys: std::collections::HashSet<String> = ep.values.iter()
            .map(|v| serde_json::to_string(v).unwrap_or_default())
            .collect();
        for uv in ep.user_added_values.clone().iter() {
            let uv_str = serde_json::to_string(uv).unwrap_or_default();
            if !existing_keys.contains(&uv_str) {
                ep.values.push(uv.clone());
            }
        }
    }

    // Merge flag_pair from genesis template for params missing it (schema migration)
    if let Some(tmpl_key) = crate::config::template_key_for_type(&save_provider.template_type) {
        let genesis_params = crate::config::params_for_provider(tmpl_key);
        let genesis_map: std::collections::HashMap<&str, &crate::types::UserEditedTemplateParam> = genesis_params.iter()
            .map(|p| (p.key.as_str(), p))
            .collect();
        for ep in &mut save_provider.user_edited_template_params {
            if ep.flag_pair.is_empty() {
                if let Some(genesis) = genesis_map.get(ep.key.as_str()) {
                    ep.flag_pair = genesis.flag_pair.clone();
                }
            }
        }
    }

    save_provider.group_order = save_provider.group_order.iter().map(|g| crate::config::normalize_ui_group(g)).collect();

    if save_provider.user_edited_template_params.is_empty() {
        if let Some(tmpl_key) = crate::config::template_key_for_type(&save_provider.template_type) {
            save_provider.user_edited_template_params = crate::config::params_for_provider(tmpl_key);
        }
    }

    if let Some(existing) = cfg.providers.iter_mut().find(|p| p.id == save_provider.id) {
        *existing = save_provider.clone();
    } else {
        cfg.providers.push(save_provider);
    }

    drop(cfg);

    let cfg_for_meta = app.config.lock().map_err(|e| e.to_string())?;
    crate::config::persist_user_providers_meta(&cfg_for_meta.providers)?;

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

    drop(cfg);

    // Persist provider metadata to disk
    let cfg_for_meta = app.config.lock().map_err(|e| e.to_string())?;
    crate::config::persist_user_providers_meta(&cfg_for_meta.providers)?;

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

    drop(cfg);

    // Persist to disk
    let cfg_for_meta = app.config.lock().map_err(|e| e.to_string())?;
    crate::config::persist_user_providers_meta(&cfg_for_meta.providers)?;

    Ok(new_hidden)
}
