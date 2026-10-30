//! Live gateway state: devices, connections, sessions, routes, pairing.
//!
//! The state lives beside the Tauri app (or the standalone gateway binary).
//! Only the trial-scope pieces are here: one active session per device, JSON
//! persistence, no transcript/audit log.

use crate::devices::{self, DeviceRecord, DeviceView};
use crate::protocol::{
    ClientMessage, HealthResponse, ModelRoute, PairRequest, PairResponse, ServerMessage,
    SessionOpen,
};
use rand::Rng;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::fs::OpenOptions;
use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc, Mutex, RwLock};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Deterministic route order: numeric route ids first (`route_2` before
/// `route_10`), then anything else alphabetically. Non-numeric ids sort last so
/// a future id scheme does not silently jump ahead of engine routes.
fn route_order(a: &str, b: &str) -> std::cmp::Ordering {
    fn number(id: &str) -> u64 {
        id.rsplit('_')
            .next()
            .and_then(|suffix| suffix.parse::<u64>().ok())
            .unwrap_or(u64::MAX)
    }
    number(a).cmp(&number(b)).then_with(|| a.cmp(b))
}

/// Append one forensic event. Logging is best-effort: a full disk or a locked
/// file must never break the maintenance session itself.
fn append_session_event(path: &Path, event: serde_json::Value) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    if let Ok(line) = serde_json::to_string(&event) {
        let _ = writeln!(file, "{line}");
    }
}

#[derive(Clone, Debug)]
pub struct GatewayConfig {
    pub bind: SocketAddr,
    pub public_url: Option<String>,
    pub data_dir: PathBuf,
    /// Test-only: start a maintenance session as soon as a device connects.
    pub auto_session: bool,
}

impl GatewayConfig {
    /// App-root layout: `{app_root}/config/remote`.
    pub fn for_app(app_root: &Path) -> Self {
        let data_dir = app_root.join("config").join("remote");
        let public_url = std::env::var("OYM_PUBLIC_URL")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .or_else(|| {
                std::fs::read_to_string(data_dir.join("public_url.txt"))
                    .ok()
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
            });

        Self {
            bind: "127.0.0.1:7443".parse().expect("static socket addr"),
            public_url,
            data_dir,
            auto_session: false,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    pub bind: String,
    pub public_url: Option<String>,
    pub gateway_error: Option<String>,
    pub gateway_running: bool,
    pub device_count: usize,
    pub online_count: usize,
    pub active_sessions: usize,
    pub protocol_version: u32,
    pub server_version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    pub code: String,
    pub expires_at: u64,
    pub public_url: Option<String>,
    pub command: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthInfo {
    pub ok: bool,
    pub url: Option<String>,
    pub status: Option<u16>,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminateResult {
    pub sent: bool,
    pub pending: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachResult {
    pub session: Option<SessionOpen>,
    pub stop_requested: bool,
}

/// Server-side route: the client-facing [`ModelRoute`] plus the engine port
/// that must never cross the tunnel.
#[derive(Clone, Debug)]
pub struct RouteBinding {
    pub route: ModelRoute,
    pub engine_port: u16,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum GatewayEvent {
    DeviceUpdated { device: DeviceView },
    DeviceConnected { device_id: String, name: String },
    DeviceDisconnected { device_id: String },
    DeviceRemoved { device_id: String },
    SessionReady {
        device_id: String,
        pid: Option<u32>,
        pi_version: Option<String>,
        integrity: Option<String>,
    },
    SessionData { device_id: String, data: String },
    SessionExit {
        device_id: String,
        code: Option<i32>,
    },
}

struct PairingCode {
    expires_at: u64,
}

struct Connection {
    id: u64,
    sender: mpsc::Sender<ServerMessage>,
    shutdown: CancellationToken,
}

struct GatewayRuntime {
    shutdown: CancellationToken,
    task: JoinHandle<()>,
}

struct SessionRecord {
    profile: String,
    state: String,
    cols: u16,
    rows: u16,
    stop_requested: bool,
    /// Append-only forensic JSONL: start/ready/out/in/stop/exit.
    log_path: PathBuf,
}

struct Inner {
    devices: HashMap<String, DeviceRecord>,
    pairing: HashMap<String, PairingCode>,
    connections: HashMap<String, Connection>,
    sessions: HashMap<String, SessionRecord>,
    routes: HashMap<String, RouteBinding>,
    model_cancels: HashMap<String, (String, CancellationToken)>,
    pair_attempts: VecDeque<Instant>,
    gateway_error: Option<String>,
}

pub struct GatewayState {
    pub cfg: GatewayConfig,
    inner: RwLock<Inner>,
    events: broadcast::Sender<GatewayEvent>,
    client: reqwest::Client,
    started: Instant,
    next_connection_id: AtomicU64,
    next_session_seq: AtomicU64,
    gateway_running: AtomicBool,
    gateway_runtime: Mutex<Option<GatewayRuntime>>,
}

impl GatewayState {
    pub fn load(cfg: GatewayConfig) -> Result<Arc<Self>, String> {
        let records = devices::load(&cfg.data_dir.join("devices.json"));
        let mut devices_map = HashMap::new();
        for record in records {
            devices_map.insert(record.id.clone(), record);
        }

        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| format!("build model HTTP client: {e}"))?;
        let (events, _) = broadcast::channel(512);

        Ok(Arc::new(Self {
            cfg,
            inner: RwLock::new(Inner {
                devices: devices_map,
                pairing: HashMap::new(),
                connections: HashMap::new(),
                sessions: HashMap::new(),
                routes: HashMap::new(),
                model_cancels: HashMap::new(),
                pair_attempts: VecDeque::new(),
                gateway_error: None,
            }),
            events,
            client,
            started: Instant::now(),
            next_connection_id: AtomicU64::new(1),
            next_session_seq: AtomicU64::new(1),
            gateway_running: AtomicBool::new(false),
            gateway_runtime: Mutex::new(None),
        }))
    }

    pub fn subscribe(&self) -> broadcast::Receiver<GatewayEvent> {
        self.events.subscribe()
    }

    pub fn http_client(&self) -> reqwest::Client {
        self.client.clone()
    }

    pub async fn set_gateway_error(&self, error: Option<String>) {
        self.inner.write().await.gateway_error = error;
    }

    pub fn uptime_seconds(&self) -> u64 {
        self.started.elapsed().as_secs()
    }

    pub async fn status(&self) -> GatewayStatus {
        let inner = self.inner.read().await;
        let online_count = inner
            .devices
            .keys()
            .filter(|id| inner.connections.contains_key(*id))
            .count();
        let active_sessions = inner
            .sessions
            .values()
            .filter(|session| session.state == "starting" || session.state == "running")
            .count();
        GatewayStatus {
            bind: self.cfg.bind.to_string(),
            public_url: self.cfg.public_url.clone(),
            gateway_error: inner.gateway_error.clone(),
            gateway_running: self.gateway_running.load(Ordering::Relaxed),
            device_count: inner.devices.len(),
            online_count,
            active_sessions,
            protocol_version: crate::protocol::PROTOCOL_VERSION,
            server_version: SERVER_VERSION.to_string(),
        }
    }

    pub async fn start_gateway(self: &Arc<Self>) -> Result<(), String> {
        let mut runtime = self.gateway_runtime.lock().await;
        if runtime.is_some() {
            return Ok(());
        }
        let shutdown = CancellationToken::new();
        let task_state = self.clone();
        let task_shutdown = shutdown.clone();
        let task = tokio::spawn(async move {
            let result = crate::serve_with_shutdown(task_state.clone(), task_shutdown).await;
            if let Err(error) = result {
                log::error!("[remote] gateway: {error}");
                task_state.set_gateway_error(Some(error)).await;
            }
            task_state.gateway_running.store(false, Ordering::Relaxed);
            *task_state.gateway_runtime.lock().await = None;
        });
        self.gateway_running.store(true, Ordering::Relaxed);
        *runtime = Some(GatewayRuntime { shutdown, task });
        Ok(())
    }

    pub async fn stop_gateway(&self) -> Result<(), String> {
        let runtime = self.gateway_runtime.lock().await.take();
        let Some(runtime) = runtime else {
            self.gateway_running.store(false, Ordering::Relaxed);
            return Ok(());
        };
        self.disconnect_all_connections().await;
        runtime.shutdown.cancel();
        let _ = runtime.task.await;
        self.gateway_running.store(false, Ordering::Relaxed);
        Ok(())
    }

    async fn disconnect_all_connections(&self) {
        let connections = {
            let mut inner = self.inner.write().await;
            for session in inner.sessions.values_mut() {
                session.state = "exited".into();
            }
            inner.connections.drain().collect::<Vec<_>>()
        };
        for (device_id, connection) in connections {
            connection.shutdown.cancel();
            let _ = self
                .events
                .send(GatewayEvent::DeviceDisconnected { device_id });
        }
    }

    pub async fn health_payload(&self) -> HealthResponse {
        let status = self.status().await;
        HealthResponse {
            ok: status.gateway_error.is_none(),
            version: SERVER_VERSION,
            protocol_version: crate::protocol::PROTOCOL_VERSION,
            uptime_seconds: self.uptime_seconds(),
            devices: status.device_count,
            online_devices: status.online_count,
            active_sessions: status.active_sessions,
        }
    }

    pub async fn health_check(&self) -> HealthInfo {
        let Some(public_url) = self.cfg.public_url.clone() else {
            return HealthInfo {
                ok: false,
                url: None,
                status: None,
                latency_ms: None,
                error: Some("public URL is not configured".into()),
            };
        };
        let url = format!("{}/healthz", public_url.trim_end_matches('/'));
        let started = Instant::now();
        match self
            .client
            .get(&url)
            .timeout(Duration::from_secs(6))
            .send()
            .await
        {
            Ok(response) => {
                let status = response.status().as_u16();
                HealthInfo {
                    ok: response.status().is_success(),
                    url: Some(url),
                    status: Some(status),
                    latency_ms: Some(started.elapsed().as_millis() as u64),
                    error: if response.status().is_success() {
                        None
                    } else {
                        Some(format!("HTTP {status}"))
                    },
                }
            }
            Err(error) => HealthInfo {
                ok: false,
                url: Some(url),
                status: None,
                latency_ms: Some(started.elapsed().as_millis() as u64),
                error: Some(error.to_string()),
            },
        }
    }

    fn ws_url(&self) -> String {
        let Some(public_url) = self.cfg.public_url.as_deref() else {
            return "wss://<public-host>".into();
        };
        let base = public_url.trim_end_matches('/');
        if let Some(rest) = base.strip_prefix("https://") {
            format!("wss://{rest}/link")
        } else if let Some(rest) = base.strip_prefix("http://") {
            format!("ws://{rest}/link")
        } else {
            format!("{base}/link")
        }
    }

    pub async fn create_pairing(&self) -> PairingInfo {
        const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let now = devices::unix_now();
        let mut inner = self.inner.write().await;
        inner.pairing.retain(|_, code| code.expires_at > now);
        let mut rng = rand::thread_rng();
        let code = loop {
            let candidate: String = (0..8)
                .map(|_| {
                    let idx = rng.gen_range(0..ALPHABET.len());
                    ALPHABET[idx] as char
                })
                .collect();
            if !inner.pairing.contains_key(&candidate) {
                break candidate;
            }
        };
        let expires_at = now + 300;
        inner
            .pairing
            .insert(code.clone(), PairingCode { expires_at });
        let public_url = self.cfg.public_url.clone();
        let command = format!("oym-link --server {} --pair {code}", self.ws_url());
        PairingInfo {
            code,
            expires_at,
            public_url,
            command,
        }
    }

    pub async fn pair(&self, request: PairRequest) -> Result<PairResponse, String> {
        let now = devices::unix_now();
        {
            let mut inner = self.inner.write().await;
            inner
                .pair_attempts
                .retain(|attempt| attempt.elapsed() < Duration::from_secs(60));
            if inner.pair_attempts.len() >= 10 {
                return Err("too many pairing attempts; wait a minute".into());
            }
            inner.pair_attempts.push_back(Instant::now());
        }

        let invite_token = request
            .invite
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(token) = invite_token {
            // Invite files are local owner state; redemption is single-use.
            let _ = crate::invites::redeem(&self.cfg.data_dir, token)?;
        } else {
            let mut inner = self.inner.write().await;
            let Some(code) = inner.pairing.remove(&request.code) else {
                return Err("invalid or already used pairing code".into());
            };
            if code.expires_at <= now {
                return Err("pairing code expired".into());
            }
        }

        let token = devices::new_token();
        let device_id = devices::new_device_id();
        let record = DeviceRecord {
            id: device_id.clone(),
            token_hash: devices::hash_token(&token),
            name: request
                .device_name
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| "Windows device".into()),
            custom_name: None,
            os: request.os,
            user: request.user,
            integrity: request.integrity,
            client_version: request.client_version,
            pi_version: request.pi_version,
            paired_at: now,
            last_seen: now,
            revoked: false,
        };

        let snapshot = {
            let mut inner = self.inner.write().await;
            inner.devices.insert(device_id.clone(), record);
            inner.devices.values().cloned().collect::<Vec<_>>()
        };
        devices::save(&self.cfg.data_dir.join("devices.json"), &snapshot)?;

        Ok(PairResponse {
            device_id,
            token,
            server_version: SERVER_VERSION.to_string(),
        })
    }

    pub async fn authenticate(&self, token: &str) -> Option<DeviceRecord> {
        if token.trim().is_empty() {
            return None;
        }
        let candidate = devices::hash_token(token);
        let mut inner = self.inner.write().await;
        let device_id = inner
            .devices
            .values()
            .find(|record| {
                !record.revoked && devices::hash_matches(&record.token_hash, &candidate)
            })
            .map(|record| record.id.clone())?;
        let record = inner.devices.get_mut(&device_id)?;
        record.last_seen = devices::unix_now();
        let clone = record.clone();
        let snapshot = inner.devices.values().cloned().collect::<Vec<_>>();
        drop(inner);
        let _ = devices::save(&self.cfg.data_dir.join("devices.json"), &snapshot);
        Some(clone)
    }

    pub async fn device_views(&self) -> Vec<DeviceView> {
        let inner = self.inner.read().await;
        let mut views: Vec<DeviceView> = inner
            .devices
            .values()
            .map(|device| {
                let online = inner.connections.contains_key(&device.id);
                let session = inner.sessions.get(&device.id);
                DeviceView {
                    id: device.id.clone(),
                    name: device.name.clone(),
                    custom_name: device.custom_name.clone(),
                    online,
                    os: device.os.clone(),
                    user: device.user.clone(),
                    integrity: device.integrity.clone(),
                    client_version: device.client_version.clone(),
                    pi_version: device.pi_version.clone(),
                    paired_at: device.paired_at,
                    last_seen: device.last_seen,
                    revoked: device.revoked,
                    session_state: session
                        .map(|s| s.state.clone())
                        .unwrap_or_else(|| "idle".into()),
                    session_profile: session.map(|s| s.profile.clone()),
                }
            })
            .collect();
        views.sort_by(|a, b| {
            a.custom_name
                .as_deref()
                .unwrap_or(&a.name)
                .to_lowercase()
                .cmp(&b.custom_name.as_deref().unwrap_or(&b.name).to_lowercase())
        });
        views
    }

    pub async fn rename_device(
        &self,
        device_id: &str,
        custom_name: Option<String>,
    ) -> Result<DeviceView, String> {
        let custom_name = custom_name
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty());
        if let Some(name) = &custom_name {
            if name.chars().count() > 80 {
                return Err("display name must be 80 characters or fewer".into());
            }
            if name.chars().any(char::is_control) {
                return Err("display name must not contain control characters".into());
            }
        }

        let (view, snapshot) = {
            let mut inner = self.inner.write().await;
            let Some(record) = inner.devices.get_mut(device_id) else {
                return Err("device not found".into());
            };
            record.custom_name = custom_name;
            let device = inner
                .devices
                .get(device_id)
                .ok_or_else(|| "device not found".to_string())?;
            let online = inner.connections.contains_key(device_id);
            let session = inner.sessions.get(device_id);
            let view = DeviceView {
                id: device.id.clone(),
                name: device.name.clone(),
                custom_name: device.custom_name.clone(),
                online,
                os: device.os.clone(),
                user: device.user.clone(),
                integrity: device.integrity.clone(),
                client_version: device.client_version.clone(),
                pi_version: device.pi_version.clone(),
                paired_at: device.paired_at,
                last_seen: device.last_seen,
                revoked: device.revoked,
                session_state: session
                    .map(|s| s.state.clone())
                    .unwrap_or_else(|| "idle".into()),
                session_profile: session.map(|s| s.profile.clone()),
            };
            let snapshot = inner.devices.values().cloned().collect::<Vec<_>>();
            (view, snapshot)
        };
        devices::save(&self.cfg.data_dir.join("devices.json"), &snapshot)?;
        let _ = self.events.send(GatewayEvent::DeviceUpdated {
            device: view.clone(),
        });
        Ok(view)
    }

    pub async fn revoke(&self, device_id: &str) -> Result<(), String> {
        let (shutdown, cancels) = {
            let mut inner = self.inner.write().await;
            if inner.devices.remove(device_id).is_none() {
                return Err("device not found".into());
            }
            let shutdown = inner
                .connections
                .remove(device_id)
                .map(|connection| connection.shutdown);
            inner.sessions.remove(device_id);
            let cancels = inner
                .model_cancels
                .iter()
                .filter(|(_, (owner, _))| owner == device_id)
                .map(|(id, (_, token))| (id.clone(), token.clone()))
                .collect::<Vec<_>>();
            for (id, _) in &cancels {
                inner.model_cancels.remove(id);
            }
            let snapshot = inner.devices.values().cloned().collect::<Vec<_>>();
            drop(inner);
            let _ = devices::save(&self.cfg.data_dir.join("devices.json"), &snapshot);
            (shutdown, cancels)
        };
        if let Some(token) = shutdown {
            token.cancel();
        }
        for (_, token) in cancels {
            token.cancel();
        }
        let _ = self.events.send(GatewayEvent::DeviceRemoved {
            device_id: device_id.to_string(),
        });
        Ok(())
    }

    pub async fn attach_connection(
        &self,
        device_id: &str,
        sender: mpsc::Sender<ServerMessage>,
        shutdown: CancellationToken,
    ) -> Result<(u64, AttachResult), String> {
        let connection_id = self.next_connection_id.fetch_add(1, Ordering::Relaxed);
        let mut inner = self.inner.write().await;
        let Some(device) = inner.devices.get(device_id) else {
            return Err("device not found".into());
        };
        if device.revoked {
            return Err("device revoked".into());
        }
        let device_name = device.name.clone();
        if let Some(old) = inner.connections.insert(
            device_id.to_string(),
            Connection {
                id: connection_id,
                sender,
                shutdown,
            },
        ) {
            old.shutdown.cancel();
        }

        let routes: Vec<ModelRoute> = inner
            .routes
            .values()
            .map(|binding| binding.route.clone())
            .collect();
        let (session, stop_requested) = if let Some(session) = inner.sessions.get_mut(device_id) {
            let active = (session.state == "starting" || session.state == "running")
                && !session.stop_requested;
            if active {
                (
                    Some(SessionOpen {
                        profile: session.profile.clone(),
                        routes,
                        cols: session.cols,
                        rows: session.rows,
                    }),
                    false,
                )
            } else {
                // A terminated or exited session must not be replayed to a
                // reconnecting client: it would spawn a fresh Pi only to stop
                // it immediately and leave the UI stuck.
                session.state = "exited".into();
                session.stop_requested = false;
                (None, false)
            }
        } else {
            (None, false)
        };

        let _ = self.events.send(GatewayEvent::DeviceConnected {
            device_id: device_id.to_string(),
            name: device_name,
        });
        Ok((
            connection_id,
            AttachResult {
                session,
                stop_requested,
            },
        ))
    }

    pub async fn detach_connection(&self, device_id: &str, connection_id: u64) {
        let removed = {
            let mut inner = self.inner.write().await;
            if inner
                .connections
                .get(device_id)
                .map(|connection| connection.id == connection_id)
                .unwrap_or(false)
            {
                let connection = inner.connections.remove(device_id);
                if let Some(connection) = connection {
                    connection.shutdown.cancel();
                }
                // The client supervisor kills its Pi child when the socket
                // closes. Do not leave the operator UI showing a phantom
                // RUNNING session for an offline device.
                if let Some(session) = inner.sessions.get_mut(device_id) {
                    if session.state == "starting" || session.state == "running" {
                        session.state = "exited".into();
                    }
                }
                true
            } else {
                false
            }
        };
        if removed {
            let _ = self.events.send(GatewayEvent::DeviceDisconnected {
                device_id: device_id.to_string(),
            });
        }
    }

    pub async fn on_hello(&self, device_id: &str, message: ClientMessage) {
        let ClientMessage::Hello {
            device_name,
            os,
            user,
            integrity,
            client_version,
            pi_version,
        } = message
        else {
            return;
        };
        let view = {
            let mut inner = self.inner.write().await;
            let base = {
                let Some(device) = inner.devices.get_mut(device_id) else {
                    return;
                };
                if let Some(name) = device_name.filter(|name| !name.trim().is_empty()) {
                    device.name = name;
                }
                if os.is_some() {
                    device.os = os;
                }
                if user.is_some() {
                    device.user = user;
                }
                if integrity.is_some() {
                    device.integrity = integrity;
                }
                if client_version.is_some() {
                    device.client_version = client_version;
                }
                if pi_version.is_some() {
                    device.pi_version = pi_version;
                }
                device.last_seen = devices::unix_now();
                (
                    device.id.clone(),
                    device.name.clone(),
                    device.os.clone(),
                    device.user.clone(),
                    device.integrity.clone(),
                    device.client_version.clone(),
                    device.pi_version.clone(),
                    device.paired_at,
                    device.last_seen,
                    device.revoked,
                    device.custom_name.clone(),
                )
            };
            let online = inner.connections.contains_key(device_id);
            let session = inner.sessions.get(device_id);
            let view = DeviceView {
                id: base.0,
                name: base.1,
                custom_name: base.10,
                online,
                os: base.2,
                user: base.3,
                integrity: base.4,
                client_version: base.5,
                pi_version: base.6,
                paired_at: base.7,
                last_seen: base.8,
                revoked: base.9,
                session_state: session
                    .map(|s| s.state.clone())
                    .unwrap_or_else(|| "idle".into()),
                session_profile: session.map(|s| s.profile.clone()),
            };
            let snapshot = inner.devices.values().cloned().collect::<Vec<_>>();
            drop(inner);
            let _ = devices::save(&self.cfg.data_dir.join("devices.json"), &snapshot);
            view
        };
        let _ = self.events.send(GatewayEvent::DeviceUpdated { device: view });
    }

    pub async fn set_routes(&self, routes: Vec<RouteBinding>) {
        let mut inner = self.inner.write().await;
        inner.routes = routes
            .into_iter()
            .map(|binding| (binding.route.id.clone(), binding))
            .collect();
    }

    /// Client-facing route snapshot for [`crate::protocol::ClientMessage::RoutesRequest`].
    ///
    /// Routes are sorted by their numeric suffix so the answer is deterministic
    /// (the route map is a `HashMap`): local Power Mode writes the first route as
    /// Pi's default model, and a random order would make the default change on
    /// every launch. Engine ports never leave this process.
    pub async fn routes(&self) -> Vec<ModelRoute> {
        let inner = self.inner.read().await;
        let mut routes: Vec<ModelRoute> = inner
            .routes
            .values()
            .map(|binding| binding.route.clone())
            .collect();
        routes.sort_by(|a, b| route_order(&a.id, &b.id).then_with(|| a.model.cmp(&b.model)));
        routes
    }

    pub async fn start_session(
        &self,
        device_id: &str,
        profile: &str,
        cols: u16,
        rows: u16,
    ) -> Result<SessionOpen, String> {
        let (sender, session) = {
            let mut inner = self.inner.write().await;
            if !inner.devices.contains_key(device_id) {
                return Err("device not found".into());
            }
            let Some(connection) = inner.connections.get(device_id) else {
                return Err("device is offline".into());
            };
            let sender = connection.sender.clone();
            if let Some(existing) = inner.sessions.get(device_id) {
                if (existing.state == "starting" || existing.state == "running")
                    && !existing.stop_requested
                {
                    return Err("a session is already active on this device".into());
                }
            }
            if inner.routes.is_empty() {
                return Err("no running model routes available".into());
            }
            let routes: Vec<ModelRoute> = inner
                .routes
                .values()
                .map(|binding| binding.route.clone())
                .collect();
            let session = SessionOpen {
                profile: profile.to_string(),
                routes: routes.clone(),
                cols,
                rows,
            };
            let sequence = self.next_session_seq.fetch_add(1, Ordering::Relaxed);
            let log_path = self
                .cfg
                .data_dir
                .join("sessions")
                .join(device_id)
                .join(format!("{}-{sequence}.jsonl", devices::unix_now()));
            append_session_event(
                &log_path,
                serde_json::json!({
                    "kind": "start",
                    "at": unix_millis(),
                    "device": device_id,
                    "profile": profile,
                    "cols": cols,
                    "rows": rows,
                }),
            );
            inner.sessions.insert(
                device_id.to_string(),
                SessionRecord {
                    profile: profile.to_string(),
                    state: "starting".into(),
                    cols,
                    rows,
                    stop_requested: false,
                    log_path,
                },
            );
            (sender, session)
        };
        sender
            .send(ServerMessage::SessionOpen(session.clone()))
            .await
            .map_err(|_| "device connection is not writable".to_string())?;
        Ok(session)
    }

    pub async fn terminate_session(&self, device_id: &str) -> Result<TerminateResult, String> {
        let (sender, cancels) = {
            let mut inner = self.inner.write().await;
            let Some(session) = inner.sessions.get_mut(device_id) else {
                return Err("no session for this device".into());
            };
            session.stop_requested = true;
            // The client acknowledges with SessionExit; mark the session dead
            // now so CONFIG/REMOTE and the active-session count cannot show a
            // phantom RUNNING session if the client is offline or slow.
            session.state = "exited".into();
            append_session_event(
                &session.log_path,
                serde_json::json!({
                    "kind": "stop",
                    "at": unix_millis(),
                    "reason": "operator terminated the session",
                }),
            );
            let sender = inner.connections.get(device_id).map(|c| c.sender.clone());
            let cancels = inner
                .model_cancels
                .iter()
                .filter(|(_, (owner, _))| owner == device_id)
                .map(|(id, (_, token))| (id.clone(), token.clone()))
                .collect::<Vec<_>>();
            for (id, _) in &cancels {
                inner.model_cancels.remove(id);
            }
            (sender, cancels)
        };
        for (_, token) in cancels {
            token.cancel();
        }
        if let Some(sender) = sender {
            let sent = sender
                .send(ServerMessage::SessionStop {
                    reason: "operator terminated the session".into(),
                })
                .await
                .is_ok();
            Ok(TerminateResult {
                sent,
                pending: !sent,
            })
        } else {
            Ok(TerminateResult {
                sent: false,
                pending: true,
            })
        }
    }

    pub async fn send_pty_input(&self, device_id: &str, data: String) -> Result<(), String> {
        if data.len() > 2 * 1024 * 1024 {
            return Err("PTY input frame too large".into());
        }
        let (sender, log_path) = {
            let inner = self.inner.read().await;
            let sender = inner
                .connections
                .get(device_id)
                .map(|connection| connection.sender.clone());
            let log_path = inner
                .sessions
                .get(device_id)
                .map(|session| session.log_path.clone());
            (sender, log_path)
        };
        let Some(sender) = sender else {
            return Err("device is offline".into());
        };
        if let Some(path) = log_path {
            append_session_event(
                &path,
                serde_json::json!({
                    "kind": "in",
                    "at": unix_millis(),
                    "data": data.clone(),
                }),
            );
        }
        sender
            .send(ServerMessage::PtyInput { data })
            .await
            .map_err(|_| "device connection is not writable".to_string())
    }

    pub async fn resize_pty(&self, device_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if cols < 20 || rows < 5 {
            return Err("invalid PTY size".into());
        }
        let sender = {
            let inner = self.inner.read().await;
            inner
                .connections
                .get(device_id)
                .map(|connection| connection.sender.clone())
        };
        let Some(sender) = sender else {
            return Err("device is offline".into());
        };
        sender
            .send(ServerMessage::PtyResize { cols, rows })
            .await
            .map_err(|_| "device connection is not writable".to_string())
    }

    pub async fn session_ready(
        &self,
        device_id: &str,
        pid: Option<u32>,
        pi_version: Option<String>,
        integrity: Option<String>,
    ) {
        let view = {
            let mut inner = self.inner.write().await;
            if let Some(session) = inner.sessions.get_mut(device_id) {
                if !session.stop_requested
                    && (session.state == "starting" || session.state == "running")
                {
                    session.state = "running".into();
                }
                append_session_event(
                    &session.log_path,
                    serde_json::json!({
                        "kind": "ready",
                        "at": unix_millis(),
                        "pid": pid,
                        "piVersion": pi_version.clone(),
                        "integrity": integrity.clone(),
                    }),
                );
            }
            let base = inner.devices.get_mut(device_id).map(|device| {
                if pi_version.is_some() {
                    device.pi_version = pi_version.clone();
                }
                if integrity.is_some() {
                    device.integrity = integrity.clone();
                }
                (
                    device.id.clone(),
                    device.name.clone(),
                    device.os.clone(),
                    device.user.clone(),
                    device.integrity.clone(),
                    device.client_version.clone(),
                    device.pi_version.clone(),
                    device.paired_at,
                    device.last_seen,
                    device.revoked,
                    device.custom_name.clone(),
                )
            });
            base.map(|base| {
                let session = inner.sessions.get(device_id);
                DeviceView {
                    id: base.0,
                    name: base.1,
                    custom_name: base.10,
                    online: inner.connections.contains_key(device_id),
                    os: base.2,
                    user: base.3,
                    integrity: base.4,
                    client_version: base.5,
                    pi_version: base.6,
                    paired_at: base.7,
                    last_seen: base.8,
                    revoked: base.9,
                    session_state: session
                        .map(|s| s.state.clone())
                        .unwrap_or_else(|| "idle".into()),
                    session_profile: session.map(|s| s.profile.clone()),
                }
            })
        };
        if let Some(device) = view {
            let _ = self.events.send(GatewayEvent::DeviceUpdated { device });
        }
        let _ = self.events.send(GatewayEvent::SessionReady {
            device_id: device_id.to_string(),
            pid,
            pi_version,
            integrity,
        });
    }

    pub async fn session_data(&self, device_id: &str, data: String) {
        if data.len() > 4 * 1024 * 1024 {
            return;
        }
        let log_path = {
            let inner = self.inner.read().await;
            inner
                .sessions
                .get(device_id)
                .map(|session| session.log_path.clone())
        };
        if let Some(path) = log_path {
            append_session_event(
                &path,
                serde_json::json!({
                    "kind": "out",
                    "at": unix_millis(),
                    "data": data.clone(),
                }),
            );
        }
        let _ = self.events.send(GatewayEvent::SessionData {
            device_id: device_id.to_string(),
            data,
        });
    }

    pub async fn session_exit(&self, device_id: &str, code: Option<i32>) {
        {
            let mut inner = self.inner.write().await;
            if let Some(session) = inner.sessions.get_mut(device_id) {
                session.state = "exited".into();
                append_session_event(
                    &session.log_path,
                    serde_json::json!({
                        "kind": "exit",
                        "at": unix_millis(),
                        "code": code,
                    }),
                );
            }
            let cancels = inner
                .model_cancels
                .iter()
                .filter(|(_, (owner, _))| owner == device_id)
                .map(|(id, (_, token))| (id.clone(), token.clone()))
                .collect::<Vec<_>>();
            for (id, _) in &cancels {
                inner.model_cancels.remove(id);
            }
            for (_, token) in cancels {
                token.cancel();
            }
        }
        let _ = self.events.send(GatewayEvent::SessionExit {
            device_id: device_id.to_string(),
            code,
        });
    }

    pub async fn read_session_state(&self, device_id: &str) -> Option<String> {
        let inner = self.inner.read().await;
        inner.sessions.get(device_id).map(|s| s.state.clone())
    }

    pub async fn route(&self, route_id: &str) -> Option<RouteBinding> {
        let inner = self.inner.read().await;
        inner.routes.get(route_id).cloned()
    }

    pub async fn register_model_cancel(
        &self,
        device_id: &str,
        request_id: &str,
    ) -> CancellationToken {
        let token = CancellationToken::new();
        let mut inner = self.inner.write().await;
        inner.model_cancels.insert(
            request_id.to_string(),
            (device_id.to_string(), token.clone()),
        );
        token
    }

    pub async fn finish_model(&self, request_id: &str) {
        self.inner.write().await.model_cancels.remove(request_id);
    }

    pub async fn cancel_model(&self, request_id: &str) {
        let token = {
            let mut inner = self.inner.write().await;
            inner
                .model_cancels
                .remove(request_id)
                .map(|(_, token)| token)
        };
        if let Some(token) = token {
            token.cancel();
        }
    }

    pub fn shutdown(&self) {
        // Best-effort: the process is exiting; the OS will close the sockets.
        // This exists so a future app-exit path can explicitly drop sessions.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> (Arc<GatewayState>, PathBuf) {
        let data_dir = std::env::temp_dir().join(format!(
            "oym-gateway-state-test-{}",
            rand::random::<u64>()
        ));
        let state = GatewayState::load(GatewayConfig {
            bind: "127.0.0.1:0".parse().expect("static socket addr"),
            public_url: None,
            data_dir: data_dir.clone(),
            auto_session: false,
        })
        .expect("state");
        (state, data_dir)
    }

    fn binding(id: &str, model: &str) -> RouteBinding {
        RouteBinding {
            route: ModelRoute {
                id: id.into(),
                label: model.into(),
                model: model.into(),
                context_window: 32768,
                vision: false,
            },
            engine_port: 8080,
        }
    }

    #[test]
    fn remote_events_keep_the_ui_wire_contract() {
        let event = GatewayEvent::SessionData {
            device_id: "dev_1".into(),
            data: "aGVsbG8=".into(),
        };
        let json = serde_json::to_value(event).unwrap();
        assert_eq!(json["type"], "session_data");
        assert_eq!(json["deviceId"], "dev_1");

        let event = GatewayEvent::SessionReady {
            device_id: "dev_1".into(),
            pid: Some(42),
            pi_version: Some("1.4.0".into()),
            integrity: Some("Medium".into()),
        };
        let json = serde_json::to_value(event).unwrap();
        assert_eq!(json["type"], "session_ready");
        assert_eq!(json["deviceId"], "dev_1");
        assert_eq!(json["piVersion"], "1.4.0");
    }

    #[tokio::test]
    async fn routes_snapshot_is_ordered_and_session_free() {
        let (state, data_dir) = test_state();
        assert!(state.routes().await.is_empty());

        state
            .set_routes(vec![
                binding("route_10", "ENGINE_10"),
                binding("route_2", "ENGINE_2"),
                binding("route_1", "ENGINE_1"),
            ])
            .await;
        let routes = state.routes().await;
        assert_eq!(
            routes.iter().map(|route| route.id.as_str()).collect::<Vec<_>>(),
            vec!["route_1", "route_2", "route_10"]
        );
        assert_eq!(routes[0].label, "ENGINE_1");

        // Reading the route list is a pure state read: it must never create a
        // session record for any device.
        assert!(state.read_session_state("dev_missing").await.is_none());
        assert!(state.device_views().await.is_empty());

        let _ = std::fs::remove_dir_all(data_dir);
    }
}
