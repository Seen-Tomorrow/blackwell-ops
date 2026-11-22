//! DEV tool: hold raw device memory so a card looks like a smaller one.
//!
//! There is no driver knob to shrink an RTX card (no MIG on this SKU, no per-process memory cap),
//! so testing "does this fit on 16 GB" means occupying the difference with something that is not a
//! model. This binary allocates raw VRAM through the CUDA driver API (`nvcuda.dll` follows the
//! display driver - no CUDA toolkit, no gguf, no model load) and closes on the *NVML* free number,
//! which is what the app's glass and occupancy guard read.
//!
//! It runs outside the app on purpose: the memory must belong to another process for the engine to
//! feel it. One process drives one card; the app starts one per selected GPU.
//!
//! ```text
//! vram-ballast --target-free 16384 --device 0      # leave 16 GiB free on GPU-0
//! vram-ballast --status --device 0                 # print what is free now
//! ```
//!
//! Allocations are touched with `cuMemsetD8` on a timer: an untouched allocation can be demoted to
//! shared memory under WDDM pressure, which would silently give the free VRAM back. The amount is
//! fixed after start and never topped up: under an engine that overcommits, demoted pages make NVML
//! report more free for a moment, and allocating on that reading leaves the card permanently below
//! the target.

use std::ffi::c_void;
use std::process::Command;
use std::time::{Duration, Instant};

/// MiB the ballast never takes. The app drives the display from the iGPU, so these cards carry no
/// compositor; this is driver/allocation room, not a desktop share.
const DEFAULT_HEADROOM_MIB: u64 = 512;
/// Below this the win is smaller than the NVML resolution.
const MIN_CHUNK_MIB: u64 = 4;
/// Small slack so allocation rounding cannot push NVML free below the target.
const ROUNDING_RESERVE_MIB: u64 = 16;
/// Keep pages resident.
const TOUCH_INTERVAL: Duration = Duration::from_secs(3);
/// Warn (once) when the card reads this much more free than the target after the hold settled.
const ABOVE_TARGET_WARN_MIB: u64 = 512;

type CuResult = i32;
type CuDevice = i32;
type CuDeviceptr = u64;
type CuContext = *mut c_void;

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryW(name: *const u16) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
    fn GetExitCodeProcess(handle: *mut c_void, code: *mut u32) -> i32;
    fn CloseHandle(handle: *mut c_void) -> i32;
}

/// PROCESS_QUERY_LIMITED_INFORMATION + STILL_ACTIVE.
fn parent_alive(pid: u32) -> bool {
    if pid == 0 {
        return true;
    }
    unsafe {
        let handle = OpenProcess(0x1000, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        ok && code == 259
    }
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

/// `nvmlMemory_t`: total/free/used in bytes.
#[repr(C)]
#[derive(Default)]
struct NvmlMemory {
    total: u64,
    free: u64,
    used: u64,
}

/// NVML, loaded in-process. Spawning `nvidia-smi` per step costs ~200 ms on Windows, which was
/// the whole cost of the fill loop; the library answers in microseconds.
struct NvmlApi {
    _module: *mut c_void,
    init: unsafe extern "system" fn() -> i32,
    get_handle_by_index: unsafe extern "system" fn(u32, *mut *mut c_void) -> i32,
    get_memory_info: unsafe extern "system" fn(*mut c_void, *mut NvmlMemory) -> i32,
}

impl NvmlApi {
    fn load() -> Option<Self> {
        unsafe {
            let module = LoadLibraryW(wide("nvml.dll").as_ptr());
            if module.is_null() {
                return None;
            }
            let sym = |name: &str| GetProcAddress(module, narrow(name).as_ptr());
            let init = sym("nvmlInit_v2");
            let get_handle_by_index = sym("nvmlDeviceGetHandleByIndex_v2");
            let get_memory_info = sym("nvmlDeviceGetMemoryInfo");
            if init.is_null() || get_handle_by_index.is_null() || get_memory_info.is_null() {
                return None;
            }
            let api = NvmlApi {
                _module: module,
                init: std::mem::transmute(init),
                get_handle_by_index: std::mem::transmute(get_handle_by_index),
                get_memory_info: std::mem::transmute(get_memory_info),
            };
            if (api.init)() != 0 {
                return None;
            }
            Some(api)
        }
    }

    unsafe fn mem_info_mib(&self, index: u32) -> Option<(u64, u64)> {
        let mut handle: *mut c_void = std::ptr::null_mut();
        if (self.get_handle_by_index)(index, &mut handle) != 0 || handle.is_null() {
            return None;
        }
        let mut mem = NvmlMemory::default();
        if (self.get_memory_info)(handle, &mut mem) != 0 {
            return None;
        }
        Some((mem.free / 1048576, mem.total / 1048576))
    }
}

/// NVML free/total for one card, with an `nvidia-smi` fallback.
///
/// NVML is the reference because it is what the app's glass and occupancy guard read.
struct VramReader {
    device: u32,
    nvml: Option<NvmlApi>,
}

impl VramReader {
    fn new(device: u32) -> Self {
        Self {
            device,
            nvml: NvmlApi::load(),
        }
    }

    fn free_mib(&self) -> Result<(u64, u64), String> {
        if let Some(nvml) = self.nvml.as_ref() {
            if let Some((free, total)) = unsafe { nvml.mem_info_mib(self.device) } {
                return Ok((total, free));
            }
        }
        nvidia_smi_free_mib(self.device)
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

/// Read NVML until two consecutive samples agree within 64 MiB.
///
/// NVML books a new CUDA context and freshly allocated chunks with up to ~1 s of lag. Planning
/// against a number that is still moving is what put the hold a few hundred MiB off the target
/// (the context alone is ~480 MiB), so sample until it stands still instead of trusting one read.
fn settled_free(reader: &VramReader, timeout: Duration) -> Result<(u64, u64), String> {
    let deadline = Instant::now() + timeout;
    let mut last = reader.free_mib()?;
    loop {
        if Instant::now() >= deadline {
            return Ok(last);
        }
        std::thread::sleep(Duration::from_millis(100));
        let next = reader.free_mib()?;
        if last.1.abs_diff(next.1) <= 64 {
            return Ok(next);
        }
        last = next;
    }
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

    /// Take one chunk and make its pages resident. Returns the CUDA result on failure.
    fn try_allocate(&mut self, mib: u64) -> Result<(), i32> {
        let bytes = (mib as usize) * 1048576;
        let mut dptr: CuDeviceptr = 0;
        let rc = unsafe { (self.api.cu_mem_alloc)(&mut dptr, bytes) };
        if rc != 0 {
            return Err(rc);
        }
        unsafe { (self.api.cu_memset_d8)(dptr, 1, bytes) };
        self.ptrs.push(dptr);
        self.sizes.push(bytes);
        Ok(())
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
         One process per card. The allocation is raw device memory (no model); it is touched\n\
         every 3 s so WDDM cannot demote it. It refuses to leave less than {DEFAULT_HEADROOM_MIB} MiB free (--headroom)."
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut target: Option<u64> = None;
    let mut device: u32 = 0;
    let mut seconds: Option<u64> = None;
    let mut status = false;
    let mut parent_pid: u32 = 0;
    let mut headroom_mib: u64 = DEFAULT_HEADROOM_MIB;

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
            "--parent-pid" => {
                i += 1;
                parent_pid = args.get(i).and_then(|v| v.parse().ok()).unwrap_or(0);
            }
            "--headroom" => {
                i += 1;
                headroom_mib = args
                    .get(i)
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(DEFAULT_HEADROOM_MIB);
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

    let reader = VramReader::new(device);

    if status {
        match reader.free_mib() {
            Ok((total, free)) => {
                println!(
                    "GPU-{device}: total {total} MiB, free {free} MiB, used+reserved {} MiB",
                    total - free
                );
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

    // The context itself takes a little VRAM and NVML books it a moment later. Plan against the
    // settled number, otherwise the ballast overshoots by the context size.
    let (total, free_now) = match settled_free(&reader, Duration::from_secs(2)) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    if target.saturating_add(headroom_mib) > total {
        eprintln!(
            "target {target} MiB leaves less than {headroom_mib} MiB on a {total} MiB card - refusing"
        );
        std::process::exit(2);
    }
    if free_now <= target {
        eprintln!(
            "the card already shows {free_now} MiB free, at or below the target {target} - another process holds it, holding nothing"
        );
    }
    println!(
        "GPU-{device}: total {total} MiB, free {free_now} MiB - target free {target} MiB (will hold ~{} MiB)",
        free_now.saturating_sub(target)
    );

    let mut held = Allocations {
        api,
        ptrs: Vec::new(),
        sizes: Vec::new(),
        last_touch: Instant::now(),
    };
    let started = Instant::now();

    // Plan from local accounting, never from a fresh NVML read between steps: NVML counts a new
    // allocation about a second late, and a loop that trusts it overshoots by gigabytes (measured:
    // 4 GiB over the target). One read at the start, subtract every allocation here, verify once.
    let want = free_now.saturating_sub(target).saturating_sub(ROUNDING_RESERVE_MIB);
    let mut chunk = want;
    while held.allocated_mib() < want {
        let step = (want - held.allocated_mib()).min(chunk);
        if step < MIN_CHUNK_MIB {
            break;
        }
        match held.try_allocate(step) {
            Ok(()) => println!("+{step:>5} MiB  held {:>5} MiB", held.allocated_mib()),
            Err(rc) => {
                if step <= MIN_CHUNK_MIB {
                    eprintln!(
                        "allocation of {step} MiB failed (CUresult {rc}) - holding {} MiB",
                        held.allocated_mib()
                    );
                    break;
                }
                chunk = (step / 2).max(MIN_CHUNK_MIB);
                eprintln!(
                    "allocation of {step} MiB failed (CUresult {rc}) - retrying in {chunk} MiB steps"
                );
            }
        }
    }

    // NVML books a fresh allocation up to ~1 s late, and the printed numbers (plus the app's glass)
    // read NVML, not our bookkeeping. Wait for it to catch up before reporting.
    let expected_free = free_now.saturating_sub(held.allocated_mib());
    let settle_deadline = Instant::now() + Duration::from_secs(3);
    let mut free = reader.free_mib().map(|(_, f)| f).unwrap_or(0);
    while free > expected_free + 32 && Instant::now() < settle_deadline {
        std::thread::sleep(Duration::from_millis(50));
        free = reader.free_mib().map(|(_, f)| f).unwrap_or(free);
    }
    if free > expected_free + 128 {
        eprintln!(
            "NVML still reports {free} MiB free (expected ~{expected_free}) - it may lag; the hold stays fixed"
        );
    }

    let (total_now, free_after) = reader.free_mib().unwrap_or((total, free));
    let (cuda_free, _) = unsafe { held.api.mem_info_mib() };
    let delta = free_after as i64 - target as i64;
    println!(
        "holding {} MiB - NVML free {free_after} MiB of {total_now} MiB (target {target}, off by {delta:+} MiB), CUDA free {cuda_free} MiB",
        held.allocated_mib()
    );

    // Hold. Ctrl+C or --seconds ends it; process exit releases the memory either way.
    let mut warned_above = false;
    loop {
        if let Some(limit) = seconds {
            if started.elapsed() >= Duration::from_secs(limit) {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(500));
        if !parent_alive(parent_pid) {
            println!("parent process exited - releasing");
            break;
        }
        if held.last_touch.elapsed() >= TOUCH_INTERVAL {
            held.re_touch();
            // Report only: the hold is fixed on purpose. An engine that overcommits makes the
            // driver demote ballast pages, so NVML free rises; re_touch pulls the same pages back
            // and free returns to the target once that engine exits. Adding memory on top of the
            // stale high reading is what left cards ~0.4 GiB below target, permanently.
            let free = reader.free_mib().map(|(_, f)| f).unwrap_or(0);
            if free > target + ABOVE_TARGET_WARN_MIB {
                if !warned_above {
                    warned_above = true;
                    println!(
                        "NVML free {free} MiB is above target {target} (pages demoted, or another process released memory) - hold stays fixed; RELEASE/HOLD to re-plan"
                    );
                }
            } else {
                warned_above = false;
            }
        }
        if held.allocated_mib() == 0 {
            break;
        }
    }

    held.free_all();
    println!("released");
}
