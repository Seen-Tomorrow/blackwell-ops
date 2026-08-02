//! Qwen Code external coding harness — external tool (not core app).
//!
//! Install: `{app_root}/external-tools/qwen-code/`
//! Home:    `{app_root}/config/external-tools/qwencode-home/`  (QWEN_HOME)
//! Never uses the user's PATH or `~\.qwen` (unless we add "use existing" later).
//! Standalone pack = embedded Node + app on disk (~180 MB), not a single PE.

use serde::{Deserialize, Serialize};
use crate::external_agents::emit_dbg;
use std::path::{Path, PathBuf};

/// Pinned standalone release we verified against local OpenAI engines.
pub const PINNED_VERSION: &str = "0.21.0";

const GITHUB_RELEASE_BASE: &str = "https://github.com/QwenLM/qwen-code/releases/download";

// ── Paths ──────────────────────────────────────────────────────────────

fn tools_dir() -> PathBuf {
    crate::config::app_root_dir()
        .join("external-tools")
        .join("qwen-code")
}

fn package_dir() -> PathBuf {
    tools_dir().join("qwen-code")
}

/// Outer launcher (Blackwell shim).
pub fn launcher_path() -> PathBuf {
    tools_dir().join("bin").join("qwen.cmd")
}

fn package_node() -> PathBuf {
    package_dir().join("node").join("node.exe")
}

fn package_cli() -> PathBuf {
    package_dir().join("lib").join("cli-entry.js")
}

pub fn home_dir() -> PathBuf {
    crate::config::config_dir()
        .join("external-tools")
        .join("qwencode-home")
}

/// One-time move from legacy runtime/tools + config/qwen-home paths.
fn migrate_legacy_paths() {
    let root = crate::config::app_root_dir();
    let cfg = crate::config::config_dir();
    let new_tools = tools_dir();
    for old in [
        root.join("runtime").join("tools").join("qwen-standalone"),
        root.join("external-tools").join("qwen-standalone"),
    ] {
        if !new_tools.exists() && old.is_dir() {
            if let Some(parent) = new_tools.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::rename(&old, &new_tools);
            break;
        }
    }
    let new_home = home_dir();
    for old in [cfg.join("qwen-home"), cfg.join("external-tools").join("qwen-home")] {
        if !new_home.exists() && old.is_dir() {
            if let Some(parent) = new_home.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::rename(&old, &new_home);
            break;
        }
    }
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

fn settings_path() -> PathBuf {
    home_dir().join("settings.json")
}

// ── Status ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QwenCodeStatus {
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
    launcher_path().is_file() && package_node().is_file() && package_cli().is_file()
}

fn probe_version() -> Option<String> {
    let launcher = launcher_path();
    if !launcher.is_file() {
        return None;
    }
    let out = std::process::Command::new("cmd")
        .args(["/c", &launcher.to_string_lossy(), "--version"])
        .env("QWEN_HOME", home_dir())
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
pub async fn qwen_code_status() -> Result<QwenCodeStatus, String> {
    migrate_legacy_paths();
    let installed = is_installed();
    let version = if installed {
        read_version_stamp().or_else(probe_version)
    } else {
        None
    };
    let last_project = crate::external_agents::read_trimmed(&last_project_path());
    Ok(QwenCodeStatus {
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
pub async fn qwen_code_accept_disclaimer() -> Result<(), String> {
    crate::external_agents::write_disclaimer(&home_dir(), PINNED_VERSION)
}

#[tauri::command]
pub async fn qwen_code_set_project(project_dir: String) -> Result<QwenCodeStatus, String> {
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
    qwen_code_status().await
}

// ── Install ────────────────────────────────────────────────────────────

fn release_zip_url(version: &str) -> String {
    // Tag uses v-prefix on GitHub releases.
    let tag = if version.starts_with('v') {
        version.to_string()
    } else {
        format!("v{version}")
    };
    format!("{GITHUB_RELEASE_BASE}/{tag}/qwen-code-win-x64.zip")
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
        // "hex  name" or "hex *name"
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next()?.trim_start_matches('*');
        if name.eq_ignore_ascii_case(archive_name) && hash.len() == 64 {
            return Some(hash.to_ascii_lowercase());
        }
    }
    None
}

fn write_outer_shim(tools: &Path) -> Result<(), String> {
    let bin = tools.join("bin");
    std::fs::create_dir_all(&bin).map_err(|e| format!("bin dir: {e}"))?;
    // ROOT = package (qwen-code) relative to bin/
    let shim = r#"@echo off
setlocal
REM Blackwell-isolated outer launcher (package lives in ..\qwen-code)
set "PKG=%~dp0..\qwen-code"
set "QWEN_CODE_LAUNCHER_PATH=%~f0"
"%PKG%\node\node.exe" "%PKG%\lib\cli-entry.js" %*
exit /b %ERRORLEVEL%
"#;
    std::fs::write(bin.join("qwen.cmd"), shim).map_err(|e| format!("write shim: {e}"))?;
    Ok(())
}

fn extract_zip_windows(zip: &Path, dest: &Path) -> Result<(), String> {
    // No zip crate in tree — PowerShell Expand-Archive is reliable on Win10+.
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

#[tauri::command]
pub async fn qwen_code_install(
    app: tauri::AppHandle,
    version: Option<String>,
) -> Result<QwenCodeStatus, String> {
    #[cfg(not(windows))]
    {
        let _ = (app, version);
        return Err("Qwen Code install is only supported on Windows.".into());
    }

    #[cfg(windows)]
    {
        if !disclaimer_path().is_file() {
            return Err(
                "Accept the Qwen Code disclaimer first (qwen_code_accept_disclaimer).".into(),
            );
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

        let zip_url = release_zip_url(&ver);
        let sums_url = release_sums_url(&ver);
        emit_dbg(&format!("[QwenCode] Downloading standalone {ver}…"));
        emit_dbg(&format!("[QwenCode] {zip_url}"));

        let zip_bytes = crate::external_agents::download_bytes(&zip_url).await?;
        if zip_bytes.len() < 1_000_000 {
            return Err(format!(
                "Standalone zip too small ({} bytes) — release may be missing: {zip_url}",
                zip_bytes.len()
            ));
        }
        let actual = crate::external_agents::sha256_hex(&zip_bytes);
        let sums_text = match crate::external_agents::download_bytes(&sums_url).await {
            Ok(b) => String::from_utf8_lossy(&b).to_string(),
            Err(e) => {
                emit_dbg(&format!("[QwenCode] SHA256SUMS download failed: {e}"));
                String::new()
            }
        };
        if let Some(expected) = parse_sums_expected(&sums_text, "qwen-code-win-x64.zip") {
            if expected != actual {
                return Err(format!(
                    "Checksum mismatch for qwen-code-win-x64.zip: expected {expected}, got {actual}"
                ));
            }
            emit_dbg("[QwenCode] SHA-256 OK");
        } else {
            emit_dbg(&format!(
                "[QwenCode] No SHA256SUMS entry — proceeding with sha256={actual}"
            ));
        }

        let zip_path = tools.join("qwen-code-win-x64.download.zip");
        std::fs::write(&zip_path, &zip_bytes).map_err(|e| format!("write zip: {e}"))?;

        let extract_root = tools.join("_extract");
        if extract_root.exists() {
            let _ = std::fs::remove_dir_all(&extract_root);
        }
        std::fs::create_dir_all(&extract_root).map_err(|e| format!("extract dir: {e}"))?;
        extract_zip_windows(&zip_path, &extract_root)?;

        // Zip contains top-level `qwen-code/`
        let extracted_pkg = extract_root.join("qwen-code");
        if !extracted_pkg.is_dir() {
            let _ = std::fs::remove_dir_all(&extract_root);
            let _ = std::fs::remove_file(&zip_path);
            return Err("Archive missing top-level qwen-code/ directory.".into());
        }
        if !extracted_pkg.join("node").join("node.exe").is_file() {
            return Err("Archive missing node/node.exe.".into());
        }
        if !extracted_pkg.join("lib").join("cli-entry.js").is_file() {
            return Err("Archive missing lib/cli-entry.js.".into());
        }

        let dest_pkg = package_dir();
        if dest_pkg.exists() {
            std::fs::remove_dir_all(&dest_pkg).map_err(|e| {
                format!(
                    "Cannot replace {}: {e}. Close any running Qwen from Blackwell and retry.",
                    dest_pkg.display()
                )
            })?;
        }
        if let Err(e) = std::fs::rename(&extracted_pkg, &dest_pkg) {
            copy_dir_all(&extracted_pkg, &dest_pkg).map_err(|e2| {
                format!("install move failed: {e} / {e2}")
            })?;
        }

        write_outer_shim(&tools)?;
        std::fs::write(version_stamp_path(), format!("{ver}\n"))
            .map_err(|e| format!("version stamp: {e}"))?;

        let _ = std::fs::remove_dir_all(&extract_root);
        let _ = std::fs::remove_file(&zip_path);

        let _ = app;
        emit_dbg(&format!(
            "[QwenCode] Installed → {}",
            launcher_path().display()
        ));
        qwen_code_status().await
    }
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

// ── Launch ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QwenEngineRef {
    pub port: u16,
    /// OpenAI model id — must match engine launch alias.
    pub model: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QwenLaunchRequest {
    /// `solo` | `brain_workers`
    pub mode: String,
    pub primary: QwenEngineRef,
    pub worker: Option<QwenEngineRef>,
    pub project_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QwenLaunchResult {
    pub launcher_path: String,
    pub settings_path: String,
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

fn env_key_for_port(port: u16) -> String {
    format!("QWEN_CUSTOM_API_KEY_BLACKWELL_{port}")
}

/// Build isolated settings.json + markdown routing table for QWEN.md.
fn build_settings_and_routing(req: &QwenLaunchRequest) -> Result<(String, String), String> {
    if req.primary.port == 0 {
        return Err("Primary engine port is 0.".into());
    }
    let mode = req.mode.trim().to_lowercase();
    let primary_model = openai_model_id(&req.primary.model);
    let primary_url = format!("http://127.0.0.1:{}/v1", req.primary.port);
    let primary_key = env_key_for_port(req.primary.port);

    let mut env_map = serde_json::Map::new();
    env_map.insert(
        primary_key.clone(),
        serde_json::Value::String("blackwell-local".into()),
    );

    // Qwen uniqueness = (id + baseUrl). `/model` and routing use `id`.
    // Stable ids: brain | worker | local. Display name carries alias + port.
    // Twin: fastModel + exploreModel = worker so subagents/"fast" leave the brain seat.
    let is_twin = matches!(
        mode.as_str(),
        "brain_workers" | "brain+workers" | "dual"
    );

    let (providers, selected_id, selected_url, routing_table) = match mode.as_str() {
        "solo" => {
            let label = format!("SOLO - {primary_model} - :{}", req.primary.port);
            let providers = vec![provider_entry(
                "local",
                &label,
                &primary_model,
                &primary_url,
                &primary_key,
                true,
            )];
            let table = format!("| `local` | SOLO | `{primary_model}` | `{primary_url}` |");
            (providers, "local".to_string(), primary_url.clone(), table)
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
            let w_model = openai_model_id(&worker.model);
            let w_url = format!("http://127.0.0.1:{}/v1", worker.port);
            let w_key = env_key_for_port(worker.port);
            env_map.insert(w_key.clone(), serde_json::Value::String("blackwell-local".into()));
            let brain_label = format!("BRAIN - {primary_model} - :{}", req.primary.port);
            let worker_label = format!("WORKER - {w_model} - :{}", worker.port);
            let providers = vec![
                provider_entry(
                    "brain",
                    &brain_label,
                    &primary_model,
                    &primary_url,
                    &primary_key,
                    true,
                ),
                provider_entry(
                    "worker",
                    &worker_label,
                    &w_model,
                    &w_url,
                    &w_key,
                    true,
                ),
            ];
            let table = format!(
                "| `brain` | BRAIN (default chat) | `{primary_model}` | `{primary_url}` |\n\
                 | `worker` | WORKER (fastModel + worker-* agents) | `{w_model}` | `{w_url}` |"
            );
            (providers, "brain".to_string(), primary_url.clone(), table)
        }
        other => return Err(format!("Unknown Qwen launch mode: {other}")),
    };

    let home_note = home_dir().to_string_lossy().to_string();
    let mut root = serde_json::json!({
        "ui": {
            "autoModeAcknowledged": true
        },
        "env": env_map,
        "modelProviders": {
            "openai": providers
        },
        "security": {
            "auth": {
                "selectedType": "openai"
            }
        },
        // model.name must match a modelProviders.openai[].id for the picker/default
        "model": {
            "name": selected_id,
            "baseUrl": selected_url
        },
        "$version": 4,
        "_blackwell": {
            "managed": true,
            "qwenHome": home_note,
            "routing": "Main chat: /model brain|worker. Subagents: model:worker or fastModel. Agent cannot self-switch main model.",
            "note": "Isolated QWEN_HOME (not %USERPROFILE%\\.qwen). Twin = distinct baseUrl ports."
        }
    });

    if is_twin {
        // Qwen UI persists selectors as authType:modelId (e.g. "openai:worker").
        // Bare "worker" is often ignored; match the runtime form exactly.
        root["fastModel"] = serde_json::json!("openai:worker");
        root["agents"] = serde_json::json!({
            "builtin": {
                "exploreModel": "openai:worker"
            }
        });
    }

    let settings =
        serde_json::to_string_pretty(&root).map_err(|e| format!("settings json: {e}"))?;
    Ok((settings, routing_table))
}

/// `engine_alias` = OpenAI model string for llama-server (stored in description).
fn provider_entry(
    id: &str,
    display_name: &str,
    engine_alias: &str,
    base_url: &str,
    env_key: &str,
    vision: bool,
) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "name": display_name,
        "description": format!("OpenAI model id / engine alias: {engine_alias}"),
        "baseUrl": base_url,
        "envKey": env_key,
        "generationConfig": {
            "extra_body": {
                "enable_thinking": true
            },
            "modalities": {
                "image": vision,
                "video": vision
            }
        }
    })
}

const QWEN_MD_BEGIN: &str = "<!-- BLACKWELL-QWEN:BEGIN -->";
const QWEN_MD_END: &str = "<!-- BLACKWELL-QWEN:END -->";

fn qwen_md_block(
    home: &Path,
    project: &Path,
    settings: &Path,
    mode: &str,
    routing_table: &str,
) -> String {
    format!(
        r#"{QWEN_MD_BEGIN}
## Blackwell Ops — Qwen Code (managed)

### Paths (do not invent `~/.qwen`)

| Role | Absolute path |
|------|----------------|
| **QWEN_HOME** (settings, this file if user-scoped) | `{home}` |
| **Project cwd** (workspace / default file ops) | `{project}` |
| **settings.json** | `{settings}` |

- Prefer project files under **Project cwd**.
- Config / session state live under **QWEN_HOME**, not `%USERPROFILE%\.qwen`.
- Install binary lives under `external-tools/qwen-code/` (not npm global).

### Model routing (how to switch engines)

Qwen identifies models by **`id` + `baseUrl`** in `settings.json` → `modelProviders.openai[]`.
Use **`/model <id>`** (not the raw GGUF name alone).

Launch mode: **{mode}**

| id (use with `/model`) | Role | Engine alias (OpenAI model string) | Endpoint |
|------------------------|------|--------------------------------------|----------|
{routing_table}

- Default **main** chat model is **`brain`** (twin) or **`local`** (solo).
- You (the agent) **cannot** switch the main session model; the user uses **`/model brain`** or **`/model worker`**.
- **Twin only:** `fastModel` and Explore use **`openai:worker`** (authType:modelId). Prefer **`worker-coder`** / **`worker-explore`** for implementation / parallel work so those calls hit the WORKER port.
- Named subagents use YAML frontmatter `model: openai:worker` (not inherit) for the worker seat.
- `ENGINE_*` names are llama-server **aliases**; harness routing keys are **`brain` / `worker` / `local`**.

### Vision

Image paste is enabled (`modalities.image/video`). Prefer multimodal tasks on the BRAIN/`local` seat.
{QWEN_MD_END}
"#,
        home = home.display(),
        project = project.display(),
        settings = settings.display(),
        mode = mode,
        routing_table = routing_table,
    )
}

/// Seed project + home agents so delegated work can use `model: worker`.
fn write_worker_agents(home: &Path, project: &Path) -> Result<(), String> {
    let worker_coder = r#"---
name: worker-coder
description: Implementation and parallel coding on the WORKER engine (Blackwell twin). Prefer for file edits, refactors, tests, and multi-file execution. Does not own high-level architecture.
model: openai:worker
---

You are the WORKER seat on a local twin-engine setup.

- Execute concrete coding tasks: edits, searches, tests, mechanical refactors.
- Stay in the project working directory unless told otherwise.
- Do not re-plan the whole architecture; return results for the BRAIN/main chat to integrate.
- If a task needs multimodal vision of UI screenshots, say so and let the main (brain) seat handle it when appropriate.
"#;

    let worker_explore = r#"---
name: worker-explore
description: Codebase exploration on the WORKER engine (Blackwell twin). Prefer for multi-path search, inventory, and parallel research forks.
model: openai:worker
---

You are the WORKER explore seat.

- Search and map code quickly; report paths, findings, and open questions.
- Prefer tools over long speculation.
- Do not make large edits unless explicitly asked; hand implementation to worker-coder or the main agent.
"#;

    for dir in [
        home.join("agents"),
        project.join(".qwen").join("agents"),
    ] {
        std::fs::create_dir_all(&dir).map_err(|e| format!("agents dir {}: {e}", dir.display()))?;
        std::fs::write(dir.join("worker-coder.md"), worker_coder)
            .map_err(|e| format!("write worker-coder: {e}"))?;
        std::fs::write(dir.join("worker-explore.md"), worker_explore)
            .map_err(|e| format!("write worker-explore: {e}"))?;
    }
    Ok(())
}

/// Upsert managed block into a QWEN.md (home and/or project).
fn upsert_qwen_md(path: &Path, block: &str) -> Result<(), String> {
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    let next = if existing.contains(QWEN_MD_BEGIN) && existing.contains(QWEN_MD_END) {
        let before = existing.split(QWEN_MD_BEGIN).next().unwrap_or("").trim_end();
        let after = existing
            .split(QWEN_MD_END)
            .nth(1)
            .map(|s| s.trim_start())
            .unwrap_or("");
        format!("{before}\n\n{block}\n{after}")
    } else if existing.trim().is_empty() {
        format!("# Qwen Code context\n\n{block}\n")
    } else {
        format!("{existing}\n\n{block}\n")
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("QWEN.md parent: {e}"))?;
    }
    std::fs::write(path, next).map_err(|e| format!("write {}: {e}", path.display()))
}

fn write_qwen_context_files(
    home: &Path,
    project: &Path,
    settings: &Path,
    mode: &str,
    routing_table: &str,
) -> Result<(), String> {
    let block = qwen_md_block(home, project, settings, mode, routing_table);
    // User-scoped context (always loaded from QWEN_HOME)
    upsert_qwen_md(&home.join("QWEN.md"), &block)?;
    // Project-scoped context (cwd-relative; agent sees this in workspace)
    upsert_qwen_md(&project.join("QWEN.md"), &block)?;
    Ok(())
}

/// Session bat hard-codes QWEN_HOME — Start-Process env inheritance is unreliable on PS 5.1.
fn write_session_launch_bat(home: &Path, launcher: &Path, project: &Path) -> Result<PathBuf, String> {
    let bat = home.join("launch-session.cmd");
    // cmd: set "VAR=value" with spaces; strip quotes from values for safety in set line
    let home_s = home.to_string_lossy().replace('"', "");
    let launch_s = launcher.to_string_lossy().replace('"', "");
    let proj_s = project.to_string_lossy().replace('"', "");
    let body = format!(
        "@echo off\r\n\
         setlocal\r\n\
         REM Blackwell managed — forces isolated home (never %USERPROFILE%\\.qwen)\r\n\
         set \"QWEN_HOME={home_s}\"\r\n\
         cd /d \"{proj_s}\"\r\n\
         call \"{launch_s}\"\r\n\
         endlocal\r\n"
    );
    std::fs::write(&bat, body).map_err(|e| format!("write launch-session.cmd: {e}"))?;
    Ok(bat)
}

#[cfg(windows)]
fn spawn_qwen_console(launcher: &Path, home: &Path, project: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let session_bat = write_session_launch_bat(home, launcher, project)?;
    let q = |s: &str| s.replace('\'', "''");
    let bat_s = q(&session_bat.to_string_lossy());
    let proj_s = q(&project.to_string_lossy());
    let home_s = q(&home.to_string_lossy());

    // Visible console via start; session bat sets QWEN_HOME before qwen.cmd.
    let ps = format!(
        "$env:QWEN_HOME = '{home_s}'; \
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
        .env("QWEN_HOME", home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Failed to spawn Qwen Code: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn qwen_code_launch(
    app: tauri::AppHandle,
    request: QwenLaunchRequest,
) -> Result<QwenLaunchResult, String> {
    #[cfg(not(windows))]
    {
        let _ = (app, request);
        return Err("Qwen Code launch is only supported on Windows.".into());
    }

    #[cfg(windows)]
    {
        migrate_legacy_paths();
        if !disclaimer_path().is_file() {
            return Err("Accept the Qwen Code disclaimer first.".into());
        }
        if !is_installed() {
            return Err(
                "Qwen Code is not installed in external-tools. Install it first.".into(),
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

        let mode = request.mode.trim().to_lowercase();
        let (settings, routing_table) = build_settings_and_routing(&request)?;
        let settings_file = settings_path();
        std::fs::write(&settings_file, &settings).map_err(|e| format!("write settings: {e}"))?;
        emit_dbg(&format!(
            "[QwenCode] Wrote settings → {} ({} bytes)",
            settings_file.display(),
            settings.len()
        ));

        if let Err(e) = write_qwen_context_files(
            &home,
            &project,
            &settings_file,
            &mode,
            &routing_table,
        ) {
            emit_dbg(&format!("[QwenCode] QWEN.md write warning: {e}"));
        }

        if matches!(mode.as_str(), "brain_workers" | "brain+workers" | "dual") {
            if let Err(e) = write_worker_agents(&home, &project) {
                emit_dbg(&format!("[QwenCode] agents write warning: {e}"));
            } else {
                emit_dbg("[QwenCode] Seeded worker-coder + worker-explore (model: worker)");
            }
        }

        let _ = std::fs::write(
            last_project_path(),
            format!("{}\n", project.to_string_lossy()),
        );

        let launcher = launcher_path();
        spawn_qwen_console(&launcher, &home, &project)?;

        let _ = app;
        emit_dbg(&format!(
            "[QwenCode] Launched ({mode}) project={} QWEN_HOME={}",
            project.display(),
            home.display()
        ));

        Ok(QwenLaunchResult {
            launcher_path: launcher.to_string_lossy().to_string(),
            settings_path: settings_file.to_string_lossy().to_string(),
            project_dir: project.to_string_lossy().to_string(),
            mode,
            home_path: home.to_string_lossy().to_string(),
        })
    }
}
