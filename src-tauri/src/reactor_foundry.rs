//! Reactor Foundry — isolated build service for compiling llama.cpp providers.
//!
//! Directory policy (see FOUNDRY_DIRECTORY_STRUCTURE_MAP.md §1, §5, §6):
//!   engines/<provider_id>/llama.cpp/   — kept source tree (git clone/pull target, reused for incremental builds)
//!   engines/<provider_id>/work/         — **DISPOSABLE** — nuked with one remove_dir_all on every build exit (success/fail/cancel)
//!   artifacts/<provider_id>/<env>/Release/ — **SACRED** — only written on successful validation; automatic cleanup never touches it
//!
//! Build flow: clone/pull into llama.cpp, configure+build into a temp tree under work/build-{env}/,
//! on success copy the Release artifacts into the sacred artifacts tree, then nuke work/.
//! No build-* directories are ever created inside llama.cpp anymore. All legacy delete guards around profile trees are gone.

use serde::{Deserialize, Serialize};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock as StdLazyLock, Mutex};
use tokio::sync::{Mutex as TokioMutex, Notify};
use tauri::Manager;

use crate::engine_stack::EngineStack;
use crate::foundry_toolchain;
use crate::output_console::{
    BlackwellOutputConsoleCategory, BlackwellOutputConsoleLineStyle,
};

/// Global cancellation flag — set by foundry_cancel, polled during all long-running waits.
static BUILD_CANCELLED: AtomicBool = AtomicBool::new(false);

/// Wakes the configure→compile gate immediately when the user clicks PROCEED.
static BUILD_CONFIRM_NOTIFY: StdLazyLock<Notify> = StdLazyLock::new(Notify::new);

/// Arc clones passed into the background build worker (State cannot cross spawn).
struct FoundryWorkerApp {
    stack: Arc<TokioMutex<EngineStack>>,
    config: Arc<std::sync::Mutex<crate::config::AppConfig>>,
    app_handle: tauri::AppHandle,
}

fn foundry_console_start_session(
    app_handle: &tauri::AppHandle,
    build_id: u64,
    provider_id: &str,
    environment: &str,
) {
    app_handle
        .state::<crate::engine::AppContext>()
        .blackwell_output_console_manager
        .start_new_foundry_build_session(build_id, provider_id.to_string(), environment.to_string());
}

fn foundry_console_end_session(app_handle: &tauri::AppHandle, build_id: u64) {
    app_handle
        .state::<crate::engine::AppContext>()
        .blackwell_output_console_manager
        .end_foundry_build_session(build_id);
}

fn foundry_console_emit(
    app_handle: &tauri::AppHandle,
    line: String,
    style: BlackwellOutputConsoleLineStyle,
) {
    app_handle
        .state::<crate::engine::AppContext>()
        .blackwell_output_console_manager
        .emit_line_to_category(BlackwellOutputConsoleCategory::Foundry, line, style);
}

/// Tracked child process PIDs for cleanup on cancel. Protected by Mutex for cross-thread access.
static CHILD_PIDS: std::sync::LazyLock<std::sync::Mutex<Vec<u32>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(Vec::new()));

const DEFAULT_CMAKE_FLAGS: &[(&str, &str)] = &[
    ("ggml-llama", concat!(
        "-DLLAMA_CURL=OFF ",
        "-DGGML_CUDA=ON ",
        "-DGGML_CUDA_PEER_TO_PEER=ON ",
        "-DGGML_CUDA_FA_ALL_QUANTS=ON ",
        "-DGGML_AVX512=ON ",
        "-DGGML_NATIVE=ON"
    )),
];

fn get_default_cmake_flags(template_type: &str) -> &'static str {
    DEFAULT_CMAKE_FLAGS
        .iter()
        .find(|(key, _)| *key == template_type)
        .map(|(_, flags)| *flags)
        .unwrap_or("")
}

fn resolve_template_type(_provider_id: &str) -> &'static str {
    "ggml-llama"
}

// ── PID Tracking ─────────────────────────────────────────────────────

fn with_child_pids<F, R>(f: F) -> Option<R>
where
    F: FnOnce(&mut Vec<u32>) -> R,
{
    match CHILD_PIDS.lock() {
        Ok(mut guard) => Some(f(&mut *guard)),
        Err(e) => {
            log::error!("[foundry] child PID registry poisoned: {e}");
            None
        }
    }
}

fn try_lock_log_buf(buf: &std::sync::Mutex<Vec<String>>) -> Option<std::sync::MutexGuard<'_, Vec<String>>> {
    buf.lock()
        .map_err(|e| {
            log::error!("[foundry] log buffer mutex poisoned: {e}");
            e
        })
        .ok()
}

fn track_pid(pid: u32) {
    with_child_pids(|pids| pids.push(pid));
}

async fn git_hidden_output(
    git_exe: std::path::PathBuf,
    current_dir: PathBuf,
    args: Vec<String>,
) -> Result<std::process::Output, String> {
    crate::engine_utils::run_hidden_output_async(move || {
        let mut cmd = std::process::Command::new(&git_exe);
        crate::sidecar_elevate::apply_portable_git_env(&mut cmd, &git_exe);
        cmd.args(&args).current_dir(&current_dir);
        cmd
    })
    .await
}

async fn ensure_git_available(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let git_exe = crate::sidecar_elevate::resolve_git_exe(app)?;
    match git_hidden_output(git_exe.clone(), std::env::temp_dir(), vec!["--version".into()]).await
    {
        Ok(output) if output.status.success() => Ok(git_exe),
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            Err(format!(
                "Bundled Git check failed ({}): {}",
                git_exe.display(),
                if !stderr.trim().is_empty() {
                    stderr.trim()
                } else {
                    stdout.trim()
                }
            ))
        }
        Err(e) => Err(format!(
            "Bundled Git failed to run ({}): {}",
            git_exe.display(),
            e
        )),
    }
}

/// Kill any in-flight Foundry child processes (cmake, ninja, git, etc.).
pub fn foundry_kill_all_children() {
    kill_all_children();
}

fn kill_all_children() {
    let pids = with_child_pids(|pids| std::mem::take(pids)).unwrap_or_default();
    for pid in pids {
        let _ = std::process::Command::new("taskkill")
            .args(&["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(0x08000000)
            .status();
    }
}

fn clear_pids() {
    let _ = with_child_pids(|pids| pids.clear());
}

// ── Foundry Directory Helpers ───────────────────────────────────────

fn foundry_src_dir(provider_id: &str) -> PathBuf {
    crate::config::foundry_dir(provider_id).join("llama.cpp")
}

// ── State Machine ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BuildPhase {
    Idle,
    Configuring,
    WaitingForConfirm,
    Building,
    Validating,
    Complete,
    Failed(String),
    BackupLocked(String),
}

impl BuildPhase {
    pub fn step_name(&self) -> &'static str {
        match self {
            Self::Idle => "Idle",
            Self::Configuring => "Configuring",
            Self::WaitingForConfirm => "WaitingForConfirm",
            Self::Building => "Building",
            Self::Validating => "Validating",
            Self::Complete => "Complete",
            Self::Failed(_) => "Failed",
            Self::BackupLocked(_) => "BackupLocked",
        }
    }
}

#[derive(Debug, Clone)]
struct BuildState {
    build_id: u64,
    provider_id: String,
    profile_id: String,
    phase: BuildPhase,
}

static BUILD_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

// ── Global State ─────────────────────────────────────────────────────

static CURRENT_BUILD: std::sync::LazyLock<TokioMutex<Option<BuildState>>> =
    std::sync::LazyLock::new(|| TokioMutex::new(None));

async fn snapshot_build_state() -> Option<BuildState> {
    CURRENT_BUILD.lock().await.as_ref().cloned()
}

async fn require_build_state(context: &str) -> Result<BuildState, String> {
    snapshot_build_state()
        .await
        .ok_or_else(|| format!("Foundry build state missing ({context})"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildProgress {
    pub build_id: u64,
    pub phase: String,
    pub provider_id: String,
    pub environment: String,
    pub log_line: Option<String>,
}

// ── Event Emission ───────────────────────────────────────────────────

fn emit_build_event(
    app_handle: &tauri::AppHandle,
    state: &BuildState,
    log_line: Option<String>,
) {
    let event = serde_json::json!({
        "build_id": state.build_id,
        "phase": state.phase.step_name(),
        "provider_id": state.provider_id,
        "environment": state.profile_id,
        "log_line": log_line,
    });

    crate::ipc_meter::emit_tracked(app_handle, "foundry-progress", &event);
}

fn emit_build_batch(
    app_handle: &tauri::AppHandle,
    state: &BuildState,
    lines: Vec<String>,
) {
    let event = serde_json::json!({
        "build_id": state.build_id,
        "phase": state.phase.step_name(),
        "provider_id": state.provider_id,
        "environment": state.profile_id,
        "log_lines": lines,
    });

    crate::ipc_meter::emit_tracked(app_handle, "foundry-progress", &event);
}

// ── Batch Script Builder ─────────────────────────────────────────────

/// Generates the environment-scrubbed batch script that runs cmake configure or build.
/// All build directory creation / cleanup is now owned by Rust (see work/ nuke policy).
/// The caller supplies a fully-formed `final_command` that already contains absolute
/// `-B "..." -S "..."` (configure) or `cmake --build "..."` (compile) paths.
fn build_isolated_batch_script(
    vs_devcmd: &str,
    cuda_path_forced: &str,
    nvcc_bin: &str,
    versioned_var: &str,
    all_cuda_vars: &[String],
    msvc_asm_bin: Option<&str>,
    git_cmd_bin: Option<&str>,
    final_command: String,
) -> Vec<String> {
    let mut lines = vec!["@echo off".to_string(), "set \"CUDA_PATH=\"".to_string()];
    for var in all_cuda_vars {
        lines.push(format!("set \"{var}=\""));
    }
    lines.push(format!("call \"{vs_devcmd}\" -arch=amd64 -host_arch=amd64"));
    if let Some(git_bin) = git_cmd_bin {
        lines.push(format!("set \"PATH={git_bin};%PATH%\""));
    }
    if let Some(asm_bin) = msvc_asm_bin {
        lines.push(format!("set \"PATH={asm_bin};%PATH%\""));
    }
    // Match scripts/test-foundry-configure.ps1 (devcmd → ml64 → CUDA_PATH → nvcc bin → cmake).
    lines.push(format!("set \"CUDA_PATH={cuda_path_forced}\""));
    lines.push(format!("set \"{versioned_var}={cuda_path_forced}\""));
    lines.push(format!("set \"PATH={nvcc_bin};%PATH%\""));
    // No rmdir/mkdir/cd of build dirs here — Rust controls the disposable work/ tree.
    lines.push(final_command);
    lines
}

// ── Streaming Log Infrastructure ─────────────────────────────────────

async fn stream_child_output(
    mut child: tokio::process::Child,
    app_handle: &tauri::AppHandle,
    state: &BuildState,
) -> (Option<std::process::ExitStatus>, Vec<String>) {
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            log::error!("[foundry] failed to capture child stdout");
            return (None, Vec::new());
        }
    };
    let stderr = match child.stderr.take() {
        Some(s) => s,
        None => {
            log::error!("[foundry] failed to capture child stderr");
            return (None, Vec::new());
        }
    };

    let stderr_capture: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_clone = stderr_capture.clone();

    let app_handle_clone = app_handle.clone();
    let state_clone = state.clone();

    let log_buffer: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let log_buffer_flush = log_buffer.clone();
    let stderr_clone2 = stderr_clone.clone();

    let flush_done: Arc<std::sync::atomic::AtomicBool> = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flush_done_inner = flush_done.clone();
    let app_handle_flush = app_handle_clone.clone();
    let state_flush = state_clone.clone();

    let _flush_handle = tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_millis(250));
        loop {
            if flush_done_inner.load(Ordering::SeqCst) { break };
            interval.tick().await;
            if let Some(mut buf) = try_lock_log_buf(&log_buffer_flush) {
                let batch = buf.drain(..).collect::<Vec<String>>();
                if !batch.is_empty() {
                    emit_build_batch(&app_handle_flush, &state_flush, batch);
                }
            }
        }
    });

    let stream_handle = tauri::async_runtime::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};

        let stdout_reader = BufReader::new(stdout);
        let mut stdout_lines = stdout_reader.lines();
        while let Ok(Some(line)) = stdout_lines.next_line().await {
            if !line.trim().is_empty() {
                if let Some(mut buf) = try_lock_log_buf(&log_buffer) {
                    buf.push(line);
                }
            }
        }

        let stderr_reader = BufReader::new(stderr);
        let mut stderr_lines = stderr_reader.lines();
        while let Ok(Some(line)) = stderr_lines.next_line().await {
            if !line.trim().is_empty() {
                if let Some(mut buf) = try_lock_log_buf(&log_buffer) {
                    buf.push(format!("[ERR] {}", line));
                }
                if let Some(mut err_buf) = try_lock_log_buf(&stderr_clone2) {
                    err_buf.push(line);
                }
            }
        }
        if let Some(mut buf) = try_lock_log_buf(&log_buffer) {
            let batch = buf.drain(..).collect::<Vec<String>>();
            if !batch.is_empty() {
                emit_build_batch(&app_handle_clone, &state_clone, batch);
            }
        }
    });

    let status = match wait_child_cancellable(&mut child).await {
        Some(status) => Some(status),
        None => {
            let _ = child.kill().await;
            flush_done.store(true, Ordering::SeqCst);
            stream_handle.await.ok();
            clear_pids();
            return (None, Vec::new());
        }
    };

    flush_done.store(true, Ordering::SeqCst);
    stream_handle.await.ok();

    let stderr_text = if status.is_none() {
        Vec::new()
    } else {
        try_lock_log_buf(&stderr_capture)
            .map(|mut buf| buf.drain(..).collect::<Vec<String>>())
            .unwrap_or_default()
    };

    (status, stderr_text)
}

async fn wait_child_cancellable(child: &mut tokio::process::Child) -> Option<std::process::ExitStatus> {
    loop {
        if BUILD_CANCELLED.load(Ordering::SeqCst) {
            return None;
        }
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => {
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            }
            Err(_) => {
                return None;
            }
        }
    }
}

fn is_cancelled() -> bool {
    BUILD_CANCELLED.load(Ordering::SeqCst)
}

/// Drop the in-memory build slot and disposable work/ tree for this attempt.
async fn clear_build_slot_if_matches(
    build_id: u64,
    provider_id: &str,
    app_handle: &tauri::AppHandle,
) {
    let should_clear = {
        let mut current = CURRENT_BUILD.lock().await;
        if current.as_ref().map(|s| s.build_id) == Some(build_id) {
            *current = None;
            true
        } else {
            false
        }
    };
    if should_clear {
        foundry_console_end_session(app_handle, build_id);
        let work_root = crate::config::foundry_work_dir(provider_id);
        let _ = tokio::fs::remove_dir_all(&work_root).await;
    }
}

// ── PR Parsing (URL or number) ───────────────────────────────────────

/// Extract owner/repo and PR number from a GitHub PR URL.
fn parse_github_pr(url: &str) -> Option<(String, String)> {
    let u = url.trim();
    if let Some(idx) = u.find("/pull/") {
        let before = &u[..idx];
        let after = &u[idx + 6..];
        let pr_num = after.split('/').next().unwrap_or(after).trim().to_string();
        if let Some(re) = regex::Regex::new(r"(?:https?://)?github\.com/([^/]+)/([^/?#]+)").ok() {
            if let Some(caps) = re.captures(before) {
                let owner = caps.get(1)?.as_str();
                let repo = caps.get(2)?.as_str();
                return Some((format!("{}/{}", owner, repo), pr_num));
            }
        }
    }
    None
}

/// Try to extract "owner/repo" from common GitHub git URL formats.
/// Used to enable number-only PR cherry-picks by guessing the repo from the provider.
fn extract_github_owner_repo(git_url: &str) -> Option<String> {
    let url = git_url.trim().trim_end_matches(".git");

    // https://github.com/owner/repo or git@github.com:owner/repo
    if let Some(rest) = url.strip_prefix("https://github.com/") {
        let parts: Vec<&str> = rest.split('/').collect();
        if parts.len() >= 2 {
            return Some(format!("{}/{}", parts[0], parts[1]));
        }
    } else if let Some(rest) = url.strip_prefix("git@github.com:") {
        let parts: Vec<&str> = rest.split('/').collect();
        if parts.len() >= 2 {
            return Some(format!("{}/{}", parts[0], parts[1]));
        }
    }

    None
}

/// Parse PR input: supports full URL or plain number.
/// Returns (owner_repo, pr_number) for URLs, or (None, number) for plain numbers.
fn parse_pr_input(pr_input: &str) -> Option<(Option<String>, String)> {
    let trimmed = pr_input.trim();
    
    // Try as plain number first
    if trimmed.chars().all(|c| c.is_ascii_digit()) {
        return Some((None, trimmed.to_string()));
    }

    // Try as GitHub PR URL
    if let Some((owner_repo, pr_num)) = parse_github_pr(trimmed) {
        return Some((Some(owner_repo), pr_num));
    }

    None
}

// ── Core Build Service ───────────────────────────────────────────────

#[tauri::command]
pub async fn foundry_build(
    provider_id: String,
    environment: String,
    pr_url: Option<String>,
    max_cores: Option<u32>,
    cmake_flags: Option<String>,
    app: tauri::State<'_, crate::engine::AppContext>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // Fail fast on bad profile/manifest before reserving the build slot.
    let profile = foundry_toolchain::validate_profile_ready(&environment)?;
    let profile_id = profile.env_label().to_string();
    let _manifest = foundry_toolchain::load_manifest()?;

    // Reset cancellation state for new build
    BUILD_CANCELLED.store(false, Ordering::SeqCst);
    clear_pids();

    let build_id = BUILD_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;

    // Reserve CURRENT_BUILD immediately so concurrent foundry_build invocations cannot race
    // past the duplicate check and nuke an in-flight work/ tree.
    {
        let mut current = CURRENT_BUILD.lock().await;
        if current.is_some() {
            return Err(format!(
                "A Foundry build is already in progress for '{}' ({}). Wait for it to finish or cancel it explicitly.",
                current.as_ref().map(|s| s.provider_id.as_str()).unwrap_or("?"),
                current.as_ref().map(|s| s.profile_id.as_str()).unwrap_or("?"),
            ));
        }
        *current = Some(BuildState {
            build_id,
            provider_id: provider_id.clone(),
            profile_id: profile_id.clone(),
            phase: BuildPhase::Configuring,
        });
    }

    // Run the long build in the background so confirm/cancel IPC is never blocked by this command.
    let worker = FoundryWorkerApp {
        stack: app.stack.clone(),
        config: app.config.clone(),
        app_handle: app_handle.clone(),
    };
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_foundry_build_worker(
            worker,
            provider_id,
            environment,
            pr_url,
            max_cores,
            cmake_flags,
            build_id,
        )
        .await
        {
            log::error!("[foundry] Background build task failed: {}", e);
        }
    });

    Ok(())
}

async fn run_foundry_build_worker(
    worker: FoundryWorkerApp,
    provider_id: String,
    environment: String,
    pr_url: Option<String>,
    max_cores: Option<u32>,
    cmake_flags: Option<String>,
    build_id: u64,
) -> Result<(), String> {
    let manifest = foundry_toolchain::load_manifest()?;
    let profile = foundry_toolchain::validate_profile_ready(&environment)?;
    let profile_id = profile.env_label().to_string();
    let all_cuda_vars = foundry_toolchain::all_cuda_path_vars(&manifest);

    let app_handle = &worker.app_handle;

    foundry_console_start_session(app_handle, build_id, &provider_id, &environment);

    foundry_console_emit(
        app_handle,
        format!(
            "=== Starting Foundry build for '{}' ({}) - Build ID {} ===",
            provider_id, environment, build_id
        ),
        BlackwellOutputConsoleLineStyle::Command,
    );

    foundry_console_emit(
        app_handle,
        "Phase: Initializing repository and environment...".to_string(),
        BlackwellOutputConsoleLineStyle::Highlight,
    );

    foundry_console_emit(
        app_handle,
        "Phase: Configuring (CMake)...".to_string(),
        BlackwellOutputConsoleLineStyle::Highlight,
    );

    let state = require_build_state("build start").await?;

    emit_build_event(app_handle, &state, None);

    // Immediate feedback to the UI so the user sees the modal is alive (fixes the long "nothing happening" delay
    // after clicking the final Start/Proceed button). Heavy work (stop engines + git) follows.
    // The actual engine stop (if needed) happens below and will emit its own progress.
    // We emit a generic early message so the UI feels responsive immediately.

    // Stop engines for this provider — but only if any are actually running.
    // This avoids unnecessary 5+ second delays when the user has no engines active for this provider.
    let backend_type: String = {
        let cfg = worker.config.lock().map_err(|e| e.to_string())?;
        cfg.providers.iter()
            .find(|p| p.id == provider_id)
            .map(|p| p.id.clone())
            .unwrap_or_default()
    };

    let profile_key = profile_id.to_ascii_lowercase();
    let running_for_profile: Vec<_> = {
        let stack = worker.stack.lock().await;
        stack.get_status()
            .into_iter()
            .filter(|e| {
                let slot_profile = if e.binary_profile.is_empty() {
                    crate::config::DEFAULT_BINARY_PROFILE
                } else {
                    e.binary_profile.as_str()
                };
                e.provider_type == backend_type
                    && e.status != "IDLE"
                    && slot_profile.eq_ignore_ascii_case(&profile_key)
            })
            .collect()
    };

    let _stopped_count = if running_for_profile.is_empty() {
        // Fast path — nothing to stop for this profile
        if let Some(s) = snapshot_build_state().await {
            emit_build_event(app_handle, &s, Some(format!(
                "No running engines for '{}' profile '{}' — proceeding directly to build.",
                provider_id, profile_id
            )));
        }
        0
    } else {
        let stopped: Vec<usize> = EngineStack::stop_slots_by_provider_and_profile_parallel(
            &backend_type,
            &profile_key,
            &worker.stack,
        )
        .await;
        if !stopped.is_empty() {
            let current = CURRENT_BUILD.lock().await;
            if let Some(ref s) = *current {
                emit_build_event(app_handle, s,
                    Some(format!(
                        "Stopping {} running engine(s) for '{}' profile '{}' before build...",
                        stopped.len(), provider_id, profile_id
                    )));
            }
        }
        stopped.len()
    };

    // === DIRECTORY MODEL (see FOUNDRY_DIRECTORY_STRUCTURE_MAP.md §5) ===
    //
    // engine_root = foundry/engines/<provider_id>
    //   src_dir     = engine_root/llama.cpp          (kept for git reuse — never touched by cleanup)
    //   work_root   = engine_root/work               (DISPOSABLE — nuked on every exit)
    //     build_dir = work_root/build-{env}        (ephemeral CMake tree for this attempt)
    //
    // cmake_build_output_dir = build_dir/bin/Release  ← where cmake puts binaries during build
    // sacred_binary_path     = foundry/artifacts/<provider>/<env>/Release  ← permanent, never nuked
    //
    // Flow: cmake builds into work/build-{env}/bin/Release → validated → copied to sacred artifacts
    let engine_root            = crate::config::foundry_dir(&provider_id);
    let src_dir                = engine_root.join("llama.cpp");
    let work_root              = crate::config::foundry_work_dir(&provider_id);
    let build_dir              = work_root.join(format!("build-{}", profile_id));
    let cmake_build_output_dir = build_dir.join("bin").join("Release");
    // NOTE: bin_bak / rename dance removed entirely from normal build flow. Sacred artifacts are never touched during a build attempt.

    // Defensive nuke of any leftover work/ from a previous crashed build (safe — disposable by policy)
    let _ = tokio::fs::remove_dir_all(&work_root).await;
    if let Err(e) = tokio::fs::create_dir_all(&work_root).await {
        // Minimal rollback (will be simplified later)
       rollback_build(app_handle, &provider_id, &profile_id, build_id).execute().await;
        return Err(format!("Failed to create work directory: {}", e));
    }
    let _ = tokio::fs::create_dir_all(&build_dir).await;

    // ── Git Operations ───────────────────────────────────────────────

    let git_exe = match ensure_git_available(app_handle).await {
        Ok(exe) => exe,
        Err(e) => {
            rollback_build(app_handle, &provider_id, &profile_id, build_id)
                .execute()
                .await;
            return Err(e);
        }
    };

    let (git_url, branch) = {
        let cfg = worker.config.lock().map_err(|e| e.to_string())?;
        let p = cfg.providers.iter()
            .find(|p| p.id == provider_id);
        (
            p.map(|p| p.git_url.clone()).unwrap_or_default(),
            p.map(|p| p.branch.clone()).unwrap_or_else(|| "main".to_string()),
        )
    };

    if git_url.is_empty() {
            rollback_build(app_handle, &provider_id, &profile_id, build_id).execute().await;
            return Err(format!("Provider '{}' has no git_url configured.", provider_id));
    }

    let is_existing = src_dir.join(".git").exists();

    if !is_existing {
        if src_dir.exists() {
            let _ = tokio::fs::remove_dir_all(&src_dir).await;
        }

        let clone_parent = engine_root.parent().ok_or_else(|| {
            format!("Invalid engine root (no parent): {}", engine_root.display())
        })?;
        let clone_output = git_hidden_output(
            git_exe.clone(),
            clone_parent.to_path_buf(),
            vec![
                "clone".into(),
                "--depth".into(),
                "1".into(),
                "--recursive".into(),
                git_url.clone(),
                "-b".into(),
                branch.to_string(),
                src_dir.to_string_lossy().into_owned(),
            ],
        )
        .await
        .map_err(|e| format!("Git clone failed: {}", e))?;

        if !clone_output.status.success() {
            let stderr = String::from_utf8_lossy(&clone_output.stderr).to_string();
            rollback_build(app_handle, &provider_id, &profile_id, build_id).execute().await;
            return Err(format!("Git clone failed: {}", stderr));
        }

        emit_config_event(app_handle, &provider_id, &profile_id, build_id, Some("Repository cloned.".into()));
    } else {
        let pull_output = git_hidden_output(
            git_exe.clone(),
            src_dir.clone(),
            vec!["pull".into(), "--recurse-submodules".into()],
        )
        .await
        .map_err(|e| format!("Git pull failed: {}", e))?;

        if pull_output.status.success() {
            let _ = git_hidden_output(
                git_exe.clone(),
                src_dir.clone(),
                vec![
                    "submodule".into(),
                    "update".into(),
                    "--init".into(),
                    "--recursive".into(),
                ],
            )
            .await;
        }

        if !pull_output.status.success() {
            let stderr = String::from_utf8_lossy(&pull_output.stderr).to_string();
            rollback_build(app_handle, &provider_id, &profile_id, build_id).execute().await;
            return Err(format!("Git pull failed: {}", stderr));
        }

        emit_config_event(app_handle, &provider_id, &profile_id, build_id, Some("Repository updated.".into()));
    }

    // ── PR Patch Apply (optional) — URL or number format ─────────────
    if let Some(ref pr_input_str) = pr_url {
        match parse_pr_input(pr_input_str) {
            Some((owner_repo_opt, pr_num)) => {
                // Try to resolve owner/repo if only a number was given (user request)
                let resolved_owner_repo = owner_repo_opt.clone().or_else(|| {
                    // Load the provider's git_url and try to guess
                    if let Ok(cfg) = worker.config.lock() {
                        if let Some(p) = cfg.providers.iter().find(|p| p.id == provider_id) {
                            if !p.git_url.trim().is_empty() {
                                return extract_github_owner_repo(&p.git_url);
                            }
                        }
                    }
                    None
                });

                let log_msg = if let Some(ref owner_repo) = resolved_owner_repo {
                    if owner_repo_opt.is_none() {
                        format!("[PR] Guessed repo {} from provider git_url — fetching PR #{}...", owner_repo, pr_num)
                    } else {
                        format!("[PR] Fetching PR #{} from {}...", pr_num, owner_repo)
                    }
                } else {
                    format!("[PR] PR #{} (number only, no repo detected — informational only)", pr_num)
                };

                emit_config_event(app_handle, &provider_id, &profile_id, build_id, Some(log_msg));

                // Only attempt actual patch download if we have a resolved owner/repo
                if let Some(ref owner_repo) = resolved_owner_repo {
                    let patch_url = format!("https://patch-diff.githubusercontent.com/raw/{}/pull/{}.diff", owner_repo, pr_num);
                    let patch_bytes = reqwest::get(&patch_url)
                        .await
                        .map_err(|e| format!("HTTP fetch failed: {}", e))?;

                    if !patch_bytes.status().is_success() {
                        emit_config_event(app_handle, &provider_id, &profile_id, build_id,
                            Some(format!("[WARN] PR #{} not found or inaccessible (HTTP {}) — continuing build", pr_num, patch_bytes.status())));
                    } else {
                        let patch = String::from_utf8_lossy(&patch_bytes.bytes().await.unwrap_or_default()).to_string();

                        if patch.trim().is_empty() {
                            emit_config_event(app_handle, &provider_id, &profile_id, build_id,
                                Some(format!("[PR] #{} already applied — no changes needed", pr_num)));
                        } else if let Some(patch_parent) = src_dir.parent() {
                            let patch_path = patch_parent.join("pr-patch.diff");
                            if let Ok(()) = tokio::fs::write(&patch_path, &patch).await {
                                if let Some(patch_path_str) = patch_path.to_str() {
                                let mut apply_output = git_hidden_output(
                                    git_exe.clone(),
                                    src_dir.clone(),
                                    vec![
                                        "apply".into(),
                                        "--whitespace=nowarn".into(),
                                        patch_path_str.to_string(),
                                    ],
                                )
                                .await;

                                if apply_output.as_ref().map_or(true, |o| !o.status.success()) {
                                    apply_output = git_hidden_output(
                                        git_exe.clone(),
                                        src_dir.clone(),
                                        vec![
                                            "apply".into(),
                                            "--3way".into(),
                                            "--whitespace=nowarn".into(),
                                            patch_path_str.to_string(),
                                        ],
                                    )
                                    .await;
                                }

                                let _ = tokio::fs::remove_file(&patch_path).await;

                                match apply_output {
                                    Ok(ref out) if out.status.success() => {
                                        emit_config_event(app_handle, &provider_id, &profile_id, build_id,
                                            Some(format!("[PR] #{} applied successfully", pr_num)));

                                        let env_key = profile_id.clone();
                                        if let Ok(mut cfg) = worker.config.lock() {
                                            if let Some(p) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
                                                p.last_pr_per_env.insert(env_key, pr_num.clone());
                                            }
                                        }
                                    }
                                    _ => {
                                        let stderr = {
                                            let raw = apply_output
                                                .as_ref()
                                                .ok()
                                                .map(|o| String::from_utf8_lossy(&o.stderr).to_string())
                                                .unwrap_or_default();
                                            raw.lines().next().map(|l| l.trim().to_string()).unwrap_or_else(|| "unknown error".into())
                                        };
                                        let _ = git_hidden_output(
                                            git_exe.clone(),
                                            src_dir.clone(),
                                            vec!["merge".into(), "--abort".into()],
                                        )
                                        .await;
                                        emit_config_event(app_handle, &provider_id, &profile_id, build_id,
                                            Some(format!("[WARN] PR #{} apply failed: {} — continuing build", pr_num, stderr)));
                                    }
                                }
                                } else {
                                    emit_config_event(app_handle, &provider_id, &profile_id, build_id,
                                        Some("[WARN] Patch path is not valid UTF-8 — skipping PR apply".into()));
                                }
                            } else {
                                emit_config_event(app_handle, &provider_id, &profile_id, build_id,
                                    Some(format!("[WARN] PR #{} could not write patch file — continuing build", pr_num)));
                            }
                        } else {
                            emit_config_event(app_handle, &provider_id, &profile_id, build_id,
                                Some("[WARN] Cannot resolve patch path — skipping PR apply".into()));
                        }
                    }
                }
            }
            None => {
                emit_config_event(app_handle, &provider_id, &profile_id, build_id,
                    Some(format!("[WARN] Invalid PR input: '{}' — must be a GitHub PR URL or plain number", pr_input_str)));
            }
        }
    }

    // ── Provider display name (used in messages) ─────────────────────
    // The old pre-redesign "Atomic Bin Prep + BackupLocked rename dance" has been removed.
    // In the new model we build into a completely separate disposable work/ tree.
    // Sacred artifacts/<id>/<env>/Release is only written (by copy) on successful validation.
    // Therefore no pre-build backup/rename of a live binary is required.
    let _provider_display_name = {
        let cfg = worker.config.lock().map_err(|e| e.to_string())?;
        cfg.providers.iter()
            .find(|p| p.id == provider_id)
            .map(|p| p.display_name.clone())
            .unwrap_or_else(|| provider_id.clone())
    };

    // ── CMake Build Chain ────────────────────────────────────────────

    let template_type = resolve_template_type(&provider_id);

    let cmake_extra = {
        let cfg = worker.config.lock().map_err(|e| e.to_string())?;
        let p = cfg.providers.iter()
            .find(|p| p.id == provider_id);
        let build_profile = p.map(|p| p.build_profile.clone()).unwrap_or_default();

        // Foundry confirm modal loads provider build_profile for edit; persisted on build start.
        // cmake_flags from the invoke carries the edited profile for this configure attempt.
        if let Some(ref flags) = cmake_flags {
            if !flags.trim().is_empty() {
                flags.trim().to_string()
            } else if !build_profile.trim().is_empty() {
                build_profile.trim().to_string()
            } else {
                get_default_cmake_flags(template_type).to_string()
            }
        } else if !build_profile.trim().is_empty() {
            build_profile.trim().to_string()
        } else {
            get_default_cmake_flags(template_type).to_string()
        }
    };

    let vs_devcmd = profile.vs_devcmd.to_string_lossy().to_string();
    let cuda_path_forced = profile.cuda_root.to_string_lossy().to_string();

    let available: usize = std::thread::available_parallelism()
        .map(|p| p.get())
        .unwrap_or(8);
    let max_cores_usize: Option<usize> = max_cores.map(|n| n as usize);
    let num_cpus = max_cores_usize.unwrap_or(available).min(available).max(2);

    emit_config_event(app_handle, &provider_id, &profile_id, build_id, Some(format!(
        "[STAGE 1/3] CMAKE CONFIGURE — {} cores detected", num_cpus
    )));

    emit_config_event(app_handle, &provider_id, &profile_id, build_id, Some(format!(
        "[TOOLCHAIN] {} / CUDA {} / NVCC {}",
        profile.display_label(),
        profile.cuda_version_short(),
        profile.nvcc.display()
    )));

    emit_config_event(app_handle, &provider_id, &profile_id, build_id, Some("[STAGE 1/3] CMAKE CONFIGURE — Reviewing flags below. Click PROCEED to start compilation.".into()));

    let cuda_ver_short = profile.cuda_version_short();
    let toolset_flag = format!("-T \"cuda={}\"", cuda_ver_short);

    let forced_cuda_flags = format!(
        "-DCMAKE_CUDA_COMPILER=\"{}\" -DCUDAToolkit_ROOT=\"{}\" \
         -DCMAKE_VS_PLATFORM_TOOLSET_CUDA=\"{}\"",
        profile.nvcc.to_string_lossy().replace('\\', "/"),
        cuda_path_forced.replace('\\', "/"),
        cuda_ver_short
    );

    let asm_flag = profile.cmake_asm_compiler_flag(&manifest)?;
    let ml64_bin = profile
        .ml64_exe(&manifest)
        .parent()
        .map(|p| p.to_string_lossy().to_string());

    let joined_extra = if cmake_extra.is_empty() {
        String::new()
    } else {
        cmake_extra.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ")
    };

    let vs_def = foundry_toolchain::vs_def(&manifest, &profile.def.vs)?;
    let gen_flag = profile.cmake_generator_flag(vs_def);
    let nvcc_bin = profile.cuda_root.join("bin").to_string_lossy().to_string();
    let versioned_var = profile.cuda_path_var();

    let cmake_exe = foundry_toolchain::resolve_cmake_exe()?;
    let cmake_cmd = cmake_exe.to_string_lossy().replace('\\', "/");

    // Absolute out-of-source configure (build tree lives in disposable work/ — never inside source)
    let build_dir_str = build_dir.to_string_lossy().replace('\\', "/");
    let src_dir_str   = src_dir.to_string_lossy().replace('\\', "/");
    let cmake_configure_line = if joined_extra.is_empty() {
        format!(
            r#""{}" -B "{}" -S "{}" {} {} {} {}"#,
            cmake_cmd, build_dir_str, src_dir_str, gen_flag, toolset_flag, forced_cuda_flags, asm_flag
        )
    } else {
        format!(
            r#""{}" -B "{}" -S "{}" {} {} {} {} {}"#,
            cmake_cmd, build_dir_str, src_dir_str, gen_flag, toolset_flag, forced_cuda_flags, asm_flag, joined_extra
        )
    };

    emit_config_event(app_handle, &provider_id, &profile_id, build_id, Some(format!(
        "cmake -B work/build-{} -S llama.cpp {} {} {} {}{}",
        profile_id,
        gen_flag,
        toolset_flag,
        asm_flag,
        forced_cuda_flags,
        if !joined_extra.is_empty() { format!(" {}", joined_extra) } else { String::new() }
    )));

    let git_cmd_bin = git_exe.parent().map(|p| p.to_string_lossy().to_string());
    let cfg_batch_lines = build_isolated_batch_script(
        &vs_devcmd,
        &cuda_path_forced,
        &nvcc_bin,
        &versioned_var,
        &all_cuda_vars,
        ml64_bin.as_deref(),
        git_cmd_bin.as_deref(),
        cmake_configure_line,
    );
    let cfg_batch_content = cfg_batch_lines.join("\n");
    let cfg_batch_path = work_root.join("_build_cfg.bat");
    if let Err(e) = tokio::fs::write(&cfg_batch_path, &cfg_batch_content).await {
        clear_build_slot_if_matches(build_id, &provider_id, app_handle).await;
        return Err(format!("Failed to write build script: {}", e));
    }

    let (cfg_program, cfg_args) =
        crate::sidecar_elevate::cmd_script_launch(&cfg_batch_path);
    let mut cmd = tokio::process::Command::new(&cfg_program);
    cmd.args(&cfg_args)
        .current_dir(&src_dir)
        .creation_flags(0x08000000)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start cmake configure: {}", e))?;

    if let Some(pid) = child.id() {
        track_pid(pid);
    }

    let stderr_capture: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_capture_clone = stderr_capture.clone();

    let app_handle_cfg = app_handle.clone();
    let state_cfg = require_build_state("cmake configure").await?;

    let log_buffer: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let log_buffer_flush = log_buffer.clone();
    let stderr_capture_clone2 = stderr_capture_clone.clone();

    let flush_done: Arc<std::sync::atomic::AtomicBool> = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flush_done_inner = flush_done.clone();
    let app_handle_flush = app_handle_cfg.clone();
    let state_flush = state_cfg.clone();

    let _flush_handle = tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_millis(250));
        loop {
            if flush_done_inner.load(Ordering::SeqCst) { break };
            interval.tick().await;
            if let Some(mut buf) = try_lock_log_buf(&log_buffer_flush) {
                let batch = buf.drain(..).collect::<Vec<String>>();
                if !batch.is_empty() {
                    emit_build_batch(&app_handle_flush, &state_flush, batch);
                }
            }
        }
    });

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let stream_handle = tauri::async_runtime::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};

        let stdout_reader = BufReader::new(stdout);
        let mut stdout_lines = stdout_reader.lines();
        while let Ok(Some(line)) = stdout_lines.next_line().await {
            if !line.trim().is_empty() {
                if let Some(mut buf) = try_lock_log_buf(&log_buffer) {
                    buf.push(line);
                }
            }
        }

        let stderr_reader = BufReader::new(stderr);
        let mut stderr_lines = stderr_reader.lines();
        while let Ok(Some(line)) = stderr_lines.next_line().await {
            if !line.trim().is_empty() {
                if let Some(mut buf) = try_lock_log_buf(&log_buffer) {
                    buf.push(format!("[ERR] {}", line));
                }
                if let Some(mut err_buf) = try_lock_log_buf(&stderr_capture_clone2) {
                    err_buf.push(line);
                }
            }
        }
        if let Some(mut buf) = try_lock_log_buf(&log_buffer) {
            let batch = buf.drain(..).collect::<Vec<String>>();
            if !batch.is_empty() {
                emit_build_batch(&app_handle_cfg, &state_cfg, batch);
            }
        }
    });

    let cfg_status = match wait_child_cancellable(&mut child).await {
        Some(status) => Some(status),
        None => {
            let _ = child.kill().await;
            flush_done.store(true, Ordering::SeqCst);
            stream_handle.await.ok();
            clear_pids();
            let _ = tokio::fs::remove_file(&cfg_batch_path).await;
            clear_build_slot_if_matches(build_id, &provider_id, app_handle).await;
            return Err("Build cancelled by user.".to_string());
        }
    };

    flush_done.store(true, Ordering::SeqCst);
    stream_handle.await.ok();

    let Some(cfg_status) = cfg_status else {
        clear_pids();
        let _ = tokio::fs::remove_file(&cfg_batch_path).await;
        clear_build_slot_if_matches(build_id, &provider_id, app_handle).await;
        return Err("CMake configure process terminated unexpectedly.".to_string());
    };

    let _ = tokio::fs::remove_file(&cfg_batch_path).await;

    if !cfg_status.success() {
        let stderr_text: String = try_lock_log_buf(&stderr_capture)
            .map(|buf| buf.join("\n"))
            .unwrap_or_default();
        rollback_build(app_handle, &provider_id, &profile_id, build_id)
            .with_message(if stderr_text.is_empty() { "CMake configure failed.".into() } else { format!("CMake configure failed:\n{}", stderr_text) })
            .execute().await;

        clear_pids();

        // Ensure work dir is cleaned even on early configure failure (prevents stuck "building" + orphaned work dir)
        let work_root = crate::config::foundry_work_dir(&provider_id);
        let _ = tokio::fs::remove_dir_all(&work_root).await;
        foundry_console_end_session(app_handle, build_id);

        *CURRENT_BUILD.lock().await = None;
        return Err("CMake configure failed. Check the log above for details.".to_string());
    }

    // ── Check cancellation before showing PROCEED prompt ─────────────
    if is_cancelled() {
        clear_pids();
        clear_build_slot_if_matches(build_id, &provider_id, app_handle).await;
        return Err("Build cancelled by user.".to_string());
    }

    // ── Wait for user confirmation via state machine ─────────────────

    {
        let mut current = CURRENT_BUILD.lock().await;
        if let Some(ref mut s) = *current {
            s.phase = BuildPhase::WaitingForConfirm;
        }
    }
    if let Some(state) = snapshot_build_state().await {
        emit_build_event(app_handle, &state, Some(format!(
            "[WAIT-CONFIRM] CMake configure complete. {} targets detected.\nReview the log above — click PROCEED to start compilation (may take 10+ minutes).",
            if cmake_extra.is_empty() { "Default" } else { "Custom" }
        )));
    }

    let timeout_dur = std::time::Duration::from_secs(600);
    let start = std::time::Instant::now();
    loop {
        if is_cancelled() || CURRENT_BUILD.lock().await.is_none() {
            clear_pids();

            // Explicit cleanup on cancel from WaitingForConfirm
            let work_root = crate::config::foundry_work_dir(&provider_id);
            let _ = tokio::fs::remove_dir_all(&work_root).await;
            foundry_console_end_session(app_handle, build_id);

            emit_build_event(app_handle, &BuildState {
                build_id,
                provider_id: provider_id.clone(),
                profile_id: profile_id.clone(),
                phase: BuildPhase::Failed("Build cancelled.".into()),
            }, Some("Build cancelled.".into()));

            return Err("Build cancelled by user.".to_string());
        }
        // Check if phase has been transitioned from WaitingForConfirm to Building
        {
            let current = CURRENT_BUILD.lock().await;
            if let Some(ref s) = *current {
                if matches!(s.phase, BuildPhase::Building) {
                    break;
                }
            }
        }
        if start.elapsed() > timeout_dur {
            let mut current = CURRENT_BUILD.lock().await;
            if let Some(ref mut s) = *current {
                s.phase = BuildPhase::Failed("Build cancelled: no confirmation within 10 minutes.".into());
            }
            if let Some(state) = snapshot_build_state().await {
                emit_build_event(app_handle, &state, None);
            }
            *CURRENT_BUILD.lock().await = None;
            return Err("Build cancelled: user did not confirm.".to_string());
        }
        tokio::select! {
            _ = BUILD_CONFIRM_NOTIFY.notified() => {}
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(200)) => {}
        }
    }

    log::info!("User approved build, starting compilation...");

    foundry_console_emit(
        app_handle,
        "Phase: Compilation started...".to_string(),
        BlackwellOutputConsoleLineStyle::Highlight,
    );

    // ── PHASE 2: CMake Build (after user approval) ───────────────────

    if let Some(state) = snapshot_build_state().await {
        emit_build_event(app_handle, &state, Some(format!(
            "[BUILD] Starting compilation with {} cores...", num_cpus
        )));
    }

    let nvcc_bin = profile.cuda_root.join("bin").to_string_lossy().to_string();
    let versioned_var = profile.cuda_path_var();

    // Absolute --build (no cd, no reliance on relative layout)
    let build_dir_str = build_dir.to_string_lossy().replace('\\', "/");
    let build_batch_lines = build_isolated_batch_script(
        &vs_devcmd,
        &cuda_path_forced,
        &nvcc_bin,
        &versioned_var,
        &all_cuda_vars,
        ml64_bin.as_deref(),
        git_cmd_bin.as_deref(),
        format!(
            r#""{}" --build "{}" --config Release -j {}"#,
            cmake_cmd, build_dir_str, num_cpus
        ),
    );
    let build_batch_content = build_batch_lines.join("\n");
    let build_batch_path = work_root.join("_build_run.bat");
    if let Err(e) = tokio::fs::write(&build_batch_path, &build_batch_content).await {
        return Err(format!("Failed to write build script: {}", e));
    }

    let (build_program, build_args) =
        crate::sidecar_elevate::cmd_script_launch(&build_batch_path);
    let mut cmd2 = tokio::process::Command::new(&build_program);
    cmd2.args(&build_args)
        .current_dir(&src_dir)
        .creation_flags(0x08000000)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let child2 = cmd2
        .spawn()
        .map_err(|e| format!("Failed to start build: {}", e))?;

    if let Some(pid) = child2.id() {
        track_pid(pid);
    }

    let state_for_stream = require_build_state("compilation").await?;

    let (build_status, stderr_text) = stream_child_output(
        child2,
        app_handle,
        &state_for_stream,
    ).await;

    let _ = tokio::fs::remove_file(&build_batch_path).await;

    let Some(build_status) = build_status else {
        clear_pids();
        do_rollback(&cmake_build_output_dir).await;
        return Err("Build cancelled by user.".to_string());
    };

    if !build_status.success() {
        let stderr_text: String = stderr_text.join("\n");
        rollback_build(app_handle, &provider_id, &profile_id, build_id)
            .with_message(if stderr_text.is_empty() { "Build failed.".into() } else { format!("Build failed:\n{}", stderr_text) })
            .execute().await;

        // work/ (incl. build_dir) nuked on exit — no per-path delete needed
        clear_pids();
        *CURRENT_BUILD.lock().await = None;
        return Err(format!("Build failed.\nSTDERR: {}", stderr_text));
    }

    clear_pids();

    if is_cancelled() {
        // work/ nuked on exit
        return Err("Build cancelled by user.".to_string());
    }

    // ── Integrity Validation ─────────────────────────────────────────

    {
        let mut current = CURRENT_BUILD.lock().await;
        if let Some(ref mut s) = *current {
            s.phase = BuildPhase::Validating;
        }
    }
    if let Some(state) = snapshot_build_state().await {
        emit_build_event(app_handle, &state, Some("[STAGE 3/3] VALIDATE — Checking core binaries...".into()));
    }

    let core_binaries = ["llama-server.exe", "llama-cli.exe", "llama-quantize.exe"];

    let candidate_dirs: Vec<PathBuf> = vec![
        cmake_build_output_dir.clone(),
        src_dir.join("bin").join("Release"),
        src_dir.join("build").join("Release"),
    ];

    let mut all_present = true;
    let mut missing: Vec<String> = vec![];
    let mut validated_binary_dir: Option<PathBuf> = None;

    for bin in &core_binaries {
        let mut found = false;
        for dir in &candidate_dirs {
            if dir.join(bin).exists() {
                found = true;
                if validated_binary_dir.is_none() {
                    validated_binary_dir = Some(dir.clone());
                }
                break;
            }
        }
        if !found {
            all_present = false;
            missing.push(bin.to_string());
        }
    }

    if let Some(found_dir) = &validated_binary_dir {
        if *found_dir != cmake_build_output_dir {
            log::info!("Binaries found at {:?}, updating provider path", found_dir);
            let cfg = worker.config.lock().map_err(|e| e.to_string())?;
            let mut cfg_mut = cfg.clone();
            for p in &mut cfg_mut.providers {
                if p.id == provider_id {
                    let _ = found_dir.join("llama-server.exe");
                    let _ = crate::profile_binaries::set_profile_source(
                        p,
                        &profile_id,
                        crate::profile_binaries::SOURCE_FOUNDRY,
                    );
                    crate::profile_binaries::resolve_after_source_change(p);
                }
            }
            drop(cfg);
            if let Err(e) = persist_providers_atomic(&worker.config) {
                log::error!("[foundry] Failed to persist provider config after path correction: {}", e);
            }
        }
    }

    if !all_present {
        rollback_build(app_handle, &provider_id, &profile_id, build_id)
            .with_message(format!("Missing core binaries: {}", missing.join(", ")))
            .execute().await;

        // work/ nuked on exit
        *CURRENT_BUILD.lock().await = None;
        return Err(format!("Build completed but core binaries missing: {}", missing.join(", ")));
    }

    // ── Success: Capture build info + update per-env paths ────────────

    {
        let mut current = CURRENT_BUILD.lock().await;
        if let Some(ref mut s) = *current {
            s.phase = BuildPhase::Complete;
        }
    }
    if let Some(state) = snapshot_build_state().await {
        emit_build_event(app_handle, &state, Some("Build successful. Capturing version info...".into()));
    }

    // Publish sacred artifacts (copy from disposable work tree into artifacts/<id>/<env>/Release)
    // This is the ONLY place the sacred tree is written during a normal build.
    let sacred_binary_path = match publish_artifacts_to_sacred(&provider_id, &profile_id, &build_dir, &src_dir).await {
        Ok(p) => p,
        Err(e) => {
            // Still nuke work/ on the way out (via later finalize), but report the publish failure
            return Err(format!("Build succeeded but failed to publish sacred artifacts: {}", e));
        }
    };

    match crate::engine::get_binary_build_info(sacred_binary_path.clone()).await {
        Ok(build_info_raw) => {
            log::info!("[foundry] Captured build info for provider '{}' profile '{}': {} built {}",
                provider_id, profile_id, build_info_raw.version, build_info_raw.build_date);

            let mut cfg = worker.config.lock().map_err(|e| e.to_string())?;
            if let Some(provider) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
                let arches = crate::engine_utils::parse_cuda_architectures_from_cmake(&cmake_extra);
                let build_info = crate::types::BuildInfo {
                    version: build_info_raw.version,
                    build_date: build_info_raw.build_date,
                    cuda_version: build_info_raw.cuda_version.clone(),
                    cuda_architectures: if arches.is_empty() { None } else { Some(arches) },
                };
                provider.binary_source_per_env.insert(
                    profile_id.clone(),
                    crate::profile_binaries::SOURCE_FOUNDRY.to_string(),
                );
                provider.downloaded_version_per_env.remove(&profile_id);
                crate::profile_binaries::resolve_after_source_change(provider);

                provider
                    .foundry_build_info_per_env
                    .insert(profile_id.clone(), build_info.clone());
                provider
                    .build_info_per_env
                    .insert(profile_id.clone(), build_info.clone());
                provider
                    .build_info_per_env
                    .insert("current".to_string(), build_info);
            }
            drop(cfg);
            if let Err(e) = persist_providers_atomic(&worker.config) {
                log::error!("[foundry] Failed to persist provider config: {}", e);
            }
        }
        Err(e) => {
            log::warn!("[foundry] Failed to capture build info for provider '{}': {}", provider_id, e);
        }
    }

    if let Some(state) = snapshot_build_state().await {
        emit_build_event(app_handle, &state, Some("Foundry build complete.".into()));
    }

    // Feed final success message into the Blackwell Output Console
    foundry_console_emit(
        app_handle,
        crate::output_console::format_console_banner("Foundry build completed successfully"),
        BlackwellOutputConsoleLineStyle::Success,
    );

    // End the session and clear its buffer (per design: clear on successful close)
    foundry_console_end_session(app_handle, build_id);

    // On a clean successful build, let the tracked child (cmake --build) + its subtree terminate naturally.
    // This restores the reliable behavior that existed before the directory redesign work.
    // We only do aggressive killing on explicit cancel and hard failure paths.
    //
    // Give the process tree a tiny moment to unwind before we nuke the (still disposable) work/ dir.
    // Any stubborn residue will be cleaned on the next build entry anyway.
    tokio::time::sleep(std::time::Duration::from_millis(750)).await;

    let work_root = crate::config::foundry_work_dir(&provider_id);
    let _ = tokio::fs::remove_dir_all(&work_root).await;

    // Just tidy the PID list. Do not kill on success — children are expected to die naturally
    // once the tracked cmake --build child has exited (pre-refactor behavior).
    let remaining = with_child_pids(|pids| std::mem::take(pids)).unwrap_or_default();
    if !remaining.is_empty() {
        log::info!("[foundry] Success path: {} tracked PIDs left (expected to have exited naturally)", remaining.len());
    }

    *CURRENT_BUILD.lock().await = None;

    Ok(())
}

#[tauri::command]
pub async fn foundry_cancel(
    app: tauri::State<'_, crate::engine::AppContext>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    BUILD_CANCELLED.store(true, Ordering::SeqCst);

    kill_all_children();

    let mut current = CURRENT_BUILD.lock().await;
    if let Some(state) = current.take() {
        emit_build_event(&app_handle, &state,
            Some("Build cancelled by user.".into()));

        // Feed cancellation into the Blackwell Output Console
        app.blackwell_output_console_manager.emit_line_to_category(
            BlackwellOutputConsoleCategory::Foundry,
            "=== Build was cancelled by user ===".to_string(),
            BlackwellOutputConsoleLineStyle::Warning,
        );

        app.blackwell_output_console_manager
            .end_foundry_build_session(state.build_id);

        // Explicit nuke of the disposable work tree for this provider (new policy)
        let work_root = crate::config::foundry_work_dir(&state.provider_id);
        let _ = tokio::fs::remove_dir_all(&work_root).await;

        // Emit a final Failed phase event for the frontend (existing behavior)
        let event = serde_json::json!({
            "build_id": state.build_id,
            "phase": "Failed",
            "provider_id": state.provider_id,
            "environment": state.profile_id,
            "log_line": Some("Build cancelled by user."),
        });
        crate::ipc_meter::emit_tracked(&app_handle, "foundry-progress", &event);
    }

    Ok(())
}

#[tauri::command]
pub async fn foundry_status() -> Result<Option<BuildProgress>, String> {
    let current = CURRENT_BUILD.lock().await;
    Ok(current.as_ref().map(|state| BuildProgress {
        build_id: state.build_id,
        phase: state.phase.step_name().to_string(),
        provider_id: state.provider_id.clone(),
        environment: state.profile_id.clone(),
        log_line: None,
    }))
}

#[tauri::command]
pub async fn foundry_confirm_build() -> Result<(), String> {
    let mut current = CURRENT_BUILD.lock().await;
    if let Some(ref mut state) = *current {
        if matches!(state.phase, BuildPhase::WaitingForConfirm) {
            state.phase = BuildPhase::Building;
            BUILD_CONFIRM_NOTIFY.notify_waiters();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn foundry_resume_backup() -> Result<(), String> {
    let mut current = CURRENT_BUILD.lock().await;
    if let Some(ref mut state) = *current {
        if matches!(state.phase, BuildPhase::BackupLocked(_)) {
            state.phase = BuildPhase::Configuring;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn refresh_build_info(
    provider_id: String,
    app: tauri::State<'_, crate::engine::AppContext>,
) -> Result<Vec<crate::types::ProviderConfig>, String> {
    let prov = {
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        match cfg.providers.iter().find(|p| p.id == provider_id).cloned() {
            Some(p) => p,
            None => return Err(format!("Provider '{}' not found", provider_id)),
        }
    };

    let _prov = {
        if prov.binary_path_per_env.is_empty() && !prov.binary_path.is_empty() {
            let src_dir = foundry_src_dir(&provider_id);
            let old_build_dir = src_dir.join("build");
            if old_build_dir.exists() {
                let new_build_dir = src_dir.join("build-frontier");
                if !new_build_dir.exists() && old_build_dir.join("bin").exists() {
                    log::info!("[migration] One-time historical migration of ancient 'build/' directory for '{}'", provider_id);
                    let _ = tokio::fs::create_dir_all(&new_build_dir).await;
                    if tokio::fs::rename(&old_build_dir, &new_build_dir).await.is_ok() {
                        let new_bin = new_build_dir.join("bin").join("Release");
                        if new_bin.exists() {
                            // Publish binaries to sacred artifacts BEFORE setting paths.
                            // Never point config at disposable work/ directories.
                            let sacred_exe = crate::config::foundry_artifacts_dir()
                                .join(&provider_id).join("frontier").join("Release").join("llama-server.exe");
                            if let Some(sacred_dir) = sacred_exe.parent() {
                                let _ = tokio::fs::create_dir_all(sacred_dir).await;
                                if copy_dir_contents(&new_bin, &sacred_dir.to_path_buf()).await.is_ok() && sacred_exe.exists() {
                                    let mut cfg = app.config.lock().map_err(|e| e.to_string())?;
                                    if let Some(p) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
                                        let rel = crate::config::to_relative_path(&sacred_exe);
                                        p.binary_path_per_env.insert("frontier".to_string(), rel.clone());
                                        p.binary_path = rel;
                                    }
                                    drop(cfg);
                                    if let Err(e) = persist_providers_atomic(&app.config) {
                                        log::error!("[foundry] Failed to persist provider config: {}", e);
                                    }
                                } else {
                                    log::warn!("[migration] Failed to copy binaries to sacred artifacts for '{}'", provider_id);
                                }
                            }
                        }
                    } else {
                        log::warn!("[migration] Failed to rename build/ for '{}'", provider_id);
                    }
                }
            }
        }
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        cfg.providers.iter().find(|p| p.id == provider_id).cloned()
            .unwrap_or_else(|| prov)
    };

    let mut provider = {
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        cfg.providers
            .iter()
            .find(|p| p.id == provider_id)
            .cloned()
            .ok_or_else(|| format!("Provider '{}' not found", provider_id))?
    };
    crate::profile_binaries::resolve_after_source_change(&mut provider);
    let changed = enrich_provider_binary_info(&mut provider, &provider_id).await;

    if changed {
        let mut cfg = app.config.lock().map_err(|e| e.to_string())?;
        if let Some(p) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
            *p = provider;
        }
        drop(cfg);
        if let Err(e) = persist_providers_atomic(&app.config) {
            log::error!("[foundry] Failed to persist provider config: {}", e);
        }
    }

    let cfg = app.config.lock().map_err(|e| e.to_string())?;
    Ok(cfg.providers.clone())
}

#[tauri::command]
pub async fn foundry_restore(
    provider_id: String,
    environment: String,
    app: tauri::State<'_, crate::engine::AppContext>,
) -> Result<(), String> {
    let manifest = foundry_toolchain::load_manifest()?;
    let env_label = foundry_toolchain::find_profile_def(&manifest, &environment)?.id.clone();

    {
        let stopped = EngineStack::stop_slots_by_provider_and_profile_parallel(
            &provider_id,
            &env_label,
            &app.stack,
        )
        .await;
        if !stopped.is_empty() {
            log::info!(
                "[restore] Stopped {} engine(s) for '{}' profile '{}' before restore",
                stopped.len(),
                provider_id,
                env_label
            );
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
    }

    // --- Artifacts-based restore (Release.prev → Release) ---
    let sacred_release = crate::config::foundry_artifact_release_dir(&provider_id, &env_label);
    let artifacts_prev = sacred_release
        .parent()
        .ok_or_else(|| format!(
            "Invalid artifact path for '{}' ({}): {}",
            provider_id, env_label, sacred_release.display()
        ))?
        .join("Release.prev");

    if !artifacts_prev.exists() {
        return Err(format!(
            "No previous build found for '{}' ({}).\n\
             The current system keeps one previous artifact automatically as Release.prev.\n\
             Rebuild the profile to create a new backup.",
            provider_id, env_label
        ));
    }

    // Remove current Release dir if it exists
    if sacred_release.exists() {
        tokio::fs::remove_dir_all(&sacred_release).await
            .map_err(|e| format!("Failed to remove current Release: {}", e))?;
    }

    // Move .prev -> current Release
    tokio::fs::rename(&artifacts_prev, &sacred_release)
        .await
        .map_err(|e| format!("Failed to restore previous artifact: {}", e))?;

    // Verify restored exe exists — fail hard if missing
    let restored_exe = sacred_release.join("llama-server.exe");
    if !restored_exe.exists() {
        return Err(format!(
            "Restored artifact missing llama-server.exe at {}",
            restored_exe.display()
        ));
    }

    // Extract build info — fail hard if extraction fails
    let info = crate::engine::get_binary_build_info(restored_exe.to_string_lossy().to_string()).await
        .map_err(|e| format!("Failed to extract build info from restored binary: {}", e))?;

    {
        let mut cfg = app.config.lock().map_err(|e| e.to_string())?;
        if let Some(p) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
            let _ = crate::profile_binaries::set_profile_source(
                p,
                &env_label,
                crate::profile_binaries::SOURCE_FOUNDRY,
            );
            crate::profile_binaries::resolve_after_source_change(p);
            p.foundry_build_info_per_env
                .insert(env_label.to_string(), info.clone());
            p.build_info_per_env
                .insert(env_label.to_string(), info.clone());
            p.build_info_per_env
                .insert("current".to_string(), info);
        }
        drop(cfg);
    }

    // Persist with error logging (not silent discard)
    if let Err(e) = persist_providers_atomic(&app.config) {
        log::error!("[restore] Failed to persist provider config: {}", e);
    }

    // Emit Blackwell Output Console event for restore completion
    app.blackwell_output_console_manager.emit_line_to_category(
        crate::output_console::BlackwellOutputConsoleCategory::Foundry,
        format!("=== Restored previous artifact for {} ({}) ===", provider_id, env_label),
        crate::output_console::BlackwellOutputConsoleLineStyle::Success,
    );

    log::info!("[restore] Restored previous artifact for {} {}", provider_id, env_label);
    Ok(())
}

// ── Helpers ──────────────────────────────────────────────────────────

async fn enrich_build_info_for_path(
    path: &str,
    build_profile: &str,
    preserve_cuda: Option<Vec<String>>,
) -> Option<crate::types::BuildInfo> {
    let mut info = crate::engine::get_binary_build_info(path.to_string()).await.ok()?;
    if crate::engine::is_placeholder_build_version(&info.version) {
        return None;
    }
    if let Some(arch) = preserve_cuda.filter(|v| !v.is_empty()) {
        info.cuda_architectures = Some(arch);
    }
    Some(crate::engine_utils::enrich_build_info_cuda_arch(
        info,
        build_profile,
    ))
}

async fn enrich_provider_binary_info(
    provider: &mut crate::types::ProviderConfig,
    provider_id: &str,
) -> bool {
    let build_profile = provider.build_profile.clone();
    let profiles = foundry_toolchain::profile_ids_or_default();
    let mut changed = false;

    for env_label in &profiles {
        if let Some(path) = provider.bundled_binary_path_per_env.get(env_label).cloned() {
            let preserve = provider
                .bundled_build_info_per_env
                .get(env_label)
                .and_then(|i| i.cuda_architectures.clone());
            if let Some(info) =
                enrich_build_info_for_path(&path, &build_profile, preserve).await
            {
                let existing = provider.bundled_build_info_per_env.get(env_label);
                if existing
                    .map(|e| e.version != info.version || e.build_date != info.build_date)
                    .unwrap_or(true)
                {
                    provider
                        .bundled_build_info_per_env
                        .insert(env_label.clone(), info);
                    changed = true;
                }
            }
        }

        if let Some(path) = provider.foundry_binary_path_per_env.get(env_label).cloned() {
            let preserve = provider
                .foundry_build_info_per_env
                .get(env_label)
                .and_then(|i| i.cuda_architectures.clone());
            if let Some(info) =
                enrich_build_info_for_path(&path, &build_profile, preserve).await
            {
                let existing = provider.foundry_build_info_per_env.get(env_label);
                if existing
                    .map(|e| e.version != info.version || e.build_date != info.build_date)
                    .unwrap_or(true)
                {
                    provider
                        .foundry_build_info_per_env
                        .insert(env_label.clone(), info);
                    changed = true;
                }
            }
        }

        if let Some(path) = provider.binary_path_per_env.get(env_label).cloned() {
            let preserve = provider
                .build_info_per_env
                .get(env_label)
                .and_then(|i| i.cuda_architectures.clone());
            if let Some(info) =
                enrich_build_info_for_path(&path, &build_profile, preserve).await
            {
                log::info!(
                    "[refresh] {} env '{}': {} built {}",
                    provider_id,
                    env_label,
                    info.version,
                    info.build_date
                );
                let existing = provider.build_info_per_env.get(env_label);
                if existing
                    .map(|e| e.version != info.version || e.build_date != info.build_date)
                    .unwrap_or(true)
                {
                    provider.build_info_per_env.insert(env_label.clone(), info);
                    changed = true;
                }
            }
        }
    }

    let profiles_set: std::collections::HashSet<&str> =
        profiles.iter().map(|s| s.as_str()).collect();
    if let Some((_, latest)) = provider
        .build_info_per_env
        .iter()
        .filter(|(k, _)| profiles_set.contains(k.as_str()))
        .max_by_key(|(_, info)| info.build_date.as_str())
    {
        let current_existing = provider.build_info_per_env.get("current");
        if current_existing
            .map(|e| e.version != latest.version || e.build_date != latest.build_date)
            .unwrap_or(true)
        {
            provider
                .build_info_per_env
                .insert("current".to_string(), latest.clone());
            changed = true;
        }
    }

    changed
}

fn persist_providers_atomic(config: &Arc<std::sync::Mutex<crate::config::AppConfig>>) -> Result<(), String> {
    let providers = {
        let cfg = config.lock().map_err(|e| e.to_string())?;
        cfg.providers.clone()
    };
    crate::config::persist_user_providers_meta(&providers)
}

/// Emit a progress event for intermediate steps within the current phase.
fn emit_config_event(
    app_handle: &tauri::AppHandle,
    provider_id: &str,
    profile_id: &str,
    build_id: u64,
    log_line: Option<String>,
) {
    let event = serde_json::json!({
        "build_id": build_id,
        "phase": "Configuring",
        "provider_id": provider_id,
        "environment": profile_id,
        "log_line": log_line,
    });

    crate::ipc_meter::emit_tracked(app_handle, "foundry-progress", &event);
}

/// Rollback builder — allows attaching a custom failure message.
struct RollbackBuilder<'a> {
    app_handle: &'a tauri::AppHandle,
    provider_id: &'a str,
    profile_id: &'a str,
    build_id: u64,
    message: Option<String>,
}

impl<'a> RollbackBuilder<'a> {
    fn with_message(mut self, msg: String) -> Self {
        self.message = Some(msg);
        self
    }

    async fn execute(self) {
        let Self { app_handle, provider_id, profile_id, build_id, message } = self;

        // Directory rollback dance removed — sacred artifacts are never touched on failure paths.
        // The disposable work/ tree is nuked by the exit discipline in every terminal path.
        let msg = message.unwrap_or_else(|| "Build setup failed.".to_string());
        let event = serde_json::json!({
            "build_id": build_id,
            "phase": "Failed",
            "provider_id": provider_id,
            "environment": profile_id,
            "log_line": Some(msg),
        });

        crate::ipc_meter::emit_tracked(&app_handle, "foundry-progress", &event);
        *CURRENT_BUILD.lock().await = None;
    }
}

fn rollback_build<'a>(
    app_handle: &'a tauri::AppHandle,
    provider_id: &'a str,
    profile_id: &'a str,
    build_id: u64,
) -> RollbackBuilder<'a> {
    RollbackBuilder {
        app_handle,
        provider_id,
        profile_id,
        build_id,
        message: None,
    }
}

/// Perform rollback without emitting an event — use when caller needs custom error message.
    /// In the new directory model this is a no-op (work/ is nuked on exit).
    async fn do_rollback(_cmake_build_output_dir: &PathBuf) {
    // Sacred artifacts untouched on failure. Disposable work tree cleaned by caller exit paths.
}

// ── Sacred Artifacts Publish (new directory model) ──────────────────

/// Copy the contents of the just-built Release dir (inside the disposable work tree)
/// into the sacred artifacts/<provider>/<env>/Release location.
/// Returns the absolute path to the published llama-server.exe on success.
async fn publish_artifacts_to_sacred(
    provider_id: &str,
    profile_id: &str,
    build_dir: &PathBuf,   // the temp work/build-xxx
    _src_dir: &PathBuf,    // unused in new model but kept for signature compat during transition
) -> Result<String, String> {
    let temp_release = build_dir.join("bin").join("Release");
    if !temp_release.exists() {
        return Err("Build produced no Release directory under bin/".into());
    }

    let sacred = crate::config::foundry_artifact_release_dir(provider_id, profile_id);
    if let Err(e) = tokio::fs::create_dir_all(&sacred).await {
        return Err(format!("Failed to create sacred artifacts dir: {}", e));
    }

    // Keep one previous artifact for the "Restore Previous Build" button (user request).
    // Before overwriting, move the current Release to Release.prev (deleting old .prev if present).
    let prev_dir = sacred
        .parent()
        .ok_or_else(|| format!("Invalid sacred artifact path: {}", sacred.display()))?
        .join("Release.prev");
    if sacred.exists() {
        // Remove any previous .prev
        if prev_dir.exists() {
            let _ = tokio::fs::remove_dir_all(&prev_dir).await;
        }
        // Move current sacred -> .prev
        let _ = tokio::fs::rename(&sacred, &prev_dir).await;
        // Recreate the target dir for the new copy
        let _ = tokio::fs::create_dir_all(&sacred).await;
    }

    // Simple recursive copy (small tree: a few exes + dlls + pdbs at most)
    copy_dir_contents(&temp_release, &sacred).await
        .map_err(|e| format!("Copy to sacred artifacts failed: {}", e))?;

    let exe = sacred.join("llama-server.exe");
    if !exe.exists() {
        return Err("Published directory missing llama-server.exe".into());
    }

    log::info!("[foundry] Published sacred artifacts for {} {} -> {}", provider_id, profile_id, sacred.display());
    Ok(exe.to_string_lossy().to_string())
}

/// Recursively copy *contents* of src_dir into dst_dir (dst must already exist).
async fn copy_dir_contents(src_dir: &PathBuf, dst_dir: &PathBuf) -> std::io::Result<()> {
    let mut rd = tokio::fs::read_dir(src_dir).await?;
    while let Some(entry) = rd.next_entry().await? {
        let src_path = entry.path();
        let dst_path = dst_dir.join(entry.file_name());

        let ft = entry.file_type().await?;
        if ft.is_dir() {
            tokio::fs::create_dir_all(&dst_path).await?;
            Box::pin(copy_dir_contents(&src_path, &dst_path)).await?;
        } else {
            // Overwrite if exists (normal case when re-building a profile)
            let _ = tokio::fs::copy(&src_path, &dst_path).await?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn foundry_check_toolchain() -> Result<Vec<foundry_toolchain::ProfileCheck>, String> {
    foundry_toolchain::check_all_profiles()
}

#[tauri::command]
pub async fn foundry_get_profiles() -> Result<Vec<foundry_toolchain::ProfileDef>, String> {
    let manifest = foundry_toolchain::load_manifest()?;
    Ok(manifest.profiles)
}
