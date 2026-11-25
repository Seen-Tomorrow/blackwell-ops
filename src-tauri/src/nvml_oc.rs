//! Native NVML GPU overclocking (power limit + core/memory clock offsets).
//!
//! Dynamically loads `nvml.dll` via `libloading` and uses `nvmlDeviceSetPowerManagementLimit`
//! + `nvmlDeviceSetClockOffsets` (with `nvmlDeviceGetClockOffsets` for bounds clamping),
//! replacing the external `nvidiaInspector.exe` dependency.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NvmlOcTarget {
    pub gpu_index: u32,
    /// Power limit in watts; `0` restores the driver default via `nvmlDeviceGetPowerManagementDefaultLimit`.
    pub power_limit_w: u32,
    pub core_offset_mhz: i32,
    /// Base MHz offset (UI slider `0..3000`); multiplied by 2 for NVML `MEM` effective MT/s offsets.
    pub mem_offset_mhz: i32,
}

pub fn format_target_spec(t: &NvmlOcTarget) -> String {
    format!(
        "{}:{}:{}:{}",
        t.gpu_index, t.power_limit_w, t.core_offset_mhz, t.mem_offset_mhz
    )
}

pub fn parse_target_spec(s: &str) -> Result<NvmlOcTarget, String> {
    let parts: Vec<&str> = s.trim().split(':').collect();
    if parts.len() != 4 {
        return Err(format!("invalid OC target spec '{s}' (expected idx:pl:core:mem)"));
    }
    let gpu_index = parts[0]
        .parse::<u32>()
        .map_err(|e| format!("invalid gpu_index in '{s}': {e}"))?;
    let power_limit_w = parts[1]
        .parse::<u32>()
        .map_err(|e| format!("invalid power_limit_w in '{s}': {e}"))?;
    let core_offset_mhz = parts[2]
        .parse::<i32>()
        .map_err(|e| format!("invalid core_offset_mhz in '{s}': {e}"))?;
    let mem_offset_mhz = parts[3]
        .parse::<i32>()
        .map_err(|e| format!("invalid mem_offset_mhz in '{s}': {e}"))?;
    Ok(NvmlOcTarget {
        gpu_index,
        power_limit_w,
        core_offset_mhz,
        mem_offset_mhz,
    })
}

#[cfg(windows)]
mod imp {
    use super::NvmlOcTarget;
    use std::ffi::{c_char, c_void, CStr};
    use std::ptr;

    const NVML_SUCCESS: i32 = 0;
    const NVML_CLOCK_GRAPHICS: u32 = 0;
    const NVML_CLOCK_MEM: u32 = 2;
    const NVML_PSTATE_0: u32 = 0;

    #[repr(C)]
    #[derive(Debug, Clone, Copy)]
    pub struct NvmlClockOffsetV1 {
        pub version: u32,
        pub clock_type: u32,
        pub pstate: u32,
        pub clock_offset_mhz: i32,
        pub min_clock_offset_mhz: i32,
        pub max_clock_offset_mhz: i32,
    }

    pub const NVML_CLOCK_OFFSET_VER1: u32 =
        (1u32 << 24) | (std::mem::size_of::<NvmlClockOffsetV1>() as u32);

    type FnInit = unsafe extern "C" fn() -> i32;
    type FnShutdown = unsafe extern "C" fn() -> i32;
    type FnErrorString = unsafe extern "C" fn(i32) -> *const c_char;
    type FnGetHandleByIndex = unsafe extern "C" fn(u32, *mut *mut c_void) -> i32;
    type FnGetDefaultPowerLimit = unsafe extern "C" fn(*mut c_void, *mut u32) -> i32;
    type FnSetPowerLimit = unsafe extern "C" fn(*mut c_void, u32) -> i32;
    type FnGetClockOffsets = unsafe extern "C" fn(*mut c_void, *mut NvmlClockOffsetV1) -> i32;
    type FnSetClockOffsets = unsafe extern "C" fn(*mut c_void, *const NvmlClockOffsetV1) -> i32;

    struct NvmlSession {
        _lib: libloading::Library,
        shutdown: FnShutdown,
        error_string: FnErrorString,
        get_handle: FnGetHandleByIndex,
        get_default_pl: FnGetDefaultPowerLimit,
        set_pl: FnSetPowerLimit,
        get_clock_offsets: Option<FnGetClockOffsets>,
        set_clock_offsets: Option<FnSetClockOffsets>,
    }

    impl Drop for NvmlSession {
        fn drop(&mut self) {
            unsafe {
                (self.shutdown)();
            }
        }
    }

    impl NvmlSession {
        fn open() -> Result<Self, String> {
            unsafe {
                let lib = libloading::Library::new("nvml.dll")
                    .map_err(|e| format!("Failed to load nvml.dll: {e}"))?;
                let init: FnInit = *lib
                    .get::<FnInit>(b"nvmlInit_v2\0")
                    .map_err(|e| format!("Missing nvmlInit_v2: {e}"))?;
                let shutdown: FnShutdown = *lib
                    .get::<FnShutdown>(b"nvmlShutdown\0")
                    .map_err(|e| format!("Missing nvmlShutdown: {e}"))?;
                let error_string: FnErrorString = *lib
                    .get::<FnErrorString>(b"nvmlErrorString\0")
                    .map_err(|e| format!("Missing nvmlErrorString: {e}"))?;
                let get_handle: FnGetHandleByIndex = *lib
                    .get::<FnGetHandleByIndex>(b"nvmlDeviceGetHandleByIndex_v2\0")
                    .map_err(|e| format!("Missing nvmlDeviceGetHandleByIndex_v2: {e}"))?;
                let get_default_pl: FnGetDefaultPowerLimit = *lib
                    .get::<FnGetDefaultPowerLimit>(b"nvmlDeviceGetPowerManagementDefaultLimit\0")
                    .map_err(|e| {
                        format!("Missing nvmlDeviceGetPowerManagementDefaultLimit: {e}")
                    })?;
                let set_pl: FnSetPowerLimit = *lib
                    .get::<FnSetPowerLimit>(b"nvmlDeviceSetPowerManagementLimit\0")
                    .map_err(|e| format!("Missing nvmlDeviceSetPowerManagementLimit: {e}"))?;
                let get_clock_offsets: Option<FnGetClockOffsets> = lib
                    .get::<FnGetClockOffsets>(b"nvmlDeviceGetClockOffsets\0")
                    .ok()
                    .map(|s| *s);
                let set_clock_offsets: Option<FnSetClockOffsets> = lib
                    .get::<FnSetClockOffsets>(b"nvmlDeviceSetClockOffsets\0")
                    .ok()
                    .map(|s| *s);

                let rc = init();
                if rc != NVML_SUCCESS {
                    let msg = CStr::from_ptr(error_string(rc)).to_string_lossy();
                    return Err(format!("nvmlInit_v2 failed: {msg} ({rc})"));
                }

                Ok(Self {
                    _lib: lib,
                    shutdown,
                    error_string,
                    get_handle,
                    get_default_pl,
                    set_pl,
                    get_clock_offsets,
                    set_clock_offsets,
                })
            }
        }

        fn err(&self, op: &str, rc: i32) -> String {
            let msg = unsafe { CStr::from_ptr((self.error_string)(rc)).to_string_lossy() };
            format!("{op} failed: {msg} ({rc})")
        }
    }

    pub fn apply_targets(targets: &[NvmlOcTarget]) -> Result<(), String> {
        if targets.is_empty() {
            return Ok(());
        }
        let nvml = NvmlSession::open()?;
        for t in targets {
            let mut dev: *mut c_void = ptr::null_mut();
            let rc = unsafe { (nvml.get_handle)(t.gpu_index, &mut dev) };
            if rc != NVML_SUCCESS || dev.is_null() {
                return Err(nvml.err(&format!("GPU{} handle", t.gpu_index), rc));
            }

            let limit_mw = if t.power_limit_w > 0 {
                t.power_limit_w.saturating_mul(1000)
            } else {
                let mut def_mw = 0u32;
                let rc = unsafe { (nvml.get_default_pl)(dev, &mut def_mw) };
                if rc != NVML_SUCCESS {
                    return Err(nvml.err(&format!("GPU{} default power limit", t.gpu_index), rc));
                }
                def_mw
            };
            let rc = unsafe { (nvml.set_pl)(dev, limit_mw) };
            if rc != NVML_SUCCESS {
                return Err(nvml.err(&format!("GPU{} set power limit", t.gpu_index), rc));
            }

            if let (Some(get_co), Some(set_co)) = (nvml.get_clock_offsets, nvml.set_clock_offsets) {
                // Core clock offset (GRAPHICS P0)
                let mut core = NvmlClockOffsetV1 {
                    version: NVML_CLOCK_OFFSET_VER1,
                    clock_type: NVML_CLOCK_GRAPHICS,
                    pstate: NVML_PSTATE_0,
                    clock_offset_mhz: 0,
                    min_clock_offset_mhz: 0,
                    max_clock_offset_mhz: 0,
                };
                let rc = unsafe { get_co(dev, &mut core) };
                if rc != NVML_SUCCESS {
                    if t.core_offset_mhz != 0 {
                        return Err(nvml.err(&format!("GPU{} get core offset", t.gpu_index), rc));
                    }
                } else {
                    core.clock_offset_mhz = t
                        .core_offset_mhz
                        .clamp(core.min_clock_offset_mhz, core.max_clock_offset_mhz);
                    let rc = unsafe { set_co(dev, &core) };
                    if rc != NVML_SUCCESS && t.core_offset_mhz != 0 {
                        return Err(nvml.err(&format!("GPU{} set core offset", t.gpu_index), rc));
                    }
                }

                // Memory clock offset (MEM P0 — NVML expects effective MT/s = 2 * base MHz)
                let mut mem = NvmlClockOffsetV1 {
                    version: NVML_CLOCK_OFFSET_VER1,
                    clock_type: NVML_CLOCK_MEM,
                    pstate: NVML_PSTATE_0,
                    clock_offset_mhz: 0,
                    min_clock_offset_mhz: 0,
                    max_clock_offset_mhz: 0,
                };
                let rc = unsafe { get_co(dev, &mut mem) };
                if rc != NVML_SUCCESS {
                    if t.mem_offset_mhz != 0 {
                        return Err(nvml.err(&format!("GPU{} get mem offset", t.gpu_index), rc));
                    }
                } else {
                    mem.clock_offset_mhz = t
                        .mem_offset_mhz
                        .saturating_mul(2)
                        .clamp(mem.min_clock_offset_mhz, mem.max_clock_offset_mhz);
                    let rc = unsafe { set_co(dev, &mem) };
                    if rc != NVML_SUCCESS && t.mem_offset_mhz != 0 {
                        return Err(nvml.err(&format!("GPU{} set mem offset", t.gpu_index), rc));
                    }
                }
            } else if t.core_offset_mhz != 0 || t.mem_offset_mhz != 0 {
                return Err("Clock offsets require NVIDIA driver R555 or newer".to_string());
            }
        }
        Ok(())
    }
}

#[cfg(windows)]
pub use imp::apply_targets;

#[cfg(not(windows))]
pub fn apply_targets(_targets: &[NvmlOcTarget]) -> Result<(), String> {
    Err("NVML OC is only available on Windows".into())
}

/// CLI branch: `--gpu-oc-apply <idx:pl:core:mem> [...]` (used by elevated `gsudo` child).
pub fn run_cli() -> Option<i32> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("--gpu-oc-apply") {
        return None;
    }
    let mut targets = Vec::new();
    for spec in args {
        match parse_target_spec(&spec) {
            Ok(t) => targets.push(t),
            Err(e) => {
                eprintln!("gpu-oc-apply: {e}");
                return Some(2);
            }
        }
    }
    if targets.is_empty() {
        eprintln!("usage: blackwell-ops --gpu-oc-apply <idx:pl:core:mem> [...]");
        return Some(2);
    }
    match apply_targets(&targets) {
        Ok(()) => Some(0),
        Err(e) => {
            eprintln!("gpu-oc-apply: {e}");
            Some(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_round_trip() {
        let t = NvmlOcTarget {
            gpu_index: 1,
            power_limit_w: 0,
            core_offset_mhz: -150,
            mem_offset_mhz: 3000,
        };
        let s = format_target_spec(&t);
        assert_eq!(s, "1:0:-150:3000");
        assert_eq!(parse_target_spec(&s).unwrap(), t);
    }

    #[cfg(windows)]
    #[test]
    fn clock_offset_v1_layout() {
        assert_eq!(std::mem::size_of::<imp::NvmlClockOffsetV1>(), 24);
        assert_eq!(imp::NVML_CLOCK_OFFSET_VER1, 0x0100_0018);
    }
}
