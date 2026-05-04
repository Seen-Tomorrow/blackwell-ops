use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::types::{ModelPathEntry, PathDiskUsage, ProviderConfig};

/// Maximum engine slots — decoupled from physical GPU count.
/// Modern Windows supports up to 16 GPUs; each slot = one provider backend process + model.
pub const MAX_ENGINE_SLOTS: usize = 16;

// ── Provider Metadata (persisted to disk) ───────────────────────────

/// Lightweight provider metadata — saved to %APPDATA%/blackwell-ops/provider_meta.json.
/// Contains: id, display_name, binary_path, enabled, git_url, branch, build_profile
/// and the full param_definitions so admin edits persist across restarts.
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
    /// Full param_definitions for this provider.
    /// Loaded from disk on startup; saved when admin edits params via save_provider IPC.
    #[serde(default)]
    pub param_definitions: Vec<crate::types::ParamDef>,
    /// Custom group order set by user (overrides template insertion order). Empty = use template order.
    #[serde(default, rename = "groupOrder")]
    pub group_order: Vec<String>,
    /// Per-environment build info captured from binary --version + file mtime.
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "buildInfoPerEnv")]
    pub build_info_per_env: HashMap<String, crate::types::BuildInfo>,
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
    /// Number of engine slots = physical GPUs detected. Set at startup.
    #[serde(default)]
    pub gpu_slots: usize,
    /// All registered providers with their current param_definitions (overlay-merged).
    #[serde(default = "default_providers")]
    pub providers: Vec<ProviderConfig>,
}

impl Default for AppConfig {
    fn default() -> Self {
        let app_dir = dirs::config_dir().map(|d| d.join("blackwell-ops").join("models"));
        let default_path = app_dir.as_ref().map(|p| p.to_string_lossy().to_string());

        let mut model_paths: Vec<ModelPathEntry> = Vec::new();

        if let Some(ref p) = default_path {
            model_paths.push(ModelPathEntry {
                path: p.clone(),
                label: "Default".to_string(),
                is_default: true,
            });
        }

        // Pre-add .lmstudio path if it exists on disk
        let lmstudio_path = r"C:\Users\GHOST-TOWER\.lmstudio\models";
        if std::path::Path::new(lmstudio_path).exists() {
            model_paths.push(ModelPathEntry {
                path: lmstudio_path.to_string(),
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

const PROVIDER_META_FILE: &str = "provider_meta.json";

// ── Provider Metadata Persistence ───────────────────────────────────

/// Load provider metadata from %APPDATA%/blackwell-ops/provider_meta.json on disk.
pub fn load_provider_meta() -> Vec<ProviderMeta> {
    if let Some(app_dir) = dirs::config_dir() {
        let config_path = app_dir.join("blackwell-ops").join(PROVIDER_META_FILE);
        if config_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&config_path) {
                if let Ok(metas) = serde_json::from_str::<Vec<ProviderMeta>>(&content) {
                    log::info!("Loaded {} provider(s) from {}", metas.len(), config_path.display());
                    return metas;
                }
            }
        }
    }
    Vec::new()
}

fn json_val_eq(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    serde_json::to_string(a).ok() == serde_json::to_string(b).ok()
}

/// Validate a single ParamDef against the expected schema.
fn validate_param_def(def: &crate::types::ParamDef) -> Vec<String> {
    let mut errors = Vec::new();

    if def.key.is_empty() {
        errors.push("key is empty".to_string());
    }

    // values[] must be string or number
    for (i, v) in def.values.iter().enumerate() {
        match v {
            serde_json::Value::String(_) | serde_json::Value::Number(_) => {}
            _ => errors.push(format!("values[{}] must be string or number, got {:?}", i, v)),
        }
    }

    // No duplicate values
    for i in 0..def.values.len() {
        for j in (i + 1)..def.values.len() {
            if json_val_eq(&def.values[i], &def.values[j]) {
                errors.push(format!("duplicate value {:?} at indices {} and {}", &def.values[i], i, j));
                break;
            }
        }
    }

    // defaultValue type must match one of values
    if !def.default_value.is_null() && !def.values.is_empty() {
        let mut found = false;
        for v in &def.values {
            if json_val_eq(&v, &def.default_value) {
                found = true;
                break;
            }
        }
        if !found {
            errors.push(format!("defaultValue ({:?}) type does not match any value in values array", def.default_value));
        }
    }

    // Valid ptype
    static VALID_PTYPES: [&str; 7] = [
        "arg_select", "mapper", "switch_onoff", "switch_inverted", "path_scanner", "logic_only", "",
    ];
    if !VALID_PTYPES.contains(&def.ptype.as_str()) {
        errors.push(format!("invalid ptype '{}' (valid: {:?})", def.ptype, VALID_PTYPES));
    }

    // flag required for arg_select/mapper with no config_key
    let needs_flag = def.ptype == "arg_select" || def.ptype == "mapper";
    if needs_flag && def.config_key.is_empty() && def.flag.as_deref().map_or(true, |s| s.is_empty()) {
        errors.push(format!("ptype '{}' requires a non-empty flag (no config_key)", def.ptype));
    }

    // hiddenValues must be subset of values
    for hv in &def.hidden_values {
        let found = def.values.iter().any(|v| json_val_eq(v, hv));
        if !found {
            errors.push(format!("hiddenValue {:?} is not in values array", hv));
        }
    }

    // sub_params: each value must be string[], no empty strings
    if let Some(ref sp) = def.sub_params {
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

/// Validate all providers before saving. Returns Vec of error strings (empty = valid).
fn check_provider_meta(metas: &[ProviderMeta]) -> Vec<String> {
    let mut all_errors: Vec<String> = Vec::new();

    // Duplicate provider IDs
    let mut seen_ids: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for meta in metas {
        if !seen_ids.insert(&meta.id) {
            all_errors.push(format!("duplicate provider id: '{}'", meta.id));
        }

        // Duplicate param keys within this provider
        let mut seen_keys: std::collections::HashMap<&str, i32> = std::collections::HashMap::new();
        for def in &meta.param_definitions {
            if let Some(&prev_order) = seen_keys.get(def.key.as_str()) {
                all_errors.push(format!(
                    "provider '{}': duplicate param key '{}' (order {} and {})",
                    meta.id, def.key, prev_order, def.order
                ));
            } else {
                seen_keys.insert(&def.key, def.order);
            }

            // Validate each ParamDef
            for e in validate_param_def(def) {
                all_errors.push(format!("provider '{}' param '{}': {}", meta.id, def.key, e));
            }
        }
    }

    all_errors
}

/// Save provider metadata to %APPDATA%/blackwell-ops/provider_meta.json on disk.
#[tauri::command]
pub fn save_provider_meta(metas: Vec<ProviderMeta>) -> Result<(), String> {
    // Block-save validation — force user to correct manually
    let errors = check_provider_meta(&metas);
    if !errors.is_empty() {
        return Err(format!("provider_meta.json has {} issue(s):\n{}", errors.len(), errors.join("\n")));
    }

    if let Some(app_dir) = dirs::config_dir() {
        let blackwell_dir = app_dir.join("blackwell-ops");
        std::fs::create_dir_all(&blackwell_dir).map_err(|e| format!("Failed to create config dir: {}", e))?;

        let config_path = blackwell_dir.join(PROVIDER_META_FILE);
        let json = serde_json::to_string_pretty(&metas)
            .map_err(|e| format!("Failed to serialize provider meta: {}", e))?;

        std::fs::write(&config_path, json).map_err(|e| format!("Failed to write provider meta: {}", e))?;
        log::debug!("Saved {} provider(s) to {}", metas.len(), config_path.display());
    } else {
        return Err("Could not determine config directory".to_string());
    }
    Ok(())
}

/// Check existing provider_meta.json for schema errors without modifying it.
/// Used by ConfigPage "Validate" button to report issues before user edits.
#[tauri::command]
pub fn validate_provider_meta() -> Result<Vec<String>, String> {
    let metas = load_provider_meta();
    if metas.is_empty() {
        return Ok(Vec::new());
    }
    let errors = check_provider_meta(&metas);
    Ok(errors)
}

/// Convert Vec<ProviderConfig> → Vec<ProviderMeta> and persist to disk.
/// param_definitions are saved as-is — no delta computation.
pub fn persist_provider_meta(providers: &[crate::types::ProviderConfig]) -> Result<(), String> {
    let metas: Vec<ProviderMeta> = providers.iter().map(|p| ProviderMeta {
        id: p.id.clone(),
        display_name: if p.display_name.is_empty() { "Untitled".to_string() } else { p.display_name.clone() },
        binary_path: p.binary_path.clone(),
        enabled: p.enabled,
        git_url: p.git_url.clone(),
        branch: p.branch.clone(),
        build_profile: p.build_profile.clone(),
        param_definitions: if p.param_definitions.is_empty() {
            Vec::new()
        } else {
            p.param_definitions.clone()
        },
        group_order: p.group_order.clone(),
        build_info_per_env: p.build_info_per_env.clone(),
    }).collect();
    save_provider_meta(metas)
}

// ── Legacy Migration ─────────────────────────────────────────────────

/// Fallback: load from deprecated admin_template.json format (one-time migration, pre-param_definitions).
fn load_legacy_provider_meta() -> Vec<ProviderMeta> {
    if let Some(app_dir) = dirs::config_dir() {
        let config_path = app_dir.join("blackwell-ops").join("admin_template.json");
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
                                    param_definitions: Vec::new(),
                                    group_order: Vec::new(),
                                    build_info_per_env: HashMap::new(),
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
    }
    Vec::new()
}

// ── Genesis Providers (factory defaults from embedded template) ─────

/// Helper: build a single ParamDef from a TemplateParam, setting factory_default.
fn param_def_from_template(tp: &crate::templates::TemplateParam, order: i32) -> crate::types::ParamDef {
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

    crate::types::ParamDef {
        key: tp.key.clone(),
        label: tp.label.clone(),
        values: tp.values.clone(),
        order,
        hidden: false,
        hidden_values: Vec::new(),
        config_key: tp.config_key.clone(),
        flag: tp.flag.clone(),
        ptype: tp.ptype.clone(),
        map_id: tp.map_id.clone(),
        ui_group: tp.ui_group.clone(),
        note: tp.note.clone(),
        pattern: tp.pattern.clone(),
        default_value: tp.default.clone(),   // Current value = factory default on first load
        user_added_values: Vec::new(),
        factory_default: tp.default.clone(),  // Never changes — set once from template
        sub_params,
    }
}

/// Build param_definitions for a provider ID from the embedded genesis_template.json.
/// Each param gets factory_default set to its template's default value.
pub fn params_for_provider(id: &str) -> Vec<crate::types::ParamDef> {
    let bundle = crate::templates::TemplateBundle::default();
    if let Some(template) = bundle.templates.get(id) {
        return template.params.iter()
            .enumerate()
            .map(|(i, tp)| param_def_from_template(tp, i as i32))
            .collect();
    }
    Vec::new()
}

/// Build the 3 built-in providers with fresh param_definitions from embedded templates.
fn genesis_providers() -> Vec<crate::types::ProviderConfig> {
    vec![
        crate::types::ProviderConfig {
            id: "ggml-stable".to_string(),
            display_name: "GGML Stable".to_string(),
            binary_path: r"C:\reactor_foundry\engines\ggml-stable\llama.cpp\build\bin\Release\llama-server.exe".to_string(),
            enabled: true,
            params: serde_json::json!({}),
            param_definitions: params_for_provider("ggml-stable"),
            group_order: Vec::new(),
            _original_id: None,
            git_url: "https://github.com/ggml-org/llama.cpp".to_string(),
            branch: "master".to_string(),
            build_profile: String::new(),
            template_type: "ggml-llama".into(),
            build_info_per_env: std::collections::HashMap::new(),
        },
        crate::types::ProviderConfig {
            id: "ggml-dev".to_string(),
            display_name: "GGML Nightly/Dev".to_string(),
            binary_path: r"C:\reactor_foundry\engines\ggml-dev\llama.cpp\build\bin\Release\llama-server.exe".to_string(),
            enabled: true,
            params: serde_json::json!({}),
            param_definitions: params_for_provider("ggml-dev"),
            group_order: Vec::new(),
            _original_id: None,
            git_url: "https://github.com/ggml-org/llama.cpp".to_string(),
            branch: "dev".to_string(),
            build_profile: String::new(),
            template_type: "ggml-llama".into(),
            build_info_per_env: std::collections::HashMap::new(),
        },
        crate::types::ProviderConfig {
            id: "ik-extreme".to_string(),
            display_name: "IK-Extreme (Flagship)".to_string(),
            binary_path: r"C:\reactor_foundry\engines\ik-extreme\llama.cpp\build\bin\Release\llama-server.exe".to_string(),
            enabled: true,
            params: serde_json::json!({}),
            param_definitions: params_for_provider("ik-extreme"),
            group_order: Vec::new(),
            _original_id: None,
            git_url: "https://github.com/ikawrakow/ik_llama.cpp".to_string(),
            branch: "main".to_string(),
            build_profile: String::new(),
            template_type: "ik-llama".into(),
            build_info_per_env: std::collections::HashMap::new(),
        },
    ]
}

/// Build AppConfig with:
/// - Built-in Genesis providers (fresh param_definitions from embedded template)
/// - Any extra providers from disk metadata
///
/// Priority: disk param_definitions > fresh template defaults.
/// If provider_meta.json has no param_definitions for a built-in, use the template.
// ── Config Loading ───────────────────────────────────────────────────

#[tauri::command]
pub fn load_config() -> AppConfig {
    // Try loading saved config from disk first (model_paths + other settings)
    if let Some(saved) = load_saved_config() {
        // Detect GPU count for Device param values only — NOT for slot count
        let gpu_count = detect_gpu_count();

        return build_config_with_providers_full(gpu_count, saved);
    }

    // No saved config — detect GPUs and build fresh
    let gpu_count = detect_gpu_count();

    let fresh = build_fresh_config(MAX_ENGINE_SLOTS);
    build_config_with_providers_full(gpu_count, fresh)
}

/// Detect physical GPU count via nvidia-smi. Returns 2 as fallback if detection fails.
pub fn detect_gpu_count_pub() -> usize {
    let mut gpu_count = 2; // Fallback for single-GPU or detection failure
    if let Ok(output) = std::process::Command::new("nvidia-smi")
        .args(&["--query-gpu=index", "--format=csv,noheader"])
        .output()
    {
        let count = String::from_utf8_lossy(&output.stdout)
            .lines().filter(|l| !l.trim().is_empty()).count();
        if count > 0 {
            gpu_count = count;
            log::info!("Detected {} GPU(s)", gpu_count);
        }
    }
    gpu_count
}

/// Internal alias used at startup.
fn detect_gpu_count() -> usize {
    detect_gpu_count_pub()
}

// ── Template Update Detection ───────────────────────────────────────

/// Result of comparing current param_definitions against fresh genesis template.
/// Used by CHECK TEMPLATE UPDATE to show what changed.
#[derive(Debug, Clone, Serialize)]
pub struct TemplateDiff {
    /// New params added to the Genesis template (not in current config).
    pub new_params: Vec<crate::types::ParamDef>,
    /// Params currently configured but removed from the template. User can choose to keep or remove.
    pub orphaned_params: Vec<crate::types::ParamDef>,
}

/// Compare fresh genesis_template.json against current param_definitions for a provider.
/// Returns what's new, what changed, and what's orphaned.
#[tauri::command]
pub fn check_template_update(provider_id: String) -> Result<TemplateDiff, String> {
    let bundle = crate::templates::TemplateBundle::default();
    // Resolve to the correct template key (ggml-dev uses ggml-stable params)
    let template_key = match provider_id.as_str() {
        "ik-extreme" => "ik-extreme",
        _ => "ggml-stable",  // ggml-stable and ggml-dev share same param structure
    };

    let fresh_template = bundle.templates.get(template_key).ok_or("Unknown provider")?;

    // Load current state from disk (what was saved via save_provider)
    let metas = load_provider_meta();
    let meta = metas.iter().find(|m| m.id == provider_id);
    
    // Build map of current params by key
    let current_params: std::collections::HashMap<String, &crate::types::ParamDef> = meta
        .map(|m| m.param_definitions.iter().map(|p| (p.key.clone(), p)).collect())
        .unwrap_or_default();

    // Find new and orphaned params by comparing keys
    let mut new_params: Vec<crate::types::ParamDef> = Vec::new();
    let mut orphaned_params: Vec<crate::types::ParamDef> = Vec::new();

    for (i, tp) in fresh_template.params.iter().enumerate() {
        if !current_params.contains_key(&tp.key) {
            // Not in current config — it's new
            new_params.push(param_def_from_template(tp, i as i32));
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

/// Apply a template update to a provider:
/// - Merge in the approved new params
/// - Remove or keep orphaned params based on user choice
#[tauri::command]
pub fn apply_template_update(
    provider_id: String,
    add_params: Vec<crate::types::ParamDef>,
    remove_keys: Vec<String>,
) -> Result<(), String> {
    let mut metas = load_provider_meta();
    
    // Find the provider meta (or create if missing)
    let meta = metas.iter_mut().find(|m| m.id == provider_id).ok_or("Provider not found")?;

    // Remove orphaned params user chose to delete
    for key in &remove_keys {
        meta.param_definitions.retain(|p| p.key != *key);
    }

    // Merge new params — add only if they don't already exist
    let existing_keys: std::collections::HashSet<String> =
        meta.param_definitions.iter().map(|p| p.key.clone()).collect();
    
    let add_count = add_params.len();
    let remove_count = remove_keys.len();

    for param in &add_params {
        if !existing_keys.contains(&param.key) {
            meta.param_definitions.push((*param).clone());
        }
    }

    // Re-index order to match insertion order
    for (i, p) in meta.param_definitions.iter_mut().enumerate() {
        p.order = i as i32;
    }

    save_provider_meta(metas)?;
    log::info!("[apply_template_update] {}: added {}, removed {}", provider_id, add_count, remove_count);

    Ok(())
}

/// Restore a single param definition to its genesis template state.
/// Used by the "R" (Restore) button in ConfigPage.
#[tauri::command]
pub fn reset_param_to_template(provider_id: String, param_key: String) -> Result<crate::types::ParamDef, String> {
    let bundle = crate::templates::TemplateBundle::default();
    // Resolve template key from provider ID
    let template_key = match provider_id.as_str() {
        "ik-extreme" => "ik-extreme",
        _ => "ggml-stable",  // ggml-stable and ggml-dev share same param structure
    };
    
    let template = bundle.templates.get(template_key).ok_or("Unknown provider")?;
    let order = template.params.iter()
        .position(|p| p.key == param_key)
        .ok_or_else(|| format!("Param '{}' not found in template", param_key))? as i32;
    
    let tp = template.params.iter().find(|p| p.key == param_key).unwrap();
    Ok(param_def_from_template(tp, order))
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

/// Validates that a provider binary exists.
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

/// Get all configured model paths. Returns default if none configured.
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

/// Add a model path. If no default exists yet, this becomes the default.
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

/// Remove a model path. If it was the default, make another one default.
pub fn remove_model_path(config: &mut AppConfig, path: &str) {
    let removed = config.model_paths.iter().position(|p| p.path == path);
    config.model_paths.retain(|p| p.path != path);
    if let Some(_idx) = removed {
        if !config.model_paths.is_empty() && config.model_paths[0].is_default == false {
            config.model_paths[0].is_default = true;
        }
    }
}

/// Set which path is the default download target.
pub fn set_default_model_path(config: &mut AppConfig, path: &str) {
    for p in &mut config.model_paths {
        p.is_default = p.path == path;
    }
}

/// Calculate disk usage for all model paths — scan for .gguf files.
pub fn calculate_disk_usage(paths: &[ModelPathEntry]) -> Vec<PathDiskUsage> {
    let mut result = Vec::new();
    for entry in paths {
        let mut total_bytes = 0u64;
        let mut file_count = 0usize;

        if let Ok(read_dir) = std::fs::read_dir(&entry.path) {
            for entry_item in read_dir.flatten() {
                let path = entry_item.path();
                if path.extension().and_then(|e| e.to_str()) == Some("gguf") {
                    if let Ok(meta) = std::fs::metadata(&path) {
                        total_bytes += meta.len();
                        file_count += 1;
                    }
                }
            }
        }

        result.push(PathDiskUsage {
            path: entry.path.clone(),
            total_gguf_bytes: total_bytes,
            file_count,
        });
    }
    result
}

/// Get the default download destination path.
pub fn get_default_download_path(config: &AppConfig) -> String {
    config.model_paths
        .iter()
        .find(|p| p.is_default)
        .map(|p| p.path.clone())
        .unwrap_or_else(|| config.model_base.to_string_lossy().to_string())
}

/// Save AppConfig to %APPDATA%/blackwell-ops/app_config.json on disk.
pub fn save_config(config: &AppConfig) -> Result<(), String> {
    if let Some(app_dir) = dirs::config_dir() {
        let blackwell_dir = app_dir.join("blackwell-ops");
        std::fs::create_dir_all(&blackwell_dir).map_err(|e| format!("Failed to create config dir: {}", e))?;

        let config_path = blackwell_dir.join("app_config.json");
        let json = serde_json::to_string_pretty(config)
            .map_err(|e| format!("Failed to serialize app config: {}", e))?;

        std::fs::write(&config_path, json).map_err(|e| format!("Failed to write app config: {}", e))?;
        log::debug!("Saved app_config.json to {}", config_path.display());
    } else {
        return Err("Could not determine config directory".to_string());
    }
    Ok(())
}

/// Build AppConfig with GPU detection and genesis providers.
fn build_fresh_config(_gpu_slots: usize) -> AppConfig {
    let app_dir = dirs::config_dir().map(|d| d.join("blackwell-ops").join("models"));
    let default_path = app_dir.as_ref().map(|p| p.to_string_lossy().to_string());

    let mut model_paths: Vec<ModelPathEntry> = Vec::new();

    if let Some(ref p) = default_path {
        model_paths.push(ModelPathEntry {
            path: p.clone(),
            label: "Default".to_string(),
            is_default: true,
        });
    }

    // Pre-add .lmstudio path if it exists on disk
    let lmstudio_path = r"C:\Users\GHOST-TOWER\.lmstudio\models";
    if std::path::Path::new(lmstudio_path).exists() {
        model_paths.push(ModelPathEntry {
            path: lmstudio_path.to_string(),
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

/// Load AppConfig from %APPDATA%/blackwell-ops/app_config.json if it exists.
fn load_saved_config() -> Option<AppConfig> {
    if let Some(app_dir) = dirs::config_dir() {
        let config_path = app_dir.join("blackwell-ops").join("app_config.json");
        if config_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&config_path) {
                if let Ok(config) = serde_json::from_str::<AppConfig>(&content) {
                    log::info!("Loaded app_config.json from {}", config_path.display());
                    return Some(config);
                }
            }
        }
    }
    None
}


/// Build AppConfig with:
/// - Built-in Genesis providers (fresh param_definitions from embedded template)
/// - Any extra providers from disk metadata
fn build_config_with_providers_full(gpu_count: usize, mut config: AppConfig) -> AppConfig {
    let metas = load_provider_meta();

    let disk_metas = if metas.is_empty() {
        load_legacy_provider_meta()
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

            if !meta.param_definitions.is_empty() {
                p.param_definitions = meta.param_definitions.clone();
            }
            if !meta.build_info_per_env.is_empty() {
                p.build_info_per_env = meta.build_info_per_env.clone();
            }
        }
        providers.push(p);
    }

    for meta in metas_clone {
        if !providers.iter().any(|p| p.id == meta.id) {
            let param_defs = if !meta.param_definitions.is_empty() {
                meta.param_definitions.clone()
            } else {
                params_for_provider(&meta.id)
            };

            providers.push(crate::types::ProviderConfig {
                id: meta.id.clone(),
                display_name: meta.display_name.clone(),
                binary_path: meta.binary_path.clone(),
                enabled: meta.enabled,
                params: serde_json::json!({}),
                param_definitions: param_defs,
                group_order: meta.group_order.clone(),
                _original_id: None,
                git_url: meta.git_url.clone(),
                branch: meta.branch.clone(),
                build_profile: meta.build_profile.clone(),
                template_type: crate::templates::ProviderTemplate::template_type_for_id(&meta.id),
                build_info_per_env: meta.build_info_per_env,
            });
        }
    }

    config.providers = providers;
    config.gpu_slots = MAX_ENGINE_SLOTS;

    config
}
