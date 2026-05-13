use std::process::Stdio;
use std::sync::Arc;
use tokio::sync::broadcast;
use crate::types::{EngineConfig, StackEntry};
use crate::log_hub::LogHub;

/// Estimate committed VRAM for a launched engine from full scan data or file size fallback.
fn fit_scanner_estimate_vram(config: &EngineConfig) -> f64 {
    // Try to find matching scan point from full scan export
    if let Some(scan_data) = crate::fit_scanner::load_full_scan_export() {
        if let Some(full) = scan_data.get(&config.model_path) {
            let ctx_tokens = match config.ctx_size.as_str() {
                "4K" => 4096, "8K" => 8192, "16K" => 16384, "32K" => 32768,
                "64K" => 65536, "128K" => 131072, "256K" => 262144, _ => 32768,
            };
            // Find closest matching point by ctx + kv_quant
            if let Some(pt) = full.points.iter().find(|p| {
                p.ctx == ctx_tokens && p.kv_quant.to_lowercase() == config.kv_quant.to_lowercase()
            }) {
                return pt.vram_mib;
            }
        }
    }
    // Fallback: file size as rough estimate
    if let Ok(meta) = std::fs::metadata(&config.model_path) {
        meta.len() as f64 / (1024.0 * 1024.0)
    } else {
        0.0
    }
}

pub async fn validate_binary_path(binary_path: &std::path::PathBuf) -> Result<(), String> {
    if !binary_path.exists() {
        return Err(format!(
            "Binary not found at: {}\nPlease update the path in Settings.",
            binary_path.display()
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq)]
pub enum SlotStatus {
    Idle,
    Loading,
    Running,
    Error(String),
}

impl std::fmt::Display for SlotStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SlotStatus::Idle => write!(f, "IDLE"),
            SlotStatus::Loading => write!(f, "LOADING"),
            SlotStatus::Running => write!(f, "RUNNING"),
            SlotStatus::Error(msg) => write!(f, "ERROR({})", msg),
        }
    }
}

#[derive(Debug)]
pub struct EngineSlot {
    pub conpty_proc: Option<conpty::Process>,
    /// Broadcast sender for ConPTY output — consumed by perf reader + readiness watcher
    pub output_tx: Option<broadcast::Sender<String>>,
    /// Buffered output lines for crash diagnostics (last 50 lines) — std Mutex since only accessed synchronously
    pub error_buffer: Arc<std::sync::Mutex<Vec<String>>>,
    pub port: u16,
    pub status: SlotStatus,
    pub alias: String,
    pub model_path: String,
    pub gpu_mask: String,
    pub vram_mib: f64,
    /// Context size in tokens — used by FuelTank display
    pub n_ctx: usize,
    /// Provider display name (e.g. "GGML Stable") — set at launch time
    pub provider_name: String,
    /// Backend type ID (e.g. "ggml-stable", "ik-extreme") — set at launch time
    pub backend_type: String,
}

pub struct EngineStack {
    pub(crate) slots: Vec<Option<EngineSlot>>,
    base_port: u16,
    log_hub: Option<LogHub>,
}

impl Default for EngineStack {
    fn default() -> Self {
        Self::new(9090, 4)
    }
}

impl EngineStack {
    pub fn new(base_port: u16, slot_count: usize) -> Self {
        let mut slots = Vec::with_capacity(slot_count);

        for i in 0..slot_count {
            slots.push(Some(EngineSlot {
                conpty_proc: None,
                output_tx: None,
                error_buffer: Arc::new(std::sync::Mutex::new(Vec::new())),
                port: base_port + i as u16,
                status: SlotStatus::Idle,
                alias: format!("ENGINE-{}", i),
                model_path: String::new(),
                gpu_mask: String::new(), // Empty placeholder — set at launch time from config.Device
                vram_mib: 0.0,
                n_ctx: 32768,
                provider_name: String::new(),
                backend_type: String::new(),
            }));
        }

        Self { slots, base_port, log_hub: None }
    }

    pub fn set_log_hub(&mut self, hub: LogHub) {
        self.log_hub = Some(hub);
    }

    pub fn find_idle_slot(&self) -> Option<usize> {
        for (i, slot_opt) in self.slots.iter().enumerate() {
            if let Some(slot) = slot_opt {
                if matches!(slot.status, SlotStatus::Idle) {
                    return Some(i);
                }
            } else {
                return Some(i);
            }
        }
        None
    }

    /// Spawns llama-server via ConPTY. Returns a Receiver for combined stdout+stderr lines.
    pub async fn load_slot_with_args(
        &mut self,
        slot_idx: usize,
        config: &EngineConfig,

        binary_path: &std::path::PathBuf,
        gpu_mask: String,
        cmd_args: Vec<String>,
        provider_display_name: String,
        backend_type: String,
    ) -> Result<(), String> {
        let slot = self.slots[slot_idx].as_mut().ok_or("Slot not found")?;

        if !matches!(slot.status, SlotStatus::Idle) {
            return Err(format!("Slot {} is not idle (current status: {})", slot_idx, slot.status));
        }

        // Use gpu_mask passed from caller (engine.rs), which already accounts for
        // typed split_mode field AND __test_args raw flags detection.

        validate_binary_path(binary_path).await?;

        let mut std_cmd = std::process::Command::new(binary_path);
        
        // Inherit parent environment — ConPTY does NOT auto-inherit, only passes explicit .env() calls
        for (k, v) in std::env::vars() {
            std_cmd.env(&k, &v);
        }
        
        eprintln!("[CONPTY] slot={} binary: {}", slot_idx, binary_path.display());
        eprintln!("[CONPTY] slot={} args: {:?}", slot_idx, cmd_args.iter().take(5).collect::<Vec<_>>());

        std_cmd
            .args(&cmd_args)
            .env("CUDA_VISIBLE_DEVICES", &gpu_mask);

        let mut conpty_proc = match conpty::Process::spawn(std_cmd) {
            Ok(p) => p,
            Err(e) => return Err(format!("Failed to spawn {} via ConPTY: {}", binary_path.display(), e)),
        };

        // Brief delay to let process initialize (ConPTY startup can be fast but not instant)
        std::thread::sleep(std::time::Duration::from_millis(100));
        
        eprintln!("[CONPTY] slot={} spawned (pid={}), alive={}", slot_idx, conpty_proc.pid(), conpty_proc.is_alive());

        let mut conpty_output = match conpty_proc.output() {
            Ok(r) => r,
            Err(e) => return Err(format!("Failed to get ConPTY output: {}", e)),
        };

        // Capture early output for crash diagnostics
        let early_lines: Vec<String> = {
            use std::io::{BufRead, BufReader};
            conpty_output.blocking(false);
            let mut reader = BufReader::new(&mut conpty_output);
            std::iter::from_fn(|| {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => None,
                    Ok(_) if line.trim().is_empty() => None,
                    Ok(_) => Some(line.trim().to_string()),
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => None,
                    Err(e) => {
                        eprintln!("[CONPTY] slot={} early read error: {}", slot_idx, e);
                        None
                    }
                }
            }).take(20).collect()
        };
        
        if !early_lines.is_empty() {
            eprintln!("[CONPTY] slot={} early output ({} lines): {:?}", slot_idx, early_lines.len(), early_lines.join(" | "));
        }

        let (tx, _rx) = broadcast::channel::<String>(256);

        // Clone error buffer and tx for the reader thread
        let error_buf = slot.error_buffer.clone();
        let reader_tx = tx.clone();

        tokio::task::spawn_blocking(move || {
            use std::io::{BufRead, BufReader};

            conpty_output.blocking(true);
            let reader = BufReader::new(&mut conpty_output);

            for line_result in reader.lines() {
                match line_result {
                    Ok(line) => {
                        if !line.is_empty() {
                            let _ = reader_tx.send(line.clone());
                            // Also buffer last 50 lines for crash diagnostics
                            let mut buf = error_buf.lock().unwrap();
                            buf.push(line);
                            if buf.len() > 50 { buf.remove(0); }
                        }
                    }
                    Err(e) => {
                        eprintln!("[CONPTY] slot={} read error: {}", slot_idx, e);
                        break;
                    }
                }
            }

            eprintln!("[CONPTY] slot={} output stream closed", slot_idx);
        });

        // Verify process is still alive after getting output handle
        eprintln!("[CONPTY] slot={} post-output check: alive={}", slot_idx, conpty_proc.is_alive());

        // If process already died, capture exit code for diagnostics
        if !conpty_proc.is_alive() {
            let exit_code = conpty_proc.wait(None).unwrap_or(u32::MAX);
            eprintln!("[CONPTY] slot={} CRASHED immediately after spawn! Exit code: {}", slot_idx, exit_code);
        }

        slot.conpty_proc = Some(conpty_proc);
        slot.output_tx = Some(tx);
        slot.port = config.port;
        slot.alias = config.alias.clone();
        slot.model_path = config.model_path.clone();
        slot.gpu_mask = gpu_mask;
        slot.vram_mib = fit_scanner_estimate_vram(&config);
        slot.n_ctx = crate::templates::ProviderTemplate::ctx_to_int_str(&config.ctx_size)
            .parse::<usize>().unwrap_or(32768);
        slot.provider_name = provider_display_name;
        slot.backend_type = backend_type.clone();
        slot.status = SlotStatus::Loading;

        Ok(())
    }

    /// Subscribe to the ConPTY output broadcast channel for a slot.
    pub fn subscribe_output(&mut self, idx: usize) -> Option<broadcast::Receiver<String>> {
        if let Some(slot) = self.slots[idx].as_mut() {
            if let Some(ref tx) = slot.output_tx {
                return Some(tx.subscribe());
            }
        }
        None
    }

    /// Drain the error buffer for crash diagnostics.
    pub fn drain_error_buffer(&mut self, idx: usize) -> Vec<String> {
        if let Some(slot) = self.slots[idx].as_mut() {
            slot.error_buffer.lock().unwrap().drain(..).collect()
        } else {
            Vec::new()
        }
    }

    /// Get log hub reference for emitting events.
    pub fn log_hub(&self) -> Option<&LogHub> {
        self.log_hub.as_ref()
    }

    async fn kill_process_by_port(port: u16) -> Result<(), String> {
        let ps_script = format!(
            r"$pids = netstat -ano | Select-String ':{0} ' | ForEach-Object {{ ($_ -split '\s+')[-1] }}; $pids | Where-Object {{ $_.Length -gt 0 }} | ForEach-Object {{ taskkill /F /PID $_ }}",
            port
        );

        let output = tokio::process::Command::new("powershell")
            .args(&["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &ps_script])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
            .await
            .map_err(|e| format!("Failed to kill process on port {}: {}", port, e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if !stderr.contains("could not be found") && !stderr.contains("ERROR") {
                log::warn!("Kill port {} stderr: {}", port, stderr);
            }
        }

        Ok(())
    }

    pub async fn kill_all(&mut self) {
        let mut ports: Vec<u16> = Vec::new();
        
        for slot_opt in self.slots.iter_mut() {
            if let Some(slot) = slot_opt {
                match &slot.status {
                    SlotStatus::Running | SlotStatus::Loading => {
                        log::info!("Clean exit: killing process on port {} (alias: {})", slot.port, slot.alias);
                        
                        if let Some(ref mut proc) = slot.conpty_proc {
                            let _ = proc.exit(1);
                        }
                        
                        ports.push(slot.port);
                    }
                    _ => {}
                }
            }
        }

        for port in ports {
            let _ = Self::kill_process_by_port(port).await;
        }
    }

    pub async fn stop_slot(&mut self, slot_idx: usize) -> Result<(), String> {
        let slot = self.slots[slot_idx].as_mut().ok_or("Slot not found")?;

        let port = slot.port;

        if let Some(ref mut proc) = slot.conpty_proc {
            eprintln!("[CONPTY] slot={} terminating (pid={})", slot_idx, proc.pid());
            let _ = proc.exit(1);
        }

        // taskkill /F is instant — no need to wait for process death
        let _ = Self::kill_process_by_port(port).await;

        slot.status = SlotStatus::Idle;
        slot.conpty_proc = None;
        slot.output_tx = None;
        slot.vram_mib = 0.0;
        Ok(())
    }

    pub fn get_status(&self) -> Vec<StackEntry> {
        let mut entries = Vec::with_capacity(self.slots.len());

        for (i, slot_opt) in self.slots.iter().enumerate() {
            match slot_opt {
                Some(slot) => {
                    let model_name = if slot.model_path.is_empty() {
                        "none".to_string()
                    } else {
                        std::path::Path::new(&slot.model_path)
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("unknown")
                            .to_string()
                    };

                    entries.push(StackEntry {
                        idx: i,
                        alias: slot.alias.clone(),
                        model_name,
                        port: slot.port,
                        gpu: if slot.gpu_mask.is_empty() { "none".to_string() } else { slot.gpu_mask.clone() },
                        status: slot.status.to_string(),
                        slot_id: i as u32,
                        provider_type: slot.backend_type.clone(),
                        model_path: slot.model_path.clone(),
                        vram_mib: slot.vram_mib,
                        n_ctx: slot.n_ctx,
                        provider_name: slot.provider_name.clone(),
                        build_info: None,
                    });
                }
                None => {
                    entries.push(StackEntry {
                        idx: i,
                        alias: format!("slot-{}", i),
                        model_name: "none".to_string(),
                        port: self.base_port + i as u16,
                        gpu: "none".to_string(),
                        status: "IDLE".to_string(),
                        slot_id: i as u32,
                        provider_type: String::new(),
                        model_path: String::new(),
                        vram_mib: 0.0,
                        n_ctx: 32768,
                        provider_name: String::new(),
                        build_info: None,
                    });
                }
            }
        }

        entries
    }

    pub fn get_slot(&self, idx: usize) -> Option<&EngineSlot> {
        self.slots[idx].as_ref()
    }

    pub fn get_slot_mut(&mut self, idx: usize) -> Option<&mut EngineSlot> {
        self.slots[idx].as_mut()
    }

    /// Stops all slots whose backend_type matches the given provider ID and are not idle.
    /// Returns indices of stopped slots.
    pub async fn stop_slots_by_provider(&mut self, backend_type: &str) -> Vec<usize> {
        // Collect matching slot info first to avoid borrow conflicts
        let mut targets: Vec<(usize, u16)> = Vec::new();
        for i in 0..self.slots.len() {
            if let Some(slot) = &self.slots[i] {
                if slot.backend_type == backend_type && !matches!(slot.status, SlotStatus::Idle) {
                    targets.push((i, slot.port));
                }
            }
        }

        // Now stop each target
        let mut stopped = Vec::new();
        for (idx, port) in targets {
            if let Some(slot) = self.slots[idx].as_mut() {
                if let Some(ref mut proc) = slot.conpty_proc {
                    let _ = proc.exit(1);
                }
                let _ = Self::kill_process_by_port(port).await;
                slot.status = SlotStatus::Idle;
                slot.conpty_proc = None;
                slot.output_tx = None;
                slot.vram_mib = 0.0;
            }
            stopped.push(idx);
        }
        stopped
    }
}
