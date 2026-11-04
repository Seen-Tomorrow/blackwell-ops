//! Per-device calibration of what a launch costs beyond its own buffers.
//!
//! The engine prints its buffer inventory at load (`model`, `KV`, `compute` per device) and
//! `launch_memory_parse` turns those into MiB. NVML reports what the device actually holds.
//!
//! ```text
//! residual_i = (used_after - used_before) - sum(parsed buffers on device i)
//! ```
//!
//! The **delta around the launch** is the whole point. An absolute reading mixes in whatever
//! else holds memory on the card — a browser, a desktop compositor, a stale engine — and on
//! this box that drift is over a gigabyte and keeps growing while the engine sits idle with
//! no requests. `note_baseline` samples immediately before spawn, `capture` right after the
//! buffer inventory is parsed.
//!
//! Per-process memory is not available on WDDM (`usedGpuMemory` comes back NOT_AVAILABLE,
//! `nvidia-smi` prints `[N/A]`), so a device-level difference is the only way to measure it
//! without TCC.
//!
//! Store: `{app_root}/config/cache/gpu-calibration.json`. Separate from `learned-vram.json`
//! on purpose — this is infrastructure calibration, not a model measurement, and deleting
//! the file only forces re-sampling.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const SAMPLES_PER_DEVICE: usize = 10;

static LAUNCH_BASELINES: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<usize, std::collections::BTreeMap<u32, u64>>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// Remember per-device usage immediately before an engine is spawned.
pub fn note_baseline(slot_idx: usize) {
    let Some(samples) = crate::nvml_metrics::scan() else {
        return;
    };
    let mut used = std::collections::BTreeMap::new();
    for gpu in &samples {
        used.insert(gpu.index, gpu.memory_used_mib);
    }
    if let Ok(mut guard) = LAUNCH_BASELINES.lock() {
        guard.insert(slot_idx, used);
    }
}

/// Drop a baseline for a launch that never produced buffers (spawn failure, cancel).
pub fn forget_baseline(slot_idx: usize) {
    if let Ok(mut guard) = LAUNCH_BASELINES.lock() {
        guard.remove(&slot_idx);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalibrationSample {
    /// `nvml_used - buffers`, MiB.
    pub residual_mib: f64,
    pub buffers_mib: f64,
    pub used_mib: f64,
    pub capacity_mib: f64,
    pub model: String,
    pub driver_model: String,
    pub taken_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DeviceCalibration {
    pub samples: Vec<CalibrationSample>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CalibrationStore {
    /// Device index (as NVML enumerates) → samples, newest last.
    pub devices: std::collections::BTreeMap<u32, DeviceCalibration>,
}

/// Median residual per device plus sample count — what the planner should use.
#[derive(Debug, Clone, Serialize)]
pub struct DeviceCalibrationSummary {
    pub index: u32,
    pub median_residual_mib: f64,
    pub samples: usize,
    pub last_capacity_mib: f64,
    pub driver_model: String,
    pub last_taken_at: String,
}

fn store_path() -> PathBuf {
    crate::config::cache_dir().join("gpu-calibration.json")
}

fn load_store() -> CalibrationStore {
    let path = store_path();
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_store(store: &CalibrationStore) -> Result<(), String> {
    let path = store_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

/// Buffers parsed for one device index, excluding host-side rows.
fn buffers_by_device(
    snapshot: &crate::launch_memory_parse::LaunchMemorySnapshot,
) -> std::collections::BTreeMap<u32, f64> {
    let mut per: std::collections::BTreeMap<u32, f64> = std::collections::BTreeMap::new();
    for line in &snapshot.buffers {
        let Some(rest) = line.device.strip_prefix("CUDA") else {
            // CUDA_Host and CPU rows are not device memory.
            continue;
        };
        let Ok(index) = rest.parse::<u32>() else {
            continue;
        };
        *per.entry(index).or_insert(0.0) += line.mib;
    }
    per
}

fn median(values: &mut [f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = values.len() / 2;
    if values.len() % 2 == 0 {
        (values[mid - 1] + values[mid]) / 2.0
    } else {
        values[mid]
    }
}

fn summarize(store: &CalibrationStore) -> Vec<DeviceCalibrationSummary> {
    store
        .devices
        .iter()
        .filter_map(|(index, device)| {
            let mut residuals: Vec<f64> = device.samples.iter().map(|s| s.residual_mib).collect();
            if residuals.is_empty() {
                return None;
            }
            let last = device.samples.last()?;
            let median_residual_mib = median(&mut residuals);
            Some(DeviceCalibrationSummary {
                index: *index,
                median_residual_mib,
                samples: device.samples.len(),
                last_capacity_mib: last.capacity_mib,
                driver_model: last.driver_model.clone(),
                last_taken_at: last.taken_at.clone(),
            })
        })
        .collect()
}

/// Sample every device a launch touched. Called once, right after the buffer inventory is
/// parsed — later the KV cache has grown and the difference stops being runtime overhead.
pub fn capture(
    model_path: &str,
    slot_idx: usize,
    snapshot: &crate::launch_memory_parse::LaunchMemorySnapshot,
) -> Result<(), String> {
    let buffers = buffers_by_device(snapshot);
    if buffers.is_empty() {
        return Ok(());
    }
    let Some(samples) = crate::nvml_metrics::scan() else {
        return Ok(());
    };
    let baseline = LAUNCH_BASELINES
        .lock()
        .ok()
        .and_then(|mut g| g.remove(&slot_idx));

    let mut store = load_store();
    let taken_at = chrono::Local::now().to_rfc3339();
    let mut recorded = 0usize;

    for gpu in &samples {
        let Some(&buffers_mib) = buffers.get(&gpu.index) else {
            continue;
        };
        if buffers_mib <= 0.0 {
            continue;
        }
        // Delta around the launch: `after - before` is what OUR engine added, so a
        // browser or a desktop compositor holding memory on the same card cancels out.
        let after_mib = gpu.memory_used_mib as f64;
        let before_mib = baseline.as_ref().and_then(|b| b.get(&gpu.index)).map(|v| *v as f64);
        let used_mib = match before_mib {
            Some(before) if after_mib >= before => after_mib - before,
            // No baseline (or the card lost memory since): fall back to the absolute reading.
            _ => after_mib,
        };
        // A launch cannot hold less than its own buffers; if NVML says so, the sample is
        // taken while the allocation is still settling and must not be stored.
        if used_mib < buffers_mib {
            continue;
        }
        let device = store.devices.entry(gpu.index).or_default();
        device.samples.push(CalibrationSample {
            residual_mib: used_mib - buffers_mib,
            buffers_mib,
            used_mib,
            capacity_mib: gpu.memory_total_mib as f64,
            model: model_path.to_string(),
            driver_model: gpu.driver_model.clone(),
            taken_at: taken_at.clone(),
        });
        if device.samples.len() > SAMPLES_PER_DEVICE {
            let drop = device.samples.len() - SAMPLES_PER_DEVICE;
            device.samples.drain(0..drop);
        }
        recorded += 1;
    }

    if recorded == 0 {
        return Ok(());
    }
    save_store(&store)
}

#[tauri::command]
pub fn get_gpu_calibration() -> Vec<DeviceCalibrationSummary> {
    summarize(&load_store())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(residual: f64) -> CalibrationSample {
        CalibrationSample {
            residual_mib: residual,
            buffers_mib: 1000.0,
            used_mib: 1000.0 + residual,
            capacity_mib: 97887.0,
            model: "m".into(),
            driver_model: "WDDM".into(),
            taken_at: "t".into(),
        }
    }    #[test]
    fn median_ignores_the_outlier_from_a_noisy_launch() {
        let mut values = vec![550.0, 618.0, 2450.0];
        assert_eq!(median(&mut values), 618.0);
    }

    #[test]
    fn summary_reports_the_median_and_sample_count() {
        let mut store = CalibrationStore::default();
        store.devices.insert(
            0,
            DeviceCalibration {
                samples: vec![sample(550.0), sample(618.0), sample(2450.0)],
            },
        );
        let summary = summarize(&store);
        assert_eq!(summary.len(), 1);
        assert_eq!(summary[0].median_residual_mib, 618.0);
        assert_eq!(summary[0].samples, 3);
    }

    #[test]
    fn host_rows_are_not_device_buffers() {
        use crate::launch_memory_parse::{BufferLine, LaunchMemorySnapshot};
        let snapshot = LaunchMemorySnapshot {
            parser_id: "t".into(),
            reference_profile: None,
            architecture: None,
            requested_ctx: None,
            buffers: vec![
                BufferLine { device: "CUDA0".into(), category: "model".into(), mib: 100.0, source: "load_tensors".into() },
                BufferLine { device: "CUDA0".into(), category: "compute".into(), mib: 50.0, source: "sched_reserve".into() },
                BufferLine { device: "CUDA_Host".into(), category: "compute".into(), mib: 900.0, source: "sched_reserve".into() },
                BufferLine { device: "CPU".into(), category: "model".into(), mib: 400.0, source: "load_tensors".into() },
            ],
            ..Default::default()
        };
        let per = buffers_by_device(&snapshot);
        assert_eq!(per.get(&0).copied(), Some(150.0));
        assert_eq!(per.len(), 1);
    }
}
