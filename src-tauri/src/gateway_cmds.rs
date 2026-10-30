//! Tauri commands for the remote control room.
//!
//! The gateway itself lives in the `oym-gateway` crate. This module is the
//! thin app-side adapter: it projects the running engine stack into model
//! routes and exposes device/session controls to the React UI.

use oym_gateway::protocol::ModelRoute;
use oym_gateway::{
    DeviceView, HealthInfo, PairingInfo, GatewayState, GatewayStatus, RouteBinding, SessionOpen,
    TerminateResult,
};
use std::sync::Arc;
use tauri::State;

use crate::engine::AppContext;

/// Project the running engine stack into gateway routes.
///
/// Route ids are derived from the **slot index**, not from a filtered
/// enumeration: the app refreshes routes periodically for local Power Mode, and
/// an index that shifts when an unrelated engine starts or stops would silently
/// re-point a live client's route id at a different engine.
pub(crate) fn running_routes(entries: Vec<crate::types::StackEntry>) -> Vec<RouteBinding> {
    entries
        .into_iter()
        .filter(|entry| entry.status == "RUNNING")
        .map(|entry| RouteBinding {
            route: ModelRoute {
                id: format!("route_{}", entry.idx + 1),
                label: entry.alias.clone(),
                model: entry.alias.clone(),
                context_window: entry.n_ctx.max(1),
                vision: entry.vision,
            },
            engine_port: entry.port,
        })
        .collect()
}

/// Read the running stack and publish its routes to the gateway.
///
/// This is the only route-population path besides a remote session start. It is
/// deliberately independent of sessions: local Power Mode asks the gateway for
/// routes before any session exists, and a running remote session keeps working
/// because model calls resolve routes by id at request time.
///
/// Returns the number of routes published.
pub(crate) async fn refresh_routes(
    stack: &tokio::sync::Mutex<crate::engine_stack::EngineStack>,
    remote: &GatewayState,
) -> usize {
    let routes = {
        let stack = stack.lock().await;
        running_routes(stack.get_status())
    };
    let count = routes.len();
    remote.set_routes(routes).await;
    count
}

#[tauri::command]
pub async fn remote_status(remote: State<'_, Arc<GatewayState>>) -> Result<GatewayStatus, String> {
    Ok(remote.status().await)
}

#[tauri::command]
pub async fn remote_gateway_start(remote: State<'_, Arc<GatewayState>>) -> Result<(), String> {
    remote.start_gateway().await
}

#[tauri::command]
pub async fn remote_gateway_stop(remote: State<'_, Arc<GatewayState>>) -> Result<(), String> {
    remote.stop_gateway().await
}

#[tauri::command]
pub async fn remote_pairing_create(
    remote: State<'_, Arc<GatewayState>>,
) -> Result<PairingInfo, String> {
    Ok(remote.create_pairing().await)
}

#[tauri::command]
pub async fn remote_devices_list(
    remote: State<'_, Arc<GatewayState>>,
) -> Result<Vec<DeviceView>, String> {
    Ok(remote.device_views().await)
}

#[tauri::command]
pub async fn remote_device_rename(
    remote: State<'_, Arc<GatewayState>>,
    device_id: String,
    custom_name: Option<String>,
) -> Result<oym_gateway::DeviceView, String> {
    remote.rename_device(&device_id, custom_name).await
}

#[tauri::command]
pub async fn remote_device_revoke(
    remote: State<'_, Arc<GatewayState>>,
    device_id: String,
) -> Result<(), String> {
    remote.revoke(&device_id).await
}

#[tauri::command]
pub async fn remote_health(
    remote: State<'_, Arc<GatewayState>>,
) -> Result<HealthInfo, String> {
    Ok(remote.health_check().await)
}

#[tauri::command]
pub async fn remote_session_start(
    app: State<'_, AppContext>,
    remote: State<'_, Arc<GatewayState>>,
    device_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<SessionOpen, String> {
    if refresh_routes(&app.stack, &remote).await == 0 {
        return Err("Start an engine (RUNNING) before opening a remote session.".into());
    }
    remote
        .start_session(
            &device_id,
            "pi-maintenance",
            cols.unwrap_or(120),
            rows.unwrap_or(32),
        )
        .await
}

#[tauri::command]
pub async fn remote_session_terminate(
    remote: State<'_, Arc<GatewayState>>,
    device_id: String,
) -> Result<TerminateResult, String> {
    remote.terminate_session(&device_id).await
}

#[tauri::command]
pub async fn remote_session_input(
    remote: State<'_, Arc<GatewayState>>,
    device_id: String,
    data: String,
) -> Result<(), String> {
    remote.send_pty_input(&device_id, data).await
}

#[tauri::command]
pub async fn remote_session_resize(
    remote: State<'_, Arc<GatewayState>>,
    device_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    remote.resize_pty(&device_id, cols, rows).await
}

#[cfg(test)]
mod tests {
    use super::running_routes;
    use crate::types::StackEntry;

    fn entry(idx: usize, status: &str, alias: &str, port: u16, n_ctx: usize, vision: bool) -> StackEntry {
        serde_json::from_value(serde_json::json!({
            "idx": idx,
            "alias": alias,
            "model_name": alias,
            "port": port,
            "gpu": "CUDA0",
            "status": status,
            "n_ctx": n_ctx,
            "vision": vision,
        }))
        .expect("stack entry fixture")
    }

    #[test]
    fn routes_only_expose_running_engines_keyed_by_slot() {
        // Slot 1 is stopped. Its route id (route_2) must stay unused rather than
        // letting the next running engine slide down to route_2: a live local
        // client resolves model calls by route id, and an id that re-points at a
        // different engine when an unrelated slot starts/stops is silent corruption.
        let routes = running_routes(vec![
            entry(0, "RUNNING", "ENGINE_1", 8101, 32768, false),
            entry(1, "STOPPED", "ENGINE_2", 8102, 32768, false),
            entry(2, "RUNNING", "ENGINE_3", 8103, 65536, true),
        ]);

        assert_eq!(routes.len(), 2, "only RUNNING slots become routes");
        assert_eq!(routes[0].route.id, "route_1");
        assert_eq!(routes[0].route.label, "ENGINE_1");
        assert_eq!(routes[0].route.model, "ENGINE_1");
        assert_eq!(routes[0].route.context_window, 32768);
        assert!(!routes[0].route.vision);
        assert_eq!(routes[0].engine_port, 8101);

        assert_eq!(routes[1].route.id, "route_3", "route ids follow the slot index");
        assert_eq!(routes[1].route.label, "ENGINE_3");
        assert_eq!(routes[1].route.context_window, 65536);
        assert!(routes[1].route.vision);
        assert_eq!(routes[1].engine_port, 8103);
    }

    #[test]
    fn stopped_stack_publishes_no_routes() {
        assert!(running_routes(vec![entry(0, "IDLE", "ENGINE_1", 8101, 8192, false)]).is_empty());
        assert!(running_routes(Vec::new()).is_empty());
    }

    #[test]
    fn zero_context_is_floored_to_one_token() {
        let routes = running_routes(vec![entry(0, "RUNNING", "ENGINE_1", 8101, 0, false)]);
        assert_eq!(routes[0].route.context_window, 1);
    }
}
