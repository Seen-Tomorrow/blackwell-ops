use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use crate::types::{EngineConfig, StackEntry};
use crate::log_hub::LogHub;

pub const DEFAULT_N_CTX: usize = 32768;
/// Returned from `load_slot` when `fail_loading_slot` already emitted the user-facing error.
pub const LOAD_FAILURE_ALREADY_REPORTED: &str = "LOAD_FAILURE_ALREADY_REPORTED";

/// When TENSOR split is active, silent engine exits are common — nudge users toward LAYER/NONE.
fn format_load_failure_reason(reason: &str, split_mode: &str) -> String {
    let trimmed = reason.trim();
    let core = if trimmed.is_empty() {
        "Engine stopped or crashed during model load (no stderr detail)".to_string()
    } else {
        trimmed.to_string()
    };
    if split_mode.trim().eq_ignore_ascii_case("tensor") {
        format!(
            "{core} — this model may not support TENSOR split; try LAYER or NONE in MULTI-GPU settings"
        )
    } else {
        core
    }
}

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

    if let Some(full) = crate::fit_scanner::find_existing_scan_in_provider_partition(
        &provider_id,
        &config.model_path,
    ) {
            let ctx_str = config.get_param_str("ctx").unwrap_or_else(|| "32768".to_string());
            let ctx_tokens = ctx_str.parse::<usize>().unwrap_or(32768);
        if let Some(pt) = full.points.iter().find(|p| {
            p.ctx == ctx_tokens && p.kv_quant.to_lowercase() == config.get_param_str("kv_quant").unwrap_or_else(|| "f16".to_string()).to_lowercase()
        }) {
            return pt.vram_mib;
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
    /// Multi-GPU split mode at launch (`none` / `layer` / `row` / `tensor`) — for load-failure hints.
    pub split_mode: String,
    /// Runtime profile binary env (vanguard/frontier/fresh/stable) used at launch.
    pub binary_profile: String,
    pub supports_fusion: bool,
    /// Set when stop/clear runs — background reaper exits without duplicate cleanup.
    pub reaper_cancel: Arc<AtomicBool>,
    /// One-shot guard — stderr EOF vs reaper must not both emit load-failure UI.
    pub load_fail_claimed: Arc<AtomicBool>,
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
                split_mode: String::new(),
                binary_profile: String::new(),
                supports_fusion: true,
                reaper_cancel: Arc::new(AtomicBool::new(false)),
                load_fail_claimed: Arc::new(AtomicBool::new(false)),
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

    /// Ports reserved or actively served by non-idle stack slots.
    pub fn reserved_ports(&self) -> HashSet<u16> {
        self.slots
            .iter()
            .filter_map(|slot_opt| {
                slot_opt.as_ref().and_then(|arc| {
                    let slot = arc.lock();
                    if matches!(slot.status, SlotStatus::Idle) || slot.port == 0 {
                        None
                    } else {
                        Some(slot.port)
                    }
                })
            })
            .collect()
    }

    /// PIDs of engines this app instance is still loading or running.
    pub fn live_engine_pids(&self) -> HashSet<u32> {
        self.slots
            .iter()
            .filter_map(|slot_opt| {
                slot_opt.as_ref().and_then(|arc| {
                    let slot = arc.lock();
                    if matches!(slot.status, SlotStatus::Idle) {
                        None
                    } else {
                        slot.pid
                    }
                })
            })
            .collect()
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
        slot.load_fail_claimed.store(false, Ordering::Release);
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
        fusion_adapter: crate::fusion::FusionAdapterId,
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
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        crate::engine_utils::apply_cuda_toolchain_for_profile(
            &mut cmd,
            if config.binary_profile.is_empty() {
                crate::config::DEFAULT_BINARY_PROFILE
            } else {
                config.binary_profile.as_str()
            },
        )?;

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return Err(format!("Failed to spawn {}: {}", binary_path.display(), e)),
        };

        let pid = child.id();
        let launch_cmd = format!("{} {}", binary_path.display(), cmd_args.join(" "));
        crate::session_log::record_launch(
            slot_idx,
            &config.alias,
            pid,
            config.port,
            &launch_cmd,
        );
        crate::fusion::registry::register_slot_adapter(slot_idx, fusion_adapter);

        let stderr = child.stderr.take().ok_or_else(|| {
            format!("Failed to capture stderr for {}", binary_path.display())
        })?;
        let stdout = child.stdout.take();
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
                cb();
                ready_flag.store(true, std::sync::atomic::Ordering::Release);
            })
        };
        log_hub.spawn_slot_reader(
            slot_idx,
            config.alias.clone(),
            pid,
            config.port,
            stderr,
            stdout,
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
            fusion_adapter,
        );

        // Quick alive check — give process 500ms to initialize (async — do not block tokio worker)
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if let Ok(status) = child.try_wait() {
            if let Some(code) = status {
                let exit_code = code.code().unwrap_or(-1);
                let already_reported = {
                    let stack = stack_ref.lock().await;
                    stack.get_slot(slot_idx).map_or(true, |slot| {
                        slot.load_fail_claimed.load(Ordering::Acquire)
                            || matches!(slot.status, SlotStatus::Idle)
                    })
                };
                if !already_reported {
                    let stack = stack_ref.lock().await;
                    stack.clear_slot(slot_idx);
                    stack.emit_stack_changed();
                }
                if already_reported {
                    return Err(LOAD_FAILURE_ALREADY_REPORTED.to_string());
                }
                return Err(format!(
                    "Engine crashed immediately with exit code {}",
                    crate::engine_utils::describe_process_exit_code(exit_code)
                ));
            }
        }

        if let Err(e) = crate::engine_port_lock::write_lock(config.port, pid, binary_path) {
            log::warn!(
                "[port_lock] Failed to write lock for port {} (PID {}): {}",
                config.port,
                pid,
                e
            );
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
            slot.split_mode = config.get_param_str("split").unwrap_or_default();
            slot.binary_profile = if config.binary_profile.is_empty() {
                crate::config::DEFAULT_BINARY_PROFILE.to_string()
            } else {
                config.binary_profile.clone()
            };
            slot.supports_fusion = supports_fusion;
            // Health/stderr readiness can fire while we still hold child/pid setup below.
            // Never downgrade Running → Loading or on_ready is one-shot and the stack sticks LOADING
            // while fusion /slots already reports READY (bench + phase bar gated on stack status).
            if !matches!(slot.status, SlotStatus::Running) {
                slot.status = SlotStatus::Loading;
            }
        }

        let reaper_cancel = {
            let slot = slot_arc.lock();
            slot.reaper_cancel.clone()
        };
        Self::spawn_reaper(slot_idx, slot_arc.clone(), stack_ref.clone(), log_hub.clone(), reaper_cancel);

        Ok(())
    }

    /// GGML can return /health ok while weights load; 5xx/unavailable from /slots means keep waiting.
    fn slots_still_loading(err: &str) -> bool {
        let lower = err.to_lowercase();
        lower.contains("status 5")
            || lower.contains("unavailable")
            || lower.contains("loading model")
    }

    /// `/slots` idle — same criterion fusion uses (model loaded, not processing).
    /// IK: fall back to `/health` ok (only true after weights load). GGML: never trust `/health`
    /// while `/slots` returns empty or a still-loading HTTP error.
    async fn probe_readiness_source(
        client: &reqwest::Client,
        port: u16,
        adapter: crate::fusion::FusionAdapterId,
    ) -> Option<&'static str> {
        match crate::fusion::poll_slots_normalized(client, "127.0.0.1", port, adapter).await {
            Ok(slots) => {
                if !slots.is_empty() && slots.iter().all(|s| !s.is_processing) {
                    Some("GET /slots idle")
                } else {
                    None
                }
            }
            Err(e) => {
                if Self::slots_still_loading(&e) {
                    return None;
                }
                // IK: /health ok only after weights load. GGML: blocked above while /slots 5xx.
                if Self::probe_health_ok(client, port).await {
                    Some("GET /health ok")
                } else {
                    None
                }
            }
        }
    }

    /// `/health` status=ok — IK returns ok only when weights are loaded; GGML returns ok while HTTP is up.
    async fn probe_health_ok(client: &reqwest::Client, port: u16) -> bool {
        let url = format!("http://127.0.0.1:{}/health", port);
        let Ok(resp) = client.get(&url).send().await else {
            return false;
        };
        if !resp.status().is_success() {
            return false;
        }
        let Ok(body) = resp.json::<serde_json::Value>().await else {
            return false;
        };
        body["status"].as_str() == Some("ok")
    }

    /// Poll until stack readiness — prefer `/slots` (GGML-safe); fall back to `/health` when /slots is absent.
    fn spawn_health_readiness_probe(
        port: u16,
        alias: String,
        log_hub: LogHub,
        on_ready: Arc<dyn Fn() + Send + Sync>,
        slot_arc: Arc<parking_lot::Mutex<EngineSlot>>,
        fusion_adapter: crate::fusion::FusionAdapterId,
    ) {
        tokio::spawn(async move {
            let client = match reqwest::Client::builder()
                .timeout(std::time::Duration::from_millis(1500))
                .build()
            {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("[readiness] HTTP client init failed for port {}: {}", port, e);
                    reqwest::Client::new()
                }
            };

            // 1200 × 500ms = 10 min — mmap + --fit on large models can exceed 5 min; we never kill on timeout.
            for _ in 0..1200 {
                {
                    let slot = slot_arc.lock();
                    if !matches!(slot.status, SlotStatus::Loading) {
                        return;
                    }
                }

                let source = Self::probe_readiness_source(&client, port, fusion_adapter).await;

                if let Some(source) = source {
                    let still_loading = {
                        let slot = slot_arc.lock();
                        matches!(slot.status, SlotStatus::Loading)
                    };
                    if !still_loading {
                        return;
                    }
                    log_hub.emit_console_line(
                        crate::output_console::BlackwellOutputConsoleCategory::Debug,
                        &format!("[{alias}] readiness={source} | port={port}"),
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

        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;

                if reaper_cancel.load(Ordering::Acquire) {
                    break;
                }

                let alive = crate::engine_utils::is_process_alive(pid);

                if !alive {
                    Self::handle_engine_died(slot_idx, &stack_ref, log_hub.clone()).await;
                    break;
                }
            }
        });
    }

    /// Background process teardown after slot is cleared — PID-only kill, never port scan.
    async fn finish_process_stop(
        pid: Option<u32>,
        proc: std::process::Child,
        hub: Option<LogHub>,
        slot_idx: usize,
        alias: String,
        emit_console: bool,
    ) {
        let exited = crate::engine_utils::stop_child_fast(proc, pid).await;

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

    /// Reaper entry: engine PID gone while slot still Loading or Running.
    async fn handle_engine_died(
        slot_idx: usize,
        stack_ref: &Arc<tokio::sync::Mutex<EngineStack>>,
        log_hub: LogHub,
    ) {
        let during_load = {
            let stack = stack_ref.lock().await;
            let Some(slot) = stack.get_slot(slot_idx) else {
                return;
            };
            if matches!(slot.status, SlotStatus::Idle) {
                return;
            }
            matches!(slot.status, SlotStatus::Loading)
        };

        if during_load {
            Self::fail_loading_slot(
                slot_idx,
                stack_ref,
                log_hub,
                "Engine process exited during model load",
            )
            .await;
        } else {
            Self::clear_crashed_running_slot(slot_idx, stack_ref, log_hub).await;
        }
    }

    /// Running engine exited unexpectedly — clear slot, delete port lock, notify UI (not a launch error).
    async fn clear_crashed_running_slot(
        slot_idx: usize,
        stack_ref: &Arc<tokio::sync::Mutex<EngineStack>>,
        log_hub: LogHub,
    ) {
        let snapshot = {
            let stack = stack_ref.lock().await;
            let Some(slot) = stack.get_slot(slot_idx) else {
                return;
            };
            if !matches!(slot.status, SlotStatus::Running) {
                return;
            }
            (slot.alias.clone(), slot.pid)
        };

        let (alias, pid) = snapshot;

        crate::fusion::stop_brain(slot_idx).await;

        log_hub
            .emit_system_event(
                slot_idx,
                &alias,
                "ENGINE_EXIT: Engine process exited unexpectedly",
            )
            .await;
        log_hub.emit_console_line(
            crate::output_console::BlackwellOutputConsoleCategory::Engines,
            &format!("[{alias}] Engine exited unexpectedly — slot cleared"),
            crate::output_console::BlackwellOutputConsoleLineStyle::Warning,
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
                pid,
                proc,
                Some(log_hub),
                slot_idx,
                alias,
                false,
            ));
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
            if slot.load_fail_claimed.swap(true, Ordering::AcqRel) {
                return;
            }
            slot.reaper_cancel.store(true, Ordering::Release);
            (
                slot.alias.clone(),
                slot.pid,
                slot.split_mode.clone(),
            )
        };

        let (alias, pid, split_mode) = snapshot;

        crate::fusion::stop_brain(slot_idx).await;

        // Pipe reader may still be flushing the last stderr line after process exit.
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let stderr_tail = log_hub.stderr_tail_line(slot_idx);
        let user_reason = format_load_failure_reason(reason, &split_mode);
        let user_reason = LogHub::format_reason_with_stderr_tail(&user_reason, stderr_tail.as_deref());
        log_hub.clear_stderr_tail(slot_idx);
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
                pid,
                proc,
                Some(log_hub),
                slot_idx,
                alias,
                false,
            ));
        } else if let Some(p) = pid {
            let _ = crate::engine_utils::kill_process_by_pid(p).await;
        }
    }

    /// Reset a slot to factory defaults.
    fn clear_slot(&self, idx: usize) {
        if let Some(slot_arc) = &self.slots[idx] {
            let mut slot = slot_arc.lock();
            let cleared_alias = slot.alias.clone();
            let port = slot.port;
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
            slot.split_mode.clear();
            slot.binary_profile.clear();
            slot.supports_fusion = false;
            slot.reaper_cancel = Arc::new(AtomicBool::new(false));
            slot.load_fail_claimed = Arc::new(AtomicBool::new(false));
            drop(slot);
            crate::session_log::note_slot_cleared(idx, &cleared_alias);
            crate::engine_port_lock::delete_lock(port);
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
        crate::fusion::stop_brain(slot_idx).await;

        // Extract process handle under per-slot lock only
        let (alias, pid, proc_to_stop, hub_opt) = {
            let stack = stack_ref.lock().await;
            let mut slot = stack.slots[slot_idx].as_ref().ok_or("Slot not found")?.lock();
            let alias = slot.alias.clone();
            let pid = slot.pid;
            let proc_to_stop = slot.child_proc.take();
            let hub_opt = stack.log_hub.as_ref().map(|h| h.clone());
            (alias, pid, proc_to_stop, hub_opt)
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
                            slot.pid,
                            slot.alias.clone(),
                            slot.child_proc.take(),
                        ));
                    }
                }
            }
            stack.log_hub.as_ref().map(|h| h.clone())
        };

        let stopped: Vec<usize> = targets.iter().map(|(i, _, _, _)| *i).collect();

        for (i, _, _, _) in &targets {
            crate::fusion::stop_brain(*i).await;
        }

        // Immediate UI — clear slots and emit before slow process/port cleanup
        {
            let stack = stack_ref.lock().await;
            for (i, _, _, _) in &targets {
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
        for (i, pid, alias, proc_to_stop) in targets {
            if let Some(proc) = proc_to_stop {
                let hub_clone = log_hub_ref.clone();
                let handle = tokio::spawn(Self::finish_process_stop(
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
            split_mode: slot.split_mode.clone(),
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
            split_mode: String::new(),
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
}

#[cfg(test)]
mod tests {
    use super::format_load_failure_reason;

    #[test]
    fn tensor_split_appends_layer_none_hint() {
        let msg = format_load_failure_reason(
            "Engine process exited during model load",
            "tensor",
        );
        assert!(msg.contains("TENSOR split"));
        assert!(msg.contains("LAYER or NONE"));
    }

    #[test]
    fn non_tensor_split_keeps_reason() {
        let msg = format_load_failure_reason(
            "Engine process exited during model load",
            "layer",
        );
        assert_eq!(msg, "Engine process exited during model load");
    }
}
