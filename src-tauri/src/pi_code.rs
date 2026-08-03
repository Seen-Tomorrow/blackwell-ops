//! pi coding agent external harness — external tool (not core app).
//!
//! Install: `{app_root}/external-tools/pi/`
//! Home:    `{app_root}/config/external-tools/pi-home/`  (PI_CODING_AGENT_DIR)
//! Never uses the user's PATH or global `~/.pi` / npm install.
//! pi is distributed as a Bun-compiled standalone Windows binary
//! (`pi-windows-x64.zip` from GitHub releases) — self-contained, no Node/Bun at runtime.
//! Launch is always a detached external console.

use serde::{Deserialize, Serialize};
use crate::external_agents::emit_dbg;
use std::path::{Path, PathBuf};

/// Pinned release we verified against local OpenAI-compatible engines.
pub const PINNED_VERSION: &str = "0.83.0";

const GITHUB_RELEASE_BASE: &str = "https://github.com/earendil-works/pi/releases/download";

// ── Paths ──────────────────────────────────────────────────────────────

fn tools_dir() -> PathBuf {
    crate::config::app_root_dir()
        .join("external-tools")
        .join("pi")
}

/// Extracted standalone package root (contains pi.exe + assets/theme/docs).
fn package_dir() -> PathBuf {
    tools_dir().join("pi")
}

/// Outer launcher (Blackwell shim) — sets PI_CODING_AGENT_DIR then runs pi.exe.
pub fn launcher_path() -> PathBuf {
    tools_dir().join("bin").join("pi.cmd")
}

fn package_binary() -> PathBuf {
    package_dir().join("pi.exe")
}

pub fn home_dir() -> PathBuf {
    crate::config::config_dir()
        .join("external-tools")
        .join("pi-home")
}

fn version_stamp_path() -> PathBuf {
    crate::external_agents::version_stamp_path(&tools_dir())
}

fn disclaimer_path() -> PathBuf {
    crate::external_agents::disclaimer_path(&home_dir())
}

fn last_project_path() -> PathBuf {
    crate::external_agents::last_project_path(&home_dir())
}

// ── Status ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiCodeStatus {
    pub installed: bool,
    pub launcher_path: String,
    pub home_path: String,
    pub version: Option<String>,
    pub pinned_version: String,
    pub disclaimer_accepted: bool,
    pub last_project: Option<String>,
}

fn read_version_stamp() -> Option<String> {
    crate::external_agents::read_trimmed(&version_stamp_path())
}

fn is_installed() -> bool {
    launcher_path().is_file() && package_binary().is_file()
}

fn probe_version() -> Option<String> {
    let launcher = launcher_path();
    if !launcher.is_file() {
        return None;
    }
    let out = std::process::Command::new("cmd")
        .args(["/c", &launcher.to_string_lossy(), "--version"])
        .env("PI_CODING_AGENT_DIR", home_dir())
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
pub async fn pi_code_status() -> Result<PiCodeStatus, String> {
    let installed = is_installed();
    let version = if installed {
        read_version_stamp().or_else(probe_version)
    } else {
        None
    };
    let last_project = crate::external_agents::read_trimmed(&last_project_path());
    Ok(PiCodeStatus {
        installed,
        launcher_path: launcher_path().to_string_lossy().to_string(),
        home_path: home_dir().to_string_lossy().to_string(),
        version,
        pinned_version: PINNED_VERSION.to_string(),
        disclaimer_accepted: disclaimer_path().is_file(),
        last_project,
    })
}

#[tauri::command]
pub async fn pi_code_accept_disclaimer() -> Result<(), String> {
    crate::external_agents::write_disclaimer(&home_dir(), PINNED_VERSION)
}

#[tauri::command]
pub async fn pi_code_set_project(project_dir: String) -> Result<PiCodeStatus, String> {
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
    pi_code_status().await
}

// ── Install ────────────────────────────────────────────────────────────

fn windows_arch_tag() -> Result<&'static str, String> {
    let arch = std::env::var("PROCESSOR_ARCHITEW6432")
        .or_else(|_| std::env::var("PROCESSOR_ARCHITECTURE"))
        .unwrap_or_else(|_| "AMD64".into());
    match arch.to_uppercase().as_str() {
        "AMD64" | "X86_64" => Ok("x64"),
        "ARM64" => Ok("arm64"),
        other => Err(format!("Unsupported architecture for pi: {other}")),
    }
}

fn release_zip_url(version: &str) -> String {
    // Tag uses v-prefix on GitHub releases.
    let tag = if version.starts_with('v') {
        version.to_string()
    } else {
        format!("v{version}")
    };
    let arch = windows_arch_tag().unwrap_or("x64");
    format!("{GITHUB_RELEASE_BASE}/{tag}/pi-windows-{arch}.zip")
}

fn release_sums_url(version: &str) -> String {
    let tag = if version.starts_with('v') {
        version.to_string()
    } else {
        format!("v{version}")
    };
    format!("{GITHUB_RELEASE_BASE}/{tag}/SHA256SUMS")
}

fn parse_sums_expected(sums: &str, archive_name: &str) -> Option<String> {
    for line in sums.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next()?.trim_start_matches('*');
        if name.eq_ignore_ascii_case(archive_name) && hash.len() == 64 {
            return Some(hash.to_ascii_lowercase());
        }
    }
    None
}

/// Write the Blackwell outer shim. ROOT = package (pi/) relative to bin/.
fn write_outer_shim(tools: &Path) -> Result<(), String> {
    let bin = tools.join("bin");
    std::fs::create_dir_all(&bin).map_err(|e| format!("bin dir: {e}"))?;
    let shim = r#"@echo off
setlocal
REM Blackwell-isolated pi launcher (package lives in ..\pi)
set "PKG=%~dp0..\pi"
"%PKG%\pi.exe" %*
exit /b %ERRORLEVEL%
"#;
    std::fs::write(bin.join("pi.cmd"), shim).map_err(|e| format!("write shim: {e}"))?;
    Ok(())
}

fn extract_zip_windows(zip: &Path, dest: &Path) -> Result<(), String> {
    // PowerShell Expand-Archive is reliable on Win10+.
    let zip_s = zip.to_string_lossy().replace('\'', "''");
    let dest_s = dest.to_string_lossy().replace('\'', "''");
    let ps = format!(
        "Expand-Archive -LiteralPath '{zip_s}' -DestinationPath '{dest_s}' -Force"
    );
    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &ps,
        ])
        .output()
        .map_err(|e| format!("Expand-Archive spawn: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Expand-Archive failed: {err}"));
    }
    Ok(())
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("mkdir {dst:?}: {e}"))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("read_dir: {e}"))? {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let ty = entry.file_type().map_err(|e| format!("file_type: {e}"))?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to).map_err(|e| format!("copy: {e}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn pi_code_install(
    app: tauri::AppHandle,
    version: Option<String>,
) -> Result<PiCodeStatus, String> {
    #[cfg(not(windows))]
    {
        let _ = (app, version);
        return Err("pi tool install is only supported on Windows.".into());
    }

    #[cfg(windows)]
    {
        if !disclaimer_path().is_file() {
            return Err("Accept the pi disclaimer first (pi_code_accept_disclaimer).".into());
        }

        let ver = version
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.trim_start_matches('v').to_string())
            .unwrap_or_else(|| PINNED_VERSION.to_string());

        let tools = tools_dir();
        std::fs::create_dir_all(&tools).map_err(|e| format!("tools dir: {e}"))?;
        std::fs::create_dir_all(home_dir()).map_err(|e| format!("home: {e}"))?;

        let archive_name = format!("pi-windows-{}.zip", windows_arch_tag()?);
        let zip_url = release_zip_url(&ver);
        let sums_url = release_sums_url(&ver);
        emit_dbg(&format!("[Pi] Downloading standalone {ver}…"));
        emit_dbg(&format!("[Pi] {zip_url}"));

        let zip_bytes = crate::external_agents::download_bytes(&zip_url).await?;
        if zip_bytes.len() < 10_000_000 {
            return Err(format!(
                "Standalone zip too small ({} bytes) — release may be missing: {zip_url}",
                zip_bytes.len()
            ));
        }
        let actual = crate::external_agents::sha256_hex(&zip_bytes);
        let sums_text = match crate::external_agents::download_bytes(&sums_url).await {
            Ok(b) => String::from_utf8_lossy(&b).to_string(),
            Err(e) => {
                emit_dbg(&format!("[Pi] SHA256SUMS download failed: {e}"));
                String::new()
            }
        };
        if let Some(expected) = parse_sums_expected(&sums_text, &archive_name) {
            if expected != actual {
                return Err(format!(
                    "Checksum mismatch for {archive_name}: expected {expected}, got {actual}"
                ));
            }
            emit_dbg("[Pi] SHA-256 OK");
        } else {
            emit_dbg(&format!("[Pi] No SHA256SUMS entry — proceeding with sha256={actual}"));
        }

        // Save with a real `.zip` extension: PowerShell Expand-Archive determines the
        // archive type from the file extension, so a `.download` suffix would be rejected.
        let zip_path = tools.join(&archive_name);
        std::fs::write(&zip_path, &zip_bytes).map_err(|e| format!("write zip: {e}"))?;

        let extract_root = tools.join("_extract");
        if extract_root.exists() {
            let _ = std::fs::remove_dir_all(&extract_root);
        }
        std::fs::create_dir_all(&extract_root).map_err(|e| format!("extract dir: {e}"))?;
        extract_zip_windows(&zip_path, &extract_root)?;

        // Zip contains top-level `pi.exe` (flat) + assets/theme/docs/etc.
        if !extract_root.join("pi.exe").is_file() {
            let _ = std::fs::remove_dir_all(&extract_root);
            let _ = std::fs::remove_file(&zip_path);
            return Err("Archive missing pi.exe.".into());
        }

        let dest_pkg = package_dir();
        if dest_pkg.exists() {
            std::fs::remove_dir_all(&dest_pkg).map_err(|e| {
                format!(
                    "Cannot replace {}: {e}. Close any running pi from Blackwell and retry.",
                    dest_pkg.display()
                )
            })?;
        }
        if let Err(e) = std::fs::rename(&extract_root, &dest_pkg) {
            copy_dir_all(&extract_root, &dest_pkg).map_err(|e2| {
                format!("install move failed: {e} / {e2}")
            })?;
        }

        write_outer_shim(&tools)?;
        std::fs::write(version_stamp_path(), format!("{ver}\n"))
            .map_err(|e| format!("version stamp: {e}"))?;

        let _ = std::fs::remove_file(&zip_path);

        let _ = app;
        emit_dbg(&format!("[Pi] Installed → {}", launcher_path().display()));
        pi_code_status().await
    }
}

// ── Launch ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiEngineRef {
    pub port: u16,
    /// OpenAI model id — must match engine launch alias.
    pub model: String,
    #[serde(default)]
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiLaunchRequest {
    /// `solo` | `brain_workers`
    pub mode: String,
    pub primary: PiEngineRef,
    pub worker: Option<PiEngineRef>,
    pub project_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiLaunchResult {
    pub launcher_path: String,
    pub models_path: String,
    pub project_dir: String,
    pub mode: String,
    pub home_path: String,
}

fn openai_model_id(raw: &str) -> String {
    let s = raw.trim();
    if s.is_empty() {
        "local-model".into()
    } else {
        s.to_string()
    }
}

fn models_path() -> PathBuf {
    home_dir().join("models.json")
}

fn settings_path() -> PathBuf {
    home_dir().join("settings.json")
}

/// Build the isolated pi `models.json` (PI_CODING_AGENT_DIR/models.json) so pi
/// routes BRAIN/WORKER to the two llama engines, plus a minimal settings.json.
///
/// pi reads `models.json` each time `/model` opens (no restart). Providers are
/// keyed by name; the model `id` MUST equal the engine launch alias (what the
/// llama server reports as the OpenAI model id).
fn build_models_and_settings(req: &PiLaunchRequest) -> Result<(String, String, String), String> {
    if req.primary.port == 0 {
        return Err("Primary engine port is 0.".into());
    }
    let mode = req.mode.trim().to_lowercase();
    let primary_model = openai_model_id(&req.primary.model);
    let primary_ctx = req.primary.context_window.unwrap_or(262_144);
    let primary_url = format!("http://localhost:{}/v1", req.primary.port);
    let primary_max = if primary_ctx >= 262_144 { 65536 } else { 32768 };

    let is_twin = matches!(mode.as_str(), "brain_workers" | "brain+workers" | "dual");

    // ── Hoist worker refs (needed by both models.json and the PI.md routing) ──
    let worker_ref = if is_twin {
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
        Some(worker)
    } else {
        None
    };
    let (w_model, w_ctx, w_url, w_max) = if let Some(worker) = worker_ref {
        let w_model = openai_model_id(&worker.model);
        let w_ctx = worker.context_window.unwrap_or(131_072);
        let w_url = format!("http://localhost:{}/v1", worker.port);
        let w_max = if w_ctx >= 131_072 { 32768 } else { 16384 };
        (w_model, w_ctx, w_url, w_max)
    } else {
        (String::new(), 0_u64, String::new(), 0_u32)
    };

    // ── models.json ───────────────────────────────────────────────────
    let mut models = serde_json::json!({ "providers": {} });

    let brain_compat = serde_json::json!({
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": true,
        "supportsUsageInStreaming": false
    });

    if is_twin {
        models["providers"]["local"] = serde_json::json!({
            "baseUrl": primary_url,
            "api": "openai-completions",
            "apiKey": "local",
            "compat": brain_compat,
            "models": [{
                "id": primary_model,
                "name": "brain",
                "input": ["text", "image"],
                "contextWindow": primary_ctx,
                "maxTokens": primary_max,
                "reasoning": true,
                "thinkingLevelMap": {
                    "off": "none",
                    "minimal": "minimal",
                    "low": "low",
                    "medium": "medium",
                    "high": "high",
                    "xhigh": "high",
                    "max": "max"
                }
            }]
        });
        models["providers"]["worker"] = serde_json::json!({
            "baseUrl": w_url,
            "api": "openai-completions",
            "apiKey": "local",
            "compat": {
                "supportsDeveloperRole": false,
                "supportsReasoningEffort": false,
                "supportsUsageInStreaming": false
            },
            "models": [{
                "id": w_model,
                "name": "worker",
                "input": ["text"],
                "contextWindow": w_ctx,
                "maxTokens": w_max,
                "reasoning": true,
                "thinkingLevelMap": { "off": null }
            }]
        });
    } else {
        models["providers"]["local"] = serde_json::json!({
            "baseUrl": primary_url,
            "api": "openai-completions",
            "apiKey": "local",
            "compat": brain_compat,
            "models": [{
                "id": primary_model,
                "name": "brain",
                "input": ["text", "image"],
                "contextWindow": primary_ctx,
                "maxTokens": primary_max,
                "reasoning": true,
                "thinkingLevelMap": {
                    "off": "none",
                    "minimal": "minimal",
                    "low": "low",
                    "medium": "medium",
                    "high": "high",
                    "xhigh": "high",
                    "max": "max"
                }
            }]
        });
    }

    let models_str =
        serde_json::to_string_pretty(&models).map_err(|e| format!("models json: {e}"))?;

    // ── settings.json ─────────────────────────────────────────────────
    let home_note = home_dir().to_string_lossy().to_string();
    let routing_note = if is_twin {
        "BRAIN = provider local / model <brain-alias>. WORKER = provider worker / model <worker-alias>. Subagents point at worker."
    } else {
        "SOLO — single engine, provider local."
    };
    let settings = serde_json::json!({
        "compaction": { "enabled": true },
        "defaultProjectTrust": "ask",
        "enableInstallTelemetry": false,
        "images": { "blockImages": true },
        "theme": "dark",
        "transport": "auto",
        "defaultProvider": "local",
        "defaultModel": primary_model,
        "hideThinkingBlock": false,
        "collapseChangelog": true,
        "defaultThinkingLevel": "off",
        "steeringMode": "all",
        "_blackwell": {
            "managed": true,
            "piHome": home_note,
            "mode": mode,
            "routing": routing_note
        }
    });
    let settings_str =
        serde_json::to_string_pretty(&settings).map_err(|e| format!("settings json: {e}"))?;

    // ── routing note (PI.md in home) ──────────────────────────────────
    let routing = if is_twin {
        format!(
            "# Blackwell Ops — pi (managed)\n\n\
             ## Model routing\n\n\
             pi reads `models.json` from PI_CODING_AGENT_DIR. Two providers:\n\n\
             | Provider | Role | Model id (engine alias) | Endpoint |\n\
             |----------|------|--------------------------|----------|\n\
             | `local`  | BRAIN | `{primary_model}` | `{primary_url}` |\n\
             | `worker` | WORKER | `{w_model}` | `{w_url}` |\n\n\
             - BRAIN = provider `local`, model `{primary_model}`.\n\
             - WORKER = provider `worker`, model `{w_model}` — point subagents at this for parallel fan-out.\n\
             - You (the agent) cannot switch the main session model; the user uses `/model`.\n",
            primary_model = primary_model,
            primary_url = primary_url,
            w_model = w_model,
            w_url = w_url,
        )
    } else {
        format!(
            "# Blackwell Ops — pi (managed)\n\n\
             ## Model routing\n\n\
             pi reads `models.json` from PI_CODING_AGENT_DIR. Single engine:\n\n\
             | Provider | Role | Model id (engine alias) | Endpoint |\n\
             |----------|------|--------------------------|----------|\n\
             | `local`  | BRAIN | `{primary_model}` | `{primary_url}` |\n\n\
             - BRAIN = provider `local`, model `{primary_model}`.\n\
             - You (the agent) cannot switch the main session model; the user uses `/model`.\n",
            primary_model = primary_model,
            primary_url = primary_url,
        )
    };

    Ok((models_str, settings_str, routing))
}

const PI_MD_BEGIN: &str = "<!-- BLACKWELL-PI:BEGIN -->";
const PI_MD_END: &str = "<!-- BLACKWELL-PI:END -->";

/// Upsert the managed PI.md block (home + project cwd) so the agent knows the
/// isolated home + routing (mirrors QWEN.md for Qwen Code).
fn upsert_pi_md(path: &Path, block: &str) -> Result<(), String> {
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    let next = if existing.contains(PI_MD_BEGIN) && existing.contains(PI_MD_END) {
        let before = existing.split(PI_MD_BEGIN).next().unwrap_or("").trim_end();
        let after = existing
            .split(PI_MD_END)
            .nth(1)
            .map(|s| s.trim_start())
            .unwrap_or("");
        format!("{before}\n\n{block}\n{after}")
    } else if existing.trim().is_empty() {
        format!("{block}\n")
    } else {
        format!("{existing}\n\n{block}\n")
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("PI.md parent: {e}"))?;
    }
    std::fs::write(path, next).map_err(|e| format!("write {}: {e}", path.display()))
}

fn pi_md_block(
    home: &Path,
    project: &Path,
    models: &Path,
    mode: &str,
    routing: &str,
) -> String {
    format!(
        r#"{PI_MD_BEGIN}
## Blackwell Ops — pi (managed)

### Paths (do not invent `~/.pi`)

| Role | Absolute path |
|------|----------------|
| **PI_CODING_AGENT_DIR** (models, settings, sessions) | `{home}` |
| **Project cwd** (workspace / default file ops) | `{project}` |
| **models.json** | `{models}` |

- pi config lives under **PI_CODING_AGENT_DIR**, not `%USERPROFILE%\.pi` or a global npm install.
- Install binary lives under `external-tools/pi/` (self-contained pi.exe, no Node/Bun needed).

### Model routing

Launch mode: **{mode}**

{routing}
{PI_MD_END}
"#,
        home = home.display(),
        project = project.display(),
        models = models.display(),
        mode = mode,
        routing = routing,
    )
}

fn write_pi_context_files(
    home: &Path,
    project: &Path,
    models: &Path,
    mode: &str,
    routing: &str,
) -> Result<(), String> {
    let block = pi_md_block(home, project, models, mode, routing);
    upsert_pi_md(&home.join("PI.md"), &block)?;
    upsert_pi_md(&project.join("PI.md"), &block)?;
    Ok(())
}

/// Session bat hard-codes PI_CODING_AGENT_DIR — Start-Process env inheritance
/// is unreliable on PS 5.1 (same pattern as QWEN_HOME).
fn write_session_launch_bat(home: &Path, launcher: &Path, project: &Path) -> Result<PathBuf, String> {
    let bat = home.join("launch-session.cmd");
    let home_s = home.to_string_lossy().replace('"', "");
    let launch_s = launcher.to_string_lossy().replace('"', "");
    let proj_s = project.to_string_lossy().replace('"', "");
    let body = format!(
        "@echo off\r\n\
         setlocal\r\n\
         REM Blackwell managed — forces isolated home (never %USERPROFILE%\\.pi)\r\n\
         set \"PI_CODING_AGENT_DIR={home_s}\"\r\n\
         cd /d \"{proj_s}\"\r\n\
         call \"{launch_s}\"\r\n\
         endlocal\r\n"
    );
    std::fs::write(&bat, body).map_err(|e| format!("write launch-session.cmd: {e}"))?;
    Ok(bat)
}

#[cfg(windows)]
fn spawn_pi_console(launcher: &Path, home: &Path, project: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let session_bat = write_session_launch_bat(home, launcher, project)?;
    let q = |s: &str| s.replace('\'', "''");
    let bat_s = q(&session_bat.to_string_lossy());
    let proj_s = q(&project.to_string_lossy());
    let home_s = q(&home.to_string_lossy());

    // Visible console via start; session bat sets PI_CODING_AGENT_DIR before pi.cmd.
    let ps = format!(
        "$env:PI_CODING_AGENT_DIR = '{home_s}'; \
         Start-Process -FilePath 'cmd.exe' \
           -WorkingDirectory '{proj_s}' \
           -ArgumentList @('/c', 'call', '\"{bat_s}\"') \
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
        .env("PI_CODING_AGENT_DIR", home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Failed to spawn pi: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn pi_code_launch(
    app: tauri::AppHandle,
    request: PiLaunchRequest,
) -> Result<PiLaunchResult, String> {
    #[cfg(not(windows))]
    {
        let _ = (app, request);
        return Err("pi launch is only supported on Windows.".into());
    }

    #[cfg(windows)]
    {
        if !disclaimer_path().is_file() {
            return Err("Accept the pi disclaimer first.".into());
        }
        if !is_installed() {
            return Err("pi is not installed in external-tools. Install it first.".into());
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

        let mode = request.mode.trim().to_lowercase();
        let (models_str, settings_str, routing) = build_models_and_settings(&request)?;
        let models_file = models_path();
        std::fs::write(&models_file, &models_str).map_err(|e| format!("write models: {e}"))?;
        let settings_file = settings_path();
        std::fs::write(&settings_file, &settings_str).map_err(|e| format!("write settings: {e}"))?;
        emit_dbg(&format!(
            "[Pi] Wrote models.json → {} ({} bytes)",
            models_file.display(),
            models_str.len()
        ));

        if let Err(e) = write_pi_context_files(&home, &project, &models_file, &mode, &routing) {
            emit_dbg(&format!("[Pi] PI.md write warning: {e}"));
        }

        let _ = std::fs::write(
            last_project_path(),
            format!("{}\n", project.to_string_lossy()),
        );

        let launcher = launcher_path();
        spawn_pi_console(&launcher, &home, &project)?;

        let _ = app;
        emit_dbg(&format!(
            "[Pi] Launched ({mode}) project={} PI_CODING_AGENT_DIR={}",
            project.display(),
            home.display()
        ));

        Ok(PiLaunchResult {
            launcher_path: launcher.to_string_lossy().to_string(),
            models_path: models_file.to_string_lossy().to_string(),
            project_dir: project.to_string_lossy().to_string(),
            mode,
            home_path: home.to_string_lossy().to_string(),
        })
    }
}
