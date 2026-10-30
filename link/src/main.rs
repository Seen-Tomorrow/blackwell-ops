//! Portable OYM device link and local assistant.
//!
//! The client owns only transport and process supervision:
//!   1. pair once and keep the device token in Windows Credential Manager
//!   2. connect outbound to the OYM gateway over WSS
//!   3. start Pi in a ConPTY when the operator opens a session
//!   4. expose a loopback OpenAI-compatible proxy that tunnels model calls
//!
//! `--local` is a second, opt-in launch path (Local Power Mode): Pi runs in the
//! console the user is sitting at, with `blackwell/*` routes fetched over a
//! routes-only WSS connection and/or a direct `cloud/*` OpenAI-compatible
//! endpoint. It never opens a remote session or PTY.
//!
//! It does not run a model, install a service, or open an inbound port.

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path as AxumPath, State};
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use oym_gateway::protocol::{ClientMessage, ModelRoute, ServerMessage, SessionOpen};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use rand::RngCore;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
use tokio_stream::wrappers::ReceiverStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

mod admin;
mod local;

use oym_link_core::identity::{load_identity, load_token, save_identity, Identity};

const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const PI_VERSION: &str = "1.4.0";

/// Local mode prints setup diagnostics on stdout before Pi starts. The tray app
/// asks for `--quiet` so only real errors reach the embedded terminal.
static QUIET: AtomicBool = AtomicBool::new(false);
/// Server baked into this portable trial build. The named-tunnel step replaces
/// this with the stable hostname; rebuild the client at that point.
const DEFAULT_SERVER: &str = "wss://favorite-fountain-begin-field.trycloudflare.com/link";

#[derive(Clone, Debug)]
struct Args {
    server: Option<String>,
    pair: Option<String>,
    name: String,
    pi: PathBuf,
    data_dir: PathBuf,
    cwd: PathBuf,
    /// True only when `--cwd` was supplied. Local Power Mode falls back to the
    /// console's working directory instead of the remote default of `C:\`.
    cwd_explicit: bool,
    /// Local Power Mode: local Pi in this console, no remote session/PTY.
    local: bool,
    /// Start with the cloud provider selected when both are available.
    prefer_cloud: bool,
    cloud_base_url: Option<String>,
    cloud_model: Option<String>,
    cloud_context_window: Option<usize>,
}

fn arg_value(args: &mut impl Iterator<Item = String>, flag: &str) -> Option<String> {
    let value = args.next();
    if value.is_none() {
        eprintln!("{flag} requires a value");
    }
    value
}

fn absolute_path(path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(&path))
            .unwrap_or(path)
    }
}

fn parse_args() -> Args {
    let mut args = std::env::args().skip(1);
    let mut server = None;
    let mut pair = None;
    let mut name = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "windows-device".into());
    let mut pi = None;
    let mut data_dir = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|path| path.join("OYM").join("Link"))
        .unwrap_or_else(|| PathBuf::from(".oym-link"));
    let mut cwd = PathBuf::from("C:\\");
    let mut cwd_explicit = false;
    let mut local = false;
    let mut prefer_cloud = false;
    let mut cloud_base_url = None;
    let mut cloud_model = None;
    let mut cloud_context_window = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--server" => server = arg_value(&mut args, "--server"),
            "--pair" => pair = arg_value(&mut args, "--pair"),
            "--name" => {
                if let Some(value) = arg_value(&mut args, "--name") {
                    name = value;
                }
            }
            "--pi" => pi = arg_value(&mut args, "--pi").map(PathBuf::from),
            "--data-dir" => {
                if let Some(value) = arg_value(&mut args, "--data-dir") {
                    data_dir = PathBuf::from(value);
                }
            }
            "--cwd" => {
                if let Some(value) = arg_value(&mut args, "--cwd") {
                    cwd = PathBuf::from(value);
                    cwd_explicit = true;
                }
            }
            "--local" => local = true,
            "--prefer-cloud" => prefer_cloud = true,
            "--quiet" | "-q" => QUIET.store(true, Ordering::Relaxed),
            "--cloud-base-url" => cloud_base_url = arg_value(&mut args, "--cloud-base-url"),
            "--cloud-model" => cloud_model = arg_value(&mut args, "--cloud-model"),
            "--cloud-context-window" => {
                let Some(value) = arg_value(&mut args, "--cloud-context-window") else {
                    std::process::exit(2);
                };
                match value.parse::<usize>() {
                    Ok(tokens) if tokens > 0 => cloud_context_window = Some(tokens),
                    _ => {
                        eprintln!("--cloud-context-window must be a positive token count");
                        std::process::exit(2);
                    }
                }
            }
            "--help" | "-h" => {
                println!(
                    "oym-link --server wss://host/link [--pair CODE] [--name NAME]\n\
                     oym-link --local [--cloud-base-url URL] [--cloud-model MODEL]\n\
                     \n\
                     --pi <path>       Pi package executable (default: <exe dir>/pi/pi.exe)\n\
                     --data-dir <dir>  identity + per-session Pi home\n\
                     --cwd <dir>       working directory for the maintenance session\n\
                     --quiet           suppress local-mode setup diagnostics\n\
                     --prefer-cloud    start on the cloud provider when configured\n\
                     \n\
                     Local Power Mode:\n\
                     --local                    run Pi in this console with blackwell/* and cloud/*\n\
                                                (owner / local administrator account only)\n\
                     --cloud-base-url <url>     override <data-dir>/cloud.json baseUrl\n\
                     --cloud-model <model>      override the cloud model id\n\
                     --cloud-context-window <n> override the cloud context window\n\
                     \n\
                     The device token is stored in Windows Credential Manager, not on disk.\n\
                     API keys are never accepted on the command line."
                );
                std::process::exit(0);
            }
            other => {
                eprintln!("unknown argument: {other}");
                std::process::exit(2);
            }
        }
    }

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let pi = pi.unwrap_or_else(|| exe_dir.join("pi").join("pi.exe"));

    Args {
        server,
        pair,
        name,
        pi: absolute_path(pi),
        data_dir: absolute_path(data_dir),
        cwd: absolute_path(cwd),
        cwd_explicit,
        local,
        prefer_cloud,
        cloud_base_url,
        cloud_model,
        cloud_context_window,
    }
}

async fn pair_device(server: &str, code: &str, name: &str) -> Result<(Identity, String), String> {
    let integrity = if is_elevated() { "High" } else { "Medium" };
    oym_link_core::pairing::pair_device(
        server,
        code,
        name,
        CLIENT_VERSION,
        PI_VERSION,
        integrity,
    )
    .await
}

fn prompt_pairing_code() -> Result<String, String> {
    println!();
    println!("No paired identity for this Windows user.");
    println!("In OYM → REMOTE → STATUS, click PAIR DEVICE.");
    print!("Pairing code (blank to cancel): ");
    std::io::stdout()
        .flush()
        .map_err(|e| format!("console: {e}"))?;
    let mut line = String::new();
    let read = std::io::stdin()
        .read_line(&mut line)
        .map_err(|e| format!("read pairing code: {e}"))?;
    if read == 0 {
        return Err("no pairing code supplied".into());
    }
    let code = line.trim().to_ascii_uppercase();
    if code.is_empty() {
        return Err("pairing cancelled".into());
    }
    Ok(code)
}

#[cfg(windows)]
fn conpty_available() -> bool {
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};

    let kernel: Vec<u16> = "kernel32.dll\0".encode_utf16().collect();
    let symbol = b"CreatePseudoConsole\0";
    unsafe {
        let module = GetModuleHandleW(kernel.as_ptr());
        if module.is_null() {
            return false;
        }
        GetProcAddress(module, symbol.as_ptr()).is_some()
    }
}

#[cfg(not(windows))]
fn conpty_available() -> bool {
    false
}

#[cfg(windows)]
fn is_elevated() -> bool {
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut returned = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            &mut elevation as *mut _ as *mut _,
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        );
        CloseHandle(token);
        ok != 0 && elevation.TokenIsElevated != 0
    }
}

#[cfg(not(windows))]
fn is_elevated() -> bool {
    false
}

struct ModelHeadInfo {
    status: u16,
    content_type: String,
}

struct ProxyShared {
    outbound: mpsc::UnboundedSender<ClientMessage>,
    token: String,
    routes: RwLock<HashMap<String, ModelRoute>>,
    /// Provider-visible model id → route id, for the model-routed `/v1` surface
    /// local Power Mode uses. Remote sessions never populate it; they address
    /// routes by id.
    models: RwLock<HashMap<String, String>>,
    /// Cloud upstream for the loopback cloud proxy. The real API key stays here
    /// (process memory) and never enters Pi's models.json.
    cloud: RwLock<Option<CloudUpstream>>,
    heads: Mutex<HashMap<String, oneshot::Sender<ModelHeadInfo>>>,
    chunks: Mutex<HashMap<String, mpsc::Sender<Result<Bytes, std::convert::Infallible>>>>,
}

#[derive(Clone)]
pub(crate) struct CloudUpstream {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

impl ProxyShared {
    fn new(outbound: mpsc::UnboundedSender<ClientMessage>, token: String) -> Self {
        Self {
            outbound,
            token,
            routes: RwLock::new(HashMap::new()),
            models: RwLock::new(HashMap::new()),
            cloud: RwLock::new(None),
            heads: Mutex::new(HashMap::new()),
            chunks: Mutex::new(HashMap::new()),
        }
    }

    async fn set_cloud(&self, cloud: CloudUpstream) {
        *self.cloud.write().await = Some(cloud);
    }

    /// Every proxy surface is loopback-only and additionally guarded by a random
    /// per-process bearer token. Nothing else is accepted.
    fn authorized(&self, headers: &HeaderMap) -> bool {
        bearer(headers) == Some(self.token.as_str())
    }
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
}

async fn models(
    State(shared): State<Arc<ProxyShared>>,
    AxumPath(route_id): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    if !shared.authorized(&headers) {
        return (StatusCode::UNAUTHORIZED, "invalid local proxy token").into_response();
    }
    let Some(route) = shared.routes.read().await.get(&route_id).cloned() else {
        return (StatusCode::NOT_FOUND, "unknown route").into_response();
    };
    Json(json!({
        "object": "list",
        "data": [{
            "id": route.model,
            "object": "model",
            "owned_by": "blackwell-ops"
        }]
    }))
    .into_response()
}

/// Model catalog for the model-routed surface used by local Power Mode.
async fn models_all(State(shared): State<Arc<ProxyShared>>, headers: HeaderMap) -> Response {
    if !shared.authorized(&headers) {
        return (StatusCode::UNAUTHORIZED, "invalid local proxy token").into_response();
    }
    let ids: Vec<String> = shared.models.read().await.keys().cloned().collect();
    let data: Vec<Value> = ids
        .into_iter()
        .map(|id| {
            json!({
                "id": id,
                "object": "model",
                "owned_by": "blackwell-ops"
            })
        })
        .collect();
    Json(json!({ "object": "list", "data": data })).into_response()
}

async fn cloud_models(State(shared): State<Arc<ProxyShared>>, headers: HeaderMap) -> Response {
    if !shared.authorized(&headers) {
        return (StatusCode::UNAUTHORIZED, "invalid local proxy token").into_response();
    }
    let cloud = shared.cloud.read().await.clone();
    let Some(cloud) = cloud else {
        return (StatusCode::SERVICE_UNAVAILABLE, "cloud is not configured").into_response();
    };
    Json(json!({
        "object": "list",
        "data": [{
            "id": cloud.model,
            "object": "model",
            "owned_by": "oym"
        }]
    }))
    .into_response()
}

/// Forward a cloud chat request with the real key injected here. Pi only ever
/// sees the loopback URL and the per-process proxy token.
async fn cloud_chat(
    State(shared): State<Arc<ProxyShared>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !shared.authorized(&headers) {
        return (StatusCode::UNAUTHORIZED, "invalid local proxy token").into_response();
    }
    let cloud = shared.cloud.read().await.clone();
    let Some(cloud) = cloud else {
        return (StatusCode::SERVICE_UNAVAILABLE, "cloud is not configured").into_response();
    };
    let url = format!("{}/chat/completions", cloud.base_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .post(url)
        .bearer_auth(&cloud.api_key)
        .json(&body)
        .send()
        .await;
    match response {
        Ok(response) => {
            let status = StatusCode::from_u16(response.status().as_u16())
                .unwrap_or(StatusCode::BAD_GATEWAY);
            let content_type = response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("application/json")
                .to_string();
            Response::builder()
                .status(status)
                .header(CONTENT_TYPE, content_type)
                .body(Body::from_stream(response.bytes_stream()))
                .unwrap_or_else(|_| {
                    (StatusCode::BAD_GATEWAY, "invalid cloud response").into_response()
                })
        }
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            format!("cloud request failed: {error}"),
        )
            .into_response(),
    }
}

async fn chat(
    State(shared): State<Arc<ProxyShared>>,
    AxumPath(route_id): AxumPath<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !shared.authorized(&headers) {
        return (StatusCode::UNAUTHORIZED, "invalid local proxy token").into_response();
    }
    let Some(route) = shared.routes.read().await.get(&route_id).cloned() else {
        return (StatusCode::NOT_FOUND, "unknown route").into_response();
    };
    chat_route(shared, route, body).await
}

/// `/v1/chat/completions` for local Power Mode: the single `blackwell` provider
/// has one baseUrl, so Pi's model name selects the route. Only route models
/// written into this launch's `models.json` resolve; anything else is a 404.
async fn chat_by_model(
    State(shared): State<Arc<ProxyShared>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !shared.authorized(&headers) {
        return (StatusCode::UNAUTHORIZED, "invalid local proxy token").into_response();
    }
    let Some(model) = body.get("model").and_then(Value::as_str) else {
        return (StatusCode::BAD_REQUEST, "model is required").into_response();
    };
    let route_id = shared.models.read().await.get(model).cloned();
    let Some(route_id) = route_id else {
        return (StatusCode::NOT_FOUND, format!("unknown model '{model}'")).into_response();
    };
    let route = shared.routes.read().await.get(&route_id).cloned();
    let Some(route) = route else {
        return (StatusCode::NOT_FOUND, format!("unknown model '{model}'")).into_response();
    };
    chat_route(shared, route, body).await
}

async fn chat_route(shared: Arc<ProxyShared>, route: ModelRoute, mut body: Value) -> Response {
    if body.get("model").is_none() {
        if let Some(object) = body.as_object_mut() {
            object.insert("model".into(), Value::String(route.model.clone()));
        }
    }

    let mut id_bytes = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut id_bytes);
    let request_id = hex::encode(id_bytes);
    let (head_tx, head_rx) = oneshot::channel::<ModelHeadInfo>();
    let (chunk_tx, chunk_rx) =
        mpsc::channel::<Result<Bytes, std::convert::Infallible>>(64);
    shared.heads.lock().await.insert(request_id.clone(), head_tx);
    shared
        .chunks
        .lock()
        .await
        .insert(request_id.clone(), chunk_tx);
    if shared
        .outbound
        .send(ClientMessage::ModelRequest {
            id: request_id.clone(),
            route_id: route.id.clone(),
            body,
        })
        .is_err()
    {
        shared.heads.lock().await.remove(&request_id);
        shared.chunks.lock().await.remove(&request_id);
        return (StatusCode::BAD_GATEWAY, "gateway link is closed").into_response();
    }

    let head = match tokio::time::timeout(Duration::from_secs(120), head_rx).await {
        Ok(Ok(head)) => head,
        _ => {
            shared.heads.lock().await.remove(&request_id);
            shared.chunks.lock().await.remove(&request_id);
            let _ = shared.outbound.send(ClientMessage::ModelCancel {
                id: request_id,
            });
            return (StatusCode::GATEWAY_TIMEOUT, "model response timed out").into_response();
        }
    };

    let status = StatusCode::from_u16(head.status).unwrap_or(StatusCode::BAD_GATEWAY);
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, head.content_type)
        .body(Body::from_stream(ReceiverStream::new(chunk_rx)))
        .unwrap_or_else(|_| (StatusCode::BAD_GATEWAY, "invalid upstream response").into_response())
}

/// Start the loopback proxy. `model_routed` adds the `/v1` surface local Power
/// Mode needs; remote sessions keep only the per-route paths they have always
/// used.
async fn start_proxy(shared: Arc<ProxyShared>, model_routed: bool) -> Result<u16, String> {
    let mut app = Router::new()
        .route("/r/{route_id}/v1/chat/completions", post(chat))
        .route("/r/{route_id}/v1/models", get(models));
    if model_routed {
        app = app
            .route("/v1/chat/completions", post(chat_by_model))
            .route("/v1/models", get(models_all))
            .route("/v1/cloud/chat/completions", post(cloud_chat))
            .route("/v1/cloud/models", get(cloud_models));
    }
    let app = app
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        .with_state(shared);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind local proxy: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(port)
}

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    pid: Option<u32>,
}

impl PtySession {
    fn write(&mut self, data: &[u8]) {
        let _ = self.writer.write_all(data);
        let _ = self.writer.flush();
    }

    fn resize(&mut self, cols: u16, rows: u16) {
        // A hidden/unlaid-out xterm can report 0x0 during the first effect;
        // resizing ConPTY to zero can make the child exit before its TUI paints.
        if cols < 20 || rows < 5 {
            return;
        }
        let _ = self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }

    fn kill(&mut self) {
        #[cfg(windows)]
        if let Some(pid) = self.pid {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .creation_flags(0x0800_0000)
                .status();
        }
        #[cfg(not(windows))]
        if let Some(pid) = self.pid {
            let _ = std::process::Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .status();
        }
        self.pid = None;
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        self.kill();
    }
}

fn encode_b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn decode_b64(data: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(data).ok()
}

fn write_pi_files(
    home: &Path,
    proxy_port: u16,
    proxy_token: &str,
    routes: &[ModelRoute],
) -> Result<String, String> {
    std::fs::create_dir_all(home).map_err(|e| format!("create pi home: {e}"))?;
    let first = routes
        .first()
        .ok_or_else(|| "session has no model routes".to_string())?;
    let mut providers = serde_json::Map::new();
    let mut first_provider = String::new();
    for (index, route) in routes.iter().enumerate() {
        // OYM's own pi catalog uses the provider name `local`. Pi's
        // interactive model lookup has been reliable with that name; the wire
        // route id stays opaque and is only used in the local proxy path.
        let provider_id = if index == 0 {
            "local".to_string()
        } else {
            format!("route{}", index + 1)
        };
        if index == 0 {
            first_provider = provider_id.clone();
        }
        let input = if route.vision {
            json!(["text", "image"])
        } else {
            json!(["text"])
        };
        providers.insert(
            provider_id,
            json!({
                "api": "openai-completions",
                "baseUrl": format!("http://127.0.0.1:{proxy_port}/r/{}/v1", route.id),
                "apiKey": proxy_token,
                "compat": {
                    "supportsDeveloperRole": false,
                    "supportsReasoningEffort": true,
                    "supportsUsageInStreaming": false
                },
                "models": [{
                    "id": route.model,
                    "name": route.label,
                    "contextWindow": route.context_window,
                    "input": input,
                    "reasoning": true,
                    "thinkingLevelMap": {
                        "off": "none",
                        "low": "low",
                        "medium": "medium",
                        "high": "high",
                        "xhigh": "xhigh"
                    }
                }]
            }),
        );
    }
    let models = json!({
        "providers": providers,
        "defaultProvider": first_provider,
        "defaultModel": first.model
    });
    let settings = json!({
        "defaultProvider": first_provider,
        "defaultModel": first.model,
        "enableInstallTelemetry": false,
        "enableAnalytics": false,
        "quietStartup": true
    });
    std::fs::write(
        home.join("models.json"),
        serde_json::to_string_pretty(&models).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("write models.json: {e}"))?;
    std::fs::write(
        home.join("settings.json"),
        serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("write settings.json: {e}"))?;

    // Pi reads APPEND_SYSTEM.md from the agent directory even with
    // --no-context-files. Keep the remote agent out of GUI tools: a GUI window
    // has no operator to close it, and the tool call blocks until the process
    // exits.
    let guidance = r#"# Headless remote maintenance — Windows

This is a remote, headless Windows maintenance session. The operator watches the
terminal through OYM; there is no one at the remote console to close a
window.

## Hard rules

- Never launch an interactive or GUI program. It will block the tool call and
  stall the entire audit.
- Never use `Start-Process` to launch a GUI application. Do not invoke
  `msinfo32`, `eventvwr`, `services.msc`, `compmgmt.msc`, `diskmgmt.msc`,
  `devmgmt.msc`, `taskmgr`, `perfmon`, `resmon`, `regedit`, `mmc`, `wf.msc`,
  `lusrmgr.msc`, `gpedit.msc`, `secpol.msc`, `control`, `ncpa.cpl`,
  `appwiz.cpl`, `winver`, `dxdiag`, `explorer`, `notepad`, or any `.msc`/`.cpl`
  control panel.
- Never use `Read-Host`, `Pause`, `choice`, `more`, `cmd /k`, interactive
  `ssh`/`ftp`/`telnet`, or anything else that waits for keyboard input.
- Every command must be non-interactive and must terminate on its own.
- If a check has no non-GUI equivalent, say so and suggest the operator run it
  manually. Do not open the GUI "just to look".

## Preferred system-audit commands

Use CIM/cmdlets instead of GUI tools:

- OS / BIOS: `Get-CimInstance Win32_OperatingSystem`,
  `Get-CimInstance Win32_ComputerSystem`, `Get-CimInstance Win32_BIOS`
- CPU / RAM: `Get-CimInstance Win32_Processor`,
  `Get-CimInstance Win32_PhysicalMemory`
- Disks / volumes: `Get-CimInstance Win32_LogicalDisk`, `Get-Volume`
- Services / drivers: `Get-Service`, `Get-CimInstance Win32_SystemDriver`
- Updates: `Get-HotFix`
- Events: `Get-WinEvent -MaxEvents 50`
- Network: `Get-NetAdapter`, `Get-NetIPConfiguration`,
  `Get-NetTCPConnection` (or `netstat -ano` if the NetTCPIP module is absent)
- Users / groups: `Get-LocalUser`, `Get-LocalGroupMember Administrators`
- Installed software: registry `Uninstall` keys or
  `Get-CimInstance Win32_Product` only as a last resort (it is slow)

If a command is expected to take longer than a minute, say so before running it.
"#;
    std::fs::write(home.join("APPEND_SYSTEM.md"), guidance)
        .map_err(|e| format!("write APPEND_SYSTEM.md: {e}"))?;
    Ok(first_provider)
}

fn write_pi_launch_bat(
    home: &Path,
    pi: &Path,
    cwd: &Path,
    session_dir: &Path,
    provider_id: &str,
    model: &str,
    name: &str,
) -> Result<PathBuf, String> {
    let strip = |value: &str| value.replace('"', "");
    let home_s = strip(&home.to_string_lossy());
    let pi_s = strip(&pi.to_string_lossy());
    let cwd_s = strip(&cwd.to_string_lossy());
    let session_s = strip(&session_dir.to_string_lossy());
    let name_s = strip(name);
    let body = format!(
        "@echo off\r\n\
         setlocal\r\n\
         set \"PI_CODING_AGENT_DIR={home_s}\"\r\n\
         set \"PI_SUBAGENT_PI_BINARY={pi_s}\"\r\n\
         cd /d \"{cwd_s}\"\r\n\
         \"{pi_s}\" --model \"{provider_id}/{model}\" --tools read,powershell,edit,write \
         --no-extensions --no-mcp --no-skills --no-context-files --no-prompt-templates \
         --no-approve --session-dir \"{session_s}\" --thinking medium --tui-mode regular \
         --name \"remote-{name_s}\"\r\n\
         exit /b %ERRORLEVEL%\r\n"
    );
    let bat = home.join("launch-session.cmd");
    std::fs::write(&bat, body).map_err(|e| format!("write launch-session.cmd: {e}"))?;
    Ok(bat)
}

async fn start_pi_session(
    shared: Arc<ProxyShared>,
    args: &Args,
    session: &SessionOpen,
) -> Result<PtySession, String> {
    if !args.pi.is_file() {
        return Err(format!("pi executable not found: {}", args.pi.display()));
    }
    let route_map = session
        .routes
        .iter()
        .map(|route| (route.id.clone(), route.clone()))
        .collect::<HashMap<_, _>>();
    *shared.routes.write().await = route_map;
    let proxy_port = start_proxy(shared.clone(), false).await?;

    let stamp = oym_gateway::devices::unix_now();
    let home = args
        .data_dir
        .join("sessions")
        .join(format!("{stamp}-{}", std::process::id()));
    let provider_id = write_pi_files(&home, proxy_port, &shared.token, &session.routes)?;

    let first = session
        .routes
        .first()
        .ok_or_else(|| "session has no model routes".to_string())?;
    if !conpty_available() {
        return Err(
            "this Windows build has no ConPTY; OYM Link needs Windows 10 1809+ / \
             Server 2019+. Pi also imports ClosePseudoConsole, so Server 2012 R2 / Windows 8.1 \
             cannot run the harness."
                .into(),
        );
    }
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: session.rows.max(8),
            cols: session.cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("open ConPTY: {e}"))?;

    // Launch through a batch wrapper, like OYM's own pi launcher. This
    // guarantees PI_CODING_AGENT_DIR is present in the shell process that
    // spawns pi; Pi's interactive model loader has been observed to miss a
    // custom catalog when the variable is only attached to the direct child.
    // Persistent Pi session store shared across maintenance sessions. This is
    // separate from the per-session agent home because models.json changes on
    // every launch; sessions themselves must survive termination/reconnect.
    let session_dir = args.data_dir.join("pi-sessions");
    std::fs::create_dir_all(&session_dir)
        .map_err(|e| format!("create pi session dir: {e}"))?;
    let launch_bat = write_pi_launch_bat(
        &home,
        &args.pi,
        &args.cwd,
        &session_dir,
        &provider_id,
        &first.model,
        &args.name,
    )?;
    std::env::set_var("PI_CODING_AGENT_DIR", home.as_os_str());
    let mut command = CommandBuilder::new("cmd.exe");
    command.args([
        "/d",
        "/c",
        "call",
        &launch_bat.to_string_lossy().to_string(),
    ]);
    command.env("PI_CODING_AGENT_DIR", home.to_string_lossy().to_string());
    command.cwd(&args.cwd);
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| format!("spawn pi launcher: {e}"))?;
    drop(pair.slave);
    let pid = child.process_id();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("pty reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("pty writer: {e}"))?;

    let outbound = shared.outbound.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    if outbound
                        .send(ClientMessage::PtyData {
                            data: encode_b64(&buffer[..n]),
                        })
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = outbound.send(ClientMessage::SessionExit { code: None });
    });

    Ok(PtySession {
        writer,
        master: pair.master,
        pid,
    })
}

async fn prompt_and_pair(server: &str, args: &Args) -> Result<(Identity, String), String> {
    loop {
        let code = prompt_pairing_code()?;
        match pair_device(server, &code, &args.name).await {
            Ok((identity, token)) => {
                save_identity(&args.data_dir, &identity)?;
                println!("Paired device {} to {}", identity.device_id, identity.server);
                return Ok((identity, token));
            }
            Err(error) => {
                eprintln!("Pairing failed: {error}");
                println!("Generate a fresh code in OYM and try again.");
            }
        }
    }
}

async fn run(args: Args) -> Result<(), String> {
    let existing = load_identity(&args.data_dir);
    let server = args
        .server
        .clone()
        .or_else(|| existing.as_ref().map(|identity| identity.server.clone()))
        .unwrap_or_else(|| DEFAULT_SERVER.to_string());
    say(&format!("Server: {server}"));
    say("Looking up paired identity...");

    let (identity, token) = if let Some(code) = args.pair.as_deref() {
        let (identity, token) = pair_device(&server, code, &args.name).await?;
        save_identity(&args.data_dir, &identity)?;
        println!("paired device {} to {}", identity.device_id, identity.server);
        (identity, token)
    } else if let Some(identity) = existing {
        match load_token(&identity) {
            Ok(token) => (identity, token),
            Err(_) => {
                // Identity exists but Credential Manager lost the token
                // (different Windows user, cleaned credentials, replaced
                // profile). Fall back to a fresh pairing.
                println!("Stored device token is unavailable; pairing again.");
                let (identity, token) = prompt_and_pair(&server, &args).await?;
                (identity, token)
            }
        }
    } else {
        let (identity, token) = prompt_and_pair(&server, &args).await?;
        (identity, token)
    };
    say(&format!(
        "Device: {} ({})",
        identity.name, identity.device_id
    ));
    say(&format!("Connecting to {server}..."));

    let mut request = oym_link_core::status::link_url(&server)
        .map_err(|e| format!("server URL: {e}"))?
        .as_str()
        .into_client_request()
        .map_err(|e| format!("websocket request: {e}"))?;
    request.headers_mut().insert(
        AUTHORIZATION,
        format!("Bearer {token}")
            .parse()
            .map_err(|e| format!("authorization header: {e}"))?,
    );
    let (socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| format!("connect {server}: {e}"))?;
    say(&format!("Connected as {}", identity.name));
    let (mut socket_tx, mut socket_rx) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<ClientMessage>();
    tokio::spawn(async move {
        while let Some(message) = out_rx.recv().await {
            let Ok(text) = serde_json::to_string(&message) else {
                break;
            };
            if socket_tx.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    // Cloudflare and NAT edges close idle WebSockets. A small application-level
    // ping every 15 s keeps the public path warm and gives the gateway a chance
    // to answer Pong.
    {
        let heartbeat_tx = out_tx.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(15));
            loop {
                ticker.tick().await;
                if heartbeat_tx.send(ClientMessage::Ping).is_err() {
                    break;
                }
            }
        });
    }

    let mut token_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut token_bytes);
    let shared = Arc::new(ProxyShared::new(
        out_tx.clone(),
        hex::encode(token_bytes),
    ));

    let _ = out_tx.send(ClientMessage::Hello {
        device_name: Some(args.name.clone()),
        os: Some("Windows".into()),
        user: std::env::var("USERNAME").ok(),
        integrity: Some(if is_elevated() { "High" } else { "Medium" }.into()),
        client_version: Some(CLIENT_VERSION.into()),
        pi_version: Some(PI_VERSION.into()),
    });

    let mut pty: Option<PtySession> = None;
    while let Some(message) = socket_rx.next().await {
        let message = match message {
            Ok(Message::Text(text)) => text.to_string(),
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => continue,
            Ok(Message::Close(frame)) => {
                println!("gateway closed the connection: {frame:?}");
                break;
            }
            Err(error) => {
                eprintln!("gateway socket error: {error}");
                break;
            }
            Ok(Message::Binary(_)) => continue,
            Ok(Message::Frame(_)) => continue,
        };
        let message: ServerMessage = match serde_json::from_str(&message) {
            Ok(message) => message,
            Err(error) => {
                eprintln!("invalid gateway frame: {error}");
                continue;
            }
        };
        match message {
            ServerMessage::Ready {
                protocol_version,
                server_version,
                public_url,
                session,
            } => {
                println!(
                    "gateway ready · protocol {protocol_version} · server {server_version} · {}",
                    public_url.as_deref().unwrap_or("no public URL")
                );
                if let Some(session) = session {
                    match start_pi_session(shared.clone(), &args, &session).await {
                        Ok(next) => {
                            let pid = next.pid;
                            pty = Some(next);
                            println!("session ready · pi pid {:?}", pid);
                            let _ = shared.outbound.send(ClientMessage::SessionReady {
                                pid,
                                pi_version: Some(PI_VERSION.into()),
                                integrity: Some(
                                    if is_elevated() { "High" } else { "Medium" }.into(),
                                ),
                            });
                        }
                        Err(error) => {
                            eprintln!("session start: {error}");
                            let _ = shared.outbound.send(ClientMessage::SessionExit { code: None });
                        }
                    }
                }
            }
            ServerMessage::SessionOpen(session) => {
                if let Some(mut current) = pty.take() {
                    current.kill();
                }
                match start_pi_session(shared.clone(), &args, &session).await {
                    Ok(next) => {
                        let pid = next.pid;
                        pty = Some(next);
                        println!("session ready · pi pid {:?}", pid);
                        let _ = shared.outbound.send(ClientMessage::SessionReady {
                            pid,
                            pi_version: Some(PI_VERSION.into()),
                            integrity: Some(
                                if is_elevated() { "High" } else { "Medium" }.into(),
                            ),
                        });
                    }
                    Err(error) => {
                        eprintln!("session start: {error}");
                        let _ = shared.outbound.send(ClientMessage::SessionExit { code: None });
                    }
                }
            }
            ServerMessage::SessionStop { reason } => {
                println!("session stop: {reason}");
                if let Some(mut current) = pty.take() {
                    current.kill();
                }
                // Acknowledge the stop so the gateway does not leave the
                // session in RUNNING after the Pi process is gone.
                let _ = shared.outbound.send(ClientMessage::SessionExit { code: None });
            }
            ServerMessage::PtyInput { data } => {
                if let Some(current) = pty.as_mut() {
                    if let Some(bytes) = decode_b64(&data) {
                        current.write(&bytes);
                    }
                }
            }
            ServerMessage::PtyResize { cols, rows } => {
                if let Some(current) = pty.as_mut() {
                    current.resize(cols, rows);
                }
            }
            ServerMessage::ModelHead {
                id,
                status,
                content_type,
            } => {
                if let Some(head) = shared.heads.lock().await.remove(&id) {
                    let _ = head.send(ModelHeadInfo {
                        status,
                        content_type: content_type.unwrap_or_else(|| "text/event-stream".into()),
                    });
                }
            }
            ServerMessage::ModelChunk { id, data } => {
                if let Some(bytes) = decode_b64(&data) {
                    let sender = shared.chunks.lock().await.get(&id).cloned();
                    if let Some(sender) = sender {
                        let _ = sender.send(Ok(Bytes::from(bytes))).await;
                    }
                }
            }
            ServerMessage::ModelEnd { id, error } => {
                if let Some(head) = shared.heads.lock().await.remove(&id) {
                    let _ = head.send(ModelHeadInfo {
                        status: 502,
                        content_type: "application/json".into(),
                    });
                }
                shared.chunks.lock().await.remove(&id);
                if let Some(error) = error {
                    eprintln!("model error [{id}]: {error}");
                }
            }
            ServerMessage::Pong => {}
            // Remote sessions never request routes: they receive them inside
            // SessionOpen. Local Power Mode handles Routes on its own socket.
            ServerMessage::Routes { .. } => {}
            ServerMessage::Error { message } => eprintln!("gateway error: {message}"),
        }
    }

    println!("gateway reader ended");
    if let Some(mut current) = pty.take() {
        current.kill();
    }
    Ok(())
}

fn say(line: &str) {
    if QUIET.load(Ordering::Relaxed) {
        return;
    }
    println!("{line}");
    let _ = std::io::stdout().flush();
}

fn pause_for_exit() {
    print!("\nPress Enter to exit...");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    let _ = std::io::stdin().read_line(&mut line);
}

fn main() {
    let args = parse_args();
    // Print before the Tokio runtime is built. On a fresh unsigned exe,
    // Defender/loader work can still delay the first instruction; this is the
    // earliest output the program itself can produce. The tray app asks for
    // quiet mode so the embedded terminal opens directly in Pi.
    if !QUIET.load(Ordering::Relaxed) {
        println!("OYM Link {CLIENT_VERSION} — starting");
        let _ = std::io::stdout().flush();
    }

    let local_mode = args.local;
    let interactive = std::env::args().len() == 1;

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("oym-link: runtime: {error}");
            std::process::exit(1);
        }
    };

    // Local Power Mode owns Pi directly in this console; its exit code is Pi's.
    // It is never the "double-clicked, pause before close" path.
    if local_mode {
        let code = match runtime.block_on(local::run(args)) {
            Ok(code) => code,
            Err(error) => {
                eprintln!("oym-link --local: {error}");
                1
            }
        };
        let _ = std::io::stdout().flush();
        std::process::exit(code);
    }

    // Double-clicking the exe passes no arguments. Keep the console visible on
    // failure/disconnect so the operator can read the message instead of the
    // window vanishing immediately.
    if let Err(error) = runtime.block_on(run(args)) {
        eprintln!("oym-link: {error}");
        if interactive {
            pause_for_exit();
        }
        std::process::exit(1);
    }
    if interactive {
        println!("Disconnected.");
        pause_for_exit();
    }
}
