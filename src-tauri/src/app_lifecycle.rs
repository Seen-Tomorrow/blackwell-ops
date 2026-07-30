//! Process-wide shutdown flag — skip WebView IPC and heavy post-pipe work during app exit.
//!
//! Heap corruption (`0xC0000374`) was observed:
//! - during long multi-engine fusion idle (mitigated: warmer poll rate)
//! - after engine teardown during **WebView destroy** / Tauri Drop (`main window destroyed` then crash)
//!
//! After engines are killed we `std::process::exit(0)` **without** destroying the webview —
//! session logs showed destroy itself is the heap-smash trigger.
//!
//! **Frontend detachment** (F5 / page reload): The JS context dies instantly on reload.
//! Rust-side Tokio tasks (log batch flush, fusion poll, telemetry) must suppress IPC into
//! a dead WebView2 until the new frontend reconnects via `startup_frontend_ping`.

use std::sync::atomic::{AtomicBool, Ordering};

static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
static FRONTEND_DETACHED: AtomicBool = AtomicBool::new(false);

/// Mark app exit in progress. Idempotent. Call at the start of teardown (before stopping brains).
pub fn begin_shutdown() {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
    log::info!("[lifecycle] begin_shutdown — IPC and pipe-exit side work suppressed");
    crate::session_log::append_session_line("[lifecycle] begin_shutdown");
}

pub fn is_shutting_down() -> bool {
    SHUTTING_DOWN.load(Ordering::Acquire)
}

/// Check if frontend is detached (F5 reload) OR shutting down.
/// Use this guard before any WebView IPC emit.
pub fn should_suppress_ipc() -> bool {
    is_shutting_down() || is_frontend_detached()
}

/// Frontend is about to unload (beforeunload event). Suppress IPC into WebView2.
pub fn set_frontend_detached() {
    FRONTEND_DETACHED.store(true, Ordering::SeqCst);
    log::info!("[lifecycle] frontend detached — IPC suppressed until re-connect");
    crate::session_log::append_session_line("[lifecycle] frontend detached (F5 / reload)");
}

/// Frontend has reconnected (startup_frontend_ping). Resume IPC.
pub fn clear_frontend_detached() {
    FRONTEND_DETACHED.store(false, Ordering::SeqCst);
    log::info!("[lifecycle] frontend re-connected — IPC resumed");
    crate::session_log::append_session_line("[lifecycle] frontend re-connected");
}

/// Check if frontend is currently detached (page reload in progress).
pub fn is_frontend_detached() -> bool {
    FRONTEND_DETACHED.load(Ordering::Acquire)
}

/// Finish app exit after engines/fusion are already torn down.
///
/// **Do not** call `WebviewWindow::destroy` or `AppHandle::exit` here — both have been observed
/// to STATUS_HEAP_CORRUPTION after a fully successful engine teardown. Engines are already dead
/// (taskkill + kill-on-close job). Hard-exit the process image.
pub async fn finish_process_exit(_app_handle: &tauri::AppHandle) -> ! {
    begin_shutdown(); // idempotent

    crate::session_log::append_session_line(
        "[lifecycle] std::process::exit(0) — skip webview destroy + Tauri Drop (heap-safe exit)",
    );
    log::info!("[lifecycle] std::process::exit(0) — no webview destroy");

    // Tiny yield so session_log flush hits disk before the process image is torn down.
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    std::process::exit(0);
}
