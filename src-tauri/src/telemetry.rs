use serde::{Deserialize, Serialize};
use std::os::windows::process::CommandExt;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use sysinfo::System;

static CPU_SYSTEM: Mutex<Option<System>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuInfo {
    pub index: u32,
    pub name: String,
    pub memory_total: u64,     // MB — BIOS-reported (may be less than manufactured)
    pub memory_used: u64,      // MB
    pub memory_free: u64,      // MB
    pub memory_total_manufactured: u64, // MB — actual card capacity (e.g. 98304 = 96 GB)
    pub temperature_gpu: u32,  // Celsius — core GPU temp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature_hot_spot: Option<u32>, // Deprecated — NVIDIA redacted on recent drivers
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature_memory: Option<u32>, // Deprecated — NVIDIA redacted on recent drivers
    pub power_draw: f32,       // Watts
    pub power_limit: f32,      // Watts
    pub utilization_gpu: u32,  // Percentage
    pub utilization_memory: u32, // Percentage
    #[serde(skip_serializing_if = "Option::is_none")]
    pub driver_version: Option<String>, // e.g. "610.47.23" from nvidia-smi
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpuInfo {
    pub name: String,
    pub cores: usize,
    pub threads: usize,
    pub max_clock_mhz: u32,
    pub avg_usage_percent: f32,
    pub core_usages: Vec<f32>, // per-core usage percentages from PerfMon
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemInfo {
    pub total_memory_mib: u64,              // Real OS-reported usable RAM in MiB (used for calculations)
    pub available_memory_mib: u64,          // Available (free + cache) in MiB
    pub total_memory_manufactured_mib: u64, // Physically installed RAM from hardware (e.g., 256 GB = 262144 MiB)
}

/// Get physically installed RAM from WMI (sum of all memory module capacities).
#[cfg(windows)]
fn get_physical_ram_bytes() -> Result<u64, String> {
    let output = std::process::Command::new("powershell")
        .args(&[
            "-NoProfile", "-NonInteractive", "-Command",
            "(Get-CimInstance Win32_PhysicalMemory | Measure-Object Capacity -Sum).Sum",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| format!("PowerShell WMI query failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let bytes: u64 = stdout.trim().parse().map_err(|_| {
        format!("Failed to parse physical RAM from PowerShell output: {}", stdout)
    })?;
    if bytes < 4 * 1024 * 1024 * 1024 {
        return Err(format!("Physical RAM value too low ({}), likely empty WMI result", bytes));
    }
    Ok(bytes)
}

/// Fallback: use sysinfo total memory as manufactured (same value).
#[cfg(not(windows))]
fn get_physical_ram_bytes() -> Result<u64, String> {
    Err("Not on Windows".into())
}

/// Scan GPUs using nvidia-smi — returns real metrics from NVIDIA drivers
#[tauri::command]
pub async fn scan_gpus() -> Result<Vec<GpuInfo>, String> {
    let output = crate::engine_utils::run_hidden_output_async(|| {
        let mut cmd = std::process::Command::new("nvidia-smi");
        cmd.args([
            "--query-gpu=index,name,driver_version,memory.total,memory.used,memory.free,temperature.gpu,power.draw,power.limit,utilization.gpu,utilization.memory",
            "--format=csv,noheader,nounits",
        ])
        .stdout(Stdio::piped()) // MUST be piped — null() discards output, returns empty GPU list
        .stderr(Stdio::null());
        cmd
    })
    .await
    .map_err(|e| format!("nvidia-smi execution failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);

    if stdout.trim().is_empty() {
        return Ok(vec![]);
    }

    let mut gpus = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // Split from the right: last 9 fields are driver_version + mem/temp/power/util metrics.
        // Everything between index(0) and those fields is the GPU name.
        let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();

        if parts.len() < 10 {
            log::debug!("nvidia-smi line has too few fields ({}): {}", parts.len(), line);
            continue;
        }

        let index: u32 = parts[0].parse().unwrap_or(0);

        let num_trailing = 9;
        let name_end = parts.len() - num_trailing;
        let gpu_name = if name_end > 1 {
            parts[1..name_end].join(", ")
        } else {
            "Unknown GPU".to_string()
        };

        // driver_version, memory.total, mem.used, mem.free, temp.gpu,
        //   power.draw, power.limit, util.gpu, util.mem
        let base = name_end;
        let driver_raw = parts[base].trim();
        let driver_version = if driver_raw.is_empty() || driver_raw == "[N/A]" {
            None
        } else {
            Some(driver_raw.to_string())
        };
        let memory_total: u64 = parts[base + 1].parse().unwrap_or(0);
        let memory_used: u64 = parts[base + 2].parse().unwrap_or(0);
        let memory_free: u64 = parts[base + 3].parse().unwrap_or(0);
        let temperature_gpu: u32 = parts[base + 4].parse().unwrap_or(0);
        let power_draw: f32 = parts[base + 5].parse().unwrap_or(0.0);
        let power_limit: f32 = parts[base + 6].parse().unwrap_or(0.0);
        let utilization_gpu: u32 = parts[base + 7].parse().unwrap_or(0);
        let utilization_memory: u32 = parts[base + 8].parse().unwrap_or(0);

        gpus.push(GpuInfo {
            index,
            name: gpu_name.clone(),
            memory_total,
            memory_used,
            memory_free,
            memory_total_manufactured: manufactured_vram(&gpu_name),
            temperature_gpu,
            temperature_hot_spot: None,
            temperature_memory: None,
            power_draw,
            power_limit,
            utilization_gpu,
            utilization_memory,
            driver_version,
        });
    }

    if gpus.is_empty() {
        return Ok(vec![]);
    }

    Ok(gpus)
}

/// Scan CPU — real-time polling via sysinfo (uses Windows PerfMon PDH API internally).
/// Reuses a single System instance across polls so cpu_usage() has proper baseline deltas.
#[tauri::command]
pub async fn scan_cpu() -> Result<CpuInfo, String> {
    let mut system_guard = CPU_SYSTEM.lock().unwrap();

    // Initialize on first call — fresh snapshot captures initial state
    if system_guard.is_none() {
        *system_guard = Some(System::new_all());
    }

    let system = system_guard.as_mut().unwrap();
    system.refresh_cpu_all();

    let cpus = system.cpus();
    let threads = cpus.len();

    if threads == 0 {
        return Ok(CpuInfo {
            name: "Unknown CPU".to_string(),
            cores: 16,
            threads: 32,
            max_clock_mhz: 0,
            avg_usage_percent: 0.0,
            core_usages: vec![0.0; 32],
        });
    }

    let mut core_usages = Vec::with_capacity(threads);
    for cpu in cpus {
        core_usages.push(cpu.cpu_usage());
    }

    let avg_usage: f32 = if !core_usages.is_empty() {
        core_usages.iter().sum::<f32>() / core_usages.len() as f32
    } else {
        0.0
    };

    Ok(CpuInfo {
        name: cpus[0].brand().to_string(),
        cores: threads / 2,
        threads,
        max_clock_mhz: cpus[0].frequency() as u32,
        avg_usage_percent: avg_usage,
        core_usages,
    })
}

/// Return manufactured VRAM in MB based on GPU model name.
/// nvidia-smi reports BIOS-reserved memory (slightly less than actual card capacity).
fn manufactured_vram(name: &str) -> u64 {
    let lower = name.to_lowercase();
    
    // NVIDIA Blackwell / Ada data center GPUs — known manufactured capacities
    if lower.contains("pro 6000 blackwell") || lower.contains("rtx 6000 ada") { 98304 }      // 96 GB
    else if lower.contains("pro 5000 blackwell") || lower.contains("rtx 5880") { 49152 }     // 48 GB
    else if lower.contains("quadro rtx 8000") { 53248 }                                       // 52 GB
    else if lower.contains("a100") && lower.contains("80") { 81920 }                          // 80 GB
    else if lower.contains("a100") { 40960 }                                                   // 40 GB
    else if lower.contains("h100") || lower.contains("h200") { 81920 }                       // 80 GB
    else if lower.contains("l40") || lower.contains("l40s") { 49152 }                        // 48 GB
    else if lower.contains("a6000") { 49152 }                                                 // 48 GB
    else if lower.contains("v100") && lower.contains("32") { 32768 }                          // 32 GB
    else if lower.contains("v100") { 16384 }                                                  // 16 GB
    else if lower.contains("rtx 4090") { 25600 }                                              // 24 GB
    else if lower.contains("rtx 4080 super") || lower.contains("rtx 4080") { 16384 }          // 16 GB
    else if lower.contains("rtx 4070") { 12288 }                                              // 12 GB
    else if lower.contains("rtx 3090") || lower.contains("rtx 3090 ti") { 24576 }            // 24 GB
    else if lower.contains("rtx 3080") && lower.contains("12") { 12288 }                     // 12 GB
    else if lower.contains("rtx 3080") { 10240 }                                              // 10 GB
    else if lower.contains("rtx 2080 ti") { 11264 }                                           // 11 GB
    else if lower.contains("rtx 2080") || lower.contains("rtx 2070") { 8192 }                // 8 GB
    else if lower.contains("gtx 1080 ti") { 11264 }                                           // 11 GB
    else if lower.contains("gtx 1080") || lower.contains("gtx 1070") { 8192 }                // 8 GB
    else if lower.contains("titan v") { 32768 }                                               // 32 GB
    else if lower.contains("titan rtx") { 24576 }                                             // 24 GB
    else if lower.contains("tesla") || lower.contains("data center") { memory_total_from_name(name) }
    else { 
        // Fallback: BIOS-reported is typically ~98% of manufactured for NVIDIA cards
        // Use a rough estimate based on the BIOS value
        0 // will fall back to BIOS in frontend
    }
}

fn memory_total_from_name(name: &str) -> u64 {
    let lower = name.to_lowercase();
    if lower.contains("a100") && lower.contains("80") { 81920 }
    else if lower.contains("a100") { 40960 }
    else if lower.contains("h100") || lower.contains("h200") { 81920 }
    else if lower.contains("l40") { 49152 }
    else if lower.contains("v100") && lower.contains("32") { 32768 }
    else if lower.contains("p100") { 16384 }
    else { 0 }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DiskIoInfo {
    pub read_mib_per_s: f32,
    pub write_mib_per_s: f32,
}

/// Display cap — perf-counter spikes can report nonsense; Gen5 PHY ~15 GiB/s, headroom to 25.
const MAX_DISK_READ_GIB_PER_S: f32 = 25.0;
const MAX_DISK_READ_MIB_PER_S: f32 = MAX_DISK_READ_GIB_PER_S * 1024.0;

fn clamp_disk_read_mib_per_s(mib: f32) -> f32 {
    if !mib.is_finite() || mib < 0.0 {
        0.0
    } else {
        mib.min(MAX_DISK_READ_MIB_PER_S)
    }
}

#[derive(Clone, Copy)]
struct DiskIoSample {
    read_bps: f32,
    write_bps: f32,
}

static DISK_IO_CACHE: Mutex<DiskIoSample> =
    Mutex::new(DiskIoSample {
        read_bps: 0.0,
        write_bps: 0.0,
    });
static DISK_IO_POLLER_STARTED: AtomicBool = AtomicBool::new(false);

/// PDH sample interval — matches FusionBooter frontend poll (~350ms) without PowerShell spawn overhead.
const DISK_IO_POLL_INTERVAL_MS: u64 = 300;

fn disk_io_poller_disabled() -> bool {
    crate::debug_flags::flags().disable_disk_io
}

/// Start the single global disk I/O poller (idempotent). Called from app setup and first `scan_disk_io`.
pub fn ensure_disk_io_poller() {
    if disk_io_poller_disabled() {
        return;
    }
    if DISK_IO_POLLER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Err(e) = std::thread::Builder::new()
        .name("disk-io-pdh".into())
        .spawn(disk_io_poller_thread)
    {
        log::warn!("[telemetry] disk io poller thread failed to start: {}", e);
    }
}

fn disk_io_poller_thread() {
    #[cfg(windows)]
    {
        let mut sampler = match crate::disk_io_pdh::PdhDiskSampler::new() {
            Ok(s) => s,
            Err(e) => {
                log::warn!("[telemetry] PDH disk sampler init failed: {}", e);
                return;
            }
        };

        loop {
            match sampler.sample() {
                Ok((read, write)) => {
                    if let Ok(mut cache) = DISK_IO_CACHE.lock() {
                        *cache = DiskIoSample {
                            read_bps: read,
                            write_bps: write,
                        };
                    }
                }
                Err(e) => log::debug!("[telemetry] disk io poll failed: {}", e),
            }
            std::thread::sleep(Duration::from_millis(DISK_IO_POLL_INTERVAL_MS));
        }
    }

    #[cfg(not(windows))]
    loop {
        std::thread::sleep(Duration::from_millis(DISK_IO_POLL_INTERVAL_MS));
    }
}

/// Returns the latest cached system disk read/write rates (MiB/s). `slot_idx` is kept for IPC compat only.
#[tauri::command]
pub async fn scan_disk_io(_slot_idx: Option<i32>) -> Result<DiskIoInfo, String> {
    ensure_disk_io_poller();
    let sample = DISK_IO_CACHE
        .lock()
        .map_err(|e| format!("disk io cache lock poisoned: {}", e))?;
    Ok(DiskIoInfo {
        read_mib_per_s: clamp_disk_read_mib_per_s(sample.read_bps / (1024.0 * 1024.0)),
        write_mib_per_s: sample.write_bps / (1024.0 * 1024.0),
    })
}

/// Scan system memory info — total and available RAM in MiB.
#[tauri::command]
pub async fn scan_system_info() -> Result<SystemInfo, String> {
    let mut sys = System::new_all();
    sys.refresh_memory();

    let total = sys.total_memory() / (1024 * 1024);   // bytes → MiB, usable by OS
    let phys_bytes = match get_physical_ram_bytes() {
        Ok(v) => v,
        Err(e) => {
            log::warn!("WMI physical RAM query failed: {}. Falling back to sysinfo.", e);
            sys.total_memory()
        }
    };
    Ok(SystemInfo {
        total_memory_mib: total,
        available_memory_mib: sys.available_memory() / (1024 * 1024),
        total_memory_manufactured_mib: phys_bytes / (1024 * 1024), // bytes → MiB
    })
}

/// Detect physical GPU count via nvidia-smi. Shared across engine, fit_scanner, config.
/// Returns 1 as fallback if detection fails (safer than guessing wrong).
///
/// NOTE: MUST use Stdio::piped() — Stdio::null() discards output and always returns fallback.
/// The null() → piped() change was needed because fd53291 accidentally broke GPU detection by
/// adding Stdio::null() to suppress CMD windows in release builds. CREATE_NO_WINDOW flag handles
/// that; stdout must still be captured for the actual data.
pub fn detect_gpu_count() -> usize {
    let fallback = 1; // Safe default — single GPU rather than guessing wrong
    if let Ok(output) = std::process::Command::new("nvidia-smi")
        .args(&["--query-gpu=index", "--format=csv,noheader"])
        .stdout(Stdio::piped())   // MUST be piped — null() discards output, always returns fallback
        .stderr(Stdio::null())
        .creation_flags(0x08000000) // CREATE_NO_WINDOW — prevents CMD window flash in release builds
        .output()
    {
        let count = String::from_utf8_lossy(&output.stdout)
            .lines().filter(|l| !l.trim().is_empty()).count();
        if count > 0 {
            log::info!("[telemetry] Detected {} GPU(s)", count);
            return count;
        }
    }
    log::warn!("[telemetry] nvidia-smi detection failed, falling back to {} GPU — GPU masking may be incorrect", fallback);
    fallback
}
