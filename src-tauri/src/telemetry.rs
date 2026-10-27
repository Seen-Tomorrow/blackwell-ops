use serde::{Deserialize, Serialize};
use std::os::windows::process::CommandExt;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
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
    pub driver_version: Option<String>,
    /// Windows: `TCC` | `WDDM` | omitted.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub driver_model: String,
    /// Negotiated PCIe link generation (drops at idle); NVML, device-wide.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pcie_gen: Option<u32>,
    /// PCIe slot/card capability generation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pcie_gen_max: Option<u32>,
    /// Negotiated PCIe link width.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pcie_width: Option<u32>,
    /// PCIe capability width of the slot/card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pcie_width_max: Option<u32>,
    /// PCIe traffic into the GPU, MiB/s (all processes on that card).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pcie_rx_mib_per_s: Option<f32>,
    /// PCIe traffic out of the GPU, MiB/s.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pcie_tx_mib_per_s: Option<f32>,
    /// Current memory clock, MHz (NVML).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mem_clock_mhz: Option<u32>,
    /// `nvmlClocksThrottleReason_t` bitmask (thermal/power/idle reasons).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub throttle_reasons: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpuInfo {
    pub name: String,
    pub cores: usize,
    pub threads: usize,
    /// Advertised / peak clock (MHz).
    pub max_clock_mhz: u32,
    /// Live average clock when available (MHz). Omitted/0 if unknown.
    #[serde(default)]
    pub current_clock_mhz: u32,
    pub avg_usage_percent: f32,
    pub core_usages: Vec<f32>, // per-core usage percentages from PerfMon
}

/// Cached WMI MaxClockSpeed — base advertised MHz (not turbo peak).
static CPU_BASE_CLOCK_MHZ: Mutex<Option<u32>> = Mutex::new(None);

#[cfg(windows)]
static CPU_PDH_PERF: Mutex<Option<crate::disk_io_pdh::PdhCpuPerfSampler>> = Mutex::new(None);

/// One-shot WMI MaxClockSpeed (MHz) — Windows “base” clock; turbo is via % Performance.
#[cfg(windows)]
fn wmi_base_clock_mhz() -> Option<u32> {
    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-CimInstance Win32_Processor | Measure-Object -Property MaxClockSpeed -Maximum).Maximum",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let v: u32 = text.trim().parse().ok()?;
    if (400..=10_000).contains(&v) {
        Some(v)
    } else {
        None
    }
}

#[cfg(not(windows))]
fn wmi_base_clock_mhz() -> Option<u32> {
    None
}

fn cached_base_clock_mhz(fallback: u32) -> u32 {
    let mut guard = CPU_BASE_CLOCK_MHZ.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(v) = *guard {
        return v;
    }
    let v = wmi_base_clock_mhz().unwrap_or(fallback).max(fallback);
    if v > 0 {
        *guard = Some(v);
    }
    v
}

/// Live MHz from PDH `% Processor Performance` × base.
/// Registry ~MHz / WMI CurrentClockSpeed / `Processor Frequency` stay glued to base
/// on modern AMD/Intel — only the performance % counter tracks turbo.
#[cfg(windows)]
fn live_cpu_clock_mhz(base_mhz: u32) -> Option<u32> {
    if base_mhz < 400 {
        return None;
    }
    let mut guard = CPU_PDH_PERF.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        match crate::disk_io_pdh::PdhCpuPerfSampler::new() {
            Ok(s) => *guard = Some(s),
            Err(e) => {
                log::debug!("CPU PDH perf sampler unavailable: {e}");
                return None;
            }
        }
    }
    let pct = guard.as_mut()?.sample_performance_pct()?;
    // 100% = base; turbo often 110–160% (e.g. 4300 × 1.24 ≈ 5330).
    let live = (base_mhz as f64 * (pct / 100.0)).round() as u32;
    if (400..=12_000).contains(&live) {
        Some(live)
    } else {
        None
    }
}

#[cfg(not(windows))]
fn live_cpu_clock_mhz(_base_mhz: u32) -> Option<u32> {
    None
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemInfo {
    pub total_memory_mib: u64,              // Real OS-reported usable RAM in MiB (used for calculations)
    pub available_memory_mib: u64,          // Available (free + cache) in MiB
    pub total_memory_manufactured_mib: u64, // Physically installed RAM from hardware (e.g., 256 GB = 262144 MiB)
}

/// Physically installed RAM (bytes) straight from the kernel.
///
/// The old probe spawned PowerShell + a CIM query (~318 ms CPU on the dev box) and ran
/// on every 2 s RAM poll. The installed capacity cannot change while the app runs, so
/// one call is cached for the process.
#[cfg(windows)]
fn get_physical_ram_bytes() -> Result<u64, String> {
    use windows_sys::Win32::System::SystemInformation::GetPhysicallyInstalledSystemMemory;

    let mut kib: u64 = 0;
    // SAFETY: out-pointer is a valid u64 the API fills with KiB.
    let ok = unsafe { GetPhysicallyInstalledSystemMemory(&mut kib) };
    if ok == 0 {
        return Err("GetPhysicallyInstalledSystemMemory failed".to_string());
    }
    if kib < 4 * 1024 * 1024 {
        return Err(format!(
            "Physical RAM value too low ({} KiB), likely a bogus SMBIOS read",
            kib
        ));
    }
    Ok(kib * 1024)
}

/// Fallback: use sysinfo total memory as manufactured (same value).
#[cfg(not(windows))]
fn get_physical_ram_bytes() -> Result<u64, String> {
    Err("Not on Windows".into())
}

static PHYSICAL_RAM_BYTES: LazyLock<Option<u64>> = LazyLock::new(|| {
    let bytes = get_physical_ram_bytes().ok();
    if bytes.is_none() {
        log::warn!(
            "[telemetry] physical RAM unavailable; reporting usable RAM as manufactured"
        );
    }
    bytes
});

/// Installed RAM in bytes, `None` when the platform cannot answer.
fn physical_ram_bytes() -> Option<u64> {
    *PHYSICAL_RAM_BYTES
}

/// How long spawning stops after nvidia-smi fails.
const SMI_COOLDOWN: Duration = Duration::from_secs(5);

/// What this poll is allowed to do, decided by [`smi_gate`].
#[derive(Debug)]
enum SmiGate {
    /// Spawn nvidia-smi.
    Proceed,
    /// Cooling down — serve the previous snapshot instead of spawning.
    Cached(Vec<GpuInfo>),
    /// Cooling down with nothing ever cached — fail without spawning.
    Wait,
}

/// Failure backoff for `scan_gpus`.
///
/// This command is polled continuously, and until now every poll spawned
/// `nvidia-smi.exe` unconditionally and returned `Err` when the spawn was refused. A
/// driver that stops answering therefore turned every poll into another doomed
/// `CreateProcess`, forever, with no backoff and a `log::warn` per attempt — which in
/// REL surfaced as a popup storm stacked on top of the stall that caused it.
///
/// After a failure, spawning stops for [`SMI_COOLDOWN`] and the last good snapshot is
/// served instead. Serving stale values is deliberate: the alternative is a blank GPU
/// view for the duration of a transient stall, and these numbers are a monitor.
struct SmiState {
    last_good: Option<Vec<GpuInfo>>,
    /// `None` = healthy. `Some(t)` = do not spawn before `t`.
    retry_after: Option<Instant>,
}

static SMI_STATE: Mutex<SmiState> = Mutex::new(SmiState {
    last_good: None,
    retry_after: None,
});

fn smi_gate() -> SmiGate {
    // Poison-tolerant: a panic elsewhere must not switch GPU telemetry off for the
    // rest of the session.
    let mut state = SMI_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // Compare the Instants instead of subtracting a Duration from one — a bare
    // `Instant - Duration` panics when the result would precede boot.
    if state.retry_after.is_some_and(|until| Instant::now() < until) {
        return match state.last_good.clone() {
            Some(cached) => SmiGate::Cached(cached),
            None => SmiGate::Wait,
        };
    }
    state.retry_after = None;
    SmiGate::Proceed
}

fn smi_record_success(gpus: &[GpuInfo]) {
    let mut state = SMI_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    state.last_good = Some(gpus.to_vec());
    state.retry_after = None;
}

fn smi_record_failure(error: &str) {
    let mut state = SMI_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // Only the first failure of a streak logs. The retry attempts are silent, because
    // one line per poll is exactly the flood this replaces.
    let streak_started = state.retry_after.is_none();
    state.retry_after = Some(Instant::now() + SMI_COOLDOWN);
    if streak_started {
        log::warn!(
            "nvidia-smi failed; GPU polling pauses for {}s: {}",
            SMI_COOLDOWN.as_secs(),
            error
        );
    }
}

/// Scan GPUs — NVML first, `nvidia-smi` only as a fallback.
///
/// The hardware monitor polls this at 4 Hz. Each `nvidia-smi` spawn cost ~56 ms CPU /
/// ~90 ms wall on the dev box, and it is only a CLI over the same NVML library, so the
/// fast path reads NVML in process. The CLI path stays for drivers where `nvml.dll`
/// cannot load/init, and keeps its failure backoff ([`SmiState`]).
#[tauri::command]
pub async fn scan_gpus() -> Result<Vec<GpuInfo>, String> {
    if let Some(gpus) = nvml_gpus_off_thread().await {
        return Ok(gpus);
    }

    match smi_gate() {
        SmiGate::Cached(cached) => return Ok(cached),
        SmiGate::Wait => return Err("nvidia-smi unavailable (cooling down)".to_string()),
        SmiGate::Proceed => {}
    }

    match run_nvidia_smi().await {
        Ok(gpus) => {
            smi_record_success(&gpus);
            Ok(gpus)
        }
        Err(error) => {
            smi_record_failure(&error);
            Err(error)
        }
    }
}

/// NVML calls block inside the driver (the link counters sample ~32 ms), so they run on the
/// blocking pool — a slow read must never occupy an async worker that IPC also needs.
async fn nvml_gpus_off_thread() -> Option<Vec<GpuInfo>> {
    tauri::async_runtime::spawn_blocking(nvml_gpus)
        .await
        .ok()
        .flatten()
}

/// NVML snapshot mapped onto the IPC shape. `None` = no usable NVML, use the CLI path.
fn nvml_gpus() -> Option<Vec<GpuInfo>> {
    let samples = crate::nvml_metrics::scan()?;
    Some(
        samples
            .into_iter()
            .map(|s| {
                let manufactured = manufactured_vram(&s.name);
                GpuInfo {
                    index: s.index,
                    name: s.name,
                    memory_total: s.memory_total_mib,
                    memory_used: s.memory_used_mib,
                    memory_free: s.memory_free_mib,
                    memory_total_manufactured: manufactured,
                    temperature_gpu: s.temperature_gpu,
                    temperature_hot_spot: None,
                    temperature_memory: None,
                    power_draw: s.power_draw_w,
                    power_limit: s.power_limit_w,
                    utilization_gpu: s.utilization_gpu,
                    utilization_memory: s.utilization_memory,
                    driver_version: s.driver_version,
                    driver_model: s.driver_model,
                    pcie_gen: s.metrics.gen,
                    pcie_gen_max: s.metrics.gen_max,
                    pcie_width: s.metrics.width,
                    pcie_width_max: s.metrics.width_max,
                    pcie_rx_mib_per_s: s.metrics.rx_mib_per_s,
                    pcie_tx_mib_per_s: s.metrics.tx_mib_per_s,
                    mem_clock_mhz: s.metrics.mem_clock_mhz,
                    throttle_reasons: s.metrics.throttle_reasons,
                }
            })
            .collect(),
    )
}

async fn run_nvidia_smi() -> Result<Vec<GpuInfo>, String> {
    let smi = crate::engine_utils::resolve_nvidia_smi_path();
    let output = crate::engine_utils::run_hidden_output_async(move || {
        let mut cmd = std::process::Command::new(&smi);
        cmd.args([
            "--query-gpu=index,name,driver_version,memory.total,memory.used,memory.free,temperature.gpu,power.draw,power.limit,utilization.gpu,utilization.memory,driver_model.current,pci.bus_id",
            "--format=csv,noheader,nounits",
        ])
        .stdout(Stdio::piped())
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

        // Last 11 fields: driver_version + mem/temp/power/util + driver_model + pci.bus_id.
        let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();

        if parts.len() < 12 {
            log::debug!("nvidia-smi line has too few fields ({}): {}", parts.len(), line);
            continue;
        }

        let index: u32 = parts[0].parse().unwrap_or(0);

        let num_trailing = 11;
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
        let driver_model = {
            let raw = parts.get(base + 9).copied().unwrap_or("").to_uppercase();
            if raw.contains("TCC") {
                "TCC".into()
            } else if raw.contains("WDDM") {
                "WDDM".into()
            } else {
                String::new()
            }
        };
        let pci_bus_id = parts.get(base + 10).copied().unwrap_or("").trim();
        let metrics = crate::nvml_metrics::gpu_metrics(pci_bus_id, index);

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
            driver_model,
            pcie_gen: metrics.gen,
            pcie_gen_max: metrics.gen_max,
            pcie_width: metrics.width,
            pcie_width_max: metrics.width_max,
            pcie_rx_mib_per_s: metrics.rx_mib_per_s,
            pcie_tx_mib_per_s: metrics.tx_mib_per_s,
            mem_clock_mhz: metrics.mem_clock_mhz,
            throttle_reasons: metrics.throttle_reasons,
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
    // Poison-tolerant on purpose. With `.unwrap()`, one panic anywhere while this lock
    // is held poisons it permanently, and every later poll then panics on "mutex
    // poisoned" — turning one fault into a repeating one. Recovering the guard keeps a
    // stale System handle recoverable instead of killing telemetry for the session.
    let mut system_guard = CPU_SYSTEM
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

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
            current_clock_mhz: 0,
            avg_usage_percent: 0.0,
            core_usages: vec![0.0; 32],
        });
    }

    let mut core_usages = Vec::with_capacity(threads);
    let mut freq_sum: u64 = 0;
    let mut freq_n: u64 = 0;
    for cpu in cpus {
        core_usages.push(cpu.cpu_usage());
        let f = cpu.frequency() as u32;
        if (400..=10_000).contains(&f) {
            freq_sum += f as u64;
            freq_n += 1;
        }
    }

    let avg_usage: f32 = if !core_usages.is_empty() {
        core_usages.iter().sum::<f32>() / core_usages.len() as f32
    } else {
        0.0
    };

    let sysinfo_avg = freq_sum.checked_div(freq_n).unwrap_or(0) as u32;
    // Base/advertised (WMI MaxClockSpeed) — sticky 4300 on Ryzen; turbo is not here.
    let max_clock_mhz = cached_base_clock_mhz(sysinfo_avg);
    // Live = base × PDH % Processor Performance (moves under load / turbo).
    let current_clock_mhz = live_cpu_clock_mhz(max_clock_mhz)
        .or(if sysinfo_avg > 0 { Some(sysinfo_avg) } else { None })
        .unwrap_or(0);

    Ok(CpuInfo {
        name: cpus[0].brand().to_string(),
        cores: threads / 2,
        threads,
        max_clock_mhz,
        current_clock_mhz,
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
    else if lower.contains("l40") || lower.contains("a6000") { 49152 }                   // 48 GB (L4/L40/L40S, RTX A6000)
    else if lower.contains("v100") && lower.contains("32") { 32768 }                          // 32 GB
    else if lower.contains("v100") { 16384 }                                                  // 16 GB
    else if lower.contains("rtx 4090") { 25600 }                                              // 24 GB
    else if lower.contains("rtx 4080") { 16384 }                                          // 16 GB (incl. Super)
    else if lower.contains("rtx 4070") { 12288 }                                              // 12 GB
    else if lower.contains("rtx 3090") { 24576 }                                          // 24 GB (incl. Ti)
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
/// Live override from CONFIG → RUNTIME (`0` = use the constant above).
static DISK_IO_POLL_MS: AtomicU64 = AtomicU64::new(0);

fn disk_io_poll_ms() -> u64 {
    match DISK_IO_POLL_MS.load(Ordering::Relaxed) {
        0 => DISK_IO_POLL_INTERVAL_MS,
        ms => ms,
    }
}

/// Clamp defensively — the RUNTIME sliders hold the product bounds.
pub fn set_disk_io_poll_ms(ms: u64) {
    DISK_IO_POLL_MS.store(ms.clamp(100, 2000), Ordering::Relaxed);
}

/// Apply the user's polling cadences (CONFIG → RUNTIME → TELEMETRY POLLING).
#[tauri::command]
pub fn set_telemetry_timings(tick_ms: u64, disk_io_ms: u64, pcie_throughput: bool) {
    crate::log_hub::set_telemetry_tick_ms(tick_ms);
    set_disk_io_poll_ms(disk_io_ms);
    crate::nvml_metrics::set_pcie_throughput_enabled(pcie_throughput);
}

fn disk_io_poller_disabled() -> bool {
    crate::debug_flags::flags().disable_disk_io
}

/// Disk I/O is only shown while a model boots (FusionBooter), so the sampler is demand-driven:
/// it starts on `scan_disk_io` and exits once nobody has asked for [`DISK_IO_IDLE_STOP_MS`].
/// Nothing polls the disk when the app is idle.
const DISK_IO_IDLE_STOP_MS: u64 = 5000;
static DISK_IO_LAST_USE: Mutex<Option<Instant>> = Mutex::new(None);

/// Start the disk I/O poller on demand (idempotent). The thread stops itself when idle.
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
        DISK_IO_POLLER_STARTED.store(false, Ordering::SeqCst);
        log::warn!("[telemetry] disk io poller thread failed to start: {}", e);
    }
}

fn disk_io_used_recently() -> bool {
    let last = DISK_IO_LAST_USE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .to_owned();
    match last {
        Some(at) => Instant::now().saturating_duration_since(at)
            < Duration::from_millis(DISK_IO_IDLE_STOP_MS),
        None => false,
    }
}

fn disk_io_poller_thread() {
    #[cfg(windows)]
    {
        let mut sampler = match crate::disk_io_pdh::PdhDiskSampler::new() {
            Ok(s) => s,
            Err(e) => {
                DISK_IO_POLLER_STARTED.store(false, Ordering::SeqCst);
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
            std::thread::sleep(Duration::from_millis(disk_io_poll_ms()));
            if !disk_io_used_recently() {
                DISK_IO_POLLER_STARTED.store(false, Ordering::SeqCst);
                log::debug!("[telemetry] disk io poller idle — stopped");
                return;
            }
        }
    }

    #[cfg(not(windows))]
    loop {
        std::thread::sleep(Duration::from_millis(disk_io_poll_ms()));
        if !disk_io_used_recently() {
            DISK_IO_POLLER_STARTED.store(false, Ordering::SeqCst);
            return;
        }
    }
}

/// Returns the latest cached system disk read/write rates (MiB/s). `slot_idx` is kept for IPC compat only.
#[tauri::command]
pub async fn scan_disk_io(_slot_idx: Option<i32>) -> Result<DiskIoInfo, String> {
    *DISK_IO_LAST_USE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Instant::now());
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
    // Memory only. `System::new_all()` additionally snapshots EVERY process on the
    // machine, opening each one — data this command never reads. It ran while engine
    // processes were spawning and dying around it, walking a process list that was
    // changing underneath, to produce a number that needs no process data at all.
    let mut sys = System::new();
    sys.refresh_memory();

    let total = sys.total_memory() / (1024 * 1024);   // bytes → MiB, usable by OS
    let phys_bytes = physical_ram_bytes().unwrap_or_else(|| sys.total_memory());
    Ok(SystemInfo {
        total_memory_mib: total,
        available_memory_mib: sys.available_memory() / (1024 * 1024),
        total_memory_manufactured_mib: phys_bytes / (1024 * 1024), // bytes → MiB
    })
}

/// Detect physical GPU count via nvidia-smi. Shared across engine, fit_scanner, config.
/// Returns 1 as fallback if detection fails (safer than guessing wrong).
///
/// Cached for the process — FIT library used to call this per model (nvidia-smi storm).
/// NOTE: MUST use Stdio::piped() — Stdio::null() discards output and always returns fallback.
static GPU_COUNT: LazyLock<usize> = LazyLock::new(detect_gpu_count_uncached);

pub fn detect_gpu_count() -> usize {
    *GPU_COUNT
}

fn detect_gpu_count_uncached() -> usize {
    let fallback = 1;
    let smi = crate::engine_utils::resolve_nvidia_smi_path();
    if let Ok(output) = std::process::Command::new(&smi)
        .args(["--query-gpu=index", "--format=csv,noheader"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
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

/// Return the NVIDIA driver version string (e.g. "610.47") from the first GPU, if available.
/// Used for per-profile driver compatibility indicators in the UI.
#[tauri::command]
pub async fn get_nvidia_driver_version() -> Result<Option<String>, String> {
    let gpus = scan_gpus().await?;
    Ok(gpus
        .into_iter()
        .filter_map(|g| g.driver_version)
        .next())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe_gpu() -> GpuInfo {
        GpuInfo {
            index: 0,
            name: "Test GPU".to_string(),
            memory_total: 98_304,
            memory_used: 1_024,
            memory_free: 97_280,
            memory_total_manufactured: 98_304,
            temperature_gpu: 40,
            temperature_hot_spot: None,
            temperature_memory: None,
            power_draw: 1.0,
            power_limit: 2.0,
            utilization_gpu: 0,
            utilization_memory: 0,
            driver_version: Some("610.47".to_string()),
            driver_model: String::new(),
            pcie_gen: None,
            pcie_gen_max: None,
            pcie_width: None,
            pcie_width_max: None,
            pcie_rx_mib_per_s: None,
            pcie_tx_mib_per_s: None,
            mem_clock_mhz: None,
            throttle_reasons: None,
        }
    }

    /// The two halves of the backoff: a failing nvidia-smi must stop being spawned,
    /// and the GPU view must not blank while it is cooling down. Before this, a
    /// refusal was retried on every single poll with no cooldown at all.
    #[test]
    fn nvidia_smi_backoff_serves_the_last_snapshot_and_recovers() {
        // Nothing cached yet: refuse to spawn, but never invent a GPU list.
        smi_record_failure("simulated refusal");
        assert!(matches!(smi_gate(), SmiGate::Wait));

        // A success clears the backoff and becomes the snapshot to fall back on.
        let probe = vec![probe_gpu()];
        smi_record_success(&probe);
        assert!(matches!(smi_gate(), SmiGate::Proceed));

        // Failing again now serves the snapshot instead of blanking the view.
        smi_record_failure("simulated refusal again");
        match smi_gate() {
            SmiGate::Cached(cached) => assert_eq!(cached.len(), 1),
            other => panic!("expected the cached snapshot, got {other:?}"),
        }

        // Recovery clears the cooldown, so a healthy driver is still polled every tick.
        smi_record_success(&probe);
        assert!(matches!(smi_gate(), SmiGate::Proceed));
    }
}
