// ── Model Path Management Commands ────────────────────────────────────
//!
//! Moved verbatim out of `main.rs`; bodies unchanged.

use std::sync::Arc;

#[tauri::command]
pub async fn list_model_paths(
    app_config: tauri::State<'_, Arc<std::sync::Mutex<crate::config::AppConfig>>>,
) -> Result<Vec<crate::types::ModelPathEntry>, String> {
    let cfg = app_config.lock().map_err(|e| e.to_string())?;
    Ok(crate::config::get_model_paths(&cfg))
}

#[tauri::command]
pub fn model_library_configured(
    app_config: tauri::State<'_, Arc<std::sync::Mutex<crate::config::AppConfig>>>,
) -> Result<bool, String> {
    let cfg = app_config.lock().map_err(|e| e.to_string())?;
    Ok(crate::config::model_library_configured(&cfg))
}

#[tauri::command]
pub fn validate_model_library(path: String) -> Result<crate::types::ModelLibraryValidation, String> {
    Ok(crate::config::validate_model_library(&path))
}

#[tauri::command]
pub async fn add_model_path(
    app_config: tauri::State<'_, Arc<std::sync::Mutex<crate::config::AppConfig>>>,
    path: String,
    label: Option<String>,
) -> Result<(), String> {
    let mut cfg = app_config.lock().map_err(|e| e.to_string())?;
    crate::config::add_model_path(&mut cfg, path, label);
    crate::config::save_config(&mut cfg).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn remove_model_path(
    app_config: tauri::State<'_, Arc<std::sync::Mutex<crate::config::AppConfig>>>,
    path: String,
) -> Result<(), String> {
    let mut cfg = app_config.lock().map_err(|e| e.to_string())?;
    crate::config::remove_model_path(&mut cfg, &path).map_err(|e| e.to_string())?;
    crate::config::save_config(&mut cfg).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn lmstudio_models_available() -> bool {
    crate::config::lm_studio_models_available()
}

#[tauri::command]
pub fn get_lm_studio_default_path() -> String {
    crate::config::lm_studio_default_path_display()
}

#[tauri::command]
pub async fn add_lmstudio_model_path(
    app_config: tauri::State<'_, Arc<std::sync::Mutex<crate::config::AppConfig>>>,
) -> Result<bool, String> {
    let mut cfg = app_config.lock().map_err(|e| e.to_string())?;
    let added = crate::config::add_lmstudio_model_path(&mut cfg)?;
    if added {
        crate::config::save_config(&mut cfg).map_err(|e| e.to_string())?;
    }
    Ok(added)
}

#[tauri::command]
pub async fn set_default_model_path(
    app_config: tauri::State<'_, Arc<std::sync::Mutex<crate::config::AppConfig>>>,
    path: String,
) -> Result<(), String> {
    let mut cfg = app_config.lock().map_err(|e| e.to_string())?;
    crate::config::set_default_model_path(&mut cfg, &path)?;
    crate::config::save_config(&mut cfg).map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub async fn get_disk_usage(
    app_config: tauri::State<'_, Arc<std::sync::Mutex<crate::config::AppConfig>>>,
) -> Result<Vec<crate::types::PathDiskUsage>, String> {
    let cfg = app_config.lock().map_err(|e| e.to_string())?;
    let paths = crate::config::get_model_paths(&cfg);
    Ok(crate::config::calculate_disk_usage(&paths))
}

#[tauri::command]
pub async fn get_default_download_path(
    app_config: tauri::State<'_, Arc<std::sync::Mutex<crate::config::AppConfig>>>,
) -> Result<String, String> {
    let cfg = app_config.lock().map_err(|e| e.to_string())?;
    Ok(crate::config::get_default_download_path(&cfg))
}
