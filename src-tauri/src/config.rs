use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::types::{ModelPathEntry, PathDiskUsage, ProviderConfig};

pub const MAX_ENGINE_SLOTS: usize = 16;

/// Returns the app config directory path.
/// Dev builds use "blackwell-ops-dev" to isolate from release configs.
fn blackwell_config_dir() -> std::path::PathBuf {
    let name = if cfg!(debug_assertions) {
        "blackwell-ops-dev"
    } else {
        "blackwell-ops"
    };
    dirs::config_dir().unwrap().join(name)
}

/// Normalize a UI group name to uppercase-hyphen format (e.g. "Speculative Decoding" → "SPECULATIVE-DECODING")
pub fn normalize_ui_group(raw: &str) -> String {
    raw.trim()
        .to_uppercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<&str>>()
        .join("-")
}

// ── Provider Metadata (persisted to disk) ───────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderMeta {
    pub id: String,
    pub display_name: String,
    pub binary_path: String,
    #[serde(default = "default_true")]
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
    /// Custom group order set by user (overrides template insertion order). Empty = use template order.
    #[serde(default, rename = "groupOrder")]
    pub group_order: Vec<String>,
    /// Per-environment build info captured from binary --version + file mtime.
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "buildInfoPerEnv")]
    pub build_info_per_env: HashMap<String, crate::types::BuildInfo>,
    /// Per-environment binary paths — each env builds into its own directory (build-vanguard/bin/Release, etc.).
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "binaryPathPerEnv")]
    pub binary_path_per_env: HashMap<String, String>,
    /// Last cherry-picked PR number per environment (for badge display)
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "lastPrPerEnv")]
    pub last_pr_per_env: HashMap<String, String>,
    /// Display order in provider list (0 = first). Auto-assigned on save if not set.
    #[serde(default)]
    pub display_order: i32,
}

fn default_true() -> bool { true }
fn default_providers() -> Vec<ProviderConfig> { Vec::new() }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub llama_path: PathBuf,
    pub model_base: PathBuf,
    #[serde(default)]
    pub model_paths: Vec<ModelPathEntry>,
    pub prefs_file: PathBuf,
    pub base_port: u16,
    #[serde(default)]
    pub gpu_slots: usize,
    #[serde(default = "default_providers")]
    pub providers: Vec<ProviderConfig>,
}

impl Default for AppConfig {
    fn default() -> Self {
        let app_dir = Some(blackwell_config_dir().join("models"));
        let default_path = app_dir.as_ref().map(|p| p.to_string_lossy().to_string());

        let mut model_paths: Vec<ModelPathEntry> = Vec::new();

        if let Some(ref p) = default_path {
            model_paths.push(ModelPathEntry {
                path: p.clone(),
                label: "Default".to_string(),
                is_default: true,
            });
        }

        if let Some(lm_path) = dirs::home_dir().map(|h| h.join(".lmstudio").join("models")).and_then(|p| {
            if p.exists() { Some(p) } else { None }
        }) {
            model_paths.push(ModelPathEntry {
                path: lm_path.to_string_lossy().to_string(),
                label: ".lmstudio/models".to_string(),
                is_default: false,
            });
        }

        Self {
            llama_path: PathBuf::from(r"C:\reactor_foundry\engines\ggml-stable\llama.cpp\build\bin\Release\llama-server.exe"),
            model_base: default_path.map(PathBuf::from).unwrap_or_default(),
            model_paths,
            prefs_file: PathBuf::new(),
            base_port: 9090,
            gpu_slots: MAX_ENGINE_SLOTS,
            providers: Vec::new(),
        }
    }
}

const USER_PROVIDERS_CONFIG_FILE: &str = "user_providers_config.json";

// ── Provider Metadata Persistence ───────────────────────────────────

pub fn load_user_providers_meta() -> Vec<ProviderMeta> {
    let config_path = blackwell_config_dir().join(USER_PROVIDERS_CONFIG_FILE);
    if config_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&config_path) {
            if let Ok(metas) = serde_json::from_str::<Vec<ProviderMeta>>(&content) {
                log::info!("Loaded {} provider(s) from {}", metas.len(), config_path.display());
                return metas;
            }
        }
    }
    Vec::new()
}

fn json_val_eq(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    serde_json::to_string(a).ok() == serde_json::to_string(b).ok()
}

fn validate_user_edited_param(ep: &crate::types::UserEditedTemplateParam) -> Vec<String> {
    let mut errors = Vec::new();

    if ep.key.is_empty() {
        errors.push("key is empty".to_string());
    }

    // values[] must be string or number
    for (i, v) in ep.values.iter().enumerate() {
        match v {
            serde_json::Value::String(_) | serde_json::Value::Number(_) => {}
            _ => errors.push(format!("values[{}] must be string or number, got {:?}", i, v)),
        }
    }

    // No duplicate values
    for i in 0..ep.values.len() {
        for j in (i + 1)..ep.values.len() {
            if json_val_eq(&ep.values[i], &ep.values[j]) {
                errors.push(format!("duplicate value {:?} at indices {} and {}", &ep.values[i], i, j));
                break;
            }
        }
    }

    // defaultValue type must match one of values
    if !ep.default_value.is_null() && !ep.values.is_empty() {
        let mut found = false;
        for v in &ep.values {
            if json_val_eq(&v, &ep.default_value) {
                found = true;
                break;
            }
        }
        if !found {
            errors.push(format!("defaultValue ({:?}) type does not match any value in values array", ep.default_value));
        }
    }

    // Valid ptype
    static VALID_PTYPES: [&str; 8] = [
        "arg_select", "arg_select_double", "mapper", "switch_onoff", "switch_inverted", "path_scanner", "logic_only", "",
    ];
    if !VALID_PTYPES.contains(&ep.ptype.as_str()) {
        errors.push(format!("invalid ptype '{}' (valid: {:?})", ep.ptype, VALID_PTYPES));
    }

    // flag required for arg_select/mapper, flag_pair for arg_select_double
    let needs_flag = ep.ptype == "arg_select" || ep.ptype == "mapper";
    if needs_flag && ep.flag.as_deref().map_or(true, |s| s.is_empty()) {
        errors.push(format!("ptype '{}' requires a non-empty flag", ep.ptype));
    }
    if ep.ptype == "arg_select_double" && ep.flag_pair.len() != 2 {
        errors.push(format!("ptype 'arg_select_double' requires exactly 2 entries in flag_pair"));
    }

    // hiddenValues must be subset of values
    for hv in &ep.hidden_values {
        let found = ep.values.iter().any(|v| json_val_eq(v, hv));
        if !found {
            errors.push(format!("hiddenValue {:?} is not in values array", hv));
        }
    }

    // sub_params: each value must be string[], no empty strings
    if let Some(ref sp) = ep.sub_params {
        for (k, args) in sp {
            for (i, arg) in args.iter().enumerate() {
                if arg.is_empty() {
                    errors.push(format!("sub_params['{}'][{}] is empty string", k, i));
                }
            }
        }
    }

    errors
}

fn check_user_providers_meta(metas: &[ProviderMeta]) -> Vec<String> {
    let mut all_errors: Vec<String> = Vec::new();

    // Duplicate provider IDs
    let mut seen_ids: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for meta in metas {
        if !seen_ids.insert(&meta.id) {
            all_errors.push(format!("duplicate provider id: '{}'", meta.id));
        }

        // Duplicate param keys within this provider
        let mut seen_keys: std::collections::HashMap<&str, i32> = std::collections::HashMap::new();
        for ep in &meta.user_edited_template_params {
            if let Some(&prev_order) = seen_keys.get(ep.key.as_str()) {
                all_errors.push(format!(
                    "provider '{}': duplicate param key '{}' (order {} and {})",
                    meta.id, ep.key, prev_order, ep.order
                ));
            } else {
                seen_keys.insert(&ep.key, ep.order);
            }

            // Validate each UserEditedTemplateParam
            for e in validate_user_edited_param(ep) {
                all_errors.push(format!("provider '{}' param '{}': {}", meta.id, ep.key, e));
            }
        }
    }

    all_errors
}

#[tauri::command]
pub fn save_user_providers_meta(metas: Vec<ProviderMeta>) -> Result<(), String> {
    // Block-save validation — force user to correct manually
    let errors = check_user_providers_meta(&metas);
    if !errors.is_empty() {
        return Err(format!("user_providers_config.json has {} issue(s):\n{}", errors.len(), errors.join("\n")));
    }

    let blackwell_dir = blackwell_config_dir();
    std::fs::create_dir_all(&blackwell_dir).map_err(|e| format!("Failed to create config dir: {}", e))?;

    let config_path = blackwell_dir.join(USER_PROVIDERS_CONFIG_FILE);
    let json = serde_json::to_string_pretty(&metas)
        .map_err(|e| format!("Failed to serialize provider meta: {}", e))?;

    std::fs::write(&config_path, json).map_err(|e| format!("Failed to write provider meta: {}", e))?;
    log::debug!("Saved {} provider(s) to {}", metas.len(), config_path.display());
    Ok(())
}

#[tauri::command]
pub fn validate_user_providers_meta() -> Result<Vec<String>, String> {
    let metas = load_user_providers_meta();
    if metas.is_empty() {
        return Ok(Vec::new());
    }
    let errors = check_user_providers_meta(&metas);
    Ok(errors)
}

pub fn persist_user_providers_meta(providers: &[crate::types::ProviderConfig]) -> Result<(), String> {
    let metas: Vec<ProviderMeta> = providers.iter().map(|p| ProviderMeta {
        id: p.id.clone(),
        display_name: if p.display_name.is_empty() { "Untitled".to_string() } else { p.display_name.clone() },
        binary_path: p.binary_path.clone(),
        enabled: p.enabled,
        git_url: p.git_url.clone(),
        branch: p.branch.clone(),
        build_profile: p.build_profile.clone(),
        user_edited_template_params: if p.user_edited_template_params.is_empty() {
            Vec::new()
        } else {
            p.user_edited_template_params.clone()
        },
        group_order: p.group_order.clone(),
        template_type: p.template_type.clone(),
        display_order: p.display_order,
        build_info_per_env: p.build_info_per_env.clone(),
        binary_path_per_env: p.binary_path_per_env.clone(),
        last_pr_per_env: p.last_pr_per_env.clone(),
    }).collect();
    save_user_providers_meta(metas)
}

// ── Legacy Migration ─────────────────────────────────────────────────

fn load_legacy_user_providers_meta() -> Vec<ProviderMeta> {
    let config_path = blackwell_config_dir().join("admin_template.json");
    if config_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&config_path) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(providers) = parsed.get("providers").and_then(|p| p.as_array()) {
                    let mut metas = Vec::new();
                    for prov in providers {
                        if let (Some(id), Some(display_name)) = (
                            prov.get("id").and_then(|v| v.as_str()),
                            prov.get("display_name").and_then(|v| v.as_str()),
                        ) {
                            metas.push(ProviderMeta {
                                id: id.to_string(),
                                display_name: display_name.to_string(),
                                binary_path: prov.get("binary_path").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                enabled: prov.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true),
                                git_url: prov.get("git_url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                branch: prov.get("branch").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                build_profile: prov.get("build_profile").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                user_edited_template_params: Vec::new(),
                                group_order: Vec::new(),
                                template_type: crate::templates::ProviderTemplate::template_type_for_id(id),
                                display_order: 0,
                                build_info_per_env: HashMap::new(),
                                binary_path_per_env: HashMap::new(),
                                last_pr_per_env: HashMap::new(),
                            });
                        }
                    }
                    if !metas.is_empty() {
                        log::info!("Migrated {} provider(s) from legacy admin_template.json", metas.len());
                        return metas;
                    }
                }
            }
        }
    }
    Vec::new()
}

// ── Genesis Providers (factory defaults from embedded template) ─────

fn user_edited_param_from_template(tp: &crate::templates::GenesisTemplateParam, order: i32) -> crate::types::UserEditedTemplateParam {
    // Convert sub_params from serde_json::Value to HashMap<String, Vec<String>>
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
        hidden_values: Vec::new(),
        flag: tp.flag.clone(),
        flag_pair: tp.flag_pair.clone(),
        ptype: tp.ptype.clone(),
        values_to_cli: tp.values_to_cli.clone(),
        ui_group: normalize_ui_group(&tp.ui_group),
        note: tp.note.clone(),
        pattern: tp.pattern.clone(),
        default_value: tp.default.clone(),
        user_added_values: Vec::new(),
        factory_default: tp.default.clone(),
        sub_params,
        dock: tp.dock.clone(),
    }
}

pub fn params_for_provider(id: &str) -> Vec<crate::types::UserEditedTemplateParam> {
    let bundle = crate::templates::TemplateBundle::default();
    if let Some(template) = bundle.templates.get(id) {
        return template.params.iter()
            .enumerate()
            .map(|(i, tp)| user_edited_param_from_template(tp, i as i32))
            .collect();
    }
    Vec::new()
}

fn genesis_providers() -> Vec<crate::types::ProviderConfig> {
    vec![
        crate::types::ProviderConfig {
            id: "ggml-stable".to_string(),
            display_name: "GGML Stable".to_string(),
            binary_path: r"C:\reactor_foundry\engines\ggml-stable\llama.cpp\build\bin\Release\llama-server.exe".to_string(),
            enabled: true,
            params: serde_json::json!({}),
            user_edited_template_params: params_for_provider("ggml-stable"),
            group_order: Vec::new(),
            _original_id: None,
            git_url: "https://github.com/ggml-org/llama.cpp".to_string(),
            branch: "master".to_string(),
            build_profile: String::new(),
            template_type: "ggml-llama".into(),
            build_info_per_env: std::collections::HashMap::new(),
            binary_path_per_env: std::collections::HashMap::new(),
            last_pr_per_env: std::collections::HashMap::new(),
            display_order: 0,
        },
        crate::types::ProviderConfig {
            id: "ik-extreme".to_string(),
            display_name: "IK-Extreme (Flagship)".to_string(),
            binary_path: r"C:\reactor_foundry\engines\ik-extreme\llama.cpp\build\bin\Release\llama-server.exe".to_string(),
            enabled: true,
            params: serde_json::json!({}),
            user_edited_template_params: params_for_provider("ik-extreme"),
            group_order: Vec::new(),
            _original_id: None,
            git_url: "https://github.com/ikawrakow/ik_llama.cpp".to_string(),
            branch: "main".to_string(),
            build_profile: String::new(),
            template_type: "ik-llama".into(),
            build_info_per_env: std::collections::HashMap::new(),
            binary_path_per_env: std::collections::HashMap::new(),
            last_pr_per_env: std::collections::HashMap::new(),
            display_order: 1,
        },
    ]
}

pub fn template_key_for_type(template_type: &str) -> Option<&'static str> {
    match template_type {
        "ik-llama" => Some("ik-extreme"),
        "ggml-llama" => Some("ggml-stable"),
        _ => None,  // custom/empty = no template
    }
}

/// Resolve effective template type: use disk value if set, otherwise auto-detect from provider ID.
pub fn resolve_template_type(provider_id: &str, disk_type: Option<&String>) -> String {
    match disk_type.and_then(|t| if t.is_empty() { None } else { Some(t.clone()) }) {
        Some(t) => t,
        None => crate::templates::ProviderTemplate::template_type_for_id(provider_id),
    }
}

fn merge_template_dock(template_type: &str, user_edited_params: &mut Vec<crate::types::UserEditedTemplateParam>) {
    let bundle = crate::templates::TemplateBundle::default();
    let Some(template_key) = template_key_for_type(template_type) else { return; };
    let Some(template) = bundle.templates.get(template_key) else { return; };

    // Build lookup of template params by key
    let tmpl_map: std::collections::HashMap<_, _> = template.params.iter()
        .map(|p| (p.key.as_str(), p))
        .collect();

    for pd in user_edited_params.iter_mut() {
        if pd.dock.is_empty() {
            if let Some(tmpl) = tmpl_map.get(pd.key.as_str()) {
                pd.dock = tmpl.dock.clone();
            }
        }
    }
}

// ── Config Loading ───────────────────────────────────────────────────

#[tauri::command]
pub fn load_config() -> AppConfig {
    // Try loading saved config from disk first (model_paths + other settings)
    if let Some(saved) = load_saved_config() {
        // Detect GPU count for Device param values only — NOT for slot count
        let gpu_count = crate::telemetry::detect_gpu_count();

        return build_config_with_providers_full(gpu_count, saved);
    }

    // No saved config — detect GPUs and build fresh
    let gpu_count = crate::telemetry::detect_gpu_count();

    let fresh = build_fresh_config(MAX_ENGINE_SLOTS);
    build_config_with_providers_full(gpu_count, fresh)
}


// ── Template Update Detection ───────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct TemplateDiff {
    /// New params added to the Genesis template (not in current config).
    pub new_params: Vec<crate::types::UserEditedTemplateParam>,
    /// Params currently configured but removed from the template. User can choose to keep or remove.
    pub orphaned_params: Vec<crate::types::UserEditedTemplateParam>,
}

#[tauri::command]
pub fn check_template_update(provider_id: String) -> Result<TemplateDiff, String> {
    // Load current state from disk (what was saved via save_provider)
    let metas = load_user_providers_meta();
    let meta = metas.iter().find(|m| m.id == provider_id);

    // Resolve template key through the provider's template_type (auto-detect from ID if empty)
    let template_type = resolve_template_type(&provider_id, meta.map(|m| &m.template_type));
    let bundle = crate::templates::TemplateBundle::default();
    let Some(template_key) = template_key_for_type(&template_type) else {
        log::info!("[check_template_update] {}: no template for type '{}', returning empty diff", provider_id, template_type);
        return Ok(TemplateDiff { new_params: Vec::new(), orphaned_params: Vec::new() });
    };

    let fresh_template = bundle.templates.get(template_key).ok_or("Unknown provider")?;
    
    // Build map of current params by key
    let current_params: std::collections::HashMap<String, &crate::types::UserEditedTemplateParam> = meta
        .map(|m| m.user_edited_template_params.iter().map(|p| (p.key.clone(), p)).collect())
        .unwrap_or_default();

    // Find new and orphaned params by comparing keys
    let mut new_params: Vec<crate::types::UserEditedTemplateParam> = Vec::new();
    let mut orphaned_params: Vec<crate::types::UserEditedTemplateParam> = Vec::new();

    for (i, tp) in fresh_template.params.iter().enumerate() {
        if !current_params.contains_key(&tp.key) {
            // Not in current config — it's new
            new_params.push(user_edited_param_from_template(tp, i as i32));
        }
    }

    for (key, param) in &current_params {
        let exists_in_template = fresh_template.params.iter().any(|tp| tp.key == *key);
        if !exists_in_template {
            // In config but not in template — orphaned
            orphaned_params.push((*param).clone());
        }
    }

    log::info!("[check_template_update] {}: {} new, {} orphaned", provider_id, new_params.len(), orphaned_params.len());

    Ok(TemplateDiff { new_params, orphaned_params })
}

#[tauri::command]
pub fn apply_template_update(
    provider_id: String,
    add_params: Vec<crate::types::UserEditedTemplateParam>,
    remove_keys: Vec<String>,
) -> Result<(), String> {
    let mut metas = load_user_providers_meta();
    
    // Find the provider meta (or create if missing)
    let meta = metas.iter_mut().find(|m| m.id == provider_id).ok_or("Provider not found")?;

    // Remove orphaned params user chose to delete
    for key in &remove_keys {
        meta.user_edited_template_params.retain(|p| p.key != *key);
    }

    // Merge new params — add only if they don't already exist
    let existing_keys: std::collections::HashSet<String> =
        meta.user_edited_template_params.iter().map(|p| p.key.clone()).collect();
    
    let add_count = add_params.len();
    let remove_count = remove_keys.len();

    for param in &add_params {
        if !existing_keys.contains(&param.key) {
            meta.user_edited_template_params.push((*param).clone());
        }
    }

    // Re-index order to match insertion order
    for (i, p) in meta.user_edited_template_params.iter_mut().enumerate() {
        p.order = i as i32;
    }

    save_user_providers_meta(metas)?;
    log::info!("[apply_template_update] {}: added {}, removed {}", provider_id, add_count, remove_count);

    Ok(())
}

#[tauri::command]
pub async fn reorder_provider(provider_id: String, direction: i32, app: tauri::State<'_, crate::engine::AppContext>) -> Result<(), String> {
    let mut cfg = app.config.lock().map_err(|e| e.to_string())?;
    let idx = cfg.providers.iter().position(|p| p.id == provider_id).ok_or("Provider not found")?;
    let new_idx = (idx as i32 + direction) as usize;
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

    let bundle = crate::templates::TemplateBundle::default();
    let Some(template_key) = template_key_for_type(&template_type) else {
        return Err(format!("No genesis template for type '{}' — cannot restore param", template_type));
    };

    let template = bundle.templates.get(template_key).ok_or("Unknown provider")?;
    let order = template.params.iter()
        .position(|p| p.key == param_key)
        .ok_or_else(|| format!("Param '{}' not found in template", param_key))? as i32;
    
    let tp = template.params.iter().find(|p| p.key == param_key).unwrap();
    Ok(user_edited_param_from_template(tp, order))
}

pub fn validate_model_path(path: &str) -> Result<(), String> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Err(format!(
            "Model file not found: {}\nVerify the path in your model catalog.",
            p.display()
        ));
    }
    Ok(())
}

pub fn validate_provider_binary(path: &str) -> Result<(), String> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Err(format!(
            "Provider binary not found at: {}\nVerify the path.",
            p.display()
        ));
    }
    Ok(())
}

// ── Model Paths Management ────────────────────────────────────────────

pub fn get_model_paths(config: &AppConfig) -> Vec<ModelPathEntry> {
    if config.model_paths.is_empty() {
        vec![ModelPathEntry {
            path: config.model_base.to_string_lossy().to_string(),
            label: "Default".to_string(),
            is_default: true,
        }]
    } else {
        config.model_paths.clone()
    }
}

pub fn add_model_path(config: &mut AppConfig, path: String, label: Option<String>) {
    if config.model_paths.iter().any(|p| p.path == path) {
        return;
    }
    let computed_label = label.unwrap_or_else(|| {
        std::path::Path::new(&path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or(path.clone())
    });
    let is_default = config.model_paths.is_empty();
    config.model_paths.push(ModelPathEntry { path, label: computed_label, is_default });
}

pub fn remove_model_path(config: &mut AppConfig, path: &str) {
    let removed = config.model_paths.iter().position(|p| p.path == path);
    config.model_paths.retain(|p| p.path != path);
    if let Some(_idx) = removed {
        if !config.model_paths.is_empty() && config.model_paths[0].is_default == false {
            config.model_paths[0].is_default = true;
        }
    }
}

pub fn set_default_model_path(config: &mut AppConfig, path: &str) {
    for p in &mut config.model_paths {
        p.is_default = p.path == path;
    }
}

pub fn calculate_disk_usage(paths: &[ModelPathEntry]) -> Vec<PathDiskUsage> {
    let mut result = Vec::new();
    for entry in paths {
        let entries = crate::model_catalog::scan_path(&std::path::PathBuf::from(&entry.path))
            .unwrap_or_default();
        let total_bytes: u64 = entries.iter().map(|e| e.total_bytes).sum();
        result.push(PathDiskUsage {
            path: entry.path.clone(),
            total_gguf_bytes: total_bytes,
            file_count: entries.len(),
        });
    }
    result
}

pub fn get_default_download_path(config: &AppConfig) -> String {
    config.model_paths
        .iter()
        .find(|p| p.is_default)
        .map(|p| p.path.clone())
        .unwrap_or_else(|| config.model_base.to_string_lossy().to_string())
}

pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let blackwell_dir = blackwell_config_dir();
    std::fs::create_dir_all(&blackwell_dir).map_err(|e| format!("Failed to create config dir: {}", e))?;

    let config_path = blackwell_dir.join("app_config.json");
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize app config: {}", e))?;

    std::fs::write(&config_path, json).map_err(|e| format!("Failed to write app config: {}", e))?;
    log::debug!("Saved app_config.json to {}", config_path.display());
    Ok(())
}

fn build_fresh_config(_gpu_slots: usize) -> AppConfig {
    let app_dir = Some(blackwell_config_dir().join("models"));
    let default_path = app_dir.as_ref().map(|p| p.to_string_lossy().to_string());

    let mut model_paths: Vec<ModelPathEntry> = Vec::new();

    if let Some(ref p) = default_path {
        model_paths.push(ModelPathEntry {
            path: p.clone(),
            label: "Default".to_string(),
            is_default: true,
        });
    }

    if let Some(lm_path) = dirs::home_dir().map(|h| h.join(".lmstudio").join("models")).and_then(|p| {
        if p.exists() { Some(p) } else { None }
    }) {
        model_paths.push(ModelPathEntry {
            path: lm_path.to_string_lossy().to_string(),
            label: ".lmstudio/models".to_string(),
            is_default: false,
        });
    }

    AppConfig {
        llama_path: PathBuf::from(r"C:\reactor_foundry\engines\ggml-stable\llama.cpp\build\bin\Release\llama-server.exe"),
        model_base: default_path.map(PathBuf::from).unwrap_or_default(),
        model_paths,
        prefs_file: PathBuf::new(),
        base_port: 9090,
        gpu_slots: MAX_ENGINE_SLOTS,
        providers: Vec::new(),
    }
}

fn load_saved_config() -> Option<AppConfig> {
    let config_path = blackwell_config_dir().join("app_config.json");
    if config_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&config_path) {
            if let Ok(config) = serde_json::from_str::<AppConfig>(&content) {
                log::info!("Loaded app_config.json from {}", config_path.display());
                return Some(config);
            }
        }
    }
    None
}


fn build_config_with_providers_full(_gpu_count: usize, mut config: AppConfig) -> AppConfig {
    let metas = load_user_providers_meta();

    let disk_metas = if metas.is_empty() {
        load_legacy_user_providers_meta()
    } else {
        metas
    };

    let meta_map: std::collections::HashMap<_, _> = disk_metas.iter()
        .map(|m| (m.id.clone(), m))
        .collect();
    let metas_clone = disk_metas.clone();

    let mut providers = Vec::new();

    for provider in genesis_providers() {
        let mut p = provider;
        if let Some(meta) = meta_map.get(&p.id) {
            if !meta.binary_path.is_empty() { p.binary_path = meta.binary_path.clone(); }
            if !meta.display_name.is_empty() { p.display_name = meta.display_name.clone(); }
            if !meta.git_url.is_empty() { p.git_url = meta.git_url.clone(); }
            if !meta.branch.is_empty() { p.branch = meta.branch.clone(); }
            if !meta.build_profile.is_empty() { p.build_profile = meta.build_profile.clone(); }

        if !meta.user_edited_template_params.is_empty() {
                 let mut defs = meta.user_edited_template_params.clone();
                 merge_template_dock(&p.template_type, &mut defs);
                 p.user_edited_template_params = defs;
            }
            if !meta.build_info_per_env.is_empty() {
                p.build_info_per_env = meta.build_info_per_env.clone();
            }
        }
        providers.push(p);
    }

    for meta in metas_clone {
        if !providers.iter().any(|p| p.id == meta.id) {
            let resolved_type = resolve_template_type(&meta.id, Some(&meta.template_type));
            let tmpl_key = template_key_for_type(&resolved_type);
        let user_edited_params = if !meta.user_edited_template_params.is_empty() {
                 meta.user_edited_template_params.clone()
            } else if let Some(key) = tmpl_key {
                params_for_provider(key)
            } else {
                Vec::new()  // custom type, no template
            };

            providers.push(crate::types::ProviderConfig {
                id: meta.id.clone(),
                display_name: meta.display_name.clone(),
                binary_path: meta.binary_path.clone(),
                enabled: meta.enabled,
          params: serde_json::json!({}),
                 user_edited_template_params: user_edited_params,
                group_order: meta.group_order.clone(),
                _original_id: None,
                git_url: meta.git_url.clone(),
                branch: meta.branch.clone(),
                build_profile: meta.build_profile.clone(),
                template_type: resolved_type,
                build_info_per_env: meta.build_info_per_env,
                binary_path_per_env: meta.binary_path_per_env,
                last_pr_per_env: meta.last_pr_per_env,
                display_order: meta.display_order,
            });
        }
    }

    // Sort by existing order then ID for stability, then re-assign unique sequential orders.
    // This handles collisions (e.g. two providers both at 0) and missing values.
    providers.sort_by(|a, b| a.display_order.cmp(&b.display_order).then_with(|| a.id.cmp(&b.id)));
    for (i, p) in providers.iter_mut().enumerate() {
        p.display_order = i as i32;
    }

    config.providers = providers;
    config.gpu_slots = MAX_ENGINE_SLOTS;

    config
}
