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
    log::debug!("[SAVE_PROVIDER] ENTER id='{}' param_count={}", provider.id, provider.param_definitions.len());
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

    for def in &mut save_provider.param_definitions {
        let existing_keys: std::collections::HashSet<String> = def.values.iter()
            .map(|v| serde_json::to_string(v).unwrap_or_default())
            .collect();
        for uv in def.user_added_values.clone().iter() {
            let uv_str = serde_json::to_string(uv).unwrap_or_default();
            if !existing_keys.contains(&uv_str) {
                def.values.push(uv.clone());
            }
        }
    }

    if save_provider.param_definitions.is_empty() {
        if let Some(tmpl_key) = crate::config::template_key_for_type(&save_provider.template_type) {
            save_provider.param_definitions = crate::config::params_for_provider(tmpl_key);
        }
    }

    if let Some(existing) = cfg.providers.iter_mut().find(|p| p.id == save_provider.id) {
        *existing = save_provider.clone();
    } else {
        cfg.providers.push(save_provider);
    }

    drop(cfg);

    let cfg_for_meta = app.config.lock().map_err(|e| e.to_string())?;
    crate::config::persist_provider_meta(&cfg_for_meta.providers)?;

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
    crate::config::persist_provider_meta(&cfg_for_meta.providers)?;

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
    for def in &prov.param_definitions {
        if def.ui_group == group_id {
            if !def.hidden {
                new_hidden = false;
                break;
            }
        }
    }

    // Flip: if any visible → hide all. If all hidden → unhide all.
    new_hidden = !new_hidden;

    for def in &mut prov.param_definitions {
        if def.ui_group == group_id {
            def.hidden = new_hidden;
        }
    }

    drop(cfg);

    // Persist to disk
    let cfg_for_meta = app.config.lock().map_err(|e| e.to_string())?;
    crate::config::persist_provider_meta(&cfg_for_meta.providers)?;

    Ok(new_hidden)
}
