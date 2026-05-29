use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{Manager, path::BaseDirectory};

use crate::types::{ModelPathEntry, PathDiskUsage, ProviderConfig};

pub const MAX_ENGINE_SLOTS: usize = 16;

/// Default provider ID — bundled with the app, always present.
pub const DEFAULT_PROVIDER_ID: &str = "ggml-master";

/// App root directory — parent of the running executable (portable).
/// DEV: target/debug/ or target/release/ during development.
/// REL: wherever the user installed/unzipped the app.
pub fn app_root_dir() -> std::path::PathBuf {
    std::env::current_exe()
        .map(|p| p.parent().unwrap().to_path_buf())
        .unwrap_or_else(|_| std::env::current_dir().unwrap())
}

/// User data directory: config/ — same in DEV and REL.
fn config_dir() -> std::path::PathBuf {
    app_root_dir().join("config")
}

/// Cache directory: inside data dir.
pub fn cache_dir() -> std::path::PathBuf {
    config_dir().join("cache")
}

/// Foundry build directory for a given provider — SHARED between DEV and REL.
/// e.g. {app_root}/foundry/engines/ggml-master
pub fn foundry_dir(provider_id: &str) -> std::path::PathBuf {
    app_root_dir()
        .join("foundry")
        .join("engines")
        .join(provider_id)
}

/// Foundry artifacts directory (sacred final Release binaries).
/// Layout: foundry/artifacts/<provider_id>/<env_label>/Release/llama-server.exe
pub fn foundry_artifacts_dir() -> std::path::PathBuf {
    app_root_dir().join("foundry").join("artifacts")
}

/// Per-provider disposable work directory for the current (or last) build attempt.
/// Everything under here may be deleted at the end of any build (success/failure/cancel).
pub fn foundry_work_dir(provider_id: &str) -> std::path::PathBuf {
    foundry_dir(provider_id).join("work")
}

/// Sacred Release directory for one provider + environment profile.
pub fn foundry_artifact_release_dir(provider_id: &str, env_label: &str) -> std::path::PathBuf {
    foundry_artifacts_dir().join(provider_id).join(env_label).join("Release")
}

/// Resolve a path that may be relative to app_root or absolute.
/// Relative paths like "runtime/ggml-master/stable/llama-server.exe" are resolved against app_root.
/// Absolute paths (containing drive letter) are returned as-is.
pub fn resolve_path(path_str: &str) -> PathBuf {
    if path_str.is_empty() {
        return PathBuf::new();
    }

    let p = PathBuf::from(path_str);
    // Check if it looks like an absolute Windows path (contains drive letter + colon)
    let is_absolute = path_str.len() >= 2 && path_str.as_bytes()[1] == b':';
    if is_absolute {
        p
    } else {
        app_root_dir().join(&p)
    }
}

/// Convert an absolute path to a relative path from app_root (if possible).
pub fn to_relative_path(abs: &PathBuf) -> String {
    let root = app_root_dir();
    if let Ok(rel) = abs.strip_prefix(&root) {
        rel.to_string_lossy().to_string()
    } else {
        abs.to_string_lossy().to_string()
    }
}

/// Ensure the portable directory structure exists. Copy bundled binaries from resources on first run (REL only).
pub fn ensure_portable_structure(app_handle: &tauri::AppHandle) {
    let root = app_root_dir();
    let data = config_dir();

    // Create directories
    let _ = std::fs::create_dir_all(&data);
    let _ = std::fs::create_dir_all(cache_dir().parent().unwrap_or(&data));
    let foundry_base = app_root_dir().join("foundry");
    let _ = std::fs::create_dir_all(&foundry_base);
    let _ = std::fs::create_dir_all(foundry_artifacts_dir());

    // Copy bundled binaries from Tauri resources (REL only)
    if !cfg!(debug_assertions) {
        let dest_binaries = root.join("runtime");
        if !dest_binaries.exists() || dest_binaries.read_dir().map(|d| d.count() == 0).unwrap_or(true) {
            log::info!("[setup] Copying bundled binaries from resources to {}", dest_binaries.display());
            let _ = copy_resources_to_binaries(app_handle, &dest_binaries);
        }
    }

    log::info!("[setup] Portable structure ready at {}", root.display());
}

/// Copy bundled binaries from Tauri resources to app_root/runtime/.
fn copy_resources_to_binaries(app_handle: &tauri::AppHandle, dest: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    let resource_path = match app_handle.path().resolve("runtime", BaseDirectory::Resource) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[setup] Could not resolve runtime resource: {}", e);
            return Ok(());
        }
    };

    if !resource_path.exists() {
        log::warn!("[setup] No bundled binaries found in resources");
        return Ok(());
    }

    std::fs::create_dir_all(dest)?;

    for entry in std::fs::read_dir(&resource_path)? {
        let entry = entry?;
        let src = entry.path();
        let dst = dest.join(entry.file_name());

        if entry.file_type()?.is_dir() {
            copy_directory_tree(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }

    Ok(())
}

/// Recursively copy a directory tree.
fn copy_directory_tree(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if entry.file_type()?.is_dir() {
            copy_directory_tree(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
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
    #[serde(default = "crate::types::default_true")]
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
    /// Per-environment binary paths — each env's final sacred binary lives under foundry/artifacts/<id>/<env>/Release/llama-server.exe.
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "binaryPathPerEnv")]
    pub binary_path_per_env: HashMap<String, String>,
    /// Per-environment downloaded release version — tracks which GitHub release tag was installed via update.
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "downloadedVersionPerEnv")]
    pub downloaded_version_per_env: HashMap<String, String>,
    /// Last cherry-picked PR number per environment (for badge display)
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "lastPrPerEnv")]
    pub last_pr_per_env: HashMap<String, String>,
    /// Display order in provider list (0 = first). Auto-assigned on save if not set.
    #[serde(default)]
    pub display_order: i32,
    /// True when the provider was discovered from runtime/ directory (bundled or downloaded).
    #[serde(default)]
    pub factory_provided: bool,
}

impl ProviderMeta {
    /// Convert a runtime ProviderConfig into persistence format (ProviderMeta).
    pub fn from_config(p: &ProviderConfig) -> Self {
        ProviderMeta {
            id: p.id.clone(),
            display_name: p.display_name.clone(),
            binary_path: to_relative_path(&PathBuf::from(&p.binary_path)),
            enabled: p.enabled,
            git_url: p.git_url.clone(),
            branch: p.branch.clone(),
            build_profile: p.build_profile.clone(),
            user_edited_template_params: p.user_edited_template_params.clone(),
            group_order: p.group_order.clone(),
            template_type: p.template_type.clone(),
            build_info_per_env: p.build_info_per_env.clone(),
            binary_path_per_env: p.binary_path_per_env.iter().map(|(k, v)| (k.clone(), to_relative_path(&PathBuf::from(v)))).collect(),
            downloaded_version_per_env: p.downloaded_version_per_env.clone(),
            last_pr_per_env: p.last_pr_per_env.clone(),
            display_order: p.display_order,
            factory_provided: p.factory_provided,
        }
    }
}

fn default_providers() -> Vec<ProviderConfig> { Vec::new() }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub model_paths: Vec<ModelPathEntry>,
    pub prefs_file: PathBuf,
    pub base_port: u16,
    #[serde(default)]
    pub gpu_slots: usize,
    /// HuggingFace API token — stored in app_config.json. Empty string if not set.
    #[serde(default)]
    pub hf_token: String,
    #[serde(default = "default_providers", skip_serializing)]
    pub providers: Vec<ProviderConfig>,
}

impl Default for AppConfig {
    fn default() -> Self {
        let app_dir = config_dir().join("models");

        let mut model_paths: Vec<ModelPathEntry> = Vec::new();
        model_paths.push(ModelPathEntry {
            path: app_dir.to_string_lossy().to_string(),
            label: "Default".to_string(),
            is_default: true,
        });

        Self {
            model_paths,
            prefs_file: PathBuf::new(),
            base_port: 9090,
            gpu_slots: MAX_ENGINE_SLOTS,
            hf_token: String::new(),
            providers: Vec::new(),
        }
    }
}

// ── Per-Provider User Config Persistence ────────────────────────────

/// Get the user config file path for a provider.
pub fn provider_user_config_path(provider_id: &str) -> PathBuf {
    config_dir().join(format!("{}-user-config.json", provider_id))
}

/// Load all per-provider user configs from disk.
pub fn load_user_providers_meta() -> Vec<ProviderMeta> {
    let mut metas = Vec::new();
    let cd = config_dir();

    if !cd.exists() {
        return metas;
    }

    for entry in std::fs::read_dir(&cd).into_iter().flatten() {
        let entry = match entry { Ok(e) => e, Err(_) => continue };
        let path = entry.path();

        // Match *-user-config.json files
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !file_name.ends_with("-user-config.json") {
            continue;
        }

        if let Ok(content) = std::fs::read_to_string(&path) {
            // Try loading as single ProviderMeta first, then fallback to array
            if let Ok(meta) = serde_json::from_str::<ProviderMeta>(&content) {
                metas.push(meta);
            } else if let Ok(arr) = serde_json::from_str::<Vec<ProviderMeta>>(&content) {
                // Legacy format: array in single file — migrate to individual files
                for m in arr {
                    let individual_path = provider_user_config_path(&m.id);
                    if !individual_path.exists() {
                        if let Ok(json) = serde_json::to_string_pretty(&m) {
                            let _ = std::fs::write(&individual_path, json);
                        }
                    }
                    metas.push(m);
                }
            } else {
                log::warn!("[config] Failed to parse {}: skipping (check for corrupt JSON)", path.display());
            }
        } else {
            log::warn!("[config] Failed to read {}", path.display());
        }
    }

    log::info!("[config] Loaded {} per-provider user config(s)", metas.len());
    metas
}

/// Save a single provider's user config to its own file.
pub fn save_provider_user_config(meta: &ProviderMeta) -> Result<(), String> {
    std::fs::create_dir_all(config_dir()).map_err(|e| format!("Failed to create config dir: {}", e))?;

    let path = provider_user_config_path(&meta.id);
    let json = serde_json::to_string_pretty(meta).map_err(|e| format!("Serialization failed: {}", e))?;
    std::fs::write(&path, &json).map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;

    log::info!("[config] Saved user config for {} -> {}", meta.id, path.display());
    Ok(())
}

/// Reset a provider by deleting its user config file. Next load will use defaults.
pub fn reset_provider_to_defaults(provider_id: &str) -> Result<(), String> {
    let path = provider_user_config_path(provider_id);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Failed to remove {}: {}", path.display(), e))?;
        log::info!("[config] Reset {} — removed user config", provider_id);
    } else {
        log::info!("[config] {} already at defaults (no user config)", provider_id);
    }
    Ok(())
}

/// Persist all providers as individual per-provider config files.
pub fn persist_user_providers_meta(providers: &[ProviderConfig]) -> Result<(), String> {
    for p in providers {
        if p.template_type.is_empty() {
            continue;
        }
        let meta = ProviderMeta::from_config(p);
        save_provider_user_config(&meta)?;
    }
    Ok(())
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
        return Err(format!("Provider config has {} issue(s):\n{}", errors.len(), errors.join("\n")));
    }

    let config_directory = config_dir();
    std::fs::create_dir_all(&config_directory).map_err(|e| format!("Failed to create config dir: {}", e))?;

    for meta in &metas {
        save_provider_user_config(meta)?;
    }
    log::debug!("Saved {} provider(s)", metas.len());
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

// ── Provider Defaults Loading (disk-based, replaces disk defaults) ─

/// Convert a ProviderDefaultParam from disk defaults into a UserEditedTemplateParam.
fn user_edited_param_from_template(tp: &crate::templates::ProviderDefaultParam, order: i32) -> crate::types::UserEditedTemplateParam {
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

/// Load params for a provider from its disk-based default config.
pub fn params_for_provider(provider_id: &str) -> Vec<crate::types::UserEditedTemplateParam> {
    if let Some(template) = crate::templates::load_provider_defaults(provider_id) {
        template.params.iter()
            .enumerate()
            .map(|(i, tp)| user_edited_param_from_template(tp, i as i32))
            .collect()
    } else {
        log::warn!("[config] No default config found for provider '{}', returning empty params", provider_id);
        Vec::new()
    }
}

/// Discover providers from disk: scan runtime/ directory for default configs.
fn discover_providers() -> Vec<crate::types::ProviderConfig> {
    let mut providers = Vec::new();
    let app_root = app_root_dir();
    let binaries_dir = app_root.join("runtime");

    if !binaries_dir.exists() {
        log::warn!("[config] Runtime directory not found at {}", binaries_dir.display());
        return providers;
    }

    #[derive(serde::Deserialize)]
    struct ProviderIdentity {
        id: String,
        display_name: String,
        git_url: String,
        branch: String,
        template_type: String,
        #[serde(default)]
        build_profile: String,
    }

    for entry in std::fs::read_dir(&binaries_dir).into_iter().flatten().filter_map(|e| e.ok()) {
        if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            continue;
        }

        let pid = entry.file_name().to_string_lossy().to_string();
        let config_path = entry.path().join("config").join(format!("{}-default-config.json", pid));

        if !config_path.exists() {
            continue;
        }

        if let Ok(content) = std::fs::read_to_string(&config_path) {
            if let Ok(identity) = serde_json::from_str::<ProviderIdentity>(&content) {
                // Populate binary paths + build info from disk — check which profiles exist
                let mut per_env: HashMap<String, String> = HashMap::new();
                let mut build_info_per_env: HashMap<String, crate::types::BuildInfo> = HashMap::new();
                let mut main_binary = String::new();
                for profile in &["vanguard", "stable", "fresh"] {
                    let exe_path = entry.path().join(profile).join("llama-server.exe");
                    if exe_path.exists() {
                        per_env.insert(profile.to_string(), format!("runtime/{}/{}/llama-server.exe", pid, profile));
                        // Populate build_info from file metadata so UI shows profile as available
                        if let Ok(m) = std::fs::metadata(&exe_path) {
                            let date_str = m.modified().ok()
                                .map(|mt| DateTime::<Local>::from(mt).format("%Y-%m-%d %H:%M").to_string())
                                .unwrap_or_else(|| "unknown".to_string());
                            build_info_per_env.insert(profile.to_string(), crate::types::BuildInfo {
                                version: "disk-scanned".to_string(),
                                build_date: date_str,
                                cuda_version: None,
                            });
                        }
                        if main_binary.is_empty() {
                            main_binary = format!("runtime/{}/vanguard/llama-server.exe", pid);
                        }
                    }
                }

                providers.push(crate::types::ProviderConfig {
                    id: identity.id.clone(),
                    display_name: identity.display_name,
                    binary_path: main_binary,
                    enabled: true,
                    params: serde_json::json!({}),
                    user_edited_template_params: params_for_provider(&identity.id),
                    group_order: Vec::new(),
                    _original_id: None,
                    git_url: identity.git_url,
                    branch: identity.branch,
                    build_profile: identity.build_profile.clone(),
                    template_type: identity.template_type,
                    build_info_per_env,
                    binary_path_per_env: per_env,
                    downloaded_version_per_env: std::collections::HashMap::new(),
                    last_pr_per_env: std::collections::HashMap::new(),
                    display_order: providers.len() as i32,
                    factory_provided: true,
                });
            }
        }
    }

    providers.sort_by(|a, b| a.display_order.cmp(&b.display_order).then_with(|| a.id.cmp(&b.id)));
    for (i, p) in providers.iter_mut().enumerate() {
        p.display_order = i as i32;
    }

    log::info!("[config] Discovered {} provider(s) from disk", providers.len());
    providers
}

/// Map template_type to provider ID for loading defaults.
pub fn template_key_for_type(template_type: &str) -> Option<String> {
    match template_type {
        "ik-llama" => Some("ik".to_string()),
        "ggml-llama" => Some(DEFAULT_PROVIDER_ID.to_string()),
        _ => None,
    }
}

/// Resolve effective template type: use disk value if set, otherwise auto-detect from provider ID.
pub fn resolve_template_type(provider_id: &str, disk_type: Option<&String>) -> String {
    match disk_type.and_then(|t| if t.is_empty() { None } else { Some(t.clone()) }) {
        Some(t) => t,
        None => crate::templates::ProviderTemplate::template_type_for_id(provider_id),
    }
}

/// Backfill dock fields from provider defaults into user-edited params.
fn merge_template_dock(template_type: &str, user_edited_params: &mut Vec<crate::types::UserEditedTemplateParam>) {
    let Some(template_key) = template_key_for_type(template_type) else { return; };
    let Some(template) = crate::templates::load_provider_defaults(&template_key) else { return; };

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

/// Internal: Load config with bundled path resolution (called from setup).
pub fn load_config_with_app(_app_handle: &tauri::AppHandle) -> AppConfig {
    if let Some(saved) = load_saved_config() {
        let gpu_count = crate::telemetry::detect_gpu_count();
        build_config_with_providers_full(gpu_count, saved)
    } else {
        let gpu_count = crate::telemetry::detect_gpu_count();
        let fresh = build_fresh_config(MAX_ENGINE_SLOTS);
        build_config_with_providers_full(gpu_count, fresh)
    }
}

/// Tauri command: Load config from disk (no app handle needed for frontend queries).
#[tauri::command]
pub fn load_config() -> AppConfig {
    if let Some(saved) = load_saved_config() {
        let gpu_count = crate::telemetry::detect_gpu_count();
        return build_config_with_providers_full(gpu_count, saved);
    }

    let gpu_count = crate::telemetry::detect_gpu_count();
    let fresh = build_fresh_config(MAX_ENGINE_SLOTS);
    build_config_with_providers_full(gpu_count, fresh)
}


// ── Template Update Detection ───────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct TemplateDiff {
    /// New params added to the provider defaults (not in current config).
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
    let Some(template_key) = template_key_for_type(&template_type) else {
        log::info!("[check_template_update] {}: no template for type '{}', returning empty diff", provider_id, template_type);
        return Ok(TemplateDiff { new_params: Vec::new(), orphaned_params: Vec::new() });
    };

    let fresh_template = crate::templates::load_provider_defaults(&template_key).ok_or("Unknown provider")?;
    
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
    let p = resolve_path(path);
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
            path: config_dir().join("models").to_string_lossy().to_string(),
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
        .unwrap_or_else(|| config_dir().join("models").to_string_lossy().to_string())
}

pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let config_directory = config_dir();
    std::fs::create_dir_all(&config_directory).map_err(|e| format!("Failed to create config dir: {}", e))?;

    let config_path = config_directory.join("app_config.json");
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize app config: {}", e))?;

    std::fs::write(&config_path, json).map_err(|e| format!("Failed to write app config: {}", e))?;
    log::debug!("Saved app_config.json to {}", config_path.display());
    Ok(())
}

fn build_fresh_config(_gpu_slots: usize) -> AppConfig {
    let mut model_paths: Vec<ModelPathEntry> = Vec::new();

    model_paths.push(ModelPathEntry {
        path: config_dir().join("models").to_string_lossy().to_string(),
        label: "Default".to_string(),
        is_default: true,
    });

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
        model_paths,
        prefs_file: PathBuf::new(),
        base_port: 9090,
        gpu_slots: MAX_ENGINE_SLOTS,
        hf_token: String::new(),
        providers: Vec::new(),
    }
}

fn load_saved_config() -> Option<AppConfig> {
    let config_path = config_dir().join("app_config.json");
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

    let meta_map: std::collections::HashMap<_, _> = metas.iter()
        .map(|m| (m.id.clone(), m))
        .collect();
    let metas_clone = metas.clone();

    let mut providers = Vec::new();

    // Disk-based provider discovery replaces disk-based discovery
    for provider in discover_providers() {
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
            if !meta.binary_path_per_env.is_empty() {
                p.binary_path_per_env = meta.binary_path_per_env.clone();
            }
            if !meta.downloaded_version_per_env.is_empty() {
                p.downloaded_version_per_env = meta.downloaded_version_per_env.clone();
            }
            if !meta.group_order.is_empty() {
                p.group_order = meta.group_order.clone();
            }
            if !meta.last_pr_per_env.is_empty() {
                p.last_pr_per_env = meta.last_pr_per_env.clone();
            }
            // Always override — user's explicit choice survives restart
            p.enabled = meta.enabled;
            p.display_order = meta.display_order;
            if !meta.template_type.is_empty() {
                p.template_type = meta.template_type.clone();
            }
        }
        providers.push(p);
    }

    // Custom/user-created providers not found in runtime/ defaults
    for meta in metas_clone {
        if !providers.iter().any(|p| p.id == meta.id) {
            let resolved_type = resolve_template_type(&meta.id, Some(&meta.template_type));
            let tmpl_key = template_key_for_type(&resolved_type);
        let user_edited_params = if !meta.user_edited_template_params.is_empty() {
                  meta.user_edited_template_params.clone()
            } else if let Some(ref key) = tmpl_key {
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
                downloaded_version_per_env: meta.downloaded_version_per_env,
                last_pr_per_env: meta.last_pr_per_env,
                display_order: meta.display_order,
                factory_provided: false,
            });
        }
    }

    providers.sort_by(|a, b| a.display_order.cmp(&b.display_order).then_with(|| a.id.cmp(&b.id)));
    for (i, p) in providers.iter_mut().enumerate() {
        p.display_order = i as i32;
    }

    config.providers = providers;
    config.gpu_slots = MAX_ENGINE_SLOTS;

    config
}
