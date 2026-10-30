//! Local Power Mode: `oym-link --local`.
//!
//! Pi runs in the console the user is sitting at, with two model providers:
//!
//! * `blackwell/<engine>` — model calls travel over a **routes-only** WSS
//!   connection to the OYM gateway, which proxies them to the running
//!   engine. The loopback proxy only accepts its random bearer token and the
//!   route models assigned to this launch.
//! * `cloud/<model>` — Pi calls an OpenAI-compatible endpoint directly with a
//!   key from `<data-dir>/cloud.json` or Windows Credential Manager.
//!
//! There is no remote `SessionOpen`, no PTY, and no forensic session log: the
//! local user owns this Pi process. Pi uses direct `std::process::Command` with
//! inherited stdio, not ConPTY, because the console is already real.

use super::{
    decode_b64, load_identity, load_token, say, start_proxy, Args, Identity, ModelHeadInfo,
    ProxyShared, CLIENT_VERSION, PI_VERSION,
};
use axum::body::Bytes;
use axum::http::header::AUTHORIZATION;
use oym_gateway::protocol::{ClientMessage, ModelRoute, ServerMessage};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

/// Keyring coordinates for the optional cloud API key. The device token uses a
/// different service (`OYMLink`) so the two can be revoked separately.
const CLOUD_SERVICE: &str = "OYMLink";
const CLOUD_KEY_ENTRY: &str = "cloud-api-key";
const CLOUD_DEFAULT_CONTEXT_WINDOW: usize = 131_072;
const HOME_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HOME_ROUTES_TIMEOUT: Duration = Duration::from_secs(10);
const HEARTBEAT_SECONDS: u64 = 15;

// ─────────────────────────── cloud provider ───────────────────────────

/// `<data-dir>/cloud.json`. Every field is optional so a partial file can fall
/// back to the CLI overrides and Credential Manager; the resolved provider is
/// only used when all required pieces are present.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct CloudFile {
    base_url: Option<String>,
    model: Option<String>,
    context_window: Option<usize>,
    vision: Option<bool>,
    /// Present only when the owner chose to keep the key in the file. The
    /// preferred storage is Windows Credential Manager.
    api_key: Option<String>,
}

#[derive(Clone, Debug, Default)]
struct CloudOverrides {
    base_url: Option<String>,
    model: Option<String>,
    context_window: Option<usize>,
}

#[derive(Clone)]
struct CloudProvider {
    base_url: String,
    model: String,
    context_window: usize,
    vision: bool,
    api_key: String,
}

impl CloudProvider {
    /// Non-secret description safe for the console and logs.
    fn summary(&self) -> String {
        format!(
            "{} · model {} · {} ctx{}",
            self.base_url,
            self.model,
            self.context_window,
            if self.vision { " · vision" } else { "" }
        )
    }
}

enum CloudOutcome {
    Ready(CloudProvider),
    /// Not configured (or partially configured). Local mode can still run on
    /// home Blackwell routes; this string is only surfaced when it cannot.
    Missing(String),
}

fn resolve_cloud(
    file: Option<CloudFile>,
    overrides: &CloudOverrides,
    keyring_key: Option<String>,
) -> Result<CloudOutcome, String> {
    let file = file.unwrap_or_default();
    let base_url = overrides
        .base_url
        .clone()
        .or(file.base_url)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let model = overrides
        .model
        .clone()
        .or(file.model)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let api_key = file
        .api_key
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            keyring_key
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        });

    let mut missing = Vec::new();
    if base_url.is_none() {
        missing.push("baseUrl");
    }
    if model.is_none() {
        missing.push("model");
    }
    if api_key.is_none() {
        missing.push("apiKey (cloud.json or Windows Credential Manager OYMLink/cloud-api-key)");
    }
    if !missing.is_empty() {
        return Ok(CloudOutcome::Missing(format!(
            "cloud provider is not configured (missing {})",
            missing.join(", ")
        )));
    }

    let (base_url, model, api_key) = match (base_url, model, api_key) {
        (Some(base_url), Some(model), Some(api_key)) => (base_url, model, api_key),
        _ => return Ok(CloudOutcome::Missing("cloud provider is not configured".into())),
    };
    let base_url = normalize_base_url(&base_url)?;
    let context_window = overrides
        .context_window
        .or(file.context_window)
        .filter(|tokens| *tokens > 0)
        .unwrap_or(CLOUD_DEFAULT_CONTEXT_WINDOW);

    Ok(CloudOutcome::Ready(CloudProvider {
        base_url,
        model,
        context_window,
        vision: file.vision.unwrap_or(false),
        api_key,
    }))
}

/// `https` anywhere; plain `http` only for a loopback test endpoint. A cloud key
/// must never travel in the clear to a remote host.
fn normalize_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let url = Url::parse(trimmed).map_err(|error| format!("cloud baseUrl is not a valid URL: {error}"))?;
    match url.scheme() {
        "https" => {}
        "http" => {
            let host = url
                .host_str()
                .unwrap_or_default()
                .trim_start_matches('[')
                .trim_end_matches(']');
            let loopback = host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .map(|address| address.is_loopback())
                    .unwrap_or(false);
            if !loopback {
                return Err(format!(
                    "cloud baseUrl must use https; http is only accepted for a loopback test endpoint: {trimmed}"
                ));
            }
        }
        other => {
            return Err(format!(
                "cloud baseUrl scheme '{other}' is not supported; use https"
            ))
        }
    }
    if url.host_str().is_none() {
        return Err(format!("cloud baseUrl has no host: {trimmed}"));
    }
    Ok(trimmed.to_string())
}

fn load_cloud_config(data_dir: &Path, overrides: &CloudOverrides) -> Result<CloudOutcome, String> {
    let path = data_dir.join("cloud.json");
    let file = match std::fs::read_to_string(&path) {
        Ok(raw) => Some(
            serde_json::from_str::<CloudFile>(&raw)
                .map_err(|error| format!("parse {}: {error}", path.display()))?,
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    // Only touch Credential Manager when the file does not carry a key, so an
    // owner-managed file stays authoritative.
    let needs_keyring = file
        .as_ref()
        .and_then(|cloud| cloud.api_key.as_deref())
        .map(|key| key.trim().is_empty())
        .unwrap_or(true);
    let keyring_key = if needs_keyring { read_cloud_key() } else { None };
    resolve_cloud(file, overrides, keyring_key)
}

#[cfg(windows)]
fn read_cloud_key() -> Option<String> {
    keyring::Entry::new(CLOUD_SERVICE, CLOUD_KEY_ENTRY)
        .ok()?
        .get_password()
        .ok()
}

#[cfg(not(windows))]
fn read_cloud_key() -> Option<String> {
    None
}

// ─────────────────────────── Pi models.json ───────────────────────────

struct ProxyEndpoint {
    port: u16,
    token: String,
}

/// Provider-visible model ids for the `blackwell` provider.
///
/// The id is the engine alias so the selector is exactly `blackwell/ENGINE_1`.
/// Duplicate aliases (two engines with the same display name) get a stable
/// suffix instead of silently resolving to the first engine.
fn local_model_ids(routes: &[ModelRoute]) -> Vec<String> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    routes
        .iter()
        .map(|route| {
            let count = seen.entry(route.model.clone()).or_insert(0);
            *count += 1;
            if *count == 1 {
                route.model.clone()
            } else {
                format!("{}#{}", route.model, count)
            }
        })
        .collect()
}

/// Route tables for the loopback proxy: route id → route, and provider-visible
/// model id → route id. Only routes assigned to this launch are ever present.
fn route_tables(
    routes: &[ModelRoute],
    model_ids: &[String],
) -> (HashMap<String, ModelRoute>, HashMap<String, String>) {
    let by_id = routes
        .iter()
        .cloned()
        .map(|route| (route.id.clone(), route))
        .collect();
    let by_model = model_ids
        .iter()
        .cloned()
        .zip(routes.iter().map(|route| route.id.clone()))
        .collect();
    (by_id, by_model)
}

fn build_local_pi_config(
    routes: &[ModelRoute],
    model_ids: &[String],
    proxy: Option<&ProxyEndpoint>,
    cloud: Option<&CloudProvider>,
) -> Result<(Value, Value), String> {
    let blackwell = proxy.filter(|_| !routes.is_empty() && !model_ids.is_empty());

    let mut providers = serde_json::Map::new();
    if let Some(proxy) = blackwell {
        let models: Vec<Value> = routes
            .iter()
            .zip(model_ids.iter())
            .map(|(route, model_id)| {
                let input = if route.vision {
                    json!(["text", "image"])
                } else {
                    json!(["text"])
                };
                json!({
                    "id": model_id,
                    "name": route.label,
                    "contextWindow": route.context_window.max(1),
                    "input": input,
                    "reasoning": true,
                    "thinkingLevelMap": {
                        "off": "none",
                        "low": "low",
                        "medium": "medium",
                        "high": "high",
                        "xhigh": "xhigh"
                    }
                })
            })
            .collect();
        providers.insert(
            "blackwell".into(),
            json!({
                "api": "openai-completions",
                "baseUrl": format!("http://127.0.0.1:{}/v1", proxy.port),
                "apiKey": proxy.token,
                "compat": {
                    "supportsDeveloperRole": false,
                    "supportsReasoningEffort": true,
                    "supportsUsageInStreaming": false
                },
                "models": models
            }),
        );
    }

    if let Some(cloud) = cloud {
        let input = if cloud.vision {
            json!(["text", "image"])
        } else {
            json!(["text"])
        };
        providers.insert(
            "cloud".into(),
            json!({
                "api": "openai-completions",
                "baseUrl": cloud.base_url,
                "apiKey": cloud.api_key,
                "models": [{
                    "id": cloud.model,
                    "name": cloud.model,
                    "contextWindow": cloud.context_window.max(1),
                    "input": input,
                    // The trial endpoint is generic OpenAI-compatible; do not
                    // ask Pi for provider-specific reasoning parameters.
                    "reasoning": false
                }]
            }),
        );
    }

    if providers.is_empty() {
        return Err("local Power Mode has no model provider".into());
    }

    let (default_provider, default_model) = if blackwell.is_some() {
        (
            "blackwell",
            routes
                .first()
                .map(|route| route.model.clone())
                .unwrap_or_default(),
        )
    } else {
        (
            "cloud",
            cloud.map(|provider| provider.model.clone()).unwrap_or_default(),
        )
    };

    let models = json!({
        "providers": providers,
        "defaultProvider": default_provider,
        "defaultModel": default_model
    });
    let settings = json!({
        "defaultProvider": default_provider,
        "defaultModel": default_model,
        "defaultTools": ["read", "powershell", "edit", "write"],
        "enableInstallTelemetry": false,
        "enableAnalytics": false,
        "quietStartup": true
    });
    Ok((models, settings))
}

fn write_pi_config(home: &Path, models: &Value, settings: &Value) -> Result<(), String> {
    std::fs::write(
        home.join("models.json"),
        serde_json::to_string_pretty(models).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("write models.json: {error}"))?;
    std::fs::write(
        home.join("settings.json"),
        serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("write settings.json: {error}"))?;
    Ok(())
}

// ─────────────────────── home (routes-only) link ───────────────────────

type HomeSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type HomeReader = futures_util::stream::SplitStream<HomeSocket>;

struct HomeLink {
    routes: Vec<ModelRoute>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl Drop for HomeLink {
    fn drop(&mut self) {
        // Closing the socket is enough: the gateway never registered this
        // connection as an operator session, so there is nothing to detach.
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// Local mode always marks its socket `role=routes` so it cannot replace a live
/// remote session that uses the same device token.
fn routes_url(server: &str) -> String {
    let trimmed = server.trim();
    if trimmed.contains('?') {
        format!("{trimmed}&role=routes")
    } else {
        format!("{trimmed}?role=routes")
    }
}

fn home_credentials(args: &Args) -> Result<(Identity, String), String> {
    let identity = load_identity(&args.data_dir).ok_or_else(|| {
        "this device is not paired (no identity.json in the data dir)".to_string()
    })?;
    let token = load_token(&identity).map_err(|_| {
        "paired identity exists but the device token is not in Windows Credential Manager"
            .to_string()
    })?;
    Ok((identity, token))
}

/// Wait for `Ready`, ask for routes, and wait for the answer.
///
/// Route discovery must finish before Pi starts: the model catalog is written
/// once. A gateway that never answers must not hang the launcher.
async fn handshake_routes(
    socket_rx: &mut HomeReader,
    out_tx: &mpsc::UnboundedSender<ClientMessage>,
) -> Result<Vec<ModelRoute>, String> {
    let deadline = tokio::time::Instant::now() + HOME_ROUTES_TIMEOUT;
    loop {
        let message = match tokio::time::timeout_at(deadline, socket_rx.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => text.to_string(),
            Ok(Some(Ok(Message::Ping(_))))
            | Ok(Some(Ok(Message::Pong(_))))
            | Ok(Some(Ok(Message::Binary(_))))
            | Ok(Some(Ok(Message::Frame(_)))) => continue,
            Ok(Some(Ok(Message::Close(frame)))) => {
                return Err(format!("gateway closed during the routes handshake: {frame:?}"))
            }
            Ok(Some(Err(error))) => return Err(format!("gateway socket: {error}")),
            Ok(None) => return Err("gateway closed during the routes handshake".into()),
            Err(_) => return Err("timed out waiting for the gateway route list".into()),
        };
        let message: ServerMessage = serde_json::from_str(&message)
            .map_err(|error| format!("invalid gateway frame: {error}"))?;
        match message {
            ServerMessage::Ready {
                protocol_version,
                server_version,
                session,
                ..
            } => {
                say(&format!(
                    "Home: gateway ready · protocol {protocol_version} · server {server_version}"
                ));
                if session.is_some() {
                    // A routes-only socket must never be steered as an operator
                    // session; the gateway should not send this at all.
                    say("Home: the gateway offered a remote session; local mode ignores it.");
                }
                let _ = out_tx.send(ClientMessage::RoutesRequest);
            }
            ServerMessage::Routes { routes } => return Ok(routes),
            ServerMessage::Error { message } => return Err(format!("gateway: {message}")),
            _ => {}
        }
    }
}

async fn connect_home(
    server: &str,
    token: &str,
    out_tx: mpsc::UnboundedSender<ClientMessage>,
    out_rx: mpsc::UnboundedReceiver<ClientMessage>,
    shared: Arc<ProxyShared>,
) -> Result<HomeLink, String> {
    let url = routes_url(server);
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|error| format!("websocket request: {error}"))?;
    request.headers_mut().insert(
        AUTHORIZATION,
        format!("Bearer {token}")
            .parse()
            .map_err(|error| format!("authorization header: {error}"))?,
    );
    let (socket, _) = tokio::time::timeout(
        HOME_CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async(request),
    )
    .await
    .map_err(|_| format!("connect {server}: timed out"))?
    .map_err(|error| format!("connect {server}: {error}"))?;

    let (mut socket_tx, mut socket_rx) = socket.split();
    let writer = tokio::spawn(async move {
        let mut out_rx = out_rx;
        while let Some(message) = out_rx.recv().await {
            let Ok(text) = serde_json::to_string(&message) else {
                break;
            };
            if socket_tx.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });
    let heartbeat_tx = out_tx.clone();
    let heartbeat = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(HEARTBEAT_SECONDS));
        loop {
            ticker.tick().await;
            if heartbeat_tx.send(ClientMessage::Ping).is_err() {
                break;
            }
        }
    });

    // A failed handshake must not leave a half-open socket and heartbeat
    // behind while local mode falls back to cloud-only.
    let routes = match handshake_routes(&mut socket_rx, &out_tx).await {
        Ok(routes) => routes,
        Err(error) => {
            writer.abort();
            heartbeat.abort();
            return Err(error);
        }
    };

    let reader_shared = shared;
    let reader = tokio::spawn(async move {
        loop {
            let text = match socket_rx.next().await {
                Some(Ok(Message::Text(text))) => text.to_string(),
                Some(Ok(Message::Ping(_)))
                | Some(Ok(Message::Pong(_)))
                | Some(Ok(Message::Binary(_)))
                | Some(Ok(Message::Frame(_))) => continue,
                Some(Ok(Message::Close(frame))) => {
                    eprintln!("home link closed by the gateway: {frame:?}");
                    break;
                }
                Some(Err(error)) => {
                    eprintln!("home link socket error: {error}");
                    break;
                }
                None => break,
            };
            let message: ServerMessage = match serde_json::from_str(&text) {
                Ok(message) => message,
                Err(error) => {
                    eprintln!("home link: invalid gateway frame: {error}");
                    continue;
                }
            };
            match message {
                ServerMessage::ModelHead {
                    id,
                    status,
                    content_type,
                } => {
                    if let Some(head) = reader_shared.heads.lock().await.remove(&id) {
                        let _ = head.send(ModelHeadInfo {
                            status,
                            content_type: content_type
                                .unwrap_or_else(|| "text/event-stream".into()),
                        });
                    }
                }
                ServerMessage::ModelChunk { id, data } => {
                    if let Some(bytes) = decode_b64(&data) {
                        let sender = reader_shared.chunks.lock().await.get(&id).cloned();
                        if let Some(sender) = sender {
                            let _ = sender.send(Ok(Bytes::from(bytes))).await;
                        }
                    }
                }
                ServerMessage::ModelEnd { id, error } => {
                    if let Some(head) = reader_shared.heads.lock().await.remove(&id) {
                        let _ = head.send(ModelHeadInfo {
                            status: 502,
                            content_type: "application/json".into(),
                        });
                    }
                    reader_shared.chunks.lock().await.remove(&id);
                    if let Some(error) = error {
                        eprintln!("home model error [{id}]: {error}");
                    }
                }
                ServerMessage::Pong => {}
                // Local Pi is owned by the local user. Never accept an operator
                // SessionOpen/SessionStop or PTY steering on this socket.
                ServerMessage::SessionOpen(_)
                | ServerMessage::SessionStop { .. }
                | ServerMessage::PtyInput { .. }
                | ServerMessage::PtyResize { .. } => {}
                ServerMessage::Ready { .. } | ServerMessage::Routes { .. } => {}
                ServerMessage::Error { message } => eprintln!("home link error: {message}"),
            }
        }
        eprintln!("home link closed; blackwell/* models are unavailable for the rest of this run");
    });

    Ok(HomeLink {
        routes,
        tasks: vec![writer, heartbeat, reader],
    })
}

// ─────────────────────────── Pi launch ───────────────────────────

fn local_cwd(args: &Args) -> PathBuf {
    if args.cwd_explicit {
        return args.cwd.clone();
    }
    // A local user expects Pi in the directory their console is already in,
    // not the remote default of C:\.
    std::env::current_dir().unwrap_or_else(|_| args.cwd.clone())
}

/// Ctrl+C in the console is for Pi: an interrupt should stop the current agent
/// turn, not the launcher that serves its model routes. A real handler (not
/// `SetConsoleCtrlHandler(NULL, TRUE)`) is deliberate — an *ignored* Ctrl+C is
/// inherited by children, which would make Pi ignore its own key.
#[cfg(windows)]
fn install_console_ctrl_guard() {
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{FALSE, TRUE};
    use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;

    unsafe extern "system" fn handler(event: u32) -> BOOL {
        // 0 = CTRL_C_EVENT, 1 = CTRL_BREAK_EVENT. Close/logoff/shutdown keep the
        // default handling so the launcher still terminates with the console.
        if event == 0 || event == 1 {
            TRUE
        } else {
            FALSE
        }
    }

    unsafe {
        SetConsoleCtrlHandler(Some(handler), TRUE);
    }
}

#[cfg(not(windows))]
fn install_console_ctrl_guard() {}

async fn launch_pi(
    pi: &Path,
    agent_dir: &Path,
    session_dir: &Path,
    cwd: &Path,
    name: &str,
) -> Result<i32, String> {
    if !pi.is_file() {
        return Err(format!(
            "Pi not found: {}\nPlace the Pi package beside oym-link.exe (pi/pi.exe) or pass --pi <path>.",
            pi.display()
        ));
    }
    install_console_ctrl_guard();
    let mut command = std::process::Command::new(pi);
    command
        .arg("--tools")
        .arg("read,powershell,edit,write")
        .arg("--no-extensions")
        .arg("--no-mcp")
        .arg("--no-skills")
        .arg("--no-context-files")
        .arg("--no-prompt-templates")
        .arg("--no-approve")
        .arg("--session-dir")
        .arg(session_dir)
        .arg("--thinking")
        .arg("medium")
        .arg("--tui-mode")
        .arg("regular")
        .arg("--name")
        .arg(format!("local-{name}"))
        .env("PI_CODING_AGENT_DIR", agent_dir)
        .env("PI_SUBAGENT_PI_BINARY", pi)
        .current_dir(cwd)
        .stdin(std::process::Stdio::inherit())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit());
    let mut child = command
        .spawn()
        .map_err(|error| format!("launch {}: {error}", pi.display()))?;
    // Direct child wait on the blocking pool; stdio is inherited so the local
    // console stays Pi's TUI.
    let status = tokio::task::spawn_blocking(move || child.wait())
        .await
        .map_err(|error| format!("wait for Pi: {error}"))?
        .map_err(|error| format!("wait for Pi: {error}"))?;
    Ok(status.code().unwrap_or(1))
}

// ─────────────────────────── entry point ───────────────────────────

pub(crate) async fn run(args: Args) -> Result<i32, String> {
    run_with_admin(args, super::admin::current_user_is_local_admin()).await
}

/// Split from [`run`] so the refusal path is testable without a standard
/// Windows account: the check must happen before any directory or file is
/// written (DECISIONS D-011/D-017).
async fn run_with_admin(args: Args, is_local_admin: bool) -> Result<i32, String> {
    // Local Pi has the full local tool surface, so it is the owner's mode, not
    // the family one. Check before writing any files.
    if !is_local_admin {
        return Err("Local Power Mode is limited to the owner / local administrator account on this PC.\n\
             Sign in with this PC's administrator account (the usual single-user home setup) and run\n\
             oym-link.exe --local again. Standard accounts use Home mode instead."
            .into());
    }
    say(&format!(
        "OYM Link {CLIENT_VERSION} — local Power Mode (pi {PI_VERSION})"
    ));
    if args.pair.is_some() {
        say("--pair is ignored in local mode: pair once from a normal run, then use --local.");
    }

    // Shared with remote Power Mode: the same persistent Pi session store, so
    // `/resume` crosses local and remote sessions on this machine.
    let pi_home = args.data_dir.join("local-pi-home");
    let session_dir = args.data_dir.join("pi-sessions");
    std::fs::create_dir_all(&pi_home)
        .map_err(|error| format!("create {}: {error}", pi_home.display()))?;
    std::fs::create_dir_all(&session_dir)
        .map_err(|error| format!("create {}: {error}", session_dir.display()))?;

    let overrides = CloudOverrides {
        base_url: args.cloud_base_url.clone(),
        model: args.cloud_model.clone(),
        context_window: args.cloud_context_window,
    };
    let (cloud, cloud_issue) = match load_cloud_config(&args.data_dir, &overrides) {
        Ok(CloudOutcome::Ready(provider)) => (Some(provider), None),
        Ok(CloudOutcome::Missing(reason)) => (None, Some(reason)),
        Err(error) => (None, Some(error)),
    };

    let mut token_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut token_bytes);
    let proxy_token = hex::encode(token_bytes);

    let mut home: Option<HomeLink> = None;
    let mut routes: Vec<ModelRoute> = Vec::new();
    let mut shared: Option<Arc<ProxyShared>> = None;
    let mut home_issue = String::new();

    match home_credentials(&args) {
        Ok((identity, token)) => {
            let server = args
                .server
                .clone()
                .unwrap_or_else(|| identity.server.clone());
            say(&format!("Home: connecting to {server} (routes only)"));
            let (out_tx, out_rx) = mpsc::unbounded_channel();
            let proxy_shared = Arc::new(ProxyShared::new(out_tx.clone(), proxy_token.clone()));
            match connect_home(&server, &token, out_tx, out_rx, proxy_shared.clone()).await {
                Ok(link) => {
                    if link.routes.is_empty() {
                        say("Home: connected, but no Blackwell engine is running.");
                        home_issue = "the home gateway reported no running engines".into();
                    } else {
                        say(&format!(
                            "Home: {} route(s) — {}",
                            link.routes.len(),
                            link.routes
                                .iter()
                                .map(|route| format!("blackwell/{}", route.model))
                                .collect::<Vec<_>>()
                                .join(", ")
                        ));
                        routes = link.routes.clone();
                        home = Some(link);
                        shared = Some(proxy_shared);
                    }
                }
                Err(error) => {
                    say(&format!("Home: unavailable — {error}"));
                    home_issue = error;
                }
            }
        }
        Err(reason) => {
            say(&format!("Home: {reason}"));
            home_issue = reason;
        }
    }

    if home.is_none() && cloud.is_none() {
        let cloud_reason = cloud_issue
            .clone()
            .unwrap_or_else(|| "not configured".into());
        let cloud_path = args.data_dir.join("cloud.json");
        return Err(format!(
            "no model endpoint available.\n\
             Home: {home_issue}\n\
             Cloud: {cloud_reason}\n\
             \n\
             Pair this PC with OYM (run oym-link.exe without --local and enter\n\
             the code from REMOTE → STATUS), or configure an OpenAI-compatible endpoint in\n\
             {}:\n\
             \n\
               {{ \"baseUrl\": \"https://api.example.com/v1\", \"model\": \"<model-id>\",\n\
                 \"contextWindow\": 131072, \"vision\": false }}\n\
             \n\
             Keep the API key out of the file if you prefer Windows Credential Manager:\n\
               service OYMLink, user cloud-api-key",
            cloud_path.display()
        ));
    }

    if let Some(provider) = &cloud {
        say(&format!("Cloud: {}", provider.summary()));
    } else if let Some(reason) = &cloud_issue {
        say(&format!("Cloud: not configured — {reason}"));
    }

    let model_ids = local_model_ids(&routes);
    let proxy = if let Some(shared) = &shared {
        let (by_id, by_model) = route_tables(&routes, &model_ids);
        *shared.routes.write().await = by_id;
        *shared.models.write().await = by_model;
        let port = start_proxy(shared.clone(), true).await?;
        say(&format!(
            "Proxy: http://127.0.0.1:{port}/v1 · loopback + random bearer token"
        ));
        Some(ProxyEndpoint {
            port,
            token: proxy_token.clone(),
        })
    } else {
        None
    };

    let (models, settings) =
        build_local_pi_config(&routes, &model_ids, proxy.as_ref(), cloud.as_ref())?;
    write_pi_config(&pi_home, &models, &settings)?;
    say(&format!(
        "Pi home: {} · session store: {}",
        pi_home.display(),
        session_dir.display()
    ));

    let cwd = local_cwd(&args);
    say(&format!(
        "Launching Pi in {} — /model switches between blackwell/* and cloud/*",
        cwd.display()
    ));
    let code = launch_pi(&args.pi, &pi_home, &session_dir, &cwd, &args.name).await?;
    drop(home);
    say(&format!("Pi exited (code {code})."));
    Ok(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_standard_user_is_refused_before_any_file_is_written() {
        let data_dir = std::env::temp_dir().join(format!(
            "blackwell-local-refusal-{}",
            rand::random::<u64>()
        ));
        let args = Args {
            server: None,
            pair: None,
            name: "refusal-test".into(),
            pi: data_dir.join("pi").join("pi.exe"),
            data_dir: data_dir.clone(),
            cwd: data_dir.clone(),
            cwd_explicit: false,
            local: true,
            cloud_base_url: None,
            cloud_model: None,
            cloud_context_window: None,
        };

        let error = run_with_admin(args, false)
            .await
            .expect_err("a standard user must be refused");
        assert!(
            error.contains("owner / local administrator"),
            "unexpected refusal text: {error}"
        );
        assert!(
            !data_dir.exists(),
            "the admin refusal must happen before the data dir is created"
        );
    }

    fn route(id: &str, model: &str, context_window: usize, vision: bool) -> ModelRoute {
        ModelRoute {
            id: id.into(),
            label: model.into(),
            model: model.into(),
            context_window,
            vision,
        }
    }

    fn cloud() -> CloudProvider {
        CloudProvider {
            base_url: "https://api.example.com/v1".into(),
            model: "cloud-model".into(),
            context_window: 131_072,
            vision: false,
            api_key: "sk-secret".into(),
        }
    }

    fn provider<'a>(models: &'a Value, name: &str) -> &'a Value {
        models["providers"]
            .as_object()
            .expect("providers object")
            .get(name)
            .unwrap_or_else(|| panic!("provider {name}"))
    }

    #[test]
    fn local_models_use_exact_provider_names_and_selectors() {
        let routes = vec![
            route("route_1", "ENGINE_1", 32768, false),
            route("route_2", "ENGINE_2", 65536, true),
        ];
        let ids = local_model_ids(&routes);
        let proxy = ProxyEndpoint {
            port: 4567,
            token: "proxy-token".into(),
        };
        let cloud = cloud();
        let (models, settings) =
            build_local_pi_config(&routes, &ids, Some(&proxy), Some(&cloud)).expect("config");

        let mut names: Vec<&String> = models["providers"]
            .as_object()
            .expect("providers")
            .keys()
            .collect();
        names.sort();
        assert_eq!(names, vec!["blackwell", "cloud"]);

        let blackwell = provider(&models, "blackwell");
        assert_eq!(blackwell["api"], "openai-completions");
        assert_eq!(blackwell["baseUrl"], "http://127.0.0.1:4567/v1");
        assert_eq!(blackwell["apiKey"], "proxy-token");
        let engine_models = blackwell["models"].as_array().expect("models");
        assert_eq!(engine_models[0]["id"], "ENGINE_1");
        assert_eq!(engine_models[1]["id"], "ENGINE_2");
        assert_eq!(engine_models[1]["input"][1], "image");
        assert_eq!(engine_models[0]["contextWindow"], 32768);

        let cloud_block = provider(&models, "cloud");
        assert_eq!(cloud_block["baseUrl"], "https://api.example.com/v1");
        assert_eq!(cloud_block["apiKey"], "sk-secret");
        assert_eq!(cloud_block["models"][0]["id"], "cloud-model");

        // Exactly the two `provider/model` names the spec names.
        assert_eq!(
            format!(
                "{}/{}",
                models["defaultProvider"].as_str().expect("provider"),
                models["defaultModel"].as_str().expect("model")
            ),
            "blackwell/ENGINE_1"
        );
        assert_eq!(
            format!(
                "cloud/{}",
                cloud_block["models"][0]["id"].as_str().expect("cloud id")
            ),
            "cloud/cloud-model"
        );
        assert_eq!(settings["defaultTools"], json!(["read", "powershell", "edit", "write"]));
        assert_eq!(settings["defaultProvider"], "blackwell");
        assert_eq!(settings["defaultModel"], "ENGINE_1");
    }

    #[test]
    fn cloud_only_keeps_a_single_cloud_provider() {
        let cloud = cloud();
        let (models, _) =
            build_local_pi_config(&[], &[], None, Some(&cloud)).expect("cloud-only config");
        let providers = models["providers"].as_object().expect("providers");
        assert_eq!(providers.len(), 1);
        assert!(providers.contains_key("cloud"));
        assert_eq!(models["defaultProvider"], "cloud");
        assert_eq!(models["defaultModel"], "cloud-model");
    }

    #[test]
    fn no_endpoint_is_a_clear_error() {
        let error = build_local_pi_config(&[], &[], None, None).expect_err("must fail");
        assert!(error.contains("no model provider"), "{error}");
    }

    #[test]
    fn duplicate_engine_aliases_get_unique_selector_ids() {
        let routes = vec![
            route("route_1", "local", 8192, false),
            route("route_2", "local", 8192, false),
        ];
        assert_eq!(local_model_ids(&routes), vec!["local", "local#2"]);
    }

    #[test]
    fn proxy_route_tables_only_expose_assigned_routes() {
        let routes = vec![route("route_1", "ENGINE_1", 8192, false)];
        let ids = local_model_ids(&routes);
        let (by_id, by_model) = route_tables(&routes, &ids);
        assert!(by_id.contains_key("route_1"));
        assert!(!by_id.contains_key("route_2"));
        assert_eq!(by_model.get("ENGINE_1").map(String::as_str), Some("route_1"));
        assert!(!by_model.contains_key("ENGINE_2"));
    }

    #[test]
    fn cloud_config_accepts_https_and_loopback_http_only() {
        assert_eq!(
            normalize_base_url("https://api.example.com/v1/").expect("https"),
            "https://api.example.com/v1"
        );
        assert!(normalize_base_url("http://127.0.0.1:8889/v1").is_ok());
        assert!(normalize_base_url("http://localhost:8889/v1").is_ok());
        assert!(normalize_base_url("http://[::1]:8889/v1").is_ok());
        assert!(normalize_base_url("http://api.example.com/v1").is_err());
        assert!(normalize_base_url("ftp://api.example.com/v1").is_err());
        assert!(normalize_base_url("not a url").is_err());
    }

    #[test]
    fn cloud_key_falls_back_to_credential_manager() {
        let file = CloudFile {
            base_url: Some("https://api.example.com/v1".into()),
            model: Some("m1".into()),
            context_window: None,
            vision: None,
            api_key: None,
        };
        match resolve_cloud(Some(file.clone()), &CloudOverrides::default(), Some("from-keyring".into()))
            .expect("resolve")
        {
            CloudOutcome::Ready(provider) => {
                assert_eq!(provider.api_key, "from-keyring");
                assert_eq!(provider.context_window, CLOUD_DEFAULT_CONTEXT_WINDOW);
                assert_eq!(provider.base_url, "https://api.example.com/v1");
            }
            CloudOutcome::Missing(reason) => panic!("expected ready, got missing: {reason}"),
        }

        match resolve_cloud(Some(file), &CloudOverrides::default(), None).expect("resolve") {
            CloudOutcome::Ready(_) => panic!("key must not be optional"),
            CloudOutcome::Missing(reason) => {
                assert!(reason.contains("cloud-api-key"), "{reason}");
            }
        }
    }

    #[test]
    fn cloud_overrides_win_and_the_key_is_never_summarized() {
        let file = CloudFile {
            base_url: Some("https://api.example.com/v1".into()),
            model: Some("file-model".into()),
            context_window: Some(4096),
            vision: Some(true),
            api_key: Some("sk-secret".into()),
        };
        let overrides = CloudOverrides {
            base_url: None,
            model: Some("override-model".into()),
            context_window: Some(8192),
        };
        match resolve_cloud(Some(file), &overrides, None).expect("resolve") {
            CloudOutcome::Ready(provider) => {
                assert_eq!(provider.model, "override-model");
                assert_eq!(provider.context_window, 8192);
                assert!(provider.vision);
                assert!(!provider.summary().contains("sk-secret"));
                assert!(provider.summary().contains("api.example.com"));
            }
            CloudOutcome::Missing(reason) => panic!("expected ready, got missing: {reason}"),
        }
    }

    #[test]
    fn local_socket_is_marked_routes_only() {
        assert_eq!(routes_url("wss://host/link"), "wss://host/link?role=routes");
        assert_eq!(
            routes_url("ws://127.0.0.1:7555/link?x=1"),
            "ws://127.0.0.1:7555/link?x=1&role=routes"
        );
    }

    #[test]
    fn cloud_models_json_never_uses_the_blackwell_proxy() {
        let routes = vec![route("route_1", "ENGINE_1", 8192, false)];
        let ids = local_model_ids(&routes);
        let (models, _) = build_local_pi_config(&routes, &ids, None, Some(&cloud())).expect("config");
        // No proxy endpoint => no blackwell provider, even when routes exist.
        assert!(!models["providers"]
            .as_object()
            .expect("providers")
            .contains_key("blackwell"));
        assert_eq!(models["defaultProvider"], "cloud");
    }
}
