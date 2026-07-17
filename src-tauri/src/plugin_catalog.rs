//! Optional engine plugins — catalog metadata from App updates, install via provider packs.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const PROFILE_LABELS: &[(&str, &str)] = &[
    ("frontier", "Frontier (CUDA 13.3)"),
    ("stable", "Stable (CUDA 12.8)"),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalogFile {
    pub catalog_version: u32,
    pub plugins: Vec<PluginCatalogPlugin>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalogPlugin {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub template_type: String,
    pub template_version: u32,
    pub profiles: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginProfileOffering {
    pub profile: String,
    pub profile_label: String,
    pub pack_available: bool,
    pub pack_version: String,
    pub size_bytes: u64,
    pub installed: bool,
    /// Prefer GitHub release tag when present; omit noisy foundry/git strings in UI.
    pub installed_version: Option<String>,
    pub update_available: bool,
    #[serde(default)]
    pub cuda_architectures: Vec<String>,
    #[serde(default)]
    pub cuda_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalogEntry {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub installed: bool,
    pub enabled: Option<bool>,
    pub profiles: Vec<PluginProfileOffering>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalogResponse {
    pub catalog_version: u32,
    pub plugins: Vec<PluginCatalogEntry>,
}

pub fn catalog_file_path() -> PathBuf {
    crate::config::app_root_dir()
        .join("runtime")
        .join("catalog")
        .join("plugins.json")
}

pub fn load_catalog_file() -> Result<PluginCatalogFile, String> {
    let path = catalog_file_path();
    if !path.is_file() {
        log::debug!(
            "[plugin-catalog] No catalog at {} — App update or NSIS bundle should ship runtime/catalog/plugins.json",
            path.display()
        );
        return Ok(PluginCatalogFile {
            catalog_version: 1,
            plugins: Vec::new(),
        });
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    serde_json::from_str(&content).map_err(|e| format!("Invalid plugin catalog JSON: {e}"))
}

fn profile_label(profile: &str) -> String {
    PROFILE_LABELS
        .iter()
        .find(|(id, _)| *id == profile)
        .map(|(_, label)| label.to_string())
        .unwrap_or_else(|| profile.to_string())
}

fn norm_version(v: &str) -> String {
    v.trim().trim_start_matches('v').to_string()
}

/// True for release-style tags (`1.0.16`, `v1.0.16`), false for foundry/git noise (`1 (57f6b93)`).
fn is_release_style_version(v: &str) -> bool {
    let n = v.trim().trim_start_matches('v');
    if n.is_empty() {
        return false;
    }
    let lower = n.to_ascii_lowercase();
    if lower == "disk-scanned" || lower == "unknown" || lower == "bundled" || lower == "local" {
        return false;
    }
    if n.contains('(') {
        return false;
    }
    let mut parts = n.split('.');
    let major = parts.next().unwrap_or("");
    major.chars().all(|c| c.is_ascii_digit()) && !major.is_empty()
}

fn profile_installed(
    provider: Option<&crate::types::ProviderConfig>,
    profile: &str,
) -> (bool, Option<String>, Vec<String>, Option<String>) {
    let Some(p) = provider else {
        return (false, None, Vec::new(), None);
    };
    let has_binary = p
        .binary_path_per_env
        .get(profile)
        .or_else(|| p.bundled_binary_path_per_env.get(profile))
        .or_else(|| p.foundry_binary_path_per_env.get(profile))
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    if !has_binary {
        return (false, None, Vec::new(), None);
    }
    let raw_ver = p
        .downloaded_version_per_env
        .get(profile)
        .cloned()
        .or_else(|| {
            p.build_info_per_env
                .get(profile)
                .map(|b| b.version.clone())
        });
    let ver = raw_ver.filter(|v| is_release_style_version(v));
    let info = p
        .build_info_per_env
        .get(profile)
        .or_else(|| p.bundled_build_info_per_env.get(profile))
        .or_else(|| p.foundry_build_info_per_env.get(profile));
    let arches = info
        .and_then(|b| b.cuda_architectures.clone())
        .unwrap_or_default();
    let cuda_ver = info.and_then(|b| b.cuda_version.clone());
    (true, ver, arches, cuda_ver)
}

pub async fn build_plugin_catalog(
    providers: &[crate::types::ProviderConfig],
) -> Result<PluginCatalogResponse, String> {
    let file = load_catalog_file()?;
    let mut entries = Vec::new();

    for plugin in &file.plugins {
        let live = providers.iter().find(|p| p.id == plugin.id);
        let mut profile_rows = Vec::new();
        let mut any_installed = false;
        let mut any_update = false;

        for profile in &plugin.profiles {
            let (installed, installed_version, cuda_architectures, cuda_version) =
                profile_installed(live, profile);
            if installed {
                any_installed = true;
            }

            let pack_hit =
                crate::github_releases::find_provider_pack_offering(&plugin.id, profile).await;
            let (pack_available, pack_version, size_bytes) = match pack_hit {
                Some((tag, size)) => (true, tag, size),
                None => (false, String::new(), 0),
            };

            // Update = installed with a known release tag that differs from pack tag.
            let update_available = pack_available
                && installed
                && installed_version.as_ref().map_or(false, |inst| {
                    norm_version(&pack_version) != norm_version(inst)
                });
            if update_available {
                any_update = true;
            }

            profile_rows.push(PluginProfileOffering {
                profile: profile.clone(),
                profile_label: profile_label(profile),
                pack_available,
                pack_version,
                size_bytes,
                installed,
                installed_version,
                update_available,
                cuda_architectures,
                cuda_version,
            });
        }

        entries.push(PluginCatalogEntry {
            id: plugin.id.clone(),
            display_name: plugin.display_name.clone(),
            description: plugin.description.clone(),
            installed: any_installed,
            enabled: live.map(|p| p.enabled),
            profiles: profile_rows,
        });

        let _ = any_update;
    }

    Ok(PluginCatalogResponse {
        catalog_version: file.catalog_version,
        plugins: entries,
    })
}

pub fn catalog_has_pending_updates(response: &PluginCatalogResponse) -> bool {
    response
        .plugins
        .iter()
        .any(|p| p.profiles.iter().any(|row| row.update_available))
}