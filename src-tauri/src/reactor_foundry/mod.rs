//! Reactor Foundry — isolated build service for compiling llama.cpp providers.
//!
//! Directory policy (see FOUNDRY_DIRECTORY_STRUCTURE_MAP.md §1, §5, §6):
//!   engines/<provider_id>/llama.cpp/   — kept source tree (git clone/pull target, reused for incremental builds)
//!   engines/<provider_id>/work/         — CMake build trees kept between runs when fingerprint matches
//!   artifacts/<provider_id>/<env>/Release/ — **SACRED** — only written on successful validation; automatic cleanup never touches it
//!
//! Build flow: clone/pull into llama.cpp, configure+build into a temp tree under work/build-{env}/,
//! on success copy the Release artifacts into the sacred artifacts tree.
//! `work/build-{profile}/` is retained when the cmake fingerprint matches (incremental); cleared on
//! flag change, configure fail (cold path), or explicit CLEAR CACHE. Never use work/ as a runtime binary path.
//! No build-* directories are ever created inside llama.cpp anymore.


mod artifacts;
mod batch;
mod cmake;
mod git;

pub use batch::foundry_kill_all_children;
pub(crate) use artifacts::{copy_dir_contents, publish_artifacts_to_sacred};
pub(crate) use batch::{
    clear_pids, kill_all_children, run_foundry_batch_streaming, track_pid, with_child_pids,
};
pub(crate) use cmake::{
    check_foundry_core_binaries, cmd_escape_batch, dir_size_bytes, format_bytes_label,
    foundry_batch_script_paths, foundry_cache_fingerprint, foundry_cmake_build_target_args,
    foundry_cmake_build_targets, foundry_keep_work_cache, foundry_release_candidate_dirs,
    get_default_cmake_flags, is_windows_vs_tail_batch_flake, merge_mandatory_cmake_flags,
    nuke_foundry_build_dir_on_configure_fail, nuke_foundry_work_tree, nuke_foundry_work_tree_on_exit,
    prepare_foundry_build_dir, read_foundry_cache_key, resolve_template_type, write_foundry_cache_key,
    FOUNDRY_EXTRA_BINARIES,
};
pub use git::FoundrySourcePreview;
pub(crate) use git::{
    apply_foundry_github_pr, apply_foundry_vendor_patches, backup_foundry_src_dirty_diff,
    commits_match, ensure_git_available, extract_commit_from_build_version, extract_github_owner_repo,
    foundry_src_dir, git_hidden_output, git_hard_sync_branch, git_ls_remote_short, git_output_text,
    git_rev_parse_short, parse_github_pr, parse_pr_input, parse_pr_list, push_pr_history,
    short_commit_hash,
};

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
pub(crate) static BUILD_CANCELLED: AtomicBool = AtomicBool::new(false);

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
pub(crate) static CHILD_PIDS: std::sync::LazyLock<std::sync::Mutex<Vec<u32>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(Vec::new()));

// ── Foundry Directory Helpers ───────────────────────────────────────

// ── State Machine ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum BuildPhase {
    Idle,
    GitClone,
    GitPull,
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
            Self::GitClone => "GitClone",
            Self::GitPull => "GitPull",
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

async fn set_build_phase(phase: BuildPhase) {
    let mut current = CURRENT_BUILD.lock().await;
    if let Some(ref mut s) = *current {
        s.phase = phase;
    }
}

fn spawn_repo_heartbeat(
    app_handle: tauri::AppHandle,
    action_label: &'static str,
    watch_phase: BuildPhase,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut elapsed: u64 = 0;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(15)).await;
            elapsed += 15;
            let state = match snapshot_build_state().await {
                Some(s) if s.phase == watch_phase => s,
                _ => break,
            };
            emit_build_event(
                &app_handle,
                &state,
                Some(format!(
                    "[STAGE 1/4] REPOSITORY — Still {}… {}s elapsed (slow internet is normal — do not close the app)",
                    action_label, elapsed
                )),
            );
        }
    })
}

/// Heartbeat while the compile batch is alive (the longest phase, and the one with no other
/// liveness signal). Surfaces a wedged MSBuild/Ninja child that is alive but producing no output.
fn spawn_build_heartbeat(app_handle: tauri::AppHandle) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut elapsed: u64 = 0;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            elapsed += 30;
            let state = match snapshot_build_state().await {
                Some(s) if s.phase == BuildPhase::Building => s,
                _ => break,
            };
            let child_pid = with_child_pids(|pids: &mut Vec<u32>| pids.last().copied()).flatten();
            let alive = child_pid
                .map(crate::engine_utils::is_process_alive)
                .unwrap_or(false);
            let pid_note = match child_pid {
                Some(pid) if alive => format!("compile pid {pid} alive"),
                Some(pid) => format!("compile pid {pid} NOT alive — wedged / pipe"),
                None => "no pid tracked yet".into(),
            };
            emit_build_event(
                &app_handle,
                &state,
                Some(format!(
                    "[STAGE 3/4] BUILD — still compiling… {elapsed}s ({pid_note})"
                )),
            );
        }
    })
}

/// Heartbeat while configure batch is alive. PID comes from tracked foundry children
/// (std::process spawn). Dead-stuck = no [FOUNDRY-ENV] and no further lines — if that
/// returns with the new std::process path, the old hang was tokio+CREATE_NO_WINDOW.
fn spawn_configure_heartbeat(app_handle: tauri::AppHandle) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut elapsed: u64 = 0;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            elapsed += 10;
            let state = match snapshot_build_state().await {
                Some(s) if s.phase == BuildPhase::Configuring => s,
                _ => break,
            };
            let child_pid = with_child_pids(|pids: &mut Vec<u32>| pids.last().copied()).flatten();
            let alive = child_pid
                .map(crate::engine_utils::is_process_alive)
                .unwrap_or(false);
            let pid_note = match child_pid {
                Some(pid) if alive => format!("cmd pid {pid} still alive"),
                Some(pid) => format!("cmd pid {pid} NOT alive — dead child / pipe"),
                None => "no pid tracked yet".into(),
            };
            emit_build_event(
                &app_handle,
                &state,
                Some(format!(
                    "[STAGE 2/4] CMAKE CONFIGURE — still running… {elapsed}s ({pid_note})"
                )),
            );
        }
    })
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
    // Stage echos: UI often freezes on the last Rust-emitted cmake line until cmake itself prints.
    // These prove whether we are stuck in env setup vs inside cmake (not elevation).
    let mut lines = vec![
        "@echo off".to_string(),
        "echo [FOUNDRY-ENV] start".to_string(),
        "set \"CUDA_PATH=\"".to_string(),
    ];
    for var in all_cuda_vars {
        lines.push(format!("set \"{var}=\""));
    }
    lines.push(format!("echo [FOUNDRY-ENV] call vsdevcmd: {vs_devcmd}"));
    lines.push(format!("call \"{vs_devcmd}\" -arch=amd64 -host_arch=amd64"));
    lines.push("if errorlevel 1 (echo [FOUNDRY-ENV] vsdevcmd FAILED & exit /b 1)".to_string());
    lines.push("echo [FOUNDRY-ENV] vsdevcmd ok".to_string());
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
    lines.push("echo [FOUNDRY-ENV] launching cmake/build command…".to_string());
    // No rmdir/mkdir/cd of build dirs here — Rust controls the disposable work/ tree.
    lines.push(final_command);
    lines.push("set FOUNDRY_RC=%ERRORLEVEL%".to_string());
    lines.push("echo [FOUNDRY-ENV] command finished exit=%FOUNDRY_RC%".to_string());
    lines.push("exit /b %FOUNDRY_RC%".to_string());
    lines
}

// ── Streaming Log Infrastructure ─────────────────────────────────────
// (Foundry batch run lives in `run_foundry_batch_streaming` — std::process, not tokio::process.)

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
        nuke_foundry_work_tree_on_exit(provider_id).await;
    }
}

// ── Core Build Service ───────────────────────────────────────────────

#[tauri::command]
pub async fn foundry_build(
    provider_id: String,
    environment: String,
    pr_url: Option<String>,
    max_cores: Option<u32>,
    cmake_flags: Option<String>,
    generator: Option<String>,
    // Also build llama-cli + llama-quantize (offline tools). Omit/null → false
    // (server + fit-params + llama-bench only).
    include_extra_tools: Option<bool>,
    app: tauri::State<'_, crate::engine::AppContext>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // Fail fast on bad profile/manifest before reserving the build slot.
    let profile = foundry_toolchain::validate_profile_ready(&environment)?;
    let profile_id = profile.env_label().to_string();
    let _manifest = foundry_toolchain::load_manifest()?;
    let include_extra_tools = include_extra_tools.unwrap_or(false);

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
            generator,
            include_extra_tools,
            build_id,
        )
        .await
        {
            log::error!("[foundry] Background build task failed: {}", e);
        }
    });

    Ok(())
}

/// Shared context passed to each build stage — holds the handles/ids the stages
/// already close over so no stage needs 20 positional arguments.
struct BuildCtx<'a> {
    worker: &'a FoundryWorkerApp,
    app_handle: &'a tauri::AppHandle,
    provider_id: &'a str,
    environment: &'a str,
    profile_id: &'a str,
    build_id: u64,
    manifest: &'a foundry_toolchain::ToolchainManifest,
    profile: &'a foundry_toolchain::ResolvedProfile,
    all_cuda_vars: &'a [String],
    pr_url: Option<&'a str>,
    max_cores: Option<u32>,
    cmake_flags: Option<&'a str>,
    generator: Option<&'a str>,
    include_extra_tools: bool,
    /// Computed in the sequencer: cores available for -j.
    num_cpus: usize,
    /// Computed in the sequencer: the cmake command path (forward-slash).
    cmake_cmd: String,
    /// Computed in the sequencer: git exe parent dir (for batch PATH).
    git_cmd_bin: Option<String>,
    /// Computed in the sequencer: ml64 parent dir (for batch PATH).
    ml64_bin: Option<String>,
    /// Computed in the sequencer: vs_devcmd path.
    vs_devcmd: String,
    /// Computed in the sequencer: forced CUDA path.
    cuda_path_forced: String,
}

impl<'a> BuildCtx<'a> {
    fn rollback(&self) -> RollbackBuilder<'a> {
        rollback_build(self.app_handle, self.provider_id, self.profile_id, self.build_id)
    }
}

/// Stage 1 — git clone/pull, vendor patches, optional GitHub PR.
/// Returns the resolved git executable path on success.
async fn stage_git_ops<'a>(ctx: &BuildCtx<'a>) -> Result<std::path::PathBuf, String> {
    let app_handle = ctx.app_handle;
    let provider_id = ctx.provider_id;
    let profile_id = ctx.profile_id;
    let build_id = ctx.build_id;
    let engine_root = crate::config::foundry_dir(provider_id);
    let src_dir = engine_root.join("llama.cpp");

    // ── Git Operations ───────────────────────────────────────────────

    let git_exe = match ensure_git_available(app_handle).await {
        Ok(exe) => exe,
        Err(e) => {
            ctx.rollback().with_message(e.clone()).execute().await;
            return Err(e);
        }
    };

    let (git_url, branch) = {
        let cfg = ctx.worker.config.lock().map_err(|e| e.to_string())?;
        let p = cfg.providers.iter()
            .find(|p| p.id == provider_id);
        (
            p.map(|p| p.git_url.clone()).unwrap_or_default(),
            p.map(|p| p.branch.clone()).unwrap_or_else(|| "main".to_string()),
        )
    };

    if git_url.is_empty() {
            ctx.rollback().execute().await;
            return Err(format!("Provider '{}' has no git_url configured.", provider_id));
    }

    let is_existing = src_dir.join(".git").exists();

    if !is_existing {
        if src_dir.exists() {
            let _ = tokio::fs::remove_dir_all(&src_dir).await;
        }

        set_build_phase(BuildPhase::GitClone).await;
        if let Some(state) = snapshot_build_state().await {
            emit_build_event(
                app_handle,
                &state,
                Some(format!(
                    "[STAGE 1/4] REPOSITORY — Cloning {} (branch {})… First download can take several minutes on slow internet.",
                    git_url, branch
                )),
            );
        }

        let clone_parent = engine_root.parent().ok_or_else(|| {
            format!("Invalid engine root (no parent): {}", engine_root.display())
        })?;
        let heartbeat = spawn_repo_heartbeat(app_handle.clone(), "cloning repository", BuildPhase::GitClone);
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
        heartbeat.abort();

        if !clone_output.status.success() {
            let stderr = String::from_utf8_lossy(&clone_output.stderr).to_string();
            let msg = format!("Git clone failed: {}", stderr.trim());
            ctx.rollback().with_message(msg.clone()).execute().await;
            return Err(msg);
        }

        set_build_phase(BuildPhase::Configuring).await;
        emit_config_event(
            app_handle,
            provider_id,
            profile_id,
            build_id,
            Some("[STAGE 1/4] REPOSITORY — Clone complete.".into()),
        );
    } else {
        set_build_phase(BuildPhase::GitPull).await;
        if let Some(state) = snapshot_build_state().await {
            emit_build_event(
                app_handle,
                &state,
                Some(format!(
                    "[STAGE 1/4] REPOSITORY — Syncing branch '{}' (fetch + hard reset)…",
                    branch
                )),
            );
        }

        // Product trees are build inputs, not hand-edit workspaces. Backup any dirt,
        // then hard-sync so local patches never block the build (re-applied below).
        let heartbeat =
            spawn_repo_heartbeat(app_handle.clone(), "updating repository", BuildPhase::GitPull);
        backup_foundry_src_dirty_diff(&git_exe, &src_dir, provider_id).await;
        let sync_result = git_hard_sync_branch(&git_exe, &src_dir, &branch).await;
        heartbeat.abort();

        if let Err(e) = sync_result {
            ctx.rollback().with_message(e.clone()).execute().await;
            return Err(e);
        }

        set_build_phase(BuildPhase::Configuring).await;
        emit_config_event(
            app_handle,
            provider_id,
            profile_id,
            build_id,
            Some("[STAGE 1/4] REPOSITORY — Repository synced to origin.".into()),
        );
    }

    // Refresh app_root/foundry/patches from repo/resource so DEV edits ship immediately.
    if let Err(e) = crate::config::ensure_foundry_patches_materialized(app_handle) {
        log::warn!("[foundry] patch materialize: {e}");
    }

    // ── Optional GitHub PR stack (fetch+merge on clean tree) ─────────
    // Must run BEFORE vendor patches: merge needs a clean worktree, and
    // product overlays should sit on top of upstream+PR.
    // Hard-fails on the first parse or apply failure (no warn-and-continue).
    if let Some(pr_input_str) = ctx.pr_url {
        if !pr_input_str.trim().is_empty() {
            let pr_stack = match parse_pr_list(pr_input_str) {
                Ok(stack) => stack,
                Err(e) => {
                    ctx.rollback().with_message(e.clone()).execute().await;
                    return Err(e);
                }
            };

            if !pr_stack.is_empty() {
                // Resolve the provider git_url once for number-only repo guessing.
                let provider_git_url = {
                    if let Ok(cfg) = ctx.worker.config.lock() {
                        cfg.providers.iter().find(|p| p.id == provider_id)
                            .map(|p| p.git_url.clone())
                            .unwrap_or_default()
                    } else {
                        String::new()
                    }
                };

                let mut applied_nums: Vec<String> = Vec::new();
                for (owner_repo_opt, pr_num) in &pr_stack {
                    let resolved_owner_repo = owner_repo_opt.clone().or_else(|| {
                        if !provider_git_url.trim().is_empty() {
                            extract_github_owner_repo(&provider_git_url)
                        } else {
                            None
                        }
                    });

                    // Number-only PR with no resolvable owner/repo → hard-fail.
                    let owner_repo = match resolved_owner_repo {
                        Some(r) => r,
                        None => {
                            let msg = format!(
                                "PR #{pr_num} (number only) has no resolvable owner/repo — cannot fetch"
                            );
                            ctx.rollback().with_message(msg.clone()).execute().await;
                            return Err(msg);
                        }
                    };

                    let fetch_msg = if owner_repo_opt.is_none() {
                        format!(
                            "[PR] Guessed repo {owner_repo} from provider git_url — fetching PR #{pr_num}..."
                        )
                    } else {
                        format!("[PR] Fetching PR #{pr_num} from {owner_repo}...")
                    };
                    emit_config_event(
                        app_handle,
                        provider_id,
                        profile_id,
                        build_id,
                        Some(fetch_msg),
                    );

                    match apply_foundry_github_pr(&git_exe, &src_dir, &owner_repo, pr_num).await {
                        Ok(method) => {
                            let how = match method {
                                "merged" => "merged (pull head)",
                                "patch" => "applied (patch)",
                                "patch-3way" => "applied (patch 3-way)",
                                other => other,
                            };
                            emit_config_event(
                                app_handle,
                                provider_id,
                                profile_id,
                                build_id,
                                Some(format!("[PR] #{pr_num} {how}")),
                            );
                            applied_nums.push(pr_num.clone());
                        }
                        Err(err) => {
                            let msg = format!("PR #{pr_num} apply failed: {err}");
                            ctx.rollback().with_message(msg.clone()).execute().await;
                            return Err(msg);
                        }
                    }
                }

                // ── Entire stack succeeded: persist last_pr + history ──
                let env_key = profile_id.to_string();
                let last_pr = applied_nums.join(",");
                let stack_str = pr_input_str.split_whitespace().collect::<Vec<_>>().join(" ");

                if let Ok(mut cfg) = ctx.worker.config.lock() {
                    if let Some(p) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
                        p.last_pr_per_env.insert(env_key.clone(), last_pr);
                        let history = p.pr_history_per_env.entry(env_key).or_default();
                        push_pr_history(history, stack_str);
                    }
                }
                // HISTORY must survive cancel-at-PROCEED — persist immediately.
                if let Err(e) = persist_providers_atomic(&ctx.worker.config) {
                    log::warn!("[foundry] persist after PR stack: {e}");
                }

                emit_config_event(
                    app_handle,
                    provider_id,
                    profile_id,
                    build_id,
                    Some(format!(
                        "[PR] stack applied: {}",
                        applied_nums.iter().map(|n| format!("#{n}")).collect::<Vec<_>>().join(" ")
                    )),
                );
            }
        }
    }

    // Product vendor patches (e.g. single-model /models/sse cold-boot). Soft-fail:
    // a drifted upstream must not kill the 1-click newest-engine path.
    // Applied AFTER PR so overlays always win on product paths.
    let (applied_patches, failed_patches) =
        apply_foundry_vendor_patches(&git_exe, &src_dir, provider_id).await;
    if !applied_patches.is_empty() {
        emit_config_event(
            app_handle,
            provider_id,
            profile_id,
            build_id,
            Some(format!(
                "[STAGE 1/4] REPOSITORY — Applied vendor patch(es): {}",
                applied_patches.join(", ")
            )),
        );
    }
    for fail in &failed_patches {
        let msg = format!(
            "[WARN] PATCH FAIL — {fail}. Continuing without this patch (fallback boot path)."
        );
        log::warn!("[foundry] {msg}");
        emit_config_event(
            app_handle,
            provider_id,
            profile_id,
            build_id,
            Some(msg.clone()),
        );
        foundry_console_emit(
            app_handle,
            msg,
            BlackwellOutputConsoleLineStyle::Error,
        );
    }

    Ok(git_exe)
}

/// Stage 2 — CMake configure chain. Returns the cmake_extra flags string.
async fn stage_cmake_configure<'a>(ctx: &BuildCtx<'a>, git_exe: &std::path::Path) -> Result<String, String> {
    let app_handle = ctx.app_handle;
    let provider_id = ctx.provider_id;
    let profile_id = ctx.profile_id;
    let build_id = ctx.build_id;
    let profile = ctx.profile;
    let manifest = ctx.manifest;
    let all_cuda_vars = ctx.all_cuda_vars;
    let work_root = crate::config::foundry_work_dir(provider_id);
    let build_dir = work_root.join(format!("build-{profile_id}"));
    let src_dir = crate::config::foundry_dir(provider_id).join("llama.cpp");

    // ── CMake Build Chain ────────────────────────────────────────────

    let template_type = resolve_template_type(provider_id);

    let cmake_extra = {
        let cfg = ctx.worker.config.lock().map_err(|e| e.to_string())?;
        let p = cfg.providers.iter()
            .find(|p| p.id == provider_id);
        let build_profile = p.map(|p| p.build_profile.clone()).unwrap_or_default();

        // Foundry confirm modal loads provider build_profile for edit; persisted on build start.
        // cmake_flags from the invoke carries the edited profile for this configure attempt.
        let raw = if let Some(flags) = ctx.cmake_flags {
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
        };
        // Always pin server on, tests/examples off, native off (portable ship).
        merge_mandatory_cmake_flags(&raw)
    };

    let available: usize = std::thread::available_parallelism()
        .map(|p| p.get())
        .unwrap_or(8);
    let max_cores_usize: Option<usize> = ctx.max_cores.map(|n| n as usize);
    let num_cpus = max_cores_usize.unwrap_or(available).min(available).max(2);

    emit_config_event(app_handle, provider_id, profile_id, build_id, Some(format!(
        "[STAGE 2/4] CMAKE CONFIGURE — {} cores detected", num_cpus
    )));

    emit_config_event(app_handle, provider_id, profile_id, build_id, Some(format!(
        "[TOOLCHAIN] {} / CUDA {} / NVCC {}",
        profile.display_label(),
        profile.cuda_version_short(),
        profile.nvcc.display()
    )));

    emit_config_event(app_handle, provider_id, profile_id, build_id, Some("[STAGE 2/4] CMAKE CONFIGURE — Reviewing flags below. Click PROCEED to start compilation.".into()));

    // Effective generator: provider override wins, else the manifest profile's `ninja` flag.
    // VS-only vs Ninja: Ninja drops `-T`, `-A` and the VS toolset CUDA var; it picks the host
    // compiler from the devcmd environment (sourced earlier in the batch).
    let use_ninja = {
        let saved_generator = {
            let cfg = ctx.worker.config.lock().map_err(|e| e.to_string())?;
            cfg.providers
                .iter()
                .find(|p| p.id == provider_id)
                .map(|p| p.foundry_generator.clone())
                .unwrap_or_default()
        };
        // Per-build override (from the confirm modal) wins, else the provider's saved choice.
        let override_str = ctx.generator
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.to_string())
            .unwrap_or(saved_generator);
        foundry_toolchain::ResolvedProfile::effective_use_ninja(profile.def.ninja, &override_str)
    };
    let toolset_flag = profile.vs_cuda_toolset_flag(profile.cuda_version_short(), use_ninja);
    let forced_cuda_flags = profile.forced_cuda_flags(use_ninja);

    let asm_flag = profile.cmake_asm_compiler_flag(manifest)?;

    let joined_extra = if cmake_extra.is_empty() {
        String::new()
    } else {
        cmake_extra.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ")
    };
    // Batch-safe copy (escapes cmd metachars) used only inside the generated .bat; the raw
    // flags are kept for the display message and the cache fingerprint stays deterministic.
    let joined_extra_batch = cmd_escape_batch(&joined_extra);

    let vs_def = foundry_toolchain::vs_def(manifest, &profile.def.vs)?;
    let gen_flag = profile.cmake_generator_flag(vs_def, use_ninja);
    let nvcc_bin = profile.cuda_root.join("bin").to_string_lossy().to_string();
    let versioned_var = profile.cuda_path_var();

    // Ninja generator requires ninja.exe beside cmake.exe. Ensure it's present before we
    // write/run the configure batch (downloads it on demand if the stripped-down pack lacks it).
    if use_ninja {
        if let Err(e) = foundry_toolchain::ensure_ninja_available().await {
            ctx.rollback().execute().await;
            return Err(format!(
                "Profile '{}' uses the Ninja generator but ninja.exe is unavailable: {}",
                profile_id, e
            ));
        }
    }
    emit_config_event(app_handle, provider_id, profile_id, build_id, Some(if use_ninja {
        "[GENERATOR] Ninja Multi-Config — VS-only flags (-T/-A/toolset-CUDA) omitted".to_string()
    } else {
        format!(
            "[GENERATOR] {} — VS toolset flags applied",
            profile.def.generator
        )
    }));

    // Absolute out-of-source configure (build tree lives in disposable work/ — never inside source)
    let build_dir_str = build_dir.to_string_lossy().replace('\\', "/");
    let src_dir_str   = src_dir.to_string_lossy().replace('\\', "/");
    let cmake_configure_line = if joined_extra_batch.is_empty() {
        format!(
            r#""{}" -B "{}" -S "{}" {} {} {} {} -Wno-dev"#,
            ctx.cmake_cmd, build_dir_str, src_dir_str, gen_flag, toolset_flag, forced_cuda_flags, asm_flag
        )
    } else {
        format!(
            r#""{}" -B "{}" -S "{}" {} {} {} {} {} -Wno-dev"#,
            ctx.cmake_cmd, build_dir_str, src_dir_str, gen_flag, toolset_flag, forced_cuda_flags, asm_flag, joined_extra_batch
        )
    };

    let toolchain_id = profile.toolchain_id(manifest);
    let cache_fingerprint = foundry_cache_fingerprint(profile_id, &cmake_configure_line, &toolchain_id);
    let cache_reused = match prepare_foundry_build_dir(&build_dir, &cache_fingerprint).await {
        Ok(reused) => reused,
        Err(e) => {
            ctx.rollback().execute().await;
            return Err(e);
        }
    };
    if cache_reused {
        emit_config_event(
            app_handle,
            provider_id,
            profile_id,
            build_id,
            Some(format!(
                "[CACHE] Reusing CMake build tree for build-{profile_id} (incremental — flags unchanged)"
            )),
        );
    } else {
        emit_config_event(
            app_handle,
            provider_id,
            profile_id,
            build_id,
            Some(format!(
                "[CACHE] Cold CMake tree for build-{profile_id} (new profile, flag change, or manual clear)"
            )),
        );
    }

    emit_config_event(app_handle, provider_id, profile_id, build_id, Some(format!(
        "cmake -B work/build-{} -S llama.cpp {} {} {} {}{}",
        profile_id,
        gen_flag,
        toolset_flag,
        asm_flag,
        forced_cuda_flags,
        if !joined_extra.is_empty() { format!(" {}", joined_extra) } else { String::new() }
    )));

    let cfg_batch_lines = build_isolated_batch_script(
        &ctx.vs_devcmd,
        &ctx.cuda_path_forced,
        &nvcc_bin,
        &versioned_var,
        all_cuda_vars,
        ctx.ml64_bin.as_deref(),
        ctx.git_cmd_bin.as_deref(),
        cmake_configure_line,
    );
    let cfg_batch_content = cfg_batch_lines.join("\n");
    let (cfg_batch_path, _) = foundry_batch_script_paths(&work_root, profile_id);
    if let Err(e) = tokio::fs::write(&cfg_batch_path, &cfg_batch_content).await {
        clear_build_slot_if_matches(build_id, provider_id, app_handle).await;
        return Err(format!("Failed to write build script: {}", e));
    }

    // Non-elevated. Spawn via std::process (not tokio) — see run_foundry_batch_streaming.
    let (cfg_program, cfg_raw_tail) =
        crate::sidecar_elevate::cmd_script_launch(&cfg_batch_path);
    let state_cfg = require_build_state("cmake configure").await?;

    emit_config_event(
        app_handle,
        provider_id,
        profile_id,
        build_id,
        Some(
            "[FOUNDRY] starting configure batch (std::process + OS pipe threads) — expect [FOUNDRY-ENV] next…"
                .into(),
        ),
    );

    let configure_heartbeat = spawn_configure_heartbeat(app_handle.clone());

    let (cfg_status, cfg_stderr_lines) = match run_foundry_batch_streaming(
        &cfg_program,
        &cfg_raw_tail,
        &src_dir,
        app_handle,
        &state_cfg,
        Some(std::time::Duration::from_secs(20 * 60)), // configure guard
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            configure_heartbeat.abort();
            clear_pids();
            clear_build_slot_if_matches(build_id, provider_id, app_handle).await;
            return Err(e);
        }
    };
    configure_heartbeat.abort();

    let Some(cfg_status) = cfg_status else {
        clear_pids();
        clear_build_slot_if_matches(build_id, provider_id, app_handle).await;
        return Err("Build cancelled by user.".to_string());
    };

    if !cfg_status.success() {
        let stderr_text = cfg_stderr_lines.join("\n");
        ctx.rollback()
            .with_message(if stderr_text.is_empty() { "CMake configure failed.".into() } else { format!("CMake configure failed:\n{}", stderr_text) })
            .execute().await;

        clear_pids();

        nuke_foundry_build_dir_on_configure_fail(provider_id, profile_id).await;
        // rollback_build(...).execute() already ended the console session above.
        return Err("CMake configure failed. Check the log above for details.".to_string());
    }

    if let Err(e) = write_foundry_cache_key(&build_dir, &cache_fingerprint).await {
        log::warn!("[foundry] Failed to persist cache fingerprint: {e}");
    }

    Ok(cmake_extra)
}

/// Stage 3 — wait for user confirmation (PROCEED).
async fn stage_wait_for_confirm<'a>(ctx: &BuildCtx<'a>, cmake_extra: &str) -> Result<(), String> {
    let app_handle = ctx.app_handle;
    let provider_id = ctx.provider_id;
    let profile_id = ctx.profile_id;
    let build_id = ctx.build_id;

    // ── Check cancellation before showing PROCEED prompt ─────────────
    if is_cancelled() {
        clear_pids();
        clear_build_slot_if_matches(build_id, provider_id, app_handle).await;
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

            nuke_foundry_work_tree_on_exit(provider_id).await;
            foundry_console_end_session(app_handle, build_id);

            emit_build_event(app_handle, &BuildState {
                build_id,
                provider_id: provider_id.to_string(),
                profile_id: profile_id.to_string(),
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
            foundry_console_end_session(app_handle, build_id);
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

    Ok(())
}

/// Stage 4 — CMake compile. Returns true if a tail-rule flake was recovered.
async fn stage_compile<'a>(ctx: &BuildCtx<'a>, cmake_extra: &str) -> Result<bool, String> {
    let app_handle = ctx.app_handle;
    let provider_id = ctx.provider_id;
    let profile_id = ctx.profile_id;
    let build_id = ctx.build_id;
    let profile = ctx.profile;
    let manifest = ctx.manifest;
    let all_cuda_vars = ctx.all_cuda_vars;
    let work_root = crate::config::foundry_work_dir(provider_id);
    let build_dir = work_root.join(format!("build-{profile_id}"));
    let src_dir = crate::config::foundry_dir(provider_id).join("llama.cpp");
    let cmake_build_output_dir = build_dir.join("bin").join("Release");

    // ── PHASE 2: CMake Build (after user approval) ───────────────────

    let build_targets = foundry_cmake_build_targets(ctx.include_extra_tools);
    if let Some(state) = snapshot_build_state().await {
        emit_build_event(app_handle, &state, Some(format!(
            "[STAGE 3/4] BUILD — {} target(s) [{}], {} cores...",
            build_targets.len(),
            build_targets.join(", "),
            ctx.num_cpus
        )));
    }

    let nvcc_bin = profile.cuda_root.join("bin").to_string_lossy().to_string();
    let versioned_var = profile.cuda_path_var();

    // Absolute --build (no cd, no reliance on relative layout)
    let build_dir_str = build_dir.to_string_lossy().replace('\\', "/");
    let build_target_args = foundry_cmake_build_target_args(ctx.include_extra_tools);
    let build_batch_lines = build_isolated_batch_script(
        &ctx.vs_devcmd,
        &ctx.cuda_path_forced,
        &nvcc_bin,
        &versioned_var,
        all_cuda_vars,
        ctx.ml64_bin.as_deref(),
        ctx.git_cmd_bin.as_deref(),
        format!(
            r#""{}" --build "{}" --config Release{build_target_args} -j {}"#,
            ctx.cmake_cmd, build_dir_str, ctx.num_cpus
        ),
    );
    let build_batch_content = build_batch_lines.join("\n");
    let (_, build_batch_path) = foundry_batch_script_paths(&work_root, profile_id);
    if let Err(e) = tokio::fs::write(&build_batch_path, &build_batch_content).await {
        return Err(format!("Failed to write build script: {}", e));
    }

    // Non-elevated — same std::process path as configure.
    let (build_program, build_raw_tail) =
        crate::sidecar_elevate::cmd_script_launch(&build_batch_path);
    let state_for_stream = require_build_state("compilation").await?;

    // Compile is the longest phase with no liveness signal — add a heartbeat so a wedged
    // MSBuild/Ninja child (silent, still alive) is surfaced instead of hanging forever.
    let build_heartbeat = spawn_build_heartbeat(app_handle.clone());

    let (build_status, stderr_text) = match run_foundry_batch_streaming(
        &build_program,
        &build_raw_tail,
        &src_dir,
        app_handle,
        &state_for_stream,
        Some(std::time::Duration::from_secs(120 * 60)), // 2h guard for large CUDA builds
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            build_heartbeat.abort();
            clear_pids();
            foundry_console_end_session(app_handle, build_id);
            do_rollback(&cmake_build_output_dir).await;
            return Err(e);
        }
    };
    build_heartbeat.abort();

    let Some(build_status) = build_status else {
        clear_pids();
        foundry_console_end_session(app_handle, build_id);
        do_rollback(&cmake_build_output_dir).await;
        return Err("Build cancelled by user.".to_string());
    };

    let stderr_joined = stderr_text.join("\n");
    let mut recovered_tail_flake = false;
    if !build_status.success() {
        let precheck = check_foundry_core_binaries(&foundry_release_candidate_dirs(
            &build_dir,
            &src_dir,
        ));
        if precheck.all_present && is_windows_vs_tail_batch_flake(&stderr_joined) {
            recovered_tail_flake = true;
            if let Some(state) = snapshot_build_state().await {
                emit_build_event(
                    app_handle,
                    &state,
                    Some(
                        "[WARN] MSBuild exited non-zero after shipping targets linked \
                         (Windows VS tail rule: batch file cannot be found). \
                         Core binaries present — continuing validation."
                            .into(),
                    ),
                );
            }
        } else {
            ctx.rollback()
                .with_message(if stderr_joined.is_empty() {
                    "Build failed.".into()
                } else {
                    format!("Build failed:\n{stderr_joined}")
                })
                .execute()
                .await;

            clear_pids();
            *CURRENT_BUILD.lock().await = None;
            return Err(format!("Build failed.\nSTDERR: {stderr_joined}"));
        }
    }

    clear_pids();

    if is_cancelled() {
        // work/ nuked on exit
        return Err("Build cancelled by user.".to_string());
    }

    Ok(recovered_tail_flake)
}

/// Stage 5 — integrity validation of core binaries.
async fn stage_validate<'a>(ctx: &BuildCtx<'a>, recovered_tail_flake: bool) -> Result<(), String> {
    let app_handle = ctx.app_handle;
    let provider_id = ctx.provider_id;
    let profile_id = ctx.profile_id;
    let build_id = ctx.build_id;
    let work_root = crate::config::foundry_work_dir(provider_id);
    let build_dir = work_root.join(format!("build-{profile_id}"));
    let src_dir = crate::config::foundry_dir(provider_id).join("llama.cpp");
    let cmake_build_output_dir = build_dir.join("bin").join("Release");

    // ── Integrity Validation ─────────────────────────────────────────

    {
        let mut current = CURRENT_BUILD.lock().await;
        if let Some(ref mut s) = *current {
            s.phase = BuildPhase::Validating;
        }
    }
    if let Some(state) = snapshot_build_state().await {
        emit_build_event(app_handle, &state, Some("[STAGE 4/4] VALIDATE — Checking core binaries...".into()));
    }

    let candidate_dirs = foundry_release_candidate_dirs(&build_dir, &src_dir);
    let binary_check = check_foundry_core_binaries(&candidate_dirs);
    let all_present = binary_check.all_present;
    let missing = binary_check.missing;
    let validated_binary_dir = binary_check.binary_dir;

    if let Some(found_dir) = &validated_binary_dir {
        if *found_dir != cmake_build_output_dir {
            log::info!("Binaries found at {:?}, updating provider path", found_dir);
            let mut cfg = ctx.worker.config.lock().map_err(|e| e.to_string())?;
            if let Some(p) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
                let _ = found_dir.join("llama-server.exe");
                if let Err(e) = crate::profile_binaries::activate_profile_source(
                    p,
                    profile_id,
                    crate::profile_binaries::SOURCE_FOUNDRY,
                ) {
                    log::warn!("[foundry] path-correction activate failed: {e}");
                }
            }
            drop(cfg);
            if let Err(e) = persist_providers_atomic(&ctx.worker.config) {
                log::error!(
                    "[foundry] Failed to persist provider config after path correction: {}",
                    e
                );
            }
        }
    }

    if !all_present {
        ctx.rollback()
            .with_message(format!("Missing core binaries: {}", missing.join(", ")))
            .execute().await;

        *CURRENT_BUILD.lock().await = None;
        return Err(format!("Build completed but core binaries missing: {}", missing.join(", ")));
    }

    if ctx.include_extra_tools {
        let mut missing_extras = Vec::new();
        for bin in FOUNDRY_EXTRA_BINARIES {
            let found = candidate_dirs.iter().any(|dir| dir.join(bin).is_file());
            if !found {
                missing_extras.push(*bin);
            }
        }
        if !missing_extras.is_empty() {
            let msg = format!(
                "[WARN] Optional tools were requested but missing after build: {}. Core server/fit-params/llama-bench are OK.",
                missing_extras.join(", ")
            );
            log::warn!("[foundry] {msg}");
            if let Some(state) = snapshot_build_state().await {
                emit_build_event(app_handle, &state, Some(msg));
            }
        }
    }

    if recovered_tail_flake {
        log::warn!(
            "[foundry] Recovered Windows VS tail-rule flake for {provider_id}/{profile_id}"
        );
    }

    Ok(())
}

/// Stage 6 — publish sacred artifacts, activate foundry as ACTIVE, then Complete.
async fn stage_publish_activate<'a>(ctx: &BuildCtx<'a>, cmake_extra: &str) -> Result<(), String> {
    let app_handle = ctx.app_handle;
    let provider_id = ctx.provider_id;
    let profile_id = ctx.profile_id;
    let build_id = ctx.build_id;
    let work_root = crate::config::foundry_work_dir(provider_id);
    let build_dir = work_root.join(format!("build-{profile_id}"));
    let src_dir = crate::config::foundry_dir(provider_id).join("llama.cpp");

    // ── Success: publish artifacts, activate foundry as ACTIVE, THEN Complete ─
    // Do NOT emit Complete before path/source update — frontend refresh_build_info
    // on early Complete races and can pin binary_source_per_env back to bundled.

    if let Some(state) = snapshot_build_state().await {
        emit_build_event(
            app_handle,
            &state,
            Some("Build successful. Publishing artifacts + activating Foundry binary...".into()),
        );
    }

    // Publish sacred artifacts (copy from disposable work tree into artifacts/<id>/<env>/Release)
    // This is the ONLY place the sacred tree is written during a normal build.
    let sacred_binary_path = match publish_artifacts_to_sacred(provider_id, profile_id, &build_dir, &src_dir).await {
        Ok(p) => p,
        Err(e) => {
            foundry_console_end_session(app_handle, build_id);
            *CURRENT_BUILD.lock().await = None;
            return Err(format!("Build succeeded but failed to publish sacred artifacts: {}", e));
        }
    };

    // Always force ACTIVE → foundry for this profile (even if --version probe fails).
    // Probe outside the config lock — never hold Mutex across await.
    let probed = crate::engine::get_binary_build_info(sacred_binary_path.clone()).await;
    {
        let mut cfg = ctx.worker.config.lock().map_err(|e| e.to_string())?;
        if let Some(provider) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
            provider.downloaded_version_per_env.remove(profile_id);
            if let Err(e) = crate::profile_binaries::activate_profile_source(
                provider,
                profile_id,
                crate::profile_binaries::SOURCE_FOUNDRY,
            ) {
                log::error!("[foundry] activate foundry source failed: {e}");
            }

            let foundry_path = provider
                .binary_path_per_env
                .get(profile_id)
                .cloned()
                .unwrap_or_else(|| {
                    crate::config::to_relative_path(&std::path::PathBuf::from(&sacred_binary_path))
                });

            match probed {
                Ok(build_info_raw) => {
                    log::info!(
                        "[foundry] Captured build info for provider '{}' profile '{}': {} built {}",
                        provider_id,
                        profile_id,
                        build_info_raw.version,
                        build_info_raw.build_date
                    );
                    let arches =
                        crate::engine_utils::parse_cuda_architectures_from_cmake(cmake_extra);
                    let build_info = crate::types::BuildInfo {
                        version: build_info_raw.version,
                        build_date: build_info_raw.build_date,
                        cuda_version: build_info_raw.cuda_version.clone(),
                        cuda_architectures: if arches.is_empty() {
                            None
                        } else {
                            Some(arches)
                        },
                    };
                    provider
                        .build_info_per_env
                        .insert(profile_id.to_string(), build_info.clone());
                    let inv = provider
                        .inventory_per_env
                        .entry(profile_id.to_string())
                        .or_default();
                    inv.foundry = Some(crate::types::BinaryEntry {
                        path: foundry_path,
                        info: Some(build_info),
                    });
                }
                Err(e) => {
                    log::warn!(
                        "[foundry] Failed to capture build info for provider '{}': {} — Foundry still ACTIVE",
                        provider_id,
                        e
                    );
                    let inv = provider
                        .inventory_per_env
                        .entry(profile_id.to_string())
                        .or_default();
                    if inv.foundry.is_none() {
                        inv.foundry = Some(crate::types::BinaryEntry {
                            path: foundry_path,
                            info: None,
                        });
                    }
                }
            }
        }
        drop(cfg);
        if let Err(e) = persist_providers_atomic(&ctx.worker.config) {
            log::error!("[foundry] Failed to persist provider config: {}", e);
        }
    }

    {
        let mut current = CURRENT_BUILD.lock().await;
        if let Some(ref mut s) = *current {
            s.phase = BuildPhase::Complete;
        }
    }
    if let Some(state) = snapshot_build_state().await {
        emit_build_event(
            app_handle,
            &state,
            Some("Foundry build complete — ACTIVE binary source: foundry.".into()),
        );
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

    nuke_foundry_work_tree_on_exit(provider_id).await;

    // Just tidy the PID list. Do not kill on success — children are expected to die naturally
    // once the tracked cmake --build child has exited (pre-refactor behavior).
    let remaining = with_child_pids(|pids: &mut Vec<u32>| std::mem::take(pids)).unwrap_or_default();
    if !remaining.is_empty() {
        log::info!("[foundry] Success path: {} tracked PIDs left (expected to have exited naturally)", remaining.len());
    }

    *CURRENT_BUILD.lock().await = None;

    Ok(())
}

/// Sequencer — calls each stage in order. Control flow, error strings, cancel checks,
/// rollback, and emit text stay identical to the pre-decomposition single body.
async fn run_foundry_build_worker(
    worker: FoundryWorkerApp,
    provider_id: String,
    environment: String,
    pr_url: Option<String>,
    max_cores: Option<u32>,
    cmake_flags: Option<String>,
    generator: Option<String>,
    include_extra_tools: bool,
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
    //   work_root   = engine_root/work               (DISPOSABLE in release; cached in DEV)
    //     build_dir = work_root/build-{env}        (CMake tree — reused in DEV when flags match)
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

    // Keep work/ between builds (fingerprint decides reuse of build-{profile}/). Ensure root exists.
    if let Err(e) = tokio::fs::create_dir_all(&work_root).await {
        rollback_build(app_handle, &provider_id, &profile_id, build_id)
            .execute()
            .await;
        return Err(format!("Failed to create work directory: {}", e));
    }

    // Pre-compute values shared across stages (avoids re-deriving in each stage).
    let available: usize = std::thread::available_parallelism()
        .map(|p| p.get())
        .unwrap_or(8);
    let max_cores_usize: Option<usize> = max_cores.map(|n| n as usize);
    let num_cpus = max_cores_usize.unwrap_or(available).min(available).max(2);
    let cmake_exe = foundry_toolchain::resolve_cmake_exe()?;
    let cmake_cmd = cmake_exe.to_string_lossy().replace('\\', "/");
    let vs_devcmd = profile.vs_devcmd.to_string_lossy().to_string();
    let cuda_path_forced = profile.cuda_root.to_string_lossy().to_string();
    let ml64_bin = profile
        .ml64_exe(&manifest)
        .parent()
        .map(|p| p.to_string_lossy().to_string());

    let ctx = BuildCtx {
        worker: &worker,
        app_handle,
        provider_id: &provider_id,
        environment: &environment,
        profile_id: &profile_id,
        build_id,
        manifest: &manifest,
        profile: &profile,
        all_cuda_vars: &all_cuda_vars,
        pr_url: pr_url.as_deref(),
        max_cores,
        cmake_flags: cmake_flags.as_deref(),
        generator: generator.as_deref(),
        include_extra_tools,
        num_cpus,
        cmake_cmd,
        git_cmd_bin: None, // set after git_exe is resolved in stage_git_ops
        ml64_bin,
        vs_devcmd,
        cuda_path_forced,
    };

    // Stage 1: git clone/pull, vendor patches, optional GitHub PR
    let git_exe = stage_git_ops(&ctx).await?;

    // Update git_cmd_bin now that we have the git exe path
    let git_cmd_bin = git_exe.parent().map(|p| p.to_string_lossy().to_string());
    let ctx = BuildCtx {
        git_cmd_bin,
        ..ctx
    };

    // Stage 2: CMake configure
    let cmake_extra = stage_cmake_configure(&ctx, &git_exe).await?;

    // Stage 3: wait for user confirmation
    stage_wait_for_confirm(&ctx, &cmake_extra).await?;

    // Stage 4: compile
    let recovered_tail_flake = stage_compile(&ctx, &cmake_extra).await?;

    // Stage 5: integrity validation
    stage_validate(&ctx, recovered_tail_flake).await?;

    // Stage 6: publish + activate
    stage_publish_activate(&ctx, &cmake_extra).await
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

        nuke_foundry_work_tree_on_exit(&state.provider_id).await;

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
pub async fn foundry_preview_source(
    app: tauri::State<'_, crate::engine::AppContext>,
    app_handle: tauri::AppHandle,
    provider_id: String,
    environment: String,
) -> Result<FoundrySourcePreview, String> {
    let profile_key = environment.to_ascii_lowercase();
    let (git_url, branch, installed_version, installed_commit, installed_build_date, has_foundry_binary) = {
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        let provider = cfg
            .providers
            .iter()
            .find(|p| p.id == provider_id)
            .ok_or_else(|| format!("Provider '{}' not found", provider_id))?;
        let branch = if provider.branch.trim().is_empty() {
            "main".to_string()
        } else {
            provider.branch.clone()
        };
        let inv = provider.inventory_per_env.get(&profile_key);
        let foundry_entry = inv.and_then(|i| i.foundry.as_ref());
        let build_info = foundry_entry
            .and_then(|e| e.info.as_ref())
            .or_else(|| provider.build_info_per_env.get(&profile_key));
        let installed_version = build_info.map(|b| b.version.clone());
        let installed_build_date = build_info.map(|b| b.build_date.clone());
        let installed_commit = installed_version
            .as_deref()
            .and_then(extract_commit_from_build_version);

        let path_candidates: Vec<String> = [
            foundry_entry.map(|e| e.path.clone()),
            provider.binary_path_per_env.get(&profile_key).cloned(),
            Some(
                crate::config::foundry_artifact_release_dir(&provider_id, &profile_key)
                    .join("llama-server.exe")
                    .to_string_lossy()
                    .to_string(),
            ),
        ]
        .into_iter()
        .flatten()
        .collect();
        let has_foundry_binary = path_candidates.iter().any(|p| {
            let abs = crate::config::resolve_path(p);
            abs.is_file()
        });

        (
            provider.git_url.clone(),
            branch,
            installed_version,
            installed_commit,
            installed_build_date,
            has_foundry_binary,
        )
    };

    // Inventory often keeps mtime placeholders ("foundry-artifact") after a successful build
    // when --version parse lagged the new llama.cpp format. Probe the sacred exe once so the
    // banner can say "matches latest" instead of lying about a missing install.
    let (installed_version, installed_commit, installed_build_date) = if has_foundry_binary
        && installed_commit.is_none()
    {
        let probe_path = {
            let cfg = app.config.lock().map_err(|e| e.to_string())?;
            let provider = cfg
                .providers
                .iter()
                .find(|p| p.id == provider_id);
            let inv_path = provider
                .and_then(|p| p.inventory_per_env.get(&profile_key))
                .and_then(|i| i.foundry.as_ref())
                .map(|e| e.path.clone());
            let active_path = provider
                .and_then(|p| p.binary_path_per_env.get(&profile_key).cloned());
            inv_path
                .or(active_path)
                .unwrap_or_else(|| {
                    crate::config::foundry_artifact_release_dir(&provider_id, &profile_key)
                        .join("llama-server.exe")
                        .to_string_lossy()
                        .to_string()
                })
        };
        match crate::engine::get_binary_build_info(probe_path.clone()).await {
            Ok(info) => {
                let commit = extract_commit_from_build_version(&info.version);
                if commit.is_some() {
                    let mut wrote = false;
                    if let Ok(mut cfg) = app.config.lock() {
                        if let Some(provider) =
                            cfg.providers.iter_mut().find(|p| p.id == provider_id)
                        {
                            let date = info.build_date.clone();
                            provider
                                .build_info_per_env
                                .insert(profile_key.clone(), info.clone());
                            let inv = provider
                                .inventory_per_env
                                .entry(profile_key.clone())
                                .or_default();
                            let path = inv
                                .foundry
                                .as_ref()
                                .map(|e| e.path.clone())
                                .unwrap_or_else(|| {
                                    crate::config::to_relative_path(&crate::config::resolve_path(
                                        &probe_path,
                                    ))
                                });
                            inv.foundry = Some(crate::types::BinaryEntry {
                                path,
                                info: Some(info.clone()),
                            });
                            wrote = true;
                            log::info!(
                                "[foundry] Preview refreshed {}/{} version → {} ({})",
                                provider_id,
                                profile_key,
                                info.version,
                                date
                            );
                        }
                    }
                    if wrote {
                        // Must not hold config lock — persist re-locks.
                        let _ = persist_providers_atomic(&app.config);
                    }

                }
                (Some(info.version), commit, Some(info.build_date))
            }
            Err(_) => (installed_version, installed_commit, installed_build_date),
        }
    } else {
        (installed_version, installed_commit, installed_build_date)
    };

    if git_url.trim().is_empty() {
        return Ok(FoundrySourcePreview {
            status: "unknown".into(),
            branch,
            local_commit: None,
            remote_commit: None,
            installed_version,
            installed_commit,
            message: "Provider has no git URL — cannot compare source revisions.".into(),
            banner_tone: "muted".into(),
        });
    }

    let src_dir = foundry_src_dir(&provider_id);
    let has_repo = src_dir.join(".git").exists();
    let git_exe = ensure_git_available(&app_handle).await.ok();

    let local_commit = if has_repo {
        match git_exe.as_ref() {
            Some(exe) => git_rev_parse_short(exe, &src_dir).await,
            None => None,
        }
    } else {
        None
    };

    let remote_commit = if let Some(ref exe) = git_exe {
        git_ls_remote_short(exe, git_url.trim(), branch.trim()).await
    } else {
        None
    };

    let remote_known = remote_commit.is_some();
    let source_current = if remote_known {
        local_commit
            .as_deref()
            .zip(remote_commit.as_deref())
            .map(|(local, remote)| commits_match(local, remote))
            .unwrap_or(false)
    } else {
        has_repo
    };

    let env_label = environment.to_uppercase();
    let local_s = local_commit.as_deref().unwrap_or("?");
    let remote_s = remote_commit.as_deref().unwrap_or("?");

    let (status, message, banner_tone) = if !has_repo {
        (
            "first_clone",
            format!(
                "First build will clone {} @ {} — download can take several minutes on slow internet.",
                git_url.trim(),
                branch
            ),
            "cyan",
        )
    } else if remote_known
        && local_commit.is_some()
        && remote_commit.is_some()
        && !commits_match(local_s, remote_s)
    {
        (
            "update_available",
            format!(
                "New commits on {} — local {} → remote {}. Build will pull before compile.",
                branch, local_s, remote_s
            ),
            "cyan",
        )
    } else if source_current
        && installed_commit.is_some()
        && local_commit.is_some()
        && commits_match(installed_commit.as_deref().unwrap(), local_s)
    {
        (
            "up_to_date",
            format!(
                "Your {} binary already matches the latest {} source (commit {}). Rebuild only if you changed CMake flags or GPU architectures.",
                env_label, branch, local_s
            ),
            "amber",
        )
    } else if source_current && has_foundry_binary && installed_commit.is_none() {
        // Binary is on disk (you just built) but inventory still has a placeholder version
        // like "foundry-artifact" — never claim "no binary installed".
        let when = installed_build_date
            .as_deref()
            .filter(|s| !s.is_empty() && *s != "unknown")
            .map(|d| format!(" (file {d})"))
            .unwrap_or_default();
        (
            "binary_present_unknown_rev",
            format!(
                "{} Foundry binary is installed{when}; source is current on {} ({}). Commit identity not in inventory yet — open Launch once or rebuild to refresh version probe. Not a missing install.",
                env_label, branch, local_s
            ),
            "amber",
        )
    } else if source_current && !has_foundry_binary && installed_commit.is_none() {
        (
            "no_binary",
            format!(
                "Repository is current on {} ({}), but no {} Foundry binary is installed yet — build required.",
                branch, local_s, env_label
            ),
            "cyan",
        )
    } else if source_current {
        (
            "binary_stale",
            format!(
                "Repository is current on {} ({}), but your {} binary ({}) was built from a different revision — build recommended.",
                branch,
                local_s,
                env_label,
                installed_version.as_deref().unwrap_or("unknown")
            ),
            "cyan",
        )
    } else if !remote_known {
        (
            "offline",
            format!(
                "Could not reach remote git (offline?). Local checkout: {}.",
                local_s
            ),
            "muted",
        )
    } else {
        (
            "unknown",
            "Could not determine whether a rebuild is needed.".into(),
            "muted",
        )
    };

    Ok(FoundrySourcePreview {
        status: status.into(),
        branch,
        local_commit,
        remote_commit,
        installed_version,
        installed_commit,
        message: message.into(),
        banner_tone: banner_tone.into(),
    })
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

    // One-time migration: ancient build/ → sacred artifacts (legacy installs).
    if prov.binary_path_per_env.is_empty() && !prov.binary_path.is_empty() {
        let src_dir = foundry_src_dir(&provider_id);
        let old_build_dir = src_dir.join("build");
        if old_build_dir.exists() {
            let new_build_dir = src_dir.join("build-frontier");
            if !new_build_dir.exists() && old_build_dir.join("bin").exists() {
                log::info!(
                    "[migration] One-time historical migration of ancient 'build/' directory for '{}'",
                    provider_id
                );
                let _ = tokio::fs::create_dir_all(&new_build_dir).await;
                if tokio::fs::rename(&old_build_dir, &new_build_dir).await.is_ok() {
                    let new_bin = new_build_dir.join("bin").join("Release");
                    if new_bin.exists() {
                        let sacred_exe = crate::config::foundry_artifacts_dir()
                            .join(&provider_id)
                            .join("frontier")
                            .join("Release")
                            .join("llama-server.exe");
                        if let Some(sacred_dir) = sacred_exe.parent() {
                            let _ = tokio::fs::create_dir_all(sacred_dir).await;
                            if copy_dir_contents(&new_bin, &sacred_dir.to_path_buf())
                                .await
                                .is_ok()
                                && sacred_exe.exists()
                            {
                                let mut cfg = app.config.lock().map_err(|e| e.to_string())?;
                                if let Some(p) =
                                    cfg.providers.iter_mut().find(|p| p.id == provider_id)
                                {
                                    let rel = crate::config::to_relative_path(&sacred_exe);
                                    p.binary_path_per_env
                                        .insert("frontier".to_string(), rel.clone());
                                    p.binary_path = rel;
                                }
                                drop(cfg);
                                if let Err(e) = persist_providers_atomic(&app.config) {
                                    log::error!(
                                        "[foundry] Failed to persist provider config: {}",
                                        e
                                    );
                                }
                            } else {
                                log::warn!(
                                    "[migration] Failed to copy binaries to sacred artifacts for '{}'",
                                    provider_id
                                );
                            }
                        }
                    }
                } else {
                    log::warn!(
                        "[migration] Failed to rename build/ for '{}'",
                        provider_id
                    );
                }
            }
        }
    }

    let mut provider = {
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        cfg.providers
            .iter()
            .find(|p| p.id == provider_id)
            .cloned()
            .ok_or_else(|| format!("Provider '{}' not found", provider_id))?
    };
    let before_source = provider.binary_source_per_env.clone();
    let before_paths = provider.binary_path_per_env.clone();
    crate::profile_binaries::resolve_after_source_change(&mut provider);
    let probed_changed = enrich_provider_binary_info(&mut provider, &provider_id).await;
    let inventory_changed = provider.binary_source_per_env != before_source
        || provider.binary_path_per_env != before_paths
        || probed_changed;

    // Always write resolved provider back — previously only probe-change persisted,
    // so auto-pick / Foundry activation from resolve was discarded when versions reused.
    {
        let mut cfg = app.config.lock().map_err(|e| e.to_string())?;
        if let Some(p) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
            *p = provider.clone();
        }
        drop(cfg);
        if inventory_changed {
            if let Err(e) =
                crate::config::persist_user_providers_meta(std::slice::from_ref(&provider))
            {
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
            if let Err(e) = crate::profile_binaries::activate_profile_source(
                p,
                &env_label,
                crate::profile_binaries::SOURCE_FOUNDRY,
            ) {
                log::error!("[foundry] restore activate failed: {e}");
            }
            p.build_info_per_env
                .insert(env_label.to_string(), info.clone());
            let inv = p
                .inventory_per_env
                .entry(env_label.to_string())
                .or_default();
            let foundry_path = inv
                .foundry
                .as_ref()
                .map(|e| e.path.clone())
                .or_else(|| p.binary_path_per_env.get(&env_label).cloned())
                .unwrap_or_default();
            inv.foundry = Some(crate::types::BinaryEntry {
                path: foundry_path,
                info: Some(info),
            });
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

fn format_file_build_date(path: &std::path::Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let mt = meta.modified().ok()?;
    use chrono::{DateTime, Local};
    let dt: DateTime<Local> = mt.into();
    Some(dt.format("%Y-%m-%d %H:%M").to_string())
}

/// Keep cached --version when non-placeholder and on-disk mtime still matches.
fn can_reuse_build_info(path: &str, existing: Option<&crate::types::BuildInfo>) -> bool {
    let Some(info) = existing else {
        return false;
    };
    if crate::engine::is_placeholder_build_version(&info.version) {
        return false;
    }
    let resolved = crate::config::resolve_path(path);
    match format_file_build_date(&resolved) {
        Some(date) => date == info.build_date,
        None => false,
    }
}

fn finish_build_info(
    mut info: crate::types::BuildInfo,
    build_profile: &str,
    preserve_cuda: Option<Vec<String>>,
) -> crate::types::BuildInfo {
    if let Some(arch) = preserve_cuda.filter(|v| !v.is_empty()) {
        info.cuda_architectures = Some(arch);
    }
    crate::engine_utils::enrich_build_info_cuda_arch(info, build_profile)
}

/// One `--version` probe (catalog-style). Used only for paths that cannot be reused.
async fn probe_build_info_fresh(
    path: &str,
    build_profile: &str,
    preserve_cuda: Option<Vec<String>>,
) -> Option<crate::types::BuildInfo> {
    let info = crate::engine::get_binary_build_info(path.to_string()).await.ok()?;
    if crate::engine::is_placeholder_build_version(&info.version) {
        return None;
    }
    Some(finish_build_info(info, build_profile, preserve_cuda))
}

struct ProbeTarget {
    /// Absolute path key (dedupe).
    key: String,
    /// Config-relative path string for get_binary_build_info.
    path: String,
    preserve_cuda: Option<Vec<String>>,
}

/// Collect inventory + active paths; reuse mtime-matched info; probe unique cold paths **in parallel**.
async fn enrich_provider_binary_info(
    provider: &mut crate::types::ProviderConfig,
    provider_id: &str,
) -> bool {
    let build_profile = provider.build_profile.clone();
    let profiles = foundry_toolchain::profile_ids_or_default();
    let mut changed = false;

    // key → best BuildInfo (reused or freshly probed)
    let mut resolved: std::collections::HashMap<String, crate::types::BuildInfo> =
        std::collections::HashMap::new();
    let mut to_probe: Vec<ProbeTarget> = Vec::new();
    let mut seen_keys: std::collections::HashSet<String> = std::collections::HashSet::new();

    let mut consider =
        |path: &str, existing: Option<&crate::types::BuildInfo>, preserve: Option<Vec<String>>| {
            let key = crate::config::resolve_path(path)
                .to_string_lossy()
                .to_string();
            if !seen_keys.insert(key.clone()) {
                return;
            }
            if can_reuse_build_info(path, existing) {
                if let Some(info) = existing {
                    resolved.insert(
                        key,
                        finish_build_info(info.clone(), &build_profile, preserve),
                    );
                }
                return;
            }
            to_probe.push(ProbeTarget {
                key,
                path: path.to_string(),
                preserve_cuda: preserve,
            });
        };

    for env_label in &profiles {
        let inv = provider.inventory_per_env.get(env_label);
        if let Some(entry) = inv.and_then(|i| i.bundled.as_ref()) {
            consider(
                &entry.path,
                entry.info.as_ref(),
                entry.info.as_ref().and_then(|i| i.cuda_architectures.clone()),
            );
        }
        if let Some(entry) = inv.and_then(|i| i.foundry.as_ref()) {
            consider(
                &entry.path,
                entry.info.as_ref(),
                entry.info.as_ref().and_then(|i| i.cuda_architectures.clone()),
            );
        }
        if let Some(entry) = inv.and_then(|i| i.catalog.as_ref()) {
            consider(
                &entry.path,
                entry.info.as_ref(),
                entry.info.as_ref().and_then(|i| i.cuda_architectures.clone()),
            );
        }
        if let Some(path) = provider.binary_path_per_env.get(env_label) {
            consider(
                path,
                provider.build_info_per_env.get(env_label),
                provider
                    .build_info_per_env
                    .get(env_label)
                    .and_then(|i| i.cuda_architectures.clone()),
            );
        }
    }

    if !to_probe.is_empty() {
        log::info!(
            "[refresh] {} — probing {} unique binary path(s) in parallel (catalog-style --version)",
            provider_id,
            to_probe.len()
        );
        let profile = build_profile.clone();
        let futs: Vec<_> = to_probe
            .into_iter()
            .map(|t| {
                let profile = profile.clone();
                async move {
                    let info =
                        probe_build_info_fresh(&t.path, &profile, t.preserve_cuda.clone()).await;
                    (t.key, t.path, info)
                }
            })
            .collect();
        let results = futures_util::future::join_all(futs).await;
        for (key, path, info) in results {
            if let Some(info) = info {
                log::info!(
                    "[refresh] {} — {} → {} built {}",
                    provider_id,
                    path,
                    info.version,
                    info.build_date
                );
                resolved.insert(key, info);
            }
        }
    }

    let lookup = |path: &str| -> Option<crate::types::BuildInfo> {
        let key = crate::config::resolve_path(path)
            .to_string_lossy()
            .to_string();
        resolved.get(&key).cloned()
    };

    for env_label in &profiles {
        if let Some(inv) = provider.inventory_per_env.get_mut(env_label) {
            if let Some(entry) = inv.bundled.as_mut() {
                if let Some(info) = lookup(&entry.path) {
                    let existing = entry.info.as_ref();
                    if existing
                        .map(|e| e.version != info.version || e.build_date != info.build_date)
                        .unwrap_or(true)
                    {
                        entry.info = Some(info);
                        changed = true;
                    }
                }
            }
            if let Some(entry) = inv.foundry.as_mut() {
                if let Some(info) = lookup(&entry.path) {
                    let existing = entry.info.as_ref();
                    if existing
                        .map(|e| e.version != info.version || e.build_date != info.build_date)
                        .unwrap_or(true)
                    {
                        entry.info = Some(info);
                        changed = true;
                    }
                }
            }
            if let Some(entry) = inv.catalog.as_mut() {
                if let Some(info) = lookup(&entry.path) {
                    let existing = entry.info.as_ref();
                    if existing
                        .map(|e| e.version != info.version || e.build_date != info.build_date)
                        .unwrap_or(true)
                    {
                        entry.info = Some(info);
                        changed = true;
                    }
                }
            }
        }
        if let Some(path) = provider.binary_path_per_env.get(env_label).cloned() {
            if let Some(info) = lookup(&path) {
                log::debug!(
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
                    if provider.binary_source_per_env.get(env_label).map(|s| s.as_str())
                        == Some(crate::profile_binaries::SOURCE_CATALOG)
                    {
                        if let Some(inv) = provider.inventory_per_env.get_mut(env_label) {
                            if let Some(entry) = inv.catalog.as_mut() {
                                entry.info = Some(info.clone());
                            }
                        }
                    }
                    provider.build_info_per_env.insert(env_label.clone(), info);
                    changed = true;
                }
            }
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
        // Central cleanup — every rollback path ends the output-console session so its buffer
        // is released instead of leaking until the next build.
        foundry_console_end_session(&app_handle, build_id);
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

#[tauri::command]
pub async fn foundry_check_toolchain() -> Result<Vec<foundry_toolchain::ProfileCheck>, String> {
    foundry_toolchain::check_all_profiles()
}

#[tauri::command]
pub async fn foundry_get_profiles() -> Result<Vec<foundry_toolchain::ProfileDef>, String> {
    let manifest = foundry_toolchain::load_manifest()?;
    Ok(manifest.profiles)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundryWorkCacheStatus {
    /// Always true — work cache retention is on for all builds (UI compatibility).
    pub cache_enabled: bool,
    pub profile_id: String,
    pub build_dir_exists: bool,
    pub cmake_cache_present: bool,
    /// Bytes under `work/build-{profile}/` (this profile only).
    pub size_bytes: u64,
    /// Human label e.g. `1.24 GiB`.
    pub size_label: String,
    /// Bytes under entire `work/` for this provider (all profiles).
    pub work_total_bytes: u64,
    pub work_total_label: String,
}

/// Confirm modal: warm/cold CMake tree + on-disk size for this provider/profile.
#[tauri::command]
pub async fn foundry_work_cache_status(
    provider_id: String,
    profile_id: String,
) -> Result<FoundryWorkCacheStatus, String> {
    let profile_id = foundry_toolchain::normalize_profile_id(&profile_id);
    let work_root = crate::config::foundry_work_dir(&provider_id);
    let build_dir = work_root.join(format!("build-{profile_id}"));
    let build_dir_for_size = build_dir.clone();
    let work_root_for_size = work_root.clone();
    let (size_bytes, work_total_bytes) = tokio::task::spawn_blocking(move || {
        (
            dir_size_bytes(&build_dir_for_size),
            dir_size_bytes(&work_root_for_size),
        )
    })
    .await
    .map_err(|e| format!("cache size task failed: {e}"))?;

    Ok(FoundryWorkCacheStatus {
        cache_enabled: foundry_keep_work_cache(),
        profile_id,
        build_dir_exists: build_dir.is_dir(),
        cmake_cache_present: build_dir.join("CMakeCache.txt").is_file(),
        size_bytes,
        size_label: format_bytes_label(size_bytes),
        work_total_bytes,
        work_total_label: format_bytes_label(work_total_bytes),
    })
}

/// Delete `foundry/engines/<provider>/work/` or one `build-{profile}/` subtree.
#[tauri::command]
pub async fn foundry_clear_work_cache(
    provider_id: String,
    profile_id: Option<String>,
) -> Result<(), String> {
    let work_root = crate::config::foundry_work_dir(&provider_id);
    if let Some(profile) = profile_id {
        let profile_id = foundry_toolchain::normalize_profile_id(&profile);
        let build_dir = work_root.join(format!("build-{profile_id}"));
        if build_dir.exists() {
            tokio::fs::remove_dir_all(&build_dir)
                .await
                .map_err(|e| format!("Failed to clear Foundry build cache: {e}"))?;
        }
    } else if work_root.exists() {
        tokio::fs::remove_dir_all(&work_root)
            .await
            .map_err(|e| format!("Failed to clear Foundry work directory: {e}"))?;
    }
    Ok(())
}

/// Fetch PR titles for HISTORY chip tooltips (confirm modal).
///
/// Calls the GitHub REST API via the Rust reqwest client (the browser `fetch` from the
/// Vite origin is CORS/UA-flaky in WebView2). Soft-fails per PR: a missing title is
/// simply omitted from the map, so one bad number never poisons the others.
#[tauri::command]
pub async fn foundry_pr_titles(
    owner_repo: String,
    pr_nums: Vec<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let mut titles = std::collections::HashMap::new();
    for pr_num in pr_nums {
        if pr_num.trim().is_empty() {
            continue;
        }
        let state = git::fetch_pr_merge_state(&owner_repo, &pr_num).await;
        if let Some(title) = state.title {
            if !title.trim().is_empty() {
                titles.insert(pr_num, title);
            }
        }
    }
    Ok(titles)
}
