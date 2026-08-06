//! Path/directory infrastructure, portable structure setup, and shared constants.
//! Extracted from the former config.rs god-file to reduce maintenance surface.

use std::path::PathBuf;
use tauri::{Manager, path::BaseDirectory};
use crate::config::*;


pub const ABSOLUTE_MAX_ENGINE_SLOTS: usize = 128;

/// Default provider ID — bundled with the app, always present.
pub const DEFAULT_PROVIDER_ID: &str = "ggml-master";

/// Retired **factory** plugin ids — not rediscovered from runtime/, not merged as factory.
/// User-created `template_type=custom` providers may reuse these ids (e.g. a custom "ik" fork).
pub const PHASED_OUT_PROVIDER_IDS: &[&str] = &["ik"];

pub fn is_phased_out_provider(id: &str) -> bool {
    PHASED_OUT_PROVIDER_IDS
        .iter()
        .any(|p| p.eq_ignore_ascii_case(id))
}

/// Drop phased-out **factory** metas only — keep user custom providers with the same id.
pub fn should_drop_user_meta(meta: &crate::types::ProviderConfig) -> bool {
    if !is_phased_out_provider(&meta.id) {
        return false;
    }
    // Custom re-registration of a retired id is allowed
    if is_custom_template_type(&meta.template_type) {
        return false;
    }
    true
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
        // pi-ext (pi-subagents factory) — same pattern: Tauri Resource → app_root/pi-ext
        // so pi_code can seed the isolated pi-home without a manual copy.
        if let Err(e) = ensure_pi_ext_materialized(app_handle) {
            log::warn!("[setup] pi-ext materialize: {e}");
        }
    }

    log::info!("[setup] Portable structure ready at {}", root.display());
}

/// Materialize bundled `pi-ext/` next to the exe (REL).
///
/// Tauri ships it under BaseDirectory::Resource; portable/NSIS layouts may not
/// leave a ready `app_root/pi-ext` until we copy it (mirrors runtime/).
/// Safe to call every launch — no-ops when `pi-ext/pi-subagents/package.json` exists.
pub fn ensure_pi_ext_materialized(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let dest = app_root_dir().join("pi-ext");
    let marker = dest.join("pi-subagents").join("package.json");
    if marker.is_file() {
        return Ok(());
    }

    let resource_path = app_handle
        .path()
        .resolve("pi-ext", BaseDirectory::Resource)
        .map_err(|e| format!("resolve pi-ext resource: {e}"))?;

    if !resource_path.is_dir() {
        return Err(format!(
            "pi-ext resource missing at {} (NSIS/App bundle incomplete)",
            resource_path.display()
        ));
    }

    let src_pkg = resource_path.join("pi-subagents").join("package.json");
    if !src_pkg.is_file() {
        return Err(format!(
            "pi-ext resource incomplete (no pi-subagents/package.json under {})",
            resource_path.display()
        ));
    }

    if dest.exists() {
        let _ = std::fs::remove_dir_all(&dest);
    }
    copy_directory_tree(&resource_path, &dest)
        .map_err(|e| format!("copy pi-ext → app root: {e}"))?;
    log::info!(
        "[setup] Materialized pi-ext → {} (from resource {})",
        dest.display(),
        resource_path.display()
    );
    Ok(())
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

