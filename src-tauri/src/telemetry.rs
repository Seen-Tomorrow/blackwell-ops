use serde::{Deserialize, Serialize};
use std::os::windows::process::CommandExt;
use std::process::Stdio;
use std::sync::Mutex;
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
    let output = tokio::process::Command::new("nvidia-smi")
        .args(&[
            "--query-gpu=index,name,memory.total,memory.used,memory.free,temperature.gpu,power.draw,power.limit,utilization.gpu,utilization.memory",
            "--format=csv,noheader,nounits",
        ])
        .stdout(Stdio::piped())   // MUST be piped — null() discards output, returns empty GPU list
        .stderr(Stdio::null())
        .creation_flags(0x08000000) // CREATE_NO_WINDOW — prevents CMD window flash in release builds
        .output()
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

        // Split from the right: last 8 fields are always numeric (mem_total through util_mem)
        // Everything between index(0) and those 8 fields is the GPU name
        let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();

        if parts.len() < 9 {
            log::debug!("nvidia-smi line has too few fields ({}): {}", parts.len(), line);
            continue;
        }

        let index: u32 = parts[0].parse().unwrap_or(0);

        // GPU name is between index and the last 8 numeric fields
        let num_numeric = 8;
        let name_end = parts.len() - num_numeric;
        let gpu_name = if name_end > 1 {
            parts[1..name_end].join(", ")
        } else {
            "Unknown GPU".to_string()
        };

        // Last 8 numeric fields: memory.total, mem.used, mem.free, temp.gpu,
        //   power.draw, power.limit, util.gpu, util.mem
        let base = name_end;
        let memory_total: u64 = parts[base].parse().unwrap_or(0);
        let memory_used: u64 = parts[base + 1].parse().unwrap_or(0);
        let memory_free: u64 = parts[base + 2].parse().unwrap_or(0);
        let temperature_gpu: u32 = parts[base + 3].parse().unwrap_or(0);
        let power_draw: f32 = parts[base + 4].parse().unwrap_or(0.0);
        let power_limit: f32 = parts[base + 5].parse().unwrap_or(0.0);
        let utilization_gpu: u32 = parts[base + 6].parse().unwrap_or(0);
        let utilization_memory: u32 = parts[base + 7].parse().unwrap_or(0);

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

/// One WMI/CIM pass — formatted perf rates work for direct-io; raw Get-Counter single samples often read 0.
#[cfg(windows)]
fn query_disk_io_bytes_per_sec(engine_pid: Option<u32>) -> Result<(f32, f32), String> {
    let pid = engine_pid.unwrap_or(0);
    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!(
                r#"
function Max-Double($values) {{
    $m = 0.0
    foreach ($v in $values) {{
        if ($null -ne $v) {{
            $d = [double]$v
            if ($d -gt $m) {{ $m = $d }}
        }}
    }}
    return $m
}}

$phys = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -ErrorAction SilentlyContinue
$physTotal = ($phys | Where-Object {{ $_.Name -eq '_Total' }} | Select-Object -First 1).DiskReadBytesPerSec
$physSum = ($phys | Where-Object {{ $_.Name -ne '_Total' }} | Measure-Object -Property DiskReadBytesPerSec -Sum).Sum
$physWrite = ($phys | Where-Object {{ $_.Name -eq '_Total' }} | Select-Object -First 1).DiskWriteBytesPerSec

$log = Get-CimInstance Win32_PerfFormattedData_PerfDisk_LogicalDisk -ErrorAction SilentlyContinue
$logTotal = ($log | Where-Object {{ $_.Name -eq '_Total' }} | Select-Object -First 1).DiskReadBytesPerSec

$procRead = 0.0
if ({pid} -gt 0) {{
    $p = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "IDProcess={pid}" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($p) {{
        $procRead = [Math]::Max([double]$p.IOReadBytesPerSec, [double]$p.IODataBytesPerSec)
    }}
}}

$engineSum = 0.0
$engineProcs = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -ErrorAction SilentlyContinue |
    Where-Object {{ $_.Name -like 'llama-server*' }}
if ($engineProcs) {{
    $engineSum = ($engineProcs | ForEach-Object {{
        [Math]::Max([double]$_.IOReadBytesPerSec, [double]$_.IODataBytesPerSec)
    }} | Measure-Object -Maximum).Maximum
    if ($null -eq $engineSum) {{ $engineSum = 0.0 }}
}}

$diskRead = Max-Double @($physTotal, $physSum, $logTotal, $procRead, $engineSum)

# Sample rate counter twice — cold Get-Counter snapshots are often 0 for direct-io
if ($diskRead -lt 1048576) {{
    $c1 = (Get-Counter '\PhysicalDisk(_Total)\Disk Read Bytes/sec' -ErrorAction SilentlyContinue).CounterSamples.CookedValue
    Start-Sleep -Milliseconds 250
    $c2 = (Get-Counter '\PhysicalDisk(_Total)\Disk Read Bytes/sec' -ErrorAction SilentlyContinue).CounterSamples.CookedValue
    $diskRead = [Math]::Max($diskRead, [Math]::Max([double]$c1, [double]$c2))
}}

# mmap / page-cache fallback when disk + process paths stay quiet
if ($diskRead -lt 1048576) {{
    $pages = (Get-Counter '\Memory\Pages Input/sec' -ErrorAction SilentlyContinue).CounterSamples.CookedValue
    $diskRead = [Math]::Max($diskRead, [double]$pages * 4096)
    if ({pid} -gt 0) {{
        $p = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "IDProcess={pid}" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($p) {{
            $faultBps = [double]$p.PageFaultsPerSec * 4096
            $diskRead = [Math]::Max($diskRead, $faultBps)
        }}
    }}
}}

Write-Output "$diskRead,$physWrite"
"#
            ),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("disk io counter failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut parts = stdout.trim().split(',');
    let read: f32 = parts.next().unwrap_or("0").trim().parse().unwrap_or(0.0);
    let write: f32 = parts.next().unwrap_or("0").trim().parse().unwrap_or(0.0);
    Ok((read, write))
}

#[cfg(not(windows))]
fn query_disk_io_bytes_per_sec(_engine_pid: Option<u32>) -> Result<(f32, f32), String> {
    Ok((0.0, 0.0))
}

#[tauri::command]
pub async fn scan_disk_io(
    slot_idx: Option<i32>,
    app: tauri::State<'_, crate::engine::AppContext>,
) -> Result<DiskIoInfo, String> {
    let engine_pid = match slot_idx.and_then(|idx| usize::try_from(idx).ok()) {
        Some(idx) => {
            let stack = app.stack.lock().await;
            stack.get_slot_pid(idx)
        }
        None => None,
    };

    let (read_bps, write_bps) = query_disk_io_bytes_per_sec(engine_pid)?;
    Ok(DiskIoInfo {
        read_mib_per_s: clamp_disk_read_mib_per_s(read_bps / (1024.0 * 1024.0)),
        write_mib_per_s: write_bps / (1024.0 * 1024.0),
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
