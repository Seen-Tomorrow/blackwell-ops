//! Cancellation state for the library metadata scan.
//!
//! This module used to hold the stderr scraper: spawn `llama-server -ngl 0`, parse the
//! printed KV/print_info lines, kill before tensor load. `gguf_meta` now reads the same
//! header in-process (no spawn, no CUDA runtime, ~40 ms per model), so the scraper is
//! gone. What survives is the cancellation flag the batch scan polls between models.

use std::sync::atomic::{AtomicBool, Ordering};

/// Global cancellation flag for batch scans. Set to true by cancel_gguf_scan_cmd().
pub static GGUF_SCAN_CANCEL: AtomicBool = AtomicBool::new(false);

/// Check if the current scan should be cancelled.
pub fn is_cancelled() -> bool {
    GGUF_SCAN_CANCEL.load(Ordering::Relaxed)
}

/// Reset the cancellation flag (called at start of each batch scan).
pub fn reset_cancel() {
    GGUF_SCAN_CANCEL.store(false, Ordering::Relaxed);
}

/// Request cancellation of a running batch scan.
pub fn cancel() {
    GGUF_SCAN_CANCEL.store(true, Ordering::Relaxed);
}
