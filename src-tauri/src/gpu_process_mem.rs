//! Per-process GPU memory from NVML.
//!
//! The engine prints its own buffer inventory at load (`model buffer size`,
//! `KV buffer size`, `compute buffer size`) and `launch_memory_parse` already stores those
//! per device. What it never prints is the CUDA context and allocator slack — roughly
//! 0.3-0.6 GiB per device.
//!
//! NVML reports usage **per process**, so that residual is measurable:
//!
//! ```text
//! context_i = usedGpuMemory(engine pid, device i) - sum(parsed buffers on device i)
//! ```
//!
//! This module owns only the NVML half. It is deliberately self-contained: deleting this
//! file and its two registration lines removes the feature and nothing else.

use libloading::Library;
use serde::Serialize;
use std::ffi::c_void;

/// `NVML_VALUE_NOT_AVAILABLE` — usedGpuMemory is `(unsigned long long)-1` when the driver
/// will not report it. **That is the normal case on Windows/WDDM**: measured on this box with
/// a live engine, every process came back `None` (nvidia-smi prints `[N/A]` for the same
/// reason). Only TCC mode reports per-process sizes, so on this stack the list gives
/// ATTRIBUTION (which pid sits on which device) but not a byte count.
const NVML_VALUE_NOT_AVAILABLE: u64 = u64::MAX;

#[derive(Debug, Clone, Serialize)]
pub struct GpuProcessUsage {
    /// Device index as NVML enumerates it (same order as `scan_gpus`).
    pub gpu_index: u32,
    pub pid: u32,
    /// MiB when the driver reports it, `null` otherwise.
    pub used_mib: Option<f64>,
}

/// `nvmlProcessInfo_t` (compute-apps flavour). Newer headers append the two instance ids;
/// passing a shorter struct would let the driver write past it, so keep the full shape.
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct NvmlProcessInfo {
    pid: u32,
    used_gpu_memory: u64,
    gpu_instance_id: u32,
    compute_instance_id: u32,
}

unsafe fn processes_for_device(lib: &Library, device: *mut c_void) -> Option<Vec<(u32, u64)>> {
    let get = lib
        .get::<unsafe extern "C" fn(*mut c_void, *mut u32, *mut NvmlProcessInfo) -> u32>(
            b"nvmlDeviceGetComputeRunningProcesses_v2\0",
        )
        .or_else(|_| {
            lib.get::<unsafe extern "C" fn(*mut c_void, *mut u32, *mut NvmlProcessInfo) -> u32>(
                b"nvmlDeviceGetComputeRunningProcesses\0",
            )
        })
        .ok()?;

    // The null-buffer probe returns NVML_ERROR_INSUFFICIENT_SIZE (7) on Windows, but it
    // still writes the required count - treating that rc as failure reported "no processes"
    // while an engine was live.
    let mut count: u32 = 0;
    let probe = get(device, &mut count, std::ptr::null_mut());
    if count == 0 {
        return if probe == 0 { Some(Vec::new()) } else { None };
    }
    let mut infos = vec![NvmlProcessInfo::default(); count as usize];
    let mut written: u32 = count;
    if get(device, &mut written, infos.as_mut_ptr()) != 0 {
        return None;
    }
    infos.truncate(written.min(count) as usize);
    Some(
        infos
            .into_iter()
            // NVML pads the tail with placeholder rows when it over-estimates the count.
            .filter(|i| i.pid != 0 && i.pid != u32::MAX)
            .map(|i| (i.pid, i.used_gpu_memory))
            .collect(),
    )
}

fn collect(lib: &Library) -> Vec<GpuProcessUsage> {
    let count_fn = unsafe {
        lib.get::<unsafe extern "C" fn(*mut u32) -> u32>(b"nvmlDeviceGetCount_v2\0")
            .or_else(|_| lib.get::<unsafe extern "C" fn(*mut u32) -> u32>(b"nvmlDeviceGetCount\0"))
    };
    let Ok(count_fn) = count_fn else {
        return Vec::new();
    };
    let mut device_count: u32 = 0;
    if unsafe { count_fn(&mut device_count) } != 0 {
        return Vec::new();
    }

    let mut out = Vec::new();
    for index in 0..device_count {
        let Some(handle) = (unsafe { crate::nvml_metrics::handle_by_index(lib, index) }) else {
            continue;
        };
        let Some(processes) = (unsafe { processes_for_device(lib, handle) }) else {
            continue;
        };
        for (pid, bytes) in processes {
            out.push(GpuProcessUsage {
                gpu_index: index,
                pid,
                used_mib: (bytes != NVML_VALUE_NOT_AVAILABLE)
                    .then(|| bytes as f64 / (1024.0 * 1024.0)),
            });
        }
    }
    out
}

/// Every process NVML attributes to a GPU, with its per-device share.
#[tauri::command]
pub fn get_gpu_process_memory() -> Vec<GpuProcessUsage> {
    crate::nvml_metrics::with_lib(collect).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A driver that refuses to report a size must yield `None`, never a bogus 16 EiB.
    #[test]
    fn unavailable_size_is_none_not_a_number() {
        let bytes = NVML_VALUE_NOT_AVAILABLE;
        let value: Option<f64> =
            (bytes != NVML_VALUE_NOT_AVAILABLE).then(|| bytes as f64 / (1024.0 * 1024.0));
        assert!(value.is_none());
    }

    /// The struct must keep the driver's C layout, including the instance-id tail.
    #[test]
    fn process_info_matches_the_driver_layout() {
        assert_eq!(std::mem::size_of::<NvmlProcessInfo>(), 24);
    }
}
