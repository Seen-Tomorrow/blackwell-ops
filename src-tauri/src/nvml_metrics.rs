//! PCIe link state and throughput straight from NVML.
//!
//! `nvidia-smi` cannot print PCIe bandwidth, so the GPU tiles read it from the driver
//! library: `nvmlDeviceGetPcieThroughput` (KB/s, device-wide) plus the negotiated and
//! maximum link generation/width. All calls are optional - a missing `nvml.dll`, an old
//! driver or a GPU without the counter returns `None`/0 and never breaks the poll.

use libloading::{Library, Symbol};
use std::ffi::{c_char, c_void, CString};
use std::sync::Mutex;

/// `nvmlPcieUtilCounter_t`: transaction bytes into the device.
const NVML_PCIE_UTIL_TX_BYTES: u32 = 0;
/// `nvmlPcieUtilCounter_t`: transaction bytes out of the device.
const NVML_PCIE_UTIL_RX_BYTES: u32 = 1;

static NVML_LIB: Mutex<Option<Library>> = Mutex::new(None);

/// PCIe readings for one GPU. Every field is optional: the tile renders whatever arrived.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct PcieMetrics {
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

/// Read the PCIe counters for the GPU at `bus_id` (authoritative) or, when the bus id is
/// missing, the NVML index (same order as `nvidia-smi`).
pub fn pcie_metrics(bus_id: &str, index: u32) -> PcieMetrics {
    let bus_id = bus_id.trim();
    with_lib(|lib| unsafe {
        let dev = if bus_id.is_empty() {
            handle_by_index(lib, index)
        } else {
            handle_by_bus(lib, bus_id).or_else(|| handle_by_index(lib, index))
        };
        let Some(dev) = dev else {
            return PcieMetrics::default();
        };
        PcieMetrics {
            gen: read_u32(lib, b"nvmlDeviceGetCurrPcieLinkGeneration\0", dev),
            gen_max: read_u32(lib, b"nvmlDeviceGetMaxPcieLinkGeneration\0", dev),
            width: read_u32(lib, b"nvmlDeviceGetCurrPcieLinkWidth\0", dev),
            width_max: read_u32(lib, b"nvmlDeviceGetMaxPcieLinkWidth\0", dev),
            rx_mib_per_s: read_u32_arg(lib, b"nvmlDeviceGetPcieThroughput\0", dev, NVML_PCIE_UTIL_RX_BYTES)
                .map(|kb_per_s| kb_per_s as f32 / 1024.0),
            tx_mib_per_s: read_u32_arg(lib, b"nvmlDeviceGetPcieThroughput\0", dev, NVML_PCIE_UTIL_TX_BYTES)
                .map(|kb_per_s| kb_per_s as f32 / 1024.0),
        }
    })
    .unwrap_or_default()
}
