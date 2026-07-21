//! Process-wide shutdown flag — skip WebView IPC and heavy post-pipe work during app exit.
//!
//! Heap corruption (`0xC0000374`) was observed:
//! - during long multi-engine fusion idle (mitigated: warmer poll rate)
//! - after engine teardown during **WebView destroy** / Tauri Drop (`main window destroyed` then crash)
//!
//! After engines are killed we `std::process::exit(0)` **without** destroying the webview —
//! session logs showed destroy itself is the heap-smash trigger.

use std::sync::atomic::{AtomicBool, Ordering};

static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// Mark app exit in progress. Idempotent. Call at the start of teardown (before stopping brains).
pub fn begin_shutdown() {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
    log::info!("[lifecycle] begin_shutdown — IPC and pipe-exit side work suppressed");
    crate::session_log::append_session_line("[lifecycle] begin_shutdown");
}

pub fn is_shutting_down() -> bool {
    SHUTTING_DOWN.load(Ordering::Acquire)
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
