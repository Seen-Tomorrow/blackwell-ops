// ── HF Search Commands ────────────────────────────────────────────────
//!
//! Moved verbatim out of `main.rs`; bodies unchanged.

use std::sync::Arc;

#[tauri::command]
pub async fn search_hf_models(
    query: String,
    vram_limit_gb: Option<u32>,
    sort: Option<String>,
    limit: Option<usize>,
) -> Result<crate::types::HfSearchResponse, String> {
    let filters = crate::config::normalize_hf_search_inputs(query, vram_limit_gb, sort, limit)?;
    let hf_token = crate::secrets::get_secret("hf_token")?;
    crate::hf_api::search_models(&filters, hf_token.as_deref()).await
}

#[tauri::command]
pub async fn get_hf_model_info(model_id: String) -> Result<crate::types::HfModelInfo, String> {
    crate::config::validate_hf_model_id(&model_id)?;
    let hf_token = crate::secrets::get_secret("hf_token")?;
    crate::hf_api::get_model_info(&model_id, hf_token.as_deref()).await
}

#[tauri::command]
pub async fn get_hf_quant_dates(
    model_id: String,
    paths: Vec<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    crate::config::validate_hf_model_id(&model_id)?;
    let hf_token = crate::secrets::get_secret("hf_token")?;
    crate::hf_api::fetch_quant_last_modified(&model_id, &paths, hf_token.as_deref()).await
}

#[tauri::command]
pub async fn check_hf_repo_updates(
    app_config: tauri::State<'_, Arc<std::sync::Mutex<crate::config::AppConfig>>>,
    model_id: String,
) -> Result<crate::types::HfRepoUpdateStatus, String> {
    crate::config::validate_hf_model_id(&model_id)?;
    let paths = {
        let cfg = app_config.lock().map_err(|e| e.to_string())?;
        crate::config::get_model_paths(&cfg)
    };
    let hf_token = crate::secrets::get_secret("hf_token")?;
    crate::hf_api::check_repo_for_updates(&model_id, &paths, hf_token.as_deref()).await
}

#[tauri::command]
pub async fn check_catalog_hf_updates(
    app_config: tauri::State<'_, Arc<std::sync::Mutex<crate::config::AppConfig>>>,
    only_path: Option<String>,
) -> Result<Vec<crate::types::CatalogUpdateEntry>, String> {
    let paths = {
        let cfg = app_config.lock().map_err(|e| e.to_string())?;
        crate::config::get_model_paths(&cfg)
    };
    let hf_token = crate::secrets::get_secret("hf_token")?;
    crate::hf_api::check_catalog_hf_updates(&paths, hf_token.as_deref(), only_path.as_deref()).await
}
