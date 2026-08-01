//! App-config load/save, provider reorder, and reset/setup commands.

use crate::config::*;
// ── Config Loading ───────────────────────────────────────────────────

/// Internal: Load config with bundled path resolution (called from setup).
pub fn load_config_with_app(_app_handle: &tauri::AppHandle) -> AppConfig {
    if let Some(saved) = load_saved_config() {
        build_config_with_providers_full(saved)
    } else {
        let fresh = build_fresh_config();
        let mut to_persist = fresh.clone();
        if let Err(e) = save_config(&mut to_persist) {
            log::warn!("[config] Failed to persist default app_config.json: {}", e);
        } else {
            log::info!("[config] Created default app_config.json with model path '{}'", DEFAULT_MODEL_PATH_REL);
        }
        build_config_with_providers_full(fresh)
    }
}

/// Tauri command: Load config from disk (no app handle needed for frontend queries).
#[tauri::command]
pub fn load_config() -> AppConfig {
    if let Some(saved) = load_saved_config() {
        return build_config_with_providers_full(saved);
    }

    let fresh = build_fresh_config();
    let mut to_persist = fresh.clone();
    if let Err(e) = save_config(&mut to_persist) {
        log::warn!("[config] Failed to persist default app_config.json: {}", e);
    }
    build_config_with_providers_full(fresh)
}


#[tauri::command]
pub async fn reorder_provider(provider_id: String, direction: i32, app: tauri::State<'_, crate::engine::AppContext>) -> Result<(), String> {
    let mut cfg = app.config.lock().map_err(|e| e.to_string())?;
    let idx = cfg.providers.iter().position(|p| p.id == provider_id).ok_or("Provider not found")?;
    let new_idx = (idx as i32).saturating_add(direction) as usize;
    if new_idx >= cfg.providers.len() { return Ok(()); }
    cfg.providers.swap(idx, new_idx);
    for (i, p) in cfg.providers.iter_mut().enumerate() { p.display_order = i as i32; }
    let mut metas = load_user_providers_meta();
    for m in &mut metas { if let Some(p) = cfg.providers.iter().find(|p| p.id == m.id) { m.display_order = p.display_order; } }
    save_user_providers_meta(metas)?;
    Ok(())
}

#[tauri::command]
pub fn reset_param_to_template(provider_id: String, param_key: String) -> Result<crate::types::UserEditedTemplateParam, String> {
    // Load provider from disk to get template_type (auto-detect from ID if empty)
    let metas = load_user_providers_meta();
    let meta = metas.iter().find(|m| m.id == provider_id);
    let template_type = resolve_template_type(&provider_id, meta.map(|m| &m.template_type));

    let Some(template_key) = template_key_for_type(&template_type) else {
        return Err(format!("No provider default config for type '{}' — cannot restore param", template_type));
    };

    let template = crate::templates::load_provider_defaults(&template_key).ok_or("Unknown provider")?;
    let order = template.params.iter()
        .position(|p| p.key == param_key)
        .ok_or_else(|| format!("Param '{}' not found in template", param_key))? as i32;
    
    let tp = template.params.iter().find(|p| p.key == param_key).unwrap();
    Ok(user_edited_param_from_template(tp, order))
}

/// Delete provider's user config file so it regenerates from fresh factory template on next load.
/// Called by frontend RESET TO DEFAULTS button — instant recovery to 1:1 with factory state.
/// Dev/testing: reset first-run fields (model paths → default `models/`), clear GGUF cache,
/// re-discover bundled providers, persist, and sync in-memory config (webview reload ≠ Rust restart).
#[tauri::command]
pub fn dev_reset_first_run(
    _config: tauri::State<'_, std::sync::Arc<std::sync::Mutex<AppConfig>>>,
) -> Result<(), String> {
    #[cfg(not(debug_assertions))]
    {
        return Err("dev_reset_first_run is only available in debug builds".to_string());
    }
    #[cfg(debug_assertions)]
    {
        crate::model_cache::clear_cache()?;

        let hf_token = {
            let cfg = _config.lock().map_err(|e| e.to_string())?;
            cfg.hf_token.clone()
        };

        let mut fresh = build_fresh_config();
        fresh.hf_token = hf_token;
        fresh.setup_completed = false;

        let built = build_config_with_providers_full(fresh);

        let provider_count = built.providers.len();
        let mut to_persist = built.clone();
        save_config(&mut to_persist)?;

        {
            let mut cfg = _config.lock().map_err(|e| e.to_string())?;
            *cfg = built;
        }
        let _ = std::fs::create_dir_all(default_models_dir());
        log::info!(
            "[config] dev_reset_first_run: paths reset, cache cleared, {provider_count} provider(s) rediscovered",
        );
        Ok(())
    }
}

/// Portable config folder path for UI (e.g. CONFIG → RECOVERY).
#[tauri::command]
pub fn get_config_dir() -> String {
    config_dir().to_string_lossy().to_string()
}

#[tauri::command]
pub fn is_setup_completed(
    config: tauri::State<'_, std::sync::Arc<std::sync::Mutex<AppConfig>>>,
) -> Result<bool, String> {
    let cfg = config.lock().map_err(|e| e.to_string())?;
    Ok(cfg.setup_completed)
}

#[tauri::command]
pub fn mark_setup_completed(
    config: tauri::State<'_, std::sync::Arc<std::sync::Mutex<AppConfig>>>,
) -> Result<(), String> {
    let mut cfg = config.lock().map_err(|e| e.to_string())?;
    if cfg.setup_completed {
        return Ok(());
    }
    cfg.setup_completed = true;
    save_config(&mut cfg)?;
    log::info!("[config] setup_completed persisted");
    Ok(())
}

fn remove_user_provider_configs() -> Result<usize, String> {
    let cd = config_dir();
    if !cd.exists() {
        return Ok(0);
    }
    let mut removed = 0usize;
    for entry in std::fs::read_dir(&cd).into_iter().flatten() {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let file_name = name.to_string_lossy();
        if file_name.ends_with("-user-config.json") {
            std::fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn clear_config_cache_dir() -> Result<(), String> {
    let dir = cache_dir();
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        return Ok(());
    }
    for entry in std::fs::read_dir(&dir).into_iter().flatten() {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            std::fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
        } else {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Reset portable `config/` to factory defaults — available in release builds.
/// Model files, foundry artifacts, and runtime binaries are untouched.
#[tauri::command]
pub fn reset_app_config(
    config: tauri::State<'_, std::sync::Arc<std::sync::Mutex<AppConfig>>>,
) -> Result<(), String> {
    let hf_token = {
        let cfg = config.lock().map_err(|e| e.to_string())?;
        cfg.hf_token.clone()
    };

    let removed_configs = remove_user_provider_configs()?;
    clear_config_cache_dir()?;
    crate::model_cache::clear_cache()?;

    let mut fresh = build_fresh_config();
    fresh.hf_token = hf_token;
    fresh.setup_completed = false;

    let built = build_config_with_providers_full(fresh);

    let provider_count = built.providers.len();
    let mut to_persist = built.clone();
    save_config(&mut to_persist)?;

    {
        let mut cfg = config.lock().map_err(|e| e.to_string())?;
        *cfg = built;
    }
    let _ = std::fs::create_dir_all(default_models_dir());
    log::info!(
        "[config] reset_app_config: removed {removed_configs} user config(s), cache cleared, {provider_count} provider(s) rediscovered",
    );
    Ok(())
}

pub fn save_config(config: &mut AppConfig) -> Result<(), String> {
    sanitize_model_paths(config);
    let config_directory = config_dir();
    std::fs::create_dir_all(&config_directory).map_err(|e| format!("Failed to create config dir: {}", e))?;

    let config_path = config_directory.join("app_config.json");
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize app config: {}", e))?;

    std::fs::write(&config_path, json).map_err(|e| format!("Failed to write app config: {}", e))?;
    log::debug!("Saved app_config.json to {}", config_path.display());
    Ok(())
}

fn build_fresh_config() -> AppConfig {
    AppConfig::default()
}

fn load_saved_config() -> Option<AppConfig> {
    let config_path = config_dir().join("app_config.json");
    if config_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&config_path) {
            if let Ok(mut config) = serde_json::from_str::<AppConfig>(&content) {
                // Sanitize: dedupe paths, ensure at most one default, sync default_download_path
                let dirty = sanitize_model_paths(&mut config);
                if dirty {
                    if let Err(e) = save_config(&mut config) {
                        log::warn!("[config] Failed to auto-save deduped model paths: {}", e);
                    } else {
                        log::info!("[config] Auto-saved deduped model paths");
                    }
                }
                log::info!("Loaded app_config.json from {}", config_path.display());
                return Some(config);
            }
        }
    }
    None
}

/// Ensure model paths are consistent: deduped, at most one default, default_download_path synced.
/// Returns true if the config was modified.
pub fn sanitize_model_paths(config: &mut AppConfig) -> bool {
    let mut changed = dedupe_model_paths(&mut config.model_paths);

    // Ensure at most one default flag
    let mut found_default = false;
    for p in &mut config.model_paths {
        if p.is_default {
            if found_default {
                p.is_default = false;
                changed = true;
            } else {
                found_default = true;
            }
        }
    }

    // No default flagged — recover from memo, then first entry
    if !found_default {
        if let Some(ref memo) = config.default_download_path {
            if let Some(idx) = find_model_path_index(&config.model_paths, memo) {
                config.model_paths[idx].is_default = true;
                found_default = true;
                changed = true;
            }
        }
        if !found_default && !config.model_paths.is_empty() {
            config.model_paths[0].is_default = true;
            changed = true;
        }
    }

    let new_memo = config.model_paths.iter()
        .find(|p| p.is_default)
        .map(|p| p.path.clone());
    if config.default_download_path != new_memo {
        config.default_download_path = new_memo;
        changed = true;
    }

    changed
}
