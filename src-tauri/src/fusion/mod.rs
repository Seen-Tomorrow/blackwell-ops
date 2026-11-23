//! Fusion telemetry — SSE-only brain (`SseBrain`) driven by `/events/sse`.

pub mod emit;
pub mod lifecycle;
pub mod meter;
pub mod sse;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::log_hub::LogHub;

pub(crate) static FUSION_SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

const BRAIN_STOP_JOIN_MS: u64 = 750;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EngineState {
    Loading,
    Ready,
    Active,
}

#[derive(Clone)]
pub struct FusionConfig {
    pub alias: String,
    pub slot_idx: usize,
    pub port: u16,
    pub ctx_total: usize,
    pub parallel: i64,
    pub unified_kv: bool,
}

struct BrainHandle {
    cancel: CancellationToken,
    join: JoinHandle<()>,
}

static BRAIN_REGISTRY: LazyLock<Mutex<HashMap<usize, BrainHandle>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

async fn stop_brain_handle(handle: BrainHandle) {
    let abort = handle.join.abort_handle();
    handle.cancel.cancel();
    if tokio::time::timeout(
        std::time::Duration::from_millis(BRAIN_STOP_JOIN_MS),
        handle.join,
    )
    .await
    .is_err()
    {
        abort.abort();
    }
}

/// Start the SSE fusion brain for an engine slot if `/events/sse` is supported.
pub async fn start_brain(log_hub: LogHub, config: FusionConfig) {
    let sse_capable = crate::engine_events::probe(config.port).await;
    let old = BRAIN_REGISTRY.lock().remove(&config.slot_idx);
    if let Some(handle) = old {
        stop_brain_handle(handle).await;
    }

    if !sse_capable {
        log::info!(
            "[fusion] slot={} port={} sse_capable=false — fusion off",
            config.slot_idx,
            config.port
        );
        emit::remove_fusion_snapshot(config.slot_idx);
        return;
    }

    crate::engine_events::restart(config.port);
    log::info!(
        "[fusion] slot={} port={} brain=Sse",
        config.slot_idx,
        config.port
    );
    let idx = config.slot_idx;
    let (join, cancel) = sse::SseBrain::spawn(log_hub, config);
    BRAIN_REGISTRY.lock().insert(idx, BrainHandle { cancel, join });
}

/// Stop the fusion brain for a specific slot.
pub async fn stop_brain(slot_idx: usize) {
    let entry = BRAIN_REGISTRY.lock().remove(&slot_idx);
    if let Some(handle) = entry {
        stop_brain_handle(handle).await;
    }
    emit::remove_fusion_snapshot(slot_idx);
}

/// Stop all fusion brains. Call on app shutdown.
pub async fn stop_all_brains() {
    FUSION_SHUTTING_DOWN.store(true, Ordering::Release);
    let entries: Vec<BrainHandle> = BRAIN_REGISTRY.lock().drain().map(|(_, v)| v).collect();
    let mut joins = Vec::with_capacity(entries.len());
    for handle in entries {
        joins.push(tokio::spawn(async move {
            stop_brain_handle(handle).await;
        }));
    }
    for j in joins {
        let _ = j.await;
    }
    emit::clear_snapshots();
    log::info!("[fusion] stop_all_brains complete (shutting_down=true, brains joined/aborted)");
    crate::session_log::append_session_line("[fusion] stop_all_brains complete");
}
