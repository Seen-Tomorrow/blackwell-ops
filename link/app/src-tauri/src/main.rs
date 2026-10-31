#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child as StdChild, Command, Stdio};
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
#[cfg(not(windows))]
use tauri::PhysicalPosition;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

use oym_link_core::identity::{
    clear_cloud_key, cloud_key_stored as cloud_key_present, default_data_dir, load_identity,
    load_token, save_cloud_key, save_identity, Identity,
};
use oym_link_core::pairing::{pair_device, pair_with_invite};
use oym_link_core::status::{probe, Probe};
use oym_link_core::{ModelRoute, CLIENT_VERSION, PI_VERSION};

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
    home_routes: Vec<ModelRoute>,
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
            home_routes: Vec::new(),
            cloud_model: "deepseek-flash".into(),
            cloud_key_stored: false,
            server_version: None,
            public_url: None,
            session: false,
            error: None,
        }
    }

    fn from_probe(identity: &Identity, probe: Probe) -> Self {
        let home_models = probe.routes.len();
        Self {
            mode: "portable",
            connected: true,
            paired: true,
            device_name: identity.name.clone(),
            gateway: identity.server.clone(),
            version: CLIENT_VERSION,
            home_models,
            home_routes: probe.routes,
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

struct AssistantSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
struct AssistantState {
    session: Mutex<Option<AssistantSession>>,
}

#[derive(Default)]
struct HelperState {
    child: Mutex<Option<StdChild>>,
}

#[derive(Deserialize)]
struct Invite {
    server: String,
    #[serde(default)]
    code: String,
    #[serde(default)]
    invite: Option<String>,
    #[serde(default)]
    owner: Option<String>,
    #[serde(default)]
    helper: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    paired: bool,
    helper: bool,
    owner: Option<String>,
    device_name: String,
    gateway: String,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceStatusView {
    installed: bool,
    running: bool,
    pid: Option<u32>,
    child_pid: Option<u32>,
    connected: bool,
    session_active: bool,
    updated_at: Option<u64>,
    error: Option<String>,
}

fn service_dir() -> Option<PathBuf> {
    std::env::var_os("PROGRAMDATA")
        .map(PathBuf::from)
        .map(|dir| dir.join("OYM").join("Link").join("service"))
}

#[tauri::command]
fn service_status() -> ServiceStatusView {
    let installed = service_dir()
        .map(|dir| dir.join("OymLink.xml").is_file())
        .unwrap_or(false);
    let status_path = std::env::var_os("PROGRAMDATA").map(|dir| {
        PathBuf::from(dir)
            .join("OYM")
            .join("Link")
            .join("service-status.json")
    });

    let mut view = ServiceStatusView {
        installed,
        running: false,
        pid: None,
        child_pid: None,
        connected: false,
        session_active: false,
        updated_at: None,
        error: None,
    };

    // A stale service-status.json from a previous install must not make the app
    // look INTEGRATED/SYSTEM after the service was uninstalled.
    if !installed {
        return view;
    }

    let Some(status_path) = status_path else {
        view.error = Some("PROGRAMDATA is not set".into());
        return view;
    };
    let raw = match std::fs::read_to_string(&status_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return view,
        Err(error) => {
            view.error = Some(format!("read service status: {error}"));
            return view;
        }
    };
    let value: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => {
            view.error = Some(format!("parse service status: {error}"));
            return view;
        }
    };
    view.pid = value.get("pid").and_then(Value::as_u64).map(|pid| pid as u32);
    view.child_pid = value
        .get("childPid")
        .and_then(Value::as_u64)
        .map(|pid| pid as u32);
    view.connected = value
        .get("connected")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    view.session_active = value
        .get("sessionActive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    view.updated_at = value.get("updatedAt").and_then(Value::as_u64);
    view.error = value
        .get("error")
        .and_then(Value::as_str)
        .map(str::to_string);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    view.running = view
        .updated_at
        .map(|updated| now.saturating_sub(updated) < 10)
        .unwrap_or(false);
    view
}

fn repo_script(name: &str) -> Result<PathBuf, String> {
    let mut roots = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors().take(8) {
            roots.push(ancestor.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    for root in roots {
        for relative in [PathBuf::from("scripts"), PathBuf::from("service")] {
            let candidate = root.join(relative).join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(format!("{name} not found; reinstall the app with its service assets"))
}

#[cfg(windows)]
fn launch_elevated_script(name: &str, extra: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let script = repo_script(name)?;
    let script = script.to_string_lossy().to_string();
    let params = format!(
        "-NoProfile -ExecutionPolicy Bypass -File \"{script}\"{}",
        if extra.is_empty() {
            String::new()
        } else {
            format!(" {extra}")
        }
    );
    let verb: Vec<u16> = "runas\0".encode_utf16().collect();
    let file: Vec<u16> = "pwsh.exe\0".encode_utf16().collect();
    let params: Vec<u16> = params.encode_utf16().chain(std::iter::once(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            params.as_ptr(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        return Err(format!("could not start elevated installer (ShellExecuteW {result:?})"));
    }
    Ok(())
}

#[cfg(not(windows))]
fn launch_elevated_script(_name: &str, _extra: &str) -> Result<(), String> {
    Err("service install is Windows-only".into())
}

#[tauri::command]
fn link_portable_start(app: AppHandle) -> Result<(), String> {
    start_helper_client(&app)
}

#[tauri::command]
fn service_install(app: AppHandle) -> Result<(), String> {
    // The service owns the link; stop the portable child first so the device
    // does not connect twice.
    stop_helper(&app);
    let data_dir = default_data_dir();
    let identity = load_identity(&data_dir).ok_or_else(|| {
        "Pair this device in Portable mode first; the service uses its device identity.".to_string()
    })?;
    let token = load_token(&identity)?;
    let bootstrap = data_dir.join("service-bootstrap.json");
    let payload = serde_json::json!({
        "identity": identity,
        "token": token,
    });
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| format!("create data dir: {error}"))?;
    std::fs::write(
        &bootstrap,
        serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("write service bootstrap: {error}"))?;
    let extra = format!("-Bootstrap \"{}\"", bootstrap.display());
    let extra = if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let service_dir = dir.join("service");
            if service_dir.join("oym-link-service.exe").is_file() {
                format!(
                    "{extra} -ServiceExe \"{}\" -Cli \"{}\" -PiDir \"{}\" -Xml \"{}\"",
                    service_dir.join("oym-link-service.exe").display(),
                    dir.join("oym-link.exe").display(),
                    dir.join("pi").display(),
                    service_dir.join("OymLink.xml").display(),
                )
            } else {
                extra
            }
        } else {
            extra
        }
    } else {
        extra
    };
    if let Err(error) = launch_elevated_script("install-oym-service.ps1", &extra) {
        let _ = std::fs::remove_file(&bootstrap);
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
fn service_uninstall() -> Result<(), String> {
    launch_elevated_script("uninstall-oym-service.ps1", "")
}

/// Find a dev/packaged artifact by walking up from the app exe (works from
/// `link/app/src-tauri/target/debug` back to the repo root) and from the cwd.
fn find_tool(env_var: &str, repo_relative: &str, exe_relative: &str) -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os(env_var) {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Ok(path);
        }
    }
    let mut roots = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors().take(8) {
            roots.push(ancestor.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    for root in roots {
        for relative in [repo_relative, exe_relative] {
            let candidate = root.join(relative);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        let runtime_candidate = root.join("runtime").join(exe_relative);
        if runtime_candidate.is_file() {
            return Ok(runtime_candidate);
        }
    }
    Err(format!(
        "could not find {env_var} artifact (`{repo_relative}`). This exe is probably outside its package; run the NSIS helper, place the CLI/Pi next to OYM-Help.exe, or pass {env_var} explicitly"
    ))
}

fn helper_requested() -> bool {
    if std::env::args().any(|arg| arg == "--helper") {
        return true;
    }
    // The packaged helper is installed as OYM-Help.exe. A normal OYM Link
    // install shares %LOCALAPPDATA%\OYM\Link settings, so a persisted
    // helper=true must not turn the normal app into the helper UI.
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.file_stem().map(|stem| stem.to_owned()))
        .map(|stem| stem.eq_ignore_ascii_case("OYM-Help"))
        .unwrap_or(false)
}

fn invite_path() -> Option<PathBuf> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--invite" {
            if let Some(path) = args.next() {
                return Some(PathBuf::from(path));
            }
        }
    }
    if let Some(path) = std::env::var_os("OYM_INVITE") {
        return Some(PathBuf::from(path));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("oym-invite.json");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let candidate = cwd.join("oym-invite.json");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn start_helper_client(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<HelperState>();
    let mut guard = state
        .child
        .lock()
        .map_err(|_| "helper state poisoned".to_string())?;
    if let Some(child) = guard.as_mut() {
        if child.try_wait().ok().flatten().is_none() {
            return Ok(());
        }
    }

    let cli = find_tool(
        "OYM_LINK_CLI",
        "remote-client/target/release/oym-link.exe",
        "oym-link.exe",
    )?;
    let pi = find_tool(
        "OYM_PI",
        "tmp/blackwell-link-package/pi/pi.exe",
        "pi/pi.exe",
    )?;
    let mut command = Command::new(cli);
    command
        .arg("--quiet")
        .arg("--pi")
        .arg(pi)
        .arg("--data-dir")
        .arg(default_data_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let child = command
        .spawn()
        .map_err(|error| format!("start helper link: {error}"))?;
    *guard = Some(child);
    Ok(())
}

fn stop_helper(app: &AppHandle) {
    let state = app.state::<HelperState>();
    if let Ok(mut guard) = state.child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    };
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HelperLinkStatus {
    linked: bool,
    session_active: bool,
    updated_at: Option<u64>,
    error: Option<String>,
}

#[tauri::command]
fn helper_stopped() -> bool {
    load_settings()
        .get("helperStopped")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

#[tauri::command]
fn helper_link_status() -> HelperLinkStatus {
    let path = default_data_dir().join("link-status.json");
    let mut status = HelperLinkStatus {
        linked: false,
        session_active: false,
        updated_at: None,
        error: None,
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return status,
        Err(error) => {
            status.error = Some(format!("read link status: {error}"));
            return status;
        }
    };
    let value: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => {
            status.error = Some(format!("parse link status: {error}"));
            return status;
        }
    };
    let updated_at = value.get("updatedAt").and_then(Value::as_u64);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let fresh = updated_at
        .map(|updated| now.saturating_sub(updated) < 15)
        .unwrap_or(false);
    status.updated_at = updated_at;
    status.linked = fresh && value.get("connected").and_then(Value::as_bool).unwrap_or(false);
    status.session_active =
        status.linked && value.get("sessionActive").and_then(Value::as_bool).unwrap_or(false);
    status
}

fn set_helper_stopped(stopped: bool) -> Result<(), String> {
    let mut settings = load_settings();
    if let Some(object) = settings.as_object_mut() {
        object.insert("helperStopped".into(), Value::Bool(stopped));
    }
    save_settings(&settings)
}

#[tauri::command]
fn helper_stop(app: AppHandle) -> Result<(), String> {
    stop_helper(&app);
    set_helper_stopped(true)
}

#[tauri::command]
fn helper_reconnect(app: AppHandle) -> Result<(), String> {
    set_helper_stopped(false)?;
    start_helper_client(&app)
}

#[tauri::command]
fn helper_close(app: AppHandle) {
    stop_helper(&app);
    app.exit(0);
}

#[tauri::command]
fn helper_forget(app: AppHandle) -> Result<(), String> {
    stop_helper(&app);
    let data_dir = default_data_dir();
    if let Some(identity) = load_identity(&data_dir) {
        let _ = oym_link_core::identity::delete_token(&identity);
    }
    let _ = std::fs::remove_file(data_dir.join("identity.json"));
    let _ = std::fs::remove_file(data_dir.join("link-status.json"));
    if let Some(invite) = invite_path() {
        let _ = std::fs::remove_file(invite);
    }
    set_helper_stopped(true)
}

#[tauri::command]
async fn invite_bootstrap(app: AppHandle) -> Bootstrap {
    let settings = load_settings();
    let data_dir = default_data_dir();
    let mut helper = helper_requested();
    let mut owner = settings
        .get("owner")
        .and_then(Value::as_str)
        .map(str::to_string);

    if let Some(identity) = load_identity(&data_dir) {
        let stopped = settings
            .get("helperStopped")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let service_hosted = service_dir()
            .map(|dir| dir.join("OymLink.xml").is_file())
            .unwrap_or(false);
        let error = if helper && !stopped {
            start_helper_client(&app).err()
        } else if !service_hosted {
            // Normal Portable mode: run the same hidden link client as the
            // helper so this device is visible in Blackwell and can be opened.
            start_helper_client(&app).err()
        } else {
            None
        };
        return Bootstrap {
            paired: true,
            helper,
            owner,
            device_name: identity.name,
            gateway: identity.server,
            error,
        };
    }

    let Some(path) = invite_path() else {
        return Bootstrap {
            paired: false,
            helper,
            owner,
            device_name: String::new(),
            gateway: String::new(),
            error: None,
        };
    };

    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) => {
            return Bootstrap {
                paired: false,
                helper,
                owner,
                device_name: String::new(),
                gateway: String::new(),
                error: Some(format!("read invite: {error}")),
            }
        }
    };
    let invite: Invite = match serde_json::from_str(&raw) {
        Ok(invite) => invite,
        Err(error) => {
            return Bootstrap {
                paired: false,
                helper,
                owner,
                device_name: String::new(),
                gateway: String::new(),
                error: Some(format!("invalid invite: {error}")),
            }
        }
    };
    helper = invite.helper.unwrap_or(true);
    owner = invite.owner.clone();
    let name = device_name(&settings);

    let pair_result = if let Some(token) = invite
        .invite
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        pair_with_invite(
            &invite.server,
            token,
            &name,
            CLIENT_VERSION,
            PI_VERSION,
            "Medium",
        )
        .await
    } else {
        pair_device(
            &invite.server,
            &invite.code,
            &name,
            CLIENT_VERSION,
            PI_VERSION,
            "Medium",
        )
        .await
    };
    let (identity, _token) = match pair_result {
        Ok(pair) => pair,
        Err(error) => {
            return Bootstrap {
                paired: false,
                helper,
                owner,
                device_name: String::new(),
                gateway: invite.server,
                error: Some(error),
            }
        }
    };

    if let Err(error) = save_identity(&data_dir, &identity) {
        return Bootstrap {
            paired: false,
            helper,
            owner,
            device_name: identity.name,
            gateway: identity.server,
            error: Some(error),
        };
    }

    let mut settings = load_settings();
    if let Some(object) = settings.as_object_mut() {
        object.insert("gatewayUrl".into(), Value::String(invite.server.clone()));
        object.insert("helper".into(), Value::Bool(helper));
        object.insert("helperStopped".into(), Value::Bool(false));
        if let Some(owner) = &owner {
            object.insert("owner".into(), Value::String(owner.clone()));
        }
    }
    let _ = save_settings(&settings);
    let _ = std::fs::remove_file(&path);

    let error = if helper {
        start_helper_client(&app).err()
    } else {
        None
    };
    Bootstrap {
        paired: true,
        helper,
        owner,
        device_name: identity.name,
        gateway: identity.server,
        error,
    }
}

fn stop_assistant(app: &AppHandle) {
    let state = app.state::<AssistantState>();
    if let Ok(mut guard) = state.session.lock() {
        if let Some(mut session) = guard.take() {
            let _ = session.child.kill();
        }
    };
}

#[tauri::command]
async fn assistant_open(app: AppHandle, provider: Option<String>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("terminal") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    let provider = provider.unwrap_or_else(|| "private".into());
    let url = WebviewUrl::App(format!("index.html?terminal=1&provider={provider}").into());
    WebviewWindowBuilder::new(&app, "terminal", url)
        .title("OYM Assistant")
        .inner_size(980.0, 640.0)
        .min_inner_size(720.0, 440.0)
        .resizable(true)
        .decorations(false)
        .shadow(true)
        .center()
        .build()
        .map(|_| ())
        .map_err(|error| format!("open assistant window: {error}"))
}

#[tauri::command]
fn assistant_start(
    app: AppHandle,
    rows: u16,
    cols: u16,
    provider: Option<String>,
) -> Result<(), String> {
    let state = app.state::<AssistantState>();
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "assistant state poisoned".to_string())?;
    if guard.is_some() {
        return Ok(());
    }

    let cli = find_tool(
        "OYM_LINK_CLI",
        "remote-client/target/release/oym-link.exe",
        "oym-link.exe",
    )?;
    let pi = find_tool(
        "OYM_PI",
        "tmp/blackwell-link-package/pi/pi.exe",
        "pi/pi.exe",
    )?;

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(10),
            cols: cols.max(40),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("open pty: {error}"))?;

    let settings = load_settings();
    let cloud_base = settings
        .get("cloudBaseUrl")
        .and_then(Value::as_str)
        .unwrap_or("https://api.deepseek.com");
    let cloud_model = settings
        .get("cloudModel")
        .and_then(Value::as_str)
        .unwrap_or("deepseek-flash");

    let mut command = CommandBuilder::new(cli);
    command.arg("--local");
    command.arg("--quiet");
    if provider.as_deref() == Some("cloud") {
        command.arg("--prefer-cloud");
    }
    command.arg("--pi");
    command.arg(pi);
    command.arg("--data-dir");
    command.arg(default_data_dir());
    command.arg("--cloud-base-url");
    command.arg(cloud_base);
    command.arg("--cloud-model");
    command.arg(cloud_model);
    command.arg("--cloud-context-window");
    command.arg("1000000");
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("launch local assistant: {error}"))?;
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("pty reader: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("pty writer: {error}"))?;
    *guard = Some(AssistantSession {
        master: pair.master,
        writer,
        child,
    });
    drop(guard);

    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let _ = app_for_thread.emit("assistant-output", &buffer[..count]);
                }
                Err(_) => break,
            }
        }
        let _ = app_for_thread.emit("assistant-exit", ());
    });

    Ok(())
}

#[tauri::command]
fn assistant_input(app: AppHandle, data: String) -> Result<(), String> {
    let state = app.state::<AssistantState>();
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "assistant state poisoned".to_string())?;
    let Some(session) = guard.as_mut() else {
        return Err("assistant is not running".into());
    };
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|error| format!("write to assistant: {error}"))
}

#[tauri::command]
fn assistant_resize(app: AppHandle, rows: u16, cols: u16) -> Result<(), String> {
    let state = app.state::<AssistantState>();
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "assistant state poisoned".to_string())?;
    let Some(session) = guard.as_mut() else {
        return Ok(());
    };
    session
        .master
        .resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("resize assistant: {error}"))
}

#[tauri::command]
fn assistant_stop(app: AppHandle) {
    stop_assistant(&app);
}

#[tauri::command]
fn assistant_close(app: AppHandle) {
    stop_assistant(&app);
    if let Some(window) = app.get_webview_window("terminal") {
        let _ = window.close();
    }
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
    let mut status = status_snapshot().await;
    status.cloud_key_stored = cloud_key_present();
    Ok(status)
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

    let mut status = status_snapshot().await;
    status.cloud_key_stored = cloud_key_present();
    Ok(status)
}

#[tauri::command]
fn cloud_key_status() -> bool {
    cloud_key_present()
}

#[tauri::command]
fn cloud_key_set(key: String) -> Result<(), String> {
    save_cloud_key(&key)
}

#[tauri::command]
fn cloud_key_clear() -> Result<(), String> {
    clear_cloud_key()
}

#[tauri::command]
fn link_settings_get() -> Result<Value, String> {
    let mut settings = load_settings();
    if let Some(object) = settings.as_object_mut() {
        object.insert("cloudKeyStored".into(), Value::Bool(cloud_key_present()));
    }
    Ok(settings)
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

#[cfg(windows)]
fn place_bottom_right(window: &WebviewWindow) {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = hwnd.0 as *mut _;
    unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info: MONITORINFO = zeroed();
        info.cbSize = size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return;
        }
        let mut rect: RECT = zeroed();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return;
        }
        let mut width = rect.right - rect.left;
        let mut height = rect.bottom - rect.top;
        // A window that has never been shown can report a zero rect. Use the
        // Tauri outer size (the configured 380x560) instead of placing a
        // zero-sized window at the bottom-right corner.
        if width <= 0 || height <= 0 {
            if let Ok(size) = window.outer_size() {
                width = size.width as i32;
                height = size.height as i32;
            }
        }
        if width <= 0 || height <= 0 {
            return;
        }
        let margin = 0;
        let x = info.rcWork.right - width - margin;
        let y = info.rcWork.bottom - height - margin;
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            x,
            y,
            0,
            0,
            SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER,
        );
    }
}

#[cfg(not(windows))]
fn place_bottom_right(window: &WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let work = monitor.work_area();
    let margin = 0i32;
    let x = work.position.x + work.size.width as i32 - size.width as i32 - margin;
    let y = work.position.y + work.size.height as i32 - size.height as i32 - margin;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn show_flyout(app: &AppHandle) {
    let Some(window) = app.get_webview_window("flyout") else {
        return;
    };
    let _ = window.set_title("OYM Link");
    let _ = window.unminimize();
    // Show first: positioning a never-shown window can read a zero rect.
    let _ = window.show();
    place_bottom_right(&window);
    let _ = window.set_focus();

    // Tauri/Windows can apply their own initial placement after show. Repeat
    // once the window has settled so it cannot reopen centered.
    let delayed = window.clone();
    std::thread::spawn(move || {
        // Give Tauri/Windows time to apply their own initial placement, then
        // keep correcting the corner for a moment.
        for _ in 0..8 {
            std::thread::sleep(std::time::Duration::from_millis(150));
            place_bottom_right(&delayed);
        }
    });
}

fn toggle_flyout(app: &AppHandle) {
    let Some(window) = app.get_webview_window("flyout") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        let _ = window.set_title("OYM Link");
        let _ = window.unminimize();
        let _ = window.show();
        place_bottom_right(&window);
        let _ = window.set_focus();
        let delayed = window.clone();
        std::thread::spawn(move || {
            for _ in 0..8 {
                std::thread::sleep(std::time::Duration::from_millis(150));
                place_bottom_right(&delayed);
            }
        });
    }
}

fn main() {
    // The default EBWebView profile can inherit a broken ACL from an earlier
    // install and then WebView2 creation fails with 0x8007139F. Keep the
    // profile beside the link data instead; it is always under the user's
    // LOCALAPPDATA and can be cleared independently of the app binaries.
    #[cfg(windows)]
    if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none() {
        let dir = default_data_dir().join("WebView2");
        if std::fs::create_dir_all(&dir).is_ok() {
            if let Ok(path) = std::fs::canonicalize(&dir) {
                std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", path);
            }
        }
    }

    let builder = tauri::Builder::default()
        .manage(AssistantState::default())
        .manage(HelperState::default())
        .invoke_handler(tauri::generate_handler![
            link_status,
            link_pair,
            invite_bootstrap,
            link_settings_get,
            link_settings_set,
            cloud_key_status,
            cloud_key_set,
            cloud_key_clear,
            service_status,
            service_install,
            service_uninstall,
            helper_stopped,
            helper_link_status,
            helper_stop,
            helper_reconnect,
            helper_close,
            helper_forget,
            link_portable_start,
            link_hide,
            link_quit,
            assistant_open,
            assistant_start,
            assistant_input,
            assistant_resize,
            assistant_stop,
            assistant_close
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
            if window.label() == "terminal" {
                if let WindowEvent::CloseRequested { .. } = event {
                    stop_assistant(window.app_handle());
                }
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building OYM Link");
    builder.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            stop_helper(app);
            stop_assistant(app);
        }
    });
}
