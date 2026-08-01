//! AtomCode external coding harness — external tool (not core app).
//!
//! Install: `{app_root}/external-tools/atomcode/`
//! Home:    `{app_root}/config/external-tools/atomcode-home/`
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
        .join("external-tools")
        .join("atomcode")
}

pub fn exe_path() -> PathBuf {
    tools_dir().join("atomcode.exe")
}

pub fn home_dir() -> PathBuf {
    crate::config::config_dir()
        .join("external-tools")
        .join("atomcode-home")
}

/// One-time move from legacy runtime/tools + config/atomcode-home paths.
fn migrate_legacy_paths() {
    let root = crate::config::app_root_dir();
    let cfg = crate::config::config_dir();
    let new_tools = tools_dir();
    let old_tools = root.join("runtime").join("tools").join("atomcode");
    if !new_tools.exists() && old_tools.is_dir() {
        if let Some(parent) = new_tools.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::rename(&old_tools, &new_tools);
    }
    let new_home = home_dir();
    let old_home = cfg.join("atomcode-home");
    if !new_home.exists() && old_home.is_dir() {
        if let Some(parent) = new_home.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::rename(&old_home, &new_home);
    }
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
    migrate_legacy_paths();
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
        migrate_legacy_paths();
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
    // Do not seed a stub config.toml here. AtomCode's webui/daemon load
    // ATOMCODE_HOME/config.toml and require `default_provider` + [providers.*].
    // Launch always overwrites config.toml via write_launch_config().
    let _ = home;
    Ok(())
}

/// Write the managed provider config AtomCode always reads from home.
/// TUI is launched with `--config` (same file). WebUI / daemon ignore CLI
/// `--config` and only parse `ATOMCODE_HOME/config.toml` — so this must be
/// the full launch TOML, never a stub without `default_provider`.
fn write_launch_config(home: &Path, toml: &str) -> Result<PathBuf, String> {
    let cfg_path = home.join("config.toml");
    std::fs::write(&cfg_path, toml).map_err(|e| format!("write config.toml: {e}"))?;
    // Mirror for debugging / older notes that pointed at launch-config.toml
    let mirror = home.join("launch-config.toml");
    let _ = std::fs::write(&mirror, toml);
    Ok(cfg_path)
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

const WEBUI_DEFAULT_PORT: u16 = 13457;
const WEBUI_HOST: &str = "127.0.0.1";

fn webui_token_path() -> PathBuf {
    home_dir().join("webui-token.txt")
}

/// Stable local-only WebUI token (persisted under atomcode-home). Reused so
/// browser bookmarks / app re-open do not need a fresh random token each start.
fn ensure_webui_static_token() -> Result<String, String> {
    let path = webui_token_path();
    if let Ok(s) = std::fs::read_to_string(&path) {
        let t = s.trim().to_string();
        // 32 hex chars (matches AtomCode dynamic token length) or any 16+ token
        if t.len() >= 16 && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Ok(t);
        }
    }
    // 32 hex — same shape as AtomCode's dynamic tokens
    let token: String = (0..32)
        .map(|_| format!("{:x}", rand_u4()))
        .collect();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("webui token dir: {e}"))?;
    }
    std::fs::write(&path, format!("{token}\n")).map_err(|e| format!("write webui token: {e}"))?;
    Ok(token)
}

/// Tiny non-crypto nibble for token generation (no rand crate dependency).
fn rand_u4() -> u8 {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let c = COUNTER.fetch_add(0x9e37_79b9_7f4a_7c15, Ordering::Relaxed);
    (((t ^ c).wrapping_mul(0x517c_c1b7)) >> 28) as u8 & 0xf
}

fn webui_url(port: u16, token: &str) -> String {
    // Query overrides work even when config language/theme are ignored by webui.
    format!("http://{WEBUI_HOST}:{port}/?token={token}&lang=en&theme=dark")
}

/// Ensure browser URL forces English + dark (AtomCode honors these query params).
fn ensure_webui_ui_query(url: &str) -> String {
    let mut u = url.trim().to_string();
    if u.is_empty() {
        return u;
    }
    let lower = u.to_ascii_lowercase();
    if !lower.contains("lang=") {
        u.push_str(if u.contains('?') { "&lang=en" } else { "?lang=en" });
    }
    let lower = u.to_ascii_lowercase();
    if !lower.contains("theme=") {
        u.push_str("&theme=dark");
    }
    u
}

/// Shared [webui] + [sync] tail — static token, local bind only.
fn webui_sync_toml_section(token: &str, port: u16) -> String {
    format!(
        r#"[webui]
# Local browser UI (Blackwell-managed). Static token = stable URL across launches.
enabled = true
host = "{host}"
port = {port}
token_auth = true
token = "{token}"
auto_open = false

[sync]
# Bidirectional CLI <-> browser when both are up (TUI /webui path).
enabled = true

[lsp]
enabled = false
"#,
        host = WEBUI_HOST,
        port = port,
        token = toml_escape(token),
    )
}

fn build_config_toml(req: &AtomcodeLaunchRequest) -> Result<String, String> {
    let mode = req.mode.trim().to_lowercase();
    // Honor Agents slider (Solo×1 … Army×32). Do not floor dual at 4 — that capped x8/x16.
    let concurrent = req.max_concurrent.clamp(1, 32);
    let primary_ctx = req.primary.context_window.unwrap_or(262_144);
    let primary_url = format!("http://127.0.0.1:{}/v1", req.primary.port);
    let primary_model = openai_model_id(&req.primary.model);
    let webui_token = ensure_webui_static_token()?;
    let webui_tail = webui_sync_toml_section(&webui_token, WEBUI_DEFAULT_PORT);

    if req.primary.port == 0 {
        return Err("Primary engine port is 0.".into());
    }

    match mode.as_str() {
        "solo" => {
            let sub_enabled = concurrent > 1;
            Ok(format!(
                r#"# Generated by Blackwell Ops - isolated AtomCode home
# Do not merge with a personal ~/.atomcode install.
# `model` MUST equal the engine alias (what /v1/models reports). Set alias at launch.
default_provider = "{prov}"
# Required by AtomCode when it does not treat the OpenAI model id as vision-native
# (e.g. launch alias ENGINE_1). Same local provider; supports_vision below opts into image_url.
vision_preprocessor_provider = "{prov}"
auto_update = false
auto_commit = false
# Force English UI (default often follows browser/OS locale).
language = "en"
# Force dark theme (dark | light | system).
theme = "dark"

[providers.{prov}]
type = "openai"
model = "{model}"
base_url = "{url}"
api_key = "blackwell"
context_window = {ctx}
capable_model = 2
# Native multimodal: send image_url base64 (not text-only OCR path).
supports_vision = true

[subagent]
enabled = {sub}
provider = "{prov}"
initial_turns = 4
max_turns = 12
max_concurrent = {n}
timeout_secs = 600

{webui_tail}"#,
                prov = PROVIDER_SOLO,
                model = toml_escape(&primary_model),
                url = toml_escape(&primary_url),
                ctx = primary_ctx,
                sub = if sub_enabled { "true" } else { "false" },
                n = concurrent,
                webui_tail = webui_tail,
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
                r#"# Generated by Blackwell Ops - dual-engine stack (attach mode)
# BRAIN = default_provider -> primary port. WORKER = subagent.provider -> worker port.
# Aliases need not be the words BRAIN/WORKER; they must match each server's --alias.
default_provider = "{brain_prov}"
# BRAIN handles vision; AtomCode rejects non-catalog model ids without this + supports_vision.
vision_preprocessor_provider = "{brain_prov}"
auto_update = false
auto_commit = false
# Force English UI (default often follows browser/OS locale).
language = "en"
# Force dark theme (dark | light | system).
theme = "dark"

[providers.{brain_prov}]
type = "openai"
model = "{brain_model}"
base_url = "{brain_url}"
api_key = "blackwell"
context_window = {brain_ctx}
capable_model = 2
# Native multimodal: send image_url base64 (not text-only OCR path).
supports_vision = true

[providers.{worker_prov}]
type = "openai"
model = "{worker_model}"
base_url = "{worker_url}"
api_key = "blackwell"
context_window = {worker_ctx}
capable_model = 1
supports_vision = false

[subagent]
enabled = true
provider = "{worker_prov}"
initial_turns = 4
max_turns = 24
max_concurrent = {n}
timeout_secs = 600

{webui_tail}"#,
                brain_prov = PROVIDER_BRAIN,
                worker_prov = PROVIDER_WORKER,
                brain_model = toml_escape(&primary_model),
                brain_url = toml_escape(&primary_url),
                brain_ctx = primary_ctx,
                worker_model = toml_escape(&worker_model),
                worker_url = toml_escape(&w_url),
                worker_ctx = w_ctx,
                n = n,
                webui_tail = webui_tail,
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
        migrate_legacy_paths();
        if !disclaimer_path().is_file() {
            return Err("Accept the AtomCode disclaimer first.".into());
        }
        let exe = exe_path();
        if !exe.is_file() {
            return Err(
                "AtomCode is not installed under external-tools/atomcode. Install it first."
                    .into(),
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
        // Must be config.toml — webui/daemon parse this path only (not launch-config.toml).
        let cfg_path = write_launch_config(&home, &toml)?;

        let _ = std::fs::write(
            last_project_path(),
            format!("{}\n", project.to_string_lossy()),
        );

        // Operational notes: refresh managed PATHS block every launch (real absolute home).
        // Agents often claim "~/.atomcode" from generic docs — our launches never use that dir.
        write_atomcode_directive(&home, &project, &cfg_path);

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


const ATOMCODE_MD_BODY: &str = r#"# Blackwell Ops - AtomCode operational notes

You are the BRAIN layer on the default provider. Workers (if enabled) use the subagent provider.

- Local hardware: prefer wall-clock speed over token thrift.
- Parallelize independent file/search/edit scopes via subagents when available.
- Non-overlapping write scopes; review worker diffs before continuing.
- Verify with cargo check / tsc / tests after edits.
- Stop after 3 fruitless search rounds and report what you checked.

Provider URLs and OpenAI model ids are injected each launch by Blackwell Ops.
"#;

const PATHS_BEGIN: &str = "<!-- BLACKWELL-PATHS:BEGIN -->";
const PATHS_END: &str = "<!-- BLACKWELL-PATHS:END -->";

/// Upsert absolute path truth into ATOMCODE.md (read by the agent).
fn write_atomcode_directive(home: &Path, project: &Path, config: &Path) {
    let paths_block = format!(
        r#"{PATHS_BEGIN}
## Paths (Blackwell Ops — authoritative)

This process is **not** using the global user install.

| Role | Absolute path |
|------|----------------|
| **ATOMCODE_HOME** (config, sessions, plugins, memory) | `{home}` |
| **Project cwd** (`-C` / working directory) | `{project}` |
| **Config file** | `{config}` |

Do **not** report `~/.atomcode` or `%USERPROFILE%\.atomcode` as your home for this session.
That folder is a separate optional user install and is unused when launched from Blackwell Ops.
If asked where config lives, answer with **ATOMCODE_HOME** above only.
{PATHS_END}
"#,
        home = home.display(),
        project = project.display(),
        config = config.display(),
    );

    let path = home.join("ATOMCODE.md");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let next = if existing.contains(PATHS_BEGIN) && existing.contains(PATHS_END) {
        // Replace managed block only
        let before = existing.split(PATHS_BEGIN).next().unwrap_or("").trim_end();
        let after = existing
            .split(PATHS_END)
            .nth(1)
            .map(|s| s.trim_start())
            .unwrap_or("");
        format!(
            "{before}\n\n{paths_block}\n{after}",
            before = if before.is_empty() {
                ATOMCODE_MD_BODY.trim_end().to_string()
            } else {
                before.to_string()
            },
            after = after
        )
    } else if existing.trim().is_empty() {
        format!("{ATOMCODE_MD_BODY}\n{paths_block}\n")
    } else {
        format!("{existing}\n\n{paths_block}\n")
    };
    let _ = std::fs::write(&path, next);
}

#[cfg(windows)]
fn spawn_atomcode_console(
    exe: &Path,
    home: &Path,
    config: &Path,
    project: &Path,
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // PowerShell Start-Process inherits $env:ATOMCODE_HOME set in the same process —
    // more reliable than `cmd set && start` for agent-visible home isolation.
    // Paths with spaces: single-quoted PS literals (double embedded ').
    // Never CREATE_BREAKAWAY_FROM_JOB.
    let q = |s: &str| s.replace('\'', "''");
    let home_s = q(&home.to_string_lossy());
    let exe_s = q(&exe.to_string_lossy());
    let cfg_s = q(&config.to_string_lossy());
    let proj_s = q(&project.to_string_lossy());

    let ps = format!(
        "$env:ATOMCODE_HOME = '{home_s}'; \
         Start-Process -FilePath '{exe_s}' \
           -WorkingDirectory '{proj_s}' \
           -ArgumentList @( \
             '--config', '{cfg_s}', \
             '-C', '{proj_s}', \
             '--lang', 'en', \
             '--no-telemetry', \
             '--dev' \
           ) \
           -WindowStyle Normal"
    );

    Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &ps,
        ])
        .env("ATOMCODE_HOME", home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Failed to spawn AtomCode TUI: {e}"))?;

    Ok(())
}

/// Kill our tools-folder atomcode.exe listening on `port` (stale webui holds old config).
#[cfg(windows)]
fn kill_our_atomcode_on_port(port: u16) {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let our_exe = exe_path();
    let our_norm = our_exe.to_string_lossy().replace('/', "\\").to_ascii_lowercase();

    // netstat -ano → find PID on 127.0.0.1:port LISTENING
    let out = Command::new("netstat")
        .args(["-ano"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let Ok(out) = out else { return };
    let text = String::from_utf8_lossy(&out.stdout);
    let needle = format!("127.0.0.1:{port}");
    let mut pids = std::collections::HashSet::new();
    for line in text.lines() {
        let line = line.trim();
        if !line.contains(&needle) || !line.to_ascii_uppercase().contains("LISTENING") {
            continue;
        }
        if let Some(pid_s) = line.split_whitespace().last() {
            if let Ok(pid) = pid_s.parse::<u32>() {
                pids.insert(pid);
            }
        }
    }
    for pid in pids {
        // Confirm image path is our atomcode.exe (not a random listener).
        let wmic = Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "(Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\").ExecutablePath"
                ),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let path = wmic
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        let path_norm = path.replace('/', "\\").to_ascii_lowercase();
        if path_norm.is_empty() || path_norm != our_norm {
            continue;
        }
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        emit_dbg(&format!(
            "[AtomCode] Killed stale webui PID {pid} on :{port} (reload config)"
        ));
    }
}

// ── WebUI (browser; static token in config when present) ───────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AtomcodeWebuiResult {
    pub url: String,
    pub port: u16,
    pub token: String,
}

fn tcp_port_open(host: &str, port: u16) -> bool {
    use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
    use std::time::Duration;
    let addr = format!("{host}:{port}");
    let Ok(mut addrs) = addr.to_socket_addrs() else {
        return false;
    };
    let Some(sa): Option<SocketAddr> = addrs.next() else {
        return false;
    };
    TcpStream::connect_timeout(&sa, Duration::from_millis(200)).is_ok()
}

/// Pull `http://127.0.0.1:PORT/?token=HEX` from atomcode stderr (EN or CN prefix).
fn parse_webui_url_line(line: &str) -> Option<(String, u16, String)> {
    // Prefer full URL if present
    let re = regex_lite_url(line)?;
    let url = re.to_string();
    let token = url
        .split("token=")
        .nth(1)?
        .split(&['&', ' ', '"', '\''][..])
        .next()?
        .trim()
        .to_string();
    if token.is_empty() {
        return None;
    }
    let port = url
        .split("://")
        .nth(1)?
        .split('/')
        .next()?
        .rsplit(':')
        .next()?
        .parse::<u16>()
        .ok()
        .unwrap_or(WEBUI_DEFAULT_PORT);
    Some((url, port, token))
}

/// Avoid pulling the `regex` crate — small scanner for http(s) URL containing token=.
fn regex_lite_url(line: &str) -> Option<&str> {
    let lower = line.to_ascii_lowercase();
    let start = lower.find("http://").or_else(|| lower.find("https://"))?;
    let rest = &line[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '>')
        .unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches(['.', ',', ';', ')']);
    if url.contains("token=") {
        Some(url)
    } else {
        None
    }
}

fn open_url_in_browser(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Stdio;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        // `start` needs an empty title arg when URL is quoted.
        std::process::Command::new("cmd")
            .args(["/c", "start", "", url])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = url;
        Err("Browser open only supported on Windows.".into())
    }
}

/// Start AtomCode webui (or reopen if already up). Prefers static token from
/// config / webui-token.txt so the URL is stable across launches.
#[tauri::command]
pub async fn atomcode_open_webui(port: Option<u16>) -> Result<AtomcodeWebuiResult, String> {
    #[cfg(not(windows))]
    {
        let _ = port;
        return Err("AtomCode webui is only supported on Windows.".into());
    }

    #[cfg(windows)]
    {
        use std::io::{BufRead, BufReader};
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let exe = exe_path();
        if !exe.is_file() {
            return Err("AtomCode is not installed. Install it from the harness first.".into());
        }
        let home = home_dir();
        let cfg = home.join("config.toml");
        if !cfg.is_file() {
            return Err(
                "No AtomCode config yet. Open AtomCode (TUI) once from the harness so providers are written."
                    .into(),
            );
        }
        let cfg_body = std::fs::read_to_string(&cfg).unwrap_or_default();
        if !cfg_body.contains("default_provider") {
            return Err(
                "AtomCode config is incomplete (missing default_provider). Open AtomCode (TUI) once from the harness first."
                    .into(),
            );
        }

        let port = port.unwrap_or(WEBUI_DEFAULT_PORT);
        let token = ensure_webui_static_token()?;
        // Prefer static URL from our token file; stderr parse is fallback only.
        let static_url = webui_url(port, &token);

        let project = std::fs::read_to_string(last_project_path())
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| home.clone());

        if project == home {
            return Err(
                "No project folder set. Open AtomCode TUI once (Choose project) before WebUI."
                    .into(),
            );
        }

        // Stale webui keeps old config in memory (e.g. without supports_vision) and may
        // lack -C project. Kill our tools-folder listener, then start clean.
        if tcp_port_open(WEBUI_HOST, port) {
            kill_our_atomcode_on_port(port);
            std::thread::sleep(Duration::from_millis(400));
        }

        // Global options MUST come before the `webui` subcommand (clap).
        // `webui` itself only accepts --port / --host / --no-telemetry.
        let cfg_path = home.join("config.toml");
        let mut child = Command::new(&exe)
            .args([
                "--config",
                &cfg_path.to_string_lossy(),
                "-C",
                &project.to_string_lossy(),
                "--lang",
                "en",
                "--no-telemetry",
                "webui",
                "--port",
                &port.to_string(),
            ])
            .current_dir(&project)
            .env("ATOMCODE_HOME", &home)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to start AtomCode webui: {e}"))?;

        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "webui: no stderr pipe".to_string())?;

        let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            let mut collected = String::new();
            let mut sent = false;
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        if !sent {
                            collected.push_str(&l);
                            collected.push('\n');
                            if let Some((url, _, _)) = parse_webui_url_line(&l) {
                                let _ = tx.send(Ok(url));
                                sent = true;
                            }
                        }
                    }
                    Err(e) => {
                        if !sent {
                            let _ = tx.send(Err(format!("webui stderr: {e}")));
                        }
                        return;
                    }
                }
            }
            if !sent {
                let _ = tx.send(Err(format!(
                    "webui exited before printing token URL. Output:\n{collected}"
                )));
            }
        });

        // Prefer static URL once port is listening; stderr is optional confirmation.
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut url = static_url.clone();
        let mut got_stderr_url = false;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                if tcp_port_open(WEBUI_HOST, port) {
                    break; // use static_url
                }
                let _ = child.kill();
                return Err(
                    "Timed out waiting for AtomCode webui. Is port busy or config rejected?"
                        .into(),
                );
            }
            match rx.recv_timeout(left.min(Duration::from_millis(150))) {
                Ok(Ok(u)) => {
                    // If AtomCode ignored our static token and printed another, use printed URL.
                    url = u;
                    got_stderr_url = true;
                    break;
                }
                Ok(Err(e)) => {
                    let _ = child.kill();
                    return Err(e);
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if tcp_port_open(WEBUI_HOST, port) {
                        break;
                    }
                    if let Ok(Some(status)) = child.try_wait() {
                        return Err(format!(
                            "AtomCode webui exited early ({status}). Port {port} may be in use."
                        ));
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    if tcp_port_open(WEBUI_HOST, port) {
                        break;
                    }
                    let _ = child.kill();
                    return Err("webui token waiter disconnected.".into());
                }
            }
        }

        let (raw_url, final_port, final_token) = if got_stderr_url {
            parse_webui_url_line(&url).unwrap_or((url.clone(), port, token.clone()))
        } else {
            (static_url, port, token)
        };
        let final_url = ensure_webui_ui_query(&raw_url);

        // Reap when webui eventually exits; do not wait here.
        std::thread::spawn(move || {
            let _ = child.wait();
        });

        if let Err(e) = open_url_in_browser(&final_url) {
            emit_dbg(&format!("[AtomCode] webui URL ready but browser open failed: {e}"));
        }

        emit_dbg(&format!("[AtomCode] WebUI → {final_url}"));

        Ok(AtomcodeWebuiResult {
            url: final_url,
            port: final_port,
            token: final_token,
        })
    }
}
