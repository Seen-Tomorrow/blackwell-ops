//! Axum HTTP/WebSocket surface.
//!
//! Public routes (intended to sit behind Cloudflare Tunnel):
//!   GET  /healthz, /health
//!   POST /pair
//!   GET  /agent   (WebSocket, bearer device token)
//!   GET  /agent?role=routes
//!       Routes-only WebSocket for local Power Mode: it can list routes and
//!       relay model calls, but it never attaches an operator connection, owns
//!       no PTY, and creates no session record.
//!
//! Nothing else is exposed. Engine ports, Tauri IPC and engine management stay
//! on loopback.

use crate::protocol::{
    ClientMessage, HealthResponse, PairRequest, PairResponse, ServerMessage, MAX_WS_MESSAGE_BYTES,
    PROTOCOL_VERSION,
};
use crate::state::{RemoteState, RouteBinding, SERVER_VERSION};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub fn router(state: Arc<RemoteState>) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/health", get(health))
        .route("/pair", post(pair))
        .route("/agent", get(agent))
        .with_state(state)
}

/// True when the query string carries `role=routes`.
///
/// Local Power Mode connects with this marker so it cannot replace, and thereby
/// terminate, an operator-configured remote session that uses the same device
/// token. Everything else about the socket is unchanged.
fn routes_only_connection(query: Option<&str>) -> bool {
    query
        .unwrap_or_default()
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .any(|(key, value)| key == "role" && value == "routes")
}

async fn health(State(state): State<Arc<RemoteState>>) -> Json<HealthResponse> {
    Json(state.health_payload().await)
}

async fn pair(
    State(state): State<Arc<RemoteState>>,
    Json(request): Json<PairRequest>,
) -> Result<Json<PairResponse>, (StatusCode, Json<Value>)> {
    state
        .pair(request)
        .await
        .map(Json)
        .map_err(|message| (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))))
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(AUTHORIZATION)?.to_str().ok()?.trim();
    let token = value.strip_prefix("Bearer ").or_else(|| value.strip_prefix("bearer "))?;
    let token = token.trim();
    (!token.is_empty()).then(|| token.to_string())
}

async fn agent(
    State(state): State<Arc<RemoteState>>,
    headers: HeaderMap,
    uri: Uri,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(token) = bearer_token(&headers) else {
        return (StatusCode::UNAUTHORIZED, "missing bearer token").into_response();
    };
    let Some(device) = state.authenticate(&token).await else {
        return (StatusCode::UNAUTHORIZED, "invalid or revoked device token").into_response();
    };
    let routes_only = routes_only_connection(uri.query());

    ws.max_message_size(MAX_WS_MESSAGE_BYTES)
        .on_upgrade(move |socket| handle_socket(state, device, socket, routes_only))
}

async fn handle_socket(
    state: Arc<RemoteState>,
    device: crate::devices::DeviceRecord,
    socket: WebSocket,
    routes_only: bool,
) {
    let (mut socket_tx, mut socket_rx) = socket.split();
    let (tx, mut rx) = mpsc::channel::<ServerMessage>(128);
    let shutdown = CancellationToken::new();

    // A routes-only socket is deliberately not registered as the device's
    // connection: attaching would replace (and shut down) a live operator
    // client using the same token. It can still ask for routes and relay model
    // calls, which is all local Power Mode needs.
    let connection_id = if routes_only {
        None
    } else {
        match state
            .attach_connection(&device.id, tx.clone(), shutdown.clone())
            .await
        {
            Ok((connection_id, attach)) => {
                log::info!("[remote] device {} connected", device.id);
                let _ = tx
                    .send(ServerMessage::Ready {
                        protocol_version: PROTOCOL_VERSION,
                        server_version: SERVER_VERSION.to_string(),
                        public_url: state.cfg.public_url.clone(),
                        session: attach.session,
                    })
                    .await;
                if attach.stop_requested {
                    let _ = tx
                        .send(ServerMessage::SessionStop {
                            reason: "operator terminated the previous session".into(),
                        })
                        .await;
                }
                Some(connection_id)
            }
            Err(error) => {
                let _ = tx.send(ServerMessage::Error { message: error }).await;
                return;
            }
        }
    };

    if routes_only {
        log::info!("[remote] device {} connected (routes-only)", device.id);
        let _ = tx
            .send(ServerMessage::Ready {
                protocol_version: PROTOCOL_VERSION,
                server_version: SERVER_VERSION.to_string(),
                public_url: state.cfg.public_url.clone(),
                session: None,
            })
            .await;
    }

    if state.cfg.auto_session && !routes_only {
        let auto_state = state.clone();
        let auto_device = device.id.clone();
        tokio::spawn(async move {
            if let Err(error) = auto_state
                .start_session(&auto_device, "pi-maintenance", 120, 32)
                .await
            {
                eprintln!("[remote] auto session: {error}");
            }
        });
    }

    let writer_shutdown = shutdown.clone();
    let writer_device = device.id.clone();
    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = writer_shutdown.cancelled() => break,
                msg = rx.recv() => {
                    let Some(msg) = msg else { break };
                    let Ok(text) = serde_json::to_string(&msg) else {
                        log::warn!("[remote] serialize failed for {writer_device}");
                        break
                    };
                    if socket_tx.send(Message::Text(text.into())).await.is_err() {
                        log::warn!("[remote] writer closed for {writer_device}");
                        break;
                    }
                }
            }
        }
    });

    loop {
        let message = tokio::select! {
            _ = shutdown.cancelled() => break,
            message = socket_rx.next() => message,
        };
        let Some(Ok(message)) = message else {
            break;
        };
        let text = match message {
            Message::Text(text) => text.to_string(),
            Message::Binary(bytes) => match String::from_utf8(bytes.to_vec()) {
                Ok(text) => text,
                Err(_) => {
                    let _ = tx
                        .send(ServerMessage::Error {
                            message: "binary frames are not part of this protocol".into(),
                        })
                        .await;
                    continue;
                }
            },
            Message::Ping(_) => {
                let _ = tx.send(ServerMessage::Pong).await;
                continue;
            }
            Message::Pong(_) => continue,
            Message::Close(_) => break,
        };

        let message = match serde_json::from_str::<ClientMessage>(&text) {
            Ok(message) => message,
            Err(error) => {
                let _ = tx
                    .send(ServerMessage::Error {
                        message: format!("invalid client message: {error}"),
                    })
                    .await;
                continue;
            }
        };

        match message {
            ClientMessage::Hello { .. } => {
                state.on_hello(&device.id, message).await;
            }
            ClientMessage::SessionReady {
                pid,
                pi_version,
                integrity,
            } => {
                if routes_only {
                    let _ = tx
                        .send(ServerMessage::Error {
                            message: "routes-only connection cannot report a session".into(),
                        })
                        .await;
                    continue;
                }
                log::info!("[remote] session ready device={} pid={pid:?}", device.id);
                state
                    .session_ready(&device.id, pid, pi_version, integrity)
                    .await;
            }
            ClientMessage::PtyData { data } => {
                if routes_only {
                    let _ = tx
                        .send(ServerMessage::Error {
                            message: "routes-only connection does not accept PTY data".into(),
                        })
                        .await;
                    continue;
                }
                state.session_data(&device.id, data).await;
            }
            ClientMessage::SessionExit { code } => {
                if routes_only {
                    let _ = tx
                        .send(ServerMessage::Error {
                            message: "routes-only connection cannot report a session exit".into(),
                        })
                        .await;
                    continue;
                }
                log::info!("[remote] session exit device={} code={code:?}", device.id);
                state.session_exit(&device.id, code).await;
            }
            ClientMessage::ModelRequest {
                id,
                route_id,
                body,
            } => {
                let Some(binding) = state.route(&route_id).await else {
                    let _ = tx
                        .send(ServerMessage::ModelEnd {
                            id,
                            error: Some("unknown model route".into()),
                        })
                        .await;
                    continue;
                };
                let task_state = state.clone();
                let task_tx = tx.clone();
                let device_id = device.id.clone();
                tokio::spawn(async move {
                    run_model(task_state, task_tx, device_id, id, binding, body).await;
                });
            }
            ClientMessage::ModelCancel { id } => {
                state.cancel_model(&id).await;
            }
            ClientMessage::RoutesRequest => {
                let routes = state.routes().await;
                let _ = tx.send(ServerMessage::Routes { routes }).await;
            }
            ClientMessage::Ping => {
                let _ = tx.send(ServerMessage::Pong).await;
            }
        }
    }

    log::info!(
        "[remote] device {} {} closed",
        device.id,
        if routes_only {
            "routes-only socket"
        } else {
            "socket"
        }
    );
    shutdown.cancel();
    if let Some(connection_id) = connection_id {
        state.detach_connection(&device.id, connection_id).await;
    }
    writer.abort();
}

async fn run_model(
    state: Arc<RemoteState>,
    tx: mpsc::Sender<ServerMessage>,
    device_id: String,
    request_id: String,
    binding: RouteBinding,
    mut body: Value,
) {
    let cancel = state
        .register_model_cancel(&device_id, &request_id)
        .await;

    let Some(object) = body.as_object_mut() else {
        let _ = tx
            .send(ServerMessage::ModelEnd {
                id: request_id.clone(),
                error: Some("model request body must be a JSON object".into()),
            })
            .await;
        state.finish_model(&request_id).await;
        return;
    };
    if object.get("model").is_none() {
        object.insert("model".into(), Value::String(binding.route.model.clone()));
    }
    if let Some(model) = object.get("model").and_then(Value::as_str) {
        if model != binding.route.model {
            let _ = tx
                .send(ServerMessage::ModelEnd {
                    id: request_id.clone(),
                    error: Some(format!(
                        "model '{}' is not available on this route",
                        model
                    )),
                })
                .await;
            state.finish_model(&request_id).await;
            return;
        }
    }

    let url = format!(
        "http://127.0.0.1:{}/v1/chat/completions",
        binding.engine_port
    );
    let request = state
        .http_client()
        .post(url)
        .header(CONTENT_TYPE, "application/json")
        .body(body.to_string());

    let response = tokio::select! {
        _ = cancel.cancelled() => {
            let _ = tx.send(ServerMessage::ModelEnd {
                id: request_id.clone(),
                error: Some("cancelled".into()),
            }).await;
            state.finish_model(&request_id).await;
            return;
        }
        response = request.send() => response,
    };

    let response = match response {
        Ok(response) => response,
        Err(error) => {
            let _ = tx
                .send(ServerMessage::ModelEnd {
                    id: request_id.clone(),
                    error: Some(format!("engine request failed: {error}")),
                })
                .await;
            state.finish_model(&request_id).await;
            return;
        }
    };

    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    if tx
        .send(ServerMessage::ModelHead {
            id: request_id.clone(),
            status,
            content_type,
        })
        .await
        .is_err()
    {
        state.finish_model(&request_id).await;
        return;
    }

    let mut stream = response.bytes_stream();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                let _ = tx.send(ServerMessage::ModelEnd {
                    id: request_id.clone(),
                    error: Some("cancelled".into()),
                }).await;
                break;
            }
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
                        if tx.send(ServerMessage::ModelChunk {
                            id: request_id.clone(),
                            data,
                        }).await.is_err() {
                            break;
                        }
                    }
                    Some(Err(error)) => {
                        let _ = tx.send(ServerMessage::ModelEnd {
                            id: request_id.clone(),
                            error: Some(format!("engine stream failed: {error}")),
                        }).await;
                        break;
                    }
                    None => {
                        let _ = tx.send(ServerMessage::ModelEnd {
                            id: request_id.clone(),
                            error: None,
                        }).await;
                        break;
                    }
                }
            }
        }
    }

    state.finish_model(&request_id).await;
}

#[cfg(test)]
mod tests {
    use super::routes_only_connection;

    #[test]
    fn routes_only_marker_is_exact() {
        assert!(routes_only_connection(Some("role=routes")));
        assert!(routes_only_connection(Some("x=1&role=routes")));
        assert!(!routes_only_connection(None));
        assert!(!routes_only_connection(Some("")));
        // Must not mistake an operator connection for a routes-only one.
        assert!(!routes_only_connection(Some("role=operator")));
        assert!(!routes_only_connection(Some("role=routes-extra")));
        assert!(!routes_only_connection(Some("role")));
    }
}
