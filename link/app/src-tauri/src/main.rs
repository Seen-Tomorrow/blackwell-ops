#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::Value;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, WebviewWindow, WindowEvent};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkStatus {
    mode: &'static str,
    connected: bool,
    device_name: String,
    gateway: String,
    version: &'static str,
    home_models: usize,
    cloud_model: String,
    cloud_key_stored: bool,
}

fn default_settings() -> Value {
    serde_json::json!({
        "deviceName": "",
        "cloudBaseUrl": "https://api.deepseek.com",
        "cloudModel": "deepseek-flash",
        "cloudKeyStored": false
    })
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("app data dir: {error}"))?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn link_status() -> LinkStatus {
    LinkStatus {
        mode: "portable",
        connected: false,
        device_name: String::new(),
        gateway: String::new(),
        version: env!("CARGO_PKG_VERSION"),
        home_models: 0,
        cloud_model: "deepseek-flash".into(),
        cloud_key_stored: false,
    }
}

#[tauri::command]
fn link_pair(code: String) -> Result<(), String> {
    let _ = code;
    Err("Pairing is wired in the link-core slice.".into())
}

#[tauri::command]
fn link_assistant_start() -> Result<(), String> {
    Err("The local assistant launches in the link-core slice.".into())
}

#[tauri::command]
fn link_settings_get(app: AppHandle) -> Result<Value, String> {
    let path = settings_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|error| format!("parse settings: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(default_settings()),
        Err(error) => Err(format!("read settings: {error}")),
    }
}

#[tauri::command]
fn link_settings_set(app: AppHandle, settings: Value) -> Result<(), String> {
    let path = settings_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("create settings dir: {error}"))?;
    }
    let raw = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    std::fs::write(&path, raw).map_err(|error| format!("write settings: {error}"))
}

#[tauri::command]
fn link_hide(app: AppHandle) {
    if let Some(window) = app.get_webview_window("flyout") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn link_quit(app: AppHandle) {
    app.exit(0);
}

fn place_bottom_right(window: &WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let monitor_size = monitor.size();
    let monitor_pos = monitor.position();
    let margin = 16i32;
    let x = monitor_pos.x + monitor_size.width as i32 - size.width as i32 - margin;
    let y = monitor_pos.y + monitor_size.height as i32 - size.height as i32 - margin;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn show_flyout(app: &AppHandle) {
    let Some(window) = app.get_webview_window("flyout") else {
        return;
    };
    place_bottom_right(&window);
    let _ = window.show();
    let _ = window.set_focus();
}

fn toggle_flyout(app: &AppHandle) {
    let Some(window) = app.get_webview_window("flyout") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        place_bottom_right(&window);
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            link_status,
            link_pair,
            link_assistant_start,
            link_settings_get,
            link_settings_set,
            link_hide,
            link_quit
        ])
        .setup(|app| {
            let open = MenuItemBuilder::with_id("open", "Open OYM Link").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&open, &quit]).build()?;

            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?;

            TrayIconBuilder::with_id("oym")
                .icon(icon)
                .tooltip("OYM Link")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_flyout(tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_flyout(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            show_flyout(&app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running OYM Link");
}
