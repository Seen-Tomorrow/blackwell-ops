//! Model library path management + download destination validation.

use std::collections::HashMap;
use std::path::PathBuf;
use crate::config::*;
use crate::types::{ModelLibraryValidation, ModelPathEntry, PathDiskUsage};


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

pub const DEFAULT_MODEL_PATH_LABEL: &str = "Models";

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

pub fn default_model_path_entry() -> ModelPathEntry {
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
pub fn strip_windows_extended_prefix(path: &str) -> String {
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

pub fn find_model_path_index(paths: &[ModelPathEntry], path: &str) -> Option<usize> {
    let key = model_path_key(path);
    if key.is_empty() {
        return None;
    }
    paths.iter().position(|p| model_path_key(&p.path) == key)
}

/// Collapse duplicate model paths (same folder, different strings). Returns true if anything changed.
pub fn dedupe_model_paths(paths: &mut Vec<ModelPathEntry>) -> bool {
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
