//! One-shot gateway status probe for the tray app.
//!
//! It connects with the routes-only role, so a status check can never displace a
//! live operator session that uses the same device token.

use futures_util::{SinkExt, StreamExt};
use oym_gateway::protocol::{ClientMessage, ModelRoute, ServerMessage};
use std::time::Duration;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

#[derive(Clone, Debug, Default)]
pub struct Probe {
    pub server_version: String,
    pub public_url: Option<String>,
    pub session: bool,
    pub routes: Vec<ModelRoute>,
}

/// `wss://host/link` (or ws/http) with the routes-only marker.
pub fn status_url(server: &str) -> Result<Url, String> {
    let mut url = Url::parse(server).map_err(|error| format!("server URL: {error}"))?;
    match url.scheme() {
        "wss" | "https" => {
            url.set_scheme("wss").ok();
        }
        "ws" | "http" => {
            url.set_scheme("ws").ok();
        }
        other => return Err(format!("unsupported server scheme: {other}")),
    }
    url.set_path("/link");
    url.set_query(None);
    url.set_fragment(None);
    url.query_pairs_mut().append_pair("role", "routes");
    Ok(url)
}

#[allow(clippy::too_many_arguments)]
pub async fn probe(
    server: &str,
    token: &str,
    device_name: &str,
    client_version: &str,
    pi_version: &str,
    integrity: &str,
) -> Result<Probe, String> {
    let url = status_url(server)?;
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|error| format!("status request: {error}"))?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|error| format!("authorization header: {error}"))?,
    );

    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(6),
        tokio_tungstenite::connect_async(request),
    )
    .await
    .map_err(|_| "gateway did not answer within 6s".to_string())?
    .map_err(|error| format!("connect gateway: {error}"))?;

    let hello = ClientMessage::Hello {
        device_name: Some(device_name.to_string()),
        os: Some("Windows".into()),
        user: std::env::var("USERNAME").ok(),
        integrity: Some(integrity.to_string()),
        client_version: Some(client_version.to_string()),
        pi_version: Some(pi_version.to_string()),
    };
    let hello = serde_json::to_string(&hello).map_err(|error| error.to_string())?;
    socket
        .send(Message::Text(hello.into()))
        .await
        .map_err(|error| format!("send hello: {error}"))?;

    let mut probe = Probe::default();
    let mut asked_routes = false;
    loop {
        let message = tokio::time::timeout(Duration::from_secs(6), socket.next())
            .await
            .map_err(|_| "gateway status timed out".to_string())?
            .ok_or_else(|| "gateway closed the status link".to_string())?
            .map_err(|error| format!("gateway status: {error}"))?;
        match message {
            Message::Text(text) => {
                let text: String = text.to_string();
                let message: ServerMessage = serde_json::from_str(&text)
                    .map_err(|error| format!("invalid gateway frame: {error}"))?;
                match message {
                    ServerMessage::Ready {
                        server_version,
                        public_url,
                        session,
                        ..
                    } => {
                        probe.server_version = server_version;
                        probe.public_url = public_url;
                        probe.session = session.is_some();
                        if !asked_routes {
                            asked_routes = true;
                            let request = serde_json::to_string(&ClientMessage::RoutesRequest)
                                .map_err(|error| error.to_string())?;
                            socket
                                .send(Message::Text(request.into()))
                                .await
                                .map_err(|error| format!("send routes request: {error}"))?;
                        }
                    }
                    ServerMessage::Routes { routes } => {
                        probe.routes = routes;
                        let _ = socket.close(None).await;
                        return Ok(probe);
                    }
                    ServerMessage::Error { message } => return Err(format!("gateway: {message}")),
                    _ => {}
                }
            }
            Message::Ping(payload) => {
                let _ = socket.send(Message::Pong(payload)).await;
            }
            Message::Close(_) => return Err("gateway closed the status link".into()),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::status_url;

    #[test]
    fn status_url_is_routes_only() {
        assert_eq!(
            status_url("wss://example.test/link").expect("wss").as_str(),
            "wss://example.test/link?role=routes"
        );
        assert_eq!(
            status_url("ws://127.0.0.1:7443/link").expect("ws").as_str(),
            "ws://127.0.0.1:7443/link?role=routes"
        );
        assert_eq!(
            status_url("https://example.test").expect("https").as_str(),
            "wss://example.test/link?role=routes"
        );
    }
}
