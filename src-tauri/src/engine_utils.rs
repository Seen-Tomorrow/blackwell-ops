//! Shared engine utilities — provider binary resolution and readiness polling.
//!
//! Extracted from engine.rs for use by multiple modules without circular deps.

use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex as TokioMutex};

use crate::config::AppConfig;
use crate::engine_stack::{EngineStack, SlotStatus};

/// Resolve binary path for a provider ID.
pub fn find_provider_binary(cfg: &AppConfig, provider_id: &str, binary_profile: &str) -> PathBuf {
    for p in &cfg.providers {
        if p.id == provider_id && !p.binary_path.is_empty() {
            let path = if !binary_profile.is_empty() {
                PathBuf::from(&p.binary_path)
            } else {
                PathBuf::from(&p.binary_path)
            };
            return path;
        }
    }

    if let Some(first) = cfg.providers.first() {
        PathBuf::from(&first.binary_path)
    } else {
        cfg.llama_path.clone()
    }
}

/// Strip ANSI escape sequences from ConPTY output.
pub fn strip_ansi(s: &str) -> String {
    let mut result = s.replace('\x1b', "");
    while let Some(start) = result.find('[') {
        let rest = &result[start + 1..];
        if let Some(end) = rest.find(|c: char| c.is_ascii_alphabetic()) {
            let params = &rest[..end];
            if params.chars().all(|c| c.is_ascii_digit() || c == ';') && !params.is_empty() {
                result = format!("{}{}", &result[..start], &rest[end..]);
                continue;
            }
        }
        break;
    }
    result.trim().to_string()
}

/// Extract a human-readable crash reason from buffered ConPTY output lines.
pub fn extract_crash_reason(lines: &[String], exit_code: u32) -> String {
    for line in lines.iter().rev() {
        let lower = line.to_lowercase();
        if lower.contains("unknown option") || lower.contains("invalid value") || lower.contains("error:") {
            return strip_ansi(line).chars().take(120).collect();
        }
    }
    format!("process exited unexpectedly (code={})", exit_code)
}

/// Poll ConPTY output for engine readiness signals.
///
/// Listens on a broadcast receiver for lines from the spawned llama-server process.
/// Transitions slot to `Running` when "server is listening" or "all slots are idle" appears.
/// Detects crashes if the channel closes without a readiness signal.
pub async fn poll_engine_readiness(
    stack: Arc<TokioMutex<EngineStack>>,
    slot_idx: usize,
    mut rx: broadcast::Receiver<String>,
    alias: &str,
) {
    loop {
        match rx.recv().await {
            Ok(line) => {
                // Already marked Running or Error by another path — bail out
                {
                    let s = stack.lock().await;
                    if let Some(slot) = s.get_slot(slot_idx) {
                        match &slot.status {
                            SlotStatus::Running | SlotStatus::Error(_) => return,
                            SlotStatus::Idle => return,
                            SlotStatus::Loading => {}
                        }
                    } else {
                        return;
                    }
                }

                let lower = line.to_lowercase();
                if lower.contains("server is listening on") || lower.contains("all slots are idle") {
                    let mut s = stack.lock().await;
                    if let Some(slot) = s.get_slot_mut(slot_idx) {
                        slot.status = SlotStatus::Running;
                    }
                    eprintln!("[READINESS] slot={} engine ready", slot_idx);
                    return;
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }

    // Channel closed — check if process crashed during loading
    {
        let mut s = stack.lock().await;
        let buffered_lines = s.drain_error_buffer(slot_idx);

        if let Some(slot) = s.get_slot_mut(slot_idx) {
            if let Some(ref mut conpty_proc) = slot.conpty_proc {
                if !conpty_proc.is_alive() {
                    let exit_code = conpty_proc.wait(None).unwrap_or(u32::MAX);
                    log::error!("slot={} ConPTY process exited while Loading (exit code: {})", slot_idx, exit_code);

                    let crash_reason = extract_crash_reason(&buffered_lines, exit_code);
                    slot.status = SlotStatus::Error(crash_reason.clone());

                    if let Some(ref hub) = s.log_hub() {
                        hub.emit_system_event(slot_idx, alias, &format!("LAUNCH_ERROR:{}", crash_reason)).await;
                        hub.emit_sanity_log("error", &format!("[ENGINE] slot={} crashed: {}", slot_idx, crash_reason));
                    }
                    return;
                }
            }
        }

        // Process still alive but channel closed — shouldn't happen normally.
        // Mark as Running anyway since the process is up.
        drop(s);
        eprintln!("[READINESS] slot={} output channel closed but process alive, marking Running", slot_idx);
        let mut s = stack.lock().await;
        if let Some(slot) = s.get_slot_mut(slot_idx) {
            slot.status = SlotStatus::Running;
        }
    }
}
