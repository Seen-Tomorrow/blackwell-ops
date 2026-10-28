// ── Blackwell Output Console Commands ─────────────────────────────────
//!
//! Moved verbatim out of `main.rs`; bodies unchanged.

use crate::engine::AppContext;

/// Folder used by SAVE AS / OPEN LOG FOLDER for console logs: the live session
/// directory when logging is active, else the durable sessions root.
fn console_logs_dir() -> std::path::PathBuf {
    crate::session_log::current_dir().unwrap_or_else(|| {
        crate::config::config_dir().join("logs").join("sessions")
    })
}

/// Native Save As dialog for the current console buffer (replaces the old
/// WebView `<a download>` path, which does nothing in Tauri/WebView2).
#[tauri::command]
pub async fn save_output_console_text(
    default_name: String,
    content: String,
) -> Result<Option<String>, String> {
    let dir = console_logs_dir();
    let _ = std::fs::create_dir_all(&dir);
    let default_name = if default_name.trim().is_empty() {
        "blackwell-console.log".to_string()
    } else {
        default_name
    };

    let picked = tokio::task::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("Save console log")
            .set_directory(&dir)
            .set_file_name(&default_name)
            .add_filter("Log files", &["log", "txt"])
            .save_file()
    })
    .await
    .map_err(|e| format!("Save dialog panicked: {e}"))?;

    let Some(path) = picked else {
        return Ok(None);
    };
    std::fs::write(&path, content).map_err(|e| format!("Could not write log: {e}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Reveal the console/session log folder in Explorer.
#[tauri::command]
pub async fn open_output_console_logs_folder() -> Result<String, String> {
    let dir = console_logs_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create log folder: {e}"))?;

    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("Could not open Explorer: {e}"))?;
        Ok(dir.to_string_lossy().to_string())
    }
    #[cfg(not(windows))]
    {
        Err(format!("Log folder: {}", dir.display()))
    }
}

#[tauri::command]
pub async fn get_blackwell_output_console_categories() -> Vec<String> {
    use crate::output_console::BlackwellOutputConsoleCategory;
    vec![
        BlackwellOutputConsoleCategory::Engines.identifier().to_string(),
        BlackwellOutputConsoleCategory::Utils.identifier().to_string(),
        BlackwellOutputConsoleCategory::Foundry.identifier().to_string(),
        BlackwellOutputConsoleCategory::Error.identifier().to_string(),
        BlackwellOutputConsoleCategory::General.identifier().to_string(),
        BlackwellOutputConsoleCategory::Scenarios.identifier().to_string(),
        BlackwellOutputConsoleCategory::Debug.identifier().to_string(),
    ]
}

#[tauri::command]
pub async fn get_blackwell_output_console_buffer_for_category(
    category: String,
    limit: Option<usize>,
    app: tauri::State<'_, AppContext>,
) -> Result<Vec<crate::output_console::BlackwellOutputConsoleTextLine>, String> {
    use crate::output_console::BlackwellOutputConsoleCategory;

    let cat = BlackwellOutputConsoleCategory::from_identifier(&category)
        .ok_or_else(|| "Unknown category".to_string())?;

    let lines = app.blackwell_output_console_manager
        .get_recent_lines_for_category(cat, limit.unwrap_or(500));

    Ok(lines)
}

#[tauri::command]
pub async fn get_blackwell_output_console_latest_line(
    app: tauri::State<'_, AppContext>,
) -> Result<Option<crate::output_console::BlackwellOutputConsoleLatestLine>, String> {
    Ok(app.blackwell_output_console_manager.get_latest_line_across_categories())
}

#[tauri::command]
pub async fn clear_blackwell_output_console_category(
    category: String,
    app: tauri::State<'_, AppContext>,
) -> Result<(), String> {
    use crate::output_console::BlackwellOutputConsoleCategory;

    let cat = BlackwellOutputConsoleCategory::from_identifier(&category)
        .ok_or_else(|| "Unknown category".to_string())?;

    app.blackwell_output_console_manager.clear_category_buffer(cat);
    Ok(())
}

#[tauri::command]
pub async fn clear_all_blackwell_output_console_buffers(
    app: tauri::State<'_, AppContext>,
) -> Result<(), String> {
    app.blackwell_output_console_manager.clear_all_buffers();
    Ok(())
}

// ── End Blackwell Output Console Commands ─────────────────────────────

#[tauri::command]
pub async fn emit_to_blackwell_console(
    category: String,
    content: String,
    style: String,
    app: tauri::State<'_, AppContext>,
) -> Result<(), String> {
    use crate::output_console::BlackwellOutputConsoleCategory;
    use crate::output_console::BlackwellOutputConsoleLineStyle;

    let cat = BlackwellOutputConsoleCategory::from_identifier(&category)
        .ok_or_else(|| "Unknown category".to_string())?;

    let style = match style.as_str() {
        "Normal" => BlackwellOutputConsoleLineStyle::Normal,
        "Command" => BlackwellOutputConsoleLineStyle::Command,
        "Success" => BlackwellOutputConsoleLineStyle::Success,
        "Warning" => BlackwellOutputConsoleLineStyle::Warning,
        "Error" => BlackwellOutputConsoleLineStyle::Error,
        "Highlight" => BlackwellOutputConsoleLineStyle::Highlight,
        _ => BlackwellOutputConsoleLineStyle::Normal,
    };

    // Split content by newlines and emit each line separately
    for line in content.lines() {
        if !line.is_empty() {
            app.blackwell_output_console_manager.emit_line_to_category(cat, line.to_string(), style);
        }
    }

    Ok(())
}
