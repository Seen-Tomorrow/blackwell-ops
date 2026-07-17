//! Provider configuration — three-layer model and template merge.
//!
//! ## Layers
//! 1. **Factory** — `runtime/<id>/config/<id>-default-config.json` (admin, read-only at runtime)
//! 2. **User disk** — `config/<id>-user-config.json` (hidden, order, defaults, custom params/values)
//! 3. **localStorage** — `BlackOps-catalog-override:<id>` (launch-time chip selections; frontend only)
//!
//! ## Merge (`merge_template_for_provider`)
//! Runs on every load and `save_provider`. Factory structural fields backfill; user cosmetic choices
//! (hidden, userHidden, order, userAddedValues, hidden_values, values) are never overwritten.
//!
//! ## RESET TO DEFAULTS
//! Deletes user config file + frontend clears overrides and group-order localStorage. Full factory wipe.
//!
//! ## Validation
//! `save_provider` and `save_user_providers_meta` block-save on invalid params (orphan defaults,
//! missing flags, duplicate keys).

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{Manager, path::BaseDirectory};

use crate::types::{ModelLibraryValidation, ModelPathEntry, PathDiskUsage, ProviderConfig};

/// Hard ceiling for engine stack size — individual providers may declare lower limits in spawn_profile.
pub const ABSOLUTE_MAX_ENGINE_SLOTS: usize = 128;

/// Default provider ID — bundled with the app, always present.
pub const DEFAULT_PROVIDER_ID: &str = "ggml-master";

/// Removed from factory/runtime — dropped from discovery and user meta on load.
pub const PHASED_OUT_PROVIDER_IDS: &[&str] = &["ik"];

pub fn is_phased_out_provider(id: &str) -> bool {
    PHASED_OUT_PROVIDER_IDS
        .iter()
        .any(|p| p.eq_ignore_ascii_case(id))
}

/// Default runtime binary profile when none is selected (fresh install / empty slot).
pub const DEFAULT_BINARY_PROFILE: &str = "frontier";

/// FIT library + on-demand scans always use the frontier toolchain build.
pub const FIT_SCAN_BINARY_PROFILE: &str = "frontier";

/// App root directory — parent of the running executable (portable).
/// DEV: target/debug/ or target/release/ during development.
/// REL: wherever the user installed/unzipped the app.
pub fn app_root_dir() -> std::path::PathBuf {
    std::env::current_exe()
        .map(|p| p.parent().unwrap().to_path_buf())
        .unwrap_or_else(|_| std::env::current_dir().unwrap())
}

/// User data directory: config/ — same in DEV and REL.
pub fn config_dir() -> std::path::PathBuf {
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

/// Copy factory `*-default-config.json` files from `source/<provider>/config/` into app_root runtime.
fn copy_factory_config_jsons(source: &std::path::Path, app_root: &std::path::Path) -> usize {
    if !source.is_dir() {
        return 0;
    }

    let mut copied = 0usize;
    for entry in std::fs::read_dir(source).into_iter().flatten().filter_map(|e| e.ok()) {
        if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            continue;
        }
        let src_config = entry.path().join("config");
        if !src_config.is_dir() {
            continue;
        }
        let dst_config = app_root.join("runtime").join(entry.file_name()).join("config");
        if let Err(e) = std::fs::create_dir_all(&dst_config) {
            log::warn!("[setup] Failed to create {}: {}", dst_config.display(), e);
            continue;
        }
        for cfg_entry in std::fs::read_dir(&src_config).into_iter().flatten().filter_map(|e| e.ok()) {
            let path = cfg_entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let dst = dst_config.join(cfg_entry.file_name());
            match std::fs::copy(&path, &dst) {
                Ok(_) => copied += 1,
                Err(e) => log::warn!("[setup] Failed to copy {}: {}", path.display(), e),
            }
        }
    }
    copied
}

/// DEV only: refresh `runtime/<provider>/config/*.json` from `src-tauri/runtime` so spawn_profile edits
/// (e.g. max_engine_slots, templateVersion) apply without re-running predev or wiping mirrored binaries.
#[cfg(debug_assertions)]
fn sync_dev_runtime_factory_configs(app_root: &std::path::Path) {
    let source = app_root.join("../../runtime");
    if !source.is_dir() {
        log::debug!(
            "[setup] Dev factory config sync skipped — source not found at {}",
            source.display()
        );
        return;
    }

    let copied = copy_factory_config_jsons(&source, app_root);
    if copied > 0 {
        log::info!(
            "[setup] Dev: synced {} factory config JSON file(s) from {}",
            copied,
            source.display()
        );
    }
}

fn sync_plugin_catalog_tree(source: &std::path::Path, app_root: &std::path::Path, label: &str) -> bool {
    // Accept source layouts:
    //   {source}/catalog/plugins.json  (legacy pack layout under runtime/)
    //   {source}/plugins.json          (flat)
    //   {source}/runtime-catalog/plugins.json
    let candidates = [
        source.join("catalog"),
        source.join("runtime-catalog"),
        source.to_path_buf(),
    ];
    let src_catalog = candidates.into_iter().find(|p| {
        p.join("plugins.json").is_file() || p.is_dir() && p.join("plugins.json").exists()
    });
    let Some(src_catalog) = src_catalog else {
        // Also accept file directly
        let direct = source.join("plugins.json");
        if !direct.is_file() {
            log::debug!(
                "[setup] Plugin catalog sync skipped ({label}) — no plugins.json under {}",
                source.display()
            );
            return false;
        }
        let dst = app_root.join("runtime-catalog");
        if let Err(e) = std::fs::create_dir_all(&dst) {
            log::warn!("[setup] Plugin catalog dir create failed ({label}): {e}");
            return false;
        }
        return match std::fs::copy(&direct, dst.join("plugins.json")) {
            Ok(_) => {
                log::info!(
                    "[setup] Synced plugin catalog ({label}) -> {}",
                    dst.join("plugins.json").display()
                );
                true
            }
            Err(e) => {
                log::warn!("[setup] Plugin catalog sync failed ({label}): {e}");
                false
            }
        };
    };

    let plugins_src = if src_catalog.join("plugins.json").is_file() {
        src_catalog.join("plugins.json")
    } else {
        log::debug!(
            "[setup] Plugin catalog sync skipped ({label}) — no plugins.json in {}",
            src_catalog.display()
        );
        return false;
    };

    let dst_dir = app_root.join("runtime-catalog");
    if let Err(e) = std::fs::create_dir_all(&dst_dir) {
        log::warn!("[setup] Plugin catalog dir create failed ({label}): {e}");
        return false;
    }
    let dst = dst_dir.join("plugins.json");
    match std::fs::copy(&plugins_src, &dst) {
        Ok(_) => {
            log::info!("[setup] Synced plugin catalog ({label}) -> {}", dst.display());
            true
        }
        Err(e) => {
            log::warn!("[setup] Plugin catalog sync failed ({label}): {e}");
            false
        }
    }
}

#[cfg(debug_assertions)]
fn sync_dev_plugin_catalog(app_root: &std::path::Path) {
    // Prefer repo runtime-catalog/, then legacy runtime/catalog/
    let repo_runtime = app_root.join("../../runtime");
    let preferred = app_root.join("../../runtime-catalog");
    if preferred.join("plugins.json").is_file() || preferred.is_dir() {
        if sync_plugin_catalog_tree(&preferred, app_root, "dev-runtime-catalog") {
            return;
        }
    }
    if repo_runtime.is_dir() {
        let _ = sync_plugin_catalog_tree(&repo_runtime, app_root, "dev");
    }
}

/// REL: refresh factory config JSON from bundled resources on every launch so templateVersion
/// bumps ship to existing installs (runtime/ binaries are not re-copied once present).
#[cfg(not(debug_assertions))]
fn sync_runtime_factory_configs_from_resources(
    app_handle: &tauri::AppHandle,
    app_root: &std::path::Path,
) {
    let resource_path = match app_handle.path().resolve("runtime", BaseDirectory::Resource) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[setup] Factory config sync skipped — runtime resource unavailable: {}", e);
            return;
        }
    };

    if !resource_path.exists() {
        log::debug!(
            "[setup] Factory config sync skipped — no runtime resource at {}",
            resource_path.display()
        );
        return;
    }

    let copied = copy_factory_config_jsons(&resource_path, app_root);
    if copied > 0 {
        log::info!(
            "[setup] Synced {} factory config JSON file(s) from bundled runtime",
            copied
        );
    }
    sync_plugin_catalog_tree(&resource_path, app_root, "bundled runtime");
}

/// Ensure the portable directory structure exists. Copy bundled binaries from resources on first run (REL only).
pub fn ensure_portable_structure(app_handle: &tauri::AppHandle) {
    let root = app_root_dir();
    let data = config_dir();

    #[cfg(debug_assertions)]
    {
        sync_dev_runtime_factory_configs(&root);
        sync_dev_plugin_catalog(&root);
    }
    #[cfg(not(debug_assertions))]
    sync_runtime_factory_configs_from_resources(app_handle, &root);

    // Create directories
    let _ = std::fs::create_dir_all(&data);
    let _ = std::fs::create_dir_all(default_models_dir());
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
    /// Factory param keys removed by admin — merge will not re-append from template.
    #[serde(default, rename = "excludedParamKeys", skip_serializing_if = "Vec::is_empty")]
    pub excluded_param_keys: Vec<String>,
    /// Custom group order set by user (overrides template insertion order). Empty = use template order.
    #[serde(default, rename = "groupOrder")]
    pub group_order: Vec<String>,
    #[serde(default, rename = "groupDisplayZone", skip_serializing_if = "HashMap::is_empty")]
    pub group_display_zone: HashMap<String, String>,
    #[serde(default, rename = "configColumnCount", skip_serializing_if = "Option::is_none")]
    pub config_column_count: Option<u8>,
    #[serde(default, rename = "configColumnWidths", skip_serializing_if = "Vec::is_empty")]
    pub config_column_widths: Vec<f64>,
    #[serde(default, rename = "groupColumn", skip_serializing_if = "HashMap::is_empty")]
    pub group_column: HashMap<String, u32>,
    #[serde(default, rename = "aboveColumnWidths", skip_serializing_if = "Vec::is_empty")]
    pub above_column_widths: Vec<f64>,
    /// Per-environment build info captured from binary --version + file mtime.
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "buildInfoPerEnv")]
    pub build_info_per_env: HashMap<String, crate::types::BuildInfo>,
    /// Active launch path per profile (resolved).
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "binaryPathPerEnv")]
    pub binary_path_per_env: HashMap<String, String>,
    /// User preference: `foundry` | `bundled`.
    #[serde(default, skip_serializing_if = "HashMap::is_empty", rename = "binarySourcePerEnv")]
    pub binary_source_per_env: HashMap<String, String>,
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
    /// Template version from default config — synced to user meta on merge.
    #[serde(default = "crate::types::default_template_version", rename = "templateVersion")]
    pub template_version: u32,
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
            excluded_param_keys: p.excluded_param_keys.clone(),
            group_order: p.group_order.clone(),
            group_display_zone: p.group_display_zone.clone(),
            config_column_count: p.config_column_count,
            config_column_widths: p.config_column_widths.clone(),
            group_column: p.group_column.clone(),
            above_column_widths: p.above_column_widths.clone(),
            template_type: p.template_type.clone(),
            build_info_per_env: p.build_info_per_env.clone(),
            binary_path_per_env: p.binary_path_per_env.iter().map(|(k, v)| (k.clone(), to_relative_path(&PathBuf::from(v)))).collect(),
            binary_source_per_env: p.binary_source_per_env.clone(),
            downloaded_version_per_env: p.downloaded_version_per_env.clone(),
            last_pr_per_env: p.last_pr_per_env.clone(),
            display_order: p.display_order,
            factory_provided: p.factory_provided,
            template_version: p.template_version,
        }
    }
}

fn default_providers() -> Vec<ProviderConfig> { Vec::new() }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub model_paths: Vec<ModelPathEntry>,
    /// Legacy field — engine slot count comes from provider `spawn_profile.max_engine_slots`. Ignored at runtime.
    #[serde(default)]
    pub gpu_slots: usize,
    /// HuggingFace API token — stored in app_config.json. Empty string if not set.
    #[serde(default)]
    pub hf_token: String,
    #[serde(default = "default_providers", skip_serializing)]
    pub providers: Vec<ProviderConfig>,
    /// Where downloads go — derived from the default model path.
    #[serde(default)]
    pub default_download_path: Option<String>,
    /// First-run onboarding checklist finished — persisted so config wipe can replay the wizard.
    #[serde(default)]
    pub setup_completed: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        let entry = default_model_path_entry();
        Self {
            model_paths: vec![entry.clone()],
            gpu_slots: 0,
            hf_token: String::new(),
            providers: Vec::new(),
            default_download_path: Some(entry.path),
            setup_completed: false,
        }
    }
}

// ── Per-Provider User Config Persistence ────────────────────────────

/// Get the user config file path for a provider.
pub fn provider_user_config_path(provider_id: &str) -> PathBuf {
    config_dir().join(format!("{}-user-config.json", provider_id))
}

/// Factory default config JSON on disk (runtime mirror).
pub fn factory_default_config_path(provider_id: &str) -> PathBuf {
    app_root_dir()
        .join("runtime")
        .join(provider_id)
        .join("config")
        .join(format!("{provider_id}-default-config.json"))
}

#[cfg(debug_assertions)]
fn dev_factory_default_config_source_path(provider_id: &str) -> Option<PathBuf> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("runtime")
        .join(provider_id)
        .join("config")
        .join(format!("{provider_id}-default-config.json"));
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

fn apply_factory_layout_defaults(
    provider: &mut crate::types::ProviderConfig,
    factory_key: &str,
) {
    let (factory_group_order, factory_layout) =
        crate::templates::load_factory_layout_supplement(factory_key);
    if provider.group_order.is_empty() && !factory_group_order.is_empty() {
        provider.group_order = factory_group_order
            .into_iter()
            .map(|g| normalize_ui_group(&g))
            .collect();
    }
    if provider.group_display_zone.is_empty() && !factory_layout.group_display_zone.is_empty() {
        provider.group_display_zone = factory_layout.group_display_zone.clone();
    }
    if provider.config_column_count.is_none() && factory_layout.config_column_count > 0 {
        provider.config_column_count = Some(factory_layout.config_column_count.clamp(1, 3));
    }
    if provider.config_column_widths.is_empty() && !factory_layout.config_column_widths.is_empty() {
        provider.config_column_widths = factory_layout.config_column_widths.clone();
    }
    if provider.group_column.is_empty() && !factory_layout.group_column.is_empty() {
        provider.group_column = factory_layout.group_column.clone();
    }
    if provider.above_column_widths.is_empty() && !factory_layout.above_column_widths.is_empty() {
        provider.above_column_widths = factory_layout.above_column_widths.clone();
    }
}

fn apply_meta_layout_overrides(
    provider: &mut crate::types::ProviderConfig,
    meta: &ProviderMeta,
    factory_key: &str,
) {
    if !meta.group_order.is_empty() {
        provider.group_order = meta.group_order.clone();
    } else {
        apply_factory_layout_defaults(provider, factory_key);
        return;
    }
    if !meta.group_display_zone.is_empty() {
        provider.group_display_zone = meta.group_display_zone.clone();
    }
    if meta.config_column_count.is_some() {
        provider.config_column_count = meta.config_column_count;
    }
    if !meta.config_column_widths.is_empty() {
        provider.config_column_widths = meta.config_column_widths.clone();
    }
    if !meta.group_column.is_empty() {
        provider.group_column = meta.group_column.clone();
    }
    if !meta.above_column_widths.is_empty() {
        provider.above_column_widths = meta.above_column_widths.clone();
    }
    if provider.group_display_zone.is_empty()
        || provider.config_column_count.is_none()
        || provider.config_column_widths.is_empty()
        || provider.group_column.is_empty()
        || provider.above_column_widths.is_empty()
    {
        let (_, factory_layout) = crate::templates::load_factory_layout_supplement(factory_key);
        if provider.group_display_zone.is_empty() && !factory_layout.group_display_zone.is_empty() {
            provider.group_display_zone = factory_layout.group_display_zone;
        }
        if provider.config_column_count.is_none() && factory_layout.config_column_count > 0 {
            provider.config_column_count = Some(factory_layout.config_column_count.clamp(1, 3));
        }
        if provider.config_column_widths.is_empty() && !factory_layout.config_column_widths.is_empty() {
            provider.config_column_widths = factory_layout.config_column_widths;
        }
        if provider.group_column.is_empty() && !factory_layout.group_column.is_empty() {
            provider.group_column = factory_layout.group_column;
        }
        if provider.above_column_widths.is_empty() && !factory_layout.above_column_widths.is_empty() {
            provider.above_column_widths = factory_layout.above_column_widths;
        }
    }
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
    // Compare numbers by numeric equality (1 == 1.0), everything else by canonical string
    if let (Some(na), Some(nb)) = (a.as_f64(), b.as_f64()) {
        na == nb
    } else {
        serde_json::to_string(a).ok() == serde_json::to_string(b).ok()
    }
}

/// Validate all params for a single provider. Returns human-readable error lines (empty = ok).
pub fn validate_provider_params(provider_id: &str, params: &[crate::types::UserEditedTemplateParam]) -> Vec<String> {
    let mut errors = Vec::new();
    let mut seen_keys: std::collections::HashMap<&str, i32> = std::collections::HashMap::new();
    for ep in params {
        if let Some(&prev_order) = seen_keys.get(ep.key.as_str()) {
            errors.push(format!(
                "provider '{}': duplicate param key '{}' (order {} and {})",
                provider_id, ep.key, prev_order, ep.order
            ));
        } else {
            seen_keys.insert(&ep.key, ep.order);
        }
        for e in validate_user_edited_param(ep) {
            errors.push(format!("provider '{}' param '{}': {}", provider_id, ep.key, e));
        }
    }
    errors
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
        "arg_select", "arg_select_double", "slider", "switch_onoff", "switch_inverted", "path_scanner", "logic_only", "",
    ];
    if !VALID_PTYPES.contains(&ep.ptype.as_str()) {
        errors.push(format!("invalid ptype '{}' (valid: {:?})", ep.ptype, VALID_PTYPES));
    }

    // flag required for arg_select/slider, flag_pair for arg_select_double
    let needs_flag = ep.ptype == "arg_select" || ep.ptype == "slider";
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
        user_hidden: false,
        hidden_values: Vec::new(),
        flag: tp.flag.clone(),
        flag_pair: tp.flag_pair.clone(),
        ptype: tp.ptype.clone(),
        step: tp.step,
        ui_group: normalize_ui_group(&tp.ui_group),
        note: tp.note.clone(),
        pattern: tp.pattern.clone(),
        default_value: tp.default.clone(),
        user_added_values: Vec::new(),
        factory_default: tp.default.clone(),
        sub_params,
        dock: tp.dock.clone(),
        essential: None,
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

/// Fresh-install provider table order — user `display_order` from CONFIG overrides after reorder.
fn factory_provider_rank(id: &str) -> i32 {
    match id {
        id if id == DEFAULT_PROVIDER_ID => 0,
        "ggml-tom" => 1,
        _ => 2,
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
        /// Template version — bumped in default config JSON when template changes.
        #[serde(default = "default_tv", rename = "templateVersion")]
        template_version: u32,
        /// Optional fork — templates via App update; engines via provider pack (not NSIS core).
        #[serde(default, rename = "optionalDownload")]
        optional_download: bool,
    }

    fn default_tv() -> u32 { 1 }

    for entry in std::fs::read_dir(&binaries_dir).into_iter().flatten().filter_map(|e| e.ok()) {
        if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            continue;
        }

        let pid = entry.file_name().to_string_lossy().to_string();
        if is_phased_out_provider(&pid) {
            continue;
        }
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
                for profile in crate::foundry_toolchain::profile_ids_or_default() {
                    let exe_path = entry.path().join(&profile).join("llama-server.exe");
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
                                cuda_architectures: None,
                            });
                        }
                        let rel = format!("runtime/{}/{}/llama-server.exe", pid, profile);
                        if profile == DEFAULT_BINARY_PROFILE {
                            main_binary = rel;
                        } else if main_binary.is_empty() {
                            main_binary = rel;
                        }
                    }
                }

                // Catalog plugins: not in PROVIDERS until a pack (or Foundry) installs binaries.
                if identity.optional_download && per_env.is_empty() {
                    log::debug!(
                        "[config] Skipping catalog plugin '{}' (not installed — see UPDATES catalog)",
                        pid
                    );
                    continue;
                }

                let mut discovered = crate::types::ProviderConfig {
                    id: identity.id.clone(),
                    display_name: identity.display_name,
                    binary_path: main_binary,
                    enabled: true,
                    params: serde_json::json!({}),
                    user_edited_template_params: params_for_provider(&identity.id),
                    excluded_param_keys: Vec::new(),
                    group_order: Vec::new(),
                    group_display_zone: HashMap::new(),
                    config_column_count: None,
                    config_column_widths: Vec::new(),
                    group_column: HashMap::new(),
                    above_column_widths: Vec::new(),
                    _original_id: None,
                    git_url: identity.git_url,
                    branch: identity.branch,
                    build_profile: identity.build_profile.clone(),
                    template_type: identity.template_type,
                    build_info_per_env,
                    binary_path_per_env: per_env,
                    binary_source_per_env: HashMap::new(),
                    bundled_binary_path_per_env: HashMap::new(),
                    foundry_binary_path_per_env: HashMap::new(),
                    catalog_binary_path_per_env: HashMap::new(),
                    bundled_build_info_per_env: HashMap::new(),
                    foundry_build_info_per_env: HashMap::new(),
                    catalog_build_info_per_env: HashMap::new(),
                    downloaded_version_per_env: std::collections::HashMap::new(),
                    last_pr_per_env: std::collections::HashMap::new(),
                    display_order: providers.len() as i32,
                    factory_provided: true,
                    optional_download: identity.optional_download,
                    template_version: identity.template_version,
                    needs_template_attention: false,
                    launch_profile: crate::templates::load_provider_defaults(&identity.id)
                        .map(|t| crate::types::LaunchProfile::from_spawn_profile(&t.spawn_profile))
                        .unwrap_or_default(),
                };
                apply_factory_layout_defaults(&mut discovered, &identity.id);
                providers.push(discovered);
            }
        }
    }

    providers.sort_by(|a, b| {
        factory_provider_rank(&a.id)
            .cmp(&factory_provider_rank(&b.id))
            .then_with(|| a.display_order.cmp(&b.display_order))
            .then_with(|| a.id.cmp(&b.id))
    });
    for (i, p) in providers.iter_mut().enumerate() {
        p.display_order = i as i32;
    }

    log::info!("[config] Discovered {} provider(s) from disk", providers.len());
    providers
}

/// Map template_type to provider ID for loading defaults.
pub fn template_key_for_type(template_type: &str) -> Option<String> {
    match template_type {
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

/// Resolve a catalog `.gguf` path and ensure it lives under a configured model library root.
pub fn validate_model_library_file(path: &str, config: &AppConfig) -> Result<PathBuf, String> {
    let resolved = resolve_model_path(path);
    if resolved.is_empty() {
        return Err("Empty model path".into());
    }
    let pb = PathBuf::from(&resolved);
    if !pb.is_file() {
        return Err(format!("Model file not found: {}", pb.display()));
    }
    if !pb
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("gguf"))
        .unwrap_or(false)
    {
        return Err("Only .gguf model files can be edited from the catalog".into());
    }

    let file_canon = pb
        .canonicalize()
        .map_err(|e| format!("Cannot resolve model file path: {e}"))?;

    for root in download_dest_roots(config) {
        let root_resolved = resolve_path(root.to_string_lossy().as_ref());
        if root_resolved.as_os_str().is_empty() {
            continue;
        }
        let Ok(root_canon) = root_resolved.canonicalize() else {
            continue;
        };
        if file_canon.starts_with(&root_canon) {
            return Ok(pb);
        }
    }

    Err("Model file must be under a configured model library path".into())
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

/// Default model library folder — relative to app root (`<app>/models/`).
pub const DEFAULT_MODEL_PATH_REL: &str = "models";

const DEFAULT_MODEL_PATH_LABEL: &str = "Models";

const LM_STUDIO_PATH_LABEL: &str = "LM Studio";

/// Portable LM Studio models folder — expanded at runtime via `expand_path_placeholders`.
pub fn lm_studio_model_path_template() -> &'static str {
    #[cfg(windows)]
    {
        r"%USERPROFILE%\.lmstudio\models"
    }
    #[cfg(not(windows))]
    {
        "~/.lmstudio/models"
    }
}

/// Expand `~`, `%USERPROFILE%`, and other `%VAR%` segments in stored model paths.
pub fn expand_path_placeholders(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let mut expanded = trimmed.to_string();
    if expanded == "~" {
        if let Some(home) = user_home_dir() {
            return home.to_string_lossy().to_string();
        }
    } else if let Some(rest) = expanded.strip_prefix("~/") {
        if let Some(home) = user_home_dir() {
            return home.join(rest).to_string_lossy().to_string();
        }
    } else if let Some(rest) = expanded.strip_prefix("~\\") {
        if let Some(home) = user_home_dir() {
            return home.join(rest).to_string_lossy().to_string();
        }
    }

    loop {
        let Some(start) = expanded.find('%') else { break };
        let rest = &expanded[start + 1..];
        let Some(end) = rest.find('%') else { break };
        let var_name = &rest[..end];
        let replacement = std::env::var(var_name).unwrap_or_default();
        let end_idx = start + 1 + end + 1;
        expanded = format!("{}{}{}", &expanded[..start], replacement, &expanded[end_idx..]);
    }

    expanded
}

fn user_home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

/// Expanded default LM Studio models folder for display (no `%USERPROFILE%` placeholders).
pub fn lm_studio_default_path_display() -> String {
    let template = lm_studio_model_path_template();
    let resolved = resolve_stored_model_path(template);
    if resolved.is_empty() {
        expand_path_placeholders(template)
    } else {
        resolved
    }
}

/// True when the standard LM Studio models directory exists on this machine.
pub fn lm_studio_models_available() -> bool {
    validate_model_library(lm_studio_model_path_template()).gguf_count > 0
}

/// Probe a model library folder — exists on disk and contains at least one `.gguf`.
pub fn validate_model_library(path: &str) -> ModelLibraryValidation {
    let resolved = resolve_stored_model_path(path);
    if resolved.is_empty() {
        return ModelLibraryValidation {
            exists: false,
            gguf_count: 0,
            resolved_path: String::new(),
        };
    }
    let dir = std::path::Path::new(&resolved);
    if !dir.is_dir() {
        return ModelLibraryValidation {
            exists: false,
            gguf_count: 0,
            resolved_path: resolved,
        };
    }
    ModelLibraryValidation {
        exists: true,
        gguf_count: crate::model_catalog::count_gguf_files(dir),
        resolved_path: resolved,
    }
}

fn entry_has_models(entry: &ModelPathEntry) -> bool {
    if is_factory_placeholder_entry(entry) {
        return false;
    }
    validate_model_library(&entry.path).gguf_count > 0
}

/// Add the portable LM Studio models path when the folder exists and contains GGUF models.
pub fn add_lmstudio_model_path(config: &mut AppConfig) -> Result<bool, String> {
    let template = lm_studio_model_path_template();
    let validation = validate_model_library(template);
    if !validation.exists {
        let display_path = if validation.resolved_path.is_empty() {
            lm_studio_default_path_display()
        } else {
            validation.resolved_path.clone()
        };
        return Err(format!(
            "LM Studio models folder not found at {display_path}. Use Browse to pick your library."
        ));
    }
    if validation.gguf_count == 0 {
        return Err(format!(
            "No GGUF models found in {}. LM Studio may use a custom folder — use Browse to pick it.",
            validation.resolved_path
        ));
    }
    if find_model_path_index(config.model_paths.as_slice(), template).is_some() {
        return Ok(false);
    }
    if !validation.resolved_path.is_empty()
        && find_model_path_index(config.model_paths.as_slice(), &validation.resolved_path).is_some()
    {
        return Ok(false);
    }
    config.model_paths.push(ModelPathEntry {
        path: template.to_string(),
        label: LM_STUDIO_PATH_LABEL.to_string(),
        is_default: false,
    });
    Ok(true)
}

fn default_model_path_entry() -> ModelPathEntry {
    ModelPathEntry {
        path: DEFAULT_MODEL_PATH_REL.to_string(),
        label: DEFAULT_MODEL_PATH_LABEL.to_string(),
        is_default: true,
    }
}

/// Factory-seeded `<app>/models` entry — not a user-configured library for onboarding.
pub fn is_factory_placeholder_entry(entry: &ModelPathEntry) -> bool {
    entry.label == DEFAULT_MODEL_PATH_LABEL
        && model_path_key(&entry.path) == model_path_key(DEFAULT_MODEL_PATH_REL)
}

/// True when the user has linked a library that exists and contains GGUF models.
pub fn model_library_configured(config: &AppConfig) -> bool {
    config.model_paths.iter().any(entry_has_models)
}

/// Absolute path to the default bundled model directory.
pub fn default_models_dir() -> PathBuf {
    resolve_path(DEFAULT_MODEL_PATH_REL)
}

fn is_absolute_model_path(path: &str) -> bool {
    let trimmed = path.trim();
    trimmed.starts_with(r"\\")
        || trimmed.starts_with('/')
        || (trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':')
}

/// Resolve a stored model path for catalog scan and display (relative → app root).
pub fn resolve_stored_model_path(path: &str) -> String {
    let expanded = expand_path_placeholders(path);
    let trimmed = strip_windows_extended_prefix(expanded.trim());
    if trimmed.is_empty() {
        return String::new();
    }
    let candidate = if is_absolute_model_path(&trimmed) {
        PathBuf::from(&trimmed)
    } else {
        resolve_path(&trimmed)
    };
    resolve_model_path(&candidate.to_string_lossy())
}

/// Short catalog badge for a configured model library — `parent/models` from the resolved path.
pub fn format_catalog_source_path_label(stored_path: &str) -> String {
    let resolved = resolve_stored_model_path(stored_path);
    if resolved.is_empty() {
        return String::new();
    }

    let path = std::path::Path::new(&resolved);
    let normals: Vec<String> = path
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();

    match normals.len() {
        0 => String::new(),
        1 => {
            let leaf = &normals[0];
            if let Some(drive) = path
                .components()
                .find_map(|c| match c {
                    std::path::Component::Prefix(p) => {
                        Some(p.as_os_str().to_string_lossy().trim_end_matches(':').to_string())
                    }
                    _ => None,
                })
            {
                format!("{}/{}", drive, leaf)
            } else {
                leaf.clone()
            }
        }
        _ => {
            let leaf = &normals[normals.len() - 1];
            let parent = &normals[normals.len() - 2];
            format!("{}/{}", parent, leaf)
        }
    }
}

fn uses_path_placeholders(path: &str) -> bool {
    let trimmed = path.trim();
    trimmed.contains('%') || trimmed.starts_with("~/") || trimmed.starts_with("~\\") || trimmed == "~"
}

fn normalize_stored_model_path(original: &str, resolved: &str) -> String {
    if uses_path_placeholders(original) {
        original.trim().to_string()
    } else {
        to_relative_path(&PathBuf::from(resolved))
    }
}

/// Strip Windows extended-length prefix (`\\?\` / `\\?\UNC\`) for human-readable storage/display.
fn strip_windows_extended_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// Normalize a model path for dedup comparison (case-insensitive on Windows, no trailing slashes).
/// Relative entries like `models` resolve against app root — same as `resolve_stored_model_path`.
pub fn model_path_key(path: &str) -> String {
    let resolved = resolve_stored_model_path(path);
    if resolved.is_empty() {
        return String::new();
    }
    let s = strip_windows_extended_prefix(&resolved)
        .trim_end_matches(['\\', '/'])
        .to_string();
    #[cfg(windows)]
    {
        s.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        s
    }
}

/// Stable on-disk cache key for a model `.gguf` file.
/// Canonicalizes when the file exists so config path remove/re-add still hits cache.
pub fn model_file_cache_key(path: &str) -> String {
    resolve_model_path(path)
}

/// Resolve to canonical stored path when the directory exists.
pub fn resolve_model_path(path: &str) -> String {
    let trimmed = strip_windows_extended_prefix(path.trim());
    if trimmed.is_empty() {
        return String::new();
    }
    let pb = std::path::PathBuf::from(&trimmed);
    let resolved = if pb.exists() {
        pb.canonicalize()
            .map(|p| strip_windows_extended_prefix(&p.to_string_lossy()))
            .unwrap_or(trimmed)
    } else {
        trimmed
    };
    resolved.trim_end_matches(['\\', '/']).to_string()
}

fn find_model_path_index(paths: &[ModelPathEntry], path: &str) -> Option<usize> {
    let key = model_path_key(path);
    if key.is_empty() {
        return None;
    }
    paths.iter().position(|p| model_path_key(&p.path) == key)
}

/// Collapse duplicate model paths (same folder, different strings). Returns true if anything changed.
fn dedupe_model_paths(paths: &mut Vec<ModelPathEntry>) -> bool {
    let before = paths.clone();
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut deduped: Vec<ModelPathEntry> = Vec::new();

    for entry in paths.drain(..) {
        let key = model_path_key(&entry.path);
        if key.is_empty() {
            continue;
        }
        if let Some(&idx) = seen.get(&key) {
            let existing = &mut deduped[idx];
            if entry.is_default {
                existing.is_default = true;
            }
            if existing.label.is_empty() && !entry.label.is_empty() {
                existing.label = entry.label.clone();
            }
            let resolved = resolve_stored_model_path(&entry.path);
            if std::path::Path::new(&resolved).exists() {
                existing.path = normalize_stored_model_path(&entry.path, &resolved);
            }
        } else {
            let mut normalized = entry;
            let resolved = resolve_stored_model_path(&normalized.path);
            normalized.path = normalize_stored_model_path(&normalized.path, &resolved);
            seen.insert(key, deduped.len());
            deduped.push(normalized);
        }
    }

    let changed = deduped.len() != before.len()
        || deduped.iter().zip(before.iter()).any(|(a, b)| {
            a.path != b.path || a.is_default != b.is_default || a.label != b.label
        });
    *paths = deduped;
    changed
}

pub fn get_model_paths(config: &AppConfig) -> Vec<ModelPathEntry> {
    config
        .model_paths
        .iter()
        .map(|p| ModelPathEntry {
            path: resolve_stored_model_path(&p.path),
            label: p.label.clone(),
            is_default: p.is_default,
        })
        .collect()
}

pub fn add_model_path(config: &mut AppConfig, path: String, label: Option<String>) {
    let resolved = resolve_stored_model_path(&path);
    if resolved.is_empty() || find_model_path_index(&config.model_paths, &resolved).is_some() {
        return;
    }
    let stored_path = normalize_stored_model_path(&path, &resolved);
    let computed_label = label.unwrap_or_else(|| format_catalog_source_path_label(&path));
    let is_default = config.model_paths.is_empty();
    config.model_paths.push(ModelPathEntry {
        path: stored_path,
        label: computed_label,
        is_default,
    });
    // Update the memo if this is the first path (making it default)
    if is_default {
        config.default_download_path = Some(config.model_paths.last().unwrap().path.clone());
    }
}

pub fn remove_model_path(config: &mut AppConfig, path: &str) -> Result<(), String> {
    if config.model_paths.len() <= 1 {
        return Err(
            "Cannot remove the last model path. Add another folder first.".to_string(),
        );
    }
    let removed = find_model_path_index(&config.model_paths, path);
    if let Some(idx) = removed {
        config.model_paths.remove(idx);
    } else {
        return Err(format!("Model path not found: {}", path));
    }
    // Ensure at least one path is default after removal
    if !config.model_paths.iter().any(|p| p.is_default) {
        if let Some(first) = config.model_paths.first_mut() {
            first.is_default = true;
        }
    }
    if let Some(new_default) = config.model_paths.iter().find(|p| p.is_default) {
        config.default_download_path = Some(new_default.path.clone());
    }
    Ok(())
}

pub fn set_default_model_path(config: &mut AppConfig, path: &str) -> Result<(), String> {
    let key = model_path_key(path);
    if key.is_empty() {
        return Err("Invalid model path".to_string());
    }
    let mut matched = false;
    for p in &mut config.model_paths {
        let is_match = model_path_key(&p.path) == key;
        if is_match {
            matched = true;
        }
        p.is_default = is_match;
    }
    if !matched {
        return Err(format!("Model path not found: {path}"));
    }
    // Update the memo: where downloads go (stored form, not resolved display path)
    if let Some(entry) = config.model_paths.iter().find(|p| p.is_default) {
        config.default_download_path = Some(entry.path.clone());
    }
    Ok(())
}

pub fn calculate_disk_usage(paths: &[ModelPathEntry]) -> Vec<PathDiskUsage> {
    let mut result = Vec::new();
    for entry in paths {
        let entries = crate::model_catalog::scan_path(&std::path::PathBuf::from(&entry.path), None)
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

/// Allowed HuggingFace download hosts for Model Hub.
pub fn validate_download_url(url: &str) -> Result<(), String> {
    let lower = url.trim().to_lowercase();
    if !lower.starts_with("https://") {
        return Err("Download URL must use HTTPS".to_string());
    }
    let rest = &lower[8..];
    let host = rest.split('/').next().unwrap_or("");
    let allowed = host == "huggingface.co"
        || host.ends_with(".huggingface.co")
        || host == "cdn-lfs.huggingface.co"
        || host == "cdn-lfs.hf.co";
    if !allowed {
        return Err(format!("Download host not allowed: {host}"));
    }
    Ok(())
}

const HF_MODEL_ID_MAX_LEN: usize = 200;
const HF_SEARCH_MAX_QUERY_LEN: usize = 200;
const HF_SEARCH_MAX_LIMIT: usize = 100;
const HF_VRAM_FILTER_MAX_GB: u32 = 512;

fn is_valid_hf_id_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= HF_MODEL_ID_MAX_LEN
        && !segment.contains("..")
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

/// HuggingFace repo IDs must be `author/repo` with safe path segments.
pub fn validate_hf_model_id(model_id: &str) -> Result<(), String> {
    let trimmed = model_id.trim();
    if trimmed.is_empty() {
        return Err("Model ID is required".to_string());
    }
    if trimmed.len() > HF_MODEL_ID_MAX_LEN {
        return Err("Model ID too long".to_string());
    }
    if trimmed.contains("..") || trimmed.contains('\\') {
        return Err("Invalid model ID".to_string());
    }
    let parts: Vec<&str> = trimmed.split('/').collect();
    if parts.len() != 2 {
        return Err("Model ID must be in author/repo format".to_string());
    }
    for part in parts {
        if !is_valid_hf_id_segment(part) {
            return Err("Invalid characters in model ID".to_string());
        }
    }
    Ok(())
}

/// Download filenames must be a single `.gguf` leaf — no path traversal.
pub fn validate_download_file_name(file_name: &str) -> Result<(), String> {
    let name = file_name.trim();
    if name.is_empty() {
        return Err("File name is required".to_string());
    }
    if name.len() > 255 {
        return Err("File name too long".to_string());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("Invalid file name".to_string());
    }
    if !name.to_lowercase().ends_with(".gguf") {
        return Err("Only .gguf files can be downloaded".to_string());
    }
    Ok(())
}

/// Ensure the download URL references the expected HF model and file.
pub fn validate_download_url_matches_model(
    url: &str,
    hf_model_id: &str,
    file_name: &str,
) -> Result<(), String> {
    validate_download_url(url)?;
    validate_hf_model_id(hf_model_id)?;
    validate_download_file_name(file_name)?;

    let lower = url.trim().to_lowercase();
    let model_lower = hf_model_id.trim().to_lowercase();
    let file_lower = file_name.trim().to_lowercase();

    let resolve_fragment = format!("{model_lower}/resolve/");
    if !lower.contains(&resolve_fragment) {
        return Err("Download URL does not match model ID".to_string());
    }
    if !lower.ends_with(&file_lower) && !lower.contains(&format!("/{file_lower}")) {
        return Err("Download URL does not match file name".to_string());
    }
    Ok(())
}

/// Validate a shard/single-file download URL against model ID and repo-relative path.
pub fn validate_shard_download(url: &str, hf_model_id: &str, path_in_repo: &str) -> Result<(), String> {
    validate_download_url(url)?;
    validate_hf_model_id(hf_model_id)?;

    let repo_path = path_in_repo.trim().replace('\\', "/");
    if repo_path.is_empty() || repo_path.contains("..") {
        return Err("Invalid repo path".to_string());
    }

    let file_name = repo_path.rsplit('/').next().unwrap_or(repo_path.as_str());
    validate_download_file_name(file_name)?;

    let lower = url.trim().to_lowercase();
    let model_lower = hf_model_id.trim().to_lowercase();
    let repo_lower = repo_path.to_lowercase();

    if !lower.contains(&format!("{model_lower}/resolve/")) {
        return Err("Download URL does not match model ID".to_string());
    }
    if !lower.contains(&repo_lower) {
        return Err("Download URL does not match repo path".to_string());
    }
    Ok(())
}

/// Validate every part of a quant (single file or sharded set).
pub fn validate_quant_download(gguf: &crate::types::GgufFile, hf_model_id: &str) -> Result<(), String> {
    let parts = gguf.download_parts();
    if parts.is_empty() {
        return Err("No files to download".to_string());
    }
    for part in &parts {
        validate_shard_download(&part.url, hf_model_id, &part.path_in_repo)?;
    }
    Ok(())
}

/// Build destination path: `{default_root}/{author}/{repo}/{path_in_repo}`.
pub fn build_quant_dest_path(
    default_root: &str,
    hf_model_id: &str,
    path_in_repo: &str,
) -> Result<String, String> {
    validate_hf_model_id(hf_model_id)?;

    let repo_path = path_in_repo.trim().replace('\\', "/");
    if repo_path.is_empty() || repo_path.contains("..") {
        return Err("Invalid repo path".to_string());
    }

    let segments: Vec<&str> = hf_model_id.split('/').collect();
    let mut dest = PathBuf::from(default_root);
    dest.push(segments[0]);
    dest.push(segments[1]);
    for seg in repo_path.split('/') {
        if !seg.is_empty() && seg != "." {
            dest.push(seg);
        }
    }
    Ok(dest.to_string_lossy().to_string())
}

/// True when an on-disk file satisfies the expected part (LFS OID or exact byte size).
pub fn quant_part_already_downloaded(dest_path: &str, expected_size: u64, lfs_oid: &str) -> bool {
    if !std::path::Path::new(dest_path).exists() {
        return false;
    }
    if !lfs_oid.is_empty() {
        let cached = crate::model_cache::get_hf_metadata(dest_path);
        return cached
            .as_ref()
            .map(|m| m.lfs_oid == lfs_oid)
            .unwrap_or(false);
    }
    std::fs::metadata(dest_path)
        .map(|m| m.len() == expected_size)
        .unwrap_or(false)
}

/// Normalize and validate HF search IPC inputs.
pub fn normalize_hf_search_inputs(
    query: String,
    vram_limit_gb: Option<u32>,
    sort: Option<String>,
    limit: Option<usize>,
) -> Result<crate::types::HfSearchFilters, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Err("Search query is required".to_string());
    }
    if q.len() > HF_SEARCH_MAX_QUERY_LEN {
        return Err(format!(
            "Search query too long (max {HF_SEARCH_MAX_QUERY_LEN} chars)"
        ));
    }

    let sort_key = sort.unwrap_or_else(|| "downloads".to_string());
    if !matches!(sort_key.as_str(), "downloads" | "likes" | "lastModified") {
        return Err(format!("Invalid sort: {sort_key}"));
    }

    let raw_limit = limit.unwrap_or(50);
    let capped_limit = if raw_limit == 0 {
        50
    } else {
        raw_limit.min(HF_SEARCH_MAX_LIMIT)
    };

    let vram = vram_limit_gb.unwrap_or(0);
    if vram > HF_VRAM_FILTER_MAX_GB {
        return Err(format!("VRAM filter too large (max {HF_VRAM_FILTER_MAX_GB} GB)"));
    }

    Ok(crate::types::HfSearchFilters {
        query: q,
        vram_limit_gb: vram,
        limit: capped_limit,
        sort: sort_key,
    })
}

fn download_dest_roots(config: &AppConfig) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = get_model_paths(config)
        .into_iter()
        .map(|entry| PathBuf::from(entry.path))
        .collect();
    roots.push(default_models_dir());
    roots
}

/// True when `child` is under `root_canon`, walking up to the nearest existing ancestor.
/// Handles Windows 8.3 short paths, mixed `/` `\` separators, and not-yet-created author/repo folders.
fn download_dest_under_root(child: &std::path::Path, root_canon: &std::path::Path) -> bool {
    let mut probe = child.to_path_buf();
    loop {
        if probe.exists() {
            return match probe.canonicalize() {
                Ok(probe_canon) => {
                    probe_canon == root_canon || probe_canon.starts_with(root_canon)
                }
                Err(_) => false,
            };
        }
        probe = match probe.parent() {
            Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
            _ => break,
        };
    }
    false
}

/// Ensure download destination stays under configured model library roots.
/// Nested author/repo folders are created at download time — only the library root must exist.
pub fn validate_download_dest(dest_path: &str, config: &AppConfig) -> Result<(), String> {
    let resolved = resolve_path(dest_path);
    if resolved.as_os_str().is_empty() {
        return Err("Invalid download destination".to_string());
    }

    for root in download_dest_roots(config) {
        let root_resolved = resolve_path(root.to_string_lossy().as_ref());
        if root_resolved.as_os_str().is_empty() {
            continue;
        }

        if !root_resolved.exists() {
            std::fs::create_dir_all(&root_resolved)
                .map_err(|e| format!("Failed to create model library root: {e}"))?;
        }

        let Ok(root_canon) = root_resolved.canonicalize() else {
            continue;
        };

        if download_dest_under_root(&resolved, &root_canon) {
            return Ok(());
        }
    }

    Err("Download destination must be under a configured model library path".to_string())
}

pub fn get_default_download_path(config: &AppConfig) -> String {
    let stored = config.default_download_path.clone().or_else(|| {
        config.model_paths.iter().find(|p| p.is_default).map(|p| p.path.clone())
    });
    match stored {
        Some(path) => resolve_stored_model_path(&path),
        None => default_models_dir().to_string_lossy().to_string(),
    }
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
fn sanitize_model_paths(config: &mut AppConfig) -> bool {
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


/// Schema evolution merge: sync structural fields from fresh template, retain user UI preferences.
///
/// Aggressive sync philosophy — factory template is source of truth for everything structural.
/// Only purely cosmetic/organizational choices are preserved: hidden, userHidden, order, userAddedValues, hidden_values, values.

/// Normalize a JSON value to a canonical string for dedup comparison.
/// Numbers are compared by numeric equality (1 == 1.0), everything else by string.
pub fn json_val_key(v: &serde_json::Value) -> String {
    if let Some(n) = v.as_f64() {
        if n.fract() == 0.0 && n.is_finite() {
            format!("{}", n as i64)
        } else {
            format!("{n}")
        }
    } else {
        v.to_string()
    }
}

/// Read `templateVersion` from the factory default config for a provider or template type.
pub fn factory_template_version_for_provider(
    provider_id: &str,
    template_type: &str,
    factory_provided: bool,
) -> u32 {
    resolve_merge_template_key(provider_id, template_type, factory_provided)
        .map(|key| crate::templates::get_template_version_for_provider(&key))
        .unwrap_or(1)
}

/// Resolve which runtime folder supplies the factory template for merge.
pub fn resolve_merge_template_key(
    provider_id: &str,
    template_type: &str,
    factory_provided: bool,
) -> Option<String> {
    if factory_provided && crate::templates::load_provider_defaults(provider_id).is_some() {
        return Some(provider_id.to_string());
    }
    template_key_for_type(template_type)
}

/// Drop duplicate/empty param keys — keeps lowest `order` entry per key.
pub fn dedupe_user_params_by_key(
    params: Vec<crate::types::UserEditedTemplateParam>,
) -> Vec<crate::types::UserEditedTemplateParam> {
    let mut sorted = params;
    sorted.sort_by_key(|p| p.order);
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(sorted.len());
    for p in sorted {
        if p.key.is_empty() {
            log::warn!("[config] Dropping param with empty key (order={})", p.order);
            continue;
        }
        if seen.insert(p.key.clone()) {
            out.push(p);
        } else {
            log::warn!("[config] Dropping duplicate param key '{}' (order={})", p.key, p.order);
        }
    }
    out.sort_by_key(|p| p.order);
    out
}

/// Merge user params against the correct factory template for this provider.
pub fn merge_template_for_provider(
    provider_id: &str,
    template_type: &str,
    factory_provided: bool,
    user_edited: &[crate::types::UserEditedTemplateParam],
    excluded_keys: &[String],
) -> Vec<crate::types::UserEditedTemplateParam> {
    let template_key = resolve_merge_template_key(provider_id, template_type, factory_provided);
    let merged = merge_template_into_user_params_by_key(template_key.as_deref(), user_edited, excluded_keys);
    dedupe_user_params_by_key(merged)
}

/// Merge using template_type → folder mapping (custom providers without factory JSON).
#[allow(dead_code)]
pub fn merge_template_into_user_params(
    template_type: &str,
    user_edited: &[crate::types::UserEditedTemplateParam],
) -> Vec<crate::types::UserEditedTemplateParam> {
    merge_template_into_user_params_by_key(
        template_key_for_type(template_type).as_deref(),
        user_edited,
        &[],
    )
}

fn template_sub_params_to_map(
    sp: &serde_json::Value,
) -> Option<std::collections::HashMap<String, Vec<String>>> {
    sp.as_object().map(|obj| {
        obj.iter()
            .filter_map(|(k, v)| {
                v.as_array().and_then(|arr| {
                    Some((
                        k.clone(),
                        arr.iter()
                            .filter_map(|el| el.as_str().map(String::from))
                            .collect(),
                    ))
                })
            })
            .collect()
    })
}

fn is_numeric_literal_value(v: &serde_json::Value) -> bool {
    if v.is_number() {
        return true;
    }
    v.as_str()
        .map(|s| {
            let t = s.trim();
            !t.is_empty() && t.parse::<f64>().is_ok() && t.chars().all(|c| c.is_ascii_digit() || c == '.' || c == '-')
        })
        .unwrap_or(false)
}

fn values_all_numeric(values: &[serde_json::Value]) -> bool {
    values.len() >= 2 && values.iter().all(is_numeric_literal_value)
}

/// Preserve factory JSON order for string enums; numeric lists keep user/saved order.
fn reorder_values_to_template(
    values: &[serde_json::Value],
    tmpl_values: &[serde_json::Value],
) -> Vec<serde_json::Value> {
    if values.is_empty() || tmpl_values.is_empty() || values_all_numeric(values) {
        return values.to_vec();
    }
    let mut ordered = Vec::with_capacity(values.len());
    let mut placed = std::collections::HashSet::new();
    for tv in tmpl_values {
        let key = json_val_key(tv);
        if let Some(v) = values.iter().find(|v| json_val_key(v) == key) {
            ordered.push(v.clone());
            placed.insert(key);
        }
    }
    for v in values {
        let key = json_val_key(v);
        if !placed.contains(&key) {
            ordered.push(v.clone());
            placed.insert(key);
        }
    }
    ordered
}

fn merge_user_params_with_template(
    template: &crate::templates::ProviderTemplate,
    user_edited: &[crate::types::UserEditedTemplateParam],
    excluded_keys: &[String],
) -> Vec<crate::types::UserEditedTemplateParam> {
    let excluded: std::collections::HashSet<&str> = excluded_keys.iter().map(|k| k.as_str()).collect();
    let tmpl_map: std::collections::HashMap<_, _> = template
        .params
        .iter()
        .map(|p| (p.key.as_str(), p))
        .collect();

    let mut merged = Vec::with_capacity(user_edited.len());

    for user_param in user_edited {
        let mut m = user_param.clone();
        if let Some(tmpl) = tmpl_map.get(user_param.key.as_str()) {
            // ── Values: user-owned catalog — only backfill when empty (never re-append deleted factory values) ──
            if m.values.is_empty() && !tmpl.values.is_empty() {
                m.values = tmpl.values.clone();
            } else if !m.values.is_empty() && !tmpl.values.is_empty() {
                m.values = reorder_values_to_template(&m.values, &tmpl.values);
            }

            // ── factoryDefault: always sync from fresh template — keeps bubble styling correct ──
            m.factory_default = tmpl.default.clone();

            // ── defaultValue: if current value still in merged array → keep. If orphaned → force reset to new factory default ──
            let user_default_key = json_val_key(&m.default_value);
            if !m.values.iter().any(|v| json_val_key(v) == user_default_key) {
                log::warn!("[config] Param '{}' default '{:?}' no longer in values — resetting to factory default {:?}",
                    m.key, m.default_value, tmpl.default);
                m.default_value = tmpl.default.clone();
            }

            // ── Structural fields: sync from template (source of truth) ──
            // label: preserve user rename from ConfigPage — backfill only when empty
            if m.label.is_empty() {
                m.label = tmpl.label.clone();
            }
            if m.flag.is_none() || m.flag.as_deref().map_or(false, |s| s.is_empty()) {
                m.flag = tmpl.flag.clone();
            }
            if m.flag_pair.is_empty() && !tmpl.flag_pair.is_empty() {
                m.flag_pair = tmpl.flag_pair.clone();
            }

            // ptype: only backfill if still default "arg_select" and template differs
            if m.ptype == "arg_select" && tmpl.ptype != "arg_select" {
                m.ptype = tmpl.ptype.clone();
            }

            if m.ui_group.is_empty() {
                m.ui_group = normalize_ui_group(&tmpl.ui_group);
            }
            if m.note.is_empty() {
                m.note = tmpl.note.clone();
            }
            if m.pattern.is_empty() {
                m.pattern = tmpl.pattern.clone();
            }

            // Backfill step (slider)
            if m.step.is_none() && tmpl.step.is_some() {
                m.step = tmpl.step;
            }

            // Per-key sub_params merge — backfill missing keys from template, preserve user keys
            if let Some(tmpl_sp) = tmpl.sub_params.as_ref().and_then(template_sub_params_to_map) {
                let mut merged_sp = m.sub_params.clone().unwrap_or_default();
                for (k, v) in tmpl_sp {
                    merged_sp.entry(k).or_insert(v);
                }
                if !merged_sp.is_empty() {
                    m.sub_params = Some(merged_sp);
                }
            }

            if m.dock.is_empty() && !tmpl.dock.is_empty() {
                m.dock = tmpl.dock.clone();
            }
        }
        merged.push(m);
    }

    merged.retain(|p| !excluded.contains(p.key.as_str()));

    // Append new params from template that don't exist in user config
    for (i, tmpl) in template.params.iter().enumerate() {
        if excluded.contains(tmpl.key.as_str()) {
            continue;
        }
        if !merged.iter().any(|p| p.key == tmpl.key) {
            let param = crate::types::UserEditedTemplateParam {
                key: tmpl.key.clone(),
                label: tmpl.label.clone(),
                values: tmpl.values.clone(),
                order: (user_edited.len() + i as usize) as i32,
                hidden: tmpl.hidden_default,
                user_hidden: false,
                hidden_values: Vec::new(),
                flag: tmpl.flag.clone(),
                flag_pair: tmpl.flag_pair.clone(),
                ptype: tmpl.ptype.clone(),
                step: tmpl.step,
                ui_group: normalize_ui_group(&tmpl.ui_group),
                note: tmpl.note.clone(),
                pattern: tmpl.pattern.clone(),
                default_value: tmpl.default.clone(),
                user_added_values: Vec::new(),
                factory_default: tmpl.default.clone(),
                sub_params: tmpl.sub_params.as_ref().and_then(|sp| {
                    sp.as_object().map(|obj| {
                        obj.iter()
                            .filter_map(|(k, v)| {
                                v.as_array().and_then(|arr| {
                                    Some((k.clone(), arr.iter().filter_map(|el| el.as_str().map(String::from)).collect()))
                                })
                            })
                            .collect::<std::collections::HashMap<_, _>>()
                    })
                }),
                dock: tmpl.dock.clone(),
                essential: None,
            };
            merged.push(param);
        }
    }

    merged
}

fn resolve_provider_binaries_from_meta(
    p: &mut crate::types::ProviderConfig,
    meta: Option<&ProviderMeta>,
) {
    let empty = HashMap::new();
    let source_pref = meta
        .map(|m| &m.binary_source_per_env)
        .unwrap_or(&empty);
    let saved_paths = meta
        .map(|m| &m.binary_path_per_env)
        .unwrap_or(&empty);
    if let Some(m) = meta {
        p.binary_source_per_env = m.binary_source_per_env.clone();
        p.downloaded_version_per_env = m.downloaded_version_per_env.clone();
    }
    crate::profile_binaries::resolve_provider_binaries(
        p,
        crate::profile_binaries::ResolveContext {
            source_pref,
            saved_paths,
        },
    );
}

fn merge_template_into_user_params_by_key(
    template_key: Option<&str>,
    user_edited: &[crate::types::UserEditedTemplateParam],
    excluded_keys: &[String],
) -> Vec<crate::types::UserEditedTemplateParam> {
    let Some(key) = template_key else {
        let excluded: std::collections::HashSet<&str> = excluded_keys.iter().map(|k| k.as_str()).collect();
        return user_edited
            .iter()
            .filter(|p| !excluded.contains(p.key.as_str()))
            .cloned()
            .collect();
    };
    let Some(template) = crate::templates::load_provider_defaults(key) else {
        let excluded: std::collections::HashSet<&str> = excluded_keys.iter().map(|k| k.as_str()).collect();
        return user_edited
            .iter()
            .filter(|p| !excluded.contains(p.key.as_str()))
            .cloned()
            .collect();
    };
    merge_user_params_with_template(&template, user_edited, excluded_keys)
}


fn build_config_with_providers_full(mut config: AppConfig) -> AppConfig {
    let metas: Vec<ProviderMeta> = load_user_providers_meta()
        .into_iter()
        .filter(|m| !is_phased_out_provider(&m.id))
        .collect();

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

            let effective_template_type = if !meta.template_type.is_empty() {
                meta.template_type.clone()
            } else {
                p.template_type.clone()
            };

            if !meta.user_edited_template_params.is_empty() {
                p.user_edited_template_params = merge_template_for_provider(
                    &p.id,
                    &effective_template_type,
                    true,
                    &meta.user_edited_template_params,
                    &meta.excluded_param_keys,
                );
            }

            // Template version mismatch → set attention flag for UI banner.
            // Merge already applied; banner is advisory — save syncs version or user hits RESET.
            let factory_tv =
                factory_template_version_for_provider(&p.id, &effective_template_type, true);
            p.template_version = factory_tv;
            if meta.template_version != factory_tv {
                log::info!(
                    "[config] Provider '{}' template version changed: user={}, factory={}",
                    p.id,
                    meta.template_version,
                    factory_tv
                );
                p.needs_template_attention = true;
            }
            // Active binary paths + build info resolved after meta merge (see resolve_provider_binaries_from_meta).
            let factory_key = resolve_merge_template_key(&p.id, &effective_template_type, true)
                .unwrap_or_else(|| p.id.clone());
            apply_meta_layout_overrides(&mut p, meta, &factory_key);
            if !meta.last_pr_per_env.is_empty() {
                p.last_pr_per_env = meta.last_pr_per_env.clone();
            }
            // Always override — user's explicit choice survives restart
            p.enabled = meta.enabled;
            p.display_order = meta.display_order;
            if !meta.template_type.is_empty() {
                p.template_type = meta.template_type.clone();
            }
            p.excluded_param_keys = meta.excluded_param_keys.clone();
            if !meta.above_column_widths.is_empty() {
                p.above_column_widths = meta.above_column_widths.clone();
            }
        }
        crate::profile_binaries::migrate_provider_profile_keys(&mut p);
        let pid = p.id.clone();
        resolve_provider_binaries_from_meta(&mut p, meta_map.get(&pid).copied());
        if let Some(tmpl) = crate::templates::load_provider_defaults(&p.id) {
            p.launch_profile = crate::types::LaunchProfile::from_spawn_profile(&tmpl.spawn_profile);
        }
        providers.push(p);
    }

    // Custom/user-created providers not found in runtime/ defaults
    for meta in metas_clone {
        if is_phased_out_provider(&meta.id) {
            continue;
        }
        if !providers.iter().any(|p| p.id == meta.id) {
            let resolved_type = resolve_template_type(&meta.id, Some(&meta.template_type));
            let tmpl_key = template_key_for_type(&resolved_type);
        let user_edited_params = if !meta.user_edited_template_params.is_empty() {
                merge_template_for_provider(
                    &meta.id,
                    &resolved_type,
                    false,
                    &meta.user_edited_template_params,
                    &meta.excluded_param_keys,
                )
            } else if let Some(ref key) = tmpl_key {
                params_for_provider(key)
            } else {
                Vec::new()  // custom type, no template
            };

            // Compare versions against fresh template if one exists
            let (factory_tv, tv_changed) = if let Some(ref key) = tmpl_key {
                let factory_v = crate::templates::get_template_version_for_provider(key);
                (factory_v, factory_v != meta.template_version)
            } else {
                (meta.template_version, false)
            };

            let factory_key = tmpl_key.clone().unwrap_or_else(|| meta.id.clone());
            let mut custom = crate::types::ProviderConfig {
                id: meta.id.clone(),
                display_name: meta.display_name.clone(),
                binary_path: meta.binary_path.clone(),
                enabled: meta.enabled,
                params: serde_json::json!({}),
                user_edited_template_params: user_edited_params,
                excluded_param_keys: meta.excluded_param_keys.clone(),
                group_order: Vec::new(),
                group_display_zone: HashMap::new(),
                config_column_count: None,
                config_column_widths: Vec::new(),
                group_column: HashMap::new(),
                above_column_widths: meta.above_column_widths.clone(),
                _original_id: None,
                git_url: meta.git_url.clone(),
                branch: meta.branch.clone(),
                build_profile: meta.build_profile.clone(),
                template_type: resolved_type,
                build_info_per_env: HashMap::new(),
                binary_path_per_env: HashMap::new(),
                binary_source_per_env: meta.binary_source_per_env.clone(),
                bundled_binary_path_per_env: HashMap::new(),
                foundry_binary_path_per_env: HashMap::new(),
                catalog_binary_path_per_env: HashMap::new(),
                bundled_build_info_per_env: HashMap::new(),
                foundry_build_info_per_env: HashMap::new(),
                catalog_build_info_per_env: HashMap::new(),
                downloaded_version_per_env: meta.downloaded_version_per_env.clone(),
                last_pr_per_env: meta.last_pr_per_env.clone(),
                display_order: meta.display_order,
                factory_provided: false,
                optional_download: false,
                template_version: if tv_changed { factory_tv } else { meta.template_version },
                needs_template_attention: tv_changed,
                launch_profile: tmpl_key
                    .as_ref()
                    .and_then(|key| crate::templates::load_provider_defaults(key))
                    .map(|t| crate::types::LaunchProfile::from_spawn_profile(&t.spawn_profile))
                    .unwrap_or_default(),
            };
            apply_meta_layout_overrides(&mut custom, &meta, &factory_key);
            resolve_provider_binaries_from_meta(&mut custom, Some(&meta));
            providers.push(custom);
        }
    }

    providers.sort_by(|a, b| a.display_order.cmp(&b.display_order).then_with(|| a.id.cmp(&b.id)));
    for (i, p) in providers.iter_mut().enumerate() {
        p.display_order = i as i32;
    }

    config.providers = providers;

    config
}

/// Re-scan runtime/ and merge user meta — after plugin pack install without app restart.
pub fn refresh_providers_from_disk(config: &mut AppConfig) {
    let snapshot = config.clone();
    *config = build_config_with_providers_full(snapshot);
}

/// Delete provider's user config file so it regenerates from fresh factory template on next load.
/// Called by frontend RESET TO DEFAULTS button — instant recovery to 1:1 with factory state.
/// Dev/testing: reset first-run fields (model paths → default `models/`), clear GGUF cache,
/// re-discover bundled providers, persist, and sync in-memory config (webview reload ≠ Rust restart).
#[tauri::command]
pub fn dev_reset_first_run(
    config: tauri::State<'_, std::sync::Arc<std::sync::Mutex<AppConfig>>>,
) -> Result<(), String> {
    #[cfg(not(debug_assertions))]
    {
        return Err("dev_reset_first_run is only available in debug builds".to_string());
    }

    crate::model_cache::clear_cache()?;

    let hf_token = {
        let cfg = config.lock().map_err(|e| e.to_string())?;
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
        let mut cfg = config.lock().map_err(|e| e.to_string())?;
        *cfg = built;
    }
    let _ = std::fs::create_dir_all(default_models_dir());
    log::info!(
        "[config] dev_reset_first_run: paths reset, cache cleared, {provider_count} provider(s) rediscovered",
    );
    Ok(())
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

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ExportFactoryTemplateInput {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "userEditedTemplateParams")]
    pub user_edited_template_params: Vec<crate::types::UserEditedTemplateParam>,
    #[serde(default, rename = "groupOrder")]
    pub group_order: Vec<String>,
    #[serde(default, rename = "layoutDefaults")]
    pub layout_defaults: crate::types::LayoutDefaults,
    #[serde(default, rename = "essentialParamKeys")]
    pub essential_param_keys: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ExportFactoryTemplateResult {
    #[serde(rename = "templateVersion")]
    pub template_version: u32,
    pub paths: Vec<String>,
}

fn user_param_to_factory_param(p: &crate::types::UserEditedTemplateParam) -> crate::templates::ProviderDefaultParam {
    let mut values = p.values.clone();
    let existing: std::collections::HashSet<String> = values.iter().map(|v| json_val_key(v)).collect();
    for uv in &p.user_added_values {
        let k = json_val_key(uv);
        if !k.is_empty() && !existing.contains(&k) {
            values.push(uv.clone());
        }
    }

    let default = if !p.default_value.is_null() {
        p.default_value.clone()
    } else if let Some(first) = values.first() {
        first.clone()
    } else if !p.factory_default.is_null() {
        p.factory_default.clone()
    } else {
        serde_json::Value::Null
    };

    let sub_params = p.sub_params.as_ref().map(|m| {
        let obj: serde_json::Map<String, serde_json::Value> = m
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    serde_json::Value::Array(
                        v.iter()
                            .map(|s| serde_json::Value::String(s.clone()))
                            .collect(),
                    ),
                )
            })
            .collect();
        serde_json::Value::Object(obj)
    });

    crate::templates::ProviderDefaultParam {
        key: p.key.clone(),
        label: p.label.clone(),
        flag: p.flag.clone().filter(|f| !f.is_empty()),
        flag_pair: p.flag_pair.clone(),
        ptype: if p.ptype.is_empty() {
            default_ptype()
        } else {
            p.ptype.clone()
        },
        values,
        step: p.step,
        default,
        ui_group: normalize_ui_group(&p.ui_group),
        note: p.note.clone(),
        pattern: p.pattern.clone(),
        sub_params,
        dock: p.dock.clone(),
        hidden_default: p.hidden || p.user_hidden,
    }
}

fn default_ptype() -> String {
    crate::types::default_ptype()
}

/// Canonical key order for factory default config JSON (identity + spawn at top).
const FACTORY_CONFIG_KEY_ORDER: &[&str] = &[
    "id",
    "display_name",
    "binary_name",
    "description",
    "git_url",
    "branch",
    "template_type",
    "templateVersion",
    "build_profile",
    "spawn_profile",
    "params",
    "groupOrder",
    "layoutDefaults",
];

const SYSTEM_UI_GROUP: &str = "SYSTEM";

/// Factory export: preserve saved group order, dedupe, pin SYSTEM last.
fn finalize_factory_group_order(order: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut deduped = Vec::new();
    let mut had_system = false;
    for g in order {
        let norm = normalize_ui_group(&g);
        if norm == SYSTEM_UI_GROUP {
            had_system = true;
            continue;
        }
        if seen.insert(norm.clone()) {
            deduped.push(norm);
        }
    }
    if had_system {
        deduped.push(SYSTEM_UI_GROUP.to_string());
    }
    deduped
}

/// Sort params for factory JSON: group order first, `order` within group, SYSTEM group last.
fn sort_params_for_factory_export(
    params: &mut [crate::types::UserEditedTemplateParam],
    group_order: &[String],
) {
    let mut group_rank: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (i, g) in group_order.iter().enumerate() {
        let norm = normalize_ui_group(g);
        if norm != SYSTEM_UI_GROUP {
            group_rank.entry(norm).or_insert(i);
        }
    }
    let system_rank = group_order.len().max(1);

    params.sort_by(|a, b| {
        let ga = normalize_ui_group(&a.ui_group);
        let gb = normalize_ui_group(&b.ui_group);
        let ra = if ga == SYSTEM_UI_GROUP {
            system_rank
        } else {
            *group_rank.get(&ga).unwrap_or(&usize::MAX)
        };
        let rb = if gb == SYSTEM_UI_GROUP {
            system_rank
        } else {
            *group_rank.get(&gb).unwrap_or(&usize::MAX)
        };
        ra.cmp(&rb).then(a.order.cmp(&b.order))
    });
}

fn reorder_factory_config_root(obj: serde_json::Map<String, serde_json::Value>) -> serde_json::Value {
    let mut ordered = serde_json::Map::new();
    let mut rest = obj;
    for key in FACTORY_CONFIG_KEY_ORDER {
        if let Some(v) = rest.remove(*key) {
            ordered.insert(key.to_string(), v);
        }
    }
    for (k, v) in rest {
        ordered.insert(k, v);
    }
    serde_json::Value::Object(ordered)
}

/// Full `spawn_profile` from core Master factory — base for ggml-family optional forks.
pub fn load_master_spawn_profile_map() -> serde_json::Map<String, serde_json::Value> {
    let candidates = [
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("runtime")
            .join(DEFAULT_PROVIDER_ID)
            .join("config")
            .join(format!("{DEFAULT_PROVIDER_ID}-default-config.json")),
        app_root_dir()
            .join("runtime")
            .join(DEFAULT_PROVIDER_ID)
            .join("config")
            .join(format!("{DEFAULT_PROVIDER_ID}-default-config.json")),
    ];
    for path in candidates {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(sp) = v.get("spawn_profile").and_then(|s| s.as_object()) {
                    return sp.clone();
                }
            }
        }
    }
    // Last resort: typed defaults (flags / fit_style filled).
    serde_json::to_value(crate::templates::SpawnProfile::default())
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// If `spawn_profile` is missing or a stub (no fit_style), start from Master and layer existing keys.
pub fn ensure_complete_spawn_profile_map(
    existing: Option<&serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut base = load_master_spawn_profile_map();
    let Some(cur) = existing.and_then(|v| v.as_object()) else {
        return base;
    };
    let fit_ok = cur
        .get("fit_style")
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if fit_ok {
        // Already complete enough — keep as-is (preserve fork adapters, etc.).
        return cur.clone();
    }
    // Stub seed: keep explicit keys (fit_adapter, fusion_adapter, max_engine_slots, …) on top of Master.
    for (k, v) in cur {
        base.insert(k.clone(), v.clone());
    }
    if !base
        .get("fit_style")
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
    {
        base.insert(
            "fit_style".into(),
            serde_json::Value::String("ggml_fit_params".into()),
        );
    }
    base
}

/// Promote live UI config to factory default JSON (admin). Bumps `templateVersion` automatically.
pub fn export_provider_factory_template(
    input: ExportFactoryTemplateInput,
) -> Result<ExportFactoryTemplateResult, String> {
    if !cfg!(debug_assertions) {
        return Err(
            "Factory export is only available in dev builds — user config cannot write factory files"
                .to_string(),
        );
    }

    let path = factory_default_config_path(&input.provider_id);
    // First export for a newly added provider: seed a factory shell if missing (dev only).
    if !path.exists() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                format!("Failed to create factory dir {}: {e}", parent.display())
            })?;
        }
        let seed = serde_json::json!({
            "id": input.provider_id,
            "display_name": input.provider_id,
            "description": format!("Optional engine plugin ({})", input.provider_id),
            "binary_name": "llama-server.exe",
            "git_url": "",
            "branch": "master",
            "build_profile": "",
            "template_type": "ggml-llama",
            "optionalDownload": true,
            "templateVersion": 0,
            "groupOrder": [],
            "layoutDefaults": {
                "groupDisplayZone": {},
                "groupColumn": {},
                "configColumnCount": 2,
                "configColumnWidths": [],
                "aboveColumnWidths": []
            },
            "params": [],
            "spawn_profile": {
                "essentialParamKeys": [],
                "simple_param_keys": []
            }
        });
        let seed_txt = serde_json::to_string_pretty(&seed)
            .map_err(|e| format!("Failed to seed factory JSON: {e}"))?;
        std::fs::write(&path, &seed_txt)
            .map_err(|e| format!("Failed to create {}: {}", path.display(), e))?;
        log::info!(
            "[config] Seeded new factory template for '{}' at {}",
            input.provider_id,
            path.display()
        );
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    let mut root: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid factory JSON at {}: {}", path.display(), e))?;

    let current_tv = root
        .get("templateVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(1) as u32;
    let new_tv = current_tv.saturating_add(1);

    let validation_errors =
        validate_provider_params(&input.provider_id, &input.user_edited_template_params);
    if !validation_errors.is_empty() {
        return Err(validation_errors.join("\n"));
    }

    let group_order = finalize_factory_group_order(
        input
            .group_order
            .iter()
            .map(|g| normalize_ui_group(g))
            .collect(),
    );

    let mut sorted = input.user_edited_template_params.clone();
    sort_params_for_factory_export(&mut sorted, &group_order);
    let factory_params: Vec<crate::templates::ProviderDefaultParam> =
        sorted.iter().map(user_param_to_factory_param).collect();

    let layout = input.layout_defaults.clone();
    let pretty = serde_json::to_string_pretty(&factory_params)
        .map_err(|e| format!("Failed to serialize params: {e}"))?;
    let params_value: serde_json::Value =
        serde_json::from_str(&pretty).map_err(|e| format!("Failed to encode params: {e}"))?;

    let essential_keys = input.essential_param_keys.clone();

    if let Some(obj) = root.as_object_mut() {
        obj.insert("params".to_string(), params_value);
        obj.insert(
            "groupOrder".to_string(),
            serde_json::to_value(&group_order).map_err(|e| e.to_string())?,
        );
        obj.insert(
            "layoutDefaults".to_string(),
            serde_json::to_value(&layout).map_err(|e| e.to_string())?,
        );
        obj.insert(
            "templateVersion".to_string(),
            serde_json::Value::Number(new_tv.into()),
        );

        // Full spawn_profile for forks: backfill from ggml-master when stub/missing
        // (EXPORT used to only write essentialParamKeys → empty fit_style / flags).
        let mut sp = ensure_complete_spawn_profile_map(obj.get("spawn_profile"));
        sp.insert(
            "essentialParamKeys".to_string(),
            serde_json::to_value(&essential_keys).map_err(|e| e.to_string())?,
        );
        sp.insert(
            "simple_param_keys".to_string(),
            serde_json::to_value(&essential_keys).map_err(|e| e.to_string())?,
        );
        obj.insert(
            "spawn_profile".to_string(),
            serde_json::Value::Object(sp),
        );
    } else {
        return Err("Factory config root must be a JSON object".to_string());
    }

    root = root
        .as_object()
        .map(|o| reorder_factory_config_root(o.clone()))
        .unwrap_or(root);

    // Author bumped factory — sync user meta version so reload won't show attention banner.
    if let Some(mut meta) = load_user_providers_meta()
        .into_iter()
        .find(|m| m.id == input.provider_id)
    {
        meta.template_version = new_tv;
        for p in &mut meta.user_edited_template_params {
            p.essential = None;
        }
        let _ = save_provider_user_config(&meta);
    }

    let output = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    let mut written = Vec::new();

    std::fs::write(&path, &output)
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    written.push(path.display().to_string());

    #[cfg(debug_assertions)]
    {
        // Always mirror into src-tauri/runtime (create if first export for a new provider).
        let src = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("runtime")
            .join(&input.provider_id)
            .join("config")
            .join(format!("{}-default-config.json", input.provider_id));
        if let Some(parent) = src.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&src, &output)
            .map_err(|e| format!("Failed to write dev source {}: {}", src.display(), e))?;
        written.push(src.display().to_string());
    }

    log::info!(
        "[config] Exported factory template for '{}' → templateVersion={} essentials={} ({} file(s))",
        input.provider_id,
        new_tv,
        essential_keys.len(),
        written.len()
    );

    Ok(ExportFactoryTemplateResult {
        template_version: new_tv,
        paths: written,
    })
}

#[tauri::command]
pub fn reset_provider_user_config(provider_id: String) -> Result<(), String> {
    let path = provider_user_config_path(&provider_id);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Failed to delete {}: {}", path.display(), e))?;
        log::info!("[config] Deleted user config for '{}' — will regenerate from factory on next load", provider_id);
    } else {
        log::warn!("[config] No user config found at {} for '{}'", path.display(), provider_id);
    }
    Ok(())
}

#[cfg(test)]
mod merge_tests {
    use super::*;
    use crate::templates::{ProviderDefaultParam, ProviderTemplate};

    fn make_user_param(key: &str, values: &[&str], default: &str, order: i32) -> crate::types::UserEditedTemplateParam {
        crate::types::UserEditedTemplateParam {
            key: key.to_string(),
            label: format!("Label {}", key),
            values: values.iter().map(|v| serde_json::Value::String(v.to_string())).collect(),
            order,
            hidden: true,
            user_hidden: false,
            hidden_values: vec![serde_json::Value::String("hidden_val".to_string())],
            flag: Some(format!("--{}", key)),
            flag_pair: Vec::new(),
            ptype: "arg_select".to_string(),
            step: None,
            ui_group: "CORE".to_string(),
            note: String::new(),
            pattern: String::new(),
            default_value: serde_json::Value::String(default.to_string()),
            user_added_values: vec![serde_json::Value::String("user_custom".to_string())],
            factory_default: serde_json::Value::String(default.to_string()),
            sub_params: None,
            dock: String::new(),
            essential: None,
        }
    }

    fn make_template(params: Vec<ProviderDefaultParam>) -> ProviderTemplate {
        ProviderTemplate {
            binary_name: "llama-server.exe".to_string(),
            description: "test".to_string(),
            spawn_profile: Default::default(),
            params,
        }
    }

    #[test]
    fn merge_preserves_user_values_catalog() {
        let template = make_template(vec![ProviderDefaultParam {
            key: "ctx".to_string(),
            label: "CTX".to_string(),
            flag: Some("--ctx-size".to_string()),
            flag_pair: Vec::new(),
            ptype: "arg_select".to_string(),
            values: vec![
                serde_json::Value::String("8192".to_string()),
                serde_json::Value::String("32768".to_string()),
            ],
            step: None,
            default: serde_json::Value::String("32768".to_string()),
            ui_group: "CORE".to_string(),
            note: String::new(),
            pattern: String::new(),
            sub_params: None,
            dock: String::new(),
            hidden_default: false,
        }]);

        let user = vec![make_user_param("ctx", &["8192", "user_custom"], "8192", 0)];
        let merged = merge_user_params_with_template(&template, &user, &[]);
        let ctx = merged.iter().find(|p| p.key == "ctx").unwrap();

        assert!(!ctx.values.iter().any(|v| v.as_str() == Some("32768")));
        assert!(ctx.values.iter().any(|v| v.as_str() == Some("user_custom")));
        assert!(ctx.hidden);
        assert_eq!(ctx.user_added_values.len(), 1);
    }

    #[test]
    fn merge_does_not_reappend_deleted_factory_values() {
        let template = make_template(vec![ProviderDefaultParam {
            key: "kv_quant".to_string(),
            label: "KV".to_string(),
            flag: Some("--cache-type-k".to_string()),
            flag_pair: Vec::new(),
            ptype: "arg_select".to_string(),
            values: vec![
                serde_json::Value::String("q4_0".to_string()),
                serde_json::Value::String("q8_0".to_string()),
            ],
            step: None,
            default: serde_json::Value::String("q4_0".to_string()),
            ui_group: "CORE".to_string(),
            note: String::new(),
            pattern: String::new(),
            sub_params: None,
            dock: String::new(),
            hidden_default: false,
        }]);

        let user = make_user_param("kv_quant", &["q4_0"], "q4_0", 0);
        let merged = merge_user_params_with_template(&template, &[user], &[]);
        let kv = merged.iter().find(|p| p.key == "kv_quant").unwrap();

        assert!(!kv.values.iter().any(|v| v.as_str() == Some("q8_0")));
    }

    #[test]
    fn merge_resets_orphan_default() {
        let template = make_template(vec![ProviderDefaultParam {
            key: "kv_quant".to_string(),
            label: "KV".to_string(),
            flag: Some("--cache-type-k".to_string()),
            flag_pair: Vec::new(),
            ptype: "arg_select".to_string(),
            values: vec![serde_json::Value::String("q4_0".to_string())],
            step: None,
            default: serde_json::Value::String("q4_0".to_string()),
            ui_group: "CORE".to_string(),
            note: String::new(),
            pattern: String::new(),
            sub_params: None,
            dock: String::new(),
            hidden_default: false,
        }]);

        let mut user = make_user_param("kv_quant", &["q4_0"], "stale_removed", 0);
        user.default_value = serde_json::Value::String("stale_removed".to_string());
        let merged = merge_user_params_with_template(&template, &[user], &[]);
        let kv = merged.iter().find(|p| p.key == "kv_quant").unwrap();

        assert_eq!(kv.default_value.as_str(), Some("q4_0"));
    }

    #[test]
    fn merge_keeps_orphaned_user_param() {
        let template = make_template(vec![]);
        let user = vec![make_user_param("orphan_key", &["on"], "on", 0)];
        let merged = merge_user_params_with_template(&template, &user, &[]);

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].key, "orphan_key");
    }

    #[test]
    fn merge_appends_new_template_param() {
        let template = make_template(vec![ProviderDefaultParam {
            key: "new_param".to_string(),
            label: "New".to_string(),
            flag: Some("--new".to_string()),
            flag_pair: Vec::new(),
            ptype: "arg_select".to_string(),
            values: vec![serde_json::Value::String("1".to_string())],
            step: None,
            default: serde_json::Value::String("1".to_string()),
            ui_group: "CORE".to_string(),
            note: String::new(),
            pattern: String::new(),
            sub_params: None,
            dock: String::new(),
            hidden_default: false,
        }]);

        let user = vec![make_user_param("existing", &["a"], "a", 0)];
        let merged = merge_user_params_with_template(&template, &user, &[]);

        assert_eq!(merged.len(), 2);
        assert!(merged.iter().any(|p| p.key == "new_param"));
        assert!(merged.iter().any(|p| p.key == "existing"));
    }

    #[test]
    fn merge_sub_params_per_key() {
        let template = make_template(vec![ProviderDefaultParam {
            key: "feat".to_string(),
            label: "Feat".to_string(),
            flag: Some("--feat".to_string()),
            flag_pair: Vec::new(),
            ptype: "arg_select".to_string(),
            values: vec![serde_json::Value::String("ON".to_string())],
            step: None,
            default: serde_json::Value::String("ON".to_string()),
            ui_group: "CORE".to_string(),
            note: String::new(),
            pattern: String::new(),
            sub_params: Some(serde_json::json!({
                "ON": ["--extra-on"],
                "NEW": ["--extra-new"]
            })),
            dock: String::new(),
            hidden_default: false,
        }]);

        let mut user = make_user_param("feat", &["ON"], "ON", 0);
        let mut user_sp = std::collections::HashMap::new();
        user_sp.insert("ON".to_string(), vec!["--user-on".to_string()]);
        user.sub_params = Some(user_sp);

        let merged = merge_user_params_with_template(&template, &[user], &[]);
        let feat = merged.iter().find(|p| p.key == "feat").unwrap();
        let sp = feat.sub_params.as_ref().unwrap();

        assert_eq!(sp.get("ON").map(|v| v.as_slice()), Some(&["--user-on".to_string()][..]));
        assert_eq!(sp.get("NEW").map(|v| v.as_slice()), Some(&["--extra-new".to_string()][..]));
    }

    #[test]
    fn validate_rejects_orphan_default() {
        let bad = make_user_param("ctx", &["8192"], "missing", 0);
        let errors = validate_provider_params("test", &[bad]);
        assert!(!errors.is_empty());
        assert!(errors.iter().any(|e| e.contains("defaultValue")));
    }

    #[test]
    fn dedupe_keeps_lowest_order_per_key() {
        let mut a = make_user_param("logit_bias", &["a"], "a", 5);
        a.label = "first".to_string();
        let mut b = make_user_param("logit_bias", &["b"], "b", 2);
        b.label = "second".to_string();
        let out = dedupe_user_params_by_key(vec![a, b]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].label, "second");
    }

    #[test]
    fn strip_windows_extended_prefix_removes_verbatim_marker() {
        assert_eq!(
            super::strip_windows_extended_prefix(r"\\?\C:\AI-MASTER\models"),
            r"C:\AI-MASTER\models"
        );
        assert_eq!(
            super::strip_windows_extended_prefix(r"\\?\UNC\server\share\models"),
            r"\\server\share\models"
        );
        assert_eq!(
            super::strip_windows_extended_prefix(r"C:\already\normal"),
            r"C:\already\normal"
        );
    }

    #[test]
    fn factory_placeholder_models_path_is_ignored_for_setup() {
        let fresh = AppConfig::default();
        assert!(!super::model_library_configured(&fresh));

        let base = std::env::temp_dir().join(format!("bwops-setup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("library root");
        std::fs::write(base.join("empty-library"), b"").expect("marker");

        let empty_library = AppConfig {
            model_paths: vec![ModelPathEntry {
                path: base.to_string_lossy().to_string(),
                label: "Empty".to_string(),
                is_default: true,
            }],
            gpu_slots: 0,
            hf_token: String::new(),
            providers: Vec::new(),
            default_download_path: Some(base.to_string_lossy().to_string()),
        };
        assert!(!super::model_library_configured(&empty_library));

        std::fs::write(base.join("demo.Q4_K_M.gguf"), b"gguf").expect("gguf");
        let with_models = AppConfig {
            model_paths: vec![ModelPathEntry {
                path: base.to_string_lossy().to_string(),
                label: "My Models".to_string(),
                is_default: true,
            }],
            gpu_slots: 0,
            hf_token: String::new(),
            providers: Vec::new(),
            default_download_path: Some(base.to_string_lossy().to_string()),
        };
        assert!(super::model_library_configured(&with_models));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn catalog_source_path_label_uses_parent_and_leaf() {
        assert_eq!(
            super::format_catalog_source_path_label(r"C:\Users\alice\.lmstudio\models"),
            ".lmstudio/models"
        );
        assert_eq!(
            super::format_catalog_source_path_label(r"D:\AI-MASTER\models"),
            "AI-MASTER/models"
        );
        assert_eq!(
            super::format_catalog_source_path_label(r"D:\models"),
            "D/models"
        );
    }

    #[test]
    fn model_path_dedupe_collapses_case_and_trailing_slash() {
        let mut paths = vec![
            ModelPathEntry {
                path: "D:\\AI-MASTER\\models".to_string(),
                label: "models".to_string(),
                is_default: false,
            },
            ModelPathEntry {
                path: "d:\\AI-MASTER\\models\\".to_string(),
                label: "models-dup".to_string(),
                is_default: true,
            },
        ];
        assert!(super::dedupe_model_paths(&mut paths));
        assert_eq!(paths.len(), 1);
        assert!(paths[0].is_default);
    }

    #[test]
    fn set_default_model_path_accepts_resolved_absolute_for_relative_models_entry() {
        let models_dir = default_models_dir();
        std::fs::create_dir_all(&models_dir).expect("models dir");

        let mut config = AppConfig {
            model_paths: vec![
                ModelPathEntry {
                    path: DEFAULT_MODEL_PATH_REL.to_string(),
                    label: DEFAULT_MODEL_PATH_LABEL.to_string(),
                    is_default: false,
                },
                ModelPathEntry {
                    path: "C:\\other\\models".to_string(),
                    label: "Other".to_string(),
                    is_default: true,
                },
            ],
            gpu_slots: 0,
            hf_token: String::new(),
            providers: Vec::new(),
            default_download_path: Some("C:\\other\\models".to_string()),
        };

        let resolved_models = resolve_stored_model_path(DEFAULT_MODEL_PATH_REL);
        set_default_model_path(&mut config, &resolved_models).expect("switch to bundled models");
        sanitize_model_paths(&mut config);

        let models_entry = config
            .model_paths
            .iter()
            .find(|p| model_path_key(&p.path) == model_path_key(DEFAULT_MODEL_PATH_REL))
            .expect("models entry");
        assert!(models_entry.is_default);
        assert_eq!(
            config.default_download_path.as_deref(),
            Some(DEFAULT_MODEL_PATH_REL)
        );
    }

    #[test]
    fn sanitize_keeps_single_default_and_syncs_memo() {
        let mut config = AppConfig {
            model_paths: vec![
                ModelPathEntry {
                    path: "C:\\path-a".to_string(),
                    label: "A".to_string(),
                    is_default: true,
                },
                ModelPathEntry {
                    path: "C:\\path-b".to_string(),
                    label: "B".to_string(),
                    is_default: true,
                },
            ],
            gpu_slots: 4,
            hf_token: String::new(),
            providers: Vec::new(),
            default_download_path: Some("C:\\path-b".to_string()),
        };
        assert!(super::sanitize_model_paths(&mut config));
        assert_eq!(config.model_paths.iter().filter(|p| p.is_default).count(), 1);
        // Explicit is_default wins over stale memo when both were flagged
        assert_eq!(config.default_download_path.as_deref(), Some("C:\\path-a"));
        assert!(config.model_paths.iter().find(|p| p.path == "C:\\path-a").unwrap().is_default);
    }

    #[test]
    fn sanitize_recovers_default_from_memo_when_unflagged() {
        let mut config = AppConfig {
            model_paths: vec![
                ModelPathEntry {
                    path: "C:\\path-a".to_string(),
                    label: "A".to_string(),
                    is_default: false,
                },
                ModelPathEntry {
                    path: "C:\\path-b".to_string(),
                    label: "B".to_string(),
                    is_default: false,
                },
            ],
            gpu_slots: 4,
            hf_token: String::new(),
            providers: Vec::new(),
            default_download_path: Some("C:\\path-b".to_string()),
        };
        assert!(super::sanitize_model_paths(&mut config));
        assert_eq!(config.model_paths.iter().filter(|p| p.is_default).count(), 1);
        assert_eq!(config.default_download_path.as_deref(), Some("C:\\path-b"));
        assert!(config.model_paths.iter().find(|p| p.path == "C:\\path-b").unwrap().is_default);
    }

    #[test]
    fn validate_download_dest_allows_nested_subfolders_under_existing_models_root() {
        let base = std::env::temp_dir().join(format!("bwops-dl-{}", std::process::id()));
        let models = base.join("models");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&models).expect("models root");

        let dest = models
            .join("JackRong")
            .join("Some-Model")
            .join("model-Q4_K_M.gguf");
        let config = AppConfig {
            model_paths: vec![ModelPathEntry {
                path: models.to_string_lossy().to_string(),
                label: "Models".to_string(),
                is_default: true,
            }],
            gpu_slots: 0,
            hf_token: String::new(),
            providers: Vec::new(),
            default_download_path: Some(models.to_string_lossy().to_string()),
        };

        super::validate_download_dest(&dest.to_string_lossy(), &config)
            .expect("nested dest under existing models root should validate");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn validate_download_dest_allows_forward_slash_dest_under_relative_models_root() {
        let base = std::env::temp_dir().join(format!("bwops-dl-mix-{}", std::process::id()));
        let models = base.join("models");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&models).expect("models root");

        // Simulate Model Hub: absolute default path + forward-slash segments
        let default_path = models.to_string_lossy();
        let dest = format!(
            "{}/JackRong/Some-Model/model-Q4_K_M.gguf",
            default_path.replace('\\', "/")
        );
        let config = AppConfig {
            model_paths: vec![ModelPathEntry {
                path: models.to_string_lossy().to_string(),
                label: "Models".to_string(),
                is_default: true,
            }],
            gpu_slots: 0,
            hf_token: String::new(),
            providers: Vec::new(),
            default_download_path: Some(models.to_string_lossy().to_string()),
        };

        super::validate_download_dest(&dest, &config)
            .expect("forward-slash dest under models root should validate");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn expand_path_placeholders_resolves_userprofile_segment() {
        std::env::set_var("BLACKOPS_TEST_HOME", r"C:\Users\ghost");
        let input = r"%BLACKOPS_TEST_HOME%\.lmstudio\models";
        let expanded = super::expand_path_placeholders(input);
        assert_eq!(expanded, r"C:\Users\ghost\.lmstudio\models");
        std::env::remove_var("BLACKOPS_TEST_HOME");
    }

    #[test]
    fn validate_hf_model_id_rejects_traversal_and_bad_format() {
        assert!(super::validate_hf_model_id("bartowski/Llama-3.1-8B-GGUF").is_ok());
        assert!(super::validate_hf_model_id("../evil/repo").is_err());
        assert!(super::validate_hf_model_id("author-only").is_err());
        assert!(super::validate_hf_model_id("bad\\segment/repo").is_err());
    }

    #[test]
    fn validate_download_file_name_rejects_path_segments() {
        assert!(super::validate_download_file_name("model-Q4_K_M.gguf").is_ok());
        assert!(super::validate_download_file_name("../escape.gguf").is_err());
        assert!(super::validate_download_file_name("sub/model.gguf").is_err());
        assert!(super::validate_download_file_name("readme.txt").is_err());
    }

    #[test]
    fn validate_download_url_matches_model_requires_hf_resolve_path() {
        let url = "https://huggingface.co/bartowski/Llama-3.1-8B-GGUF/resolve/main/model-Q4_K_M.gguf";
        assert!(super::validate_download_url_matches_model(
            url,
            "bartowski/Llama-3.1-8B-GGUF",
            "model-Q4_K_M.gguf"
        )
        .is_ok());
        assert!(super::validate_download_url_matches_model(
            url,
            "other/Repo",
            "model-Q4_K_M.gguf"
        )
        .is_err());
    }

    #[test]
    fn build_quant_dest_path_preserves_repo_subfolders() {
        let dest = super::build_quant_dest_path(
            r"C:\models",
            "bartowski/Llama-GGUF",
            "Q4_K_M/model-00001-of-00004.gguf",
        )
        .expect("valid dest");
        assert!(dest.replace('\\', "/").ends_with("Q4_K_M/model-00001-of-00004.gguf"));
    }

    #[test]
    fn normalize_hf_search_inputs_caps_limit_and_validates_sort() {
        let filters = super::normalize_hf_search_inputs(
            "llama".to_string(),
            Some(24),
            Some("likes".to_string()),
            Some(500),
        )
        .expect("valid search");
        assert_eq!(filters.limit, 100);
        assert_eq!(filters.sort, "likes");
        assert_eq!(filters.vram_limit_gb, 24);

        assert!(super::normalize_hf_search_inputs(
            "".to_string(),
            None,
            None,
            None
        )
        .is_err());
        assert!(super::normalize_hf_search_inputs(
            "llama".to_string(),
            None,
            Some("bogus".to_string()),
            None
        )
        .is_err());
    }

    fn make_grouped_param(key: &str, ui_group: &str, order: i32) -> crate::types::UserEditedTemplateParam {
        let mut p = make_user_param(key, &["a"], "a", order);
        p.ui_group = ui_group.to_string();
        p
    }

    #[test]
    fn factory_provider_rank_puts_master_first() {
        assert!(factory_provider_rank(DEFAULT_PROVIDER_ID) < factory_provider_rank("ggml-tom"));
    }

    #[test]
    fn finalize_factory_group_order_pins_system_last() {
        let order = finalize_factory_group_order(vec![
            "SYSTEM".into(),
            "PERFORMANCE".into(),
            "FEATURE-FLAGS".into(),
        ]);
        assert_eq!(order, vec!["PERFORMANCE", "FEATURE-FLAGS", "SYSTEM"]);
    }

    #[test]
    fn sort_params_for_factory_export_orders_by_group_then_order() {
        let group_order = vec![
            "ABOVE-CONFIG-LEFT".into(),
            "PERFORMANCE".into(),
            "SYSTEM".into(),
        ];
        let mut params = vec![
            make_grouped_param("base_port", "SYSTEM", 0),
            make_grouped_param("batch", "PERFORMANCE", 2),
            make_grouped_param("ctx", "ABOVE-CONFIG-LEFT", 1),
            make_grouped_param("split", "SYSTEM", 1),
        ];
        sort_params_for_factory_export(&mut params, &group_order);
        assert_eq!(
            params.iter().map(|p| p.key.as_str()).collect::<Vec<_>>(),
            vec!["ctx", "batch", "base_port", "split"]
        );
    }
}
