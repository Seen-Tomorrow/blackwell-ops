//! Reactor Foundry — isolated build service for compiling llama.cpp providers.
//!
//! Each provider builds in C:/reactor_foundry/engines/[provider_id]/ with:
//! - Git clone/pull from configured URL + branch
//! - Environment-scrubbed CUDA toolchain (no version mixing)
//! - CMake configure + build via VS DevCmd environment
//! - Atomic bin directory swap with rollback protocol

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Mutex as TokioMutex;
use tauri::Emitter;

static BUILD_CONFIRMED: AtomicBool = AtomicBool::new(false);

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
            BuildEnv::Vanguard => &["v12.8", "v13.1"],  // exclude older, use v13.2 only
            BuildEnv::Stable => &["v13.1", "v13.2"],    // exclude newer, use v12.8 only
            BuildEnv::Fresh => &["v12.8", "v13.2"],     // exclude older/newer, use v13.1 only
        }
    }

    pub fn scrub_path(&self) -> String {
        let current_path = std::env::var("PATH").unwrap_or_default();
        let base = self.cuda_path(); // e.g. C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.2

        let mut filtered: Vec<String> = Vec::new();
        for entry in current_path.split(';') {
            let entry_lower = entry.to_lowercase();
            let is_cuda_toolkit = entry_lower.contains("nvidia gpu computing toolkit\\cuda\\");
            
            if !is_cuda_toolkit {
                filtered.push(entry.to_string());
            } else {
                // Extract version suffix (v12.8, v13.1, v13.2, etc.) from path
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

/// Track a child PID for cleanup on cancel.
fn track_pid(pid: u32) {
    CHILD_PIDS.lock().unwrap().push(pid);
}

/// Kill all tracked child processes (Windows taskkill /T /F).
fn kill_all_children() {
    let pids = {
        let mut guard = CHILD_PIDS.lock().unwrap();
        std::mem::take(&mut *guard)
    };
    for pid in pids {
        let _ = std::process::Command::new("taskkill")
            .args(&["/T", "/F", "/PID", &pid.to_string()])
            .status();
    }
}

/// Clear all tracked PIDs without killing (normal completion).
fn clear_pids() {
    CHILD_PIDS.lock().unwrap().clear();
}

/// Poll child with try_wait — returns None if cancelled, Some(status) on exit.
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
                // Process already gone or error — treat as done
                return None;
            }
        }
    }
}

/// Check if build was cancelled. Returns true if we should abort.
fn is_cancelled() -> bool {
    BUILD_CANCELLED.load(Ordering::SeqCst)
}

/// Extract PR number from various URL formats.
fn parse_github_pr(url: &str) -> Option<(String, String)> {
    let u = url.trim();
    if let Some(idx) = u.find("/pull/") {
        let before = &u[..idx];
        let after = &u[idx + 6..];
        let pr_num = after.split('/').next().unwrap_or(after).trim().to_string();
        // Extract owner/repo from path like "https://github.com/owner/repo"
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

// ── Build State ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BuildStep {
    Idle,
    Initializing,
    GitClone,
    GitPull,
    PrCherryPick,
    CMakeConfigure,
    /// CMake done — waiting for user PROCEED/ABORT confirmation
    WaitingForConfirm,
    Building,
    Validating,
    Complete,
    Failed(String),
    /// Binary locked — waiting for user to resolve (YES/PAUSE modal)
    BackupLocked(String), // provider display name
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildProgress {
    pub step: BuildStep,
    pub provider_id: String,
    pub environment: String,
    pub log_line: Option<String>,
}

// ── Global State ─────────────────────────────────────────────────────

static BUILD_LOCK: TokioMutex<()> = TokioMutex::const_new(());
static CURRENT_BUILD: std::sync::LazyLock<TokioMutex<Option<BuildState>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(None));

/// Atomic flag for BackupLocked resolution — set to true when user clicks YES.
static BACKUP_RESOLVED: AtomicBool = AtomicBool::new(false);

struct BuildState {
    build_id: u64,
    provider_id: String,
    environment: BuildEnv,
}

static BUILD_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

// ── Core Build Service ───────────────────────────────────────────────

#[tauri::command]
pub async fn foundry_build(
    provider_id: String,
    environment: String,
    pr_url: Option<String>,
    max_cores: Option<u32>,
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

    let _lock = BUILD_LOCK.lock().await;

    // Reset cancellation state for new build — ensures cancelled flag from previous run doesn't carry over
    BUILD_CANCELLED.store(false, Ordering::SeqCst);
    clear_pids();

    {
        let current = CURRENT_BUILD.lock().await;
        if current.is_some() {
            return Err("A build is already in progress. Wait for it to complete or cancel.".to_string());
        }
    }

    let build_id = BUILD_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;

    *CURRENT_BUILD.lock().await = Some(BuildState {
        build_id,
        provider_id: provider_id.clone(),
        environment: env,
    });

    emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::Initializing, None);

    let _stopped_count = {
        let backend_type: String = {
            let cfg = app.config.lock().map_err(|e| e.to_string())?;
            cfg.providers.iter()
                .find(|p| p.id == provider_id)
                .map(|p| p.id.clone())
                .unwrap_or_default()
        };

        let stack = app.stack.lock().await;
        let stopped: Vec<usize> = stack.stop_slots_by_provider(&backend_type).await;
        if !stopped.is_empty() {
            emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::Initializing, 
                Some(format!("Stopping {} running engine(s) for '{}' before build...", stopped.len(), provider_id)));
        }
        stopped.len()
    };

    let work_dir = PathBuf::from(format!(r"C:\reactor_foundry\engines\{}", provider_id));
    let src_dir = work_dir.join("llama.cpp");
    // Per-env build directory — each env (vanguard/stable/fresh) builds into its own isolated dir
    let build_dir = src_dir.join(format!("build-{}", env.env_label()));
    let bin_release = build_dir.join("bin").join("Release");
    // Per-env backup — persists after success for user restore
    let bin_bak = work_dir.join(format!("bin-{}-bak", env.env_label()));

    if let Err(e) = tokio::fs::create_dir_all(&work_dir).await {
        rollback_build(app_handle, &provider_id, env, build_id, &src_dir, &bin_release, &bin_bak).await;
        return Err(format!("Failed to create work directory: {}", e));
    }

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
        rollback_build(app_handle, &provider_id, env, build_id, &src_dir, &bin_release, &bin_bak).await;
        return Err(format!("Provider '{}' has no git_url configured.", provider_id));
    }

    let is_existing = src_dir.join(".git").exists();

    if !is_existing {
        emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::GitClone, Some("Cloning repository...".into()));
        
        if src_dir.exists() {
            let _ = tokio::fs::remove_dir_all(&src_dir).await;
        }
        
        let clone_output = tokio::process::Command::new("git")
            .args(["clone", "--depth", "1", "--recursive"])
            .arg(&*git_url)
            .arg("-b")
            .arg(branch)
            .arg(&src_dir)
            .current_dir(work_dir.parent().unwrap())
            .output()
            .await
            .map_err(|e| format!("Git clone failed: {}", e))?;

        if !clone_output.status.success() {
            let stderr = String::from_utf8_lossy(&clone_output.stderr).to_string();
            rollback_build(app_handle, &provider_id, env, build_id, &src_dir, &bin_release, &bin_bak).await;
            return Err(format!("Git clone failed: {}", stderr));
        }

        emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::GitClone, Some("Repository cloned.".into()));
    } else {
        emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::GitPull, Some("Pulling latest changes...".into()));
        
        let pull_output = tokio::process::Command::new("git")
            .args(["pull", "--recurse-submodules"])
            .current_dir(&src_dir)
            .output()
            .await
            .map_err(|e| format!("Git pull failed: {}", e))?;

        // Update submodules separately to avoid cmd escaping issues
        if pull_output.status.success() {
            let _ = tokio::process::Command::new("git")
                .args(["submodule", "update", "--init", "--recursive"])
                .current_dir(&src_dir)
                .output()
                .await;
        }

        if !pull_output.status.success() {
            let stderr = String::from_utf8_lossy(&pull_output.stderr).to_string();
            rollback_build(app_handle, &provider_id, env, build_id, &src_dir, &bin_release, &bin_bak).await;
            return Err(format!("Git pull failed: {}", stderr));
        }

        emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::GitPull, Some("Repository updated.".into()));
    }

    // ── PR Patch Apply (optional) ────────────────────────────────────
    if let Some(ref pr_url_str) = pr_url {
        match parse_github_pr(pr_url_str) {
            Some((owner_repo, pr_num)) => {
                emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::PrCherryPick,
                    Some(format!("[PR] Fetching PR #{} from {}...", pr_num, owner_repo)));

                // Download patch from GitHub's raw diff endpoint
                let patch_url = format!("https://patch-diff.githubusercontent.com/raw/{}/pull/{}.diff", owner_repo, pr_num);
                let patch_bytes = reqwest::get(&patch_url)
                    .await
                    .map_err(|e| format!("HTTP fetch failed: {}", e))?;

                if !patch_bytes.status().is_success() {
                    emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::PrCherryPick,
                        Some(format!("[WARN] PR #{} not found or inaccessible (HTTP {}) — continuing build", pr_num, patch_bytes.status())));
                } else {
                    let patch = String::from_utf8_lossy(&patch_bytes.bytes().await.unwrap_or_default()).to_string();

                    if patch.trim().is_empty() {
                        emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::PrCherryPick,
                            Some(format!("[PR] #{} already applied — no changes needed", pr_num)));
                    } else {
                        // Write patch to temp file and apply with 3-way merge
                        let patch_path = src_dir.parent().unwrap().join("pr-patch.diff");
                        if let Ok(()) = tokio::fs::write(&patch_path, &patch).await {
                            // Try plain apply first, fall back to --3way
                            let mut apply_output = tokio::process::Command::new("git")
                                .args(["apply", "--whitespace=nowarn", patch_path.to_str().unwrap()])
                                .current_dir(&src_dir)
                                .output()
                                .await;

                            if apply_output.as_ref().map_or(true, |o| !o.status.success()) {
                                apply_output = tokio::process::Command::new("git")
                                    .args(["apply", "--3way", "--whitespace=nowarn", patch_path.to_str().unwrap()])
                                    .current_dir(&src_dir)
                                    .output()
                                    .await;
                            }

                            // Cleanup temp file
                            let _ = tokio::fs::remove_file(&patch_path).await;

                            match apply_output {
                                Ok(ref out) if out.status.success() => {
                                    emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::PrCherryPick,
                                        Some(format!("[PR] #{} applied successfully", pr_num)));

                                    let env_key = match env {
                                        BuildEnv::Vanguard => "vanguard".to_string(),
                                        BuildEnv::Stable => "stable".to_string(),
                                        BuildEnv::Fresh => "fresh".to_string(),
                                    };
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
                                    emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::PrCherryPick,
                                        Some(format!("[WARN] PR #{} apply failed: {} — continuing build", pr_num, stderr)));
                                }
                            }
                        } else {
                            emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::PrCherryPick,
                                Some(format!("[WARN] PR #{} could not write patch file — continuing build", pr_num)));
                        }
                    }
                }
            }
            None => {
                emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::PrCherryPick,
                    Some(format!("[WARN] Invalid PR URL: '{}' — must be a full GitHub PR URL like https://github.com/owner/repo/pull/N", pr_url_str)));
            }
        }
    }

    // ── Atomic Bin Prep (with BackupLocked modal for locked binaries) ─

    let provider_display_name = {
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        cfg.providers.iter()
            .find(|p| p.id == provider_id)
            .map(|p| p.display_name.clone())
            .unwrap_or_else(|| provider_id.clone())
    };

    if bin_release.exists() {
        emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::Initializing, Some("Backing up existing binaries...".into()));

        // Try backup rename — if locked, show modal and wait for user action
        let mut backup_retries: u32 = 0;
        loop {
            match tokio::fs::rename(&bin_release, &bin_bak).await {
                Ok(()) => break,
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied && backup_retries < 1 => {
                    // Binary locked — emit BackupLocked step and wait for user action
                    BACKUP_RESOLVED.store(false, Ordering::SeqCst);
                    emit_build_event(app_handle, &provider_id, env, build_id,
                        BuildStep::BackupLocked(provider_display_name.clone()), None);

                    // Wait for user to click YES (stop engines + retry) or PAUSE (cancel)
                    let timeout = std::time::Duration::from_secs(600); // 10 min
                    let start = std::time::Instant::now();
                    while !BACKUP_RESOLVED.load(Ordering::SeqCst) {
                        if start.elapsed() > timeout {
                            emit_build_event(app_handle, &provider_id, env, build_id,
                                BuildStep::Failed("Build cancelled: no action on locked binary within 10 minutes.".into()), None);
                            *CURRENT_BUILD.lock().await = None;
                            return Err("Build cancelled: user did not resolve locked binary.".to_string());
                        }
                        {
                            let current = CURRENT_BUILD.lock().await;
                            if current.is_none() {
                                return Err("Build cancelled by user.".to_string());
                            }
                        }
                        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                    }

                    // User clicked YES — stop engines and retry
                    let stopped: Vec<usize> = {
                        let stack = app.stack.lock().await;
                        stack.stop_slots_by_provider(&provider_id).await
                    };
                    if !stopped.is_empty() {
                        emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::Initializing,
                            Some(format!("Stopped {} engine(s) for '{}'. Retrying backup...", stopped.len(), provider_display_name)));
                    }
                    tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
                    backup_retries += 1;
                    continue; // retry rename
                }
                Err(e) => {
                    rollback_build(app_handle, &provider_id, env, build_id, &src_dir, &bin_release, &bin_bak).await;
                    return Err(format!("Failed to backup existing binaries: {}. Is an engine for '{}' still running?", e, provider_display_name));
                }
            }
        }

        if !bin_bak.exists() {
            rollback_build(app_handle, &provider_id, env, build_id, &src_dir, &bin_release, &bin_bak).await;
            return Err("Backup verification failed — backup not found after rename.".into());
        }
    }

    // ── CMake Build Chain ────────────────────────────────────────────
    
    let template_type = resolve_template_type(&provider_id);
    
    let (vs_devcmd, cuda_path, cmake_extra) = {
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        let p = cfg.providers.iter()
            .find(|p| p.id == provider_id);
        let build_profile = p.map(|p| p.build_profile.clone()).unwrap_or_default();
        
        let extra = if !build_profile.trim().is_empty() {
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

    emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::CMakeConfigure, Some(format!(
        "[STAGE 1/3] CMAKE CONFIGURE — {} cores detected", num_cpus
    )));

    // ── PHASE 1: CMake Configure (stream output, wait for user approval) ──
    
    emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::CMakeConfigure, Some("[STAGE 1/3] CMAKE CONFIGURE — Reviewing flags below. Click PROCEED to start compilation.".into()));

    let cuda_ver_short = env.cuda_version_short(); // "13.1", "12.8", etc.
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

    // Build cmake command with pinned generator + toolset override + forced CUDA flags
    let gen_flag = env.cmake_generator();
    let cmake_configure_line = if joined_extra.is_empty() {
        format!("cmake .. {} {} {}", gen_flag, toolset_flag, forced_cuda_flags)
    } else {
        format!("cmake .. {} {} {} {}", gen_flag, toolset_flag, forced_cuda_flags, joined_extra)
    };

    emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::CMakeConfigure, Some(format!(
        "cmake .. {} {}{}{}", gen_flag, toolset_flag, forced_cuda_flags, if !joined_extra.is_empty() { format!(" {}", joined_extra) } else { String::new() }
    )));

    let cuda_path_forced = env.cuda_path();
    let nvcc_bin = format!("{}\\bin", cuda_path_forced);
    let versioned_var = env.cuda_versioned_var_name();
    let env_build_name = format!("build-{}", env.env_label());

    // Batch: clear CUDA vars → call VsDevCmd (sets MSVC) → strip non-target CUDA from PATH via PowerShell → hard override target CUDA → prepend target nvcc bin → cmake
    let cfg_batch_lines = vec![
        "@echo off".to_string(),
        "set \"CUDA_PATH=\"".to_string(),
        "set \"CUDA_PATH_V12_8=\"".to_string(),
        "set \"CUDA_PATH_V13_1=\"".to_string(),
        "set \"CUDA_PATH_V13_2=\"".to_string(),
        format!("call \"{vs_devcmd}\" -arch=amd64 -host_arch=amd64"),
        // Strip all CUDA toolkit entries from PATH using PowerShell, keeping MSVC additions intact
        format!("for /f \"usebackq delims=\" %%P in (`powershell -NoProfile -Command \"$p = $env:PATH -split ';' | Where-Object {{ $_.ToLower() -notlike '*nvidia gpu computing toolkit\\cuda*' }}; Write-Output ($p -join ';')\"`) do set \"CLEANPATH=%%P\""),
        "if defined CLEANPATH set \"PATH=%CLEANPATH%\"".to_string(),
        format!("set \"CUDA_PATH={cuda_path_forced}\""),
        format!("set \"{}={cuda_path_forced}\"", versioned_var),
        format!("set \"PATH={};%PATH%\"", nvcc_bin),
        format!("if exist {} rmdir /s /q {}", env_build_name, env_build_name),
        format!("mkdir {}", env_build_name),
        format!("cd /d {}", env_build_name),
        cmake_configure_line,
    ];
    let cfg_batch_content = cfg_batch_lines.join("\n");
    let cfg_batch_path = src_dir.join("_build_cfg.bat");
    if let Err(e) = tokio::fs::write(&cfg_batch_path, &cfg_batch_content).await {
        return Err(format!("Failed to write build script: {}", e));
    }

    let scrubbed_path = env.scrub_path();
    let mut cmd = tokio::process::Command::new("cmd");
    cmd.args(&["/c", cfg_batch_path.to_string_lossy().as_ref()])
        .current_dir(&src_dir)
        .env("PATH", &scrubbed_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Failed to start cmake: {}", e))?;
    
    // Track PID for cleanup on cancel
    if let Some(pid) = child.id() {
        track_pid(pid);
    }

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    use std::sync::{Arc, Mutex};
    let stderr_capture: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_capture_clone = stderr_capture.clone();

    let app_handle_cfg = app_handle.clone();
    let provider_id_cfg = provider_id.clone();
    let env_cfg = env;
    let build_id_cfg = build_id;

    let stream_handle = tauri::async_runtime::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        
        let stdout_reader = BufReader::new(stdout);
        let mut stdout_lines = stdout_reader.lines();
        while let Ok(Some(line)) = stdout_lines.next_line().await {
            if !line.trim().is_empty() {
                emit_build_event(&app_handle_cfg, &provider_id_cfg, env_cfg, build_id_cfg, BuildStep::CMakeConfigure, Some(line));
            }
        }

        let stderr_reader = BufReader::new(stderr);
        let mut stderr_lines = stderr_reader.lines();
        while let Ok(Some(line)) = stderr_lines.next_line().await {
            if !line.trim().is_empty() {
                emit_build_event(&app_handle_cfg, &provider_id_cfg, env_cfg, build_id_cfg, BuildStep::CMakeConfigure, Some(format!("[ERR] {}", line)));
                stderr_capture_clone.lock().unwrap().push(line);
            }
        }
    });

    // Cancellable wait — polls try_wait() and checks BUILD_CANCELLED flag each 100ms
    let cfg_status = match wait_child_cancellable(&mut child).await {
        Some(status) => Some(status),
        None => {
            // Cancelled during cmake configure — kill process, clean up, return
            let _ = child.kill().await;
            stream_handle.await.ok();
            clear_pids();
            let _ = tokio::fs::remove_file(&cfg_batch_path).await;
            return Err("Build cancelled by user.".to_string());
        }
    };

    stream_handle.await.ok();
    
    if cfg_status.is_none() {
        // Process exited abnormally but wasn't cancelled — treat as failure
        clear_pids();
        let _ = tokio::fs::remove_file(&cfg_batch_path).await;
        return Err("CMake configure process terminated unexpectedly.".to_string());
    }

    let cfg_status = cfg_status.unwrap();
    
    let _ = tokio::fs::remove_file(&cfg_batch_path).await;

    if !cfg_status.success() {
        let stderr_text: String = stderr_capture.lock().unwrap().join("\n");
        emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::Failed(if stderr_text.is_empty() { "CMake configure failed.".into() } else { format!("CMake configure failed:\n{}", stderr_text) }), None);

        // Clean up partial build artifacts and restore working binaries
        let _ = tokio::fs::remove_dir_all(&bin_release).await;
        if bin_bak.exists() {
            let _ = tokio::fs::rename(&bin_bak, &bin_release).await;
        }
        clear_pids();
        *CURRENT_BUILD.lock().await = None;
        return Err("CMake configure failed. Check the log above for details.".to_string());
    }

    // ── Check cancellation before showing PROCEED prompt ──
    if is_cancelled() {
        clear_pids();
        return Err("Build cancelled by user.".to_string());
    }

    // ── Show cmake output summary and wait for user approval to build ──
    
    emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::WaitingForConfirm, Some(format!(
        "[WAIT-CONFIRM] CMake configure complete. {} targets detected.\nReview the log above — click PROCEED to start compilation (may take 10+ minutes).",
        if cmake_extra.is_empty() { "Default" } else { "Custom" }
    )));

    BUILD_CONFIRMED.store(false, Ordering::SeqCst);
    
    let timeout_dur = std::time::Duration::from_secs(600); // 10 min to review
    let start = std::time::Instant::now();
    while !BUILD_CONFIRMED.load(Ordering::SeqCst) {
        if is_cancelled() || CURRENT_BUILD.lock().await.is_none() {
            // Cancelled during PROCEED wait — clean up cmake artifacts
            clear_pids();
            let _ = tokio::fs::remove_dir_all(&build_dir).await;
            return Err("Build cancelled by user.".to_string());
        }
        if start.elapsed() > timeout_dur {
            emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::Failed("Build cancelled: no confirmation within 10 minutes.".into()), None);
            *CURRENT_BUILD.lock().await = None;
            return Err("Build cancelled: user did not confirm.".to_string());
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
    }

    log::info!("User approved build, starting compilation...");

    // ── PHASE 2: CMake Build (after user approval) ──
    
    emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::Building, Some(format!(
        "[BUILD] Starting compilation with {} cores...", num_cpus
    )));

    let cuda_path_forced = env.cuda_path();
    let nvcc_bin = format!("{}\\bin", cuda_path_forced);
    let versioned_var = env.cuda_versioned_var_name();

    // Same isolation pattern: clear → VsDevCmd → hard override CUDA → strip non-target from PATH → prepend target → build
    let build_batch_lines = vec![
        "@echo off".to_string(),
        "set \"CUDA_PATH=\"".to_string(),
        "set \"CUDA_PATH_V12_8=\"".to_string(),
        "set \"CUDA_PATH_V13_1=\"".to_string(),
        "set \"CUDA_PATH_V13_2=\"".to_string(),
        format!("call \"{vs_devcmd}\" -arch=amd64 -host_arch=amd64"),
        // Strip all CUDA toolkit entries from PATH using PowerShell, keeping MSVC additions intact
        format!("for /f \"usebackq delims=\" %%P in (`powershell -NoProfile -Command \"$p = $env:PATH -split ';' | Where-Object {{ $_.ToLower() -notlike '*nvidia gpu computing toolkit\\cuda*' }}; Write-Output ($p -join ';')\"`) do set \"CLEANPATH=%%P\""),
        "if defined CLEANPATH set \"PATH=%CLEANPATH%\"".to_string(),
        format!("set \"CUDA_PATH={cuda_path_forced}\""),
        format!("set \"{}={cuda_path_forced}\"", versioned_var),
        format!("set \"PATH={};%PATH%\"", nvcc_bin),
        format!("cd /d {}", env_build_name),
        format!("cmake --build . --config Release -j {num_cpus}"),
    ];
    let build_batch_content = build_batch_lines.join("\n");
    let build_batch_path = src_dir.join("_build_run.bat");
    if let Err(e) = tokio::fs::write(&build_batch_path, &build_batch_content).await {
        return Err(format!("Failed to write build script: {}", e));
    }

    let mut cmd2 = tokio::process::Command::new("cmd");
    cmd2.args(&["/c", build_batch_path.to_string_lossy().as_ref()])
        .current_dir(&src_dir)
        .env("PATH", &scrubbed_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child2 = cmd2.spawn().map_err(|e| format!("Failed to start build: {}", e))?;
    
    // Track PID for cleanup on cancel
    if let Some(pid) = child2.id() {
        track_pid(pid);
    }

    let stdout2 = child2.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr2 = child2.stderr.take().ok_or("Failed to capture stderr")?;

    let stderr_capture2: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_capture_clone2 = stderr_capture2.clone();

    let app_handle_bld = app_handle.clone();
    let provider_id_bld = provider_id.clone();
    let env_bld = env;
    let build_id_bld = build_id;

    let stream_handle2 = tauri::async_runtime::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        
        let stdout_reader = BufReader::new(stdout2);
        let mut stdout_lines = stdout_reader.lines();
        while let Ok(Some(line)) = stdout_lines.next_line().await {
            if !line.trim().is_empty() {
                emit_build_event(&app_handle_bld, &provider_id_bld, env_bld, build_id_bld, BuildStep::Building, Some(line));
            }
        }

        let stderr_reader = BufReader::new(stderr2);
        let mut stderr_lines = stderr_reader.lines();
        while let Ok(Some(line)) = stderr_lines.next_line().await {
            if !line.trim().is_empty() {
                emit_build_event(&app_handle_bld, &provider_id_bld, env_bld, build_id_bld, BuildStep::Building, Some(format!("[ERR] {}", line)));
                stderr_capture_clone2.lock().unwrap().push(line);
            }
        }
    });

    // Cancellable wait — polls try_wait() and checks BUILD_CANCELLED flag each 100ms
    let build_status = match wait_child_cancellable(&mut child2).await {
        Some(status) => Some(status),
        None => {
            // Cancelled during build — kill process, clean up, return
            let _ = child2.kill().await;
            stream_handle2.await.ok();
            clear_pids();
            let _ = tokio::fs::remove_file(&build_batch_path).await;
            // Restore backup if available
            let _ = tokio::fs::remove_dir_all(&bin_release).await;
            if bin_bak.exists() {
                let _ = tokio::fs::rename(&bin_bak, &bin_release).await;
            }
            return Err("Build cancelled by user.".to_string());
        }
    };

    stream_handle2.await.ok();
    
    if build_status.is_none() {
        clear_pids();
        let _ = tokio::fs::remove_file(&build_batch_path).await;
        return Err("Build process terminated unexpectedly.".to_string());
    }

    let build_status = build_status.unwrap();
    let _ = tokio::fs::remove_file(&build_batch_path).await;

    if !build_status.success() {
        // ── Failure: Rollback ────────────────────────────────────────
        
        let stderr_text: String = stderr_capture2.lock().unwrap().join("\n");
        emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::Failed(if stderr_text.is_empty() { "Build failed.".into() } else { format!("Build failed:\n{}", stderr_text) }), None);
        
        // Remove partial/broken build output and restore working binaries
        let _ = tokio::fs::remove_dir_all(&bin_release).await;
        if bin_bak.exists() {
            let _ = tokio::fs::rename(&bin_bak, &bin_release).await;
        }
        let build_dir = src_dir.join("build");
        if build_dir.exists() {
            let _ = tokio::fs::remove_dir_all(&build_dir).await;
        }

        clear_pids();
        *CURRENT_BUILD.lock().await = None;
        return Err(format!("Build failed.\nSTDERR: {}", stderr_text));
    }

    // Build succeeded — clear tracked PIDs, no longer needed
    clear_pids();

    // ── Check cancellation before validation ──
    if is_cancelled() {
        return Err("Build cancelled by user.".to_string());
    }

    // ── Integrity Validation ─────────────────────────────────────────
    
    emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::Validating, Some("[STAGE 3/3] VALIDATE — Checking core binaries...".into()));

    let core_binaries = ["llama-server.exe", "llama-cli.exe", "llama-quantize.exe"];
    
    // Search multiple possible output locations (cmake config varies by fork/version)
    let candidate_dirs: Vec<PathBuf> = vec![
        bin_release.clone(),
        build_dir.join("bin").join("Release"),
        src_dir.join("bin").join("Release"),
        src_dir.join("build").join("Release"), // legacy path for migration
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
                    p.binary_path = found_dir.join("llama-server.exe").to_string_lossy().to_string();
                }
            }
            drop(cfg);
            crate::config::persist_provider_meta(&cfg_mut.providers).ok();
        }
    }

    if !all_present {
        emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::Failed(format!("Missing core binaries: {}", missing.join(", "))), None);
        
        // Remove incomplete output and restore working binaries
        let _ = tokio::fs::remove_dir_all(&bin_release).await;
        if bin_bak.exists() {
            let _ = tokio::fs::rename(&bin_bak, &bin_release).await;
        }
        // Nuke /build folder so next attempt starts fresh
        let build_dir = src_dir.join("build");
        if build_dir.exists() {
            let _ = tokio::fs::remove_dir_all(&build_dir).await;
        }

        *CURRENT_BUILD.lock().await = None;
        return Err(format!("Build completed but core binaries missing: {}", missing.join(", ")));
    }

    // ── Success: Capture build info + update per-env paths ────────────────

    emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::Complete, Some("Build successful. Capturing version info...".into()));

    // Clean build artifacts — keep only bin/Release, wipe everything else
    {
        let build_root = src_dir.join(&env_build_name);
        if let Ok(entries) = std::fs::read_dir(&build_root) {
            for entry in entries {
                if let Ok(e) = entry {
                    let path = e.path();
                    let file_name = path.file_name().and_then(|n| n.to_str());
                    // Keep only the "bin" directory, remove everything else (CMakeFiles, CMakeCache.txt, vcxproj files, etc.)
                    if file_name != Some("bin") {
                        if path.is_dir() {
                            let _ = tokio::fs::remove_dir_all(&path).await;
                        } else {
                            let _ = tokio::fs::remove_file(&path).await;
                        }
                    }
                }
            }
        }
    }

    let bin_path = found_bin_dir
        .as_ref()
        .map(|d| d.join("llama-server.exe").to_string_lossy().to_string())
        .unwrap_or_else(|| bin_release.join("llama-server.exe").to_string_lossy().to_string());

    // Capture build info from binary --version + mtime
    match crate::engine::get_binary_build_info(bin_path.clone()).await {
        Ok(build_info_raw) => {
            let env_label = env.env_label();
            log::info!("[foundry] Captured build info for provider '{}' env '{}': {} built {}",
                provider_id, env_label, build_info_raw.version, build_info_raw.build_date);

            // Update in-memory config directly through the lock — no cloning
            let mut cfg = app.config.lock().map_err(|e| e.to_string())?;
            if let Some(provider) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
                if provider.build_info_per_env.is_empty() {
                    provider.build_info_per_env = std::collections::HashMap::new();
                }
                if provider.binary_path_per_env.is_empty() {
                    provider.binary_path_per_env = std::collections::HashMap::new();
                }
                let build_info = crate::types::BuildInfo {
                    version: build_info_raw.version,
                    build_date: build_info_raw.build_date,
                    cuda_version: None,
                };
                provider.build_info_per_env.insert(env_label.to_string(), build_info.clone());
                provider.build_info_per_env.insert("current".to_string(), build_info);
                let final_bin_path = bin_path.clone();
                provider.binary_path_per_env.insert(env_label.to_string(), final_bin_path);
            }
            drop(cfg);
            crate::config::persist_provider_meta(&app.config.lock().map_err(|e| e.to_string())?.providers).ok();
        }
        Err(e) => {
            log::warn!("[foundry] Failed to capture build info for provider '{}': {}", provider_id, e);
        }
    }

    // Update main binary_path (fallback) — single lock + persist cycle
    {
        let mut cfg = app.config.lock().map_err(|e| e.to_string())?;
        if let Some(provider) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
            provider.binary_path = bin_release.join("llama-server.exe").to_string_lossy().to_string();
        }
        drop(cfg);
        crate::config::persist_provider_meta(&app.config.lock().map_err(|e| e.to_string())?.providers).ok();
    }

    // NOTE: bin_bak is NOT deleted — kept for user restore via ↻ RESTORE button

    emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::Complete, Some("Foundry build complete.".into()));
    *CURRENT_BUILD.lock().await = None;

    Ok(())
}

#[tauri::command]
pub async fn foundry_cancel(
    _app: tauri::State<'_, crate::engine::AppContext>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // Set cancellation flag — all poll loops will detect this and abort
    BUILD_CANCELLED.store(true, Ordering::SeqCst);

    // Reset confirmation flags so they don't carry over to next build
    BUILD_CONFIRMED.store(false, Ordering::SeqCst);
    BACKUP_RESOLVED.store(false, Ordering::SeqCst);

    // Kill all tracked child processes (cmd.exe trees for cmake/build)
    kill_all_children();

    // Clear state and emit Failed event — always do this regardless of whether build was active
    let mut current = CURRENT_BUILD.lock().await;
    if let Some(state) = current.take() {
        emit_build_event(&app_handle, &state.provider_id, state.environment, state.build_id,
            BuildStep::Failed("Build cancelled by user.".into()), None);
    }

    Ok(()) // Always succeed — never return error to frontend
}

#[tauri::command]
pub async fn foundry_status() -> Result<Option<BuildProgress>, String> {
    let current = CURRENT_BUILD.lock().await;
    Ok(current.as_ref().map(|state| BuildProgress {
        step: BuildStep::Idle,
        provider_id: state.provider_id.clone(),
        environment: state.environment.label().to_string(),
        log_line: None,
    }))
}

#[tauri::command]
pub async fn foundry_confirm_build() -> Result<(), String> {
    BUILD_CONFIRMED.store(true, Ordering::SeqCst);
    Ok(())
}

/// Resume backup after user clicks YES on BackupLocked modal.
#[tauri::command]
pub async fn foundry_resume_backup() -> Result<(), String> {
    BACKUP_RESOLVED.store(true, Ordering::SeqCst);
    Ok(())
}

/// Refresh build info for all envs of a provider — called when FoundryPage mounts or after build completes.
/// Returns ALL foundry-capable providers with fresh build info so frontend can update its state.
#[tauri::command]
pub async fn refresh_build_info(
    provider_id: String,
    app: tauri::State<'_, crate::engine::AppContext>,
) -> Result<Vec<crate::types::ProviderConfig>, String> {
    // Clone provider data out of lock — no Send issue across awaits
    let prov = {
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        match cfg.providers.iter().find(|p| p.id == provider_id).cloned() {
            Some(p) => p,
            None => return Err(format!("Provider '{}' not found", provider_id)),
        }
    };

    // Migration: if per-env paths are empty but old binary exists, copy to vanguard
    let prov = {
        if prov.binary_path_per_env.is_empty() && !prov.binary_path.is_empty() {
            let work_dir = PathBuf::from(format!(r"C:\reactor_foundry\engines\{}", provider_id));
            let src_dir = work_dir.join("llama.cpp");
            let old_build_dir = src_dir.join("build");
            if old_build_dir.exists() {
                let new_build_dir = src_dir.join("build-vanguard");
                if !new_build_dir.exists() && old_build_dir.join("bin").exists() {
                    log::info!("[migration] Migrating '{}' from build/ to build-vanguard/", provider_id);
                    let _ = tokio::fs::create_dir_all(&new_build_dir).await;
                    if tokio::fs::rename(&old_build_dir, &new_build_dir).await.is_ok() {
                        let new_bin = new_build_dir.join("bin").join("Release");
                        if new_bin.exists() {
                            let mut cfg = app.config.lock().map_err(|e| e.to_string())?;
                            if let Some(p) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
                                if p.binary_path_per_env.is_empty() {
                                    p.binary_path_per_env = std::collections::HashMap::new();
                                }
                                p.binary_path_per_env.insert("vanguard".to_string(),
                                    new_bin.join("llama-server.exe").to_string_lossy().to_string());
                                p.binary_path = new_bin.join("llama-server.exe").to_string_lossy().to_string();
                            }
                            drop(cfg);
                            crate::config::persist_provider_meta(&app.config.lock().map_err(|e| e.to_string())?.providers).ok();
                        }
                    } else {
                        log::warn!("[migration] Failed to rename build/ for '{}'", provider_id);
                    }
                }
            }
        }
        // Re-read from config after possible migration to get updated paths
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        cfg.providers.iter().find(|p| p.id == provider_id).cloned()
            .unwrap_or_else(|| prov)
    };

    // Refresh build info for each env that has a binary — scan binaries and WRITE back to config
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

    // Write refreshed build info back into in-memory config + persist to disk
    if !updated_info.is_empty() {
        let mut cfg = app.config.lock().map_err(|e| e.to_string())?;
        if let Some(p) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
            for (env_label, info) in &updated_info {
                p.build_info_per_env.insert(env_label.clone(), info.clone());
            }
            // Also set "current" to the last refreshed env's build info
            if let Some(latest) = updated_info.last() {
                p.build_info_per_env.insert("current".to_string(), latest.1.clone());
            }
        }
        drop(cfg);
        crate::config::persist_provider_meta(&app.config.lock().map_err(|e| e.to_string())?.providers).ok();
    }

    // Return ALL providers with fresh config data so frontend can update its state (no dropped providers)
    let cfg = app.config.lock().map_err(|e| e.to_string())?;
    Ok(cfg.providers.clone())
}

/// Restore a previous build from backup for a specific env.
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

    // Check if any engine is running for this provider — stop it first
    {
        let stack = app.stack.lock().await;
        let stopped = stack.stop_slots_by_provider(&provider_id).await;
        if !stopped.is_empty() {
            log::info!("[restore] Stopped {} engine(s) before restore", stopped.len());
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
    }

    let work_dir = PathBuf::from(format!(r"C:\reactor_foundry\engines\{}", provider_id));
    let src_dir = work_dir.join("llama.cpp");
    let build_dir = src_dir.join(format!("build-{}", env_label));
    let bin_release = build_dir.join("bin").join("Release");
    let bin_bak = work_dir.join(format!("bin-{}-bak", env_label));

    if !bin_bak.exists() {
        return Err(format!("No backup found for '{}' ({})", provider_id, env_label));
    }

    // Remove current build output and restore from backup
    if bin_release.exists() {
        tokio::fs::remove_dir_all(&bin_release).await
            .map_err(|e| format!("Failed to remove current binaries: {}", e))?;
    }
    tokio::fs::rename(&bin_bak, &bin_release)
        .await
        .map_err(|e| format!("Failed to restore backup: {}", e))?;

    // Refresh build info from restored binary — write through lock, not clone
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
            crate::config::persist_provider_meta(&app.config.lock().map_err(|e| e.to_string())?.providers).ok();
        }
    }

    log::info!("[restore] Restored '{}' from {} backup", provider_id, env_label);
    Ok(())
}

// ── Helpers ──────────────────────────────────────────────────────────

fn emit_build_event(
    app_handle: &tauri::AppHandle,
    provider_id: &str,
    env: BuildEnv,
    build_id: u64,
    step: BuildStep,
    log_line: Option<String>,
) {
    let step_name = match &step {
        BuildStep::Idle => "Idle",
        BuildStep::Initializing => "Initializing",
        BuildStep::GitClone => "GitClone",
        BuildStep::GitPull => "GitPull",
        BuildStep::PrCherryPick => "PrCherryPick",
        BuildStep::CMakeConfigure => "CMakeConfigure",
        BuildStep::WaitingForConfirm => "WaitingForConfirm",
        BuildStep::Building => "Building",
        BuildStep::Validating => "Validating",
        BuildStep::Complete => "Complete",
        BuildStep::Failed(_) => "Failed",
        BuildStep::BackupLocked(_) => "BackupLocked",
    };

    let progress = serde_json::json!({
        "build_id": build_id,
        "step": step_name,
        "provider_id": provider_id,
        "environment": env.label(),
        "log_line": log_line,
    });

    if let Err(e) = app_handle.emit("foundry-build-progress", &progress) {
        log::debug!("Failed to emit foundry-build-progress: {}", e);
    }

    match step {
        BuildStep::Initializing => {
            let _ = app_handle.emit("foundry-toast", &serde_json::json!({
                "type": "info",
                "text": format!("Foundry Active: Compiling {} Kernels...", env.label()),
            }));
        }
        BuildStep::Complete => {
            let _ = app_handle.emit("foundry-toast", &serde_json::json!({
                "type": "success",
                "text": format!("Build complete for {}", provider_id),
            }));
        }
        BuildStep::Failed(_) => {
            let _ = app_handle.emit("foundry-toast", &serde_json::json!({
                "type": "error",
                "text": format!("Build failed for {}", provider_id),
            }));
        }
        BuildStep::BackupLocked(name) => {
            let _ = app_handle.emit("foundry-toast", &serde_json::json!({
                "type": "warning",
                "text": format!("Binary locked: {} — waiting for user action", name),
            }));
        }
        _ => {}
    }
}

async fn rollback_build(
    app_handle: &tauri::AppHandle,
    provider_id: &str,
    env: BuildEnv,
    build_id: u64,
    _src_dir: &PathBuf,
    bin_release: &PathBuf,
    bin_bak: &PathBuf,
) {
    if bin_bak.exists() && bin_release.exists() {
        let _ = tokio::fs::remove_dir_all(bin_release).await;
        let _ = tokio::fs::rename(bin_bak, bin_release).await;
    }

    emit_build_event(app_handle, provider_id, env, build_id, BuildStep::Failed("Build setup failed.".into()), None);
    *CURRENT_BUILD.lock().await = None;
}
