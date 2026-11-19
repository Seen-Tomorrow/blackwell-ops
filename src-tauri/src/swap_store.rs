//! SWAP store — where every non-quant file lives (draft heads, mmproj, engram tables).
//!
//! The store can hold terabytes and users keep it on a different drive from the models,
//! so its location is a first-class setting: shown in CONFIG → MODEL PATHS, changeable,
//! and movable without losing the catalog. A move rewrites everything that pins an
//! absolute path into the store — companion pins and the cached extras index — because
//! those paths are the only places the old location is remembered.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapStoreInfo {
    pub path: String,
    pub exists: bool,
    pub files: usize,
    pub bytes: u64,
}

fn store_path() -> Option<PathBuf> {
    let cfg = crate::config::load_config();
    crate::config::get_extras_paths(&cfg)
        .into_iter()
        .map(|e| PathBuf::from(e.path))
        .find(|p| !p.as_os_str().is_empty())
}

/// Recursive file count + byte total. Missing folder = zeroes, never an error: the store
/// is created lazily by the first download.
fn measure(dir: &Path) -> (usize, u64) {
    let mut files = 0usize;
    let mut bytes = 0u64;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (0, 0);
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            let (f, b) = measure(&entry.path());
            files += f;
            bytes += b;
        } else if meta.is_file() {
            files += 1;
            bytes += meta.len();
        }
    }
    (files, bytes)
}

fn info_for(path: &Path) -> SwapStoreInfo {
    let (files, bytes) = measure(path);
    SwapStoreInfo {
        path: path.to_string_lossy().to_string(),
        exists: path.is_dir(),
        files,
        bytes,
    }
}

#[tauri::command]
pub fn swap_store_info() -> SwapStoreInfo {
    match store_path() {
        Some(path) => info_for(&path),
        None => SwapStoreInfo {
            path: String::new(),
            exists: false,
            files: 0,
            bytes: 0,
        },
    }
}

/// Point the store at `path`, creating it. Existing files are NOT moved here — that is
/// `move_swap_store`, which is explicit about cost and failure.
#[tauri::command]
pub fn set_swap_store(path: String) -> Result<SwapStoreInfo, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Pick a folder for the SWAP store".to_string());
    }
    let dir = PathBuf::from(trimmed);
    if dir.is_file() {
        return Err("That path is a file, not a folder".to_string());
    }
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;

    let mut cfg = crate::config::load_config();
    cfg.extras_paths = vec![crate::types::ModelPathEntry {
        path: dir.to_string_lossy().to_string(),
        label: crate::config::EXTRAS_DIR_NAME.to_string(),
        is_default: false,
    }];
    crate::config::save_config(&mut cfg)?;
    // The catalog caches attachment paths; a new store invalidates that view.
    invalidate_catalog_cache();
    Ok(info_for(&dir))
}

/// Move the store's contents to `target`, then re-point the setting and every absolute
/// path that remembered the old one.
#[tauri::command]
pub fn move_swap_store(target: String) -> Result<SwapStoreInfo, String> {
    let from = store_path().ok_or_else(|| "No SWAP store configured".to_string())?;
    let to = PathBuf::from(target.trim());
    if to.as_os_str().is_empty() {
        return Err("Pick a destination folder".to_string());
    }
    if same_path(&from, &to) {
        return Ok(info_for(&from));
    }
    std::fs::create_dir_all(&to).map_err(|e| format!("Failed to create {}: {e}", to.display()))?;
    if !from.is_dir() {
        // Nothing to move — just re-point.
        return set_swap_store(to.to_string_lossy().to_string());
    }

    let mut failures: Vec<String> = Vec::new();
    let Ok(entries) = std::fs::read_dir(&from) else {
        return Err(format!("Cannot read {}", from.display()));
    };
    for entry in entries.flatten() {
        let src = entry.path();
        let Some(name) = src.file_name() else { continue };
        let dest = to.join(name);
        if dest.exists() {
            failures.push(format!("{} already exists at the destination", src.display()));
            continue;
        }
        if let Err(e) = move_path(&src, &dest) {
            failures.push(format!("{}: {e}", src.display()));
        }
    }
    if !failures.is_empty() {
        return Err(format!(
            "Move incomplete, nothing was re-pointed: {}",
            failures.join("; ")
        ));
    }
    let info = set_swap_store(to.to_string_lossy().to_string())?;
    repoint_pins(&from, &to);
    invalidate_catalog_cache();
    Ok(info)
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Rename, then fall back to copy + delete across volumes.
fn move_path(src: &Path, dest: &Path) -> Result<(), String> {
    if std::fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    if src.is_dir() {
        copy_dir(src, dest)?;
        std::fs::remove_dir_all(src).map_err(|e| e.to_string())?;
    } else {
        std::fs::copy(src, dest).map_err(|e| e.to_string())?;
        std::fs::remove_file(src).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn copy_dir(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let target = dest.join(path.file_name().ok_or("bad name")?);
        if path.is_dir() {
            copy_dir(&path, &target)?;
        } else {
            std::fs::copy(&path, &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Pins remember absolute paths. Rewrite the ones that point into the old store.
fn repoint_pins(from: &Path, to: &Path) {
    let path = crate::config::config_dir()
        .join("cache")
        .join("companion_pins.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    let Ok(mut pins) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    let from_prefix = from.to_string_lossy().to_lowercase();
    let to_prefix = to.to_string_lossy().to_string();
    let mut changed = 0usize;
    if let Some(map) = pins.get_mut("pins").and_then(|v| v.as_object_mut()) {
        for roles in map.values_mut() {
            if let Some(roles) = roles.as_object_mut() {
                for value in roles.values_mut() {
                    let Some(current) = value.as_str() else { continue };
                    if current.to_lowercase().starts_with(&from_prefix) {
                        let rest = &current[from_prefix.len()..];
                        let next = format!("{}{}", to_prefix.trim_end_matches(['/', '\\']), rest);
                        *value = serde_json::Value::String(next);
                        changed += 1;
                    }
                }
            }
        }
    }
    if changed > 0 {
        if let Err(e) = crate::fs_util::write_json_atomic(&path, &pins) {
            log::warn!("[swap-store] moved {changed} pin(s) but could not save them: {e}");
        } else {
            log::info!("[swap-store] re-pointed {changed} companion pin(s)");
        }
    }
}

/// The catalog's attachment inventory caches absolute paths; drop it so the next scan
/// rebuilds against the new store.
fn invalidate_catalog_cache() {
    let index = crate::config::config_dir().join("cache").join("extras_index.json");
    let _ = std::fs::remove_file(index);
}
