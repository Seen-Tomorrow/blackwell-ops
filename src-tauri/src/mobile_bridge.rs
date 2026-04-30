//! Mobile Sentinel Bridge — WebSocket server broadcasting Blackwell metrics to mobile clients.
//!
//! Architecture:
//!   ┌─────────────────────────────────────────────────────────────┐
//!   │                  MobileBridge (Tauri State)                 │
//!   │  ┌──────────────────┐    ┌──────────────────────────────┐   │
//!   │  │ WebSocket Server │───▶│ Broadcast Hub                │   │
//!   │  │ (0.0.0.0:3814)   │    │ broadcast::Sender            │   │
//!   │  └──────────────────┘    │                              │   │
//!   │                          │ PushTelemetry → broadcast    │   │
//!   │                          │ Heartbeat loop (30s ping)    │   │
//!   │                          └──────────────────────────────┘   │
//!   └─────────────────────────────────────────────────────────────┘

use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::{Mutex, broadcast};

// ── Sentinel Protocol Message Types ────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SentinelTelemetry {
    pub timestamp: u64,
    pub tps: f32,
    pub gpu_temp: Vec<f32>,
    pub vram_used_mib: Vec<f64>,
    pub vram_total_mib: Vec<f64>,
    pub model_name: String,
    pub engine_status: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SentinelHeartbeat {
    pub timestamp: u64,
    pub status: String,
    pub uptime_seconds: f64,
    pub connected_clients: usize,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SentinelMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub payload: serde_json::Value,
}

// ── Internal State ─────────────────────────────────────────────────────

struct InnerState {
    running: bool,
    bind_addr: SocketAddr,
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
    broadcast_tx: broadcast::Sender<SentinelMessage>,
}

// ── MobileBridge Singleton ─────────────────────────────────────────────

pub struct MobileBridge {
    inner: Arc<Mutex<InnerState>>,
    bind_addr: SocketAddr,
    start_time: std::time::Instant,
}

impl Clone for MobileBridge {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            bind_addr: self.bind_addr,
            start_time: self.start_time,
        }
    }
}

impl MobileBridge {
    pub fn new(bind_port: u16) -> Self {
        let bind_addr: SocketAddr = format!("0.0.0.0:{bind_port}").parse().unwrap();
        let (broadcast_tx, _) = broadcast::channel::<SentinelMessage>(256);

        Self {
            inner: Arc::new(Mutex::new(InnerState {
                running: false,
                bind_addr,
                shutdown_tx: None,
                broadcast_tx: broadcast_tx.clone(),
            })),
            bind_addr,
            start_time: std::time::Instant::now(),
        }
    }

    pub async fn start(&self) -> Result<(), String> {
        let mut state = self.inner.lock().await;

        if state.running {
            log::info!("MobileBridge: already running on {}", state.bind_addr);
            return Ok(());
        }

        let bind_addr = state.bind_addr;
        let broadcast_tx = state.broadcast_tx.clone();

        // Create shutdown channel — sending to it aborts the server loop.
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        state.shutdown_tx = Some(shutdown_tx);

        // Spawn on Tauri's runtime.
        tauri::async_runtime::spawn(ws_server_loop(bind_addr, broadcast_tx, shutdown_rx));

        state.running = true;

        log::info!("MobileBridge: WebSocket server started on {}", bind_addr);
        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        let mut state = self.inner.lock().await;

        if !state.running {
            return Err("MobileBridge is not running".to_string());
        }

        // Broadcast a shutdown message to all clients.
        let _ = state.broadcast_tx.send(SentinelMessage {
            msg_type: "shutdown".into(),
            payload: serde_json::json!({ "reason": "server_stopping" }),
        });

        // Signal the server loop to stop via oneshot channel.
        if let Some(tx) = state.shutdown_tx.take() {
            let _ = tx.send(());
        }

        state.running = false;
        log::info!("MobileBridge: WebSocket server stopped");
        Ok(())
    }

    pub async fn is_running(&self) -> bool {
        self.inner.lock().await.running
    }

    /// Push telemetry data to all connected Sentinel clients.
    pub async fn push_telemetry(&self, tps: f32, gpu_temps: Vec<f32>, vram_used: Vec<f64>, vram_total: Vec<f64>, model_name: String, engine_status: String) {
        let state = self.inner.lock().await;

        if !state.running {
            return;
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let telemetry = SentinelTelemetry {
            timestamp: now,
            tps,
            gpu_temp: gpu_temps,
            vram_used_mib: vram_used,
            vram_total_mib: vram_total,
            model_name,
            engine_status,
        };

        let _ = state.broadcast_tx.send(SentinelMessage {
            msg_type: "telemetry".into(),
            payload: serde_json::to_value(telemetry).unwrap_or_default(),
        });
    }

    /// Send a heartbeat to all connected clients.
    pub async fn send_heartbeat(&self, status: &str) -> Result<(), String> {
        let state = self.inner.lock().await;

        if !state.running {
            return Err("MobileBridge is not running".to_string());
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let uptime = self.start_time.elapsed().as_secs_f64();

        let heartbeat = SentinelHeartbeat {
            timestamp: now,
            status: status.to_string(),
            uptime_seconds: uptime,
            connected_clients: 0,
        };

        let _ = state.broadcast_tx.send(SentinelMessage {
            msg_type: "heartbeat".into(),
            payload: serde_json::to_value(heartbeat).unwrap_or_default(),
        });

        Ok(())
    }

    /// Get the bind address for this bridge.
    pub fn bind_addr(&self) -> SocketAddr {
        self.bind_addr
    }
}

// ── WebSocket Server Loop ──────────────────────────────────────────────

async fn ws_server_loop(
    bind_addr: SocketAddr,
    broadcast_tx: broadcast::Sender<SentinelMessage>,
    mut shutdown_rx: tokio::sync::oneshot::Receiver<()>,
) {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let listener = match tokio::net::TcpListener::bind(bind_addr).await {
        Ok(l) => l,
        Err(e) => {
            log::error!("MobileBridge: failed to bind WebSocket server to {}: {}", bind_addr, e);
            return;
        }
    };

    log::info!("MobileBridge: listening on {} for Sentinel clients", bind_addr);

    // Atomic counter for tracking active connections.
    let connection_count = Arc::new(std::sync::Arc::new(tokio::sync::Mutex::new(0usize)));

    loop {
        let accepted = tokio::select! {
            result = listener.accept() => match result {
                Ok(v) => v,
                Err(e) => {
                    log::error!("MobileBridge: accept error: {}", e);
                    continue;
                }
            },
            _ = &mut shutdown_rx => {
                log::info!("MobileBridge: server loop shutting down");
                return;
            }
        };

        let (stream, peer_addr) = accepted;
        log::info!("MobileBridge: TCP connection from {} — upgrading to WebSocket", peer_addr);

        let mut rx = broadcast_tx.subscribe();
        let conn_count = connection_count.clone();

        // Increment connection count.
        {
            let mut count = conn_count.lock().await;
            *count += 1;
        }

        tokio::spawn(async move {
            let (mut write, mut read) = match tokio_tungstenite::accept_async(stream).await {
                Ok(ws) => ws.split(),
                Err(e) => {
                    log::warn!("MobileBridge: WebSocket upgrade failed for {}: {}", peer_addr, e);
                    return;
                }
            };

            // Send welcome message.
            let welcome = SentinelMessage {
                msg_type: "welcome".into(),
                payload: serde_json::json!({
                    "message": "Blackwell Ops Mobile Sentinel Bridge",
                    "version": "0.1.0",
                    "protocol": "sentinel-v1"
                }),
            };
            if let Ok(json) = serde_json::to_string(&welcome) {
                let _ = write.send(Message::Text(json.into())).await;
            }

            // Heartbeat loop — ping every 30s.
            let heartbeat_interval = tokio::time::interval(tokio::time::Duration::from_secs(30));
            tokio::pin!(heartbeat_interval);

            loop {
                tokio::select! {
                    _ = heartbeat_interval.tick() => {
                        if let Err(e) = write.send(Message::Ping(Default::default())).await {
                            log::warn!("MobileBridge: ping failed for {}: {}", peer_addr, e);
                            break;
                        }
                    }

                    // Receive broadcast messages.
                    result = rx.recv() => {
                        match result {
                            Ok(msg) => {
                                if let Ok(json) = serde_json::to_string(&msg) {
                                    if let Err(e) = write.send(Message::Text(json.into())).await {
                                        log::warn!("MobileBridge: broadcast send failed for {}: {}", peer_addr, e);
                                        break;
                                    }
                                }
                            }
                            Err(broadcast::error::RecvError::Lagged(n)) => {
                                log::debug!("MobileBridge: client {} lagged by {} messages", peer_addr, n);
                            }
                            Err(_) => {
                                break;
                            }
                        }
                    }

                    // Handle incoming messages from client.
                    msg = read.next() => {
                        match msg {
                            Some(Ok(Message::Text(text))) => {
                                log::debug!("MobileBridge: received from {}: {}", peer_addr, text);
                                if let Ok(sentinel_msg) = serde_json::from_str::<SentinelMessage>(&text) {
                                    match sentinel_msg.msg_type.as_str() {
                                        "ping" => {
                                            let pong = SentinelMessage {
                                                msg_type: "pong".into(),
                                                payload: serde_json::json!({ "timestamp": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() }),
                                            };
                                            if let Ok(json) = serde_json::to_string(&pong) {
                                                let _ = write.send(Message::Text(json.into())).await;
                                            }
                                        }
                                        "command" => {
                                            log::info!("MobileBridge: command from {}: {:?}", peer_addr, sentinel_msg.payload);
                                        }
                                        _ => {}
                                    }
                                }
                            }
                            Some(Ok(Message::Close(_))) | None => {
                                log::info!("MobileBridge: client {} disconnected", peer_addr);
                                break;
                            }
                            Some(Err(e)) => {
                                log::warn!("MobileBridge: WebSocket error for {}: {}", peer_addr, e);
                                break;
                            }
                            _ => {}
                        }
                    }
                }
            }

            // Decrement connection count on disconnect.
            let mut count = conn_count.lock().await;
            if *count > 0 { *count -= 1; }
        });
    }
}

// ── Tauri Commands ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn cmd_mobile_bridge_start(manager: tauri::State<'_, MobileBridge>) -> Result<serde_json::Value, String> {
    manager.start().await?;
    Ok(serde_json::json!({
        "status": "started",
        "bind_addr": format!("{}", manager.bind_addr()),
    }))
}

#[tauri::command]
pub async fn cmd_mobile_bridge_stop(manager: tauri::State<'_, MobileBridge>) -> Result<serde_json::Value, String> {
    manager.stop().await?;
    Ok(serde_json::json!({ "status": "stopped" }))
}

#[tauri::command]
pub async fn cmd_mobile_bridge_status(manager: tauri::State<'_, MobileBridge>) -> Result<serde_json::Value, String> {
    let running = manager.is_running().await;
    Ok(serde_json::json!({
        "running": running,
        "bind_addr": format!("{}", manager.bind_addr()),
    }))
}

#[tauri::command]
pub async fn cmd_mobile_bridge_push_telemetry(
    manager: tauri::State<'_, MobileBridge>,
    tps: f32,
    gpu_temps: Vec<f32>,
    vram_used: Vec<f64>,
    vram_total: Vec<f64>,
    model_name: String,
    engine_status: String,
) -> Result<(), String> {
    manager.push_telemetry(tps, gpu_temps, vram_used, vram_total, model_name, engine_status).await;
    Ok(())
}

#[tauri::command]
pub async fn cmd_mobile_bridge_send_heartbeat(
    manager: tauri::State<'_, MobileBridge>,
    status: String,
) -> Result<serde_json::Value, String> {
    manager.send_heartbeat(&status).await?;
    Ok(serde_json::json!({ "status": "sent" }))
}
