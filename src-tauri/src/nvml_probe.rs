use libloading::{Library, Symbol};
use std::collections::HashMap;
use std::sync::Mutex;

static NVML_LIB: Mutex<Option<Library>> = Mutex::new(None);

// Temperature IDs — NVIDIA defines these in nvml_device.h
const NVML_TEMPERATURE_MEMORY: u32 = 1;
const NVML_TEMPERATURE_AUX: u32 = 2;
const NVML_TEMPERATURE_BOARD: u32 = 3;
const NVML_TEMPERATURE_GFX: u32 = 5;
const NVML_TEMPERATURE_XBAR: u32 = 6;
const NVML_TEMPERATURE_SOC: u32 = 7;

/// Probe NVML.dll for any available GPU temperatures (not just junction).
/// Filters out 255 — NVIDIA sentinel value meaning "sensor not available / redacted".
pub async fn probe_junction_temps_nvml() -> HashMap<u32, u32> {
    let mut map = HashMap::new();

    // Initialize NVML once (thread-safe)
    let mut lib_guard = match NVML_LIB.lock() {
        Ok(g) => g,
        Err(_) => return map,
    };

    if lib_guard.is_none() {
        let lib: Library = unsafe {
            match Library::new("nvml.dll") {
                Ok(l) => l,
                Err(e) => {
                    log::debug!("NVML.dll load failed: {}", e);
                    return map;
                }
            }
        };

        // nvmlInit — returns 0 on success
        let init_fn: Symbol<'_, unsafe extern "C" fn() -> u32> = unsafe {
            match lib.get(b"nvmlInit") {
                Ok(f) => f,
                Err(e) => {
                    log::debug!("NVML nvmlInit not found: {}", e);
                    return map;
                }
            }
        };

        if unsafe { init_fn() } != 0 {
            log::debug!("NVML initialization failed (non-zero return)");
            return map;
        }

        *lib_guard = Some(lib);
    }

    let lib = match lib_guard.as_ref() {
        Some(l) => l,
        None => return map,
    };

    // Get device count
    let mut device_count: u32 = 0;
    
    unsafe {
        let get_count_fn: Symbol<'_, unsafe extern "C" fn(*mut u32) -> u32> = match lib.get(b"nvmlDeviceGetCount") {
            Ok(f) => f,
            Err(_) => return map,
        };

        if get_count_fn(&mut device_count) != 0 || device_count == 0 {
            log::debug!("NVML: no devices found or nvmlDeviceGetCount failed");
            return map;
        }

        // Temperature IDs to try — Blackwell may expose junction via non-standard ID
        let temp_ids = [
            NVML_TEMPERATURE_MEMORY,   // 1 — standard HBM memory temp (Blackwell: N/A)
            NVML_TEMPERATURE_AUX,      // 2 — auxiliary (sometimes junction on newer GPUs)
            NVML_TEMPERATURE_BOARD,    // 3 — board temp
            NVML_TEMPERATURE_GFX,      // 5 — GFX die temp
            NVML_TEMPERATURE_XBAR,     // 6 — XBAR interconnect
            NVML_TEMPERATURE_SOC,      // 7 — SOC temperature
        ];

        let get_handle_fn: Symbol<'_, unsafe extern "C" fn(u32, *mut *mut std::ffi::c_void) -> u32> = 
            match lib.get(b"nvmlDeviceGetHandleByIndex") {
                Ok(f) => f,
                Err(_) => return map,
            };

        let get_temp_fn: Symbol<'_, unsafe extern "C" fn(*mut std::ffi::c_void, u32, *mut u32) -> u32> = 
            match lib.get(b"nvmlDeviceGetTemperature") {
                Ok(f) => f,
                Err(_) => return map,
            };

        for idx in 0..device_count {
            let mut device: *mut std::ffi::c_void = std::ptr::null_mut();

            if get_handle_fn(idx, &mut device) != 0 || device.is_null() {
                continue;
            }

            // Try each temperature ID — Blackwell may expose junction via a non-standard ID
            for &temp_id in &temp_ids {
                let mut temp: u32 = 0;

                let ret = get_temp_fn(device, temp_id, &mut temp);

                if ret == 0 && temp > 0 && temp < 150 && temp != 255 {
                    log::debug!("NVML GPU[{}] temp_id={} -> {}°C", idx, temp_id, temp);
                    
                    // Only set if we don't already have a value (prefer lower index = more standard)
                    // Filter out 255 — NVIDIA sentinel for "sensor not available / redacted"
                    if !map.contains_key(&idx) {
                        map.insert(idx, temp);
                    }
                }
            }
        }
    }

    log::debug!("NVML junction probe complete: {} GPUs with data", map.len());
    map
}
