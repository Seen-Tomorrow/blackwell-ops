use serde::Serialize;
use tokio::sync::mpsc;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;

use crate::output_console::BlackwellOutputConsoleCategory;
use crate::output_console::BlackwellOutputConsoleLineStyle;

/// A single log line emitted to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub slot: usize,
    pub alias: String,
    pub text: String,
}

/// System-level event (launch debug, errors) — separate from engine stdout.
#[derive(Debug, Clone, Serialize)]
pub struct SystemEvent {
    pub slot: usize,
    pub alias: String,
    pub text: String,
    pub timestamp: String,
}

/// Batched log event emitted to frontend.
#[derive(Debug, Clone, Serialize)]
pub struct LogBatch {
    pub slot: usize,
    pub alias: String,
    pub entries: Vec<LogEntry>,
}

/// Shared telemetry tick — stderr log batch flush and fusion /slots poll cadence.
/// Single knob keeps log console and fusion meters aligned (25ms ≈ 80 HTTP polls/s per active engine).
/// Override via `BLACKWELL_TELEMETRY_TICK_MS` for bisection (e.g. 500 or 2000).
pub fn telemetry_tick_ms() -> u64 {
    crate::debug_flags::flags().telemetry_tick_ms
}
const MAX_BATCH_SIZE: usize = 10;
/// Bounded stderr line queue — drops on flood instead of unbounded RAM growth.
const STDERR_LINE_CHANNEL_CAP: usize = 4096;

/// Engine pipe line — stderr feeds UI + fusion; stdout is fusion/readiness only (lv≤3 INFO slot lines).
enum EnginePipeLine {
    Stderr(String),
    Stdout(String),
}
/// MoE --fit can print dozens of memory tables; keep enough stderr for one load.
const VRAM_LEARN_BUF_CAP: usize = 4096;
pub struct LogHub {
    app_handle: AppHandle,
}

impl Clone for LogHub {
    fn clone(&self) -> Self {
        Self { app_handle: self.app_handle.clone() }
    }
}

impl LogHub {
    pub fn new(app_handle: AppHandle) -> Self {
        Self { app_handle }
    }

    /// Emit a generic event to all frontend windows.
    pub fn emit(&self, event: &str, payload: impl serde::Serialize + Clone) {
        if crate::app_lifecycle::is_shutting_down() {
            return;
        }
        if crate::debug_flags::flags().disable_ipc_emit {
            return;
        }
        crate::ipc_meter::record(event);
        if let Err(e) = self.app_handle.emit(event, payload) {
            log::warn!("[LOG_HUB] emit failed: {}", e);
        }
    }

    /// Emit a line to the Blackwell Output Console via the specified category.
    pub fn emit_console_line(
        &self,
        category: BlackwellOutputConsoleCategory,
        text: &str,
        style: BlackwellOutputConsoleLineStyle,
    ) {
        if let Some(ctx) = self.app_handle.try_state::<crate::engine::AppContext>() {
            ctx.blackwell_output_console_manager.emit_line_to_category(category, text.to_string(), style);
        }
    }

    pub fn clear_stderr_tail(&self, slot_idx: usize) {
        let Some(ctx) = self.app_handle.try_state::<crate::engine::AppContext>() else {
            return;
        };
        ctx.slot_stderr_tails.lock().remove(&slot_idx);
    }

    pub fn record_stderr_line(&self, slot_idx: usize, line: &str) {
        let Some(ctx) = self.app_handle.try_state::<crate::engine::AppContext>() else {
            return;
        };
        if Self::is_idle_chatter(line) || Self::is_stderr_tail_noise(line) {
            return;
        }
        let cleaned = crate::engine_utils::strip_ansi(line).trim().to_string();
        if cleaned.is_empty() {
            return;
        }
        let mut tails = ctx.slot_stderr_tails.lock();
        tails.insert(slot_idx, vec![cleaned]);
    }

    pub fn stderr_tail_line(&self, slot_idx: usize) -> Option<String> {
        let Some(ctx) = self.app_handle.try_state::<crate::engine::AppContext>() else {
            return None;
        };
        let tails = ctx.slot_stderr_tails.lock();
        tails
            .get(&slot_idx)
            .and_then(|v| v.last())
            .cloned()
    }

    pub(crate) fn is_stderr_tail_noise(line: &str) -> bool {
        let lower = line.to_lowercase();
        if lower.starts_with("device ")
            && (lower.contains("compute capability") || lower.contains("vram:"))
        {
            return true;
        }
        if lower.starts_with("common_init_result:") {
            return true;
        }
        false
    }

    fn is_generic_load_failure_reason(reason: &str) -> bool {
        let lower = reason.to_lowercase();
        lower.starts_with("engine process exited")
            || lower.starts_with("engine exited before")
            || lower.contains("engine stderr had no readable")
            || lower.contains("engine reported a fatal error")
            || lower.contains("engine stopped or crashed during model load")
    }

    pub fn format_reason_with_stderr_tail(base_reason: &str, tail: Option<&str>) -> String {
        let Some(last_line) = tail.map(str::trim).filter(|s| !s.is_empty()) else {
            return base_reason.to_string();
        };

        if base_reason.trim().eq_ignore_ascii_case(last_line) {
            return base_reason.to_string();
        }

        if Self::is_generic_load_failure_reason(base_reason) {
            if let Some(idx) = base_reason.find(" — this model may not support") {
                return format!("{}{}", last_line, &base_reason[idx..]);
            }
            return last_line.to_string();
        }

        base_reason.to_string()
    }

    /// Spawns the slot's log reader task.
    /// Reads stderr pipe, batches and emits "engine-log-batch" to frontend,
    /// detects readiness ("server is listening" / "all slots idle"),
    /// and routes fusion-relevant events to FusionBrain via parse_line → route_log_event.
    pub fn spawn_slot_reader(
        &self,
        slot_idx: usize,
        alias: String,
        engine_pid: u32,
        engine_port: u16,
        stderr: std::process::ChildStderr,
        stdout: Option<std::process::ChildStdout>,
        learn_snapshot: crate::vram_learn::VramLearnSnapshot,
        model_ready: std::sync::Arc<std::sync::atomic::AtomicBool>,
        on_ready: std::sync::Arc<dyn Fn() + Send + Sync>,
    ) {
        let app_handle = self.app_handle.clone();
        self.clear_stderr_tail(slot_idx);

        // Internal channel: pipe readers → main processing loop (bounded)
        let (line_tx, line_rx) = mpsc::channel::<EnginePipeLine>(STDERR_LINE_CHANNEL_CAP);

        tokio::task::spawn_blocking({
            let tx = line_tx.clone();
            move || {
                use std::io::{BufRead, BufReader};
                let reader = BufReader::new(stderr);
                for line_result in reader.lines() {
                    match line_result {
                        Ok(line) => {
                            if !line.is_empty() {
                                let _ = tx.try_send(EnginePipeLine::Stderr(line));
                            }
                        }
                        Err(_) => break,
                    }
                }
            }
        });
        if let Some(stdout) = stdout {
            tokio::task::spawn_blocking({
                let tx = line_tx;
                move || {
                    use std::io::{BufRead, BufReader};
                    let reader = BufReader::new(stdout);
                    for line_result in reader.lines() {
                        match line_result {
                            Ok(line) => {
                                if !line.is_empty() {
                                    let _ = tx.try_send(EnginePipeLine::Stdout(line));
                                }
                            }
                            Err(_) => break,
                        }
                    }
                }
            });
        }

        // Main processing loop: line pipeline + batching + readiness detection
        tokio::spawn(Self::process_lines(
            app_handle,
            slot_idx,
            alias,
            engine_pid,
            engine_port,
            line_rx,
            learn_snapshot,
            model_ready,
            on_ready,
        ));

        // Log hub reader started now routed to Blackwell Output Console
    }

    /// Main processing loop: consumes raw lines from pipe readers, applies pipeline, batches to frontend.
    #[allow(unused_assignments)] // load_failed / fit table counters span loop iterations
    async fn process_lines(
        app_handle: AppHandle,
        slot_idx: usize,
        alias: String,
        engine_pid: u32,
        engine_port: u16,
        mut line_rx: mpsc::Receiver<EnginePipeLine>,
        learn_snapshot: crate::vram_learn::VramLearnSnapshot,
        model_ready: std::sync::Arc<std::sync::atomic::AtomicBool>,
        on_ready: std::sync::Arc<dyn Fn() + Send + Sync>,
    ) {
        use std::sync::atomic::Ordering;

        let fire_ready = {
            let ready_flag = model_ready.clone();
            let cb = on_ready.clone();
            move || {
                cb();
                ready_flag.store(true, Ordering::Release);
            }
        };

        let mut batch_buffer: Vec<LogEntry> = Vec::with_capacity(MAX_BATCH_SIZE);
        let mut last_emit = tokio::time::Instant::now();
        let batch_interval = tokio::time::Duration::from_millis(telemetry_tick_ms());

        let mut load_failed = false;
        let mut tables_seen: usize = 0;
        let mut tables_persisted: usize = 0;
        let mut launch_snapshot_persisted = false;
        let mut vram_learn_buf: Vec<String> = Vec::with_capacity(256);
        let fit_adapter =
            crate::fit_scanner::resolve_fit_adapter(&learn_snapshot.provider_id);

        let mut flush_interval = tokio::time::interval(batch_interval);

        loop {
            tokio::select! {
                biased;

                // ── Raw line from pipe reader ─────────────────────────────
                result = line_rx.recv() => {
                    let (raw_line, stdout_only) = match result {
                        Some(EnginePipeLine::Stderr(l)) => (l, false),
                        Some(EnginePipeLine::Stdout(l)) => (l, true),
                        None => {
                            crate::session_log::note_pipe_closed(
                                slot_idx,
                                &alias,
                                engine_pid,
                                model_ready.load(Ordering::Acquire),
                            );
                            // App exit: engines were taskkilled on purpose. Skip FIT persist + IPC
                            // into a dying WebView (heap corruption smoke trail after teardown DONE).
                            if crate::app_lifecycle::is_shutting_down() {
                                break;
                            }
                            if model_ready.load(Ordering::Acquire) {
                                let prev = tables_persisted;
                                if let Some((mib, total, gpu_breakdown)) = Self::persist_pending_fit_tables(
                                    &app_handle,
                                    &alias,
                                    &learn_snapshot,
                                    &vram_learn_buf,
                                    tables_persisted,
                                    "exit",
                                    fit_adapter,
                                )
                                .await
                                {
                                    tables_persisted = total;
                                    tables_seen = total;
                                    let added = total.saturating_sub(prev);
                                    if added > 0 {
                                        Self::emit_vram_learn_progress(
                                            &app_handle,
                                            &alias,
                                            mib,
                                            total,
                                            added,
                                            gpu_breakdown.as_deref(),
                                        );
                                    }
                                }
                            }
                            if !load_failed {
                                Self::cleanup_slot_if_still_active(
                                    &app_handle,
                                    slot_idx,
                                    &alias,
                                    engine_pid,
                                    engine_port,
                                    model_ready.load(Ordering::Acquire),
                                    "Engine exited before model finished loading",
                                )
                                .await;
                            }
                            break;
                        }
                    };

                    if raw_line.is_empty() { continue; }

                    let cleaned = raw_line.trim().to_string();
                    if cleaned.is_empty() { continue; }

                    if !Self::is_idle_chatter(&cleaned) {
                        crate::session_log::write_engine_line(
                            slot_idx,
                            &alias,
                            stdout_only,
                            &cleaned,
                        );
                    }

                    if !stdout_only {
                        LogHub::new(app_handle.clone()).record_stderr_line(slot_idx, &cleaned);
                    }

                    // ── Readiness check (one-shot) — before fatal heuristics ──────────────
                    if !model_ready.load(Ordering::Acquire) {
                        if Self::is_engine_ready_log_line(&cleaned) {
                            let source = if stdout_only { "stdout log pattern" } else { "stderr log pattern" };
                            Self::emit_readiness_debug(&app_handle, &alias, source, &cleaned);
                            fire_ready();
                            if let Some(ctx) = app_handle.try_state::<crate::engine::AppContext>() {
                                ctx.blackwell_output_console_manager.emit_line_to_category(
                                    BlackwellOutputConsoleCategory::Engines,
                                    format!("[{}] Engine ready", alias),
                                    BlackwellOutputConsoleLineStyle::Normal,
                                );
                            }
                            if !launch_snapshot_persisted {
                                if let Some((mib, gpu_breakdown, profile)) =
                                    Self::persist_launch_memory_snapshot(
                                        &app_handle,
                                        slot_idx,
                                        &alias,
                                        &learn_snapshot,
                                        &vram_learn_buf,
                                    )
                                    .await
                                {
                                    launch_snapshot_persisted = true;
                                    Self::emit_launch_memory_learn_progress(
                                        &app_handle,
                                        &alias,
                                        mib,
                                        profile.as_deref(),
                                        gpu_breakdown.as_deref(),
                                    );
                                }
                            }
                            if tables_seen > tables_persisted {
                                let prev = tables_persisted;
                                if let Some((mib, total, gpu_breakdown)) = Self::persist_pending_fit_tables(
                                    &app_handle,
                                    &alias,
                                    &learn_snapshot,
                                    &vram_learn_buf,
                                    tables_persisted,
                                    "fit",
                                    fit_adapter,
                                )
                                .await
                                {
                                    tables_persisted = total;
                                    let added = total.saturating_sub(prev);
                                    if added > 0 {
                                        Self::emit_vram_learn_progress(
                                            &app_handle,
                                            &alias,
                                            mib,
                                            total,
                                            added,
                                            gpu_breakdown.as_deref(),
                                        );
                                    }
                                }
                            }
                        }
                    }

                    if !stdout_only
                        && !model_ready.load(Ordering::Acquire)
                        && !load_failed
                        && Self::is_fatal_load_error(&cleaned)
                    {
                        load_failed = true;
                        let reason = Self::extract_load_error_reason(&cleaned);
                        let reason = if reason.trim().is_empty() {
                            "Model load failed — engine reported a fatal error".to_string()
                        } else {
                            reason
                        };
                        log::warn!(
                            "[log_hub] slot={} ({}) fatal stderr: {}",
                            slot_idx,
                            alias,
                            cleaned.chars().take(240).collect::<String>()
                        );
                        Self::fail_loading_from_log(&app_handle, slot_idx, &alias, &reason).await;
                        batch_buffer.push(LogEntry {
                            slot: slot_idx,
                            alias: alias.clone(),
                            text: cleaned.clone(),
                        });
                        let _ = Self::flush_batch(
                            &app_handle,
                            slot_idx,
                            &alias,
                            &mut batch_buffer,
                            &mut last_emit,
                            &batch_interval,
                        );
                        break;
                    }

                    // Buffer provider-specific learn lines; persist only on complete samples.
                    if !stdout_only
                        && (fit_adapter.is_vram_learn_line(&cleaned, stdout_only)
                            || crate::launch_memory_parse::is_launch_memory_line(&cleaned))
                    {
                        vram_learn_buf.push(cleaned.clone());
                        if vram_learn_buf.len() > VRAM_LEARN_BUF_CAP {
                            log::warn!(
                                "[vram_learn] slot={} stderr learn buffer exceeded {} lines — MoE FIT history may truncate",
                                slot_idx,
                                VRAM_LEARN_BUF_CAP
                            );
                        }
                    }
                    if fit_adapter.is_vram_learn_complete_line(&cleaned) {
                        let ready = model_ready.load(Ordering::Acquire);
                        let phase = if ready { "exit" } else { "fit" };
                        let prev_seen = tables_seen;
                        if let Some((mib, total, gpu_breakdown)) = Self::try_record_fit_tables(
                            &app_handle,
                            slot_idx,
                            &alias,
                            &learn_snapshot,
                            &vram_learn_buf,
                            prev_seen,
                            tables_persisted,
                            phase,
                            ready,
                            fit_adapter,
                        )
                        .await
                        {
                            tables_seen = total;
                            if ready {
                                let prev_persisted = tables_persisted;
                                tables_persisted = total;
                                let added = total.saturating_sub(prev_persisted);
                                if added > 0 {
                                    Self::emit_vram_learn_progress(
                                        &app_handle,
                                        &alias,
                                        mib,
                                        total,
                                        added,
                                        gpu_breakdown.as_deref(),
                                    );
                                }
                            }
                        }
                    }

                    // Skip idle poll chatter before fusion parse (regex savings at steady state)
                    if Self::is_idle_chatter(&cleaned) {
                        continue;
                    }
                    crate::fusion::parse_and_route_log_event(slot_idx, &cleaned);
                    if stdout_only {
                        continue;
                    }

                    // ── Push to batch buffer for frontend emit ──────
                    batch_buffer.push(LogEntry {
                        slot: slot_idx,
                        alias: alias.clone(),
                        text: cleaned.clone(),
                    });

                    // Batch emit when buffer is full or interval elapsed
                    if Self::flush_batch(&app_handle, slot_idx, &alias, &mut batch_buffer, &mut last_emit, &batch_interval) {
                        // flushed
                    }
                }

                // ── Timer tick — flush stale partial buffer ──────────────
                _ = flush_interval.tick() => {
                    if Self::flush_batch(&app_handle, slot_idx, &alias, &mut batch_buffer, &mut last_emit, &batch_interval) {
                        // flushed
                    }
                }
            }
        }

        // Flush remaining batch on channel close
        if !batch_buffer.is_empty() && !crate::debug_flags::flags().disable_ipc_emit {
            crate::ipc_meter::record("engine-log-batch");
            let _ = app_handle.emit("engine-log-batch", &LogBatch {
                slot: slot_idx,
                alias: alias.clone(),
                entries: std::mem::take(&mut batch_buffer),
            });
        }

        // Log hub reader stopped now routed to Blackwell Output Console
    }

    /// Parse stderr buffer, append any new complete breakdown tables.
    /// Returns (total_gpu_self_mib, table_count, per_gpu_self_mib).
    fn emit_learned_vram_changed(
        app_handle: &AppHandle,
        learn_snapshot: &crate::vram_learn::VramLearnSnapshot,
    ) {
        LogHub::new(app_handle.clone()).emit(
            "learned-vram-changed",
            &serde_json::json!({
                "model_path": learn_snapshot.model_path,
                "provider_id": learn_snapshot.provider_id,
            }),
        );
    }

    async fn persist_pending_fit_tables(
        app_handle: &AppHandle,
        alias: &str,
        learn_snapshot: &crate::vram_learn::VramLearnSnapshot,
        line_buf: &[String],
        already_persisted: usize,
        phase: &str,
        fit_adapter: crate::fit_adapters::FitAdapterId,
    ) -> Option<(f64, usize, Option<Vec<f64>>)> {
        let combined = line_buf.join("\n");
        let tables = fit_adapter.parse_vram_learn_tables(&combined);
        if tables.len() <= already_persisted {
            return None;
        }

        let table = tables.last()?;
        let latest_mib = table.total_gpu_self_mib();
        if latest_mib <= 0.0 {
            return None;
        }
        let gpu_breakdown = Some(table.gpu_self_mib.clone());
        let total = tables.len();
        let learn_key = &learn_snapshot.learn_key;
        match crate::vram_learn::append_fit_breakdown_tables(
            learn_key,
            &tables,
            already_persisted,
            phase,
        ) {
            Ok(Some(_)) => {
                log::info!(
                    "[vram_learn] persisted {} table(s) for {} → {:.1} MiB GPU (phase={})",
                    total.saturating_sub(already_persisted),
                    alias,
                    latest_mib,
                    phase
                );
                Self::emit_learned_vram_changed(app_handle, learn_snapshot);
                Some((latest_mib, total, gpu_breakdown))
            }
            Ok(None) => None,
            Err(e) => {
                log::warn!("[vram_learn] persist failed for {alias}: {e}");
                None
            }
        }
    }

    async fn try_record_fit_tables(
        app_handle: &AppHandle,
        slot_idx: usize,
        alias: &str,
        learn_snapshot: &crate::vram_learn::VramLearnSnapshot,
        line_buf: &[String],
        already_seen: usize,
        already_persisted: usize,
        phase: &str,
        persist: bool,
        fit_adapter: crate::fit_adapters::FitAdapterId,
    ) -> Option<(f64, usize, Option<Vec<f64>>)> {
        let combined = line_buf.join("\n");
        let tables = fit_adapter.parse_vram_learn_tables(&combined);
        if tables.len() <= already_seen {
            return None;
        }

        let ctx = app_handle.try_state::<crate::engine::AppContext>()?;
        let table = tables.last()?;
        let latest_mib = table.total_gpu_self_mib();
        if latest_mib <= 0.0 {
            return None;
        }
        let gpu_breakdown = Some(table.gpu_self_mib.clone());
        let total = tables.len();

        {
            let stack = ctx.stack.lock().await;
            stack.update_slot_vram(slot_idx, latest_mib, gpu_breakdown.clone());
            stack.emit_stack_changed();
        }

        if persist && tables.len() > already_persisted {
            let learn_key = &learn_snapshot.learn_key;
            match crate::vram_learn::append_fit_breakdown_tables(
                learn_key,
                &tables,
                already_persisted,
                phase,
            ) {
                Ok(Some(_)) => {
                    log::info!(
                        "[vram_learn] slot={} provider={} model={} → {:.1} MiB GPU total ({} tables, phase={})",
                        slot_idx,
                        learn_snapshot.provider_id,
                        learn_snapshot.model_path,
                        latest_mib,
                        total,
                        phase
                    );
                    Self::emit_learned_vram_changed(app_handle, learn_snapshot);
                }
                Ok(None) => {}
                Err(e) => {
                    log::warn!("[vram_learn] persist failed for {alias}: {e}");
                }
            }
        } else {
            log::info!(
                "[vram_learn] slot={} reserved {:.1} MiB GPU (table {}, phase={}) — persist deferred until ready",
                slot_idx,
                latest_mib,
                total,
                phase
            );
        }

        Some((latest_mib, total, gpu_breakdown))
    }

    fn format_gpu_self_breakdown(gpus: Option<&[f64]>) -> String {
        match gpus {
            Some(list) if list.len() > 1 => list
                .iter()
                .enumerate()
                .map(|(i, v)| format!("GPU{i}:{:.0}", v))
                .collect::<Vec<_>>()
                .join(" + "),
            Some(list) if !list.is_empty() => format!("{:.0}", list[0]),
            _ => String::new(),
        }
    }

    async fn persist_launch_memory_snapshot(
        app_handle: &AppHandle,
        slot_idx: usize,
        alias: &str,
        learn_snapshot: &crate::vram_learn::VramLearnSnapshot,
        line_buf: &[String],
    ) -> Option<(f64, Option<Vec<f64>>, Option<String>)> {
        let combined = line_buf.join("\n");
        let snapshot = crate::launch_memory_parse::parse_launch_memory_snapshot(&combined)?;
        let mib = snapshot.vram_mib;
        let gpu_breakdown = Some(snapshot.gpu_breakdown_mib.clone());
        let profile = snapshot.reference_profile.clone();

        if let Some(ctx) = app_handle.try_state::<crate::engine::AppContext>() {
            let stack = ctx.stack.lock().await;
            stack.update_slot_vram(slot_idx, mib, gpu_breakdown.clone());
            stack.emit_stack_changed();
        }

        match crate::vram_learn::record_launch_memory_snapshot(
            &learn_snapshot.learn_key,
            snapshot,
        ) {
            Ok(()) => {
                log::info!(
                    "[vram_learn] launch snapshot slot={} provider={} → {:.1} MiB GPU ({})",
                    slot_idx,
                    learn_snapshot.provider_id,
                    mib,
                    profile.as_deref().unwrap_or("generic"),
                );
                Self::emit_learned_vram_changed(app_handle, learn_snapshot);
                Some((mib, gpu_breakdown, profile))
            }
            Err(e) => {
                log::warn!("[vram_learn] launch snapshot persist failed for {alias}: {e}");
                None
            }
        }
    }

    fn emit_launch_memory_learn_progress(
        app_handle: &AppHandle,
        alias: &str,
        mib: f64,
        profile: Option<&str>,
        gpu_breakdown: Option<&[f64]>,
    ) {
        let per_gpu = Self::format_gpu_self_breakdown(gpu_breakdown);
        let gpu_detail = if per_gpu.is_empty() {
            String::new()
        } else {
            format!(" ({per_gpu})")
        };
        let profile_tag = profile
            .map(|p| format!(" · {p}"))
            .unwrap_or_default();
        if let Some(ctx) = app_handle.try_state::<crate::engine::AppContext>() {
            ctx.blackwell_output_console_manager.emit_line_to_category(
                BlackwellOutputConsoleCategory::Engines,
                format!(
                    "[{alias}] Learned launch memory: {mib:.0} MiB{gpu_detail}{profile_tag} — buffer inventory saved"
                ),
                BlackwellOutputConsoleLineStyle::Normal,
            );
        }
    }

    fn emit_vram_learn_progress(
        app_handle: &AppHandle,
        alias: &str,
        mib: f64,
        total_tables: usize,
        added: usize,
        gpu_breakdown: Option<&[f64]>,
    ) {
        let per_gpu = Self::format_gpu_self_breakdown(gpu_breakdown);
        let gpu_detail = if per_gpu.is_empty() {
            String::new()
        } else {
            format!(" ({per_gpu})")
        };

        if let Some(ctx) = app_handle.try_state::<crate::engine::AppContext>() {
            let msg = if total_tables <= 1 {
                format!("[{alias}] Learned VRAM: {mib:.0} MiB{gpu_detail} — saved for next launch forecast")
            } else if added > 1 {
                format!(
                    "[{alias}] Learned VRAM: {mib:.0} MiB{gpu_detail} — {total_tables} FIT tables recorded (+{added} new)"
                )
            } else {
                format!(
                    "[{alias}] Learned VRAM: {mib:.0} MiB{gpu_detail} — FIT table {total_tables} recorded"
                )
            };
            ctx.blackwell_output_console_manager.emit_line_to_category(
                BlackwellOutputConsoleCategory::Engines,
                msg,
                BlackwellOutputConsoleLineStyle::Normal,
            );
        }
        Self::emit_readiness_debug(
            app_handle,
            alias,
            "learned VRAM",
            &format!("{mib:.0} MiB{gpu_detail} — {total_tables} table(s)"),
        );
    }

    fn emit_readiness_debug(app_handle: &AppHandle, alias: &str, source: &str, detail: &str) {
        if let Some(ctx) = app_handle.try_state::<crate::engine::AppContext>() {
            let snippet: String = detail.chars().take(120).collect();
            ctx.blackwell_output_console_manager.emit_line_to_category(
                BlackwellOutputConsoleCategory::Debug,
                format!("[{alias}] readiness={source} | {snippet}"),
                BlackwellOutputConsoleLineStyle::Normal,
            );
        }
    }

    /// Model finished loading — NOT merely "HTTP listening" (GGML starts HTTP before weights).
    fn is_engine_ready_log_line(line: &str) -> bool {
        let lower = line.to_lowercase();
        lower.contains("all slots are idle")
            || (lower.contains("update_slots") && lower.contains("idle"))
            || lower.contains("model loaded")
    }

    /// FIT probe gave up on this split mode — engine continues load; must not fail the slot.
    fn is_fit_abort_warning(line: &str) -> bool {
        let lower = line.to_lowercase();
        (lower.contains("common_fit_params") || lower.contains("llama_params_fit"))
            && (lower.contains("failed to fit params") || lower.contains("not implemented"))
            && lower.contains("abort")
    }

    /// True only for explicit engine-reported failures — not normal CUDA_Host buffer info lines.
    fn is_fatal_load_error(line: &str) -> bool {
        let lower = line.to_lowercase();

        if Self::is_fit_abort_warning(line) {
            return false;
        }

        if lower.contains("exiting due to") || lower.contains("model loading error") {
            return true;
        }

        if lower.contains("invalid parameter") || lower.contains("invalid argument") {
            return true;
        }

        // Normal load info: `allocated 'CUDA_Host' buffer` — must not match `unable to allocate`.
        if lower.contains("unable to allocate") && !lower.contains("allocated '") {
            return true;
        }

        if lower.contains("failed to load model")
            || lower.contains("error loading model")
            || lower.contains("unable to load model")
        {
            return true;
        }

        if lower.contains("out of memory")
            || lower.contains("cuda error")
            || lower.contains("cudamalloc failed")
            || lower.contains("ggml_cuda error")
        {
            return true;
        }

        if lower.contains("not implemented") || lower.starts_with("error:") {
            return true;
        }

        false
    }

    fn extract_load_error_reason(line: &str) -> String {
        let lower = line.to_lowercase();
        if let Some(idx) = lower.find("exiting due to") {
            let tail = line[idx..].trim();
            let reason = tail
                .strip_prefix("exiting due to")
                .or_else(|| tail.strip_prefix("Exiting due to"))
                .unwrap_or(tail)
                .trim()
                .trim_start_matches(':')
                .trim();
            if !reason.is_empty() {
                return reason.to_string();
            }
        }
        if lower.contains("model loading error") {
            return "Model loading error — check VRAM, ctx size, and launch flags".to_string();
        }
        let stripped = crate::engine_utils::strip_ansi(line)
            .chars()
            .take(200)
            .collect::<String>()
            .trim()
            .to_string();
        if stripped.is_empty() {
            "Model load failed — engine stderr had no readable error text".to_string()
        } else {
            stripped
        }
    }

    async fn cleanup_slot_if_still_active(
        app_handle: &AppHandle,
        slot_idx: usize,
        alias: &str,
        engine_pid: u32,
        engine_port: u16,
        model_ready: bool,
        reason: &str,
    ) {
        if model_ready {
            return;
        }

        // Stderr pipe EOF ≠ process exit. Quiet/new models often stop writing to stderr
        // while mmap/GPU load continues — defer readiness to the HTTP probe.
        if crate::engine_utils::is_process_alive(engine_pid) {
            log::info!(
                "[log_hub] slot={} ({}) stderr ended but engine PID {engine_pid} still alive on port {engine_port} — waiting on HTTP readiness",
                slot_idx,
                alias
            );
            if let Some(ctx) = app_handle.try_state::<crate::engine::AppContext>() {
                ctx.blackwell_output_console_manager.emit_line_to_category(
                    BlackwellOutputConsoleCategory::Engines,
                    format!(
                        "[{alias}] Stderr quiet — model still loading (readiness via HTTP on port {engine_port})"
                    ),
                    BlackwellOutputConsoleLineStyle::Normal,
                );
            }
            return;
        }

        let Some(ctx) = app_handle.try_state::<crate::engine::AppContext>() else {
            return;
        };
        let still_active = {
            let stack = ctx.stack.lock().await;
            stack
                .get_slot(slot_idx)
                .map_or(false, |s| !matches!(s.status, crate::engine_stack::SlotStatus::Idle))
        };
        if !still_active {
            return;
        }

        crate::engine_stack::EngineStack::fail_loading_slot(
            slot_idx,
            &ctx.stack,
            ctx.log_hub.clone(),
            reason,
        )
        .await;
    }

    async fn fail_loading_from_log(
        app_handle: &AppHandle,
        slot_idx: usize,
        alias: &str,
        reason: &str,
    ) {
        let Some(ctx) = app_handle.try_state::<crate::engine::AppContext>() else {
            log::warn!(
                "[log_hub] load failure for slot {} ({}) — no AppContext: {}",
                slot_idx,
                alias,
                reason
            );
            return;
        };
        let stack_ref = ctx.stack.clone();
        crate::engine_stack::EngineStack::fail_loading_slot(
            slot_idx,
            &stack_ref,
            ctx.log_hub.clone(),
            reason,
        )
        .await;
    }

    /// Check if a line is idle poll chatter with no informational value.
    fn is_idle_chatter(line: &str) -> bool {
        line.contains("update_slots: all slots are idle")
            || (line.contains("log_server_r:") && line.contains("done request"))
    }

    /// Flush batch buffer if full or interval elapsed. Returns true if flushed.
    fn flush_batch(
        app_handle: &AppHandle,
        slot_idx: usize,
        alias: &str,
        batch_buffer: &mut Vec<LogEntry>,
        last_emit: &mut tokio::time::Instant,
        batch_interval: &tokio::time::Duration,
    ) -> bool {
        if batch_buffer.len() >= MAX_BATCH_SIZE || last_emit.elapsed() >= *batch_interval {
            let entries = std::mem::take(batch_buffer);
            if !entries.is_empty() && !crate::debug_flags::flags().disable_ipc_emit {
                let batch = LogBatch { slot: slot_idx, alias: alias.to_string(), entries };
                crate::ipc_meter::record("engine-log-batch");
                if let Err(_e) = app_handle.emit_to("main", "engine-log-batch", &batch) {
                    // Log hub emit_to failed now routed to Blackwell Output Console
                    let _ = app_handle.emit("engine-log-batch", &batch);
                }
            }
            *last_emit = tokio::time::Instant::now();
            true
        } else {
            false
        }
    }

    /// Emit a system-level event (launch debug, errors) visible in the frontend.
    pub async fn emit_system_event(&self, slot: usize, alias: &str, text: &str) {
        if crate::app_lifecycle::is_shutting_down() {
            return;
        }
        let event = SystemEvent {
            slot,
            alias: alias.to_string(),
            text: format!("[SYSTEM] {}", text),
            timestamp: chrono::Local::now().format("%H:%M:%S%.3f").to_string(),
        };

        if crate::debug_flags::flags().disable_ipc_emit {
            return;
        }
        crate::ipc_meter::record("engine-system");
        if let Err(e) = self.app_handle.emit("engine-system", &event) {
            log::warn!("Failed to emit engine-system event: {}", e);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::LogHub;

    #[test]
    fn format_reason_with_stderr_tail_replaces_generic_reason() {
        let msg = LogHub::format_reason_with_stderr_tail(
            "Engine process exited during model load",
            Some("error: invalid argument: --foo"),
        );
        assert_eq!(msg, "error: invalid argument: --foo");
    }

    #[test]
    fn format_reason_with_stderr_tail_keeps_tensor_hint() {
        let msg = LogHub::format_reason_with_stderr_tail(
            "Engine exited before model finished loading — this model may not support TENSOR split; try LAYER or NONE in MULTI-GPU settings",
            Some("llama_init_from_model: simultaneous use of SPLIT_MODE_TENSOR and KV cache quantization not implemented"),
        );
        assert!(msg.starts_with("llama_init_from_model:"));
        assert!(msg.contains("TENSOR split"));
    }

    #[test]
    fn format_reason_with_stderr_tail_skips_duplicate_fatal_reason() {
        let msg = LogHub::format_reason_with_stderr_tail(
            "error: invalid argument: --sex",
            Some("error: invalid argument: --sex"),
        );
        assert_eq!(msg, "error: invalid argument: --sex");
    }

    #[test]
    fn format_reason_with_stderr_tail_empty_passthrough() {
        let msg = LogHub::format_reason_with_stderr_tail("load timed out", None);
        assert_eq!(msg, "load timed out");
    }

    #[test]
    fn idle_chatter_matches_steady_state_slots_poll() {
        assert!(LogHub::is_idle_chatter(
            "14.24.080.725 I srv  update_slots: all slots are idle"
        ));
    }

    #[test]
    fn stderr_tail_noise_skips_gpu_enumeration() {
        assert!(LogHub::is_stderr_tail_noise(
            "Device 0: NVIDIA RTX PRO 6000 Blackwell Workstation Edition, compute capability 12.0, VMM: yes, VRAM: 97886 MiB"
        ));
        assert!(LogHub::is_stderr_tail_noise(
            "common_init_result: added <|repo_name|> logit bias = -inf"
        ));
    }

    #[test]
    fn fit_tensor_abort_warning_is_not_fatal() {
        let line = "common_fit_params: failed to fit params to free device memory: llama_params_fit is not implemented for SPLIT_MODE_TENSOR, abort";
        assert!(LogHub::is_fit_abort_warning(line));
        assert!(!LogHub::is_fatal_load_error(line));
    }

    #[test]
    fn tensor_not_implemented_without_fit_abort_stays_fatal() {
        let line = "llama_init_from_model: simultaneous use of SPLIT_MODE_TENSOR and KV cache quantization not implemented";
        assert!(!LogHub::is_fit_abort_warning(line));
        assert!(LogHub::is_fatal_load_error(line));
    }
}
