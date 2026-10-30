//! OYM gateway.
//!
//! The gateway is deliberately independent of Tauri so it can be run
//! standalone for a Cloudflare smoke test, then embedded in the app.

pub mod devices;
pub mod gateway;
pub mod invites;
pub mod protocol;
pub mod state;

pub use devices::DeviceView;
pub use protocol::SessionOpen;
pub use state::{
    AttachResult, HealthInfo, PairingInfo, GatewayConfig, GatewayEvent, GatewayState, GatewayStatus,
    RouteBinding, TerminateResult, SERVER_VERSION,
};

use std::sync::Arc;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

/// Bind and serve until the listener dies or `shutdown` is cancelled.
pub async fn serve_with_shutdown(
    state: Arc<GatewayState>,
    shutdown: CancellationToken,
) -> Result<(), String> {
    let listener = TcpListener::bind(state.cfg.bind)
        .await
        .map_err(|error| format!("bind {}: {error}", state.cfg.bind))?;
    state.set_gateway_error(None).await;
    axum::serve(listener, gateway::router(state.clone()))
        .with_graceful_shutdown(async move { shutdown.cancelled().await })
        .await
        .map_err(|error| format!("gateway server: {error}"))
}

/// Bind and serve until the listener dies. Kept for the standalone gateway.
pub async fn serve(state: Arc<GatewayState>) -> Result<(), String> {
    serve_with_shutdown(state, CancellationToken::new()).await
}

/// Load state and start the listener in a background task.
pub async fn start(cfg: GatewayConfig) -> Result<Arc<GatewayState>, String> {
    let state = GatewayState::load(cfg)?;
    state.clone().start_gateway().await?;
    Ok(state)
}
