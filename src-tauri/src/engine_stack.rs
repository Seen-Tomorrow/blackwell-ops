use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use crate::types::{EngineConfig, StackEntry};
use crate::log_hub::LogHub;

pub const DEFAULT_N_CTX: usize = 32768;

/// Estimate committed VRAM for a launched engine — learned → FIT scan → file size fallback.
fn fit_scanner_estimate_vram(config: &EngineConfig) -> f64 {
    let provider_id = if config.backend_type.is_empty() {
        crate::config::DEFAULT_PROVIDER_ID.to_string()
    } else {
        config.backend_type.clone()
    };
    if let Some(entry) =
        crate::vram_learn::lookup_learned_vram_for_config(&config.model_path, &provider_id, config)
    {
        return entry.vram_mib;
    }

    if let Some(scan_data) = crate::fit_scanner::load_full_scan_export() {
        if let Some(full) = scan_data.get(&config.model_path) {
            let ctx_str = config.get_param_str("ctx").unwrap_or_else(|| "32768".to_string());
            let ctx_tokens = ctx_str.parse::<usize>().unwrap_or(32768);
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
    /// PID stored separately so the reaper can monitor without stealing the child handle.
    pub pid: Option<u32>,
    pub port: u16,
    pub status: SlotStatus,
    pub alias: String,
    pub model_path: String,
    pub gpu_mask: String,
    pub vram_mib: f64,
    pub gpu_breakdown_mib: Option<Vec<f64>>,
    pub n_ctx: usize,
    pub provider_name: String,
    pub backend_type: String,
    /// Runtime profile binary env (vanguard/frontier/fresh/stable) used at launch.
    pub binary_profile: String,
    pub supports_fusion: bool,
    /// Set when stop/clear runs — background reaper exits without duplicate cleanup.
    pub reaper_cancel: Arc<AtomicBool>,
}

pub struct EngineStack {
    pub(crate) slots: Vec<Option<Arc<parking_lot::Mutex<EngineSlot>>>>,
    log_hub: Option<LogHub>,
}

impl EngineStack {
    pub fn new(slot_count: usize) -> Self {
        let mut slots = Vec::with_capacity(slot_count);

        for i in 0..slot_count {
            slots.push(Some(Arc::new(parking_lot::Mutex::new(EngineSlot {
                child_proc: None,
                pid: None,
                port: 0,
                status: SlotStatus::Idle,
                alias: format!("ENGINE-{}", i),
                model_path: String::new(),
                gpu_mask: String::new(),
                vram_mib: 0.0,
                gpu_breakdown_mib: None,
                n_ctx: DEFAULT_N_CTX,
                provider_name: String::new(),
                backend_type: String::new(),
                binary_profile: String::new(),
                supports_fusion: true,
                reaper_cancel: Arc::new(AtomicBool::new(false)),
            }))));
        }

        Self { slots, log_hub: None }
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

    /// True if any non-idle slot already uses this alias.
    pub fn alias_in_use(&self, alias: &str) -> bool {
        self.slots.iter().any(|slot_opt| {
            slot_opt.as_ref().map_or(false, |arc| {
                let slot = arc.lock();
                slot.alias == alias && !matches!(slot.status, SlotStatus::Idle)
            })
        })
    }

    /// Reserve a slot before slow launch work — prevents double-booking during port cleanup/spawn.
    pub fn reserve_slot(&self, idx: usize, alias: &str, port: u16) -> Result<(), String> {
        let slot_arc = self.slots.get(idx).and_then(|s| s.as_ref()).ok_or("Slot not found")?;
        let mut slot = slot_arc.lock();
        if !matches!(slot.status, SlotStatus::Idle) {
            return Err(format!("Slot {} is not idle (current status: {})", idx, slot.status));
        }
        slot.status = SlotStatus::Loading;
        slot.alias = alias.to_string();
        slot.port = port;
        slot.child_proc = None;
        slot.pid = None;
        Ok(())
    }

    /// Release a reserved slot after a failed launch attempt.
    pub fn release_reserved_slot(&self, idx: usize) {
        if let Some(slot_arc) = self.slots.get(idx).and_then(|s| s.as_ref()) {
            let slot = slot_arc.lock();
            if matches!(slot.status, SlotStatus::Loading)
                && slot.child_proc.is_none()
                && slot.pid.is_none()
            {
                drop(slot);
                self.clear_slot(idx);
            }
        }
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
        supports_fusion: bool,
        stack_ref: &Arc<tokio::sync::Mutex<EngineStack>>,
        log_hub: LogHub,
        on_ready: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<(), String> {
        // Validate binary BEFORE acquiring any lock (avoids holding tokio MutexGuard across await)
        validate_binary_path(binary_path).await?;

        let slot_arc = {
            let stack = stack_ref.lock().await;
            let arc = stack.slots[slot_idx].as_ref().ok_or("Slot not found")?.clone();
            // Accept idle slots or slots reserved by launch_engine (LOADING, no child yet).
            {
                let slot = arc.lock();
                let reserved = matches!(slot.status, SlotStatus::Loading)
                    && slot.child_proc.is_none()
                    && slot.pid.is_none();
                if !matches!(slot.status, SlotStatus::Idle) && !reserved {
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

        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
            .args(&cmd_args)
            .env("CUDA_VISIBLE_DEVICES", &gpu_mask)
            .env("LLAMA_LOG_COLORS", "on")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return Err(format!("Failed to spawn {}: {}", binary_path.display(), e)),
        };

        let pid = child.id();
        // Engine spawned now routed to Blackwell Output Console

        // Extract stderr pipe and start reader immediately
        let stderr = child.stderr.take().ok_or_else(|| {
            format!("Failed to capture stderr for {}", binary_path.display())
        })?;
        let learn_snapshot = crate::vram_learn::snapshot_from_config(
            &config.model_path,
            &backend_type,
            config,
        );
        let model_ready = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let fire_ready = {
            let ready_flag = model_ready.clone();
            let cb = on_ready.clone();
            std::sync::Arc::new(move || {
                if !ready_flag.swap(true, std::sync::atomic::Ordering::AcqRel) {
                    cb();
                }
            })
        };
        log_hub.spawn_slot_reader(
            slot_idx,
            config.alias.clone(),
            stderr,
            learn_snapshot,
            model_ready,
            fire_ready.clone(),
        );

        Self::spawn_health_readiness_probe(
            config.port,
            config.alias.clone(),
            log_hub.clone(),
            fire_ready,
            slot_arc.clone(),
        );

        // Quick alive check — give process 500ms to initialize (async — do not block tokio worker)
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if let Ok(status) = child.try_wait() {
            if let Some(code) = status {
                let exit_code = code.code().unwrap_or(-1);
                {
                    let stack = stack_ref.lock().await;
                    stack.clear_slot(slot_idx);
                    stack.emit_stack_changed();
                }
                return Err(format!(
                    "Engine crashed immediately with exit code {}",
                    crate::engine_utils::describe_process_exit_code(exit_code)
                ));
            }
        }

        // Update slot state under per-slot lock only
        {
            let mut slot = slot_arc.lock();
            slot.child_proc = Some(child);
            slot.pid = Some(pid);
            slot.port = config.port;
            slot.alias = config.alias.clone();
            slot.model_path = config.model_path.clone();
            slot.gpu_mask = gpu_mask;
            slot.vram_mib = fit_scanner_estimate_vram(&config);
            slot.n_ctx = config.get_param_str("ctx")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(32768);
            slot.provider_name = provider_display_name;
            slot.backend_type = backend_type;
            slot.binary_profile = if config.binary_profile.is_empty() {
                crate::config::DEFAULT_BINARY_PROFILE.to_string()
            } else {
                config.binary_profile.clone()
            };
            slot.supports_fusion = supports_fusion;
            slot.status = SlotStatus::Loading;
        }

        let reaper_cancel = {
            let slot = slot_arc.lock();
            slot.reaper_cancel.clone()
        };
        Self::spawn_reaper(slot_idx, slot_arc.clone(), stack_ref.clone(), log_hub.clone(), reaper_cancel);

        Ok(())
    }

    /// Poll llama-server `/health` until the model is loaded and slots are available.
    /// Authoritative readiness signal — works regardless of stderr verbosity or log format.
    fn spawn_health_readiness_probe(
        port: u16,
        alias: String,
        log_hub: LogHub,
        on_ready: Arc<dyn Fn() + Send + Sync>,
        slot_arc: Arc<parking_lot::Mutex<EngineSlot>>,
    ) {
        tokio::spawn(async move {
            let client = match reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(2))
                .build()
            {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("[readiness] HTTP client init failed for port {}: {}", port, e);
                    reqwest::Client::new()
                }
            };
            let url = format!("http://127.0.0.1:{}/health", port);

            // 1200 × 500ms = 10 min — mmap + --fit on large models can exceed 5 min; we never kill on timeout.
            for _ in 0..1200 {
                {
                    let slot = slot_arc.lock();
                    if !matches!(slot.status, SlotStatus::Loading) {
                        return;
                    }
                }

                if let Ok(resp) = client.get(&url).send().await {
                    if resp.status().is_success() {
                        if let Ok(body) = resp.json::<serde_json::Value>().await {
                            match body["status"].as_str() {
                                Some("ok") => {
                                    let status = body["status"].as_str().unwrap_or("?");
                                    log_hub.emit_console_line(
                                        crate::output_console::BlackwellOutputConsoleCategory::Debug,
                                        &format!("[{alias}] readiness=GET /health | port={port} status={status}"),
                                        crate::output_console::BlackwellOutputConsoleLineStyle::Normal,
                                    );
                                    log_hub.emit_console_line(
                                        crate::output_console::BlackwellOutputConsoleCategory::Engines,
                                        &format!("[{alias}] Engine ready"),
                                        crate::output_console::BlackwellOutputConsoleLineStyle::Normal,
                                    );
                                    on_ready();
                                    return;
                                }
                                _ => {}
                            }
                        }
                    }
                }

                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }

            log::info!(
                "[readiness] HTTP health probe stopped polling port {} — load may still be in progress (engine not stopped)",
                port
            );
            log_hub.emit_console_line(
                crate::output_console::BlackwellOutputConsoleCategory::Engines,
                &format!(
                    "[{alias}] Load still in progress after health poll window — engine was not stopped (slow mmap/--fit is normal)"
                ),
                crate::output_console::BlackwellOutputConsoleLineStyle::Normal,
            );
        });
    }

    /// Check if a Windows process is still alive by PID using OpenProcess + GetExitCodeProcess.
    pub(crate) fn is_process_alive(pid: u32) -> bool {
        use windows_sys::Win32::System::Threading::{
            OpenProcess, GetExitCodeProcess, PROCESS_QUERY_INFORMATION,
        };
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};

        // SAFETY: PROCESS_QUERY_INFORMATION is all we need for GetExitCodeProcess.
        // DO NOT add PROCESS_VM_READ — it causes OpenProcess to be denied on child processes,
        // making the reaper think the process is dead and kill it via kill_process_by_port.
        let handle = unsafe {
            OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid)
        };

        if handle == INVALID_HANDLE_VALUE {
            // Transient access denial during heavy GPU load — assume alive to avoid false kills.
            return true;
        }

        let mut exit_code: u32 = 0;
        let success = unsafe { GetExitCodeProcess(handle, &mut exit_code) } != 0;

        unsafe { CloseHandle(handle); }

        if !success {
            return true; // Can't determine, assume alive
        }

        const STILL_ACTIVE: u32 = 259;
        exit_code == STILL_ACTIVE
    }

    /// Background reaper: monitors a PID and cleans up the slot if the process dies unexpectedly.
    fn spawn_reaper(
        slot_idx: usize,
        slot_arc: Arc<parking_lot::Mutex<EngineSlot>>,
        stack_ref: Arc<tokio::sync::Mutex<EngineStack>>,
        log_hub: LogHub,
        reaper_cancel: Arc<AtomicBool>,
    ) {
        let pid = {
            let slot = slot_arc.lock();
            slot.pid
        };

        let pid = match pid {
            Some(p) => p,
            None => {
                // Reaper no PID now routed to Blackwell Output Console
                return;
            }
        };

        let (port, alias) = {
            let slot = slot_arc.lock();
            (slot.port, slot.alias.clone())
        };

        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;

                if reaper_cancel.load(Ordering::Acquire) {
                    break;
                }

                let alive = Self::is_process_alive(pid);

                if !alive {
                    let still_loading = {
                        let stack = stack_ref.lock().await;
                        stack
                            .get_slot(slot_idx)
                            .map_or(false, |s| matches!(s.status, SlotStatus::Loading))
                    };
                    if still_loading {
                        Self::fail_loading_slot(
                            slot_idx,
                            &stack_ref,
                            log_hub.clone(),
                            "Engine process exited during model load",
                        )
                        .await;
                    }
                    break;
                }
            }
        });
    }

    async fn kill_process_by_port(port: u16) -> Result<(), String> {
        crate::engine_utils::kill_process_by_port(port).await
    }

    /// Background orphan cleanup — only when graceful stop failed.
    async fn finish_process_stop(
        port: u16,
        pid: Option<u32>,
        proc: std::process::Child,
        hub: Option<LogHub>,
        slot_idx: usize,
        alias: String,
        emit_console: bool,
    ) {
        let exited = crate::engine_utils::stop_child_fast(proc, pid, port).await;

        if emit_console {
            if let Some(hub) = hub {
                let msg = if exited {
                    "[STOP] graceful — stderr draining (exit breakdown may refine learned VRAM)".to_string()
                } else {
                    "[STOP] force-killed (exit breakdown skipped)".to_string()
                };
                hub.emit_console_line(
                    crate::output_console::BlackwellOutputConsoleCategory::Engines,
                    &format!("[STOP] slot={} alias={} {}", slot_idx, alias, msg),
                    crate::output_console::BlackwellOutputConsoleLineStyle::Warning,
                );
            }
        }
    }

    /// Model load failed or engine exited before ready — tear down slot and notify frontend.
    pub async fn fail_loading_slot(
        slot_idx: usize,
        stack_ref: &Arc<tokio::sync::Mutex<EngineStack>>,
        log_hub: LogHub,
        reason: &str,
    ) {
        let snapshot = {
            let stack = stack_ref.lock().await;
            let Some(slot) = stack.get_slot(slot_idx) else {
                return;
            };
            if matches!(slot.status, SlotStatus::Idle) {
                return;
            }
            (slot.alias.clone(), slot.port, slot.pid)
        };

        let (alias, port, pid) = snapshot;

        crate::fusion_brain::stop_brain(slot_idx).await;

        let user_reason = {
            let trimmed = reason.trim();
            if trimmed.is_empty() {
                "Engine stopped or crashed during model load (no stderr detail)".to_string()
            } else {
                trimmed.to_string()
            }
        };
        let launch_err = format!("LAUNCH_ERROR: {}", user_reason);
        log_hub.emit_system_event(slot_idx, &alias, &launch_err).await;
        log_hub.emit_console_line(
            crate::output_console::BlackwellOutputConsoleCategory::Error,
            &format!("[{}] Model load failed: {}", alias, user_reason),
            crate::output_console::BlackwellOutputConsoleLineStyle::Error,
        );
        log_hub.emit(
            "engine-load-failed",
            &serde_json::json!({
                "slot": slot_idx,
                "alias": alias,
                "reason": user_reason,
            }),
        );

        let proc_to_stop = {
            let stack = stack_ref.lock().await;
            stack
                .slots
                .get(slot_idx)
                .and_then(|s| s.as_ref())
                .map(|slot_arc| {
                    let mut slot = slot_arc.lock();
                    slot.child_proc.take()
                })
                .flatten()
        };

        {
            let stack = stack_ref.lock().await;
            stack.clear_slot(slot_idx);
            stack.emit_stack_changed();
        }
        log_hub.emit("slot-cleared", &serde_json::json!({ "slot": slot_idx }));

        if let Some(proc) = proc_to_stop {
            tokio::spawn(Self::finish_process_stop(
                port,
                pid,
                proc,
                Some(log_hub),
                slot_idx,
                alias,
                false,
            ));
        } else {
            if let Some(p) = pid {
                let _ = crate::engine_utils::kill_process_by_pid(p).await;
            }
            let _ = Self::kill_process_by_port(port).await;
        }
    }

    /// Reset a slot to factory defaults.
    fn clear_slot(&self, idx: usize) {
        if let Some(slot_arc) = &self.slots[idx] {
            let mut slot = slot_arc.lock();
            slot.reaper_cancel.store(true, Ordering::Release);
            slot.status = SlotStatus::Idle;
            slot.child_proc = None;
            slot.pid = None;
            slot.alias = format!("ENGINE-{}", idx);
            slot.port = 0;
            slot.model_path.clear();
            slot.gpu_mask.clear();
            slot.vram_mib = 0.0;
            slot.gpu_breakdown_mib = None;
            slot.n_ctx = DEFAULT_N_CTX;
            slot.provider_name.clear();
            slot.backend_type.clear();
            slot.binary_profile.clear();
            slot.supports_fusion = false;
            slot.reaper_cancel = Arc::new(AtomicBool::new(false));
        }
    }

    /// Emit a stack-changed event to frontend with current status snapshot.
    /// Update measured VRAM after engine prints memory breakdown at load.
    pub fn update_slot_vram(
        &self,
        slot_idx: usize,
        vram_mib: f64,
        gpu_breakdown_mib: Option<Vec<f64>>,
    ) {
        if let Some(Some(slot_arc)) = self.slots.get(slot_idx) {
            let mut slot = slot_arc.lock();
            if matches!(slot.status, SlotStatus::Idle) {
                return;
            }
            if vram_mib > 0.0 {
                slot.vram_mib = vram_mib;
            }
            if let Some(bd) = gpu_breakdown_mib {
                slot.gpu_breakdown_mib = Some(bd);
            }
        }
    }

    pub fn emit_stack_changed(&self) {
        if let Some(hub) = self.log_hub.as_ref() {
            let status = self.get_status();
            hub.emit("stack-changed", &status);
        }
    }

    /// Stops a single slot. Static self-locking — caller must NOT hold the tokio stack lock.
    pub async fn stop_slot(
        slot_idx: usize,
        stack_ref: &Arc<tokio::sync::Mutex<EngineStack>>,
    ) -> Result<(), String> {
        crate::fusion_brain::stop_brain(slot_idx).await;

        // Extract process handle under per-slot lock only
        let (port, alias, pid, proc_to_stop, hub_opt) = {
            let stack = stack_ref.lock().await;
            let mut slot = stack.slots[slot_idx].as_ref().ok_or("Slot not found")?.lock();
            let port = slot.port;
            let alias = slot.alias.clone();
            let pid = slot.pid;
            let proc_to_stop = slot.child_proc.take();
            let hub_opt = stack.log_hub.as_ref().map(|h| h.clone());
            (port, alias, pid, proc_to_stop, hub_opt)
        };

        // Immediate UI feedback — don't block on process teardown or port scan
        {
            let stack = stack_ref.lock().await;
            stack.clear_slot(slot_idx);
            stack.emit_stack_changed();
            if let Some(hub) = hub_opt.as_ref() {
                hub.emit("slot-cleared", &serde_json::json!({ "slot": slot_idx }));
            }
        }

        if let Some(proc) = proc_to_stop {
            Self::finish_process_stop(
                port,
                pid,
                proc,
                hub_opt,
                slot_idx,
                alias,
                true,
            )
            .await;
        }

        Ok(())
    }

    /// Generic shutdown helper — collects targets under lock, runs parallel shutdown, clears slots.
    async fn shutdown_slots_generic(
        stack_ref: &Arc<tokio::sync::Mutex<EngineStack>>,
        filter: impl Fn(&mut EngineSlot) -> bool,
        emit_events: bool,
        await_process_kill: bool,
    ) -> Vec<usize> {
        // Phase 1: Collect targets under brief lock
        let mut targets = Vec::new();
        let log_hub_ref = {
            let stack = stack_ref.lock().await;
            for (i, slot_opt) in stack.slots.iter().enumerate() {
                if let Some(slot_arc) = slot_opt {
                    let mut slot = slot_arc.lock();
                    if filter(&mut slot) {
                        targets.push((
                            i,
                            slot.port,
                            slot.pid,
                            slot.alias.clone(),
                            slot.child_proc.take(),
                        ));
                    }
                }
            }
            stack.log_hub.as_ref().map(|h| h.clone())
        };

        let stopped: Vec<usize> = targets.iter().map(|(i, _, _, _, _)| *i).collect();

        for (i, _, _, _, _) in &targets {
            crate::fusion_brain::stop_brain(*i).await;
        }

        // Immediate UI — clear slots and emit before slow process/port cleanup
        {
            let stack = stack_ref.lock().await;
            for (i, _, _, _, _) in &targets {
                stack.clear_slot(*i);
                if emit_events {
                    if let Some(hub) = log_hub_ref.as_ref() {
                        hub.emit("slot-cleared", &serde_json::json!({ "slot": i }));
                    }
                }
            }
            stack.emit_stack_changed();
        }

        let mut kill_handles = Vec::new();
        for (i, port, pid, alias, proc_to_stop) in targets {
            if let Some(proc) = proc_to_stop {
                let hub_clone = log_hub_ref.clone();
                let handle = tokio::spawn(Self::finish_process_stop(
                    port,
                    pid,
                    proc,
                    hub_clone,
                    i,
                    alias,
                    emit_events,
                ));
                if await_process_kill {
                    kill_handles.push(handle);
                }
            }
        }

        if await_process_kill {
            for handle in kill_handles {
                let _ = handle.await;
            }
        }

        stopped
    }

    /// Stops all running slots in parallel. Static self-locking.
    pub async fn stop_all_parallel(
        stack_ref: &Arc<tokio::sync::Mutex<EngineStack>>,
    ) -> Vec<usize> {
        Self::shutdown_slots_generic(
            stack_ref,
            |slot| matches!(slot.status, SlotStatus::Running | SlotStatus::Loading),
            true,
            false,
        )
        .await
    }

    /// Stops all slots whose backend_type matches the given provider ID in parallel.
    pub async fn stop_slots_by_provider_parallel(
        backend_type: &str,
        stack_ref: &Arc<tokio::sync::Mutex<EngineStack>>,
    ) -> Vec<usize> {
        let bt = backend_type.to_string();
        Self::shutdown_slots_generic(
            stack_ref,
            |slot| slot.backend_type == bt && !matches!(slot.status, SlotStatus::Idle),
            true,
            false,
        )
        .await
    }

    fn normalized_slot_profile(raw: &str) -> String {
        if raw.is_empty() {
            crate::config::DEFAULT_BINARY_PROFILE.to_string()
        } else {
            raw.to_ascii_lowercase()
        }
    }

    /// Stops slots for a provider + runtime profile only (other profiles keep running).
    pub async fn stop_slots_by_provider_and_profile_parallel(
        backend_type: &str,
        binary_profile: &str,
        stack_ref: &Arc<tokio::sync::Mutex<EngineStack>>,
    ) -> Vec<usize> {
        let bt = backend_type.to_string();
        let bp = Self::normalized_slot_profile(binary_profile);
        Self::shutdown_slots_generic(
            stack_ref,
            |slot| {
                slot.backend_type == bt
                    && !matches!(slot.status, SlotStatus::Idle)
                    && Self::normalized_slot_profile(&slot.binary_profile) == bp
            },
            true,
            false,
        )
        .await
    }

    /// Emergency kill all — used during app exit. Awaits process teardown.
    pub async fn kill_all(stack_ref: &Arc<tokio::sync::Mutex<EngineStack>>) {
        Self::shutdown_slots_generic(
            stack_ref,
            |slot| matches!(slot.status, SlotStatus::Running | SlotStatus::Loading),
            false,
            true,
        )
        .await;
    }

    /// Create a StackEntry from an engine slot.
    fn slot_to_entry(i: usize, slot: &EngineSlot) -> StackEntry {
        let model_name = if slot.model_path.is_empty() {
            "none".to_string()
        } else {
            std::path::Path::new(&slot.model_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string()
        };
        StackEntry {
            idx: i,
            alias: slot.alias.clone(),
            model_name,
            port: slot.port,
            gpu: if slot.gpu_mask.is_empty() { "none".to_string() } else { slot.gpu_mask.clone() },
            status: slot.status.to_string(),
            slot_id: i as u32,
            provider_type: slot.backend_type.clone(),
            binary_profile: slot.binary_profile.clone(),
            model_path: slot.model_path.clone(),
            vram_mib: slot.vram_mib,
            gpu_breakdown_mib: slot.gpu_breakdown_mib.clone(),
            n_ctx: slot.n_ctx,
            provider_name: slot.provider_name.clone(),
            build_info: None,
            supports_fusion: slot.supports_fusion,
        }
    }

    /// Create a default StackEntry for an empty slot.
    fn default_entry(i: usize) -> StackEntry {
        StackEntry {
            idx: i,
            alias: format!("slot-{}", i),
            model_name: "none".to_string(),
            port: 0,
            gpu: "none".to_string(),
            status: "IDLE".to_string(),
            slot_id: i as u32,
            provider_type: String::new(),
            binary_profile: String::new(),
            model_path: String::new(),
            vram_mib: 0.0,
            gpu_breakdown_mib: None,
            n_ctx: DEFAULT_N_CTX,
            provider_name: String::new(),
            build_info: None,
            supports_fusion: false,
        }
    }

    pub fn get_status(&self) -> Vec<StackEntry> {
        let mut entries = Vec::with_capacity(self.slots.len());

        for (i, slot_opt) in self.slots.iter().enumerate() {
            match slot_opt {
                Some(slot_arc) => {
                    let slot = slot_arc.lock();
                    entries.push(Self::slot_to_entry(i, &slot));
                }
                None => {
                    entries.push(Self::default_entry(i));
                }
            }
        }
        entries
    }

    pub fn get_slot(&self, idx: usize) -> Option<parking_lot::MutexGuard<'_, EngineSlot>> {
        self.slots[idx].as_ref().map(|arc| arc.lock())
    }

    pub fn get_slot_pid(&self, idx: usize) -> Option<u32> {
        let slot_arc = self.slots.get(idx)?.as_ref()?;
        let slot = slot_arc.lock();
        slot.pid
    }
}
