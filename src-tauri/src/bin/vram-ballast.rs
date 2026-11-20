//! DEV tool: hold raw device memory so a card looks like a smaller one.
//!
//! There is no driver knob to shrink an RTX card (no MIG on this SKU, no per-process memory cap),
//! so testing "does this fit on 16 GB" means occupying the difference with something that is not a
//! model. This binary allocates raw VRAM through the CUDA driver API (`nvcuda.dll` follows the
//! display driver - no CUDA toolkit, no gguf, no model load) and closes on the *NVML* free number,
//! which is what the app's glass and occupancy guard read.
//!
//! It runs outside the app on purpose: the memory must belong to another process for the engine to
//! feel it.
//!
//! ```text
//! vram-ballast --target-free 16384 --device 0      # leave 16 GiB free on GPU-0
//! vram-ballast --status --device 0                 # print what is free now
//! ```
//!
//! Allocations are touched with `cuMemsetD8` on a timer: an untouched allocation can be demoted to
//! shared memory under WDDM pressure, which would silently give the free VRAM back.

use std::ffi::c_void;
use std::process::Command;
use std::time::{Duration, Instant};

/// MiB the ballast never takes: the desktop compositor needs room or the display resets.
const DESKTOP_HEADROOM_MIB: u64 = 1536;
/// Largest single step; chunks shrink as the target approaches.
const MAX_CHUNK_MIB: u64 = 1024;
/// Below this the win is smaller than the NVML resolution.
const MIN_CHUNK_MIB: u64 = 4;
/// Keep pages resident.
const TOUCH_INTERVAL: Duration = Duration::from_secs(3);

type CuResult = i32;
type CuDevice = i32;
type CuDeviceptr = u64;
type CuContext = *mut c_void;

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryW(name: *const u16) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// GetProcAddress takes an ANSI C string, never the wide LoadLibrary form.
fn narrow(s: &str) -> Vec<u8> {
    s.bytes().chain(std::iter::once(0)).collect()
}

struct CudaApi {
    _module: *mut c_void,
    cu_init: unsafe extern "system" fn(u32) -> CuResult,
    cu_device_get: unsafe extern "system" fn(*mut CuDevice, i32) -> CuResult,
    cu_device_primary_ctx_retain: unsafe extern "system" fn(*mut CuContext, CuDevice) -> CuResult,
    cu_ctx_set_current: unsafe extern "system" fn(CuContext) -> CuResult,
    cu_mem_get_info: unsafe extern "system" fn(*mut usize, *mut usize) -> CuResult,
    cu_mem_alloc: unsafe extern "system" fn(*mut CuDeviceptr, usize) -> CuResult,
    cu_mem_free: unsafe extern "system" fn(CuDeviceptr) -> CuResult,
    cu_memset_d8: unsafe extern "system" fn(CuDeviceptr, u8, usize) -> CuResult,
}

impl CudaApi {
    fn load() -> Result<Self, String> {
        unsafe {
            let module = LoadLibraryW(wide("nvcuda.dll").as_ptr());
            if module.is_null() {
                return Err("nvcuda.dll not found (no NVIDIA display driver?)".into());
            }
            let sym = |name: &str| -> Result<*mut c_void, String> {
                let p = GetProcAddress(module, narrow(name).as_ptr());
                if p.is_null() {
                    Err(format!("nvcuda.dll has no {name}"))
                } else {
                    Ok(p)
                }
            };
            let api = CudaApi {
                _module: module,
                cu_init: std::mem::transmute(sym("cuInit")?),
                cu_device_get: std::mem::transmute(sym("cuDeviceGet")?),
                cu_device_primary_ctx_retain: std::mem::transmute(sym("cuDevicePrimaryCtxRetain")?),
                cu_ctx_set_current: std::mem::transmute(sym("cuCtxSetCurrent")?),
                cu_mem_get_info: std::mem::transmute(sym("cuMemGetInfo_v2")?),
                cu_mem_alloc: std::mem::transmute(sym("cuMemAlloc_v2")?),
                cu_mem_free: std::mem::transmute(sym("cuMemFree_v2")?),
                cu_memset_d8: std::mem::transmute(sym("cuMemsetD8_v2")?),
            };
            let rc = (api.cu_init)(0);
            if rc != 0 {
                return Err(format!("cuInit failed with CUresult {rc}"));
            }
            Ok(api)
        }
    }

    unsafe fn bind(&self, index: u32) -> Result<(), String> {
        let mut dev: CuDevice = 0;
        let rc = (self.cu_device_get)(&mut dev, index as i32);
        if rc != 0 {
            return Err(format!("cuDeviceGet({index}) failed with CUresult {rc}"));
        }
        let mut ctx: CuContext = std::ptr::null_mut();
        let rc = (self.cu_device_primary_ctx_retain)(&mut ctx, dev);
        if rc != 0 {
            return Err(format!("cuDevicePrimaryCtxRetain failed with CUresult {rc}"));
        }
        let rc = (self.cu_ctx_set_current)(ctx);
        if rc != 0 {
            return Err(format!("cuCtxSetCurrent failed with CUresult {rc}"));
        }
        Ok(())
    }

    unsafe fn mem_info_mib(&self) -> (u64, u64) {
        let mut free: usize = 0;
        let mut total: usize = 0;
        if (self.cu_mem_get_info)(&mut free, &mut total) != 0 {
            return (0, 0);
        }
        ((free / 1048576) as u64, (total / 1048576) as u64)
    }
}

fn nvidia_smi_free_mib(index: u32) -> Result<(u64, u64), String> {
    let out = Command::new("nvidia-smi")
        .args([
            "--query-gpu=index,memory.total,memory.free",
            "--format=csv,noheader,nounits",
            "-i",
            &index.to_string(),
        ])
        .output()
        .map_err(|e| format!("cannot run nvidia-smi: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "nvidia-smi failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find(|l| !l.trim().is_empty()).ok_or("nvidia-smi returned nothing")?;
    let parts: Vec<&str> = line.split(',').map(str::trim).collect();
    if parts.len() < 3 {
        return Err(format!("unexpected nvidia-smi row: {line}"));
    }
    let total: u64 = parts[1].parse().map_err(|_| format!("bad total in {line}"))?;
    let free: u64 = parts[2].parse().map_err(|_| format!("bad free in {line}"))?;
    Ok((total, free))
}

fn parse_mib(value: &str) -> Option<u64> {
    let v = value.trim().to_lowercase();
    if let Some(gb) = v.strip_suffix("gb") {
        return gb.trim().parse::<u64>().ok().map(|n| n * 1024);
    }
    if let Some(gib) = v.strip_suffix("gib") {
        return gib.trim().parse::<u64>().ok().map(|n| n * 1024);
    }
    if let Some(mb) = v.strip_suffix("mb") {
        return mb.trim().parse::<u64>().ok();
    }
    v.parse::<u64>().ok()
}

/// Next allocation step: shrink towards the target so the last MiB are not overshot.
fn next_chunk_mib(free_mib: u64, target_mib: u64) -> u64 {
    if free_mib <= target_mib {
        return 0;
    }
    ((free_mib - target_mib) / 8).min(MAX_CHUNK_MIB)
}

struct Allocations {
    api: CudaApi,
    ptrs: Vec<CuDeviceptr>,
    sizes: Vec<usize>,
    last_touch: Instant,
}

impl Allocations {
    fn allocated_mib(&self) -> u64 {
        (self.sizes.iter().sum::<usize>() as u64) / 1048576
    }

    /// Touch the first page of every 64 MiB: enough to keep the physical pages attached.
    fn re_touch(&mut self) {
        for (dptr, size) in self.ptrs.iter().zip(self.sizes.iter()) {
            let mut page = *dptr;
            let end = dptr.saturating_add(*size as u64);
            while page < end {
                unsafe { (self.api.cu_memset_d8)(page, 1, 4096) };
                page = page.saturating_add(64 * 1048576);
            }
        }
        self.last_touch = Instant::now();
    }

    fn free_all(&mut self) {
        for dptr in self.ptrs.drain(..) {
            unsafe { (self.api.cu_mem_free)(dptr) };
        }
        self.sizes.clear();
    }
}

fn usage() {
    eprintln!(
        "vram-ballast - hold VRAM so a card looks smaller (DEV tool)\n\
         \n\
         Usage:\n\
           vram-ballast --target-free <16gb|16384> [--device N] [--seconds S]\n\
           vram-ballast --status [--device N]\n\
         \n\
         --target-free   MiB (or Ngb) that must stay FREE on the card\n\
         --device        CUDA device index (default 0)\n\
         --seconds       stop automatically after N seconds (default: run until Ctrl+C)\n\
         \n\
         The allocation is raw device memory (no model); it is touched every 3 s so WDDM\n\
         cannot demote it to shared RAM. It refuses to leave less than {DESKTOP_HEADROOM_MIB} MiB free."
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut target: Option<u64> = None;
    let mut device: u32 = 0;
    let mut seconds: Option<u64> = None;
    let mut status = false;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--target-free" | "--target" => {
                i += 1;
                target = args.get(i).and_then(|v| parse_mib(v));
                if target.is_none() {
                    eprintln!("--target-free needs a value like 16gb or 16384");
                    std::process::exit(2);
                }
            }
            "--device" => {
                i += 1;
                device = args
                    .get(i)
                    .and_then(|v| v.parse().ok())
                    .unwrap_or_else(|| {
                        eprintln!("--device needs an index");
                        std::process::exit(2);
                    });
            }
            "--seconds" => {
                i += 1;
                seconds = args.get(i).and_then(|v| v.parse().ok());
            }
            "--status" => status = true,
            "--help" | "-h" => {
                usage();
                return;
            }
            other => {
                eprintln!("unknown argument: {other}");
                usage();
                std::process::exit(2);
            }
        }
        i += 1;
    }

    if status {
        match nvidia_smi_free_mib(device) {
            Ok((total, free)) => {
                println!("GPU-{device}: total {total} MiB, free {free} MiB, used {} MiB", total - free);
                if let Ok(api) = CudaApi::load() {
                    unsafe {
                        let _ = api.bind(device);
                        let (cf, ct) = api.mem_info_mib();
                        println!("  CUDA view: free {cf} MiB of {ct} MiB (WDDM budget may exceed NVML)");
                    }
                }
            }
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
        return;
    }

    let Some(target) = target else {
        usage();
        std::process::exit(2);
    };

    let (total, free_now) = match nvidia_smi_free_mib(device) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    if target + DESKTOP_HEADROOM_MIB > total {
        eprintln!(
            "target {target} MiB leaves less than {DESKTOP_HEADROOM_MIB} MiB on a {total} MiB card - refusing"
        );
        std::process::exit(2);
    }
    println!(
        "GPU-{device}: total {total} MiB, free {free_now} MiB - target free {target} MiB (will hold ~{} MiB)",
        free_now.saturating_sub(target)
    );

    let api = match CudaApi::load() {
        Ok(api) => api,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    unsafe {
        if let Err(e) = api.bind(device) {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }

    let mut held = Allocations {
        api,
        ptrs: Vec::new(),
        sizes: Vec::new(),
        last_touch: Instant::now(),
    };
    let started = Instant::now();

    // Allocate towards the target: the step shrinks as the gap closes, so the last chunk is small.
    loop {
        if let Some(limit) = seconds {
            if started.elapsed() >= Duration::from_secs(limit) {
                break;
            }
        }
        let free = match nvidia_smi_free_mib(device) {
            Ok((_, free)) => free,
            Err(e) => {
                eprintln!("{e}");
                break;
            }
        };
        let chunk = next_chunk_mib(free, target);
        if chunk < MIN_CHUNK_MIB {
            break;
        }
        let bytes = (chunk as usize) * 1048576;
        let mut dptr: CuDeviceptr = 0;
        let rc = unsafe { (held.api.cu_mem_alloc)(&mut dptr, bytes) };
        if rc != 0 {
            eprintln!("allocation of {chunk} MiB failed (CUresult {rc}) - holding what fits");
            break;
        }
        unsafe { (held.api.cu_memset_d8)(dptr, 1, bytes) };
        held.ptrs.push(dptr);
        held.sizes.push(bytes);
        println!(
            "+{chunk:>5} MiB  held {:>5} MiB  NVML free {:>5} MiB",
            held.allocated_mib(),
            free.saturating_sub(chunk)
        );
        std::thread::sleep(Duration::from_millis(200));
    }

    let (total_now, free_after) = nvidia_smi_free_mib(device).unwrap_or((total, 0));
    let (cuda_free, _) = unsafe { held.api.mem_info_mib() };
    let delta = free_after as i64 - target as i64;
    println!(
        "holding {} MiB - NVML free {free_after} MiB of {total_now} MiB (target {target}, off by {delta:+} MiB), CUDA free {cuda_free} MiB",
        held.allocated_mib()
    );

    // Hold. Ctrl+C or --seconds ends it; process exit releases the memory either way.
    loop {
        if let Some(limit) = seconds {
            if started.elapsed() >= Duration::from_secs(limit) {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(500));
        if held.last_touch.elapsed() >= TOUCH_INTERVAL {
            held.re_touch();
            let free = nvidia_smi_free_mib(device).map(|(_, f)| f).unwrap_or(0);
            if free > target + 512 {
                println!("free crept up to {free} MiB - the driver demoted pages, re-touching");
            }
        }
        if held.allocated_mib() == 0 {
            break;
        }
    }

    held.free_all();
    println!("released");
}
