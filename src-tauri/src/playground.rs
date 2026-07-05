//! Playground helpers — open generated HTML in the system default browser.

#[tauri::command]
pub async fn playground_open_html_in_browser(html: String) -> Result<String, String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let path = std::env::temp_dir().join(format!("blackwell-playground-{ts}.html"));
    std::fs::write(&path, &html).map_err(|e| format!("Failed to write preview file: {e}"))?;

    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path.to_string_lossy()])
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
    }

    #[cfg(not(windows))]
    {
        let _ = (&html, &path);
        return Err("Open in browser is supported on Windows only.".into());
    }

    Ok(path.to_string_lossy().to_string())
}