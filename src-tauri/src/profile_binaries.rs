//! Per-profile binary inventory: NSIS `runtime/`, Foundry artifacts, catalog packs.
//!
//! - **Bundled** — `runtime/{id}/{profile}/` (Full NSIS core; plugins after first install)
//! - **Foundry** — `foundry/artifacts/...`
//! - **Catalog** — core: `runtime-catalog/{id}/{profile}/` (does not clobber NSIS);
//!   plugins: same tree as bundled under `runtime/` with `downloadedVersion` stamp
//!
//! Model:
//! - `inventory_per_env` = disk scan (paths + optional probed build info)
//! - `binary_source_per_env` = **user/intent preference only** (`foundry` | `bundled` |
//!   `catalog`). Missing key = deterministic default: catalog (pack) > foundry > bundled seed.
//!   Resolve never overwrites preference. `bundled` is the seed/floor, not a managed version.
//! - `binary_path_per_env` / `build_info_per_env` = pure(active) from inventory + preference

use std::path::{Path, PathBuf};

use chrono::{DateTime, Local};

use crate::config::{
    foundry_artifact_release_dir, resolve_path, to_relative_path,
};
use crate::types::{BuildInfo, ProviderConfig};

pub const SOURCE_FOUNDRY: &str = "foundry";
pub const SOURCE_BUNDLED: &str = "bundled";
pub const SOURCE_CATALOG: &str = "catalog";

fn is_known_source(s: &str) -> bool {
    s == SOURCE_FOUNDRY || s == SOURCE_BUNDLED || s == SOURCE_CATALOG
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

/// True when bundled `runtime/` or Foundry artifact engines exist for any factory provider profile.
pub fn launch_engines_available() -> bool {
    const PROVIDERS: &[&str] = &[crate::config::DEFAULT_PROVIDER_ID];
    const PROFILES: &[&str] = &["edge", "stable"];
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
    foundry: &Option<(String, BuildInfo)>,
    catalog: &Option<(String, BuildInfo)>,
) -> &'static str {
    // Deterministic precedence, deliberately NOT "newest tree". With a bundled seed, a
    // downloaded pack and a Foundry build able to coexist for one profile, mtime is not
    // intent: a fresh pack could lose to yesterday's build (and the reverse) after any
    // update, so what launches depended on file timestamps. Order is:
    //   pack (managed, updatable) > local build > bundled seed (the floor).
    // A user who wants their own build selects it; that preference is explicit and wins.
    if catalog.is_some() {
        return SOURCE_CATALOG;
    }
    if foundry.is_some() {
        return SOURCE_FOUNDRY;
    }
    SOURCE_BUNDLED
}

fn enrich(info: BuildInfo, build_profile: &str) -> BuildInfo {
    crate::engine_utils::enrich_build_info_cuda_arch(info, build_profile)
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
        if same_path && !crate::engine_build_info::is_placeholder_build_version(&prev.version) {
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
///
/// Does **not** mutate `binary_source_per_env` — preference is intent-only.
pub fn resolve_provider_binaries(p: &mut ProviderConfig) {
    // Preserve probed engine versions before inventory clear (rescans use mtime placeholders).
    let prev_inventory = p.inventory_per_env.clone();
    let prev_active_info = p.build_info_per_env.clone();
    // Preference map is read-only here; clone so we can still clear inventory freely.
    let source_pref = p.binary_source_per_env.clone();

    p.inventory_per_env.clear();

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
            None
        } else {
            bundled.clone()
        };

        let prev = prev_inventory.get(&profile);
        let prev_bundled_info = prev.and_then(|i| i.bundled.as_ref()).and_then(|e| e.info.as_ref());
        let prev_bundled_path = prev.and_then(|i| i.bundled.as_ref()).map(|e| e.path.as_str());
        let prev_foundry_info = prev.and_then(|i| i.foundry.as_ref()).and_then(|e| e.info.as_ref());
        let prev_foundry_path = prev.and_then(|i| i.foundry.as_ref()).map(|e| e.path.as_str());
        let prev_catalog_info = prev.and_then(|i| i.catalog.as_ref()).and_then(|e| e.info.as_ref());
        let prev_catalog_path = prev.and_then(|i| i.catalog.as_ref()).map(|e| e.path.as_str());

        let mut inv = crate::types::EnvBinaryInventory::default();
        if let Some((path, info)) = &show_bundled_as_nsis {
            let info = merge_probed_version(
                enrich(info.clone(), &build_profile),
                prev_bundled_info.or_else(|| prev_active_info.get(&profile)),
                path,
                prev_bundled_path,
            );
            inv.bundled = Some(crate::types::BinaryEntry {
                path: path.clone(),
                info: Some(info),
            });
        }
        if let Some((path, info)) = &foundry {
            let info = merge_probed_version(
                enrich(info.clone(), &build_profile),
                prev_foundry_info.or_else(|| prev_active_info.get(&profile)),
                path,
                prev_foundry_path,
            );
            inv.foundry = Some(crate::types::BinaryEntry {
                path: path.clone(),
                info: Some(info),
            });
        }
        if let Some((path, info)) = &catalog {
            let info = merge_probed_version(
                enrich(info.clone(), &build_profile),
                prev_catalog_info.or_else(|| prev_active_info.get(&profile)),
                path,
                prev_catalog_path,
            );
            inv.catalog = Some(crate::types::BinaryEntry {
                path: path.clone(),
                info: Some(info),
            });
        }

        let pref = source_pref
            .get(&profile)
            .map(|s| s.as_str())
            .filter(|s| is_known_source(s));

        // Explicit pref if that source exists; otherwise the deterministic default (no mtime).
        let source = match pref {
            Some(SOURCE_CATALOG) if catalog.is_some() => SOURCE_CATALOG,
            Some(SOURCE_BUNDLED) if show_bundled_as_nsis.is_some() => SOURCE_BUNDLED,
            Some(SOURCE_FOUNDRY) if foundry.is_some() => SOURCE_FOUNDRY,
            _ => auto_pick_source(&foundry, &catalog),
        };

        let active = match source {
            SOURCE_CATALOG => catalog
                .clone()
                .or(show_bundled_as_nsis.clone())
                .or(foundry.clone()),
            SOURCE_BUNDLED => show_bundled_as_nsis
                .clone()
                .or(catalog.clone())
                .or(foundry.clone()),
            SOURCE_FOUNDRY => foundry
                .clone()
                .or(show_bundled_as_nsis.clone())
                .or(catalog.clone()),
            _ => show_bundled_as_nsis.or(catalog).or(foundry),
        };

        if let Some((path, info)) = active {
            let from_inv = match source {
                SOURCE_CATALOG => inv.catalog.as_ref().and_then(|e| e.info.clone()),
                SOURCE_BUNDLED => inv.bundled.as_ref().and_then(|e| e.info.clone()),
                SOURCE_FOUNDRY => inv.foundry.as_ref().and_then(|e| e.info.clone()),
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
            // Preference stays — user intent survives missing disk rows.
        }

        if inv.bundled.is_some() || inv.foundry.is_some() || inv.catalog.is_some() {
            p.inventory_per_env.insert(profile.to_string(), inv);
        }
    }

    sync_main_binary_path(p);
}

/// Set intent preference only (`foundry` | `bundled` | `catalog`). Does not resolve paths.
pub fn set_profile_source(p: &mut ProviderConfig, profile: &str, source: &str) -> Result<(), String> {
    if !is_known_source(source) {
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

/// Set preference and re-scan/resolve active path. Single entry for Foundry/catalog/UI.
pub fn activate_profile_source(
    p: &mut ProviderConfig,
    profile: &str,
    source: &str,
) -> Result<(), String> {
    set_profile_source(p, profile, source)?;
    resolve_provider_binaries(p);
    Ok(())
}

/// Re-scan inventory + recompute active paths from existing preference.
pub fn resolve_after_source_change(p: &mut ProviderConfig) {
    resolve_provider_binaries(p);
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

#[cfg(test)]
mod source_tests {
    use super::*;

    fn entry(name: &str) -> Option<(String, BuildInfo)> {
        Some((
            name.to_string(),
            BuildInfo {
                version: name.to_string(),
                build_date: "2026-10-25 02:00".into(),
                cuda_version: None,
                cuda_architectures: None,
            },
        ))
    }

    /// Precedence is fixed: pack > local build > bundled seed. The previous rule compared
    /// file mtimes, so identical disk state could resolve differently after an update — a
    /// fresh pack losing to yesterday's Foundry build, or the reverse. That is exactly what
    /// this test pins.
    #[test]
    fn default_source_precedence_is_deterministic() {
        assert_eq!(auto_pick_source(&entry("f"), &entry("c")), SOURCE_CATALOG);
        assert_eq!(auto_pick_source(&entry("f"), &None), SOURCE_FOUNDRY);
        assert_eq!(auto_pick_source(&None, &entry("c")), SOURCE_CATALOG);
        // Nothing on disk: the caller drops the paths; the value is only a placeholder.
        assert_eq!(auto_pick_source(&None, &None), SOURCE_BUNDLED);
    }
}

