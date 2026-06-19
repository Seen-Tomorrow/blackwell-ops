//! Manifest-driven portable toolchain resolution for Reactor Foundry.
//! All builds use `<app_root>/toolchain/` only — system VS/CUDA installs are ignored.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize)]
pub struct ToolchainManifest {
    pub version: u32,
    pub windows_sdk_version: String,
    pub vs: VsManifest,
    pub profiles: Vec<ProfileDef>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VsManifest {
    #[serde(rename = "2022")]
    pub vs2022: VsDef,
    #[serde(rename = "2026")]
    pub vs2026: VsDef,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VsDef {
    pub msvc_version: String,
    pub cmake_version: String,
    pub devcmd: String,
    pub label: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProfileDef {
    pub id: String,
    pub label: String,
    pub vs: String,
    pub cuda: String,
    pub generator: String,
    pub arch: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone)]
pub struct ResolvedProfile {
    pub def: ProfileDef,
    pub vs_devcmd: PathBuf,
    pub cuda_root: PathBuf,
    pub nvcc: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProfileCheck {
    pub id: String,
    pub label: String,
    pub cuda: String,
    pub vs_label: String,
    pub ready: bool,
    pub missing: Vec<String>,
}

/// Pinned GitHub release for the portable Foundry toolchain bundle.
pub const TOOLCHAIN_RELEASE_TAG: &str = "toolchain";
pub const TOOLCHAIN_GITHUB_REPO: &str = "Seen-Tomorrow/blackwell-ops";
pub const TOOLCHAIN_ARCHIVE_PARTS: &[&str] = &[
    "toolchain.7z.001",
    "toolchain.7z.002",
    "toolchain.7z.003",
];

#[derive(Debug, Clone, Serialize)]
pub struct ToolchainInstallInfo {
    pub app_root: String,
    pub extract_target: String,
    pub toolchain_dir: String,
    pub release_url: String,
    pub archive_parts: Vec<String>,
    pub compressed_size_label: String,
    pub uncompressed_size_label: String,
    pub manifest_present: bool,
    pub profiles_ready: usize,
    pub profiles_total: usize,
    pub all_ready: bool,
    pub profile_checks: Vec<ProfileCheck>,
}

pub fn toolchain_dir() -> PathBuf {
    crate::config::app_root_dir().join("toolchain")
}

pub fn manifest_path() -> PathBuf {
    toolchain_dir().join("manifest.json")
}

const EMBEDDED_MANIFEST: &str = include_str!("../../toolchain/manifest.json");

pub fn ensure_manifest_on_disk() -> Result<(), String> {
    let path = manifest_path();
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create toolchain dir: {}", e))?;
    }
    std::fs::write(&path, EMBEDDED_MANIFEST)
        .map_err(|e| format!("Failed to write embedded toolchain manifest: {}", e))?;
    Ok(())
}

pub fn load_manifest() -> Result<ToolchainManifest, String> {
    ensure_manifest_on_disk()?;
    let path = manifest_path();
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Toolchain manifest not found at {}: {}", path.display(), e))?;
    serde_json::from_str(&raw).map_err(|e| format!("Invalid toolchain manifest: {}", e))
}

pub fn profile_ids(manifest: &ToolchainManifest) -> Vec<String> {
    manifest.profiles.iter().map(|p| p.id.clone()).collect()
}

pub fn profile_ids_or_default() -> Vec<String> {
    load_manifest()
        .map(|m| profile_ids(&m))
        .unwrap_or_else(|_| vec![
            "frontier".into(),
            "vanguard".into(),
            "fresh".into(),
            "stable".into(),
        ])
}

pub fn find_profile_def<'a>(manifest: &'a ToolchainManifest, id: &str) -> Result<&'a ProfileDef, String> {
    let key = id.to_lowercase();
    manifest
        .profiles
        .iter()
        .find(|p| p.id.eq_ignore_ascii_case(&key))
        .ok_or_else(|| {
            let known: Vec<_> = manifest.profiles.iter().map(|p| p.id.as_str()).collect();
            format!(
                "Unknown build profile '{}'. Known profiles: {}",
                id,
                known.join(", ")
            )
        })
}

pub fn vs_def<'a>(manifest: &'a ToolchainManifest, vs_key: &str) -> Result<&'a VsDef, String> {
    match vs_key {
        "2022" => Ok(&manifest.vs.vs2022),
        "2026" => Ok(&manifest.vs.vs2026),
        other => Err(format!("Unknown VS toolchain key '{}' in manifest", other)),
    }
}

pub fn resolve_profile(id: &str) -> Result<ResolvedProfile, String> {
    let manifest = load_manifest()?;
    let def = find_profile_def(&manifest, id)?.clone();
    let vs = vs_def(&manifest, &def.vs)?;

    let root = toolchain_dir();
    let vs_devcmd = root.join(&vs.devcmd);
    let cuda_root = root.join("cuda").join(format!("v{}", def.cuda));
    let nvcc = cuda_root.join("bin").join("nvcc.exe");

    Ok(ResolvedProfile {
        def,
        vs_devcmd,
        cuda_root,
        nvcc,
    })
}

pub fn cuda_path_var(cuda_version: &str) -> String {
    format!("CUDA_PATH_V{}", cuda_version.replace('.', "_"))
}

impl ResolvedProfile {
    pub fn env_label(&self) -> &str {
        &self.def.id
    }

    pub fn display_label(&self) -> &str {
        &self.def.label
    }

    pub fn cuda_version_short(&self) -> &str {
        &self.def.cuda
    }

    pub fn cuda_path_var(&self) -> String {
        cuda_path_var(&self.def.cuda)
    }

    pub fn vs_instance_dir(&self) -> PathBuf {
        toolchain_dir().join("vs").join(&self.def.vs)
    }

    pub fn cmake_generator_flag(&self, vs: &VsDef) -> String {
        let instance = self.vs_instance_dir().to_string_lossy().replace('\\', "/");
        format!(
            r#"-G "{}" -A {} -DCMAKE_GENERATOR_INSTANCE="{},version={}""#,
            self.def.generator, self.def.arch, instance, vs.cmake_version
        )
    }

    /// MSVC MASM (`ml64.exe`) — required since upstream ggml `project(... ASM)` + CMake CMP0194.
    pub fn ml64_exe(&self, manifest: &ToolchainManifest) -> PathBuf {
        let vs = vs_def(manifest, &self.def.vs).expect("profile VS key validated at resolve");
        toolchain_dir()
            .join("vs")
            .join(&self.def.vs)
            .join("VC")
            .join("Tools")
            .join("MSVC")
            .join(&vs.msvc_version)
            .join("bin")
            .join("Hostx64")
            .join("x64")
            .join("ml64.exe")
    }

    pub fn cmake_asm_compiler_flag(&self, manifest: &ToolchainManifest) -> Result<String, String> {
        let ml64 = self.ml64_exe(manifest);
        if !ml64.exists() {
            return Err(format!(
                "MSVC assembler (ml64.exe) not found at {}. Recent ggml requires CMAKE_ASM_COMPILER — update the portable toolchain bundle.",
                ml64.display()
            ));
        }
        let path = ml64.to_string_lossy().replace('\\', "/");
        Ok(format!(r#"-DCMAKE_ASM_COMPILER="{}""#, path))
    }

    pub fn excluded_cuda_folders(&self, manifest: &ToolchainManifest) -> Vec<String> {
        manifest
            .profiles
            .iter()
            .filter(|p| !p.id.eq_ignore_ascii_case(&self.def.id))
            .map(|p| format!("v{}", p.cuda))
            .collect()
    }

    pub fn scrub_path(&self, manifest: &ToolchainManifest) -> String {
        let current_path = std::env::var("PATH").unwrap_or_default();
        let base = self.cuda_root.to_string_lossy().to_string();
        let excluded: Vec<String> = self
            .excluded_cuda_folders(manifest)
            .iter()
            .map(|s| s.to_lowercase())
            .collect();

        let mut filtered: Vec<String> = Vec::new();
        for entry in current_path.split(';') {
            let entry_lower = entry.to_lowercase();
            let is_cuda_toolkit = entry_lower.contains("nvidia gpu computing toolkit\\cuda\\")
                || entry_lower.contains("\\toolchain\\cuda\\");

            if !is_cuda_toolkit {
                filtered.push(entry.to_string());
            } else {
                let parts: Vec<&str> = entry_lower.split('\\').collect();
                if let Some(last) = parts.last() {
                    if !excluded.iter().any(|ex| last == ex) {
                        filtered.push(entry.to_string());
                    }
                } else {
                    filtered.push(entry.to_string());
                }
            }
        }

        let mut scrubbed = format!(r"{};\{}\;", format!("{}\\bin", base), format!("{}\\libnvvp", base));
        scrubbed.push_str(&filtered.join(";"));
        scrubbed
    }

    pub fn check(&self, manifest: &ToolchainManifest) -> ProfileCheck {
        let vs = vs_def(manifest, &self.def.vs).unwrap();
        let mut missing = Vec::new();

        if !self.vs_devcmd.exists() {
            missing.push(format!("VS devcmd: {}", self.vs_devcmd.display()));
        }
        let msvc_dir = toolchain_dir()
            .join("vs")
            .join(&self.def.vs)
            .join("VC")
            .join("Tools")
            .join("MSVC")
            .join(&vs.msvc_version);
        if !msvc_dir.exists() {
            missing.push(format!("MSVC toolset: {}", msvc_dir.display()));
        }
        let ml64 = self.ml64_exe(manifest);
        if !ml64.exists() {
            missing.push(format!("MASM ml64.exe: {}", ml64.display()));
        }
        let sdk_inc = toolchain_dir()
            .join("Windows Kits")
            .join("10")
            .join("Include")
            .join(&manifest.windows_sdk_version);
        if !sdk_inc.exists() {
            missing.push(format!("Windows SDK headers: {}", sdk_inc.display()));
        }
        if !self.nvcc.exists() {
            missing.push(format!("NVCC: {}", self.nvcc.display()));
        }
        if !self.cuda_root.join("include").exists() {
            missing.push(format!("CUDA include: {}", self.cuda_root.join("include").display()));
        }

        ProfileCheck {
            id: self.def.id.clone(),
            label: self.def.label.clone(),
            cuda: self.def.cuda.clone(),
            vs_label: vs.label.clone(),
            ready: missing.is_empty(),
            missing,
        }
    }
}

pub fn check_all_profiles() -> Result<Vec<ProfileCheck>, String> {
    let manifest = load_manifest()?;
    let mut out = Vec::new();
    for def in &manifest.profiles {
        let resolved = resolve_profile(&def.id)?;
        out.push(resolved.check(&manifest));
    }
    Ok(out)
}

pub fn all_cuda_path_vars(manifest: &ToolchainManifest) -> Vec<String> {
    manifest
        .profiles
        .iter()
        .map(|p| cuda_path_var(&p.cuda))
        .collect::<Vec<_>>()
}

pub fn validate_profile_ready(id: &str) -> Result<ResolvedProfile, String> {
    let manifest = load_manifest()?;
    let resolved = resolve_profile(id)?;
    let check = resolved.check(&manifest);
    if !check.ready {
        return Err(format!(
            "Toolchain not ready for profile '{}'. Missing:\n  - {}",
            id,
            check.missing.join("\n  - ")
        ));
    }
    Ok(resolved)
}

pub fn toolchain_release_url() -> String {
    format!(
        "https://github.com/{}/releases/tag/{}",
        TOOLCHAIN_GITHUB_REPO, TOOLCHAIN_RELEASE_TAG
    )
}

pub fn install_info() -> Result<ToolchainInstallInfo, String> {
    let app_root = crate::config::app_root_dir();
    let tc_dir = toolchain_dir();
    let checks = check_all_profiles()?;
    let profiles_ready = checks.iter().filter(|c| c.ready).count();
    let profiles_total = checks.len();

    Ok(ToolchainInstallInfo {
        app_root: app_root.to_string_lossy().to_string(),
        extract_target: app_root.to_string_lossy().to_string(),
        toolchain_dir: tc_dir.to_string_lossy().to_string(),
        release_url: toolchain_release_url(),
        archive_parts: TOOLCHAIN_ARCHIVE_PARTS.iter().map(|s| (*s).to_string()).collect(),
        compressed_size_label: "~5.6 GB (3 parts)".to_string(),
        uncompressed_size_label: "~22 GB".to_string(),
        manifest_present: manifest_path().exists(),
        profiles_ready,
        profiles_total,
        all_ready: profiles_ready == profiles_total && profiles_total > 0,
        profile_checks: checks,
    })
}

#[cfg(windows)]
fn open_path_in_shell(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(path)
        .spawn()
        .map_err(|e| format!("Failed to open folder: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn foundry_get_toolchain_install_info(
) -> Result<ToolchainInstallInfo, String> {
    install_info()
}

/// Opens the app root folder where the user extracts the toolchain archive.
#[tauri::command]
pub async fn foundry_open_toolchain_install_folder() -> Result<(), String> {
    let root = crate::config::app_root_dir();
    if let Err(e) = ensure_manifest_on_disk() {
        log::debug!("[toolchain] ensure_manifest_on_disk: {}", e);
    }
    if let Some(parent) = toolchain_dir().parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::create_dir_all(toolchain_dir());

    #[cfg(windows)]
    {
        open_path_in_shell(&root)
    }
    #[cfg(not(windows))]
    {
        let _ = root;
        Err("Portable Foundry toolchain is supported on Windows only.".into())
    }
}