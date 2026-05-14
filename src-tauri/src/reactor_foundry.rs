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
    Building,
    Validating,
    Complete,
    Failed(String),
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

        let mut stack = app.stack.lock().await;
        let stopped: Vec<usize> = stack.stop_slots_by_provider(&backend_type).await;
        if !stopped.is_empty() {
            emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::Initializing, 
                Some(format!("Stopping {} running engine(s) for '{}' before build...", stopped.len(), provider_id)));
        }
        stopped.len()
    };

    let work_dir = PathBuf::from(format!(r"C:\reactor_foundry\engines\{}", provider_id));
    let src_dir = work_dir.join("llama.cpp");
    let bin_release = src_dir.join("build").join("bin").join("Release");
    let bin_bak = work_dir.join("Release_bak");

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

    // ── Atomic Bin Prep ──────────────────────────────────────────────
    
    if bin_release.exists() {
        emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::Initializing, Some("Backing up existing binaries...".into()));
        
        if let Err(e) = tokio::fs::rename(&bin_release, &bin_bak).await {
            rollback_build(app_handle, &provider_id, env, build_id, &src_dir, &bin_release, &bin_bak).await;
            return Err(format!("Failed to backup existing binaries (file locked by running engine?): {}. Is an engine for '{}' still running?", e, provider_id));
        }
        
        if !bin_bak.exists() {
            rollback_build(app_handle, &provider_id, env, build_id, &src_dir, &bin_release, &bin_bak).await;
            return Err("Backup verification failed — Release_bak not found after revert.".into());
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

    let num_cpus = std::thread::available_parallelism()
        .map(|p| p.get().min(64).max(2))
        .unwrap_or(8);

    emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::CMakeConfigure, Some(format!(
        "[STAGE 1/3] CMAKE CONFIGURE — {} cores detected", num_cpus
    )));

    // ── PHASE 1: CMake Configure (stream output, wait for user approval) ──
    
    emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::CMakeConfigure, Some("[STAGE 1/3] CMAKE CONFIGURE — Reviewing flags below. Click PROCEED to start compilation.".into()));

    let forced_cuda_flags = format!(
        "-DCMAKE_CUDA_COMPILER=\"{}\" -DCUDAToolkit_ROOT=\"{}\"",
        env.nvcc_path().replace('\\', "/"),
        cuda_path.replace('\\', "/")
    );

    let joined_extra = if cmake_extra.is_empty() {
        String::new()
    } else {
        cmake_extra.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ")
    };
    let cmake_configure_line = if joined_extra.is_empty() {
        format!("cmake .. {}", forced_cuda_flags)
    } else {
        format!("cmake .. {} {}", forced_cuda_flags, joined_extra)
    };

    emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::CMakeConfigure, Some(format!(
        "cmake .. {}{}", forced_cuda_flags, if !joined_extra.is_empty() { format!(" {}", joined_extra) } else { String::new() }
    )));

    let cfg_batch_lines = vec![
        "@echo off".to_string(),
        format!("set \"CUDA_PATH={cuda_path}\""),
        format!("call \"{vs_devcmd}\" -arch=x64"),
        "if exist build rmdir /s /q build".to_string(),
        "mkdir build".to_string(),
        "cd /d build".to_string(),
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

    let cfg_status = child.wait().await.map_err(|e| format!("CMake configure failed: {}", e))?;
    
    stream_handle.await.ok();
    
    let _ = tokio::fs::remove_file(&cfg_batch_path).await;

    if !cfg_status.success() {
        let stderr_text: String = stderr_capture.lock().unwrap().join("\n");
        emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::Failed(if stderr_text.is_empty() { "CMake configure failed.".into() } else { format!("CMake configure failed:\n{}", stderr_text) }), None);
        
        // Clean up partial build artifacts and restore working binaries
        let _ = tokio::fs::remove_dir_all(&bin_release).await;
        if bin_bak.exists() {
            let _ = tokio::fs::rename(&bin_bak, &bin_release).await;
        }
        let build_dir = src_dir.join("build");
        if build_dir.exists() {
            let _ = tokio::fs::remove_dir_all(&build_dir).await;
        }

        *CURRENT_BUILD.lock().await = None;
        return Err("CMake configure failed. Check the log above for details.".to_string());
    }

    // ── Show cmake output summary and wait for user approval to build ──
    
    emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::Initializing, Some(format!(
        "═══════════════════════════════════════════════\nCMake configure complete. {} targets detected.\nReview the log above — click PROCEED to start compilation (may take 10+ minutes).\n═══════════════════════════════════════════════",
        if cmake_extra.is_empty() { "Default" } else { "Custom" }
    )));

    BUILD_CONFIRMED.store(false, Ordering::SeqCst);
    
    let timeout_dur = std::time::Duration::from_secs(600); // 10 min to review
    let start = std::time::Instant::now();
    while !BUILD_CONFIRMED.load(Ordering::SeqCst) {
        if start.elapsed() > timeout_dur {
            emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::Failed("Build cancelled: no confirmation within 10 minutes.".into()), None);
            *CURRENT_BUILD.lock().await = None;
            return Err("Build cancelled: user did not confirm.".to_string());
        }
        {
            let current = CURRENT_BUILD.lock().await;
            if current.is_none() {
                return Err("Build cancelled by user.".to_string());
            }
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
    }

    log::info!("User approved build, starting compilation...");

    // ── PHASE 2: CMake Build (after user approval) ──
    
    emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::Building, Some(format!(
        "[BUILD] Starting compilation with {} cores...", num_cpus
    )));

    let build_batch_lines = vec![
        "@echo off".to_string(),
        format!("set \"CUDA_PATH={cuda_path}\""),
        format!("call \"{vs_devcmd}\" -arch=x64"),
        "cd /d build".to_string(),
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

    let build_status = child2.wait().await.map_err(|e| format!("Build failed: {}", e))?;
    stream_handle2.await.ok();
    
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

        *CURRENT_BUILD.lock().await = None;
        return Err(format!("Build failed.\nSTDERR: {}", stderr_text));
    }

    // ── Integrity Validation ─────────────────────────────────────────
    
    emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::Validating, Some("[STAGE 3/3] VALIDATE — Checking core binaries...".into()));

    let core_binaries = ["llama-server.exe", "llama-cli.exe", "llama-quantize.exe"];
    
    // Search multiple possible output locations (cmake config varies by fork/version)
    let candidate_dirs: Vec<PathBuf> = vec![
        bin_release.clone(),
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

    // ── Success: Capture build info (version + CUDA from nvcc), purge backup and update binary path ─────────────────

    emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::Complete, Some("Build successful. Capturing version info...".into()));

    let cuda_version = {
        let nvcc_path = env.nvcc_path();
        if std::path::PathBuf::from(nvcc_path).exists() {
            match tokio::process::Command::new(nvcc_path)
                .args(&["--version"])
                .output()
                .await
            {
                Ok(output) => {
                    let raw = String::from_utf8_lossy(&output.stdout);
                    if let Some(caps) = regex::Regex::new(r"V(\d+\.\d+\.\d+)")
                        .ok()
                        .and_then(|re| re.captures(&raw))
                    {
                        caps.get(1).map(|m| m.as_str().to_string())
                    } else {
                        None
                    }
                }
                Err(_) => None,
            }
        } else {
            None
        }
    };

    let bin_path = found_bin_dir
        .as_ref()
        .map(|d| d.join("llama-server.exe").to_string_lossy().to_string())
        .unwrap_or_else(|| bin_release.join("llama-server.exe").to_string_lossy().to_string());
    if let Ok(build_info_raw) = crate::engine::get_binary_build_info(bin_path.clone()).await {
        // Override with actual CUDA version from nvcc used during this build
        let build_info = crate::types::BuildInfo {
            version: build_info_raw.version,
            build_date: build_info_raw.build_date,
            cuda_version,
        };

        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        let mut cfg_mut = cfg.clone();
        if let Some(provider) = cfg_mut.providers.iter_mut().find(|p| p.id == provider_id) {
            if provider.build_info_per_env.is_empty() {
                provider.build_info_per_env = std::collections::HashMap::new();
            }
            provider.build_info_per_env.insert("current".to_string(), build_info);
        }
        drop(cfg);
        crate::config::persist_provider_meta(&cfg_mut.providers).ok();
    }

    // Update binary path and persist
    {
        let mut cfg = app.config.lock().map_err(|e| e.to_string())?;

        if let Some(provider) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
            provider.binary_path = bin_release.join("llama-server.exe").to_string_lossy().to_string();
        }

        drop(cfg);
        let cfg_for_meta = app.config.lock().map_err(|e| e.to_string())?;
        let _ = crate::config::persist_provider_meta(&cfg_for_meta.providers);
    }

    if bin_bak.exists() {
        let _ = tokio::fs::remove_dir_all(&bin_bak).await;
    }

    emit_build_event(app_handle, &provider_id, env, build_id, BuildStep::Complete, Some("Foundry build complete.".into()));
    *CURRENT_BUILD.lock().await = None;

    Ok(())
}

#[tauri::command]
pub async fn foundry_cancel(
    _app: tauri::State<'_, crate::engine::AppContext>,
    _app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let app_handle = &_app_handle;
    let mut current = CURRENT_BUILD.lock().await;
    if let Some(state) = current.take() {
        emit_build_event(app_handle, &state.provider_id, state.environment, state.build_id, BuildStep::Failed("Build cancelled by user.".into()), None);
        Ok(())
    } else {
        Err("No build in progress to cancel.".to_string())
    }
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
        BuildStep::Building => "Building",
        BuildStep::Validating => "Validating",
        BuildStep::Complete => "Complete",
        BuildStep::Failed(_) => "Failed",
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
