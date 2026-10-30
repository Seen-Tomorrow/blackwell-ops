//! Standalone gateway test for Local Power Mode's routes-only handshake.
//!
//! Runs the real `blackwell_remote` router on an ephemeral loopback port with a
//! temporary data dir and a fake OpenAI-compatible engine. No Blackwell OPS app,
//! no 7443 gateway, no Pi.
//!
//! These tests pin the three properties local mode depends on:
//!   1. `RoutesRequest` answers from `RemoteState` without creating a session.
//!   2. A routes-only connection can relay model calls (the `blackwell/*`
//!      provider) but is never accepted as an operator/PTY session.
//!   3. Connecting with the local-mode marker does not detach or replace an
//!      operator connection that uses the same device token.

use axum::http::header::AUTHORIZATION;
use axum::routing::post;
use axum::Router;
use base64::Engine as _;
use blackwell_remote::protocol::{ClientMessage, ModelRoute, PairRequest, ServerMessage};
use blackwell_remote::{gateway, RemoteConfig, RemoteState, RouteBinding};
use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

type TestSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct TestGateway {
    state: Arc<RemoteState>,
    addr: SocketAddr,
    token: String,
    device_id: String,
    data_dir: PathBuf,
    serve: tokio::task::JoinHandle<()>,
    engines: Vec<tokio::task::JoinHandle<()>>,
}

impl Drop for TestGateway {
    fn drop(&mut self) {
        self.serve.abort();
        for engine in &self.engines {
            engine.abort();
        }
        let _ = std::fs::remove_dir_all(&self.data_dir);
    }
}

fn route(id: &str, model: &str, engine_port: u16) -> RouteBinding {
    RouteBinding {
        route: ModelRoute {
            id: id.into(),
            label: model.into(),
            model: model.into(),
            context_window: 32768,
            vision: false,
        },
        engine_port,
    }
}

/// One fake engine: any chat completion answers `reply`. Mirrors the shape the
/// gateway streams back (a single JSON body, not SSE, is enough here).
async fn fake_engine_with_reply(reply: &'static str) -> (u16, tokio::task::JoinHandle<()>) {
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move || async move {
            axum::Json(serde_json::json!({
                "id": "chatcmpl-local-test",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "message": { "role": "assistant", "content": reply },
                    "finish_reason": "stop"
                }]
            }))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind fake engine");
    let port = listener.local_addr().expect("fake engine addr").port();
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (port, handle)
}

async fn fake_engine() -> (u16, tokio::task::JoinHandle<()>) {
    fake_engine_with_reply("pong").await
}

async fn start_gateway(routes: Vec<RouteBinding>) -> TestGateway {
    let data_dir = std::env::temp_dir().join(format!(
        "blackwell-routes-only-test-{}",
        rand::random::<u64>()
    ));
    let state = RemoteState::load(RemoteConfig {
        bind: "127.0.0.1:0".parse().expect("static socket addr"),
        public_url: None,
        data_dir: data_dir.clone(),
        auto_session: false,
    })
    .expect("remote state");
    state.set_routes(routes).await;

    let pairing = state.create_pairing().await;
    let pair = state
        .pair(PairRequest {
            code: pairing.code,
            device_name: Some("routes-test".into()),
            os: Some("Windows".into()),
            user: None,
            integrity: None,
            client_version: None,
            pi_version: None,
        })
        .await
        .expect("pair test device");

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind gateway");
    let addr = listener.local_addr().expect("gateway addr");
    let serve_state = state.clone();
    let serve = tokio::spawn(async move {
        let _ = axum::serve(listener, gateway::router(serve_state)).await;
    });

    TestGateway {
        state,
        addr,
        token: pair.token,
        device_id: pair.device_id,
        data_dir,
        serve,
        engines: Vec::new(),
    }
}

async fn connect(gateway: &TestGateway, query: &str) -> TestSocket {
    let url = format!("ws://{}/agent{query}", gateway.addr);
    let mut request = url.as_str().into_client_request().expect("ws request");
    request.headers_mut().insert(
        AUTHORIZATION,
        format!("Bearer {}", gateway.token)
            .parse()
            .expect("authorization header"),
    );
    let (socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .expect("connect to test gateway");
    socket
}

async fn send(socket: &mut TestSocket, message: ClientMessage) {
    let text = serde_json::to_string(&message).expect("serialize");
    socket
        .send(Message::Text(text.into()))
        .await
        .expect("send frame");
}

async fn recv(socket: &mut TestSocket) -> ServerMessage {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("timed out waiting for a gateway frame")
            .expect("gateway closed the socket")
            .expect("websocket frame");
        if let Message::Text(text) = message {
            return serde_json::from_str(&text).expect("parse gateway frame");
        }
    }
}

#[tokio::test]
async fn routes_request_returns_routes_without_a_session() {
    let mut gateway = start_gateway(vec![route("route_1", "ENGINE_1", 8888)]).await;
    let engine = fake_engine().await;
    gateway.engines.push(engine.1);

    let mut socket = connect(&gateway, "?role=routes").await;
    match recv(&mut socket).await {
        ServerMessage::Ready { session, .. } => {
            assert!(session.is_none(), "routes-only handshake opened a session");
        }
        other => panic!("expected ready, got {other:?}"),
    }

    send(&mut socket, ClientMessage::RoutesRequest).await;
    match recv(&mut socket).await {
        ServerMessage::Routes { routes } => {
            assert_eq!(routes.len(), 1);
            assert_eq!(routes[0].id, "route_1");
            assert_eq!(routes[0].model, "ENGINE_1");
            assert_eq!(routes[0].context_window, 32768);
            assert!(!routes[0].vision);
        }
        other => panic!("expected routes, got {other:?}"),
    }

    // The same socket can relay a model call — that is the `blackwell/*`
    // provider — and the answer is the engine's body.
    send(
        &mut socket,
        ClientMessage::ModelRequest {
            id: "model_req_1".into(),
            route_id: "route_1".into(),
            body: serde_json::json!({
                "model": "ENGINE_1",
                "messages": [{ "role": "user", "content": "ping" }]
            }),
        },
    )
    .await;

    let mut body = Vec::new();
    let mut saw_head = false;
    loop {
        match recv(&mut socket).await {
            ServerMessage::ModelHead { id, status, .. } => {
                assert_eq!(id, "model_req_1");
                assert_eq!(status, 200);
                saw_head = true;
            }
            ServerMessage::ModelChunk { id, data } => {
                assert_eq!(id, "model_req_1");
                body.extend(
                    base64::engine::general_purpose::STANDARD
                        .decode(data)
                        .expect("base64 chunk"),
                );
            }
            ServerMessage::ModelEnd { id, error } => {
                assert_eq!(id, "model_req_1");
                assert!(error.is_none(), "model request failed: {error:?}");
                break;
            }
            other => panic!("unexpected frame during model request: {other:?}"),
        }
    }
    assert!(saw_head, "no model head frame");
    let body = String::from_utf8(body).expect("utf8 model body");
    assert!(body.contains("pong"), "unexpected model body: {body}");

    // PTY/session frames are refused on a routes-only connection.
    send(
        &mut socket,
        ClientMessage::PtyData {
            data: "aGVsbG8=".into(),
        },
    )
    .await;
    match recv(&mut socket).await {
        ServerMessage::Error { message } => assert!(
            message.contains("routes-only"),
            "unexpected error text: {message}"
        ),
        other => panic!("expected routes-only error, got {other:?}"),
    }

    // Nothing was recorded as a session, on any device.
    assert_eq!(gateway.state.read_session_state(&gateway.device_id).await, None);
    let views = gateway.state.device_views().await;
    assert_eq!(views.len(), 1);
    assert_eq!(views[0].session_state, "idle");
    assert!(!views[0].online, "routes-only socket must not mark the device online");
}

#[tokio::test]
async fn local_mode_does_not_replace_an_operator_connection() {
    let gateway = start_gateway(vec![route("route_1", "ENGINE_1", 8888)]).await;

    let mut operator = connect(&gateway, "").await;
    match recv(&mut operator).await {
        ServerMessage::Ready { session, .. } => assert!(session.is_none()),
        other => panic!("expected ready, got {other:?}"),
    }
    send(&mut operator, ClientMessage::Ping).await;
    assert!(matches!(recv(&mut operator).await, ServerMessage::Pong));

    let mut local = connect(&gateway, "?role=routes").await;
    assert!(matches!(recv(&mut local).await, ServerMessage::Ready { .. }));
    send(&mut local, ClientMessage::RoutesRequest).await;
    assert!(matches!(
        recv(&mut local).await,
        ServerMessage::Routes { .. }
    ));

    // The operator's socket must still be attached and writable.
    send(&mut operator, ClientMessage::Ping).await;
    assert!(matches!(recv(&mut operator).await, ServerMessage::Pong));
    let views = gateway.state.device_views().await;
    assert_eq!(views.len(), 1);
    assert!(views[0].online, "operator connection was detached");
}

#[tokio::test]
async fn empty_route_table_returns_an_empty_list() {
    let gateway = start_gateway(Vec::new()).await;
    let mut socket = connect(&gateway, "?role=routes").await;
    assert!(matches!(recv(&mut socket).await, ServerMessage::Ready { .. }));
    send(&mut socket, ClientMessage::RoutesRequest).await;
    match recv(&mut socket).await {
        ServerMessage::Routes { routes } => assert!(routes.is_empty()),
        other => panic!("expected empty routes, got {other:?}"),
    }
}

/// Local Power Mode writes one provider model per route, and Pi selects a route
/// by model name. Two running engines must therefore stay two distinct engines:
/// a request for one route must never be answered by the other.
#[tokio::test]
async fn each_route_reaches_its_own_engine() {
    let (port_one, engine_one) = fake_engine_with_reply("pong-one").await;
    let (port_two, engine_two) = fake_engine_with_reply("pong-two").await;
    let mut gateway = start_gateway(vec![
        route("route_1", "ENGINE_ONE", port_one),
        route("route_2", "ENGINE_TWO", port_two),
    ])
    .await;
    gateway.engines.push(engine_one);
    gateway.engines.push(engine_two);

    let mut socket = connect(&gateway, "?role=routes").await;
    assert!(matches!(recv(&mut socket).await, ServerMessage::Ready { .. }));
    send(&mut socket, ClientMessage::RoutesRequest).await;
    match recv(&mut socket).await {
        ServerMessage::Routes { routes } => {
            assert_eq!(routes.len(), 2);
            assert_eq!(routes[0].id, "route_1");
            assert_eq!(routes[0].model, "ENGINE_ONE");
            assert_eq!(routes[1].id, "route_2");
            assert_eq!(routes[1].model, "ENGINE_TWO");
        }
        other => panic!("expected routes, got {other:?}"),
    }

    for (route_id, model, expected) in [
        ("route_2", "ENGINE_TWO", "pong-two"),
        ("route_1", "ENGINE_ONE", "pong-one"),
    ] {
        let request_id = format!("model_{route_id}");
        send(
            &mut socket,
            ClientMessage::ModelRequest {
                id: request_id.clone(),
                route_id: route_id.into(),
                body: serde_json::json!({
                    "model": model,
                    "messages": [{ "role": "user", "content": "ping" }]
                }),
            },
        )
        .await;

        let mut body = Vec::new();
        loop {
            match recv(&mut socket).await {
                ServerMessage::ModelHead { id, status, .. } => {
                    assert_eq!(id, request_id);
                    assert_eq!(status, 200);
                }
                ServerMessage::ModelChunk { id, data } => {
                    assert_eq!(id, request_id);
                    body.extend(
                        base64::engine::general_purpose::STANDARD
                            .decode(data)
                            .expect("base64 chunk"),
                    );
                }
                ServerMessage::ModelEnd { id, error } => {
                    assert_eq!(id, request_id);
                    assert!(error.is_none(), "model request failed: {error:?}");
                    break;
                }
                other => panic!("unexpected frame during model request: {other:?}"),
            }
        }
        let body = String::from_utf8(body).expect("utf8 model body");
        assert!(
            body.contains(expected),
            "route {route_id} was answered by the wrong engine: {body}"
        );
    }
}
