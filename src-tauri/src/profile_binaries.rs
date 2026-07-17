//! Per-profile binary inventory: bundled `runtime/` vs user `foundry/artifacts/`.
//! Resolves the active launch path with upgrade-aware defaults and explicit user choice.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use chrono::{DateTime, Local};

use crate::config::{
    foundry_artifact_release_dir, resolve_path, to_relative_path,
};
use crate::types::{BuildInfo, ProviderConfig};

pub const SOURCE_FOUNDRY: &str = "foundry";
pub const SOURCE_BUNDLED: &str = "bundled";

pub struct ResolveContext<'a> {
    /// Saved per-env source preference from user config (`foundry` | `bundled`).
    pub source_pref: &'a HashMap<String, String>,
    /// Prior persisted active paths — used to detect GitHub-downloaded binaries under `updates/`.
    pub saved_paths: &'a HashMap<String, String>,
}

fn build_info_from_mtime(exe: &Path, version_label: &str) -> Option<BuildInfo> {
    let m = std::fs::metadata(exe).ok()?;
    let build_date = m
        .modified()
        .ok()
        .map(|mt| DateTime::<Local>::from(mt).format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| "unknown".to_string());
    Some(BuildInfo {
        version: version_label.to_string(),
        build_date,
        cuda_version: None,
        cuda_architectures: None,
    })
}

fn exe_modified_secs(path: &Path) -> u64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// True when bundled `runtime/` or Foundry artifact engines exist for any factory provider profile.
pub fn launch_engines_available() -> bool {
    const PROVIDERS: &[&str] = &[crate::config::DEFAULT_PROVIDER_ID, "ggml-tom"];
    const PROFILES: &[&str] = &["frontier", "stable"];
    for provider_id in PROVIDERS {
        for profile in PROFILES {
            if bundled_exe_abs(provider_id, profile).is_file() {
                return true;
            }
            let foundry =
                foundry_artifact_release_dir(provider_id, profile).join("llama-server.exe");
            if foundry.is_file() {
                return true;
            }
        }
    }
    false
}

fn bundled_exe_abs(provider_id: &str, profile: &str) -> PathBuf {
    resolve_path(&format!(
        "runtime/{}/{}/llama-server.exe",
        provider_id, profile
    ))
}

fn scan_bundled(provider_id: &str, profile: &str) -> Option<(String, BuildInfo)> {
    let abs = bundled_exe_abs(provider_id, profile);
    if !abs.exists() {
        return None;
    }
    let rel = to_relative_path(&abs);
    let info = build_info_from_mtime(&abs, "bundled")?;
    Some((rel, info))
}

fn scan_foundry(provider_id: &str, profile: &str) -> Option<(String, BuildInfo)> {
    let abs = foundry_artifact_release_dir(provider_id, profile).join("llama-server.exe");
    if !abs.exists() {
        return None;
    }
    let rel = to_relative_path(&abs);
    let info = build_info_from_mtime(&abs, "foundry-artifact")?;
    Some((rel, info))
}

fn is_downloaded_or_runtime_path(path: &str) -> bool {
    let norm = path.replace('\\', "/").to_lowercase();
    // Legacy `updates/` layout + current portable `runtime/{provider}/{profile}/` packs
    norm.contains("/updates/")
        || norm.contains("updates/")
        || norm.contains("runtime/")
}

fn auto_pick_source(
    bundled: &Option<(String, BuildInfo)>,
    foundry: &Option<(String, BuildInfo)>,
) -> &'static str {
    match (bundled, foundry) {
        (Some((bp, _)), Some((fp, _))) => {
            let bt = exe_modified_secs(&resolve_path(bp));
            let ft = exe_modified_secs(&resolve_path(fp));
            if bt >= ft {
                SOURCE_BUNDLED
            } else {
                SOURCE_FOUNDRY
            }
        }
        (Some(_), None) => SOURCE_BUNDLED,
        (None, Some(_)) => SOURCE_FOUNDRY,
        (None, None) => SOURCE_BUNDLED,
    }
}

fn enrich(info: BuildInfo, build_profile: &str) -> BuildInfo {
    crate::engine_utils::enrich_build_info_cuda_arch(info, build_profile)
}

fn migrate_hashmap_keys<T: Clone>(map: &mut HashMap<String, T>) {
    let retired: Vec<String> = map
        .keys()
        .filter(|k| crate::foundry_toolchain::is_retired_profile(k))
        .cloned()
        .collect();
    for old in retired {
        if let Some(val) = map.remove(&old) {
            let new_key = crate::foundry_toolchain::normalize_profile_id(&old);
            map.entry(new_key).or_insert(val);
        }
    }
}

/// vanguard/fresh → frontier on saved per-env maps.
pub fn migrate_provider_profile_keys(p: &mut ProviderConfig) {
    migrate_hashmap_keys(&mut p.binary_path_per_env);
    migrate_hashmap_keys(&mut p.build_info_per_env);
    migrate_hashmap_keys(&mut p.binary_source_per_env);
    migrate_hashmap_keys(&mut p.bundled_binary_path_per_env);
    migrate_hashmap_keys(&mut p.foundry_binary_path_per_env);
    migrate_hashmap_keys(&mut p.bundled_build_info_per_env);
    migrate_hashmap_keys(&mut p.foundry_build_info_per_env);
    migrate_hashmap_keys(&mut p.downloaded_version_per_env);
    migrate_hashmap_keys(&mut p.last_pr_per_env);
}

/// Scan both sources, resolve active path + metadata, populate inventory fields on `p`.
pub fn resolve_provider_binaries(p: &mut ProviderConfig, ctx: ResolveContext<'_>) {
    p.bundled_binary_path_per_env.clear();
    p.foundry_binary_path_per_env.clear();
    p.bundled_build_info_per_env.clear();
    p.foundry_build_info_per_env.clear();

    let profiles = crate::foundry_toolchain::profile_ids_or_default();
    let build_profile = p.build_profile.clone();

    for profile in profiles {
        let bundled = scan_bundled(&p.id, &profile);
        let foundry = scan_foundry(&p.id, &profile);

        if let Some((path, info)) = &bundled {
            p.bundled_binary_path_per_env
                .insert(profile.to_string(), path.clone());
            p.bundled_build_info_per_env
                .insert(profile.to_string(), enrich(info.clone(), &build_profile));
        }
        if let Some((path, info)) = &foundry {
            p.foundry_binary_path_per_env
                .insert(profile.to_string(), path.clone());
            p.foundry_build_info_per_env
                .insert(profile.to_string(), enrich(info.clone(), &build_profile));
        }

        // GitHub pack install — version tag tracked; path is portable runtime/ (or legacy updates/).
        let downloaded_active = p
            .downloaded_version_per_env
            .get(&profile)
            .filter(|v| !v.is_empty())
            .and_then(|_| {
                ctx.saved_paths
                    .get(&profile)
                    .filter(|path| is_downloaded_or_runtime_path(path))
                    .cloned()
                    .or_else(|| {
                        let rel = format!("runtime/{}/{}/llama-server.exe", p.id, profile);
                        if resolve_path(&rel).is_file() {
                            Some(rel)
                        } else {
                            None
                        }
                    })
            })
            .and_then(|path| {
                let abs = resolve_path(&path);
                if abs.exists() {
                    let ver = p
                        .downloaded_version_per_env
                        .get(&profile)
                        .map(|v| v.trim().trim_start_matches('v').to_string())
                        .filter(|v| !v.is_empty())
                        .unwrap_or_else(|| "downloaded".to_string());
                    build_info_from_mtime(&abs, &ver).map(|info| (path, info))
                } else {
                    None
                }
            });

        if let Some((path, mut info)) = downloaded_active {
            info = enrich(info, &build_profile);
            p.binary_path_per_env.insert(profile.to_string(), path.clone());
            p.build_info_per_env.insert(profile.to_string(), info.clone());
            // Keep runtime inventory slot filled so UI can show ACTIVE on catalog packs.
            p.bundled_binary_path_per_env
                .insert(profile.to_string(), path);
            p.bundled_build_info_per_env
                .insert(profile.to_string(), info);
            p.binary_source_per_env
                .insert(profile.to_string(), SOURCE_BUNDLED.to_string());
            continue;
        }

        let pref = ctx
            .source_pref
            .get(&profile)
            .map(|s| s.as_str())
            .filter(|s| *s == SOURCE_BUNDLED || *s == SOURCE_FOUNDRY);

        let source = match pref {
            Some(SOURCE_BUNDLED) if bundled.is_some() => SOURCE_BUNDLED,
            Some(SOURCE_FOUNDRY) if foundry.is_some() => SOURCE_FOUNDRY,
            Some(SOURCE_BUNDLED) | Some(SOURCE_FOUNDRY) => auto_pick_source(&bundled, &foundry),
            _ => auto_pick_source(&bundled, &foundry),
        };

        p.binary_source_per_env.insert(profile.to_string(), source.to_string());

        let active = match source {
            SOURCE_BUNDLED => bundled.or(foundry),
            SOURCE_FOUNDRY => foundry.or(bundled),
            _ => bundled.or(foundry),
        };

        if let Some((path, info)) = active {
            let info = enrich(info, &build_profile);
            p.binary_path_per_env.insert(profile.to_string(), path);
            p.build_info_per_env.insert(profile.to_string(), info);
        } else {
            p.binary_path_per_env.remove(&profile);
            p.build_info_per_env.remove(&profile);
            p.binary_source_per_env.remove(&profile);
        }
    }

    sync_main_binary_path(p);
    sync_current_build_info(p);
}

pub fn set_profile_source(p: &mut ProviderConfig, profile: &str, source: &str) -> Result<(), String> {
    if source != SOURCE_FOUNDRY && source != SOURCE_BUNDLED {
        return Err(format!("Invalid binary source '{}'", source));
    }
    p.binary_source_per_env
        .insert(profile.to_string(), source.to_string());
    p.downloaded_version_per_env.remove(profile);
    Ok(())
}

pub fn resolve_after_source_change(p: &mut ProviderConfig) {
    let source_pref = p.binary_source_per_env.clone();
    let saved_paths = p.binary_path_per_env.clone();
    resolve_provider_binaries(
        p,
        ResolveContext {
            source_pref: &source_pref,
            saved_paths: &saved_paths,
        },
    );
}

fn sync_main_binary_path(p: &mut ProviderConfig) {
    let default_profile = crate::config::DEFAULT_BINARY_PROFILE;
    if let Some(path) = p.binary_path_per_env.get(default_profile) {
        p.binary_path = path.clone();
        return;
    }
    if let Some((_, path)) = p
        .binary_path_per_env
        .iter()
        .next()
    {
        p.binary_path = path.clone();
    }
}

fn sync_current_build_info(p: &mut ProviderConfig) {
    let profiles = crate::foundry_toolchain::profile_ids_or_default();
    if let Some((_, info)) = p
        .build_info_per_env
        .iter()
        .filter(|(k, _)| profiles.iter().any(|pr| pr == k.as_str()))
        .max_by_key(|(_, info)| info.build_date.as_str())
    {
        p.build_info_per_env
            .insert("current".to_string(), info.clone());
    }
}