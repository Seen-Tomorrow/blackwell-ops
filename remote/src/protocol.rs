//! Wire protocol shared by the Blackwell gateway and the portable client.
//!
//! All frames are JSON text WebSocket messages. PTY/model byte payloads are
//! base64 inside JSON. This is deliberately boring: it keeps the first client
//! small and makes `wscat`/PowerShell debugging practical.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_WS_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

/// One selectable model route. `id` is opaque to the client; the client never
/// learns the engine port.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRoute {
    pub id: String,
    pub label: String,
    pub model: String,
    pub context_window: usize,
    pub vision: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpen {
    pub profile: String,
    pub routes: Vec<ModelRoute>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    /// First message after the socket upgrade. The gateway already knows the
    /// device id from the bearer token; this fills in display metadata.
    Hello {
        #[serde(default)]
        device_name: Option<String>,
        #[serde(default)]
        os: Option<String>,
        #[serde(default)]
        user: Option<String>,
        #[serde(default)]
        integrity: Option<String>,
        #[serde(default)]
        client_version: Option<String>,
        #[serde(default)]
        pi_version: Option<String>,
    },
    SessionReady {
        #[serde(default)]
        pid: Option<u32>,
        #[serde(default)]
        pi_version: Option<String>,
        #[serde(default)]
        integrity: Option<String>,
    },
    /// Base64 PTY output.
    PtyData { data: String },
    SessionExit {
        #[serde(default)]
        code: Option<i32>,
    },
    ModelRequest {
        id: String,
        route_id: String,
        body: Value,
    },
    ModelCancel { id: String },
    /// Ask for the current model route list without opening a session.
    ///
    /// Local Power Mode (`blackwell-link --local`) uses this to build Pi's
    /// `blackwell/*` model catalog before any remote session exists. The gateway
    /// answers with [`ServerMessage::Routes`] and creates no session record, no
    /// PTY, and no task/approval.
    RoutesRequest,
    Ping,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Ready {
        protocol_version: u32,
        server_version: String,
        #[serde(default)]
        public_url: Option<String>,
        #[serde(default)]
        session: Option<SessionOpen>,
    },
    SessionOpen(SessionOpen),
    SessionStop {
        reason: String,
    },
    /// Base64 operator keystrokes.
    PtyInput { data: String },
    PtyResize { cols: u16, rows: u16 },
    ModelHead {
        id: String,
        status: u16,
        #[serde(default)]
        content_type: Option<String>,
    },
    ModelChunk { id: String, data: String },
    ModelEnd {
        id: String,
        #[serde(default)]
        error: Option<String>,
    },
    /// Reply to [`ClientMessage::RoutesRequest`]. An empty list is normal when no
    /// engine is running; the client then falls back to its cloud provider.
    Routes { routes: Vec<ModelRoute> },
    Pong,
    Error { message: String },
}

/// `POST /pair` request. All metadata is optional; the device name is only a
/// display label.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    pub code: String,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub os: Option<String>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub integrity: Option<String>,
    #[serde(default)]
    pub client_version: Option<String>,
    #[serde(default)]
    pub pi_version: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    pub device_id: String,
    pub token: String,
    pub server_version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub ok: bool,
    pub version: &'static str,
    pub protocol_version: u32,
    pub uptime_seconds: u64,
    pub devices: usize,
    pub online_devices: usize,
    pub active_sessions: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_exchange_keeps_the_wire_shape() {
        // Local Power Mode is only a new message pair; the route fields stay the
        // same camelCase shape the session handshake already uses.
        let request = serde_json::to_value(ClientMessage::RoutesRequest).unwrap();
        assert_eq!(request["type"], "routes_request");

        let reply = serde_json::to_value(ServerMessage::Routes {
            routes: vec![ModelRoute {
                id: "route_1".into(),
                label: "ENGINE_1".into(),
                model: "ENGINE_1".into(),
                context_window: 32768,
                vision: false,
            }],
        })
        .unwrap();
        assert_eq!(reply["type"], "routes");
        assert_eq!(reply["routes"][0]["id"], "route_1");
        assert_eq!(reply["routes"][0]["contextWindow"], 32768);
    }
}
