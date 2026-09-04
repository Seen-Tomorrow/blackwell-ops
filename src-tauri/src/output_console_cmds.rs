// ── Blackwell Output Console Commands ─────────────────────────────────
//!
//! Moved verbatim out of `main.rs`; bodies unchanged.

use crate::engine::AppContext;

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
