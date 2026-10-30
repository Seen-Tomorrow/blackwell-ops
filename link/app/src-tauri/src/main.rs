#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::Value;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, WebviewWindow, WindowEvent};

use oym_link_core::identity::{
    default_data_dir, load_identity, load_token, save_identity, Identity,
};
use oym_link_core::pairing::pair_device;
use oym_link_core::status::{probe, Probe};
use oym_link_core::{CLIENT_VERSION, PI_VERSION};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkStatus {
    mode: &'static str,
    connected: bool,
    paired: bool,
    device_name: String,
    gateway: String,
    version: &'static str,
    home_models: usize,
    cloud_model: String,
    cloud_key_stored: bool,
    server_version: Option<String>,
    public_url: Option<String>,
    session: bool,
    error: Option<String>,
}

impl LinkStatus {
    fn unpaired() -> Self {
        Self {
            mode: "portable",
            connected: false,
            paired: false,
            device_name: String::new(),
            gateway: String::new(),
            version: CLIENT_VERSION,
            home_models: 0,
            cloud_model: "deepseek-flash".into(),
            cloud_key_stored: false,
            server_version: None,
            public_url: None,
            session: false,
            error: None,
        }
    }

    fn from_probe(identity: &Identity, probe: Probe) -> Self {
        Self {
            mode: "portable",
            connected: true,
            paired: true,
            device_name: identity.name.clone(),
            gateway: identity.server.clone(),
            version: CLIENT_VERSION,
            home_models: probe.routes,
            cloud_model: "deepseek-flash".into(),
            cloud_key_stored: false,
            server_version: Some(probe.server_version),
            public_url: probe.public_url,
            session: probe.session,
            error: None,
        }
    }
}

fn default_settings() -> Value {
    serde_json::json!({
        "deviceName": "",
        "gatewayUrl": "",
        "cloudBaseUrl": "https://api.deepseek.com",
        "cloudModel": "deepseek-flash",
        "cloudKeyStored": false
    })
}

fn settings_path() -> std::path::PathBuf {
    default_data_dir().join("settings.json")
}

fn load_settings() -> Value {
    std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(default_settings)
}

fn save_settings(settings: &Value) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("create data dir: {error}"))?;
    }
    let raw = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    std::fs::write(&path, raw).map_err(|error| format!("write settings: {error}"))
}

fn device_name(settings: &Value) -> String {
    settings
        .get("deviceName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            std::env::var("COMPUTERNAME").unwrap_or_else(|_| "windows-device".into())
        })
}

async fn status_snapshot() -> LinkStatus {
    let data_dir = default_data_dir();
    let Some(identity) = load_identity(&data_dir) else {
        return LinkStatus::unpaired();
    };
    let token = match load_token(&identity) {
        Ok(token) => token,
        Err(error) => {
            let mut status = LinkStatus::unpaired();
            status.paired = true;
            status.device_name = identity.name;
            status.gateway = identity.server;
            status.error = Some(error);
            return status;
        }
    };
    match probe(
        &identity.server,
        &token,
        &identity.name,
        CLIENT_VERSION,
        PI_VERSION,
        "Medium",
    )
    .await
    {
        Ok(probe) => LinkStatus::from_probe(&identity, probe),
        Err(error) => {
            let mut status = LinkStatus::unpaired();
            status.paired = true;
            status.device_name = identity.name;
            status.gateway = identity.server;
            status.error = Some(error);
            status
        }
    }
}

#[tauri::command]
async fn link_status() -> Result<LinkStatus, String> {
    Ok(status_snapshot().await)
}

#[tauri::command]
async fn link_pair(code: String, server: String, name: Option<String>) -> Result<LinkStatus, String> {
    let server = server.trim().to_string();
    if server.is_empty() {
        return Err("Enter the gateway URL from REMOTE → STATUS first.".into());
    }
    let code = code.trim().to_string();
    if code.is_empty() {
        return Err("Enter the pairing code.".into());
    }
    let settings = load_settings();
    let name = name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| device_name(&settings));

    let (identity, _token) = pair_device(
        &server,
        &code,
        &name,
        CLIENT_VERSION,
        PI_VERSION,
        "Medium",
    )
    .await?;
    save_identity(&default_data_dir(), &identity)?;

    let mut settings = load_settings();
    if let Some(object) = settings.as_object_mut() {
        object.insert("gatewayUrl".into(), Value::String(server));
        if object
            .get("deviceName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .is_empty()
        {
            object.insert("deviceName".into(), Value::String(identity.name.clone()));
        }
    }
    let _ = save_settings(&settings);

    Ok(status_snapshot().await)
}

#[tauri::command]
fn link_assistant_start() -> Result<(), String> {
    Err("The local assistant launches in the next slice.".into())
}

#[tauri::command]
fn link_settings_get() -> Result<Value, String> {
    Ok(load_settings())
}

#[tauri::command]
fn link_settings_set(settings: Value) -> Result<(), String> {
    save_settings(&settings)
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

            show_flyout(app.handle());
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
