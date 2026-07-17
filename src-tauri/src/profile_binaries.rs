//! Per-profile binary inventory: NSIS `runtime/`, Foundry artifacts, catalog packs.
//!
//! - **Bundled** — `runtime/{id}/{profile}/` (Full NSIS core; plugins after first install)
//! - **Foundry** — `foundry/artifacts/...`
//! - **Catalog** — core: `runtime-catalog/{id}/{profile}/` (does not clobber NSIS);
//!   plugins: same tree as bundled under `runtime/` with `downloadedVersion` stamp
//!
//! Active launch path is user-selectable via `binary_source_per_env`.

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
pub const SOURCE_CATALOG: &str = "catalog";

pub struct ResolveContext<'a> {
    /// Saved per-env source preference (`foundry` | `bundled` | `catalog`).
    pub source_pref: &'a HashMap<String, String>,
    /// Prior persisted active paths.
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
            if catalog_exe_abs(provider_id, profile).is_file() {
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

/// Core catalog overlay — never written into NSIS `runtime/` for ggml-master.
pub fn catalog_exe_abs(provider_id: &str, profile: &str) -> PathBuf {
    resolve_path(&format!(
        "runtime-catalog/{}/{}/llama-server.exe",
        provider_id, profile
    ))
}

fn is_core_provider(provider_id: &str) -> bool {
    crate::github_releases::is_core_engine_provider(provider_id)
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

/// Core: `runtime-catalog/`. Plugins: catalog install lives under `runtime/` with product-tag stamp.
fn scan_catalog(
    p: &ProviderConfig,
    profile: &str,
) -> Option<(String, BuildInfo)> {
    let provider_id = &p.id;
    let product_tag = p
        .downloaded_version_per_env
        .get(profile)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());

    // Preferred core overlay path
    let catalog_abs = catalog_exe_abs(provider_id, profile);
    if catalog_abs.is_file() {
        let rel = to_relative_path(&catalog_abs);
        // Engine identity = disk/mtime label (not product tag). Product tag stays in downloadedVersion.
        let info = build_info_from_mtime(&catalog_abs, "catalog")?;
        return Some((rel, info));
    }

    // Plugins (and legacy core overwrite): stamp + runtime/ tree
    if let Some(_tag) = product_tag {
        let runtime_abs = bundled_exe_abs(provider_id, profile);
        if runtime_abs.is_file() {
            // For core, only treat runtime/ as catalog when overlay is missing (legacy).
            // For plugins, runtime/ *is* the catalog install.
            if !is_core_provider(provider_id) || !catalog_abs.is_file() {
                let rel = to_relative_path(&runtime_abs);
                let info = build_info_from_mtime(&runtime_abs, "catalog")?;
                return Some((rel, info));
            }
        }
    }

    None
}

fn auto_pick_source(
    bundled: &Option<(String, BuildInfo)>,
    foundry: &Option<(String, BuildInfo)>,
    catalog: &Option<(String, BuildInfo)>,
    prefer_catalog: bool,
) -> &'static str {
    if prefer_catalog && catalog.is_some() {
        return SOURCE_CATALOG;
    }
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
        (None, None) => {
            if catalog.is_some() {
                SOURCE_CATALOG
            } else {
                SOURCE_BUNDLED
            }
        }
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
    migrate_hashmap_keys(&mut p.catalog_binary_path_per_env);
    migrate_hashmap_keys(&mut p.bundled_build_info_per_env);
    migrate_hashmap_keys(&mut p.foundry_build_info_per_env);
    migrate_hashmap_keys(&mut p.catalog_build_info_per_env);
    migrate_hashmap_keys(&mut p.downloaded_version_per_env);
    migrate_hashmap_keys(&mut p.last_pr_per_env);
}

fn merge_probed_version(
    mut info: BuildInfo,
    prev: Option<&BuildInfo>,
    path: &str,
    prev_path: Option<&str>,
) -> BuildInfo {
    // Keep a real llama --version string across inventory rescans (mtime labels are placeholders).
    if let Some(prev) = prev {
        let same_path = prev_path
            .map(|pp| {
                pp.replace('\\', "/").eq_ignore_ascii_case(&path.replace('\\', "/"))
            })
            .unwrap_or(true);
        if same_path && !crate::engine::is_placeholder_build_version(&prev.version) {
            info.version = prev.version.clone();
            if info.cuda_version.is_none() {
                info.cuda_version = prev.cuda_version.clone();
            }
            if info.cuda_architectures.is_none() {
                info.cuda_architectures = prev.cuda_architectures.clone();
            }
        }
    }
    info
}

/// Scan sources, resolve active path + metadata, populate inventory fields on `p`.
pub fn resolve_provider_binaries(p: &mut ProviderConfig, ctx: ResolveContext<'_>) {
    // Preserve probed engine versions before inventory clear (rescans use mtime placeholders).
    let prev_catalog_info = p.catalog_build_info_per_env.clone();
    let prev_catalog_path = p.catalog_binary_path_per_env.clone();
    let prev_bundled_info = p.bundled_build_info_per_env.clone();
    let prev_bundled_path = p.bundled_binary_path_per_env.clone();
    let prev_foundry_info = p.foundry_build_info_per_env.clone();
    let prev_foundry_path = p.foundry_binary_path_per_env.clone();
    let prev_active_info = p.build_info_per_env.clone();

    p.bundled_binary_path_per_env.clear();
    p.foundry_binary_path_per_env.clear();
    p.catalog_binary_path_per_env.clear();
    p.bundled_build_info_per_env.clear();
    p.foundry_build_info_per_env.clear();
    p.catalog_build_info_per_env.clear();

    let profiles = crate::foundry_toolchain::profile_ids_or_default();
    let build_profile = p.build_profile.clone();
    let core = is_core_provider(&p.id);

    for profile in profiles {
        let bundled = scan_bundled(&p.id, &profile);
        let foundry = scan_foundry(&p.id, &profile);
        let catalog = scan_catalog(p, &profile);

        // Core: bundled inventory is pure NSIS runtime/. Catalog is separate.
        // Plugins: if catalog stamp exists, runtime/ is catalog (not NSIS "bundled").
        let show_bundled_as_nsis = if core {
            bundled.clone()
        } else if catalog.is_some()
            && p.downloaded_version_per_env
                .get(&profile)
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
        {
            // Plugin pack installed — no separate NSIS row
            None
        } else {
            bundled.clone()
        };

        if let Some((path, info)) = &show_bundled_as_nsis {
            let info = merge_probed_version(
                enrich(info.clone(), &build_profile),
                prev_bundled_info
                    .get(&profile)
                    .or_else(|| prev_active_info.get(&profile)),
                path,
                prev_bundled_path.get(&profile).map(|s| s.as_str()),
            );
            p.bundled_binary_path_per_env
                .insert(profile.to_string(), path.clone());
            p.bundled_build_info_per_env
                .insert(profile.to_string(), info);
        }
        if let Some((path, info)) = &foundry {
            let info = merge_probed_version(
                enrich(info.clone(), &build_profile),
                prev_foundry_info
                    .get(&profile)
                    .or_else(|| prev_active_info.get(&profile)),
                path,
                prev_foundry_path.get(&profile).map(|s| s.as_str()),
            );
            p.foundry_binary_path_per_env
                .insert(profile.to_string(), path.clone());
            p.foundry_build_info_per_env
                .insert(profile.to_string(), info);
        }
        if let Some((path, info)) = &catalog {
            let info = merge_probed_version(
                enrich(info.clone(), &build_profile),
                prev_catalog_info
                    .get(&profile)
                    .or_else(|| prev_active_info.get(&profile)),
                path,
                prev_catalog_path.get(&profile).map(|s| s.as_str()),
            );
            p.catalog_binary_path_per_env
                .insert(profile.to_string(), path.clone());
            p.catalog_build_info_per_env
                .insert(profile.to_string(), info);
        }

        let pref = ctx
            .source_pref
            .get(&profile)
            .map(|s| s.as_str())
            .filter(|s| {
                *s == SOURCE_BUNDLED || *s == SOURCE_FOUNDRY || *s == SOURCE_CATALOG
            });

        let prefer_catalog = catalog.is_some()
            && p.downloaded_version_per_env
                .get(&profile)
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);

        let source = match pref {
            Some(SOURCE_CATALOG) if catalog.is_some() => SOURCE_CATALOG,
            Some(SOURCE_BUNDLED) if show_bundled_as_nsis.is_some() => SOURCE_BUNDLED,
            Some(SOURCE_FOUNDRY) if foundry.is_some() => SOURCE_FOUNDRY,
            Some(SOURCE_CATALOG) | Some(SOURCE_BUNDLED) | Some(SOURCE_FOUNDRY) => {
                auto_pick_source(&show_bundled_as_nsis, &foundry, &catalog, prefer_catalog)
            }
            _ => auto_pick_source(&show_bundled_as_nsis, &foundry, &catalog, prefer_catalog),
        };

        p.binary_source_per_env
            .insert(profile.to_string(), source.to_string());

        let active = match source {
            SOURCE_CATALOG => catalog.clone().or(show_bundled_as_nsis.clone()).or(foundry.clone()),
            SOURCE_BUNDLED => show_bundled_as_nsis
                .clone()
                .or(catalog.clone())
                .or(foundry.clone()),
            SOURCE_FOUNDRY => foundry
                .clone()
                .or(show_bundled_as_nsis.clone())
                .or(catalog.clone()),
            _ => show_bundled_as_nsis
                .or(catalog)
                .or(foundry),
        };

        if let Some((path, info)) = active {
            // Prefer inventory row we just filled (may carry preserved --version).
            let from_inv = match source {
                SOURCE_CATALOG => p.catalog_build_info_per_env.get(&profile).cloned(),
                SOURCE_BUNDLED => p.bundled_build_info_per_env.get(&profile).cloned(),
                SOURCE_FOUNDRY => p.foundry_build_info_per_env.get(&profile).cloned(),
                _ => None,
            };
            let info = from_inv.unwrap_or_else(|| {
                merge_probed_version(
                    enrich(info, &build_profile),
                    prev_active_info.get(&profile),
                    &path,
                    None,
                )
            });
            p.binary_path_per_env.insert(profile.to_string(), path);
            p.build_info_per_env.insert(profile.to_string(), info);
        } else {
            p.binary_path_per_env.remove(&profile);
            p.build_info_per_env.remove(&profile);
            p.binary_source_per_env.remove(&profile);
        }

        let _ = ctx.saved_paths;
    }

    sync_main_binary_path(p);
    sync_current_build_info(p);
}

pub fn set_profile_source(p: &mut ProviderConfig, profile: &str, source: &str) -> Result<(), String> {
    if source != SOURCE_FOUNDRY && source != SOURCE_BUNDLED && source != SOURCE_CATALOG {
        return Err(format!(
            "Invalid binary source '{}' (use foundry | bundled | catalog)",
            source
        ));
    }
    p.binary_source_per_env
        .insert(profile.to_string(), source.to_string());
    // Keep downloaded_version so catalog inventory remains selectable after REVERT to bundled.
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
    if let Some((_, path)) = p.binary_path_per_env.iter().next() {
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
