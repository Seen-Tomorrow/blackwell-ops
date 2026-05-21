use std::process::Stdio;
use std::sync::Arc;
use crate::types::{EngineConfig, StackEntry};
use crate::log_hub::LogHub;

/// Estimate committed VRAM for a launched engine from full scan data or file size fallback.
fn fit_scanner_estimate_vram(config: &EngineConfig) -> f64 {
    if let Some(scan_data) = crate::fit_scanner::load_full_scan_export() {
        if let Some(full) = scan_data.get(&config.model_path) {
            let ctx_str = config.get_param_str("ctx").unwrap_or_else(|| "32k".to_string());
            let ctx_tokens = crate::templates::ctx_to_int_tokens(&ctx_str);
            if let Some(pt) = full.points.iter().find(|p| {
                p.ctx == ctx_tokens && p.kv_quant.to_lowercase() == config.get_param_str("kv_quant").unwrap_or_else(|| "f16".to_string()).to_lowercase()
            }) {
                return pt.vram_mib;
            }
        }
    }
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
}

impl std::fmt::Display for SlotStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SlotStatus::Idle => write!(f, "IDLE"),
            SlotStatus::Loading => write!(f, "LOADING"),
            SlotStatus::Running => write!(f, "RUNNING"),
        }
    }
}

#[derive(Debug)]
pub struct EngineSlot {
    pub child_proc: Option<std::process::Child>,
    pub port: u16,
    pub status: SlotStatus,
    pub alias: String,
    pub model_path: String,
    pub gpu_mask: String,
    pub vram_mib: f64,
    pub n_ctx: usize,
    pub provider_name: String,
    pub backend_type: String,
}

pub struct EngineStack {
    pub(crate) slots: Vec<Option<Arc<parking_lot::Mutex<EngineSlot>>>>,
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
            slots.push(Some(Arc::new(parking_lot::Mutex::new(EngineSlot {
                child_proc: None,
                port: base_port + i as u16,
                status: SlotStatus::Idle,
                alias: format!("ENGINE-{}", i),
                model_path: String::new(),
                gpu_mask: String::new(),
                vram_mib: 0.0,
                n_ctx: 32768,
                provider_name: String::new(),
                backend_type: String::new(),
            }))));
        }

        Self { slots, base_port, log_hub: None }
    }

    pub fn set_log_hub(&mut self, hub: LogHub) {
        self.log_hub = Some(hub);
    }

    pub fn find_idle_slot(&self) -> Option<usize> {
        for (i, slot_opt) in self.slots.iter().enumerate() {
            if let Some(slot_arc) = slot_opt {
                let slot = slot_arc.lock();
                if matches!(slot.status, SlotStatus::Idle) {
                    return Some(i);
                }
            } else {
                return Some(i);
            }
        }
        None
    }

    /// Static entry point — handles its own locking. Callers don't need to hold the stack lock.
    pub async fn load_slot(
        slot_idx: usize,
        config: &EngineConfig,
        binary_path: &std::path::PathBuf,
        gpu_mask: String,
        cmd_args: Vec<String>,
        provider_display_name: String,
        backend_type: String,
        stack_ref: &Arc<tokio::sync::Mutex<EngineStack>>,
    ) -> Result<std::process::ChildStderr, String> {
        // Validate binary BEFORE acquiring any lock (avoids holding tokio MutexGuard across await)
        validate_binary_path(binary_path).await?;

        let slot_arc = {
            let stack = stack_ref.lock().await;
            let arc = stack.slots[slot_idx].as_ref().ok_or("Slot not found")?.clone();
            // Check status under per-slot lock (no await)
            {
                let slot = arc.lock();
                if !matches!(slot.status, SlotStatus::Idle) {
                    return Err(format!("Slot {} is not idle (current status: {})", slot_idx, slot.status));
                }
            }
            drop(stack); // Release tokio stack lock before async work below
            arc
        };

        let mut cmd = std::process::Command::new(binary_path);

        // Set CWD to model directory so bare filenames (mmproj, etc.) resolve correctly
        if let Some(model_dir) = std::path::Path::new(&config.model_path).parent() {
            cmd.current_dir(model_dir);
        }

        for (k, v) in std::env::vars() {
            cmd.env(&k, &v);
        }

        eprintln!("[ENGINE] slot={} binary: {}", slot_idx, binary_path.display());
        eprintln!("[ENGINE] slot={} args: {:?}", slot_idx, cmd_args.iter().take(5).collect::<Vec<_>>());

        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP) // process isolation for signal handling
            .args(&cmd_args)
            .env("CUDA_VISIBLE_DEVICES", &gpu_mask)
            .env("LLAMA_LOG_COLORS", "on")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return Err(format!("Failed to spawn {}: {}", binary_path.display(), e)),
        };

        let pid = child.id();
        eprintln!("[ENGINE] slot={} spawned (pid={})", slot_idx, pid);

        // Extract stderr pipe — LogHub will own reading and processing.
        let stderr = child.stderr.take().unwrap();

        // Quick alive check — give process 100ms to initialize
        std::thread::sleep(std::time::Duration::from_millis(100));
        if let Ok(status) = child.try_wait() {
            if let Some(code) = status {
                eprintln!("[ENGINE] slot={} CRASHED immediately after spawn! Exit code: {}", slot_idx, code.code().unwrap_or(-1));
            }
        }

        // Update slot state under per-slot lock only (no tokio guard held)
        {
            let mut slot = slot_arc.lock();
            slot.child_proc = Some(child);
            slot.port = config.port;
            slot.alias = config.alias.clone();
            slot.model_path = config.model_path.clone();
            slot.gpu_mask = gpu_mask;
            slot.vram_mib = fit_scanner_estimate_vram(&config);
            slot.n_ctx = crate::templates::ctx_to_int_tokens(&config.get_param_str("ctx").unwrap_or_else(|| "32k".to_string()));
            slot.provider_name = provider_display_name;
            slot.backend_type = backend_type;
            slot.status = SlotStatus::Loading;
        }

        Ok(stderr)
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
            .creation_flags(0x08000000)
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

    fn graceful_shutdown_process(
        child: &mut std::process::Child,
        slot_idx: usize,
    ) -> bool {
        let pid = child.id();

        // With piped I/O (no console), Ctrl+C and stdin EOF are both unreliable.
        // TerminateProcess is the only reliable path — it completes in ~0.2s.
        eprintln!("[STOP] slot={} pid={} TerminateProcess...", slot_idx, pid);
        let _ = child.kill();

        for attempt in 0..40 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            match child.try_wait() {
                Ok(Some(_)) => {
                    eprintln!("[STOP] slot={} KILLED after {:.1}s", slot_idx, (attempt + 1) as f64 * 0.05);
                    return true;
                }
                Ok(None) => {}
                Err(_) => break,
            }
        }

        eprintln!("[STOP] slot={} STILL ALIVE after kill — orphaned", slot_idx);
        false
    }

    /// Reset a slot to factory defaults — clears all engine metadata so the status poll returns clean idle entries.
    fn clear_slot(&self, idx: usize) {
        if let Some(slot_arc) = &self.slots[idx] {
            let mut slot = slot_arc.lock();
            slot.status = SlotStatus::Idle;
            slot.child_proc = None;
            slot.alias = format!("ENGINE-{}", idx);
            slot.model_path.clear();
            slot.gpu_mask.clear();
            slot.vram_mib = 0.0;
            slot.n_ctx = 32768;
            slot.provider_name.clear();
            slot.backend_type.clear();
        }
    }

    /// Emit a stack-changed event to frontend with current status snapshot.
    pub fn emit_stack_changed(&self) {
        if let Some(hub) = self.log_hub.as_ref() {
            hub.emit("stack-changed", &self.get_status());
        }
    }

    /// Stops a single slot. Static self-locking — caller must NOT hold the tokio stack lock.
    pub async fn stop_slot(
        slot_idx: usize,
        stack_ref: &Arc<tokio::sync::Mutex<EngineStack>>,
    ) -> Result<(), String> {
        // Extract process handle under per-slot lock only — no tokio lock needed
        let (port, alias, proc_to_stop) = {
            let stack = stack_ref.lock().await;
            let mut slot = stack.slots[slot_idx].as_ref().ok_or("Slot not found")?.lock();
            let port = slot.port;
            let alias = slot.alias.clone();
            let proc_to_stop = slot.child_proc.take();
            (port, alias, proc_to_stop)
        }; // tokio stack lock dropped

        if let Some(mut proc) = proc_to_stop {
            // Blocking shutdown runs in spawn_blocking so it doesn't block the tokio worker
            let graceful = tokio::task::spawn_blocking({
                let si = slot_idx;
                move || EngineStack::graceful_shutdown_process(&mut proc, si)
            }).await.unwrap_or(false);

            let msg = if !graceful {
                "[STOP] ORPHANED (still alive after kill)".to_string()
            } else {
                "[STOP] KILLED".to_string()
            };
            eprintln!("[STOP] slot={} alias={} shutdown: {}", slot_idx, alias, msg);

            // Emit shutdown event and kill orphaned port listener
            let hub_opt = {
                let stack = stack_ref.lock().await;
                stack.log_hub.as_ref().map(|h| h.clone())
            };
            if let Some(hub) = hub_opt {
                hub.emit_system_event(slot_idx, &alias, &msg).await;
            }
            let _ = Self::kill_process_by_port(port).await;
        }

        // Clean up slot state — full metadata reset
        {
            let stack = stack_ref.lock().await;
            stack.clear_slot(slot_idx);
            stack.emit_stack_changed();
        }
        Ok(())
    }

    /// Stops all running slots in parallel. Static self-locking — caller must NOT hold the tokio stack lock.
    pub async fn stop_all_parallel(
        stack_ref: &Arc<tokio::sync::Mutex<EngineStack>>,
    ) -> Vec<usize> {
        // Phase 1: Collect target slot data under a brief lock
        let mut targets: Vec<(usize, u16, String, Option<std::process::Child>)> = Vec::new();
        let log_hub_ref = {
            let stack = stack_ref.lock().await;
            for (i, slot_opt) in stack.slots.iter().enumerate() {
                if let Some(slot_arc) = slot_opt {
                    let mut slot = slot_arc.lock();
                    match &slot.status {
                        SlotStatus::Running | SlotStatus::Loading => {
                            eprintln!("[STOP] shutting down slot={} port={} alias={}", i, slot.port, slot.alias);
                            let port = slot.port;
                            let alias = slot.alias.clone();
                            let proc_to_stop = slot.child_proc.take();
                            targets.push((i, port, alias, proc_to_stop));
                        }
                        _ => {}
                    }
                }
            }
            stack.log_hub.as_ref().map(|h| h.clone())
        }; // tokio stack lock dropped

        // Phase 2: Run all shutdowns in parallel outside any lock
        let mut handles = Vec::new();
        for (i, port, alias, proc_to_stop) in targets {
            let hub_clone = log_hub_ref.clone();
            handles.push(tokio::spawn(async move {
                if let Some(proc) = proc_to_stop {
                    // Blocking shutdown in spawn_blocking
                    let graceful = tokio::task::spawn_blocking(move || {
                        let mut p = proc;
                        EngineStack::graceful_shutdown_process(&mut p, i)
                    }).await.unwrap_or(false);

                    let msg = if !graceful {
                        "[STOP] ORPHANED (still alive after kill)".to_string()
                    } else {
                        "[STOP] KILLED".to_string()
                    };
                    eprintln!("[STOP] slot={} alias={} shutdown: {}", i, alias, msg);

                    if let Some(hub) = hub_clone.as_ref() {
                        hub.emit_system_event(i, &alias, &msg).await;
                    }
                    let _ = EngineStack::kill_process_by_port(port).await;
                }

                // Emit slot-cleared so frontend clears per-slot logs
                if let Some(hub) = hub_clone.as_ref() {
                    hub.emit("slot-cleared", &serde_json::json!({ "slot": i }));
                }

                i
            }));
        }

        // Phase 3: Await all, clear slots, emit stack-changed
        let mut stopped = Vec::new();
        for handle in handles {
            if let Ok(i) = handle.await {
                {
                    let stack = stack_ref.lock().await;
                    stack.clear_slot(i);
                }
                stopped.push(i);
            }
        }
        {
            let stack = stack_ref.lock().await;
            stack.emit_stack_changed();
        }
        stopped
    }

    /// Stops all slots whose backend_type matches the given provider ID in parallel.
    /// Static self-locking — caller must NOT hold the tokio stack lock.
    pub async fn stop_slots_by_provider_parallel(
        backend_type: &str,
        stack_ref: &Arc<tokio::sync::Mutex<EngineStack>>,
    ) -> Vec<usize> {
        // Phase 1: Collect targets under brief lock
        let mut targets: Vec<(usize, u16, String, Option<std::process::Child>)> = Vec::new();
        let log_hub_ref = {
            let stack = stack_ref.lock().await;
            for (i, slot_opt) in stack.slots.iter().enumerate() {
                if let Some(slot_arc) = slot_opt {
                    let mut slot = slot_arc.lock();
                    if slot.backend_type == backend_type && !matches!(slot.status, SlotStatus::Idle) {
                        eprintln!("[STOP] provider stop slot={} port={} alias={}", i, slot.port, slot.alias);
                        let port = slot.port;
                        let alias = slot.alias.clone();
                        let proc_to_stop = slot.child_proc.take();
                        targets.push((i, port, alias, proc_to_stop));
                    }
                }
            }
            stack.log_hub.as_ref().map(|h| h.clone())
        }; // tokio stack lock dropped

        // Phase 2: Parallel shutdown outside any lock
        let mut handles = Vec::new();
        for (i, port, alias, proc_to_stop) in targets {
            let hub_clone = log_hub_ref.clone();
            handles.push(tokio::spawn(async move {
                if let Some(proc) = proc_to_stop {
                    let graceful = tokio::task::spawn_blocking(move || {
                        let mut p = proc;
                        EngineStack::graceful_shutdown_process(&mut p, i)
                    }).await.unwrap_or(false);

                    let msg = if !graceful {
                        "[STOP] ORPHANED (still alive after kill)".to_string()
                    } else {
                        "[STOP] KILLED".to_string()
                    };
                    eprintln!("[STOP] slot={} alias={} shutdown: {}", i, alias, msg);

                    if let Some(hub) = hub_clone.as_ref() {
                        hub.emit_system_event(i, &alias, &msg).await;
                    }
                    let _ = EngineStack::kill_process_by_port(port).await;
                }

                if let Some(hub) = hub_clone.as_ref() {
                    hub.emit("slot-cleared", &serde_json::json!({ "slot": i }));
                }

                i
            }));
        }

        // Phase 3: Await, clear slots, emit
        let mut stopped = Vec::new();
        for handle in handles {
            if let Ok(i) = handle.await {
                {
                    let stack = stack_ref.lock().await;
                    stack.clear_slot(i);
                }
                stopped.push(i);
            }
        }
        {
            let stack = stack_ref.lock().await;
            stack.emit_stack_changed();
        }
        stopped
    }

    /// Emergency kill all — used during app exit. Runs in parallel for speed.
    /// Static self-locking — caller must NOT hold the tokio stack lock.
    pub async fn kill_all(stack_ref: &Arc<tokio::sync::Mutex<EngineStack>>) {
        // Phase 1: Collect targets under brief lock
        let mut targets: Vec<(usize, u16, Option<std::process::Child>)> = Vec::new();
        {
            let stack = stack_ref.lock().await;
            for (i, slot_opt) in stack.slots.iter().enumerate() {
                if let Some(slot_arc) = slot_opt {
                    let mut slot = slot_arc.lock();
                    match &slot.status {
                        SlotStatus::Running | SlotStatus::Loading => {
                            eprintln!("[STOP] app exit: shutting down slot={} port={} alias={}", i, slot.port, slot.alias);
                            let port = slot.port;
                            let proc_to_stop = slot.child_proc.take();
                            targets.push((i, port, proc_to_stop));
                        }
                        _ => {}
                    }
                }
            }
        } // tokio stack lock dropped

        // Phase 2: Parallel blocking shutdown in spawn_blocking
        let mut handles = Vec::new();
        for (i, port, proc_to_stop) in targets {
            handles.push(tokio::spawn(async move {
                if let Some(proc) = proc_to_stop {
                    tokio::task::spawn_blocking(move || {
                        let mut p = proc;
                        EngineStack::graceful_shutdown_process(&mut p, i)
                    }).await.unwrap_or(false);
                }
                (i, port)
            }));
        }

        // Phase 3: Await, clear slots, kill orphaned ports
        let mut ports = Vec::new();
        for handle in handles {
            if let Ok((i, port)) = handle.await {
                ports.push(port);
                {
                    let stack = stack_ref.lock().await;
                    stack.clear_slot(i);
                }
            }
        }

        for port in &ports {
            let _ = Self::kill_process_by_port(*port).await;
        }

        // Final cleanup — ensure every slot is reset
        {
            let stack = stack_ref.lock().await;
            for (i, _) in stack.slots.iter().enumerate() {
                stack.clear_slot(i);
            }
       }
    }

    pub fn get_status(&self) -> Vec<StackEntry> {
        let mut entries = Vec::with_capacity(self.slots.len());

        for (i, slot_opt) in self.slots.iter().enumerate() {
            match slot_opt {
                Some(slot_arc) => {
                    let slot = slot_arc.lock();
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

    pub fn get_slot(&self, idx: usize) -> Option<parking_lot::MutexGuard<'_, EngineSlot>> {
        self.slots[idx].as_ref().map(|arc| arc.lock())
    }
}
