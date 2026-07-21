//! DEV distribution policy — single source of truth for NSIS core vs plugin packs.
//! Release builds: commands return errors (UI is DEV-gated).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

static RELEASE_JOB_RUNNING: AtomicBool = AtomicBool::new(false);

const POLICY_VERSION: u32 = 1;
const DEFAULT_PROFILES: &[&str] = &["frontier", "stable"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionPolicy {
    pub policy_version: u32,
    pub nsis_core: BTreeMap<String, Vec<String>>,
    pub plugins: BTreeMap<String, Vec<String>>,
    #[serde(default = "default_plugin_profiles")]
    pub default_plugin_profiles: Vec<String>,
}

fn default_plugin_profiles() -> Vec<String> {
    DEFAULT_PROFILES.iter().map(|s| s.to_string()).collect()
}

impl Default for DistributionPolicy {
    fn default() -> Self {
        let mut nsis_core = BTreeMap::new();
        nsis_core.insert(
            crate::config::DEFAULT_PROVIDER_ID.to_string(),
            vec!["frontier".into(), "stable".into()],
        );
        Self {
            policy_version: POLICY_VERSION,
            nsis_core,
            plugins: BTreeMap::new(),
            default_plugin_profiles: default_plugin_profiles(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileReadiness {
    pub profile: String,
    pub runtime_binary: bool,
    pub foundry_artifact: bool,
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDistributionRow {
    pub id: String,
    pub display_name: String,
    /// `core` | `plugin` | `local`
    pub role: String,
    pub optional_download: bool,
    pub factory_exists: bool,
    pub profiles: Vec<String>,
    pub readiness: Vec<ProfileReadiness>,
    pub all_ready: bool,
    pub pack_commands: Vec<String>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionDashboard {
    pub policy_path: String,
    pub catalog_path: String,
    pub app_version: String,
    pub nsis_core: BTreeMap<String, Vec<String>>,
    pub plugins: BTreeMap<String, Vec<String>>,
    pub providers: Vec<ProviderDistributionRow>,
    pub release_job_running: bool,
    pub workflow_notes: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDistributionInput {
    pub provider_id: String,
    /// `plugin` | `local` (core is fixed to policy nsisCore)
    pub role: String,
    pub profiles: Option<Vec<String>>,
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn policy_path() -> PathBuf {
    repo_root().join("scripts").join("distribution-policy.json")
}

fn catalog_src_path() -> PathBuf {
    // Canonical: runtime-catalog/plugins.json (engine overlays share this tree).
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("runtime-catalog")
        .join("plugins.json")
}

fn factory_src_path(provider_id: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("runtime")
        .join(provider_id)
        .join("config")
        .join(format!("{provider_id}-default-config.json"))
}

fn runtime_src_profile_exe(provider_id: &str, profile: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("runtime")
        .join(provider_id)
        .join(profile)
        .join("llama-server.exe")
}

fn foundry_artifact_exe(provider_id: &str, profile: &str) -> PathBuf {
    crate::config::app_root_dir()
        .join("foundry")
        .join("artifacts")
        .join(provider_id)
        .join(profile)
        .join("Release")
        .join("llama-server.exe")
}

fn assert_dev() -> Result<(), String> {
    if cfg!(debug_assertions) {
        Ok(())
    } else {
        Err("Distribution tools are only available in DEV builds".into())
    }
}

pub fn load_policy() -> Result<DistributionPolicy, String> {
    let path = policy_path();
    if !path.is_file() {
        let p = DistributionPolicy::default();
        save_policy(&p)?;
        return Ok(p);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("Invalid distribution-policy.json: {e}"))
}

pub fn save_policy(policy: &DistributionPolicy) -> Result<(), String> {
    let path = policy_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let raw = serde_json::to_string_pretty(policy)
        .map_err(|e| format!("Failed to serialize policy: {e}"))?;
    std::fs::write(&path, raw + "\n")
        .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    Ok(())
}

fn set_factory_optional_download(provider_id: &str, optional: bool) -> Result<(), String> {
    let path = factory_src_path(provider_id);
    if !path.is_file() {
        return Ok(());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let mut root: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("Invalid factory JSON: {e}"))?;
    if let Some(obj) = root.as_object_mut() {
        obj.insert(
            "optionalDownload".to_string(),
            serde_json::Value::Bool(optional),
        );
    }
    let out = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    let body = format!("{out}\n");
    std::fs::write(&path, &body)
        .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;

    // Also update live runtime next to debug exe if present
    let live = crate::config::factory_default_config_path(provider_id);
    if live.is_file() {
        let _ = std::fs::write(&live, &body);
    }
    Ok(())
}

/// Build plugins.json from policy + factory metadata (DEV + pack scripts).
pub fn regenerate_plugin_catalog_from_policy() -> Result<PathBuf, String> {
    let policy = load_policy()?;
    let mut plugins = Vec::new();

    for (id, profiles) in &policy.plugins {
        let factory_path = factory_src_path(id);
        let (display_name, description, template_type, template_version) =
            if factory_path.is_file() {
                let raw = std::fs::read_to_string(&factory_path).unwrap_or_default();
                let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
                let display = v
                    .get("display_name")
                    .or_else(|| v.get("displayName"))
                    .and_then(|x| x.as_str())
                    .unwrap_or(id)
                    .to_string();
                let desc = v
                    .get("description")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let tt = v
                    .get("template_type")
                    .or_else(|| v.get("templateType"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("ggml-llama")
                    .to_string();
                let tv = v
                    .get("templateVersion")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(1) as u32;
                (display, desc, tt, tv)
            } else {
                (
                    id.clone(),
                    format!("Optional engine plugin ({id})"),
                    "ggml-llama".into(),
                    1,
                )
            };

        plugins.push(serde_json::json!({
            "id": id,
            "displayName": display_name,
            "description": if description.is_empty() {
                format!("Optional engine plugin ({id})")
            } else {
                description
            },
            "templateType": template_type,
            "templateVersion": template_version,
            "profiles": profiles,
        }));
    }

    let catalog = serde_json::json!({
        "catalogVersion": 1,
        "plugins": plugins,
    });
    let out = serde_json::to_string_pretty(&catalog).map_err(|e| e.to_string())?;

    let dest = catalog_src_path();
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    std::fs::write(&dest, out.clone() + "\n")
        .map_err(|e| format!("Failed to write {}: {e}", dest.display()))?;

    // Live app catalog next to debug/release exe
    let live_catalog = crate::config::app_root_dir()
        .join("runtime-catalog")
        .join("plugins.json");
    if let Some(parent) = live_catalog.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&live_catalog, out + "\n");

    Ok(dest)
}

fn profile_readiness(provider_id: &str, profile: &str) -> ProfileReadiness {
    let runtime_binary = runtime_src_profile_exe(provider_id, profile).is_file()
        || crate::config::app_root_dir()
            .join("runtime")
            .join(provider_id)
            .join(profile)
            .join("llama-server.exe")
            .is_file();
    let foundry_artifact = foundry_artifact_exe(provider_id, profile).is_file();
    ProfileReadiness {
        profile: profile.to_string(),
        runtime_binary,
        foundry_artifact,
        ready: runtime_binary || foundry_artifact,
    }
}

fn role_for(provider_id: &str, policy: &DistributionPolicy) -> String {
    if policy.nsis_core.contains_key(provider_id) {
        "core".into()
    } else if policy.plugins.contains_key(provider_id) {
        "plugin".into()
    } else {
        "local".into()
    }
}

fn build_row(
    p: &crate::types::ProviderConfig,
    policy: &DistributionPolicy,
) -> ProviderDistributionRow {
    let role = role_for(&p.id, policy);
    let profiles = match role.as_str() {
        "core" => policy
            .nsis_core
            .get(&p.id)
            .cloned()
            .unwrap_or_else(|| DEFAULT_PROFILES.iter().map(|s| s.to_string()).collect()),
        "plugin" => policy
            .plugins
            .get(&p.id)
            .cloned()
            .unwrap_or_else(|| policy.default_plugin_profiles.clone()),
        _ => policy.default_plugin_profiles.clone(),
    };
    let readiness: Vec<ProfileReadiness> = profiles
        .iter()
        .map(|pr| profile_readiness(&p.id, pr))
        .collect();
    let all_ready = !readiness.is_empty() && readiness.iter().all(|r| r.ready);
    let mut notes = Vec::new();
    let factory_exists = factory_src_path(&p.id).is_file();
    if role == "plugin" && !factory_exists {
        notes.push("Factory JSON missing — EXPORT FACTORY or turn Plugin ON again".into());
    }
    for r in &readiness {
        if !r.ready {
            notes.push(format!(
                "{}: no runtime/ or foundry artifact — Foundry-build then pack",
                r.profile
            ));
        }
    }
    let pack_commands = if role == "plugin" || role == "core" {
        profiles
            .iter()
            .map(|pr| {
                format!(
                    "npm run majestic:pack:provider -- -ProviderId {} -ProfileId {}",
                    p.id, pr
                )
            })
            .collect()
    } else {
        Vec::new()
    };

    ProviderDistributionRow {
        id: p.id.clone(),
        display_name: p.display_name.clone(),
        role,
        optional_download: p.optional_download,
        factory_exists,
        profiles,
        readiness,
        all_ready,
        pack_commands,
        notes,
    }
}

#[tauri::command]
pub fn get_distribution_dashboard(
    app_handle: tauri::AppHandle,
) -> Result<DistributionDashboard, String> {
    assert_dev()?;
    let policy = load_policy()?;
    let providers = {
        let ctx = app_handle.state::<crate::engine::AppContext>();
        let cfg = ctx.config.lock().map_err(|e| e.to_string())?;
        cfg.providers.clone()
    };

    let mut rows: Vec<ProviderDistributionRow> = providers
        .iter()
        .map(|p| build_row(p, &policy))
        .collect();

    // Policy plugins not currently in PROVIDERS (e.g. after UNINSTALL) still show here
    // so DEV can Catalog ON/OFF + Pack without re-installing first.
    let live_ids: std::collections::HashSet<_> =
        providers.iter().map(|p| p.id.as_str()).collect();
    for (id, profiles) in &policy.plugins {
        if live_ids.contains(id.as_str()) {
            continue;
        }
        let readiness: Vec<ProfileReadiness> = profiles
            .iter()
            .map(|pr| profile_readiness(id, pr))
            .collect();
        let all_ready = !readiness.is_empty() && readiness.iter().all(|r| r.ready);
        let factory_exists = factory_src_path(id).is_file();
        let mut notes = vec![
            "Not in PROVIDERS (uninstalled or no engines) — Catalog ON still ships metadata".into(),
        ];
        if !factory_exists {
            notes.push("Factory JSON missing under src-tauri/runtime".into());
        }
        rows.push(ProviderDistributionRow {
            id: id.clone(),
            display_name: id.clone(),
            role: "plugin".into(),
            optional_download: true,
            factory_exists,
            profiles: profiles.clone(),
            readiness,
            all_ready,
            pack_commands: profiles
                .iter()
                .map(|pr| {
                    format!(
                        "npm run majestic:pack:provider -- -ProviderId {id} -ProfileId {pr}"
                    )
                })
                .collect(),
            notes,
        });
    }

    rows.sort_by(|a, b| {
        let rank = |r: &str| match r {
            "core" => 0,
            "plugin" => 1,
            _ => 2,
        };
        rank(&a.role)
            .cmp(&rank(&b.role))
            .then_with(|| a.id.cmp(&b.id))
    });

    Ok(DistributionDashboard {
        policy_path: policy_path().display().to_string(),
        catalog_path: catalog_src_path().display().to_string(),
        app_version: app_handle.package_info().version.to_string(),
        nsis_core: policy.nsis_core,
        plugins: policy.plugins,
        providers: rows,
        release_job_running: RELEASE_JOB_RUNNING.load(Ordering::SeqCst),
        workflow_notes: vec![
            "Weekly Full: NSIS = ggml-master only (nsisCore in policy)".into(),
            "Pack+Ship App: bump + clean REL rebuild + PE identity assert + App .7z + ship".into(),
            "Ship refuses DEV ProductName / version mismatch inside App .7z".into(),
            "Pack+Ship provider: engines for current tag (no bump)".into(),
            "Plugin ON writes policy + optionalDownload + catalog - does not upload".into(),
            "Job output: Tauri console [majestic] lines + visible Majestic console".into(),
        ],
    })
}

#[tauri::command]
pub fn set_provider_distribution(
    app_handle: tauri::AppHandle,
    input: SetDistributionInput,
) -> Result<DistributionDashboard, String> {
    assert_dev()?;
    let role = input.role.trim().to_ascii_lowercase();
    if role != "plugin" && role != "local" {
        return Err("role must be 'plugin' or 'local' (core is fixed in policy nsisCore)".into());
    }

    let mut policy = load_policy()?;
    if policy.nsis_core.contains_key(&input.provider_id) {
        return Err(format!(
            "'{}' is NSIS core — edit distribution-policy.json nsisCore only if intentional",
            input.provider_id
        ));
    }

    let profiles = input
        .profiles
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| policy.default_plugin_profiles.clone());

    // optionalDownload = product type (optional fork, not NSIS core) — always true for non-core.
    // policy.plugins = shipping: include in App catalog / Majestic packs (Plugin ON).
    // Plugin OFF (local) only drops shipping; keeps optionalDownload so empty shells stay hidden
    // and UNINSTALL still works when engines are on disk.
    if role == "plugin" {
        policy.plugins.insert(input.provider_id.clone(), profiles);
        ensure_factory_shell(&app_handle, &input.provider_id)?;
        set_factory_optional_download(&input.provider_id, true)?;
    } else {
        policy.plugins.remove(&input.provider_id);
        // Leave optionalDownload=true on factory if already a plugin-shaped fork.
        set_factory_optional_download(&input.provider_id, true)?;
    }

    save_policy(&policy)?;
    regenerate_plugin_catalog_from_policy()?;

    // Live config: always optional for non-core toggles (shipping is policy-only).
    {
        let ctx = app_handle.state::<crate::engine::AppContext>();
        let mut cfg = ctx.config.lock().map_err(|e| e.to_string())?;
        if let Some(p) = cfg.providers.iter_mut().find(|p| p.id == input.provider_id) {
            p.optional_download = true;
            let _ = crate::config::persist_user_providers_meta(&cfg.providers);
        }
    }

    get_distribution_dashboard(app_handle)
}

fn ensure_factory_shell(
    app_handle: &tauri::AppHandle,
    provider_id: &str,
) -> Result<(), String> {
    let path = factory_src_path(provider_id);
    if path.is_file() {
        return Ok(());
    }
    let provider = {
        let ctx = app_handle.state::<crate::engine::AppContext>();
        let cfg = ctx.config.lock().map_err(|e| e.to_string())?;
        cfg.providers.iter().find(|p| p.id == provider_id).cloned()
    };
    let Some(p) = provider else {
        return Err(format!("Provider '{provider_id}' not in live config"));
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let mut spawn = crate::config::load_master_spawn_profile_map();
    spawn.insert(
        "fit_adapter".into(),
        serde_json::Value::String("ggml_master".into()),
    );
    spawn.insert(
        "fusion_adapter".into(),
        serde_json::Value::String("ggml_master".into()),
    );
    if !p.launch_profile.essential_param_keys.is_empty() {
        spawn.insert(
            "essentialParamKeys".into(),
            serde_json::to_value(&p.launch_profile.essential_param_keys).unwrap_or_default(),
        );
        spawn.insert(
            "simple_param_keys".into(),
            serde_json::to_value(&p.launch_profile.essential_param_keys).unwrap_or_default(),
        );
    }
    let seed = serde_json::json!({
        "id": p.id,
        "display_name": p.display_name,
        "description": format!("Optional engine plugin ({})", p.id),
        "binary_name": "llama-server.exe",
        "git_url": p.git_url,
        "branch": p.branch,
        "build_profile": p.build_profile,
        "template_type": p.template_type,
        "optionalDownload": true,
        "templateVersion": 1,
        "groupOrder": p.group_order,
        "layoutDefaults": {
            "groupDisplayZone": p.group_display_zone,
            "groupColumn": p.group_column,
            "configColumnCount": p.config_column_count.unwrap_or(2),
            "configColumnWidths": p.config_column_widths,
            "aboveColumnWidths": p.above_column_widths
        },
        "params": [],
        "spawn_profile": spawn
    });
    let out = serde_json::to_string_pretty(&seed).map_err(|e| e.to_string())?;
    std::fs::write(&path, out + "\n")
        .map_err(|e| format!("Failed to seed factory {}: {e}", path.display()))?;
    Ok(())
}

#[tauri::command]
pub fn regenerate_distribution_catalog() -> Result<String, String> {
    assert_dev()?;
    let path = regenerate_plugin_catalog_from_policy()?;
    Ok(path.display().to_string())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevReleaseAction {
    /// Single steps or chains:
    /// check_app | check_full | pack_app | pack_full | ship_app | ship_full |
    /// pack_provider | ship_provider | bump |
    /// pack_ship_app (bump+pack+ship) | pack_ship_full | pack_ship_provider
    pub action: String,
    pub provider_id: Option<String>,
    pub profile_id: Option<String>,
}

fn emit_log(app: &tauri::AppHandle, line: &str) {
    // Primary sink: Tauri / cargo console (always open during DEV work).
    log::info!("[majestic] {line}");
    // Secondary: panel job log (plain text).
    let _ = app.emit("dev-release-log", serde_json::json!({ "line": line }));
}

fn majestic_out_dir() -> PathBuf {
    repo_root().join(".majestic-out")
}

fn job_log_path() -> PathBuf {
    majestic_out_dir().join("job-log.txt")
}

fn job_status_path() -> PathBuf {
    majestic_out_dir().join("job-status.json")
}

fn chain_runner_ps1() -> PathBuf {
    repo_root()
        .join("scripts")
        .join("majestic")
        .join("run-detached-chain.ps1")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevReleaseJobStatus {
    pub state: String,
    pub chain: String,
    pub message: String,
    pub updated_at: String,
    pub provider_id: String,
    pub profile_id: String,
    pub log_tail: Vec<String>,
    /// true while status file says running (panel should poll)
    pub running: bool,
}

fn read_job_status_file() -> Option<serde_json::Value> {
    let path = job_status_path();
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// If status says running but the process is gone (or never started), mark failed.
fn heal_stale_running_job() {
    let Some(j) = read_job_status_file() else {
        return;
    };
    if j.get("state").and_then(|x| x.as_str()) != Some("running") {
        return;
    }
    let pid = j.get("pid").and_then(|x| x.as_u64()).unwrap_or(0);
    let updated = j
        .get("updatedAt")
        .and_then(|x| x.as_str())
        .unwrap_or("");
    // Never started (seed) for > 15s, or dead pid
    let stale_seed = pid == 0 && job_status_is_older_than_secs(updated, 15);
    let dead_pid = pid > 0 && !windows_pid_alive(pid as u32);
    if !stale_seed && !dead_pid {
        return;
    }
    let chain = j
        .get("chain")
        .and_then(|x| x.as_str())
        .unwrap_or("?")
        .to_string();
    let msg = if stale_seed {
        "Detached PowerShell never started (stale seed). Retry Pack, or run manually: scripts/majestic/run-detached-chain.ps1"
    } else {
        "Detached job process exited without writing final status"
    };
    let failed = serde_json::json!({
        "state": "failed",
        "chain": chain,
        "message": msg,
        "updatedAt": chrono::Local::now().to_rfc3339(),
        "providerId": j.get("providerId").and_then(|x| x.as_str()).unwrap_or(""),
        "profileId": j.get("profileId").and_then(|x| x.as_str()).unwrap_or(""),
        "pid": pid,
    });
    let _ = std::fs::write(
        job_status_path(),
        serde_json::to_string_pretty(&failed).unwrap_or_default(),
    );
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(job_log_path())
        .and_then(|mut f| {
            use std::io::Write;
            writeln!(f, "[{}] HEAL: {msg}", chrono::Local::now().to_rfc3339())
        });
}

fn job_status_is_older_than_secs(updated_at: &str, secs: i64) -> bool {
    if updated_at.is_empty() {
        return true;
    }
    // Accept RFC3339; if parse fails, treat as stale.
    chrono::DateTime::parse_from_rfc3339(updated_at)
        .map(|dt| {
            let age = chrono::Local::now().signed_duration_since(dt.with_timezone(&chrono::Local));
            age.num_seconds() > secs
        })
        .unwrap_or(true)
}

#[cfg(windows)]
fn windows_pid_alive(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match out {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout);
            s.contains(&pid.to_string())
        }
        Err(_) => true, // unknown — don't mark failed
    }
}

#[cfg(not(windows))]
fn windows_pid_alive(_pid: u32) -> bool {
    true
}

fn read_log_tail(max_lines: usize) -> Vec<String> {
    let path = job_log_path();
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    raw.lines()
        .map(|s| s.to_string())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .take(max_lines)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

#[tauri::command]
pub fn get_dev_release_job_status() -> Result<DevReleaseJobStatus, String> {
    assert_dev()?;
    heal_stale_running_job();
    let v = read_job_status_file();
    let (state, chain, message, updated_at, provider_id, profile_id) = match v {
        Some(j) => (
            j.get("state")
                .and_then(|x| x.as_str())
                .unwrap_or("idle")
                .to_string(),
            j.get("chain")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            j.get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            j.get("updatedAt")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            j.get("providerId")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            j.get("profileId")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
        ),
        None => (
            "idle".into(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
        ),
    };
    let running = state == "running";
    Ok(DevReleaseJobStatus {
        state,
        chain,
        message,
        updated_at,
        provider_id,
        profile_id,
        log_tail: read_log_tail(200),
        running,
    })
}

/// Long jobs (pack/ship/bump) run in a **detached** PowerShell so tauri dev
/// restarts from version-file bumps do not kill the chain mid-flight.
#[tauri::command]
pub async fn run_dev_release_action(
    app_handle: tauri::AppHandle,
    action: DevReleaseAction,
) -> Result<String, String> {
    assert_dev()?;

    // Fast paths stay in-process (no detached console).
    // Bump is quick version-file edits — run inline so UI can refresh immediately.
    if action.action == "check_app" || action.action == "check_full" || action.action == "bump" {
        if RELEASE_JOB_RUNNING.swap(true, Ordering::SeqCst) {
            return Err("A release job is already running".into());
        }
        let result = tokio::task::spawn_blocking({
            let app = app_handle.clone();
            let action = action.clone();
            move || {
                if action.action == "bump" {
                    run_bump_inline(&app)
                } else {
                    run_check_inline(&app, &action)
                }
            }
        })
        .await
        .map_err(|e| format!("Job join failed: {e}"));
        RELEASE_JOB_RUNNING.store(false, Ordering::SeqCst);
        return result?;
    }

    if let Some(j) = read_job_status_file() {
        if j.get("state").and_then(|x| x.as_str()) == Some("running") {
            return Err(
                "A detached pack/ship job is already running — open DISTRIBUTION and wait, or delete .majestic-out/job-status.json if stale."
                    .into(),
            );
        }
    }

    tokio::task::spawn_blocking({
        let app = app_handle.clone();
        let action = action.clone();
        move || spawn_detached_chain(&app, &action)
    })
    .await
    .map_err(|e| format!("Spawn join failed: {e}"))?
}

fn run_check_inline(app: &tauri::AppHandle, action: &DevReleaseAction) -> Result<String, String> {
    let variant = if action.action == "check_full" {
        "full"
    } else {
        "app"
    };
    run_majestic_step(app, &["-Mode", "check", "-Variant", variant])?;
    Ok("ok".into())
}

/// Patch version bump only (tauri conf + package.json + Cargo.toml). No pack/ship.
fn run_bump_inline(app: &tauri::AppHandle) -> Result<String, String> {
    run_majestic_step(app, &["-Mode", "bump"])?;
    Ok("ok".into())
}

fn majestic_ps1() -> Result<PathBuf, String> {
    let path = repo_root()
        .join("scripts")
        .join("majestic")
        .join("majestic.ps1");
    if !path.is_file() {
        return Err(format!("Missing {}", path.display()));
    }
    Ok(path)
}

/// One majestic.ps1 invocation with -Force (no YES prompts). In-process only (checks).
fn run_majestic_step(app: &tauri::AppHandle, mode_args: &[&str]) -> Result<(), String> {
    let root = repo_root();
    let majestic = majestic_ps1()?;
    let mut args: Vec<String> = vec![
        "-NoProfile".into(),
        "-ExecutionPolicy".into(),
        "Bypass".into(),
        "-File".into(),
        majestic.to_string_lossy().to_string(),
    ];
    for a in mode_args {
        args.push((*a).into());
    }
    if !mode_args.iter().any(|a| *a == "-Force") {
        args.push("-Force".into());
    }

    emit_log(app, &format!("$ powershell {}", args.join(" ")));

    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let output = std::process::Command::new("powershell.exe")
        .args(&args)
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to spawn powershell: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stdout.lines().chain(stderr.lines()) {
        if !line.trim().is_empty() {
            emit_log(app, line);
        }
    }
    if !output.status.success() {
        return Err(format!(
            "Command failed with exit {:?}",
            output.status.code()
        ));
    }
    Ok(())
}

fn spawn_detached_chain(app: &tauri::AppHandle, action: &DevReleaseAction) -> Result<String, String> {
    let root = repo_root();
    let runner = chain_runner_ps1();
    if !runner.is_file() {
        return Err(format!("Missing chain runner: {}", runner.display()));
    }

    let out = majestic_out_dir();
    std::fs::create_dir_all(&out)
        .map_err(|e| format!("Failed to create .majestic-out: {e}"))?;

    let log = job_log_path();
    let status = job_status_path();

    // Seed status so the panel can poll immediately after app restart.
    let seed = serde_json::json!({
        "state": "running",
        "chain": action.action,
        "message": "Spawning detached PowerShell…",
        "updatedAt": chrono::Local::now().to_rfc3339(),
        "providerId": action.provider_id.clone().unwrap_or_default(),
        "profileId": action.profile_id.clone().unwrap_or_default(),
        "pid": 0,
    });
    std::fs::write(
        &status,
        serde_json::to_string_pretty(&seed).unwrap_or_default(),
    )
    .map_err(|e| format!("Failed to write job status: {e}"))?;
    std::fs::write(
        &log,
        format!(
            "[{}] App spawning detached chain: {}\n",
            chrono::Local::now().to_rfc3339(),
            action.action
        ),
    )
    .ok();

    // Detached visible console without CREATE_BREAKAWAY_FROM_JOB.
    // Breakaway fails with ERROR_ACCESS_DENIED (os error 5) when cargo/tauri/dev
    // hosts put the process in a job that does not allow breakaway — common on Windows.
    // Same pattern as engine::spawn_nobsproof_cmd_window: hidden Start-Process helper.
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

    let runner_s = runner.to_string_lossy().replace('\'', "''");
    let root_s = root.to_string_lossy().replace('\'', "''");
    let chain_s = action.action.replace('\'', "''");

    let mut ps_arg_list = format!(
        "'-NoProfile','-ExecutionPolicy','Bypass','-File','{runner_s}','-Chain','{chain_s}'"
    );
    if let Some(pid) = action.provider_id.as_ref().filter(|s| !s.is_empty()) {
        let p = pid.replace('\'', "''");
        ps_arg_list.push_str(&format!(",'-ProviderId','{p}'"));
    }
    if let Some(prof) = action.profile_id.as_ref().filter(|s| !s.is_empty()) {
        let p = prof.replace('\'', "''");
        ps_arg_list.push_str(&format!(",'-ProfileId','{p}'"));
    }

    emit_log(
        app,
        &format!(
            "Starting DETACHED job with VISIBLE console (log: {}) - survives app restart",
            log.display()
        ),
    );
    emit_log(
        app,
        &format!(
            "$ Start-Process powershell -File {} -Chain {}",
            runner.display(),
            action.action
        ),
    );

    // Start-Process -PassThru returns the real console process Id (not the helper).
    // Scrub TAURI_* from the helper process first so the child does not inherit
    // conf.dev merge env from the running DEV app (ships "Blackwell Ops DEV").
    let launcher = format!(
        "foreach($n in @('TAURI_CONFIG','TAURI_ANDROID_PACKAGE_NAME','TAURI_ANDROID_PACKAGE_NAME_PREFIX','TAURI_DEV_HOST')){{ \
           Remove-Item \"Env:$n\" -ErrorAction SilentlyContinue }}; \
         $env:NODE_ENV='production'; \
         $wd='{root_s}'; $al=@({ps_arg_list}); \
         $p=Start-Process -FilePath powershell.exe -WorkingDirectory $wd \
         -ArgumentList $al -WindowStyle Normal -PassThru; \
         if($null -eq $p){{ exit 1 }}; Write-Output $p.Id"
    );

    let mut child_pid: u32 = 0;
    let mut spawned = false;

    match std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &launcher,
        ])
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            child_pid = stdout
                .lines()
                .rev()
                .find_map(|l| l.trim().parse::<u32>().ok())
                .unwrap_or(0);
            spawned = true;
            if child_pid > 0 {
                emit_log(app, &format!("Spawned detached powershell pid={child_pid}"));
            } else {
                emit_log(app, "Start-Process succeeded (pid not parsed; script will write status)");
            }
        }
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr);
            emit_log(
                app,
                &format!(
                    "Start-Process helper failed (exit {:?}): {}",
                    out.status.code(),
                    err.trim()
                ),
            );
        }
        Err(e) => {
            emit_log(app, &format!("Start-Process helper spawn failed: {e}"));
        }
    }

    // Fallback: cmd start (empty title "" required).
    if !spawned {
        // Empty quoted title ("") is required; unquoted first token becomes the window title.
        let mut start_args: Vec<String> = vec![
            "/C".into(),
            "start".into(),
            "".into(),
            "powershell.exe".into(),
            "-NoProfile".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-File".into(),
            runner.to_string_lossy().into_owned(),
            "-Chain".into(),
            action.action.clone(),
        ];
        if let Some(pid) = action.provider_id.as_ref().filter(|s| !s.is_empty()) {
            start_args.push("-ProviderId".into());
            start_args.push(pid.clone());
        }
        if let Some(prof) = action.profile_id.as_ref().filter(|s| !s.is_empty()) {
            start_args.push("-ProfileId".into());
            start_args.push(prof.clone());
        }

        match std::process::Command::new("cmd.exe")
            .args(&start_args)
            .current_dir(&root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
        {
            Ok(c) => {
                drop(c);
                spawned = true;
                emit_log(app, "Spawned via cmd start (fallback)");
            }
            Err(e) => {
                emit_log(app, &format!("cmd start fallback failed: {e}"));
            }
        }
    }

    // Last resort: CREATE_NEW_CONSOLE only (no breakaway — that was the access-denied bug).
    if !spawned {
        let mut cmd = std::process::Command::new("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &runner.to_string_lossy(),
            "-Chain",
            &action.action,
        ]);
        if let Some(pid) = action.provider_id.as_ref().filter(|s| !s.is_empty()) {
            cmd.args(["-ProviderId", pid]);
        }
        if let Some(prof) = action.profile_id.as_ref().filter(|s| !s.is_empty()) {
            cmd.args(["-ProfileId", prof]);
        }
        let child = cmd
            .current_dir(&root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map_err(|e| {
                format!(
                    "Failed to spawn detached PowerShell: {e}. \
                     If elevation is required, use gsudo from bin/; pack jobs normally do not need admin."
                )
            })?;
        child_pid = child.id();
        drop(child);
        emit_log(app, &format!("Spawned CREATE_NEW_CONSOLE pid={child_pid}"));
    }

    // Child should rewrite status with its own $PID within a second.
    std::thread::sleep(std::time::Duration::from_millis(1200));
    if let Ok(raw) = std::fs::read_to_string(&status) {
        if raw.contains("\"pid\":0") || raw.contains("\"pid\": 0") {
            if child_pid > 0 {
                let fallback = serde_json::json!({
                    "state": "running",
                    "chain": action.action,
                    "message": format!("Spawned pid {child_pid} (awaiting script bootstrap)"),
                    "updatedAt": chrono::Local::now().to_rfc3339(),
                    "providerId": action.provider_id.clone().unwrap_or_default(),
                    "profileId": action.profile_id.clone().unwrap_or_default(),
                    "pid": child_pid,
                });
                let _ = std::fs::write(
                    &status,
                    serde_json::to_string_pretty(&fallback).unwrap_or_default(),
                );
                emit_log(
                    app,
                    &format!(
                        "WARN: script had not rewritten status yet; seeded pid={child_pid}. Watch console + {}",
                        log.display()
                    ),
                );
            } else {
                emit_log(
                    app,
                    &format!(
                        "WARN: status still pid=0 — watch console + {}",
                        log.display()
                    ),
                );
            }
        } else {
            emit_log(
                app,
                "Detached job process is running - watch the Majestic console window + job-log.txt",
            );
        }
    }

    Ok("detached".into())
}
