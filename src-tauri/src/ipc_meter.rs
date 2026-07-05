//! Rolling IPC emit rate meter — tracks Rust→webview Tauri events for footer telemetry.

use parking_lot::Mutex;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Runtime};

static TOTAL: AtomicU64 = AtomicU64::new(0);
static FUSION: AtomicU64 = AtomicU64::new(0);
static LOG_BATCH: AtomicU64 = AtomicU64::new(0);

static SNAPSHOT: OnceLock<Mutex<IpcMeterSnapshot>> = OnceLock::new();

fn snapshot_lock() -> &'static Mutex<IpcMeterSnapshot> {
    SNAPSHOT.get_or_init(|| Mutex::new(IpcMeterSnapshot::default()))
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IpcMeterSnapshot {
    pub total_per_sec: u64,
    pub fusion_per_sec: u64,
    pub log_batch_per_sec: u64,
    pub other_per_sec: u64,
    pub peak_per_sec: u64,
    pub tier: IpcMeterTier,
}

#[derive(Debug, Clone, Copy, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IpcMeterTier {
    #[default]
    Green,
    Yellow,
    Orange,
    Red,
}

fn tier_for_rate(total: u64) -> IpcMeterTier {
    if total >= 800 {
        IpcMeterTier::Red
    } else if total >= 300 {
        IpcMeterTier::Orange
    } else if total >= 50 {
        IpcMeterTier::Yellow
    } else {
        IpcMeterTier::Green
    }
}

/// Count one outbound IPC emit (call only when emit actually runs).
pub fn record(event: &str) {
    TOTAL.fetch_add(1, Ordering::Relaxed);
    match event {
        "fusion-update" => {
            FUSION.fetch_add(1, Ordering::Relaxed);
        }
        "engine-log-batch" => {
            LOG_BATCH.fetch_add(1, Ordering::Relaxed);
        }
        _ => {}
    }
}

/// Emit a Tauri event and record it for the IPC meter.
pub fn emit_tracked<R: Runtime, P: serde::Serialize + Clone>(
    app: &AppHandle<R>,
    event: &str,
    payload: P,
) {
    if crate::debug_flags::flags().disable_ipc_emit {
        return;
    }
    record(event);
    if let Err(e) = app.emit(event, payload) {
        log::warn!("[IPC_METER] emit `{event}` failed: {e}");
    }
}

pub fn snapshot() -> IpcMeterSnapshot {
    snapshot_lock().lock().clone()
}

pub fn start_rotator() {
    tauri::async_runtime::spawn(async {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            rotate_second();
        }
    });
}

fn rotate_second() {
    let total = TOTAL.swap(0, Ordering::Relaxed);
    let fusion = FUSION.swap(0, Ordering::Relaxed);
    let log_batch = LOG_BATCH.swap(0, Ordering::Relaxed);
    let other = total.saturating_sub(fusion + log_batch);

    let mut snap = snapshot_lock().lock();
    snap.peak_per_sec = snap.peak_per_sec.max(total);
    snap.total_per_sec = total;
    snap.fusion_per_sec = fusion;
    snap.log_batch_per_sec = log_batch;
    snap.other_per_sec = other;
    snap.tier = tier_for_rate(total);
}

#[tauri::command]
pub fn get_ipc_meter_stats() -> IpcMeterSnapshot {
    snapshot()
}