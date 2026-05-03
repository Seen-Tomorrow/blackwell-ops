//! Provider management commands — CRUD for backend providers.
//!
//! Extracted from engine.rs for modularity.

use crate::engine::AppContext;

/// Lists all registered backend providers with their binary paths.
#[tauri::command]
pub async fn list_providers(app: tauri::State<'_, AppContext>) -> Result<Vec<crate::types::ProviderConfig>, String> {
    let providers = {
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        cfg.providers.clone()
    };

    Ok(providers)
}

/// Adds or updates a backend provider in the config.
#[tauri::command]
pub async fn save_provider(provider: crate::types::ProviderConfig, app: tauri::State<'_, AppContext>) -> Result<(), String> {
    log::debug!("[SAVE_PROVIDER] ENTER id='{}' param_count={}", provider.id, provider.param_definitions.len());
    let mut cfg = app.config.lock().map_err(|e| e.to_string())?;

    // If editing and the ID changed, remove the old entry first.
    if let Some(original_id) = &provider._original_id {
        if original_id != &provider.id {
            cfg.providers.retain(|p| p.id != *original_id);
        }
    }

    // Determine template_type: use provided value or auto-detect from ID (case-insensitive)
    let mut save_provider = provider.clone();
    if save_provider.template_type.is_empty() {
        let lower_id = save_provider.id.to_lowercase();
        if lower_id.contains("ik") {
            save_provider.template_type = "ik-llama".to_string();
        } else {
            save_provider.template_type = "ggml-llama".to_string();
        }
    }

    // Merge user_added_values into values so build_command() picks them up
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

    // New provider with empty param_definitions — populate from correct template by type
    if save_provider.param_definitions.is_empty() {
        let tmpl_key = if save_provider.template_type == "ik-llama" || save_provider.id == "ik-extreme" { "ik-extreme" } else { "ggml-stable" };
        save_provider.param_definitions = crate::config::params_for_provider(tmpl_key);
    }

    // Check if provider with this (new) ID already exists — update in place or push new.
    if let Some(existing) = cfg.providers.iter_mut().find(|p| p.id == save_provider.id) {
        *existing = save_provider.clone();
    } else {
        cfg.providers.push(save_provider);
    }

    drop(cfg);

    // Persist param_definitions directly to provider_meta.json (no delta computation needed).
    let cfg_for_meta = app.config.lock().map_err(|e| e.to_string())?;
    crate::config::persist_provider_meta(&cfg_for_meta.providers)?;

    Ok(())
}

/// Removes a backend provider by ID.
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
