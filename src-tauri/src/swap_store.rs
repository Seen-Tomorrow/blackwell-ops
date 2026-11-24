//! SWAP store — where every non-quant file lives (draft heads, mmproj, engram tables).
//!
//! The store can hold terabytes and users keep it on a different drive from the models,
//! so its location is a first-class setting: shown in CONFIG → MODEL PATHS, changeable,
//! and movable without losing the catalog. A move rewrites everything that pins an
//! absolute path into the store — companion pins and the cached extras index — because
//! those paths are the only places the old location is remembered.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
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

fn norm_path(raw: &str) -> String {
    raw.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// True when `candidate` IS a configured model library, or would contain one.
fn overlaps_library(candidate: &Path, model_roots: &[String]) -> bool {
    let c = norm_path(&candidate.to_string_lossy());
    if c.is_empty() {
        return false;
    }
    model_roots.iter().map(|r| norm_path(r)).any(|m| {
        m == c || m.starts_with(&format!("{c}\\"))
    })
}

/// Where a chosen folder actually lands.
///
/// Picking a model library is the natural mistake — and the hint itself says the store
/// belongs *inside* one (`<library>\model_EXTRAS`). Same for a drive root. Rather than
/// refusing with a message that contradicts the hint, both resolve to `<chosen>/model_EXTRAS`,
/// which is its own folder and cannot swallow the library.
pub(crate) fn resolve_store_target(chosen: &Path, model_roots: &[String]) -> Option<PathBuf> {
    if chosen.as_os_str().is_empty() {
        return None;
    }
    let mut candidate = chosen.to_path_buf();
    if overlaps_library(&candidate, model_roots) {
        candidate = candidate.join(crate::config::EXTRAS_DIR_NAME);
    }
    if overlaps_library(&candidate, model_roots) {
        return None;
    }
    Some(candidate)
}

fn model_roots(cfg: &crate::config::AppConfig) -> Vec<String> {
    crate::config::get_model_paths(cfg)
        .into_iter()
        .map(|e| e.path)
        .collect()
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
    let chosen = PathBuf::from(trimmed);
    if chosen.is_file() {
        return Err("That path is a file, not a folder".to_string());
    }
    let roots = {
        let cfg = crate::config::load_config();
        model_roots(&cfg)
    };
    let dir = resolve_store_target(&chosen, &roots)
        .ok_or_else(|| format!("Cannot use {} as the SWAP store", chosen.display()))?;
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
    let to = {
        let cfg = crate::config::load_config();
        let roots = model_roots(&cfg);
        // A store that is currently a model library must not be "moved": that would
        // relocate the whole library. CHANGE points the setting instead.
        if overlaps_library(&from, &roots) {
            return Err(format!(
                "The current store ({}) is a model library, not an extras folder. Use CHANGE \
                 to point the store at a dedicated folder first — MOVE would relocate the library.",
                from.display()
            ));
        }
        resolve_store_target(&to, &roots)
            .ok_or_else(|| format!("Cannot use {} as the SWAP store", to.display()))?
    };
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
    let from_prefix = from.to_string_lossy().to_ascii_lowercase();
    let to_prefix = to.to_string_lossy().to_string();
    let mut changed = 0usize;
    if let Some(map) = pins.get_mut("pins").and_then(|v| v.as_object_mut()) {
        for roles in map.values_mut() {
            if let Some(roles) = roles.as_object_mut() {
                for value in roles.values_mut() {
                    let Some(current) = value.as_str() else { continue };
                    if current.to_ascii_lowercase().starts_with(&from_prefix) {
                        if let Some(rest) = current.get(from_prefix.len()..) {
                            let next = format!("{}{}", to_prefix.trim_end_matches(['/', '\\']), rest);
                            *value = serde_json::Value::String(next);
                            changed += 1;
                        }
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
#[cfg(test)]
mod tests {
    use super::*;

    fn roots() -> Vec<String> {
        vec![r"E:\STORAGE-MODELS".to_string(), r"C:\AI-MASTER\models".to_string()]
    }

    fn resolve(raw: &str) -> Option<String> {
        resolve_store_target(&PathBuf::from(raw), &roots()).map(|p| p.to_string_lossy().to_string())
    }

    /// Picking a library means "this library's extras folder", not an error.
    #[test]
    fn library_choice_lands_in_its_own_model_extras() {
        assert_eq!(
            resolve(r"E:\STORAGE-MODELS").unwrap(),
            r"E:\STORAGE-MODELS\model_EXTRAS"
        );
    }

    /// A drive root contains the library, so it gets the same treatment instead of being
    /// refused for "containing a model library".
    #[test]
    fn drive_root_lands_in_model_extras_at_that_root() {
        assert_eq!(resolve(r"E:\").unwrap(), r"E:\model_EXTRAS");
    }

    /// The canonical store is left alone, however it is spelled.
    #[test]
    fn canonical_store_path_is_unchanged() {
        assert_eq!(
            resolve(r"C:\AI-MASTER\models\model_EXTRAS").unwrap(),
            r"C:\AI-MASTER\models\model_EXTRAS"
        );
        assert_eq!(
            resolve(r"C:\AI-MASTER\models\model_EXTRAS").unwrap(),
            r"C:\AI-MASTER\models\model_EXTRAS"
        );
    }

    /// An unrelated folder is taken as given.
    #[test]
    fn unrelated_folder_is_used_as_is() {
        assert_eq!(resolve(r"D:\swap").unwrap(), r"D:\swap");
    }
}