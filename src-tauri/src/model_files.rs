//! `model_files` — model-library file actions: native dialogs, Explorer reveal, delete and
//! rename.
//!
//! Seam: these are the commands that act on the model library as *files on disk*. They split
//! out of `engine.rs` because none of
//! them touches engine state — `AppContext` is taken only to reach the output console, never
//! the stack — which is why they are the safest region to have moved first, and why they do
//! not belong in the module that owns spawn/teardown.
//!
//! Sibling: `model_paths.rs` (which *paths* are configured) — this module acts on the files
//! those paths contain. On-disk *size* lives with the scan/catalog side, in `model_scan.rs`.

use crate::engine::AppContext;

#[tauri::command]
pub async fn open_file_dialog(title: Option<String>, _filter: Option<String>) -> Result<Option<String>, String> {
    let title = title.unwrap_or_else(|| "Select File".to_string());
    let result = tokio::task::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title(&title)
            .pick_file()
    })
    .await
    .map_err(|e| format!("File dialog panicked: {}", e))?;

    Ok(result.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn open_folder_dialog(title: Option<String>) -> Result<Option<String>, String> {
    let title = title.unwrap_or_else(|| "Select Model Folder".to_string());

    let result = tokio::task::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title(&title)
            .pick_folder()
    })
    .await
    .map_err(|e| format!("Folder dialog panicked: {}", e))?;

    Ok(result.map(|p| p.to_string_lossy().to_string()))
}

/// Open Explorer at a model path — selects the file when it exists, otherwise opens the folder.
#[tauri::command]
pub async fn reveal_path_in_explorer(path: String) -> Result<(), String> {
    let resolved = crate::config::resolve_model_path(&path);
    if resolved.is_empty() {
        return Err("Empty path".into());
    }
    let path = std::path::PathBuf::from(&resolved);
    if !path.exists() {
        return Err(format!("Path not found: {}", path.display()));
    }

    #[cfg(windows)]
    {
        reveal_path_in_explorer_windows(&path)
    }

    #[cfg(not(windows))]
    {
        let _ = path;
        Err("Reveal in file manager is supported on Windows only.".into())
    }
}

fn sanitize_model_rename_filename(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Filename cannot be empty".into());
    }
    if trimmed.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err("Filename cannot contain path separators or reserved characters".into());
    }
    let with_ext = if trimmed.to_lowercase().ends_with(".gguf") {
        trimmed.to_string()
    } else {
        format!("{trimmed}.gguf")
    };
    Ok(with_ext)
}

/// Move a catalog model file to the Recycle Bin.
#[tauri::command]
pub async fn delete_model_file_cmd(
    path: String,
    app: tauri::State<'_, AppContext>,
) -> Result<(), String> {
    let file = {
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        crate::config::validate_model_library_file(&path, &cfg)?
    };

    let in_use = {
        let stack = app.stack.lock().await;
        stack.model_path_in_active_use(&path)
    };
    if in_use {
        return Err("Cannot delete a model that is loading or running — stop the engine first".into());
    }

    let resolved = crate::config::resolve_model_path(&path);
    crate::trash_util::move_to_trash(&file)?;
    let _ = crate::model_cache::remove_cached(&resolved);
    Ok(())
}

/// Rename a catalog model file in place (same folder).
#[tauri::command]
pub async fn rename_model_file_cmd(
    path: String,
    new_file_name: String,
    app: tauri::State<'_, AppContext>,
) -> Result<String, String> {
    let file = {
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        crate::config::validate_model_library_file(&path, &cfg)?
    };

    let in_use = {
        let stack = app.stack.lock().await;
        stack.model_path_in_active_use(&path)
    };
    if in_use {
        return Err("Cannot rename a model that is loading or running — stop the engine first".into());
    }

    let new_name = sanitize_model_rename_filename(&new_file_name)?;
    let parent = file
        .parent()
        .ok_or_else(|| "Model file has no parent directory".to_string())?;
    let dest = parent.join(&new_name);
    if dest.exists() {
        return Err(format!("A file named \"{new_name}\" already exists in this folder"));
    }

    let old_resolved = crate::config::resolve_model_path(&path);
    std::fs::rename(&file, &dest).map_err(|e| format!("Failed to rename file: {e}"))?;
    let new_path = crate::config::resolve_model_path(&dest.to_string_lossy());
    let _ = crate::model_cache::rename_cached_path(&old_resolved, &new_path);
    Ok(new_path)
}

#[cfg(windows)]
fn reveal_path_in_explorer_windows(path: &std::path::Path) -> Result<(), String> {
    // Explorer expects `/select,` and the path as separate argv entries — a single
    // combined `/select,"C:\..."` arg falls through to the user Desktop.
    if path.is_file() {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to open Explorer: {}", e))?;
    } else {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to open Explorer: {}", e))?;
    }
    Ok(())
}
