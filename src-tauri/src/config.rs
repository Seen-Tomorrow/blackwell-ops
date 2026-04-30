use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::types::ProviderConfig;

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
        Self {
            llama_path: PathBuf::from(r"C:\reactor_foundry\engines\ggml-stable\llama.cpp\build\bin\Release\llama-server.exe"),
            model_base: PathBuf::from(r"C:\Users\GHOST-TOWER\.lmstudio\models"),
            prefs_file: PathBuf::new(),
            base_port: 9090,
            gpu_slots: 2,
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
fn build_config_with_providers(gpu_slots: usize) -> AppConfig {
    let metas = load_provider_meta();

    // Fallback to legacy format if provider_meta.json is empty
    let disk_metas = if metas.is_empty() {
        load_legacy_provider_meta()
    } else {
        metas
    };

    // Map of disk metadata by ID for quick lookup
    let meta_map: std::collections::HashMap<_, _> = disk_metas.iter()
        .map(|m| (m.id.clone(), m))
        .collect();
    let metas_clone = disk_metas.clone();

    let mut providers = Vec::new();

    // Start with fresh Genesis providers
    for provider in genesis_providers() {
        let mut p = provider;
        if let Some(meta) = meta_map.get(&p.id) {
            // Apply metadata overrides from disk (binary_path, display_name, etc.)
            if !meta.binary_path.is_empty() { p.binary_path = meta.binary_path.clone(); }
            if !meta.display_name.is_empty() { p.display_name = meta.display_name.clone(); }
            if !meta.git_url.is_empty() { p.git_url = meta.git_url.clone(); }
            if !meta.branch.is_empty() { p.branch = meta.branch.clone(); }
            if !meta.build_profile.is_empty() { p.build_profile = meta.build_profile.clone(); }

            // If disk has param_definitions, use those (preserves admin edits)
            // Otherwise keep fresh template defaults
            if !meta.param_definitions.is_empty() {
                p.param_definitions = meta.param_definitions.clone();
            }
            // Merge build_info_per_env from disk
            if !meta.build_info_per_env.is_empty() {
                p.build_info_per_env = meta.build_info_per_env.clone();
            }
        }
        providers.push(p);
    }

    // Add extra providers from disk that aren't built-in (user-created custom providers)
    for meta in metas_clone {
        if !providers.iter().any(|p| p.id == meta.id) {
            // Use disk param_definitions or load from template based on ID auto-detection
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
                _original_id: None,
                git_url: meta.git_url.clone(),
                branch: meta.branch.clone(),
                build_profile: meta.build_profile.clone(),
                template_type: crate::templates::ProviderTemplate::template_type_for_id(&meta.id),
                build_info_per_env: meta.build_info_per_env,
            });
        }
    }

    AppConfig {
        llama_path: PathBuf::from(r"C:\reactor_foundry\engines\ggml-stable\llama.cpp\build\bin\Release\llama-server.exe"),
        model_base: PathBuf::from(r"C:\Users\GHOST-TOWER\.lmstudio\models"),
        prefs_file: PathBuf::new(),
        base_port: 9090,
        gpu_slots,
        providers,
    }
}

// ── Config Loading ───────────────────────────────────────────────────

#[tauri::command]
pub fn load_config() -> AppConfig {
    // Detect GPU count for engine slot allocation
        let mut gpu_slots = 2;
    if let Ok(output) = std::process::Command::new("nvidia-smi")
        .args(&["--query-gpu=index", "--format=csv,noheader"])
        .output()
    {
        let count = String::from_utf8_lossy(&output.stdout)
            .lines().filter(|l| !l.trim().is_empty()).count();
        if count > 0 {
            gpu_slots = count;
            log::info!("Detected {} GPU(s)", gpu_slots);
        }
    }
    // DEV/TESTING: force minimum 8 slots regardless of GPU count
    gpu_slots = std::cmp::max(gpu_slots, 8);

    build_config_with_providers(gpu_slots)
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

/// Overwrite the genesis_template.json with current provider definitions.
/// Backs up existing file first. Updates ALL providers sharing this template_type.
#[tauri::command]
pub fn overwrite_template(provider_id: String, _pin: u32) -> Result<(), String> {
    
    let bundle = crate::templates::TemplateBundle::default();
    let template_key = match provider_id.as_str() {
        "ik-extreme" => "ik-extreme",
        _ => "ggml-stable",
    };
    
    let metas = load_provider_meta();
    
    let siblings: Vec<&ProviderMeta> = metas.iter()
        .filter(|m| {
            match m.id.as_str() {
                "ik-extreme" => template_key == "ik-extreme",
                _ => template_key == "ggml-stable",  // matches ggml-stable and ggml-dev
            }
        })
        .collect();
    
    if siblings.is_empty() {
        return Err("No providers found for this template type".to_string());
    }
    
    log::info!("[overwrite_template] Overwriting {} template with {} provider(s)", template_key, siblings.len());
    
    // Build new bundle by copying existing + replacing the target template
    let mut new_bundle_json: serde_json::Value = serde_json::to_value(&bundle)
        .map_err(|e| format!("Serialization error: {}", e))?;
    
    if let Some(existing_tpl) = bundle.templates.get(template_key) {
        // Build params array from first sibling's param_definitions
        let mut new_params: Vec<serde_json::Value> = Vec::new();
        
        for p in &siblings[0].param_definitions {
            let mut param_json = serde_json::json!({
                "key": p.key,
                "label": p.label,
                "ptype": p.ptype,
            });
            
            if !p.config_key.is_empty() {
                param_json.as_object_mut().unwrap().insert("config_key".to_string(), serde_json::json!(p.config_key));
            }
            
            if let Some(ref flag) = p.flag {
                if !flag.is_empty() {
                    param_json.as_object_mut().unwrap().insert("flag".to_string(), serde_json::json!(flag));
                }
            }
            
            if let Some(ref mid) = p.map_id {
                if !mid.is_empty() {
                    param_json.as_object_mut().unwrap().insert("map_id".to_string(), serde_json::json!(mid));
                }
            }
            
            if !p.pattern.is_empty() {
                param_json.as_object_mut().unwrap().insert("pattern".to_string(), serde_json::json!(&p.pattern));
            }
            
            param_json.as_object_mut().unwrap().insert("values".to_string(), serde_json::json!(&p.values));
            
            // default_value is serde_json::Value — serialize if not Null
            if !p.default_value.is_null() {
                param_json.as_object_mut().unwrap().insert("default".to_string(), p.default_value.clone());
            }
            
            if !p.ui_group.is_empty() {
                param_json.as_object_mut().unwrap().insert("ui_group".to_string(), serde_json::json!(&p.ui_group));
            }
            
            if !p.note.is_empty() {
                param_json.as_object_mut().unwrap().insert("note".to_string(), serde_json::json!(&p.note));
            }
            
            // Use sub_params from disk (user edits take precedence over embedded template)
            if let Some(ref sp) = p.sub_params {
                if !sp.is_empty() {
                    let sp_json: serde_json::Value = serde_json::to_value(sp).unwrap_or_default();
                    param_json.as_object_mut().unwrap().insert("sub_params".to_string(), sp_json);
                }
            }
            
            new_params.push(param_json);
        }
        
        // Build replacement provider template
        let new_tpl_json = serde_json::json!({
            "binary_name": &existing_tpl.binary_name,
            "description": &existing_tpl.description,
            "params": new_params,
        });
        
        if let Some(obj) = new_bundle_json.as_object_mut() {
            obj.insert(template_key.to_string(), new_tpl_json);
        }
    }
    
    // Find template path — check exe dir first, then config dir
    let template_path = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|pa| pa.join("blackwell-ops").join("genesis_template.json")));
    
    let template_path = if let Some(ref tp) = template_path {
        if tp.exists() { tp.clone() } else {
            dirs::config_dir()
                .map(|d| d.join("blackwell-ops").join("genesis_template.json"))
                .unwrap_or_else(|| PathBuf::from("config/genesis_template.json"))
        }
    } else if let Some(app_dir) = dirs::config_dir() {
        app_dir.join("blackwell-ops").join("genesis_template.json")
    } else {
        return Err("Cannot find genesis_template.json location".to_string());
    };
    
    // Backup existing file
    let bak_path = template_path.with_extension("json.bak");
    if template_path.exists() {
        std::fs::copy(&template_path, &bak_path)
            .map_err(|e| format!("Backup failed: {}", e))?;
        log::info!("[overwrite_template] Backed up to {:?}", bak_path);
    }
    
    // Write new content
    let file = std::fs::File::create(&template_path)
        .map_err(|e| format!("Cannot create template file: {}", e))?;
    serde_json::to_writer_pretty(file, &new_bundle_json)
        .map_err(|e| format!("Write error: {}", e))?;
    
    log::info!("[overwrite_template] Wrote {} bytes to {:?}", 
        std::fs::metadata(&template_path).map(|m| m.len()).unwrap_or(0), template_path);
    
    Ok(())
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
