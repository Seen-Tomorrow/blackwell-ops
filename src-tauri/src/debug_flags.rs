//! Runtime debug / bisection flags — read once from env at first access.

use serde::Serialize;
use std::sync::OnceLock;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugFlags {
    pub disable_fusion_poll: bool,
    pub disable_ipc_emit: bool,
    pub disable_frontend_poll: bool,
    pub disable_disk_io: bool,
    pub telemetry_tick_ms: u64,
    pub fusion_idle_poll_ms: u64,
}

static FLAGS: OnceLock<DebugFlags> = OnceLock::new();

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
}

fn parse_telemetry_tick_ms() -> u64 {
    parse_env_ms("BLACKWELL_TELEMETRY_TICK_MS", 25)
}

fn parse_fusion_idle_poll_ms() -> u64 {
    parse_env_ms("BLACKWELL_FUSION_IDLE_POLL_MS", 2500)
}

fn parse_env_ms(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|&ms| ms > 0)
        .unwrap_or(default)
}

pub fn flags() -> &'static DebugFlags {
    FLAGS.get_or_init(|| {
        let f = DebugFlags {
            disable_fusion_poll: env_flag("BLACKWELL_DISABLE_FUSION_POLL"),
            disable_ipc_emit: env_flag("BLACKWELL_DISABLE_IPC_EMIT"),
            disable_frontend_poll: env_flag("BLACKWELL_DISABLE_FRONTEND_POLL"),
            disable_disk_io: env_flag("BLACKWELL_DISABLE_DISK_IO"),
            telemetry_tick_ms: parse_telemetry_tick_ms(),
            fusion_idle_poll_ms: parse_fusion_idle_poll_ms(),
        };
        log::warn!(
            "[debug] bisect flags: fusion_poll={} ipc_emit={} frontend_poll={} disk_io={} telemetry_tick_ms={} fusion_idle_poll_ms={}",
            !f.disable_fusion_poll,
            !f.disable_ipc_emit,
            !f.disable_frontend_poll,
            !f.disable_disk_io,
            f.telemetry_tick_ms,
            f.fusion_idle_poll_ms,
        );
        f
    })
}

#[tauri::command]
pub fn get_debug_flags() -> DebugFlags {
    flags().clone()
}