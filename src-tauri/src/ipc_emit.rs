//! Guarded Tauri event emission — the policy that must outlive the removed IPC meter.
//!
//! Two conditions silence every Rust→webview event: the app is shutting down
//! (`app_lifecycle::should_suppress_ipc`), or the debug flag disables emission
//! (`BLACKWELL_DISABLE_IPC_EMIT`). This used to be carried inside
//! `ipc_meter::emit_tracked`; the counters and footer UI are gone, the guards are not.

use tauri::{AppHandle, Emitter, Runtime};

/// Emit a Tauri event unless shutdown or the debug kill-switch says otherwise.
pub fn emit_guarded<R: Runtime, P: serde::Serialize + Clone>(
    app: &AppHandle<R>,
    event: &str,
    payload: P,
) {
    if crate::app_lifecycle::should_suppress_ipc() {
        return;
    }
    if crate::debug_flags::flags().disable_ipc_emit {
        return;
    }
    if let Err(e) = app.emit(event, payload) {
        log::warn!("[IPC] emit `{event}` failed: {e}");
    }
}
