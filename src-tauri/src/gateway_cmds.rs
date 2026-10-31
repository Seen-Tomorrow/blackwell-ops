//! Tauri commands for the remote control room.
//!
//! The gateway itself lives in the `oym-gateway` crate. This module is the
//! thin app-side adapter: it projects the running engine stack into model
//! routes and exposes device/session controls to the React UI.

use oym_gateway::protocol::ModelRoute;
use oym_gateway::{
    DeviceView, HealthInfo, PairingInfo, GatewayState, GatewayStatus, RouteBinding, SessionOpen,
    TerminateResult,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use tauri::State;

use crate::engine::AppContext;

/// Project the running engine stack into gateway routes.
///
/// Route ids are derived from the **slot index**, not from a filtered
/// enumeration: the app refreshes routes periodically for local Power Mode, and
/// an index that shifts when an unrelated engine starts or stops would silently
/// re-point a live client's route id at a different engine.
pub(crate) fn running_routes(entries: Vec<crate::types::StackEntry>) -> Vec<RouteBinding> {
    entries
        .into_iter()
        .filter(|entry| entry.status == "RUNNING")
        .map(|entry| RouteBinding {
            route: ModelRoute {
                id: format!("route_{}", entry.idx + 1),
                label: entry.alias.clone(),
                model: entry.alias.clone(),
                context_window: entry.n_ctx.max(1),
                vision: entry.vision,
            },
            engine_port: entry.port,
        })
        .collect()
}

/// Read the running stack and publish its routes to the gateway.
///
/// This is the only route-population path besides a remote session start. It is
/// deliberately independent of sessions: local Power Mode asks the gateway for
/// routes before any session exists, and a running remote session keeps working
/// because model calls resolve routes by id at request time.
///
/// Returns the number of routes published.
pub(crate) async fn refresh_routes(
    stack: &tokio::sync::Mutex<crate::engine_stack::EngineStack>,
    remote: &GatewayState,
) -> usize {
    let routes = {
        let stack = stack.lock().await;
        running_routes(stack.get_status())
    };
    let count = routes.len();
    remote.set_routes(routes).await;
    count
}

#[tauri::command]
pub async fn remote_status(remote: State<'_, Arc<GatewayState>>) -> Result<GatewayStatus, String> {
    Ok(remote.status().await)
}

#[tauri::command]
pub async fn remote_gateway_start(remote: State<'_, Arc<GatewayState>>) -> Result<(), String> {
    remote.start_gateway().await
}

#[tauri::command]
pub async fn remote_gateway_stop(remote: State<'_, Arc<GatewayState>>) -> Result<(), String> {
    remote.stop_gateway().await
}

#[tauri::command]
pub async fn remote_pairing_create(
    remote: State<'_, Arc<GatewayState>>,
) -> Result<PairingInfo, String> {
    Ok(remote.create_pairing().await)
}

#[tauri::command]
pub async fn remote_devices_list(
    remote: State<'_, Arc<GatewayState>>,
) -> Result<Vec<DeviceView>, String> {
    Ok(remote.device_views().await)
}

#[tauri::command]
pub async fn remote_device_rename(
    remote: State<'_, Arc<GatewayState>>,
    device_id: String,
    custom_name: Option<String>,
) -> Result<oym_gateway::DeviceView, String> {
    remote.rename_device(&device_id, custom_name).await
}

#[tauri::command]
pub async fn remote_device_revoke(
    remote: State<'_, Arc<GatewayState>>,
    device_id: String,
) -> Result<(), String> {
    remote.revoke(&device_id).await
}

#[tauri::command]
pub async fn remote_health(
    remote: State<'_, Arc<GatewayState>>,
) -> Result<HealthInfo, String> {
    Ok(remote.health_check().await)
}

#[tauri::command]
pub async fn remote_session_start(
    app: State<'_, AppContext>,
    remote: State<'_, Arc<GatewayState>>,
    device_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<SessionOpen, String> {
    if refresh_routes(&app.stack, &remote).await == 0 {
        return Err("Start an engine (RUNNING) before opening a remote session.".into());
    }
    remote
        .start_session(
            &device_id,
            "pi-maintenance",
            cols.unwrap_or(120),
            rows.unwrap_or(32),
        )
        .await
}

#[tauri::command]
pub async fn remote_session_terminate(
    remote: State<'_, Arc<GatewayState>>,
    device_id: String,
) -> Result<TerminateResult, String> {
    remote.terminate_session(&device_id).await
}

#[tauri::command]
pub async fn remote_session_input(
    remote: State<'_, Arc<GatewayState>>,
    device_id: String,
    data: String,
) -> Result<(), String> {
    remote.send_pty_input(&device_id, data).await
}

#[tauri::command]
pub async fn remote_session_resize(
    remote: State<'_, Arc<GatewayState>>,
    device_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    remote.resize_pty(&device_id, cols, rows).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteView {
    pub id: String,
    pub owner: Option<String>,
    pub created_at: u64,
    pub expires_at: u64,
    pub used_at: Option<u64>,
    pub revoked: bool,
    pub state: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedInvite {
    pub token: String,
    pub invite: InviteView,
}

fn invite_view(record: oym_gateway::invites::InviteRecord) -> InviteView {
    let state = if record.revoked {
        "revoked"
    } else if record.used_at.is_some() {
        "used"
    } else if record.expires_at <= oym_gateway::devices::unix_now() {
        "expired"
    } else {
        "unused"
    };
    InviteView {
        id: record.id,
        owner: record.owner,
        created_at: record.created_at,
        expires_at: record.expires_at,
        used_at: record.used_at,
        revoked: record.revoked,
        state,
    }
}

#[tauri::command]
pub fn remote_invites_list(remote: State<'_, Arc<GatewayState>>) -> Vec<InviteView> {
    let mut invites: Vec<InviteView> = oym_gateway::invites::list(&remote.cfg.data_dir)
        .into_iter()
        .map(invite_view)
        .collect();
    invites.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    invites
}

#[tauri::command]
pub fn remote_invite_create(
    remote: State<'_, Arc<GatewayState>>,
    owner: Option<String>,
    ttl_hours: Option<u64>,
) -> Result<CreatedInvite, String> {
    let ttl = ttl_hours.unwrap_or(oym_gateway::invites::DEFAULT_TTL_HOURS);
    let (token, record) = oym_gateway::invites::create(&remote.cfg.data_dir, owner, ttl)?;
    Ok(CreatedInvite {
        token,
        invite: invite_view(record),
    })
}

#[tauri::command]
pub fn remote_invite_revoke(
    remote: State<'_, Arc<GatewayState>>,
    id: String,
) -> Result<bool, String> {
    oym_gateway::invites::revoke(&remote.cfg.data_dir, &id)
}

#[tauri::command]
pub fn remote_invites_cleanup(
    remote: State<'_, Arc<GatewayState>>,
    scope: String,
) -> Result<usize, String> {
    oym_gateway::invites::cleanup(&remote.cfg.data_dir, &scope)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperBuild {
    pub path: String,
    pub size_bytes: u64,
}

fn repo_script(name: &str) -> Result<PathBuf, String> {
    let mut roots = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors().take(8) {
            roots.push(ancestor.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    for root in roots {
        let candidate = root.join("scripts").join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(format!("{name} not found; this is a DEV build"))
}

fn helper_script() -> Result<PathBuf, String> {
    repo_script("make-oym-helper-nsis.ps1")
}

fn helper_label(owner: &str) -> String {
    let label: String = owner
        .trim()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .take(40)
        .collect();
    if label.is_empty() {
        "support".to_string()
    } else {
        label
    }
}

fn helper_final_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|home| home.join("Downloads"))
        .filter(|path| path.is_dir())
        .unwrap_or_else(std::env::temp_dir)
}

/// Build a one-file helper SFX from a freshly created invite. This is the dev
/// implementation: it invokes the repo packer, which requires the release app,
/// release CLI and the local Pi package to exist.
#[tauri::command]
pub async fn remote_helper_build(
    remote: State<'_, Arc<GatewayState>>,
    invite: String,
    owner: Option<String>,
) -> Result<HelperBuild, String> {
    let public_url = remote
        .cfg
        .public_url
        .clone()
        .ok_or_else(|| "public URL is not configured yet".to_string())?;
    let data_dir = remote.cfg.data_dir.clone();
    let token = invite.trim().to_string();
    if !token.starts_with("oym_inv_") {
        return Err("invalid invite token".into());
    }
    let token_hash = oym_gateway::devices::hash_token(&token);
    let now = oym_gateway::devices::unix_now();
    let valid = oym_gateway::invites::list(&data_dir).into_iter().any(|record| {
        !record.revoked
            && record.used_at.is_none()
            && record.expires_at > now
            && oym_gateway::devices::hash_matches(&record.token_hash, &token_hash)
    });
    if !valid {
        return Err("invite is missing, used, revoked or expired".into());
    }

    let script = helper_script()?;
    let repo_root = script
        .parent()
        .and_then(|path| path.parent())
        .ok_or_else(|| "cannot resolve repo root from helper packer".to_string())?
        .to_path_buf();
    let owner = owner.unwrap_or_else(|| "support".into());
    let label = helper_label(&owner);
    let build_out = repo_root
        .join("tmp")
        .join(format!("OYM-Help-{label}.exe"));
    let final_out = helper_final_dir().join(format!("OYM-Help-{label}.exe"));

    let result = tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = build_out.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("create build dir: {error}"))?;
        }
        let mut command = Command::new("pwsh");
        command
            .arg("-NoProfile")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(&script)
            .arg("-Server")
            .arg(&public_url)
            .arg("-Invite")
            .arg(&token)
            .arg("-Owner")
            .arg(&owner)
            .arg("-OutFile")
            .arg(&build_out)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let output = command
            .output()
            .map_err(|error| format!("start helper packer: {error}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let log_path = repo_root.join("tmp/helper-build.log");
            let combined = format!("--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}\n");
            let _ = std::fs::write(&log_path, &combined);
            let tail: String = combined
                .chars()
                .rev()
                .take(1_500)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            return Err(format!(
                "helper build failed ({}). Full log: {}\n{}",
                output.status,
                log_path.display(),
                tail.trim()
            ));
        }

        let mut output_path = build_out.clone();
        if let Some(parent) = final_out.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if final_out != build_out {
            if std::fs::copy(&build_out, &final_out).is_ok() {
                output_path = final_out;
            }
        }
        let size = std::fs::metadata(&output_path)
            .map_err(|error| format!("read helper output: {error}"))?
            .len();
        Ok(HelperBuild {
            path: output_path.display().to_string(),
            size_bytes: size,
        })
    })
    .await
    .map_err(|error| format!("helper build task: {error}"))??;

    Ok(result)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkBuild {
    pub profile: String,
    pub app: String,
    pub cli: Option<String>,
    pub package: Option<String>,
    pub installer: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkBuildStatus {
    pub state: String,
    pub profile: String,
    pub message: String,
    pub updated_at: String,
    pub running: bool,
    pub result: Option<LinkBuild>,
    pub log_tail: Vec<String>,
}

fn link_build_status_path() -> PathBuf {
    repo_root_path().join("tmp/link-build-status.json")
}

fn link_build_log_path() -> PathBuf {
    repo_root_path().join("tmp/link-build.log")
}

fn repo_root_path() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors().take(8) {
            if ancestor.join("scripts/build-link.ps1").is_file() {
                return ancestor.to_path_buf();
            }
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn read_link_build_log_tail(max_lines: usize) -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(link_build_log_path()) else {
        return Vec::new();
    };
    raw.lines()
        .map(str::to_string)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .take(max_lines)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

/// Start a detached link build. Mirrors the Majestic runner: a visible
/// PowerShell owns the job and writes a status/log the app can poll while the
/// app itself stays responsive and survives a dev restart.
#[tauri::command]
pub async fn remote_link_build_start(profile: String) -> Result<(), String> {
    let profile = profile.trim().to_lowercase();
    if profile != "dev" && profile != "rel" && profile != "installer" {
        return Err("profile must be dev, rel or installer".into());
    }
    let root = repo_root_path();
    let runner = root.join("scripts/run-detached-link-build.ps1");
    if !runner.is_file() {
        return Err(format!("missing link build runner: {}", runner.display()));
    }
    let status = link_build_status_path();
    let log = link_build_log_path();
    if let Some(parent) = status.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create build dir: {e}"))?;
    }
    let seed = serde_json::json!({
        "state": "running",
        "profile": profile,
        "message": "Spawning detached build…",
        "updatedAt": chrono::Local::now().to_rfc3339(),
        "result": null,
    });
    std::fs::write(&status, serde_json::to_string_pretty(&seed).map_err(|e| e.to_string())?)
        .map_err(|e| format!("write build status: {e}"))?;
    std::fs::write(&log, format!("[{}] starting {profile} build\n", chrono::Local::now().to_rfc3339()))
        .map_err(|e| format!("write build log: {e}"))?;

    let root_s = root.to_string_lossy().replace('\'', "''");
    let runner_s = runner.to_string_lossy().replace('\'', "''");
    let status_s = status.to_string_lossy().replace('\'', "''");
    let log_s = log.to_string_lossy().replace('\'', "''");
    let launcher = format!(
        "foreach($n in @('TAURI_CONFIG','TAURI_ANDROID_PACKAGE_NAME','TAURI_ANDROID_PACKAGE_NAME_PREFIX','TAURI_DEV_HOST')){{ Remove-Item \"Env:$n\" -ErrorAction SilentlyContinue }};          $env:NODE_ENV='production';          $wd='{root_s}';          $p=Start-Process -FilePath powershell.exe -WorkingDirectory $wd          -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','{runner_s}','-Profile','{profile}','-StatusFile','{status_s}','-LogFile','{log_s}')          -WindowStyle Normal -PassThru;          if($null -eq $p){{ exit 1 }}; Write-Output $p.Id"
    );

    let output = tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &launcher])
            .current_dir(&root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        command.output()
    })
    .await
    .map_err(|e| format!("link build spawn: {e}"))?
    .map_err(|e| format!("link build spawn: {e}"))?;

    if !output.status.success() {
        let message = format!(
            "could not start detached link build: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        let failed = serde_json::json!({
            "state": "failed",
            "profile": profile,
            "message": message,
            "updatedAt": chrono::Local::now().to_rfc3339(),
            "result": null,
        });
        let _ = std::fs::write(&status, serde_json::to_string_pretty(&failed).unwrap_or_default());
        return Err(message);
    }
    Ok(())
}

#[tauri::command]
pub fn remote_link_build_status() -> Result<LinkBuildStatus, String> {
    let raw = match std::fs::read_to_string(link_build_status_path()) {
        Ok(raw) => raw,
        Err(_) => {
            return Ok(LinkBuildStatus {
                state: "idle".into(),
                profile: String::new(),
                message: String::new(),
                updated_at: String::new(),
                running: false,
                result: None,
                log_tail: read_link_build_log_tail(120),
            })
        }
    };
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse build status: {e}"))?;
    let state = value.get("state").and_then(|v| v.as_str()).unwrap_or("idle").to_string();
    Ok(LinkBuildStatus {
        running: state == "running",
        profile: value.get("profile").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        message: value.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        updated_at: value.get("updatedAt").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        result: value
            .get("result")
            .cloned()
            .filter(|v| !v.is_null())
            .and_then(|v| serde_json::from_value(v).ok()),
        state,
        log_tail: read_link_build_log_tail(120),
    })
}

#[cfg(test)]
mod tests {
    use super::running_routes;
    use crate::types::StackEntry;

    fn entry(idx: usize, status: &str, alias: &str, port: u16, n_ctx: usize, vision: bool) -> StackEntry {
        serde_json::from_value(serde_json::json!({
            "idx": idx,
            "alias": alias,
            "model_name": alias,
            "port": port,
            "gpu": "CUDA0",
            "status": status,
            "n_ctx": n_ctx,
            "vision": vision,
        }))
        .expect("stack entry fixture")
    }

    #[test]
    fn routes_only_expose_running_engines_keyed_by_slot() {
        // Slot 1 is stopped. Its route id (route_2) must stay unused rather than
        // letting the next running engine slide down to route_2: a live local
        // client resolves model calls by route id, and an id that re-points at a
        // different engine when an unrelated slot starts/stops is silent corruption.
        let routes = running_routes(vec![
            entry(0, "RUNNING", "ENGINE_1", 8101, 32768, false),
            entry(1, "STOPPED", "ENGINE_2", 8102, 32768, false),
            entry(2, "RUNNING", "ENGINE_3", 8103, 65536, true),
        ]);

        assert_eq!(routes.len(), 2, "only RUNNING slots become routes");
        assert_eq!(routes[0].route.id, "route_1");
        assert_eq!(routes[0].route.label, "ENGINE_1");
        assert_eq!(routes[0].route.model, "ENGINE_1");
        assert_eq!(routes[0].route.context_window, 32768);
        assert!(!routes[0].route.vision);
        assert_eq!(routes[0].engine_port, 8101);

        assert_eq!(routes[1].route.id, "route_3", "route ids follow the slot index");
        assert_eq!(routes[1].route.label, "ENGINE_3");
        assert_eq!(routes[1].route.context_window, 65536);
        assert!(routes[1].route.vision);
        assert_eq!(routes[1].engine_port, 8103);
    }

    #[test]
    fn stopped_stack_publishes_no_routes() {
        assert!(running_routes(vec![entry(0, "IDLE", "ENGINE_1", 8101, 8192, false)]).is_empty());
        assert!(running_routes(Vec::new()).is_empty());
    }

    #[test]
    fn zero_context_is_floored_to_one_token() {
        let routes = running_routes(vec![entry(0, "RUNNING", "ENGINE_1", 8101, 0, false)]);
        assert_eq!(routes[0].route.context_window, 1);
    }
}