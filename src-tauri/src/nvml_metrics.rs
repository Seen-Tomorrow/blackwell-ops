//! Per-GPU readings straight from NVML.
//!
//! This module owns two things:
//!
//! 1. [`scan`] — the full per-tick snapshot (identity, VRAM, utilization, temperature,
//!    power) used by `scan_gpus`. `nvidia-smi` is a CLI over this same library, so the
//!    numbers are identical; reading them in-process skips a ~56 ms CPU / ~90 ms wall
//!    process spawn per poll, which the 4 Hz hardware monitor was paying for.
//! 2. [`gpu_metrics`] — the PCIe link/throughput, memory clock and clock-throttle
//!    reasons that `nvidia-smi` cannot print (used by the CLI fallback path).
//!
//! NVML does not expose the memory junction on this stack (probed: only the die sensor,
//! `MEM_MAX` threshold NOT_SUPPORTED). The clock-throttle reasons are the supported proxy
//! for "is it thermally/power limited". Every call is optional: a missing `nvml.dll`, an
//! old driver or a GPU without the counter returns `None` and never breaks the poll.

use libloading::{Library, Symbol};
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// `nvmlPcieUtilCounter_t`: transaction bytes into the device.
const NVML_PCIE_UTIL_TX_BYTES: u32 = 0;
/// `nvmlPcieUtilCounter_t`: transaction bytes out of the device.
const NVML_PCIE_UTIL_RX_BYTES: u32 = 1;
/// `nvmlClocks_t`: memory clock.
const NVML_CLOCK_MEM: u32 = 2;
/// `nvmlTemperatureSensors_t`: die sensor.
const NVML_TEMPERATURE_GPU: u32 = 0;

const BYTES_PER_MIB: u64 = 1024 * 1024;

/// `nvmlDeviceGetPcieThroughput` costs ~32 ms per call on the dev box — it asks the driver
/// to sample the link counters. A bandwidth readout is fine at ~1 Hz per card, and it must
/// never run on the 4-10 Hz path: it was what capped every scan at ~135 ms and queued polls
/// at 100 ms. Refreshes are spread (one card per scan), so scan latency stays ≤ ~64 ms even
/// with 8 GPUs instead of N×64 ms in a single pass.
const PCIE_SAMPLE_TTL: Duration = Duration::from_millis(1000);
/// `nvmlDeviceGetDriverModel` costs ~2.9 ms; it only changes on a TCC switch or driver restart.
const DRIVER_MODEL_TTL: Duration = Duration::from_secs(30);

static NVML_LIB: Mutex<Option<Library>> = Mutex::new(None);

/// Live toggle (CONFIG → RUNTIME). Off skips the link counters entirely and the tile shows "—".
static PCIE_THROUGHPUT_ENABLED: AtomicBool = AtomicBool::new(true);

pub fn set_pcie_throughput_enabled(enabled: bool) {
    PCIE_THROUGHPUT_ENABLED.store(enabled, Ordering::Relaxed);
}

/// Cached "slow" readings, keyed by NVML index and refreshed on their own cadence.
#[derive(Default)]
struct SlowCache {
    /// (index, rx MiB/s, tx MiB/s, sampled at)
    pcie: Vec<(u32, Option<f32>, Option<f32>, Instant)>,
    /// (index, WDDM | TCC, sampled at)
    model: Vec<(u32, String, Instant)>,
}

static SLOW_CACHE: Mutex<SlowCache> = Mutex::new(SlowCache {
    pcie: Vec::new(),
    model: Vec::new(),
});

/// NVML readings `nvidia-smi` cannot print for one GPU. Every field is optional: the
/// tile renders whatever arrived.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct GpuMetrics {
    /// Negotiated link generation; drops at idle (power saving).
    pub gen: Option<u32>,
    /// Capability of the slot/the card.
    pub gen_max: Option<u32>,
    /// Negotiated link width.
    pub width: Option<u32>,
    /// Capability width of the slot/the card.
    pub width_max: Option<u32>,
    /// Bytes/s into the GPU, MiB/s.
    pub rx_mib_per_s: Option<f32>,
    /// Bytes/s out of the GPU, MiB/s.
    pub tx_mib_per_s: Option<f32>,
    /// Current memory clock, MHz.
    pub mem_clock_mhz: Option<u32>,
    /// `nvmlClocksThrottleReason_t` bitmask.
    pub throttle_reasons: Option<u64>,
}

/// One complete per-tick GPU reading.
#[derive(Debug, Clone, Default)]
pub struct GpuSample {
    pub index: u32,
    pub name: String,
    pub driver_version: Option<String>,
    /// `WDDM` | `TCC` | empty when the driver refuses the query.
    pub driver_model: String,
    pub memory_total_mib: u64,
    pub memory_used_mib: u64,
    pub memory_free_mib: u64,
    pub temperature_gpu: u32,
    pub power_draw_w: f32,
    pub power_limit_w: f32,
    pub utilization_gpu: u32,
    pub utilization_memory: u32,
    pub metrics: GpuMetrics,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
struct NvmlMemory {
    total: u64,
    free: u64,
    used: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
struct NvmlUtilization {
    gpu: u32,
    memory: u32,
}

fn with_lib<T>(f: impl FnOnce(&Library) -> T) -> Option<T> {
    let mut guard = NVML_LIB.lock().ok()?;
    if guard.is_none() {
        let lib = unsafe { Library::new("nvml.dll").ok()? };
        // nvmlInit_v2 exists on every driver that ships nvml.dll; keep the v1 fallback.
        let init = unsafe {
            lib.get::<unsafe extern "C" fn() -> u32>(b"nvmlInit_v2\0")
                .or_else(|_| lib.get::<unsafe extern "C" fn() -> u32>(b"nvmlInit\0"))
        }
        .ok()?;
        if unsafe { init() } != 0 {
            return None;
        }
        *guard = Some(lib);
    }
    let lib = guard.as_ref()?;
    Some(f(lib))
}

unsafe fn handle_by_bus(lib: &Library, bus_id: &str) -> Option<*mut c_void> {
    let bus = CString::new(bus_id).ok()?;
    let get = lib
        .get::<unsafe extern "C" fn(*const c_char, *mut *mut c_void) -> u32>(b"nvmlDeviceGetHandleByPciBusId_v2\0")
        .or_else(|_| lib.get::<unsafe extern "C" fn(*const c_char, *mut *mut c_void) -> u32>(b"nvmlDeviceGetHandleByPciBusId\0"))
        .ok()?;
    let mut dev = std::ptr::null_mut();
    (get(bus.as_ptr(), &mut dev) == 0 && !dev.is_null()).then_some(dev)
}

unsafe fn handle_by_index(lib: &Library, index: u32) -> Option<*mut c_void> {
    let get = lib
        .get::<unsafe extern "C" fn(u32, *mut *mut c_void) -> u32>(b"nvmlDeviceGetHandleByIndex_v2\0")
        .or_else(|_| lib.get::<unsafe extern "C" fn(u32, *mut *mut c_void) -> u32>(b"nvmlDeviceGetHandleByIndex\0"))
        .ok()?;
    let mut dev = std::ptr::null_mut();
    (get(index, &mut dev) == 0 && !dev.is_null()).then_some(dev)
}

unsafe fn read_u32(lib: &Library, name: &[u8], dev: *mut c_void) -> Option<u32> {
    let f: Symbol<unsafe extern "C" fn(*mut c_void, *mut u32) -> u32> = lib.get(name).ok()?;
    let mut value = 0u32;
    (f(dev, &mut value) == 0).then_some(value)
}

unsafe fn read_u32_arg(lib: &Library, name: &[u8], dev: *mut c_void, arg: u32) -> Option<u32> {
    let f: Symbol<unsafe extern "C" fn(*mut c_void, u32, *mut u32) -> u32> = lib.get(name).ok()?;
    let mut value = 0u32;
    (f(dev, arg, &mut value) == 0).then_some(value)
}

unsafe fn read_u64(lib: &Library, name: &[u8], dev: *mut c_void) -> Option<u64> {
    let f: Symbol<unsafe extern "C" fn(*mut c_void, *mut u64) -> u32> = lib.get(name).ok()?;
    let mut value = 0u64;
    (f(dev, &mut value) == 0).then_some(value)
}

/// `nvmlDeviceGetMemoryInfo` — bytes.
unsafe fn memory_info(lib: &Library, dev: *mut c_void) -> Option<NvmlMemory> {
    let f: Symbol<unsafe extern "C" fn(*mut c_void, *mut NvmlMemory) -> u32> =
        lib.get(b"nvmlDeviceGetMemoryInfo\0").ok()?;
    let mut value = NvmlMemory::default();
    (f(dev, &mut value) == 0).then_some(value)
}

/// `nvmlDeviceGetUtilizationRates` — percent, already 0-100.
unsafe fn utilization_rates(lib: &Library, dev: *mut c_void) -> Option<NvmlUtilization> {
    let f: Symbol<unsafe extern "C" fn(*mut c_void, *mut NvmlUtilization) -> u32> =
        lib.get(b"nvmlDeviceGetUtilizationRates\0").ok()?;
    let mut value = NvmlUtilization::default();
    (f(dev, &mut value) == 0).then_some(value)
}

/// ASCII string out of a `(device, buffer, length)` NVML getter.
unsafe fn read_cstr_device(
    lib: &Library,
    name: &[u8],
    dev: *mut c_void,
    cap: usize,
) -> Option<String> {
    let f: Symbol<unsafe extern "C" fn(*mut c_void, *mut c_char, u32) -> u32> = lib.get(name).ok()?;
    let mut buf = vec![0 as c_char; cap];
    if f(dev, buf.as_mut_ptr(), cap as u32) != 0 {
        return None;
    }
    Some(CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned())
}

unsafe fn driver_version(lib: &Library) -> Option<String> {
    let f: Symbol<unsafe extern "C" fn(*mut c_char, u32) -> u32> =
        lib.get(b"nvmlSystemGetDriverVersion\0").ok()?;
    let mut buf = [0 as c_char; 80];
    (f(buf.as_mut_ptr(), buf.len() as u32) == 0)
        .then(|| CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned())
}

/// `nvmlDriverModel_t`: 0 = WDDM, 1 = WDM/TCC (verified against `nvidia-smi` on WDDM).
unsafe fn driver_model(lib: &Library, dev: *mut c_void) -> String {
    let Ok(f) = lib.get::<unsafe extern "C" fn(*mut c_void, *mut i32, *mut i32) -> u32>(
        b"nvmlDeviceGetDriverModel\0",
    ) else {
        return String::new();
    };
    let mut current = 0i32;
    let mut pending = 0i32;
    if f(dev, &mut current, &mut pending) != 0 {
        return String::new();
    }
    match current {
        0 => "WDDM".to_string(),
        1 => "TCC".to_string(),
        _ => String::new(),
    }
}

unsafe fn power_limit_mw(lib: &Library, dev: *mut c_void) -> Option<u32> {
    read_u32(lib, b"nvmlDeviceGetPowerManagementLimit\0", dev)
        .or_else(|| read_u32(lib, b"nvmlDeviceGetEnforcedPowerLimit\0", dev))
}

/// Link/clocks/throttle — every call here is a few microseconds.
unsafe fn read_fast_metrics(lib: &Library, dev: *mut c_void) -> GpuMetrics {
    GpuMetrics {
        gen: read_u32(lib, b"nvmlDeviceGetCurrPcieLinkGeneration\0", dev),
        gen_max: read_u32(lib, b"nvmlDeviceGetMaxPcieLinkGeneration\0", dev),
        width: read_u32(lib, b"nvmlDeviceGetCurrPcieLinkWidth\0", dev),
        width_max: read_u32(lib, b"nvmlDeviceGetMaxPcieLinkWidth\0", dev),
        mem_clock_mhz: read_u32_arg(lib, b"nvmlDeviceGetClockInfo\0", dev, NVML_CLOCK_MEM),
        throttle_reasons: read_u64(lib, b"nvmlDeviceGetCurrentClocksThrottleReasons\0", dev),
        // Filled by `read_throughput` — never read on the fast path (see PCIE_SAMPLE_TTL).
        rx_mib_per_s: None,
        tx_mib_per_s: None,
    }
}

/// PCIe bandwidth in MiB/s — ~32 ms per call, so only the CLI fallback and the slow
/// cache refresh may call this.
unsafe fn read_throughput(lib: &Library, dev: *mut c_void) -> (Option<f32>, Option<f32>) {
    let rx = read_u32_arg(lib, b"nvmlDeviceGetPcieThroughput\0", dev, NVML_PCIE_UTIL_RX_BYTES)
        .map(|kb_per_s| kb_per_s as f32 / 1024.0);
    let tx = read_u32_arg(lib, b"nvmlDeviceGetPcieThroughput\0", dev, NVML_PCIE_UTIL_TX_BYTES)
        .map(|kb_per_s| kb_per_s as f32 / 1024.0);
    (rx, tx)
}

unsafe fn read_metrics(lib: &Library, dev: *mut c_void) -> GpuMetrics {
    let (rx, tx) = read_throughput(lib, dev);
    GpuMetrics {
        rx_mib_per_s: rx,
        tx_mib_per_s: tx,
        ..read_fast_metrics(lib, dev)
    }
}

/// Read NVML's per-GPU counters for the card at `bus_id` (authoritative) or, when the bus
/// id is missing, the NVML index (same order as `nvidia-smi`).
pub fn gpu_metrics(bus_id: &str, index: u32) -> GpuMetrics {
    let bus_id = bus_id.trim();
    with_lib(|lib| unsafe {
        let dev = if bus_id.is_empty() {
            handle_by_index(lib, index)
        } else {
            handle_by_bus(lib, bus_id).or_else(|| handle_by_index(lib, index))
        };
        match dev {
            Some(dev) => read_metrics(lib, dev),
            None => GpuMetrics::default(),
        }
    })
    .unwrap_or_default()
}

/// Full per-tick snapshot for every NVIDIA device, in NVML index order.
///
/// `None` means this machine has no usable `nvml.dll` (missing, refusing `nvmlInit`, or
/// no driver) — the caller falls back to `nvidia-smi`. An empty vector means NVML is
/// healthy and the machine simply has no NVIDIA device.
pub fn scan() -> Option<Vec<GpuSample>> {
    with_lib(|lib| unsafe {
        let count_f = lib
            .get::<unsafe extern "C" fn(*mut u32) -> u32>(b"nvmlDeviceGetCount_v2\0")
            .or_else(|_| lib.get::<unsafe extern "C" fn(*mut u32) -> u32>(b"nvmlDeviceGetCount\0"));
        let Ok(count_f) = count_f else {
            return Vec::new();
        };
        let mut count = 0u32;
        if count_f(&mut count) != 0 {
            return Vec::new();
        }

        let version = driver_version(lib);
        let now = Instant::now();
        let pcie_enabled = PCIE_THROUGHPUT_ENABLED.load(Ordering::Relaxed);
        let mut cache = SLOW_CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        // At most ONE card's link counters per scan — the oldest stale sample (a card that
        // was never sampled wins). Scan latency stays ~fast or +64 ms, never N×64 ms.
        let pcie_refresh_index = if pcie_enabled {
            let oldest = (0..count)
                .map(|index| {
                    let sampled = cache
                        .pcie
                        .iter()
                        .find(|(i, _, _, _)| *i == index)
                        .map(|(_, _, _, at)| *at);
                    let age = sampled
                        .map(|at| now.saturating_duration_since(at).as_millis())
                        .unwrap_or(u128::MAX);
                    (index, sampled, age)
                })
                .max_by_key(|(_, _, age)| *age);
            oldest.and_then(|(index, sampled, _)| {
                let due = sampled
                    .map_or(true, |at| now.saturating_duration_since(at) >= PCIE_SAMPLE_TTL);
                due.then_some(index)
            })
        } else {
            None
        };

        let mut samples = Vec::with_capacity(count as usize);
        for index in 0..count {
            let Some(dev) = handle_by_index(lib, index) else {
                continue;
            };

            let model = match cache.model.iter().find(|(i, _, _)| *i == index) {
                Some((_, model, at)) if now.saturating_duration_since(*at) < DRIVER_MODEL_TTL => {
                    model.clone()
                }
                _ => {
                    let model = driver_model(lib, dev);
                    cache.model.retain(|(i, _, _)| *i != index);
                    cache.model.push((index, model.clone(), now));
                    model
                }
            };

            let (rx_mib_per_s, tx_mib_per_s) = if !pcie_enabled {
                (None, None)
            } else if pcie_refresh_index == Some(index) {
                let pair = read_throughput(lib, dev);
                cache.pcie.retain(|(i, _, _, _)| *i != index);
                cache.pcie.push((index, pair.0, pair.1, now));
                pair
            } else {
                cache
                    .pcie
                    .iter()
                    .find(|(i, _, _, _)| *i == index)
                    .map(|(_, rx, tx, _)| (*rx, *tx))
                    .unwrap_or((None, None))
            };

            let memory = memory_info(lib, dev).unwrap_or_default();
            let utilization = utilization_rates(lib, dev).unwrap_or_default();
            samples.push(GpuSample {
                index,
                name: read_cstr_device(lib, b"nvmlDeviceGetName\0", dev, 96).unwrap_or_default(),
                driver_version: version.clone(),
                driver_model: model,
                memory_total_mib: memory.total / BYTES_PER_MIB,
                memory_used_mib: memory.used / BYTES_PER_MIB,
                memory_free_mib: memory.free / BYTES_PER_MIB,
                temperature_gpu: read_u32_arg(lib, b"nvmlDeviceGetTemperature\0", dev, NVML_TEMPERATURE_GPU)
                    .unwrap_or(0),
                power_draw_w: read_u32(lib, b"nvmlDeviceGetPowerUsage\0", dev)
                    .map(|mw| mw as f32 / 1000.0)
                    .unwrap_or(0.0),
                power_limit_w: power_limit_mw(lib, dev)
                    .map(|mw| mw as f32 / 1000.0)
                    .unwrap_or(0.0),
                utilization_gpu: utilization.gpu,
                utilization_memory: utilization.memory,
                metrics: GpuMetrics {
                    rx_mib_per_s,
                    tx_mib_per_s,
                    ..read_fast_metrics(lib, dev)
                },
            });
        }
        drop(cache);
        samples
    })
}
