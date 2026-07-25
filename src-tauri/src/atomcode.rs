//! AtomCode external coding harness — app-owned tool (not an engine).
//!
//! Isolated install under `runtime/tools/atomcode/` + `config/atomcode-home/`.
//! Never uses the user's PATH or `%LOCALAPPDATA%\AtomCode` / `~\.atomcode`.
//! Launch is always a detached external console.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Pinned release we last verified against local OpenAI-compatible engines.
pub const PINNED_VERSION: &str = "v5.0.2";

const RELEASE_BASE: &str =
    "https://atomgit.com/atomgit_atomcode/atomcode/releases/download";

// ── Paths ──────────────────────────────────────────────────────────────

fn tools_dir() -> PathBuf {
    crate::config::app_root_dir()
        .join("runtime")
        .join("tools")
        .join("atomcode")
}

pub fn exe_path() -> PathBuf {
    tools_dir().join("atomcode.exe")
}

pub fn home_dir() -> PathBuf {
    crate::config::config_dir().join("atomcode-home")
}

fn version_stamp_path() -> PathBuf {
    tools_dir().join("version.txt")
}

fn disclaimer_path() -> PathBuf {
    home_dir().join(".disclaimer_accepted")
}

fn last_project_path() -> PathBuf {
    home_dir().join("last_project.txt")
}

// ── Status ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AtomcodeStatus {
    pub installed: bool,
    pub exe_path: String,
    pub home_path: String,
    pub version: Option<String>,
    pub pinned_version: String,
    pub disclaimer_accepted: bool,
    pub last_project: Option<String>,
}

fn read_version_stamp() -> Option<String> {
    std::fs::read_to_string(version_stamp_path())
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn probe_exe_version(exe: &Path) -> Option<String> {
    let out = std::process::Command::new(exe)
        .arg("--version")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let line = s.lines().next()?.trim();
    if line.is_empty() {
        None
    } else {
        Some(line.to_string())
    }
}

#[tauri::command]
pub async fn atomcode_status() -> Result<AtomcodeStatus, String> {
    let exe = exe_path();
    let home = home_dir();
    let installed = exe.is_file();
    let version = if installed {
        read_version_stamp().or_else(|| probe_exe_version(&exe))
    } else {
        None
    };
    let last_project = std::fs::read_to_string(last_project_path())
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Ok(AtomcodeStatus {
        installed,
        exe_path: exe.to_string_lossy().to_string(),
        home_path: home.to_string_lossy().to_string(),
        version,
        pinned_version: PINNED_VERSION.to_string(),
        disclaimer_accepted: disclaimer_path().is_file(),
        last_project,
    })
}

#[tauri::command]
pub async fn atomcode_accept_disclaimer() -> Result<(), String> {
    std::fs::create_dir_all(home_dir()).map_err(|e| format!("atomcode home: {e}"))?;
    std::fs::write(
        disclaimer_path(),
        format!(
            "accepted_at_unix={}\npinned={}\n",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            PINNED_VERSION
        ),
    )
    .map_err(|e| format!("disclaimer: {e}"))
}

#[tauri::command]
pub async fn atomcode_set_project(project_dir: String) -> Result<AtomcodeStatus, String> {
    let project = PathBuf::from(project_dir.trim());
    if project_dir.trim().is_empty() {
        return Err("Project directory is empty.".into());
    }
    if !project.is_dir() {
        return Err(format!("Not a directory: {}", project.display()));
    }
    std::fs::create_dir_all(home_dir()).map_err(|e| format!("home: {e}"))?;
    std::fs::write(
        last_project_path(),
        format!("{}\n", project.to_string_lossy()),
    )
    .map_err(|e| format!("save project: {e}"))?;
    atomcode_status().await
}

// ── Install ────────────────────────────────────────────────────────────

fn windows_arch_tag() -> Result<&'static str, String> {
    // Match install.ps1: PROCESSOR_ARCHITEW6432 when 32-bit process on 64-bit OS.
    let arch = std::env::var("PROCESSOR_ARCHITEW6432")
        .or_else(|_| std::env::var("PROCESSOR_ARCHITECTURE"))
        .unwrap_or_else(|_| "AMD64".into());
    match arch.to_uppercase().as_str() {
        "AMD64" | "X86_64" => Ok("x64"),
        "ARM64" => Ok("arm64"),
        other => Err(format!("Unsupported architecture for AtomCode: {other}")),
    }
}

fn release_download_url(version: &str, arch: &str) -> String {
    // e.g. atomcode-v5.0.2-windows-x64.exe
    format!("{RELEASE_BASE}/{version}/atomcode-{version}-windows-{arch}.exe")
}

#[tauri::command]
pub async fn atomcode_install(
    app: tauri::AppHandle,
    version: Option<String>,
) -> Result<AtomcodeStatus, String> {
    #[cfg(not(windows))]
    {
        let _ = (app, version);
        return Err("AtomCode tool install is only supported on Windows.".into());
    }

    #[cfg(windows)]
    {
        if !disclaimer_path().is_file() {
            return Err(
                "Accept the AtomCode disclaimer first (atomcode_accept_disclaimer).".into(),
            );
        }

        let ver = version
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(PINNED_VERSION)
            .to_string();
        let arch = windows_arch_tag()?;
        let url = release_download_url(&ver, arch);
        let dir = tools_dir();
        std::fs::create_dir_all(&dir).map_err(|e| format!("create tools dir: {e}"))?;
        std::fs::create_dir_all(home_dir()).map_err(|e| format!("create home: {e}"))?;

        emit_dbg(&format!("[AtomCode] Downloading {ver} ({arch})…"));
        emit_dbg(&format!("[AtomCode] {url}"));

        let tmp = dir.join("atomcode.download.exe");
        let dest = exe_path();

        download_file(&url, &tmp).await?;

        // Sanity: PE MZ header
        let header = std::fs::read(&tmp).map_err(|e| format!("read download: {e}"))?;
        if header.len() < 2 || header[0] != b'M' || header[1] != b'Z' {
            let _ = std::fs::remove_file(&tmp);
            return Err(
                "Download does not look like a Windows PE (expected MZ header).".into(),
            );
        }

        if dest.exists() {
            std::fs::remove_file(&dest).map_err(|e| {
                format!(
                    "Cannot replace {}: {e}. Close any running AtomCode from Blackwell and retry.",
                    dest.display()
                )
            })?;
        }
        if let Err(e) = std::fs::rename(&tmp, &dest) {
            std::fs::copy(&tmp, &dest).map_err(|e2| {
                format!("install move/copy failed: {e} / {e2}")
            })?;
            let _ = std::fs::remove_file(&tmp);
        }

        std::fs::write(version_stamp_path(), format!("{ver}\n"))
            .map_err(|e| format!("version stamp: {e}"))?;

        // Seed default telemetry-off / no auto-update into isolated home if absent.
        ensure_base_home_config()?;

        let _ = app;
        emit_dbg(&format!("[AtomCode] Installed → {}", dest.display()));

        atomcode_status().await
    }
}

fn emit_dbg(line: &str) {
    crate::output_console::emit_blackwell_output_console_debug_line(line);
}

async fn download_file(url: &str, dest: &Path) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("download request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "download HTTP {} for {url}",
            resp.status()
        ));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("download body: {e}"))?;

    if bytes.len() < 1_000_000 {
        // AtomCode is ~30MB; tiny body is almost certainly an HTML error page.
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(200)]);
        if head.trim_start().starts_with('<') {
            return Err(format!(
                "download looks like HTML, not a binary (release may be missing). URL: {url}"
            ));
        }
    }

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create parent: {e}"))?;
    }
    std::fs::write(dest, &bytes).map_err(|e| format!("write download: {e}"))?;
    Ok(())
}

fn ensure_base_home_config() -> Result<(), String> {
    let home = home_dir();
    std::fs::create_dir_all(&home).map_err(|e| format!("home: {e}"))?;
    let cfg = home.join("config.toml");
    if !cfg.is_file() {
        std::fs::write(
            &cfg,
            r#"# Blackwell Ops managed AtomCode home — do not share with ~/.atomcode
auto_update = false
auto_commit = false
"#,
        )
        .map_err(|e| format!("seed config: {e}"))?;
    }
    Ok(())
}

// ── Launch ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtomcodeEngineRef {
    pub port: u16,
    /// OpenAI model id — must match what the engine reports (launch alias).
    pub model: String,
    #[serde(default)]
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtomcodeLaunchRequest {
    /// `solo` | `brain_workers`
    pub mode: String,
    /// Solo engine, or BRAIN when mode is brain_workers.
    pub primary: AtomcodeEngineRef,
    /// WORKER engine (required for brain_workers).
    pub worker: Option<AtomcodeEngineRef>,
    /// Subagent concurrency (1 = effectively solo agents).
    #[serde(default = "default_concurrent")]
    pub max_concurrent: u32,
    /// Project directory (-C). Required.
    pub project_dir: String,
}

fn default_concurrent() -> u32 {
    4
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AtomcodeLaunchResult {
    pub exe_path: String,
    pub config_path: String,
    pub project_dir: String,
    pub mode: String,
}

fn toml_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// OpenAI `model` id must match what llama-server reports (engine alias at launch).
/// Never invent display names here — that causes AtomCode "routing mismatch".
fn openai_model_id(raw: &str) -> String {
    let s = raw.trim();
    if s.is_empty() {
        "local-model".into()
    } else {
        s.to_string()
    }
}

/// Provider table keys shown in AtomCode (not the OpenAI model id).
const PROVIDER_SOLO: &str = "Blackwell_Ops_local_AI";
const PROVIDER_BRAIN: &str = "Blackwell_Ops_local_AI_brain";
const PROVIDER_WORKER: &str = "Blackwell_Ops_local_AI_worker";

fn build_config_toml(req: &AtomcodeLaunchRequest) -> Result<String, String> {
    let mode = req.mode.trim().to_lowercase();
    // Honor Agents slider (Solo×1 … Army×32). Do not floor dual at 4 — that capped x8/x16.
    let concurrent = req.max_concurrent.clamp(1, 32);
    let primary_ctx = req.primary.context_window.unwrap_or(262_144);
    let primary_url = format!("http://127.0.0.1:{}/v1", req.primary.port);
    let primary_model = openai_model_id(&req.primary.model);

    if req.primary.port == 0 {
        return Err("Primary engine port is 0.".into());
    }

    match mode.as_str() {
        "solo" => {
            let sub_enabled = concurrent > 1;
            Ok(format!(
                r#"# Generated by Blackwell Ops — isolated AtomCode home
# Do not merge with a personal ~/.atomcode install.
# `model` MUST equal the engine alias (what /v1/models reports). Set alias at launch.
default_provider = "{prov}"
auto_update = false
auto_commit = false

[providers.{prov}]
type = "openai"
model = "{model}"
base_url = "{url}"
api_key = "blackwell"
context_window = {ctx}
capable_model = 2

[subagent]
enabled = {sub}
provider = "{prov}"
initial_turns = 4
max_turns = 12
max_concurrent = {n}
timeout_secs = 600

[lsp]
enabled = false
"#,
                prov = PROVIDER_SOLO,
                model = toml_escape(&primary_model),
                url = toml_escape(&primary_url),
                ctx = primary_ctx,
                sub = if sub_enabled { "true" } else { "false" },
                n = concurrent,
            ))
        }
        "brain_workers" | "brain+workers" | "dual" => {
            let worker = req
                .worker
                .as_ref()
                .ok_or_else(|| "brain_workers mode requires a worker engine.".to_string())?;
            if worker.port == 0 {
                return Err("Worker engine port is 0.".into());
            }
            if worker.port == req.primary.port {
                return Err("Brain and worker must use different ports.".into());
            }
            let worker_model = openai_model_id(&worker.model);
            let w_ctx = worker.context_window.unwrap_or(131_072);
            let w_url = format!("http://127.0.0.1:{}/v1", worker.port);
            // Role routing = which base_url is default vs subagent provider.
            // `model` is only the live OpenAI id (engine alias) — ENGINE-0 is fine.
            let n = concurrent;

            Ok(format!(
                r#"# Generated by Blackwell Ops — dual-engine stack (attach mode)
# BRAIN = default_provider → primary port. WORKER = subagent.provider → worker port.
# Aliases need not be the words BRAIN/WORKER; they must match each server's --alias.
default_provider = "{brain_prov}"
auto_update = false
auto_commit = false

[providers.{brain_prov}]
type = "openai"
model = "{brain_model}"
base_url = "{brain_url}"
api_key = "blackwell"
context_window = {brain_ctx}
capable_model = 2

[providers.{worker_prov}]
type = "openai"
model = "{worker_model}"
base_url = "{worker_url}"
api_key = "blackwell"
context_window = {worker_ctx}
capable_model = 1

[subagent]
enabled = true
provider = "{worker_prov}"
initial_turns = 4
max_turns = 24
max_concurrent = {n}
timeout_secs = 600

[lsp]
enabled = false
"#,
                brain_prov = PROVIDER_BRAIN,
                worker_prov = PROVIDER_WORKER,
                brain_model = toml_escape(&primary_model),
                brain_url = toml_escape(&primary_url),
                brain_ctx = primary_ctx,
                worker_model = toml_escape(&worker_model),
                worker_url = toml_escape(&w_url),
                worker_ctx = w_ctx,
                n = n,
            ))
        }
        other => Err(format!("Unknown AtomCode launch mode: {other}")),
    }
}

#[tauri::command]
pub async fn atomcode_launch(
    app: tauri::AppHandle,
    request: AtomcodeLaunchRequest,
) -> Result<AtomcodeLaunchResult, String> {
    #[cfg(not(windows))]
    {
        let _ = (app, request);
        return Err("AtomCode launch is only supported on Windows.".into());
    }

    #[cfg(windows)]
    {
        if !disclaimer_path().is_file() {
            return Err("Accept the AtomCode disclaimer first.".into());
        }
        let exe = exe_path();
        if !exe.is_file() {
            return Err(
                "AtomCode is not installed in the app tools folder. Install it first.".into(),
            );
        }

        let project = PathBuf::from(request.project_dir.trim());
        if request.project_dir.trim().is_empty() {
            return Err("Project directory is required.".into());
        }
        if !project.is_dir() {
            return Err(format!(
                "Project directory does not exist: {}",
                project.display()
            ));
        }

        let home = home_dir();
        std::fs::create_dir_all(&home).map_err(|e| format!("home: {e}"))?;
        ensure_base_home_config()?;

        let toml = build_config_toml(&request)?;
        let cfg_path = home.join("launch-config.toml");
        std::fs::write(&cfg_path, toml).map_err(|e| format!("write config: {e}"))?;

        let _ = std::fs::write(
            last_project_path(),
            format!("{}\n", project.to_string_lossy()),
        );

        // Seed operational directive once — never rewrite (user/harness may own it).
        // Role routing lives in launch-config.toml (default_provider vs subagent.provider), not here.
        let directive = home.join("ATOMCODE.md");
        if !directive.is_file() {
            let _ = std::fs::write(
                &directive,
                r#"# Blackwell Ops — AtomCode operational notes

You are the BRAIN layer on the default provider. Workers (if enabled) use the subagent provider.

- Local hardware: prefer wall-clock speed over token thrift.
- Parallelize independent file/search/edit scopes via subagents when available.
- Non-overlapping write scopes; review worker diffs before continuing.
- Verify with cargo check / tsc / tests after edits.
- Stop after 3 fruitless search rounds and report what you checked.

Provider URLs and OpenAI model ids are injected each launch by Blackwell Ops.
"#,
            );
        }

        spawn_atomcode_console(&exe, &home, &cfg_path, &project)?;

        let mode = request.mode.trim().to_lowercase();
        let _ = app;
        emit_dbg(&format!(
            "[AtomCode] Launched ({mode}) project={} config={}",
            project.display(),
            cfg_path.display()
        ));

        Ok(AtomcodeLaunchResult {
            exe_path: exe.to_string_lossy().to_string(),
            config_path: cfg_path.to_string_lossy().to_string(),
            project_dir: project.to_string_lossy().to_string(),
            mode,
        })
    }
}

#[cfg(windows)]
fn spawn_atomcode_console(
    exe: &Path,
    home: &Path,
    config: &Path,
    project: &Path,
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // PowerShell single-quoted literals: double embedded quotes.
    let q = |s: &str| s.replace('\'', "''");
    let exe_s = q(&exe.to_string_lossy());
    let home_s = q(&home.to_string_lossy());
    let cfg_s = q(&config.to_string_lossy());
    let proj_s = q(&project.to_string_lossy());

    // Visible external console; env isolates state from the user's global AtomCode.
    // Never --dangerously-skip-permissions. --dev disables auto-update apply.
    let ps = format!(
        "$env:ATOMCODE_HOME='{home_s}'; \
         Start-Process -FilePath '{exe_s}' \
           -WorkingDirectory '{proj_s}' \
           -ArgumentList @( \
             '--config', '{cfg_s}', \
             '-C', '{proj_s}', \
             '--no-telemetry', \
             '--dev' \
           ) \
           -WindowStyle Normal"
    );

    std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &ps,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Failed to spawn AtomCode: {e}"))?;

    Ok(())
}
