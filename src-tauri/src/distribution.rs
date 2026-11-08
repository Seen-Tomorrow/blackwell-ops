//! DEV distribution policy — single source of truth for NSIS core vs plugin packs.
//! Release builds: commands return errors (UI is DEV-gated).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

static RELEASE_JOB_RUNNING: AtomicBool = AtomicBool::new(false);

const POLICY_VERSION: u32 = 1;
const DEFAULT_PROFILES: &[&str] = &["edge", "stable"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionPolicy {
    pub policy_version: u32,
    pub nsis_core: BTreeMap<String, Vec<String>>,
    /// Profiles published as downloadable engine packs (docs/RELEASE-CHANNELS.md).
    #[serde(default)]
    pub engine_packs: BTreeMap<String, Vec<String>>,
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
            vec!["edge".into(), "stable".into()],
        );
        Self {
            policy_version: POLICY_VERSION,
            nsis_core,
            engine_packs: BTreeMap::new(),
            plugins: BTreeMap::new(),
            default_plugin_profiles: default_plugin_profiles(),
        }
    }
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


fn foundry_artifact_release_dir(provider_id: &str, profile: &str) -> PathBuf {
    crate::config::app_root_dir()
        .join("foundry")
        .join("artifacts")
        .join(provider_id)
        .join(profile)
        .join("Release")
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


// ── Release state + plans (docs/DISTRIBUTION-PANEL.md) ─────────────────────

/// Engine identity found on disk (build-info.txt beside the binaries).
#[derive(Debug, Clone)]
struct EngineSource {
    version: String,
    build: String,
}

fn parse_engine_build_number(build: &str) -> Option<u64> {
    build
        .strip_prefix('b')?
        .split('-')
        .next()?
        .parse::<u64>()
        .ok()
}

/// Read `build-info.txt`:
/// - foundry: `<version> (build N)` + `commit <sha>`
/// - pack sidecar: `<version> (build N)` or `b<build>-<sha>`
fn read_engine_build_info(dir: &std::path::Path) -> Option<EngineSource> {
    let text = std::fs::read_to_string(dir.join("build-info.txt")).ok()?;
    let mut lines = text.lines();
    let first = lines.next()?.trim();
    let commit = lines.find_map(|line| {
        line.trim()
            .strip_prefix("commit ")
            .map(|s| s.trim().to_string())
    });

    if let Some(rest) = first.strip_prefix('b') {
        return Some(EngineSource {
            version: String::new(),
            build: format!("b{rest}"),
        });
    }
    let idx = first.rfind("(build ")?;
    let version = first[..idx].trim().to_string();
    let digits: String = first[idx + 7..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    let build_no: u64 = digits.parse().ok()?;
    let build = match commit {
        Some(sha) if sha.len() >= 8 => format!("b{build_no}-{}", &sha[..8]),
        _ => format!("b{build_no}"),
    };
    Some(EngineSource { version, build })
}

/// Newest engine build available to pack: Foundry's published artifacts (the only binary root).
fn engine_source(provider: &str, profile: &str) -> Option<EngineSource> {
    let dir = foundry_artifact_release_dir(provider, profile);
    if !dir.join("llama-server.exe").is_file() {
        return None;
    }
    read_engine_build_info(&dir)
}

fn sha256_file(path: &std::path::Path) -> Option<String> {
    use std::io::Read;
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(hex::encode(hasher.finalize()))
}

/// Digest cache: reopening the panel must not re-hash a 150 MB installer or a 110 MB pack.
/// Keyed by path and invalidated by (size, mtime); a file swapped in place has a new mtime.
fn sha256_file_cached(path: &std::path::Path) -> Option<String> {
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex};
    static CACHE: LazyLock<Mutex<HashMap<std::path::PathBuf, (u64, u128, String)>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let key = path.to_path_buf();
    if let Ok(cache) = CACHE.lock() {
        if let Some((len, stamp, sha)) = cache.get(&key) {
            if *len == meta.len() && *stamp == mtime {
                return Some(sha.clone());
            }
        }
    }
    let sha = sha256_file(path)?;
    if let Ok(mut cache) = CACHE.lock() {
        cache.insert(key, (meta.len(), mtime, sha.clone()));
    }
    Some(sha)
}

/// Working-tree app version (package.json).
///
/// `package_info().version` is the RUNNING binary's version and goes stale the
/// moment the in-app Bump writes new manifests: a fresh bump still planned
/// against the old number, so an un-bumped pack/ship claimed the channel was
/// up to date and a bumped one would double-bump. Pack/ship plans (and the
/// dashboard header) must read the worktree instead.
fn repo_app_version() -> Option<String> {
    let raw = std::fs::read_to_string(repo_root().join("package.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("version")?
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn bump_patch_version(v: &str) -> String {
    let mut parts: Vec<u64> = v.split('.').filter_map(|p| p.parse().ok()).collect();
    if parts.is_empty() {
        return v.to_string();
    }
    let last = parts.len() - 1;
    parts[last] += 1;
    parts
        .iter()
        .map(|n| n.to_string())
        .collect::<Vec<_>>()
        .join(".")
}

fn parse_engine_id(id: &str) -> Option<(&str, &str)> {
    let rest = id.strip_prefix("engine:")?;
    let (provider, profile) = rest.split_once(':')?;
    if provider.is_empty() || profile.is_empty() {
        return None;
    }
    Some((provider, profile))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactStatus {
    pub id: String,
    /// `app` | `full` | `engine`
    pub kind: String,
    pub channel: String,
    pub label: String,
    pub version: String,
    pub build: String,
    pub staged: bool,
    pub staged_bytes: u64,
    pub staged_sha256: String,
    pub published: bool,
    pub published_version: String,
    pub published_build: String,
    /// Identity of the last packed artifact (engines: engines.json; app/full: app version).
    pub packed_version: String,
    pub packed_build: String,
    /// `absent` | `needs-pack` | `needs-ship` | `published`
    pub state: String,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub ship_unlocked: bool,
    pub release_exe: bool,
    pub pi_pinned: String,
    pub foundry_ready: Vec<String>,
    pub foundry_missing: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelStatus {
    pub tag: String,
    pub title: String,
    pub latest_version: String,
    pub latest_build: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct JobSummary {
    pub id: String,
    pub started_at: String,
    pub ended_at: String,
    pub result: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionState {
    pub app_version: String,
    pub policy_path: String,
    pub artifacts: Vec<ArtifactStatus>,
    pub preflight: Preflight,
    pub channels: Vec<ChannelStatus>,
    pub job: DevReleaseJobStatus,
    pub history: Vec<JobSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub args: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedJob {
    pub id: String,
    pub version: String,
    pub summary: String,
    pub steps: Vec<PlanStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleasePlan {
    #[serde(default)]
    pub schema_version: u32,
    pub artifacts: Vec<String>,
    pub phases: Vec<String>,
    #[serde(default)]
    pub bump: String,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub allow_repair: bool,
}

fn jobs_dir() -> PathBuf {
    majestic_out_dir().join("jobs")
}

fn read_release_history(limit: usize) -> Vec<JobSummary> {
    let Ok(rd) = std::fs::read_dir(jobs_dir()) else {
        return Vec::new();
    };
    let mut rows: Vec<JobSummary> = rd
        .flatten()
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|raw| serde_json::from_str::<JobSummary>(&raw).ok())
        .collect();
    rows.sort_by(|a, b| b.ended_at.cmp(&a.ended_at));
    rows.truncate(limit);
    rows
}

fn read_staged(dir: &std::path::Path, name: &str, published_size: u64, published_sha: &str) -> (bool, u64, String) {
    let path = dir.join(name);
    let Ok(meta) = std::fs::metadata(&path) else {
        return (false, 0, String::new());
    };
    if !meta.is_file() {
        return (false, 0, String::new());
    }
    let bytes = meta.len();
    // Hash only when the size matches the published asset — otherwise the digest cannot match
    // and the read would be wasted (engine packs are ~110 MB).
    let sha = if published_size > 0 && bytes == published_size && !published_sha.is_empty() {
        sha256_file_cached(&path).unwrap_or_default()
    } else {
        String::new()
    };
    (true, bytes, sha)
}

/// Size only — engine rows trust `engines.json` digests and never hash a 110 MB pack here.
fn staged_size(dir: &std::path::Path, name: &str) -> Option<u64> {
    let meta = std::fs::metadata(dir.join(name)).ok()?;
    meta.is_file().then_some(meta.len())
}

async fn build_distribution_state(
    app_handle: &tauri::AppHandle,
    force: bool,
) -> Result<DistributionState, String> {
    use crate::release_channels::{asset_name, TAG_APP, TAG_FULL};

    let app_version = repo_app_version()
        .unwrap_or_else(|| app_handle.package_info().version.to_string());
    let dir = majestic_out_dir();
    let app_manifest = crate::github_releases::fetch_product_manifest(TAG_APP, force).await;
    let full_manifest = crate::github_releases::fetch_product_manifest(TAG_FULL, force).await;
    let engine_manifest = crate::github_releases::fetch_engine_manifest(force).await;
    let policy = load_policy().unwrap_or_default();

    let mut artifacts = Vec::new();

    for (id, tag, label) in [("app", TAG_APP, "App update (.7z)"), ("full", TAG_FULL, "FULL setup (.exe)")] {
        let name = asset_name(tag, &app_version).unwrap_or_default();
        let manifest = if tag == TAG_APP { &app_manifest } else { &full_manifest };
        let published = manifest.as_ref().ok().map(|m| &m.latest);
        let pub_sha = published.map(|l| l.sha256.clone()).unwrap_or_default();
        let pub_size = published.map(|l| l.size_bytes).unwrap_or(0);
        let pub_version = published.map(|l| l.version.clone()).unwrap_or_default();

        let (staged, bytes, sha) = read_staged(&dir, &name, pub_size, &pub_sha);
        let mut state = if staged { "packed" } else { "absent" };
        if staged && !pub_sha.is_empty() && sha.eq_ignore_ascii_case(&pub_sha) {
            state = "published";
        }
        if !staged && !pub_version.is_empty() {
            state = "published";
        }

        let mut notes = Vec::new();
        if !pub_version.is_empty() && !crate::github_releases::version_gt(&app_version, &pub_version) {
            notes.push(format!(
                "channel publishes v{pub_version} — bump before shipping a new version"
            ));
        }
        if staged && state != "published" {
            notes.push(format!("staged {name} is not the published asset yet"));
        }

        artifacts.push(ArtifactStatus {
            id: id.into(),
            kind: id.into(),
            channel: tag.into(),
            label: label.into(),
            version: app_version.clone(),
            build: String::new(),
            staged,
            staged_bytes: bytes,
            staged_sha256: sha,
            published: !pub_version.is_empty(),
            published_version: pub_version,
            published_build: String::new(),
            packed_version: app_version.clone(),
            packed_build: String::new(),
            state: state.into(),
            notes,
        });
    }

    // Engines: the row is about what *can be packed*, not what was packed last time.
    // Source = newest of the runtime mirror (pack input) and the Foundry artifacts.
    let mut engine_map = policy.engine_packs.clone();
    if engine_map.is_empty() {
        engine_map = policy.nsis_core.clone();
    }
    for (provider, profiles) in &engine_map {
        for profile in profiles {
            let packed = crate::engine_packs::engine_pack(provider, profile);
            let entry = engine_manifest
                .as_ref()
                .ok()
                .and_then(|m| m.entry(provider, profile));
            let source = engine_source(provider, profile);
            // Engine rows never hash the pack: `engines.json` carries the digest computed at
            // pack time, and ship re-verifies the file against it before upload.
            let (staged, bytes) = match packed {
                Some(p) => match staged_size(&dir, &p.asset) {
                    Some(size) => (true, size),
                    None => (false, 0),
                },
                None => (false, 0),
            };
            let sha = String::new();
            let packed_build = packed.map(|p| p.build.clone()).unwrap_or_default();
            let source_build = source.as_ref().map(|s| s.build.clone());
            let source_newer = match (source_build.as_deref(), packed_build.as_str()) {
                (Some(s), packed) if !packed.is_empty() => {
                    parse_engine_build_number(s).unwrap_or(0)
                        > parse_engine_build_number(packed).unwrap_or(0)
                }
                (Some(_), _) => true,
                _ => false,
            };
            let published_matches_pack = match (entry, packed) {
                (Some(e), Some(p)) => {
                    e.build == p.build && staged && e.sha256.eq_ignore_ascii_case(&p.sha256)
                }
                _ => false,
            };

            let mut state = "absent";
            if source.is_some() || packed.is_some() {
                state = if packed.is_none() || source_newer || !staged {
                    "needs-pack"
                } else if published_matches_pack {
                    "published"
                } else {
                    "needs-ship"
                };
            }

            let mut notes = Vec::new();
            if let (Some(src), Some(p)) = (&source, packed) {
                if source_newer {
                    notes.push(format!(
                        "new build available: {} {} (packed {})",
                        src.version, src.build, p.build
                    ));
                }
            }
            if packed.is_none() {
                notes.push("not packed yet — Pack builds it from the mirror/Foundry".into());
            } else if !published_matches_pack {
                notes.push("packed build is not published on the engines channel".into());
            }
            if !staged && packed.is_some() {
                notes.push("staged pack missing from .majestic-out — re-pack before shipping".into());
            }

            let shown = source.clone().unwrap_or_else(|| EngineSource {
                version: packed.map(|p| p.llama_version.clone()).unwrap_or_default(),
                build: packed_build.clone(),
            });

            artifacts.push(ArtifactStatus {
                id: format!("engine:{provider}:{profile}"),
                kind: "engine".into(),
                channel: crate::release_channels::TAG_ENGINES.into(),
                label: format!("{} {}", provider, profile.to_uppercase()),
                version: shown.version,
                build: shown.build,
                staged,
                staged_bytes: bytes,
                staged_sha256: sha,
                published: entry.is_some(),
                published_version: entry.map(|e| e.version.clone()).unwrap_or_default(),
                published_build: entry.map(|e| e.build.clone()).unwrap_or_default(),
                packed_version: packed.map(|p| p.llama_version.clone()).unwrap_or_default(),
                packed_build,
                state: state.into(),
                notes,
            });
        }
    }

    let mut foundry_ready = Vec::new();
    let mut foundry_missing = Vec::new();
    let mut foundry_map = policy.engine_packs.clone();
    if foundry_map.is_empty() {
        foundry_map = policy.nsis_core.clone();
    }
    for (provider, profiles) in &foundry_map {
        for profile in profiles {
            let label = format!("{provider}/{profile}");
            if foundry_artifact_exe(provider, profile).is_file() {
                foundry_ready.push(label);
            } else {
                foundry_missing.push(label);
            }
        }
    }

    let mut channels = Vec::new();
    for (tag, manifest) in [(TAG_APP, &app_manifest), (TAG_FULL, &full_manifest)] {
        if let Ok(m) = manifest {
            channels.push(ChannelStatus {
                tag: tag.into(),
                title: crate::release_channels::channel(tag)
                    .map(|c| c.title.clone())
                    .unwrap_or_else(|| tag.to_string()),
                latest_version: m.latest.version.clone(),
                latest_build: String::new(),
            });
        }
    }
    if let Ok(m) = &engine_manifest {
        if let Some(first) = m.engines.first() {
            channels.push(ChannelStatus {
                tag: crate::release_channels::TAG_ENGINES.into(),
                title: crate::release_channels::channel(crate::release_channels::TAG_ENGINES)
                    .map(|c| c.title.clone())
                    .unwrap_or_else(|| "engines".to_string()),
                latest_version: first.version.clone(),
                latest_build: first.build.clone(),
            });
        }
    }

    Ok(DistributionState {
        app_version,
        policy_path: policy_path().display().to_string(),
        artifacts,
        preflight: Preflight {
            ship_unlocked: repo_root()
                .join("scripts")
                .join("majestic")
                .join(".majestic-enabled")
                .is_file(),
            release_exe: repo_root()
                .join("src-tauri")
                .join("target")
                .join("release")
                .join("blackwell-ops.exe")
                .is_file(),
            pi_pinned: std::fs::read_to_string(
                repo_root().join("src-tauri").join("pi-pinned-version.txt"),
            )
            .unwrap_or_default()
            .trim()
            .to_string(),
            foundry_ready,
            foundry_missing,
        },
        channels,
        job: get_dev_release_job_status()?,
        history: read_release_history(10),
    })
}

async fn build_planned_job(
    app_handle: &tauri::AppHandle,
    plan: &ReleasePlan,
    force: bool,
) -> Result<PlannedJob, String> {
    use crate::release_channels::{TAG_APP, TAG_FULL};

    let current = repo_app_version()
        .unwrap_or_else(|| app_handle.package_info().version.to_string());
    let app_pub = crate::github_releases::fetch_product_manifest(TAG_APP, force)
        .await
        .ok()
        .map(|m| m.latest);
    let full_pub = crate::github_releases::fetch_product_manifest(TAG_FULL, force)
        .await
        .ok()
        .map(|m| m.latest);

    let mut phases = std::collections::BTreeSet::new();
    for phase in &plan.phases {
        match phase.as_str() {
            "pack" | "ship" => {
                phases.insert(phase.clone());
            }
            other => return Err(format!("unknown phase '{other}' (pack|ship)")),
        }
    }
    if phases.is_empty() {
        return Err("plan has no phases".into());
    }
    if plan.artifacts.is_empty() {
        return Err("plan has no artifacts".into());
    }
    for artifact in &plan.artifacts {
        match artifact.as_str() {
            "app" | "full" | "link" | "toolchain" => {}
            other if other.starts_with("engine:") => {
                if parse_engine_id(other).is_none() {
                    return Err(format!("invalid engine artifact '{other}'"));
                }
            }
            other => return Err(format!("unknown artifact '{other}'")),
        }
    }

    let bump = plan.bump.trim().to_ascii_lowercase();
    if !matches!(bump.as_str(), "" | "none" | "patch") {
        return Err(format!("unknown bump '{bump}' (none|patch)"));
    }
    let do_bump = bump == "patch";
    let has_app = plan.artifacts.iter().any(|a| a == "app");
    let has_full = plan.artifacts.iter().any(|a| a == "full");
    let has_link = plan.artifacts.iter().any(|a| a == "link");
    let has_toolchain = plan.artifacts.iter().any(|a| a == "toolchain");
    if do_bump && !(has_app || has_full) {
        return Err("engines never bump — bump applies to app/full only".into());
    }
    let version = if do_bump {
        bump_patch_version(&current)
    } else {
        current.clone()
    };

    let ship = phases.contains("ship");
    if ship && !plan.allow_repair {
        if has_app {
            if let Some(latest) = &app_pub {
                if !crate::github_releases::version_gt(&version, &latest.version) {
                    return Err(format!(
                        "app channel already publishes v{} — bump first (or allow repair)",
                        latest.version
                    ));
                }
            }
        }
        if has_full {
            if let Some(latest) = &full_pub {
                if !crate::github_releases::version_gt(&version, &latest.version) {
                    return Err(format!(
                        "full channel already publishes v{} — bump first (or allow repair)",
                        latest.version
                    ));
                }
            }
        }
    }

    let engines: Vec<(String, String)> = plan
        .artifacts
        .iter()
        .filter_map(|a| parse_engine_id(a))
        .map(|(p, q)| (p.to_string(), q.to_string()))
        .collect();

    let mut steps: Vec<PlanStep> = Vec::new();
    if do_bump {
        steps.push(PlanStep {
            id: "bump".into(),
            label: format!("Bump {current} → {version}"),
            args: serde_json::json!({}),
        });
    }
    if phases.contains("pack") {
        if has_full {
            steps.push(PlanStep {
                id: "pack:full".into(),
                label: "Pack FULL (engines → app → NSIS)".into(),
                args: serde_json::json!({}),
            });
        } else {
            if has_app {
                steps.push(PlanStep {
                    id: "pack:app".into(),
                    label: "Pack App .7z".into(),
                    args: serde_json::json!({}),
                });
            }
            for (provider, profile) in &engines {
                steps.push(PlanStep {
                    id: format!("pack:engine:{provider}:{profile}"),
                    label: format!("Pack engine {provider}/{profile}"),
                    args: serde_json::json!({ "provider": provider, "profile": profile }),
                });
            }
        }
        if has_link {
            steps.push(PlanStep {
                id: "pack:link".into(),
                label: "Build + pack OYM-Link".into(),
                args: serde_json::json!({}),
            });
        }
        if has_toolchain {
            steps.push(PlanStep {
                id: "pack:toolchain".into(),
                label: "Build toolchain packs".into(),
                args: serde_json::json!({}),
            });
        }
    }
    if ship {
        if has_full {
            steps.push(PlanStep {
                id: "ship:app".into(),
                label: "Ship app channel".into(),
                args: serde_json::json!({ "channel": "app" }),
            });
            steps.push(PlanStep {
                id: "ship:full".into(),
                label: "Ship full channel".into(),
                args: serde_json::json!({ "channel": "full" }),
            });
        } else if has_app {
            steps.push(PlanStep {
                id: "ship:app".into(),
                label: "Ship app channel".into(),
                args: serde_json::json!({ "channel": "app" }),
            });
        }

        let engine_targets: Vec<(String, String)> = if has_full {
            crate::engine_packs::all()
                .iter()
                .map(|p| (p.provider.clone(), p.profile.clone()))
                .collect()
        } else {
            engines.clone()
        };
        if !engine_targets.is_empty() {
            let profiles: Vec<serde_json::Value> = engine_targets
                .iter()
                .map(|(provider, profile)| {
                    serde_json::json!({ "provider": provider, "profile": profile })
                })
                .collect();
            steps.push(PlanStep {
                id: "ship:engines".into(),
                label: "Ship engines channel".into(),
                args: serde_json::json!({ "profiles": profiles }),
            });
        }
        if has_link {
            steps.push(PlanStep {
                id: "ship:link".into(),
                label: "Ship OYM-Link".into(),
                args: serde_json::json!({}),
            });
        }
        if has_toolchain {
            steps.push(PlanStep {
                id: "ship:toolchain".into(),
                label: "Ship toolchain channel".into(),
                args: serde_json::json!({}),
            });
        }
    }

    let summary = format!(
        "v{version}: {}",
        steps
            .iter()
            .map(|s| s.label.clone())
            .collect::<Vec<_>>()
            .join(" → ")
    );
    Ok(PlannedJob {
        id: format!(
            "{}-{}",
            chrono::Local::now().format("%Y%m%d-%H%M%S"),
            if has_full {
                "full"
            } else if has_app {
                "app"
            } else {
                "engines"
            }
        ),
        version,
        summary,
        steps,
    })
}

#[tauri::command]
pub async fn get_distribution_state(
    app_handle: tauri::AppHandle,
    force: Option<bool>,
) -> Result<DistributionState, String> {
    assert_dev()?;
    build_distribution_state(&app_handle, force.unwrap_or(false)).await
}

#[tauri::command]
pub async fn preview_release_plan(
    app_handle: tauri::AppHandle,
    plan: ReleasePlan,
) -> Result<PlannedJob, String> {
    assert_dev()?;
    build_planned_job(&app_handle, &plan, false).await
}

#[tauri::command]
pub async fn run_release_plan(
    app_handle: tauri::AppHandle,
    plan: ReleasePlan,
) -> Result<PlannedJob, String> {
    assert_dev()?;
    if let Some(j) = read_job_status_file() {
        if j.get("state").and_then(|x| x.as_str()) == Some("running") {
            return Err("A release job is already running — wait for it or clear a stale status file.".into());
        }
    }

    let planned = build_planned_job(&app_handle, &plan, false).await?;
    let dir = majestic_out_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("create .majestic-out: {e}"))?;
    let plan_path = dir.join("release-plan.json");
    let doc = serde_json::json!({
        "schemaVersion": 1,
        "id": planned.id,
        "version": planned.version,
        "summary": planned.summary,
        "steps": planned.steps,
        "plan": plan,
    });
    std::fs::write(
        &plan_path,
        serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("write release-plan.json: {e}"))?;

    // spawn_detached_plan blocks (Start-Process handshake + 1.2 s pid check); keep it off the
    // async runtime's worker threads.
    {
        let app = app_handle.clone();
        let planned_for_spawn = planned.clone();
        tokio::task::spawn_blocking(move || {
            spawn_detached_plan(&app, &plan_path, &planned_for_spawn)
        })
        .await
        .map_err(|e| format!("Spawn join failed: {e}"))??;
    }
    Ok(planned)
}

/// DEV-only: local portable install used for manual REL testing (DISTRIBUTION → REFRESH LOCAL REL).
/// Override with `BLACKWELL_LOCAL_REL_DIR` when the test box moves.
const LOCAL_REL_DIR: &str = r"C:\AI-MASTER\Blackwell OPS portable";

/// Build the current tree as a REL exe and copy it + the Foundry EDGE artifact + the factory
/// template into the local portable install. No pack, no bump, no upload. Reuses the plan
/// runner (as a single `refresh:local-rel` step) so progress/log/history work unchanged.
#[tauri::command]
pub async fn run_local_rel_refresh(
    app_handle: tauri::AppHandle,
) -> Result<PlannedJob, String> {
    assert_dev()?;
    if let Some(j) = read_job_status_file() {
        if j.get("state").and_then(|x| x.as_str()) == Some("running") {
            return Err("A release job is already running — wait for it or clear a stale status file.".into());
        }
    }

    let version = repo_app_version()
        .unwrap_or_else(|| app_handle.package_info().version.to_string());
    let dest = std::env::var("BLACKWELL_LOCAL_REL_DIR").unwrap_or_else(|_| LOCAL_REL_DIR.to_string());
    let planned = PlannedJob {
        id: format!(
            "{}-local-rel",
            chrono::Local::now().format("%Y%m%d-%H%M%S")
        ),
        version: version.clone(),
        summary: format!("Refresh local REL {version} from the current tree"),
        steps: vec![PlanStep {
            id: "refresh:local-rel".into(),
            label: "Build REL + copy EDGE, template, learned cache".into(),
            args: serde_json::json!({ "dest": dest }),
        }],
    };

    let dir = majestic_out_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("create .majestic-out: {e}"))?;
    let plan_path = dir.join("release-plan.json");
    let doc = serde_json::json!({
        "schemaVersion": 1,
        "id": planned.id,
        "version": planned.version,
        "summary": planned.summary,
        "steps": planned.steps,
        "plan": { "artifacts": [], "phases": [] },
    });
    std::fs::write(
        &plan_path,
        serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("write release-plan.json: {e}"))?;

    {
        let app = app_handle.clone();
        let planned_for_spawn = planned.clone();
        tokio::task::spawn_blocking(move || {
            spawn_detached_plan(&app, &plan_path, &planned_for_spawn)
        })
        .await
        .map_err(|e| format!("Spawn join failed: {e}"))??;
    }
    Ok(planned)
}
/// Inline DEV actions only: `check_app`, `check_full`, `bump`, `bump_pi`, `update_harness`.
/// Pack/ship run through `run_release_plan` (docs/DISTRIBUTION-PANEL.md).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevReleaseAction {
    pub action: String,
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

/// Write the status via temp + rename: a poll must never read a half-written file (that used to
/// parse as "no job" and stop the panel's polling for the rest of a long job).
fn write_job_status_atomic(value: &serde_json::Value) -> std::io::Result<()> {
    let path = job_status_path();
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(value).unwrap_or_default())?;
    std::fs::rename(&tmp, &path)
}

fn chain_runner_ps1() -> PathBuf {
    repo_root()
        .join("scripts")
        .join("majestic")
        .join("run-release-plan.ps1")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStepStatus {
    pub id: String,
    pub label: String,
    /// `pending` | `running` | `ok` | `failed`
    pub state: String,
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
    /// Step list for plan jobs (empty for inline actions).
    #[serde(default)]
    pub steps: Vec<PlanStepStatus>,
    /// true while status file says running (panel should poll)
    pub running: bool,
}

fn read_job_status_file() -> Option<serde_json::Value> {
    let path = job_status_path();
    // Retry a few times: another process may be replacing the file, and a single failed parse
    // must not look like "no job" (that stops polling).
    for attempt in 0..4 {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(value) = serde_json::from_str(&raw) {
                return Some(value);
            }
        }
        if attempt < 3 {
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
    }
    None
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
    let dead_pid = pid > 0 && !runner_pid_alive(pid as u32);
    if !stale_seed && !dead_pid {
        return;
    }
    let chain = j
        .get("chain")
        .and_then(|x| x.as_str())
        .unwrap_or("?")
        .to_string();
    let msg = if stale_seed {
        "Detached PowerShell never started (stale seed). Retry the job, or run scripts/majestic/run-release-plan.ps1 -PlanFile .majestic-out/release-plan.json manually"
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
        // Keep the step strip meaningful after a crash; the panel renders whatever is here.
        "steps": j.get("steps").cloned().unwrap_or(serde_json::json!([])),
    });
    let _ = write_job_status_atomic(&failed);
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
fn runner_pid_alive(pid: u32) -> bool {
    // In-process OpenProcess check — `tasklist` here spawned on every panel poll.
    crate::engine_utils::is_process_alive(pid)
}

#[cfg(not(windows))]
fn runner_pid_alive(_pid: u32) -> bool {
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
    let (state, chain, message, updated_at, provider_id, profile_id, steps) = match v {
        Some(j) => {
            let steps = j
                .get("steps")
                .cloned()
                .and_then(|s| serde_json::from_value::<Vec<PlanStepStatus>>(s).ok())
                .unwrap_or_default();
            (
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
                steps,
            )
        }
        None => (
            "idle".into(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            Vec::new(),
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
        steps,
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

    // Harness refresh is async (network + npm), so it cannot share the sync inline block
    // below. It must still claim the single-job slot: it rewrites the installed pi tree.
    if action.action == "update_harness" {
        if RELEASE_JOB_RUNNING.swap(true, Ordering::SeqCst) {
            return Err("A release job is already running".into());
        }
        let result = refresh_harness(&app_handle).await;
        RELEASE_JOB_RUNNING.store(false, Ordering::SeqCst);
        return result;
    }

    // Fast paths stay in-process (no detached console).
    // Bump is quick version-file edits — run inline so UI can refresh immediately.
    if action.action == "check_app"
        || action.action == "check_full"
        || action.action == "bump"
        || action.action == "bump_pi"
    {
        if RELEASE_JOB_RUNNING.swap(true, Ordering::SeqCst) {
            return Err("A release job is already running".into());
        }
        let result = tokio::task::spawn_blocking({
            let app = app_handle.clone();
            let action = action.clone();
            move || {
                if action.action == "bump" {
                    run_bump_inline(&app)
                } else if action.action == "bump_pi" {
                    run_bump_pi_inline(&app)
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

    Err("Legacy pack/ship actions are retired — use run_release_plan (DISTRIBUTION panel).".into())
}

fn run_check_inline(app: &tauri::AppHandle, action: &DevReleaseAction) -> Result<String, String> {
    let variant = if action.action == "check_full" {
        "full"
    } else {
        "app"
    };
    run_majestic_step(app, &["-Mode", "check", "-Variant", variant])?;
    // Majestic compares the pin against the DEV-installed pi. It cannot see whether the
    // bundled extension can actually load on that pi, which is the failure that shipped:
    // bundle 0.80.0 (needs pi-ai >= 1.2.0) pinned to pi 0.84.3. Same gate, cheap.
    let pinned = read_pinned_version();
    crate::pi_code::assert_bundle_matches_host(&pinned)?;
    // And the bundle must be the *pinned* version, not merely a loadable one: 0.70+
    // satisfies the peer range and then kills the host on the first workflow run.
    crate::pi_code::assert_bundle_matches_pin()?;
    Ok("ok".into())
}

fn pinned_version_path() -> PathBuf {
    repo_root().join("src-tauri").join("pi-pinned-version.txt")
}

fn read_pinned_version() -> String {
    std::fs::read_to_string(pinned_version_path())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// One click: newest pi + refreshed pi-subagents bundle + pin the two to each other.
///
/// These used to be three separate rituals — Harness UPDATE for the binary and bundle,
/// Distribution BUMP HARNESS for the pin, and nothing that checked the pair. Skipping
/// the middle step shipped a bundle the installed host could not load, which surfaced as
/// `(0, _piAi.toToolDeclaration) is not a function` with no subagent tool.
async fn refresh_harness(app: &tauri::AppHandle) -> Result<String, String> {
    let before = read_pinned_version();

    emit_log(
        app,
        "[harness] fetching latest pi, refreshing pi-subagents, then pinning both…",
    );
    let status = crate::pi_code::pi_code_update_latest().await?;
    let installed = status.version.clone().unwrap_or_default();

    // Majestic stays the only writer of the pin file (no BOM, no trailing newline).
    let app_for_step = app.clone();
    tokio::task::spawn_blocking(move || run_majestic_step(&app_for_step, &["-Mode", "bump-pi"]))
        .await
        .map_err(|e| format!("Pin task failed: {e}"))??;

    let pinned = read_pinned_version();
    crate::pi_code::assert_bundle_matches_host(&pinned)?;
    // The shipped bundle must be the pinned version — 0.70+ loads fine and then crashes
    // the host on the first workflow/parallel run, which no peer check can catch.
    let bundle = crate::pi_code::assert_bundle_matches_pin()?;

    let msg = format!(
        "harness: pi {before} -> {installed}, pin {pinned}, pi-subagents {bundle} (pinned, pairing OK)"
    );
    emit_log(app, &format!("[harness] {msg}"));
    Ok(msg)
}

/// Patch version bump only (tauri conf + package.json + Cargo.toml). No pack/ship.
fn run_bump_inline(app: &tauri::AppHandle) -> Result<String, String> {
    run_majestic_step(app, &["-Mode", "bump"])?;
    Ok("ok".into())
}

/// Pin the shipped pi version to the DEV-installed (tested) version. No pack/ship.
/// Writes `src-tauri/pi-pinned-version.txt`, which the release build embeds via
/// `pi_code::PINNED_VERSION` (`include_str!`).
fn run_bump_pi_inline(app: &tauri::AppHandle) -> Result<String, String> {
    run_majestic_step(app, &["-Mode", "bump-pi"])?;
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
    if !mode_args.contains(&"-Force") {
        args.push("-Force".into());
    }

    emit_log(app, &format!("$ powershell {}", args.join(" ")));

    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let output = std::process::Command::new("pwsh.exe")
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

fn spawn_detached_plan(
    app: &tauri::AppHandle,
    plan_path: &std::path::Path,
    planned: &PlannedJob,
) -> Result<(), String> {
    let root = repo_root();
    let runner = chain_runner_ps1();
    if !runner.is_file() {
        return Err(format!("Missing chain runner: {}", runner.display()));
    }

    let out = majestic_out_dir();
    std::fs::create_dir_all(&out).map_err(|e| format!("Failed to create .majestic-out: {e}"))?;

    let log = job_log_path();
    let status = job_status_path();

    // Seed the step list so the panel can render progress before the runner starts.
    let step_status: Vec<serde_json::Value> = planned
        .steps
        .iter()
        .map(|s| serde_json::json!({ "id": s.id, "label": s.label, "state": "pending" }))
        .collect();
    let seed = serde_json::json!({
        "state": "running",
        "chain": "plan",
        "message": planned.summary,
        "updatedAt": chrono::Local::now().to_rfc3339(),
        "providerId": "",
        "profileId": "",
        "pid": 0,
        "steps": step_status,
    });
    write_job_status_atomic(&seed)
        .map_err(|e| format!("Failed to write job status: {e}"))?;
    std::fs::write(
        &log,
        format!(
            "[{}] App spawning detached plan {}\n",
            chrono::Local::now().to_rfc3339(),
            planned.id
        ),
    )
    .ok();

    // Detached WINDOWLESS job without CREATE_BREAKAWAY_FROM_JOB (breakaway is denied by the
    // cargo/tauri job object → os error 5). Same pattern as the old chain spawner: a hidden
    // Start-Process helper, then cmd-start and CREATE_NEW_CONSOLE as fallbacks.
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

    let runner_s = runner.to_string_lossy().replace('\'', "''");
    let root_s = root.to_string_lossy().replace('\'', "''");
    let plan_s = plan_path.to_string_lossy().replace('\'', "''");

    let ps_arg_list = format!(
        "'-NoProfile','-ExecutionPolicy','Bypass','-File','{runner_s}','-PlanFile','{plan_s}'"
    );

    emit_log(
        app,
        &format!(
            "Starting DETACHED plan (windowless; log: {}) - survives app restart",
            log.display()
        ),
    );

    // Start-Process -PassThru returns the real PowerShell process Id (not the helper).
    // Scrub TAURI_* first so the child does not inherit conf.dev merge env from the DEV app.
    let launcher = format!(
        "foreach($n in @('TAURI_CONFIG','TAURI_ANDROID_PACKAGE_NAME','TAURI_ANDROID_PACKAGE_NAME_PREFIX','TAURI_DEV_HOST')){{ \
           Remove-Item \"Env:$n\" -ErrorAction SilentlyContinue }}; \
         $env:NODE_ENV='production'; \
         $wd='{root_s}'; $al=@({ps_arg_list}); \
         $p=Start-Process -FilePath pwsh.exe -WorkingDirectory $wd \
         -ArgumentList $al -WindowStyle Hidden -PassThru; \
         if($null -eq $p){{ exit 1 }}; Write-Output $p.Id"
    );

    let mut child_pid: u32 = 0;
    let mut spawned = false;

    match std::process::Command::new("pwsh.exe")
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
                emit_log(app, &format!("Spawned detached plan pid={child_pid}"));
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

    // Fallback: cmd start with /b (empty title "" required, no new window).
    if !spawned {
        let start_args: Vec<String> = vec![
            "/C".into(),
            "start".into(),
            "".into(),
            "/b".into(),
            "pwsh.exe".into(),
            "-NoProfile".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-File".into(),
            runner.to_string_lossy().into_owned(),
            "-PlanFile".into(),
            plan_path.to_string_lossy().into_owned(),
        ];
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
        let child = std::process::Command::new("pwsh.exe")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                &runner.to_string_lossy(),
                "-PlanFile",
                &plan_path.to_string_lossy(),
            ])
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

    // The child rewrites status with its own $PID within a second; seed it if it did not.
    std::thread::sleep(std::time::Duration::from_millis(1200));
    if let Ok(raw) = std::fs::read_to_string(&status) {
        if raw.contains("\"pid\":0") || raw.contains("\"pid\": 0") {
            if child_pid > 0 {
                let fallback = serde_json::json!({
                    "state": "running",
                    "chain": "plan",
                    "message": planned.summary,
                    "updatedAt": chrono::Local::now().to_rfc3339(),
                    "providerId": "",
                    "profileId": "",
                    "pid": child_pid,
                    "steps": step_status,
                });
                let _ = write_job_status_atomic(&fallback);
                emit_log(
                    app,
                    &format!(
                        "WARN: script had not rewritten status yet; seeded pid={child_pid}. Watch the job log: {}",
                        log.display()
                    ),
                );
            } else {
                emit_log(
                    app,
                    &format!(
                        "WARN: status still pid=0 — watch the job log: {}",
                        log.display()
                    ),
                );
            }
        } else {
            emit_log(
                app,
                "Detached plan is running (windowless) — progress is in the DISTRIBUTION job log",
            );
        }
    }

    Ok(())
}
