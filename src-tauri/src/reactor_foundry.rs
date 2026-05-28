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
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Mutex as TokioMutex;
use tauri::Emitter;
use crate::engine_stack::EngineStack;
use crate::output_console::{
    BlackwellOutputConsoleCategory, BlackwellOutputConsoleLineStyle,
};

/// Global cancellation flag — set by foundry_cancel, polled during all long-running waits.
static BUILD_CANCELLED: AtomicBool = AtomicBool::new(false);

/// Tracked child process PIDs for cleanup on cancel. Protected by Mutex for cross-thread access.
static CHILD_PIDS: std::sync::LazyLock<std::sync::Mutex<Vec<u32>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(Vec::new()));

// ── Build Environment Mapping ────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildEnv {
    Vanguard, // VS 2026/v18 + CUDA 13.2
    Stable,   // VS 2022 + CUDA 12.8
    Fresh,    // VS 2022 + CUDA 13.1
}

impl BuildEnv {
    pub fn vs_devcmd(&self) -> &'static str {
        match self {
            BuildEnv::Vanguard => r"C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\Tools\VsDevCmd.bat",
            BuildEnv::Stable => r"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat",
            BuildEnv::Fresh => r"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat",
        }
    }

    pub fn cuda_path(&self) -> &'static str {
        match self {
            BuildEnv::Vanguard => "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v13.2",
            BuildEnv::Stable => "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.8",
            BuildEnv::Fresh => "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v13.1",
        }
    }

    pub fn nvcc_path(&self) -> &'static str {
        match self {
            BuildEnv::Vanguard => r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.2\bin\nvcc.exe",
            BuildEnv::Stable => r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.8\bin\nvcc.exe",
            BuildEnv::Fresh => r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.1\bin\nvcc.exe",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            BuildEnv::Vanguard => "VANGUARD",
            BuildEnv::Stable => "STABLE",
            BuildEnv::Fresh => "FRESH",
        }
    }

    pub fn env_label(&self) -> &'static str {
        match self {
            BuildEnv::Vanguard => "vanguard",
            BuildEnv::Stable   => "stable",
            BuildEnv::Fresh    => "fresh",
        }
    }

    pub fn cmake_generator(&self) -> &'static str {
        match self {
            BuildEnv::Vanguard => r#"-G "Visual Studio 18 2026" -A x64"#,
            BuildEnv::Stable   => r#"-G "Visual Studio 17 2022" -A x64"#,
            BuildEnv::Fresh    => r#"-G "Visual Studio 17 2022" -A x64"#,
        }
    }

    pub fn cuda_versioned_var_name(&self) -> &'static str {
        match self {
            BuildEnv::Vanguard => "CUDA_PATH_V13_2",
            BuildEnv::Stable   => "CUDA_PATH_V12_8",
            BuildEnv::Fresh    => "CUDA_PATH_V13_1",
        }
    }

    pub fn cuda_version_short(&self) -> &'static str {
        match self {
            BuildEnv::Vanguard => "13.2",
            BuildEnv::Stable   => "12.8",
            BuildEnv::Fresh    => "13.1",
        }
    }

    pub fn excluded_cuda_versions(&self) -> &'static [&'static str] {
        match self {
            BuildEnv::Vanguard => &["v12.8", "v13.1"],
            BuildEnv::Stable => &["v13.1", "v13.2"],
            BuildEnv::Fresh => &["v12.8", "v13.2"],
        }
    }

    pub fn scrub_path(&self) -> String {
        let current_path = std::env::var("PATH").unwrap_or_default();
        let base = self.cuda_path();

        let mut filtered: Vec<String> = Vec::new();
        for entry in current_path.split(';') {
            let entry_lower = entry.to_lowercase();
            let is_cuda_toolkit = entry_lower.contains("nvidia gpu computing toolkit\\cuda\\");

            if !is_cuda_toolkit {
                filtered.push(entry.to_string());
            } else {
                let parts: Vec<&str> = entry_lower.split('\\').collect();
                if let Some(last) = parts.last() {
                    let excluded = self.excluded_cuda_versions();
                    if !excluded.contains(&last) {
                        filtered.push(entry.to_string());
                    }
                } else {
                    filtered.push(entry.to_string());
                }
            }
        }

        let mut scrubbed = format!(r"{};\{}\;", 
            format!("{}\\bin", base),
            format!("{}\\libnvvp", base)
        );

        scrubbed.push_str(&filtered.join(";"));
        scrubbed
    }
}

const DEFAULT_CMAKE_FLAGS: &[(&str, &str)] = &[
    ("ggml-llama", concat!(
        "-DLLAMA_CURL=OFF ",
        "-DGGML_CUDA=ON ",
        "-DCMAKE_CUDA_ARCHITECTURES=\"120a\" ",
        "-DGGML_CUDA_PEER_TO_PEER=ON ",
        "-DGGML_CUDA_FA_ALL_QUANTS=ON ",
        "-DGGML_AVX512=ON ",
        "-DGGML_NATIVE=ON"
    )),
    ("ik-llama", concat!(
        "-DLLAMA_CURL=OFF ",
        "-DGGML_CUDA=ON ",
        "-DCMAKE_CUDA_ARCHITECTURES=\"120a\" ",
        "-DGGML_CUDA_PEER_TO_PEER=ON "
    )),
];

fn get_default_cmake_flags(template_type: &str) -> &'static str {
    DEFAULT_CMAKE_FLAGS
        .iter()
        .find(|(key, _)| *key == template_type)
        .map(|(_, flags)| *flags)
        .unwrap_or("")
}

fn resolve_template_type(provider_id: &str) -> &'static str {
    if provider_id.to_lowercase().contains("ik") {
        "ik-llama"
    } else {
        "ggml-llama"
    }
}

// ── PID Tracking ─────────────────────────────────────────────────────

fn track_pid(pid: u32) {
    CHILD_PIDS.lock().unwrap().push(pid);
}

fn kill_all_children() {
    let pids = {
        let mut guard = CHILD_PIDS.lock().unwrap();
        std::mem::take(&mut *guard)
    };
    for pid in pids {
        let _ = std::process::Command::new("taskkill")
            .args(&["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(0x08000000)
            .status();
    }
}

fn clear_pids() {
    CHILD_PIDS.lock().unwrap().clear();
}

// ── Toolchain Paths (portable bundle) ────────────────────────────────

#[derive(Debug, Clone)]
pub struct ToolchainPaths {
    pub vs2022_devcmd: PathBuf,
    pub vs2026_devcmd: PathBuf,
    pub cuda_12_8: PathBuf,
    pub cuda_13_1: PathBuf,
    pub cuda_13_2: PathBuf,
}

impl ToolchainPaths {
    fn from_build_tools(app_root: &Path) -> Self {
        let bt = app_root.join("BuildTools");
        Self {
            vs2022_devcmd: bt.join("VS2022").join("Common7").join("Tools").join("VsDevCmd.bat"),
            vs2026_devcmd: bt.join("VS2026").join("Common7").join("Tools").join("VsDevCmd.bat"),
            cuda_12_8: bt.join("CUDA").join("v12.8"),
            cuda_13_1: bt.join("CUDA").join("v13.1"),
            cuda_13_2: bt.join("CUDA").join("v13.2"),
        }
    }

    pub fn resolve_vs_devcmd(&self, env: BuildEnv) -> PathBuf {
        match env {
            BuildEnv::Vanguard => self.vs2026_devcmd.clone(),
            BuildEnv::Stable | BuildEnv::Fresh => self.vs2022_devcmd.clone(),
        }
    }

    pub fn resolve_cuda_path(&self, env: BuildEnv) -> PathBuf {
        match env {
            BuildEnv::Vanguard => self.cuda_13_2.clone(),
            BuildEnv::Stable => self.cuda_12_8.clone(),
            BuildEnv::Fresh => self.cuda_13_1.clone(),
        }
    }

    pub fn resolve_nvcc_path(&self, env: BuildEnv) -> PathBuf {
        self.resolve_cuda_path(env).join("bin").join("nvcc.exe")
    }
}

/// Check if toolchain bundles are installed in the portable location.
pub async fn check_toolchain_installed(app_root: &Path) -> Result<bool, String> {
    let paths = ToolchainPaths::from_build_tools(app_root);
    Ok(paths.vs2022_devcmd.exists() &&
       paths.vs2026_devcmd.exists() &&
       paths.cuda_12_8.join("bin").exists() &&
       paths.cuda_13_1.join("bin").exists() &&
       paths.cuda_13_2.join("bin").exists())
}

/// Download toolchain bundles from GitHub releases.
pub async fn download_toolchain_bundles(
    _app_handle: &tauri::AppHandle,
    app_root: &Path,
) -> Result<(), String> {
    let installed = check_toolchain_installed(app_root).await?;
    if !installed {
        return Err("Toolchain not found. Please install VS2022/VS2026 and CUDA toolchains.".into());
    }
    Ok(())
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
    environment: BuildEnv,
    phase: BuildPhase,
}

static BUILD_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

// ── Global State ─────────────────────────────────────────────────────

static CURRENT_BUILD: std::sync::LazyLock<TokioMutex<Option<BuildState>>> =
    std::sync::LazyLock::new(|| TokioMutex::new(None));

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildProgress {
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
        "environment": state.environment.env_label(),
        "log_line": log_line,
    });

    if let Err(e) = app_handle.emit("foundry-progress", &event) {
        log::debug!("Failed to emit foundry-progress: {}", e);
    }
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
        "environment": state.environment.env_label(),
        "log_lines": lines,
    });

    if let Err(e) = app_handle.emit("foundry-progress", &event) {
        log::debug!("Failed to emit foundry-progress batch: {}", e);
    }
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
    final_command: String,
) -> Vec<String> {
    let mut lines = vec![
        "@echo off".to_string(),
        "set \"CUDA_PATH=\"".to_string(),
        "set \"CUDA_PATH_V12_8=\"".to_string(),
        "set \"CUDA_PATH_V13_1=\"".to_string(),
        "set \"CUDA_PATH_V13_2=\"".to_string(),
        format!("call \"{vs_devcmd}\" -arch=amd64 -host_arch=amd64"),
        format!("for /f \"usebackq delims=\" %%P in (`powershell -NoProfile -Command \"$p = $env:PATH -split ';' | Where-Object {{ $_.ToLower() -notlike '*nvidia gpu computing toolkit\\cuda*' }}; Write-Output ($p -join ';')\"`) do set \"CLEANPATH=%%P\""),
        "if defined CLEANPATH set \"PATH=%CLEANPATH%\"".to_string(),
        format!("set \"CUDA_PATH={cuda_path_forced}\""),
        format!("set \"{}={cuda_path_forced}\"", versioned_var),
        format!("set \"PATH={};%PATH%\"", nvcc_bin),
    ];
    // No rmdir/mkdir/cd of build dirs here — Rust controls the disposable work/ tree.
    lines.push(final_command);
    lines
}

// ── Streaming Log Infrastructure ─────────────────────────────────────

use std::sync::{Arc, Mutex};

async fn stream_child_output(
    mut child: tokio::process::Child,
    app_handle: &tauri::AppHandle,
    state: &BuildState,
) -> (Option<std::process::ExitStatus>, Vec<String>) {
    let stdout = child.stdout.take().expect("Failed to capture stdout");
    let stderr = child.stderr.take().expect("Failed to capture stderr");

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
            let batch = log_buffer_flush.lock().unwrap().drain(..).collect::<Vec<String>>();
            if !batch.is_empty() {
                emit_build_batch(&app_handle_flush, &state_flush, batch);
            }
        }
    });

    let stream_handle = tauri::async_runtime::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};

        let stdout_reader = BufReader::new(stdout);
        let mut stdout_lines = stdout_reader.lines();
        while let Ok(Some(line)) = stdout_lines.next_line().await {
            if !line.trim().is_empty() {
                log_buffer.lock().unwrap().push(line);
            }
        }

        let stderr_reader = BufReader::new(stderr);
        let mut stderr_lines = stderr_reader.lines();
        while let Ok(Some(line)) = stderr_lines.next_line().await {
            if !line.trim().is_empty() {
                log_buffer.lock().unwrap().push(format!("[ERR] {}", line));
                stderr_clone2.lock().unwrap().push(line);
            }
        }
        let batch = log_buffer.lock().unwrap().drain(..).collect::<Vec<String>>();
        if !batch.is_empty() {
            emit_build_batch(&app_handle_clone, &state_clone, batch);
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
        stderr_capture.lock().unwrap().drain(..).collect::<Vec<String>>()
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
                let owner = caps.get(1).unwrap().as_str().to_string();
                let repo = caps.get(2).unwrap().as_str().to_string();
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
    _app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let env = match environment.to_lowercase().as_str() {
        "vanguard" => BuildEnv::Vanguard,
        "stable" => BuildEnv::Stable,
        "fresh" => BuildEnv::Fresh,
        _ => return Err(format!("Unknown build environment: {}. Use 'vanguard', 'stable', or 'fresh'.", environment)),
    };

    let app_handle = &_app_handle;

    // Reset cancellation state for new build
    BUILD_CANCELLED.store(false, Ordering::SeqCst);
    clear_pids();

    {
        let mut current = CURRENT_BUILD.lock().await;
        if current.is_some() {
            if let Some(state) = current.take() {
                log::warn!("[foundry] Force-clearing orphaned build for '{}' env '{}'", state.provider_id, state.environment.env_label());
                emit_build_event(app_handle, &state,
                    Some("Build cancelled: frontend closed without proper cancel.".into()));
            }
        }
    }

    let build_id = BUILD_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;

    // Start tracking this build in the Blackwell Output Console (power-user output system)
    app.blackwell_output_console_manager
        .start_new_foundry_build_session(
            build_id,
            provider_id.clone(),
            environment.clone(),
        );

    // Emit an initial line into the Blackwell Output Console under the FOUNDRY category
    app.blackwell_output_console_manager.emit_line_to_category(
        BlackwellOutputConsoleCategory::Foundry,
        format!(
            "=== Starting Foundry build for '{}' ({}) - Build ID {} ===",
            provider_id, environment, build_id
        ),
        BlackwellOutputConsoleLineStyle::Command,
    );

    app.blackwell_output_console_manager.emit_line_to_category(
        BlackwellOutputConsoleCategory::Foundry,
        "Phase: Initializing repository and environment...".to_string(),
        BlackwellOutputConsoleLineStyle::Highlight,
    );

    app.blackwell_output_console_manager.emit_line_to_category(
        BlackwellOutputConsoleCategory::Foundry,
        "Phase: Configuring (CMake)...".to_string(),
        BlackwellOutputConsoleLineStyle::Highlight,
    );

    let state = BuildState {
        build_id,
        provider_id: provider_id.clone(),
        environment: env,
        phase: BuildPhase::Configuring,
    };

    *CURRENT_BUILD.lock().await = Some(state.clone());

    emit_build_event(app_handle, &state, None);

    // Immediate feedback to the UI so the user sees the modal is alive (fixes the long "nothing happening" delay
    // after clicking the final Start/Proceed button). Heavy work (stop engines + git) follows.
    // The actual engine stop (if needed) happens below and will emit its own progress.
    // We emit a generic early message so the UI feels responsive immediately.

    // Stop engines for this provider — but only if any are actually running.
    // This avoids unnecessary 5+ second delays when the user has no engines active for this provider.
    let backend_type: String = {
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        cfg.providers.iter()
            .find(|p| p.id == provider_id)
            .map(|p| p.id.clone())
            .unwrap_or_default()
    };

    let running_for_provider: Vec<_> = {
        let stack = app.stack.lock().await;
        stack.get_status()
            .into_iter()
            .filter(|e| e.provider_type == backend_type && e.status != "IDLE")
            .collect()
    };

    let _stopped_count = if running_for_provider.is_empty() {
        // Fast path — nothing to stop
        emit_build_event(app_handle, &{
            let c = CURRENT_BUILD.lock().await;
            c.as_ref().cloned().unwrap()
        }, Some("No running engines for this provider — proceeding directly to build.".into()));
        0
    } else {
        let stopped: Vec<usize> = EngineStack::stop_slots_by_provider_parallel(&backend_type, &app.stack).await;
        if !stopped.is_empty() {
            let current = CURRENT_BUILD.lock().await;
            if let Some(ref s) = *current {
                emit_build_event(app_handle, s,
                    Some(format!("Stopping {} running engine(s) for '{}' before build...", stopped.len(), provider_id)));
            }
        }
        stopped.len()
    };

    // === NEW DIRECTORY MODEL (see FOUNDRY_DIRECTORY_STRUCTURE_MAP.md §5) ===
    // engine_root = foundry/engines/<provider_id>
    //   src_dir   = engine_root/llama.cpp          (kept for git reuse — never touched by cleanup)
    //   work_root = engine_root/work               (DISPOSABLE — nuked on every exit)
    //     build_dir = work_root/build-{env}        (ephemeral CMake tree for this attempt)
    //   artifacts live at foundry/artifacts/<provider>/<env>/Release (SACRED)
    let engine_root = crate::config::foundry_dir(&provider_id);
    let src_dir     = engine_root.join("llama.cpp");
    let work_root   = crate::config::foundry_work_dir(&provider_id);
    let build_dir   = work_root.join(format!("build-{}", env.env_label()));
    let bin_release = build_dir.join("bin").join("Release");
    // Dummy value kept only for compilation of a few remaining rollback call sites.
    // Can be removed once those sites are updated.
    // In the fully simplified world these calls will take far fewer arguments.
    let bin_bak: std::path::PathBuf = std::path::PathBuf::new();
    // NOTE: bin_bak / rename dance removed entirely from normal build flow. Sacred artifacts are never touched during a build attempt.

    // Defensive nuke of any leftover work/ from a previous crashed build (safe — disposable by policy)
    let _ = tokio::fs::remove_dir_all(&work_root).await;
    if let Err(e) = tokio::fs::create_dir_all(&work_root).await {
        // Minimal rollback (will be simplified later)
        rollback_build(app_handle, &provider_id, env, build_id, &src_dir, &bin_release, &PathBuf::new()).execute().await;
        return Err(format!("Failed to create work directory: {}", e));
    }
    let _ = tokio::fs::create_dir_all(&build_dir).await;

    // ── Git Operations ───────────────────────────────────────────────

    let (git_url, branch) = {
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        let p = cfg.providers.iter()
            .find(|p| p.id == provider_id);
        (
            p.map(|p| p.git_url.clone()).unwrap_or_default(),
            p.map(|p| p.branch.clone()).unwrap_or_else(|| "main".to_string()),
        )
    };

    if git_url.is_empty() {
            rollback_build(app_handle, &provider_id, env, build_id, &src_dir, &bin_release, &bin_bak).execute().await;
            return Err(format!("Provider '{}' has no git_url configured.", provider_id));
    }

    let is_existing = src_dir.join(".git").exists();

    if !is_existing {
        if src_dir.exists() {
            let _ = tokio::fs::remove_dir_all(&src_dir).await;
        }

        let clone_output = tokio::process::Command::new("git")
            .args(["clone", "--depth", "1", "--recursive"])
            .arg(&*git_url)
            .arg("-b")
            .arg(branch)
            .arg(&src_dir)
            .current_dir(engine_root.parent().unwrap())
            .creation_flags(0x08000000)
            .output()
            .await
            .map_err(|e| format!("Git clone failed: {}", e))?;

        if !clone_output.status.success() {
            let stderr = String::from_utf8_lossy(&clone_output.stderr).to_string();
            rollback_build(app_handle, &provider_id, env, build_id, &src_dir, &bin_release, &bin_bak).execute().await;
            return Err(format!("Git clone failed: {}", stderr));
        }

        emit_config_event(app_handle, &provider_id, env, build_id, Some("Repository cloned.".into()));
    } else {
        let pull_output = tokio::process::Command::new("git")
            .args(["pull", "--recurse-submodules"])
            .current_dir(&src_dir)
            .creation_flags(0x08000000)
            .output()
            .await
            .map_err(|e| format!("Git pull failed: {}", e))?;

        if pull_output.status.success() {
            let _ = tokio::process::Command::new("git")
                .args(["submodule", "update", "--init", "--recursive"])
                .current_dir(&src_dir)
                .creation_flags(0x08000000)
                .output()
                .await;
        }

        if !pull_output.status.success() {
            let stderr = String::from_utf8_lossy(&pull_output.stderr).to_string();
            rollback_build(app_handle, &provider_id, env, build_id, &src_dir, &bin_release, &bin_bak).execute().await;
            return Err(format!("Git pull failed: {}", stderr));
        }

        emit_config_event(app_handle, &provider_id, env, build_id, Some("Repository updated.".into()));
    }

    // ── PR Patch Apply (optional) — URL or number format ─────────────
    if let Some(ref pr_input_str) = pr_url {
        match parse_pr_input(pr_input_str) {
            Some((owner_repo_opt, pr_num)) => {
                // Try to resolve owner/repo if only a number was given (user request)
                let resolved_owner_repo = owner_repo_opt.clone().or_else(|| {
                    // Load the provider's git_url and try to guess
                    if let Ok(cfg) = app.config.lock() {
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

                emit_config_event(app_handle, &provider_id, env, build_id, Some(log_msg));

                // Only attempt actual patch download if we have a resolved owner/repo
                if let Some(ref owner_repo) = resolved_owner_repo {
                    let patch_url = format!("https://patch-diff.githubusercontent.com/raw/{}/pull/{}.diff", owner_repo, pr_num);
                    let patch_bytes = reqwest::get(&patch_url)
                        .await
                        .map_err(|e| format!("HTTP fetch failed: {}", e))?;

                    if !patch_bytes.status().is_success() {
                        emit_config_event(app_handle, &provider_id, env, build_id,
                            Some(format!("[WARN] PR #{} not found or inaccessible (HTTP {}) — continuing build", pr_num, patch_bytes.status())));
                    } else {
                        let patch = String::from_utf8_lossy(&patch_bytes.bytes().await.unwrap_or_default()).to_string();

                        if patch.trim().is_empty() {
                            emit_config_event(app_handle, &provider_id, env, build_id,
                                Some(format!("[PR] #{} already applied — no changes needed", pr_num)));
                        } else {
                            let patch_path = src_dir.parent().unwrap().join("pr-patch.diff");
                            if let Ok(()) = tokio::fs::write(&patch_path, &patch).await {
                                let mut apply_output = tokio::process::Command::new("git")
                                    .args(["apply", "--whitespace=nowarn", patch_path.to_str().unwrap()])
                                    .current_dir(&src_dir)
                                    .creation_flags(0x08000000)
                                    .output()
                                    .await;

                                if apply_output.as_ref().map_or(true, |o| !o.status.success()) {
                                    apply_output = tokio::process::Command::new("git")
                                        .args(["apply", "--3way", "--whitespace=nowarn", patch_path.to_str().unwrap()])
                                        .current_dir(&src_dir)
                                        .creation_flags(0x08000000)
                                        .output()
                                        .await;
                                }

                                let _ = tokio::fs::remove_file(&patch_path).await;

                                match apply_output {
                                    Ok(ref out) if out.status.success() => {
                                        emit_config_event(app_handle, &provider_id, env, build_id,
                                            Some(format!("[PR] #{} applied successfully", pr_num)));

                                        let env_key = env.env_label().to_string();
                                        if let Ok(mut cfg) = app.config.lock() {
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
                                        let _ = tokio::process::Command::new("git")
                                            .args(["merge", "--abort"])
                                            .current_dir(&src_dir)
                                            .output()
                                            .await;
                                        emit_config_event(app_handle, &provider_id, env, build_id,
                                            Some(format!("[WARN] PR #{} apply failed: {} — continuing build", pr_num, stderr)));
                                    }
                                }
                            } else {
                                emit_config_event(app_handle, &provider_id, env, build_id,
                                    Some(format!("[WARN] PR #{} could not write patch file — continuing build", pr_num)));
                            }
                        }
                    }
                }
            }
            None => {
                emit_config_event(app_handle, &provider_id, env, build_id,
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
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        cfg.providers.iter()
            .find(|p| p.id == provider_id)
            .map(|p| p.display_name.clone())
            .unwrap_or_else(|| provider_id.clone())
    };

    // ── CMake Build Chain ────────────────────────────────────────────

    let template_type = resolve_template_type(&provider_id);

    let (vs_devcmd, cuda_path, cmake_extra) = {
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        let p = cfg.providers.iter()
            .find(|p| p.id == provider_id);
        let build_profile = p.map(|p| p.build_profile.clone()).unwrap_or_default();

        // IMPORTANT: User-provided cmake_flags (from the build modal) completely REPLACE both
        // the provider's build_profile AND the built-in defaults. This is by design for power users.
        // See FoundryConfirmForm.tsx for the UI warning.
        let extra = if let Some(ref flags) = cmake_flags {
            flags.trim().to_string()
        } else if !build_profile.trim().is_empty() {
            build_profile.trim().to_string()
        } else {
            get_default_cmake_flags(template_type).to_string()
        };

        (env.vs_devcmd(), env.cuda_path(), extra)
    };

    let available: usize = std::thread::available_parallelism()
        .map(|p| p.get())
        .unwrap_or(8);
    let max_cores_usize: Option<usize> = max_cores.map(|n| n as usize);
    let num_cpus = max_cores_usize.unwrap_or(available).min(available).max(2);

    emit_config_event(app_handle, &provider_id, env, build_id, Some(format!(
        "[STAGE 1/3] CMAKE CONFIGURE — {} cores detected", num_cpus
    )));

    emit_config_event(app_handle, &provider_id, env, build_id, Some("[STAGE 1/3] CMAKE CONFIGURE — Reviewing flags below. Click PROCEED to start compilation.".into()));

    let cuda_ver_short = env.cuda_version_short();
    let toolset_flag = format!("-T \"cuda={}\"", cuda_ver_short);

    let forced_cuda_flags = format!(
        "-DCMAKE_CUDA_COMPILER=\"{}\" -DCUDAToolkit_ROOT=\"{}\" \
         -DCMAKE_VS_PLATFORM_TOOLSET_CUDA=\"{}\"",
        env.nvcc_path().replace('\\', "/"),
        cuda_path.replace('\\', "/"),
        cuda_ver_short
    );

    let joined_extra = if cmake_extra.is_empty() {
        String::new()
    } else {
        cmake_extra.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ")
    };

    let gen_flag = env.cmake_generator();
    let cuda_path_forced = env.cuda_path();
    let nvcc_bin = format!("{}\\bin", cuda_path_forced);
    let versioned_var = env.cuda_versioned_var_name();

    // Absolute out-of-source configure (build tree lives in disposable work/ — never inside source)
    let build_dir_str = build_dir.to_string_lossy().replace('\\', "/");
    let src_dir_str   = src_dir.to_string_lossy().replace('\\', "/");
    let cmake_configure_line = if joined_extra.is_empty() {
        format!(r#"cmake -B "{}" -S "{}" {} {} {}"#, build_dir_str, src_dir_str, gen_flag, toolset_flag, forced_cuda_flags)
    } else {
        format!(r#"cmake -B "{}" -S "{}" {} {} {} {}"#, build_dir_str, src_dir_str, gen_flag, toolset_flag, forced_cuda_flags, joined_extra)
    };

    emit_config_event(app_handle, &provider_id, env, build_id, Some(format!(
        "cmake -B work/build-{} -S llama.cpp {} {} {}{}", env.env_label(), gen_flag, toolset_flag, forced_cuda_flags, if !joined_extra.is_empty() { format!(" {}", joined_extra) } else { String::new() }
    )));

    let cfg_batch_lines = build_isolated_batch_script(
        vs_devcmd,
        cuda_path_forced,
        &nvcc_bin,
        &versioned_var,
        cmake_configure_line,
    );
    let cfg_batch_content = cfg_batch_lines.join("\n");
    let cfg_batch_path = work_root.join("_build_cfg.bat");
    if let Err(e) = tokio::fs::write(&cfg_batch_path, &cfg_batch_content).await {
        return Err(format!("Failed to write build script: {}", e));
    }

    let scrubbed_path = env.scrub_path();
    let mut cmd = tokio::process::Command::new("cmd");
    cmd.args(&["/c", cfg_batch_path.to_string_lossy().as_ref()])
        .current_dir(&src_dir)
        .env("PATH", &scrubbed_path)
        .creation_flags(0x08000000)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Failed to start cmake: {}", e))?;

    if let Some(pid) = child.id() {
        track_pid(pid);
    }

    use std::sync::{Arc, Mutex};
    let stderr_capture: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_capture_clone = stderr_capture.clone();

    let app_handle_cfg = app_handle.clone();
    let state_cfg = {
        let c = CURRENT_BUILD.lock().await;
        c.as_ref().cloned().unwrap()
    };

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
            let batch = log_buffer_flush.lock().unwrap().drain(..).collect::<Vec<String>>();
            if !batch.is_empty() {
                emit_build_batch(&app_handle_flush, &state_flush, batch);
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
                log_buffer.lock().unwrap().push(line);
            }
        }

        let stderr_reader = BufReader::new(stderr);
        let mut stderr_lines = stderr_reader.lines();
        while let Ok(Some(line)) = stderr_lines.next_line().await {
            if !line.trim().is_empty() {
                log_buffer.lock().unwrap().push(format!("[ERR] {}", line));
                stderr_capture_clone2.lock().unwrap().push(line);
            }
        }
        let batch = log_buffer.lock().unwrap().drain(..).collect::<Vec<String>>();
        if !batch.is_empty() {
            emit_build_batch(&app_handle_cfg, &state_cfg, batch);
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
            return Err("Build cancelled by user.".to_string());
        }
    };

    flush_done.store(true, Ordering::SeqCst);
    stream_handle.await.ok();

    if cfg_status.is_none() {
        clear_pids();
        let _ = tokio::fs::remove_file(&cfg_batch_path).await;
        return Err("CMake configure process terminated unexpectedly.".to_string());
    }

    let cfg_status = cfg_status.unwrap();

    let _ = tokio::fs::remove_file(&cfg_batch_path).await;

    if !cfg_status.success() {
        let stderr_text: String = stderr_capture.lock().unwrap().join("\n");
        rollback_build(app_handle, &provider_id, env, build_id, &src_dir, &bin_release, &bin_bak)
            .with_message(if stderr_text.is_empty() { "CMake configure failed.".into() } else { format!("CMake configure failed:\n{}", stderr_text) })
            .execute().await;

        clear_pids();

        // Ensure work dir is cleaned even on early configure failure (prevents stuck "building" + orphaned work dir)
        let work_root = crate::config::foundry_work_dir(&provider_id);
        let _ = tokio::fs::remove_dir_all(&work_root).await;
        app.blackwell_output_console_manager.end_foundry_build_session(build_id);

        *CURRENT_BUILD.lock().await = None;
        return Err("CMake configure failed. Check the log above for details.".to_string());
    }

    // ── Check cancellation before showing PROCEED prompt ─────────────
    if is_cancelled() {
        clear_pids();
        return Err("Build cancelled by user.".to_string());
    }

    // ── Wait for user confirmation via state machine ─────────────────

    {
        let mut current = CURRENT_BUILD.lock().await;
        if let Some(ref mut s) = *current {
            s.phase = BuildPhase::WaitingForConfirm;
        }
    }
    emit_build_event(app_handle, &{
        let c = CURRENT_BUILD.lock().await;
        c.as_ref().cloned().unwrap()
    }, Some(format!(
        "[WAIT-CONFIRM] CMake configure complete. {} targets detected.\nReview the log above — click PROCEED to start compilation (may take 10+ minutes).",
        if cmake_extra.is_empty() { "Default" } else { "Custom" }
    )));

    let timeout_dur = std::time::Duration::from_secs(600);
    let start = std::time::Instant::now();
    loop {
        if is_cancelled() || CURRENT_BUILD.lock().await.is_none() {
            clear_pids();

            // Explicit cleanup on cancel from WaitingForConfirm
            let work_root = crate::config::foundry_work_dir(&provider_id);
            let _ = tokio::fs::remove_dir_all(&work_root).await;
            app.blackwell_output_console_manager.end_foundry_build_session(build_id);

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
            emit_build_event(app_handle, &{
                let c = CURRENT_BUILD.lock().await;
                c.as_ref().cloned().unwrap()
            }, None);
            *CURRENT_BUILD.lock().await = None;
            return Err("Build cancelled: user did not confirm.".to_string());
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
    }

    log::info!("User approved build, starting compilation...");

    app.blackwell_output_console_manager.emit_line_to_category(
        BlackwellOutputConsoleCategory::Foundry,
        "Phase: Compilation started...".to_string(),
        BlackwellOutputConsoleLineStyle::Highlight,
    );

    // ── PHASE 2: CMake Build (after user approval) ───────────────────

    emit_build_event(app_handle, &{
        let c = CURRENT_BUILD.lock().await;
        c.as_ref().cloned().unwrap()
    }, Some(format!(
        "[BUILD] Starting compilation with {} cores...", num_cpus
    )));

    let cuda_path_forced = env.cuda_path();
    let nvcc_bin = format!("{}\\bin", cuda_path_forced);
    let versioned_var = env.cuda_versioned_var_name();

    // Absolute --build (no cd, no reliance on relative layout)
    let build_dir_str = build_dir.to_string_lossy().replace('\\', "/");
    let build_batch_lines = build_isolated_batch_script(
        vs_devcmd,
        cuda_path_forced,
        &nvcc_bin,
        &versioned_var,
        format!(r#"cmake --build "{}" --config Release -j {}"#, build_dir_str, num_cpus),
    );
    let build_batch_content = build_batch_lines.join("\n");
    let build_batch_path = work_root.join("_build_run.bat");
    if let Err(e) = tokio::fs::write(&build_batch_path, &build_batch_content).await {
        return Err(format!("Failed to write build script: {}", e));
    }

    let mut cmd2 = tokio::process::Command::new("cmd");
    cmd2.args(&["/c", build_batch_path.to_string_lossy().as_ref()])
        .current_dir(&src_dir)
        .env("PATH", &scrubbed_path)
        .creation_flags(0x08000000)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let child2 = cmd2.spawn().map_err(|e| format!("Failed to start build: {}", e))?;

    if let Some(pid) = child2.id() {
        track_pid(pid);
    }

    let state_for_stream = {
        let c = CURRENT_BUILD.lock().await;
        c.as_ref().cloned().unwrap()
    };

    let (build_status, stderr_text) = stream_child_output(
        child2,
        app_handle,
        &state_for_stream,
    ).await;

    if build_status.is_none() {
        clear_pids();
        let _ = tokio::fs::remove_file(&build_batch_path).await;
        do_rollback(&bin_release, &bin_bak).await; // will become no-op after rollback simplification
        // work/ (incl. build_dir) nuked on exit
        return Err("Build cancelled by user.".to_string());
    }

    let _ = tokio::fs::remove_file(&build_batch_path).await;

    if !build_status.unwrap().success() {
        let stderr_text: String = stderr_text.join("\n");
        rollback_build(app_handle, &provider_id, env, build_id, &src_dir, &bin_release, &bin_bak)
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
    emit_build_event(app_handle, &{
        let c = CURRENT_BUILD.lock().await;
        c.as_ref().cloned().unwrap()
    }, Some("[STAGE 3/3] VALIDATE — Checking core binaries...".into()));

    let core_binaries = ["llama-server.exe", "llama-cli.exe", "llama-quantize.exe"];

    let candidate_dirs: Vec<PathBuf> = vec![
        bin_release.clone(),
        build_dir.join("bin").join("Release"),
        src_dir.join("bin").join("Release"),
        src_dir.join("build").join("Release"),
    ];

    let mut all_present = true;
    let mut missing: Vec<String> = vec![];
    let mut found_bin_dir: Option<PathBuf> = None;

    for bin in &core_binaries {
        let mut found = false;
        for dir in &candidate_dirs {
            if dir.join(bin).exists() {
                found = true;
                if found_bin_dir.is_none() {
                    found_bin_dir = Some(dir.clone());
                }
                break;
            }
        }
        if !found {
            all_present = false;
            missing.push(bin.to_string());
        }
    }

    if let Some(found_dir) = &found_bin_dir {
        if *found_dir != bin_release {
            log::info!("Binaries found at {:?}, updating provider path", found_dir);
            let cfg = app.config.lock().map_err(|e| e.to_string())?;
            let mut cfg_mut = cfg.clone();
            for p in &mut cfg_mut.providers {
                if p.id == provider_id {
                    let abs = found_dir.join("llama-server.exe");
                    p.binary_path = crate::config::to_relative_path(&abs);
                }
            }
            drop(cfg);
            if let Err(e) = persist_providers_atomic(&*app) {
                log::error!("[foundry] Failed to persist provider config after path correction: {}", e);
            }
        }
    }

    if !all_present {
        rollback_build(app_handle, &provider_id, env, build_id, &src_dir, &bin_release, &bin_bak)
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
    emit_build_event(app_handle, &{
        let c = CURRENT_BUILD.lock().await;
        c.as_ref().cloned().unwrap()
    }, Some("Build successful. Capturing version info...".into()));

    // Publish sacred artifacts (copy from disposable work tree into artifacts/<id>/<env>/Release)
    // This is the ONLY place the sacred tree is written during a normal build.
    let published_bin_path = match publish_artifacts_to_sacred(&provider_id, env, &build_dir, &src_dir).await {
        Ok(p) => p,
        Err(e) => {
            // Still nuke work/ on the way out (via later finalize), but report the publish failure
            return Err(format!("Build succeeded but failed to publish sacred artifacts: {}", e));
        }
    };

    let bin_path = found_bin_dir
        .as_ref()
        .map(|d| d.join("llama-server.exe").to_string_lossy().to_string())
        .unwrap_or_else(|| published_bin_path.clone());

    match crate::engine::get_binary_build_info(bin_path.clone()).await {
        Ok(build_info_raw) => {
            let env_label = env.env_label();
            log::info!("[foundry] Captured build info for provider '{}' env '{}': {} built {}",
                provider_id, env_label, build_info_raw.version, build_info_raw.build_date);

            let mut cfg = app.config.lock().map_err(|e| e.to_string())?;
            if let Some(provider) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
                let build_info = crate::types::BuildInfo {
                    version: build_info_raw.version,
                    build_date: build_info_raw.build_date,
                    cuda_version: build_info_raw.cuda_version.clone(),
                };
                provider.build_info_per_env.insert(env_label.to_string(), build_info.clone());
                provider.build_info_per_env.insert("current".to_string(), build_info);
                let rel_path = crate::config::to_relative_path(&std::path::PathBuf::from(&bin_path));
                provider.binary_path_per_env.insert(env_label.to_string(), rel_path);
                provider.downloaded_version_per_env.remove(env_label);

                // Main binary_path now points at the sacred artifacts location
                provider.binary_path = crate::config::to_relative_path(&std::path::PathBuf::from(&published_bin_path));
            }
            drop(cfg);
            if let Err(e) = persist_providers_atomic(&*app) {
                log::error!("[foundry] Failed to persist provider config: {}", e);
            }
        }
        Err(e) => {
            log::warn!("[foundry] Failed to capture build info for provider '{}': {}", provider_id, e);
        }
    }

    emit_build_event(app_handle, &{
        let c = CURRENT_BUILD.lock().await;
        c.as_ref().cloned().unwrap()
    }, Some("Foundry build complete.".into()));

    // Feed final success message into the Blackwell Output Console
    app.blackwell_output_console_manager.emit_line_to_category(
        BlackwellOutputConsoleCategory::Foundry,
        "=== Foundry build completed successfully ===".to_string(),
        BlackwellOutputConsoleLineStyle::Success,
    );

    // End the session and clear its buffer (per design: clear on successful close)
    app.blackwell_output_console_manager
        .end_foundry_build_session(build_id);

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
    let remaining = {
        let mut guard = CHILD_PIDS.lock().unwrap();
        std::mem::take(&mut *guard)
    };
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
            "environment": state.environment.env_label(),
            "log_line": Some("Build cancelled by user."),
        });
        app_handle.emit("foundry-progress", &event).ok();
    }

    Ok(())
}

#[tauri::command]
pub async fn foundry_status() -> Result<Option<BuildProgress>, String> {
    let current = CURRENT_BUILD.lock().await;
    Ok(current.as_ref().map(|state| BuildProgress {
        phase: state.phase.step_name().to_string(),
        provider_id: state.provider_id.clone(),
        environment: state.environment.env_label().to_string(),
        log_line: None,
    }))
}

#[tauri::command]
pub async fn foundry_confirm_build() -> Result<(), String> {
    let mut current = CURRENT_BUILD.lock().await;
    if let Some(ref mut state) = *current {
        if matches!(state.phase, BuildPhase::WaitingForConfirm) {
            state.phase = BuildPhase::Building;
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

    let prov = {
        if prov.binary_path_per_env.is_empty() && !prov.binary_path.is_empty() {
            let src_dir = foundry_src_dir(&provider_id);
            let old_build_dir = src_dir.join("build");
            if old_build_dir.exists() {
                let new_build_dir = src_dir.join("build-vanguard");
                if !new_build_dir.exists() && old_build_dir.join("bin").exists() {
                    log::info!("[migration] One-time historical migration of ancient 'build/' directory for '{}'", provider_id);
                    let _ = tokio::fs::create_dir_all(&new_build_dir).await;
                    if tokio::fs::rename(&old_build_dir, &new_build_dir).await.is_ok() {
                        let new_bin = new_build_dir.join("bin").join("Release");
                        if new_bin.exists() {
                            let mut cfg = app.config.lock().map_err(|e| e.to_string())?;
                            if let Some(p) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
                                if p.binary_path_per_env.is_empty() {
                                    p.binary_path_per_env = std::collections::HashMap::new();
                                }
                                let abs_exe = new_bin.join("llama-server.exe");
                                let rel = crate::config::to_relative_path(&abs_exe);
                                p.binary_path_per_env.insert("vanguard".to_string(), rel.clone());
                                p.binary_path = rel;
                            }
                            drop(cfg);
                            if let Err(e) = persist_providers_atomic(&*app) {
                                log::error!("[foundry] Failed to persist provider config: {}", e);
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

    let mut updated_info: Vec<(String, crate::types::BuildInfo)> = Vec::new();

    for env_label in &["vanguard", "stable", "fresh"] {
        if let Some(path_str) = prov.binary_path_per_env.get(*env_label) {
            match crate::engine::get_binary_build_info(path_str.clone()).await {
                Ok(info) => {
                    log::info!("[refresh] {} env '{}': {} built {}", provider_id, env_label, info.version, info.build_date);
                    updated_info.push((env_label.to_string(), info));
                }
                Err(_) => { /* binary missing or failed — skip */ }
            }
        }
    }

    if !updated_info.is_empty() {
        let mut cfg = app.config.lock().map_err(|e| e.to_string())?;
        let mut changed = false;
        if let Some(p) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
            for (env_label, info) in &updated_info {
                let existing = p.build_info_per_env.get(env_label);
                if existing.map(|e| e.version != info.version || e.build_date != info.build_date).unwrap_or(true) {
                    p.build_info_per_env.insert(env_label.clone(), info.clone());
                    changed = true;
                }
            }
            if let Some(latest) = updated_info.iter().max_by_key(|(_, info)| info.build_date.as_str()) {
                let current_existing = p.build_info_per_env.get("current");
                if current_existing.map(|e| e.version != latest.1.version || e.build_date != latest.1.build_date).unwrap_or(true) {
                    p.build_info_per_env.insert("current".to_string(), latest.1.clone());
                    changed = true;
                }
            }
        }
        drop(cfg);
        if changed {
            if let Err(e) = persist_providers_atomic(&*app) {
                log::error!("[foundry] Failed to persist provider config: {}", e);
            }
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
    let env_label = match environment.to_lowercase().as_str() {
        "vanguard" => "vanguard",
        "stable" => "stable",
        "fresh" => "fresh",
        _ => return Err(format!("Unknown environment: {}", environment)),
    };

    {
        let stopped = EngineStack::stop_slots_by_provider_parallel(&provider_id, &app.stack).await;
        if !stopped.is_empty() {
            log::info!("[restore] Stopped {} engine(s) before restore", stopped.len());
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
    }

    // --- New artifacts-based previous backup (preferred) ---
    let artifacts_prev = crate::config::foundry_artifact_release_dir(&provider_id, env_label)
        .parent()
        .unwrap()
        .join("Release.prev");

    if artifacts_prev.exists() {
        let sacred_release = crate::config::foundry_artifact_release_dir(&provider_id, env_label);

        // Stop engines first (already done above)
        if sacred_release.exists() {
            let _ = tokio::fs::remove_dir_all(&sacred_release).await;
        }
        // Move .prev -> current Release
        tokio::fs::rename(&artifacts_prev, &sacred_release)
            .await
            .map_err(|e| format!("Failed to restore previous artifact: {}", e))?;

        // Update provider paths to point at the restored sacred location
        let restored_exe = sacred_release.join("llama-server.exe");
        if restored_exe.exists() {
            if let Ok(info) = crate::engine::get_binary_build_info(restored_exe.to_string_lossy().to_string()).await {
                let mut cfg = app.config.lock().map_err(|e| e.to_string())?;
                if let Some(p) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
                    let rel = crate::config::to_relative_path(&restored_exe);
                    p.binary_path_per_env.insert(env_label.to_string(), rel.clone());
                    p.binary_path = rel;
                    p.build_info_per_env.insert(env_label.to_string(), info.clone());
                    p.build_info_per_env.insert("current".to_string(), info);
                }
                drop(cfg);
                let _ = persist_providers_atomic(&*app);
            }
        }

        log::info!("[restore] Restored previous artifact for {} {}", provider_id, env_label);
        return Ok(());
    }

    // --- Very old legacy fallback (pre-artifacts era) ---
    // Most users will never hit this path anymore.
    let work_dir = crate::config::foundry_dir(&provider_id);
    let src_dir = foundry_src_dir(&provider_id);
    let build_dir = src_dir.join(format!("build-{}", env_label));
    let bin_release = build_dir.join("bin").join("Release");
    let bin_bak = work_dir.join(format!("bin-{}-bak", env_label));

    if !bin_bak.exists() {
        return Err(format!(
            "No previous build found for '{}' ({}).\n\
             The current system keeps one previous artifact automatically as Release.prev.\n\
             Rebuild the profile to create a new backup.",
            provider_id, env_label
        ));
    }

    if bin_release.exists() {
        tokio::fs::remove_dir_all(&bin_release).await
            .map_err(|e| format!("Failed to remove current binaries: {}", e))?;
    }
    tokio::fs::rename(&bin_bak, &bin_release)
        .await
        .map_err(|e| format!("Failed to restore ancient legacy backup: {}", e))?;

    let bin_path = bin_release.join("llama-server.exe");
    if bin_path.exists() {
        if let Ok(info) = crate::engine::get_binary_build_info(bin_path.to_string_lossy().to_string()).await {
            let mut cfg = app.config.lock().map_err(|e| e.to_string())?;
            if let Some(provider) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
                if provider.build_info_per_env.is_empty() {
                    provider.build_info_per_env = std::collections::HashMap::new();
                }
                provider.build_info_per_env.insert(env_label.to_string(), info);
            }
            drop(cfg);
            if let Err(e) = persist_providers_atomic(&*app) {
                log::error!("[foundry] Failed to persist provider config: {}", e);
            }
        }
    }

    log::info!("[restore] Restored '{}' from {} backup", provider_id, env_label);
    Ok(())
}

// ── Helpers ──────────────────────────────────────────────────────────

fn persist_providers_atomic(app: &crate::engine::AppContext) -> Result<(), String> {
    let providers = {
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        cfg.providers.clone()
    };
    crate::config::persist_user_providers_meta(&providers)
}

/// Emit a progress event for intermediate steps within the current phase.
fn emit_config_event(
    app_handle: &tauri::AppHandle,
    provider_id: &str,
    env: BuildEnv,
    build_id: u64,
    log_line: Option<String>,
) {
    let event = serde_json::json!({
        "build_id": build_id,
        "phase": "Configuring",
        "provider_id": provider_id,
        "environment": env.env_label(),
        "log_line": log_line,
    });

    if let Err(e) = app_handle.emit("foundry-progress", &event) {
        log::debug!("Failed to emit foundry-progress: {}", e);
    }
}

/// Rollback builder — allows attaching a custom failure message.
struct RollbackBuilder<'a> {
    app_handle: &'a tauri::AppHandle,
    provider_id: &'a str,
    env: BuildEnv,
    build_id: u64,
    src_dir: &'a PathBuf,
    bin_release: &'a PathBuf,
    bin_bak: &'a PathBuf,
    message: Option<String>,
}

impl<'a> RollbackBuilder<'a> {
    fn with_message(mut self, msg: String) -> Self {
        self.message = Some(msg);
        self
    }

    async fn execute(self) {
        let Self { app_handle, provider_id, env, build_id, src_dir: _, bin_release: _, bin_bak: _, message } = self;

        // Directory rollback dance removed — sacred artifacts are never touched on failure paths.
        // The disposable work/ tree is nuked by the exit discipline in every terminal path.
        let msg = message.unwrap_or_else(|| "Build setup failed.".to_string());
        let event = serde_json::json!({
            "build_id": build_id,
            "phase": "Failed",
            "provider_id": provider_id,
            "environment": env.env_label(),
            "log_line": Some(msg),
        });

        if let Err(e) = app_handle.emit("foundry-progress", &event) {
            log::debug!("Failed to emit foundry-progress: {}", e);
        }
        *CURRENT_BUILD.lock().await = None;
    }
}

fn rollback_build<'a>(
    app_handle: &'a tauri::AppHandle,
    provider_id: &'a str,
    env: BuildEnv,
    build_id: u64,
    src_dir: &'a PathBuf,
    bin_release: &'a PathBuf,
    bin_bak: &'a PathBuf,
) -> RollbackBuilder<'a> {
    RollbackBuilder {
        app_handle,
        provider_id,
        env,
        build_id,
        src_dir,
        bin_release,
        bin_bak,
        message: None,
    }
}

/// Perform rollback without emitting an event — use when caller needs custom error message.
/// In the new directory model this is a no-op (no bin_bak dance; work/ is nuked on exit).
async fn do_rollback(_bin_release: &PathBuf, _bin_bak: &PathBuf) {
    // Sacred artifacts untouched on failure. Disposable work tree cleaned by caller exit paths.
}

// ── Sacred Artifacts Publish (new directory model) ──────────────────

/// Copy the contents of the just-built Release dir (inside the disposable work tree)
/// into the sacred artifacts/<provider>/<env>/Release location.
/// Returns the absolute path to the published llama-server.exe on success.
async fn publish_artifacts_to_sacred(
    provider_id: &str,
    env: BuildEnv,
    build_dir: &PathBuf,   // the temp work/build-xxx
    _src_dir: &PathBuf,    // unused in new model but kept for signature compat during transition
) -> Result<String, String> {
    let temp_release = build_dir.join("bin").join("Release");
    if !temp_release.exists() {
        return Err("Build produced no Release directory under bin/".into());
    }

    let sacred = crate::config::foundry_artifact_release_dir(provider_id, env.env_label());
    if let Err(e) = tokio::fs::create_dir_all(&sacred).await {
        return Err(format!("Failed to create sacred artifacts dir: {}", e));
    }

    // Keep one previous artifact for the "Restore Previous Build" button (user request).
    // Before overwriting, move the current Release to Release.prev (deleting old .prev if present).
    let prev_dir = sacred.parent().unwrap().join("Release.prev");
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

    log::info!("[foundry] Published sacred artifacts for {} {} -> {}", provider_id, env.env_label(), sacred.display());
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
