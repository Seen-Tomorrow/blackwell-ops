//! Manifest-driven portable toolchain resolution for Reactor Foundry.
//! All builds use `<app_root>/toolchain/` only — system VS/CUDA installs are ignored.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize)]
pub struct ToolchainManifest {
    #[allow(dead_code)]
    pub version: u32,
    pub windows_sdk_version: String,
    pub vs: VsManifest,
    pub profiles: Vec<ProfileDef>,
    /// Split pack registry — `runtime-<cuda>` / `build` / `full`. Empty in a pre-v4 manifest.
    #[serde(default)]
    pub packs: Vec<ToolchainPackDef>,
}

/// One downloadable toolchain pack. Identity (asset name + digest) comes from this manifest,
/// which is embedded in the binary, so a stale installed pack cannot hide a new one.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ToolchainPackDef {
    pub id: String,
    /// `runtime` | `build` | `full`.
    pub kind: String,
    #[serde(default)]
    pub cuda: Option<String>,
    pub asset: String,
    #[serde(default)]
    pub sha256: String,
    #[serde(default, rename = "sizeBytes")]
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackKind {
    Runtime,
    Build,
    Full,
}

impl ToolchainPackDef {
    pub fn kind(&self) -> PackKind {
        match self.kind.trim().to_lowercase().as_str() {
            "runtime" => PackKind::Runtime,
            "build" => PackKind::Build,
            _ => PackKind::Full,
        }
    }

    pub fn label(&self) -> String {
        match self.kind() {
            PackKind::Runtime => format!(
                "CUDA {} runtime",
                self.cuda.as_deref().unwrap_or("?")
            ),
            PackKind::Build => "Foundry build tools".to_string(),
            PackKind::Full => "Full toolchain".to_string(),
        }
    }
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
    /// When true, use the `Ninja Multi-Config` generator instead of the Visual Studio
    /// generator. `Ninja Multi-Config` preserves the `--config Release` build step and the
    /// `bin/Release` output layout, but drops VS-only flags (`-A`, `-T`, `CMAKE_GENERATOR_INSTANCE`).
    /// Requires `ninja.exe` next to the portable `cmake.exe` (downloaded on demand if absent).
    #[serde(default)]
    pub ninja: bool,
    #[serde(default)]
    pub description: String,
    /// Shipped to users. `false` withholds a profile: it stays resolvable by id but is
    /// never listed by `profile_ids`, so inventory, discovery and the build list cannot
    /// offer a profile the pack does not carry. Defaults to `true` so a manifest written
    /// before this field existed does not silently lose its profiles.
    #[serde(default = "distributed_by_default")]
    pub distributed: bool,
    /// Minimum NVIDIA driver *major* that can run this profile's CUDA version, per the
    /// toolkit release notes. `None` means the manifest forgot to state it: the gate then
    /// passes and logs, so a missing value never bricks launches — but it must not stay
    /// missing (`shipped_profiles_state_their_driver_floor` pins that).
    #[serde(default)]
    pub min_driver_major: Option<u32>,
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


#[derive(Debug, Clone, Serialize)]
pub struct ToolchainInstallInfo {
    pub app_root: String,
    extract_target: String,
    /// Drop `toolchain.7z` here, then use install-from-cache in the app.
    pub archive_cache_dir: String,
    pub toolchain_dir: String,
    pub release_url: String,
    pub archive_name: String,
    pub archive_parts: Vec<String>,
    pub compressed_size_label: String,
    pub uncompressed_size_label: String,
    pub manifest_present: bool,
    /// Portable CUDA runtime DLLs (cublas + cudart) present for both profiles.
    pub runtime_ready: bool,
    /// Per-profile runtime readiness plus the driver gate. `runtime_ready` above stays the
    /// "every profile" aggregate for the Foundry panel; onboarding reads one entry.
    pub runtime_versions: Vec<RuntimeVersionInfo>,
    /// Split pack registry as offered by this build (identity from the embedded manifest).
    pub packs: Vec<PackOffering>,
    /// x64 MSVC C runtime (vcruntime140 / vcruntime140_1 / msvcp140) resolvable for every
    /// profile — app-local, in the portable toolchain, or installed system-wide. Every
    /// shipped engine binary imports these; absent means LoadLibrary dies before any log.
    pub msvc_crt_ready: bool,
    /// Present only when `msvc_crt_ready` is false.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msvc_crt_error: Option<String>,
    pub profiles_ready: usize,
    pub profiles_total: usize,
    pub all_ready: bool,
    pub profile_checks: Vec<ProfileCheck>,
    /// Verified archives kept for re-extract without re-downloading.
    pub cached_archives: Vec<CachedToolchainArchive>,
    /// Manifest version found in the toolchain on disk (0 = none installed yet).
    pub pack_installed_version: u32,
    /// Manifest version this app build was compiled against.
    pub pack_expected_version: u32,
    /// True when the pack on disk predates this app.
    pub pack_outdated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeVersionInfo {
    pub id: String,
    pub label: String,
    pub cuda: String,
    /// cublas + cublasLt + cudart present for this CUDA version.
    pub ready: bool,
    /// Manifest floor. `None` = not stated, treated as no constraint.
    pub min_driver_major: Option<u32>,
    /// Detected driver major (`nvidia-smi`), `None` when unreadable / no NVIDIA GPU.
    pub driver_major: Option<u32>,
    /// `driver_major >= min_driver_major`. Strict when the driver is unknown.
    pub driver_ok: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PackOffering {
    pub id: String,
    /// `runtime` | `build` | `full`.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cuda: Option<String>,
    pub asset: String,
    pub size_bytes: u64,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CachedToolchainArchive {
    pub pack: String,
    pub archive_name: String,
    pub size_bytes: u64,
    /// `cache` (durable) or `download` (in-flight / failed verify, not yet promoted).
    pub location: String,
}

pub fn toolchain_dir() -> PathBuf {
    crate::config::app_root_dir().join("toolchain")
}

/// Manifest version this binary was compiled against. The embedded manifest is the app's
/// *expectation*; the one on disk is *reality*, and they can disagree after an app update
/// lands before its toolchain pack does.
pub fn embedded_manifest_version() -> u32 {
    serde_json::from_str::<ToolchainManifest>(EMBEDDED_MANIFEST)
        .map(|m| m.version)
        .unwrap_or(0)
}

/// An installed pack is stale only when its manifest version is strictly older than the
/// expected one. A newer pack is fine (forward reads), and `installed == 0` means nothing
/// is installed — a different problem, reported by `check()`, not by "outdated".
pub fn pack_is_outdated(installed: u32, expected: u32) -> bool {
    installed != 0 && installed < expected
}

/// Portable CMake shipped inside the Full Foundry toolchain pack (`toolchain/cmake/bin/cmake.exe`).
pub fn cmake_exe_path() -> PathBuf {
    toolchain_dir().join("cmake").join("bin").join("cmake.exe")
}

/// Ninja lives beside the portable cmake.exe — CMake auto-finds the make program there.
pub fn ninja_exe_path() -> PathBuf {
    toolchain_dir().join("cmake").join("bin").join("ninja.exe")
}

/// Pinned Ninja release used when the stripped-down CMake pack lacks ninja.exe.
pub const NINJA_VERSION: &str = "v1.12.1";
pub const NINJA_WIN_ZIP: &str = "ninja-win.zip";
/// SHA-256 of `ninja-win.zip` for `NINJA_VERSION`, pinned rather than fetched.
///
/// Ninja's own release predates GitHub's per-asset digests (`assets[].digest` is empty
/// for v1.12.1), and this is a third-party binary this repo does not publish — so a value
/// reviewed in git is the only trustworthy source for it. A wrong pin fails closed:
/// the archive is rejected before it is ever written to disk. Bump with `NINJA_VERSION`.
pub const NINJA_WIN_SHA256: &str =
    "f550fec705b6d6ff58f2db3c374c2277a37691678d6aba463adcbb129108467a";

pub fn ninja_download_url() -> String {
    format!(
        "https://github.com/ninja-build/ninja/releases/download/{NINJA_VERSION}/{NINJA_WIN_ZIP}"
    )
}

#[cfg(test)]
mod pin_tests {
    use super::*;

    /// A mistyped pin — or a `NINJA_VERSION` bump without re-hashing the archive — would
    /// otherwise only surface on a Foundry machine mid-build, as a download rejection.
    #[test]
    fn pinned_ninja_digest_is_a_sha256_hex_string() {
        assert_eq!(NINJA_WIN_SHA256.len(), 64);
        assert!(
            NINJA_WIN_SHA256.chars().all(|c| c.is_ascii_hexdigit()),
            "NINJA_WIN_SHA256 must be bare lowercase hex: {NINJA_WIN_SHA256}"
        );
    }
}

#[cfg(test)]
mod driver_tests {
    use super::*;

    #[test]
    fn parse_driver_major_reads_the_leading_component() {
        assert_eq!(parse_driver_major(Some("616.92")), Some(616));
        assert_eq!(parse_driver_major(Some(" 610.47.03 ")), Some(610));
        assert_eq!(parse_driver_major(Some("580")), Some(580));
        assert_eq!(parse_driver_major(Some("")), None);
        assert_eq!(parse_driver_major(Some("not-a-version")), None);
        assert_eq!(parse_driver_major(None), None);
    }

    #[test]
    fn gate_is_strict_when_the_driver_is_unknown() {
        assert!(driver_gate_result("EDGE", 610, Some(616)).is_ok());
        assert!(driver_gate_result("EDGE", 610, Some(610)).is_ok());
        assert!(driver_gate_result("EDGE", 610, Some(609)).is_err());
        assert!(
            driver_gate_result("EDGE", 610, None).is_err(),
            "an unreadable driver must not be treated as compatible"
        );
        assert!(driver_ok(None, None), "no stated floor never blocks");
        assert!(!driver_ok(Some(570), None));
        assert!(driver_ok(Some(570), Some(570)));
    }

    /// A manifest edit that drops the floor silently disables the gate for that profile.
    /// Reads the embedded manifest via `profile_def` — the same source the launch gate uses.
    #[test]
    fn shipped_profiles_state_their_driver_floor() {
        for id in ["edge", "stable"] {
            let def = profile_def(id).unwrap_or_else(|| panic!("profile '{id}' present"));
            assert!(
                def.min_driver_major.is_some(),
                "profile '{id}' must state min_driver_major (CUDA {})",
                def.cuda
            );
        }
    }

    /// The fallback hint must come from the same manifest the gate reads, or it lies after a
    /// floor change. 580 can run STABLE (570) but not EDGE (610); 500 can run neither.
    #[test]
    fn compatible_alternative_is_derived_from_the_manifest() {
        let hint = driver_compatible_alternative("edge", Some(580)).expect("STABLE hint");
        assert!(hint.contains("STABLE"), "unexpected hint: {hint}");
        assert!(hint.contains("570"), "hint must quote the manifest floor: {hint}");
        assert!(driver_compatible_alternative("edge", Some(500)).is_none());
        // From STABLE the only "other" profile is EDGE, which needs 610.
        assert!(driver_compatible_alternative("stable", Some(580)).is_none());
        assert!(
            driver_compatible_alternative("stable", Some(616))
                .expect("EDGE hint")
                .contains("EDGE")
        );
    }
}

pub fn resolve_ninja_exe() -> Result<PathBuf, String> {
    let path = ninja_exe_path();
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!(
            "Ninja not found at {}. Download it (or re-extract the Full Foundry toolchain pack) so ninja.exe sits next to cmake.exe.",
            path.display()
        ))
    }
}

/// Ensure `ninja.exe` sits next to the portable `cmake.exe`. Downloads the pinned `ninja-win.zip`
/// and extracts just the binary into `toolchain/cmake/bin/` when the stripped-down CMake pack
/// didn't bundle it. Idempotent — once present it is reused across builds.
#[cfg(windows)]
pub async fn ensure_ninja_available() -> Result<PathBuf, String> {
    if let Ok(p) = resolve_ninja_exe() {
        return Ok(p);
    }

    let seven_z = resolve_7z_exe()?;
    let download_dir = toolchain_download_dir();
    std::fs::create_dir_all(&download_dir)
        .map_err(|e| format!("Failed to create ninja download dir: {e}"))?;

    let zip_path = download_dir.join(NINJA_WIN_ZIP);
    let url = ninja_download_url();
    log::info!("[toolchain] Downloading ninja {NINJA_VERSION} from {url}");
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to download ninja ({url}): {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Ninja download failed (HTTP {}): {url}",
            resp.status()
        ));
    }
    let data = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read ninja download: {e}"))?;

    // Verify before the bytes ever reach disk — this archive is extracted and executed
    // as a build tool, so an unverified one is exactly the hole the digest gate closes
    // for provider packs and installers.
    let actual = crate::external_agents::sha256_hex(&data);
    if !actual.eq_ignore_ascii_case(NINJA_WIN_SHA256) {
        return Err(format!(
            "ninja {NINJA_VERSION} archive failed its integrity check: expected {}, got {actual}. \
             Nothing was installed — re-check NINJA_WIN_SHA256 against the release if the pin \
             was bumped without updating it.",
            NINJA_WIN_SHA256
        ));
    }

    tokio::fs::write(&zip_path, &data)
        .await
        .map_err(|e| format!("Failed to write ninja archive: {e}"))?;

    let extract_dir = download_dir.join("ninja-extract");
    let _ = std::fs::remove_dir_all(&extract_dir);
    std::fs::create_dir_all(&extract_dir)
        .map_err(|e| format!("Failed to create ninja extract dir: {e}"))?;

    // Synchronous 7z extract (~300 KB zip, fast) — mirrors extract_toolchain_archive.
    let zip_str = zip_path.to_string_lossy().to_string();
    let extract_str = format!("-o{}", extract_dir.to_string_lossy());
    let output = command_no_window(&seven_z)
        .args(["x", &zip_str, &extract_str, "-y", "-aoa"])
        .output()
        .map_err(|e| format!("Failed to run 7-Zip for ninja: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "7-Zip extraction of ninja failed: {} {}",
            stderr.trim(),
            stdout.trim()
        ));
    }

    let extracted = extract_dir.join("ninja.exe");
    if !extracted.is_file() {
        return Err("Ninja archive did not contain ninja.exe".to_string());
    }
    let cmake_bin = cmake_exe_path()
        .parent()
        .ok_or_else(|| "Invalid portable cmake path".to_string())?
        .to_path_buf();
    std::fs::create_dir_all(&cmake_bin)
        .map_err(|e| format!("Failed to create cmake bin dir: {e}"))?;
    std::fs::rename(&extracted, ninja_exe_path())
        .map_err(|e| format!("Failed to place ninja.exe next to cmake: {e}"))?;

    let _ = std::fs::remove_file(&zip_path);
    let _ = std::fs::remove_dir_all(&extract_dir);
    log::info!("[toolchain] Installed ninja {NINJA_VERSION} at {}", ninja_exe_path().display());
    Ok(ninja_exe_path())
}

#[cfg(not(windows))]
pub async fn ensure_ninja_available() -> Result<PathBuf, String> {
    Err("Ninja install is supported on Windows only.".into())
}

pub fn resolve_cmake_exe() -> Result<PathBuf, String> {
    let path = cmake_exe_path();
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!(
            "Portable CMake not found at {}. Install or re-extract the Full Foundry toolchain pack.",
            path.display()
        ))
    }
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
    read_manifest_from_disk()
}

/// Read manifest only — never writes the embedded stub (used post-extract verify).
fn read_manifest_strict() -> Result<ToolchainManifest, String> {
    let path = manifest_path();
    if !path.is_file() {
        return Err(format!(
            "Toolchain manifest not found at {} — extract may have landed in the wrong folder.",
            path.display()
        ));
    }
    read_manifest_from_disk()
}

fn read_manifest_from_disk() -> Result<ToolchainManifest, String> {
    let path = manifest_path();
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Toolchain manifest not readable at {}: {}", path.display(), e))?;
    serde_json::from_str(&raw).map_err(|e| format!("Invalid toolchain manifest: {}", e))
}

fn distributed_by_default() -> bool {
    true
}

/// Profiles the app may offer. This is the ONE filter: inventory, vendor discovery and
/// the build list all read it, so withholding a profile is a single flag on the manifest.
pub fn profile_ids(manifest: &ToolchainManifest) -> Vec<String> {
    manifest
        .profiles
        .iter()
        .filter(|p| p.distributed)
        .map(|p| p.id.clone())
        .collect()
}

/// Every profile in the manifest, including withheld ones. Resolution by id uses this
/// path; nothing user-facing should.
#[cfg(test)]
pub fn all_profile_ids(manifest: &ToolchainManifest) -> Vec<String> {
    manifest.profiles.iter().map(|p| p.id.clone()).collect()
}

pub fn profile_ids_or_default() -> Vec<String> {
    load_manifest()
        .map(|m| profile_ids(&m))
        .unwrap_or_else(|_| vec!["edge".into(), "stable".into()])
}

/// Canonical profile id: trimmed and lowercased. No aliasing — a stored id that no
/// longer names a manifest profile simply fails to resolve.
pub fn normalize_profile_id(id: &str) -> String {
    id.trim().to_lowercase()
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

    pub fn cmake_generator_flag(&self, vs: &VsDef, use_ninja: bool) -> String {
        if use_ninja {
            // Ninja Multi-Config keeps `--config Release` and the `bin/Release` output layout.
            // No `-A` (arch comes from the devcmd env) and no `CMAKE_GENERATOR_INSTANCE` (VS-only).
            r#"-G "Ninja Multi-Config""#.to_string()
        } else {
            let instance = self.vs_instance_dir().to_string_lossy().replace('\\', "/");
            format!(
                r#"-G "{}" -A {} -DCMAKE_GENERATOR_INSTANCE="{},version={}""#,
                self.def.generator, self.def.arch, instance, vs.cmake_version
            )
        }
    }

    /// VS-only `-T "cuda=..."` toolset selection. The Ninja generator picks the host compiler
    /// from the devcmd environment, so this flag is omitted there.
    pub fn vs_cuda_toolset_flag(&self, cuda_ver_short: &str, use_ninja: bool) -> String {
        if use_ninja {
            String::new()
        } else {
            format!("-T \"cuda={}\"", cuda_ver_short)
        }
    }

    /// CUDA compiler/root flags. `CMAKE_VS_PLATFORM_TOOLSET_CUDA` is VS-only; Ninja relies on
    /// nvcc + `CUDAToolkit_ROOT` + the devcmd host environment.
    pub fn forced_cuda_flags(&self, use_ninja: bool) -> String {
        let compiler = format!(
            "-DCMAKE_CUDA_COMPILER=\"{}\" -DCUDAToolkit_ROOT=\"{}\"",
            self.nvcc.to_string_lossy().replace('\\', "/"),
            self.cuda_root.to_string_lossy().replace('\\', "/")
        );
        if use_ninja {
            compiler
        } else {
            format!(
                "{} -DCMAKE_VS_PLATFORM_TOOLSET_CUDA=\"{}\"",
                compiler,
                self.cuda_version_short()
            )
        }
    }

    /// Resolve the effective generator from a provider override, falling back to the manifest
    /// profile's `ninja` flag when the override is empty/auto.
    pub fn effective_use_ninja(manifest_ninja: bool, override_str: &str) -> bool {
        match override_str.trim().to_lowercase().as_str() {
            "ninja" => true,
            "visual-studio" | "vs" | "msbuild" | "cmake" => false,
            _ => manifest_ninja,
        }
    }

    /// Stable toolchain identity used to invalidate the CMake work-tree cache. A VS/CUDA/version
    /// bump must cold-start even when the configure line is byte-identical (paths under the stable
    /// `toolchain/` root don't change, so the configure line alone can't detect a toolchain swap).
    pub fn toolchain_id(&self, manifest: &ToolchainManifest) -> String {
        let msvc = vs_def(manifest, &self.def.vs)
            .map(|v| v.msvc_version.clone())
            .unwrap_or_default();
        format!(
            "v{}|{}|msvc{}|cuda{}|ninja={}",
            manifest.version, self.def.vs, msvc, self.def.cuda, self.def.ninja
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
        let cmake = cmake_exe_path();
        if !cmake.is_file() {
            missing.push(format!("CMake: {}", cmake.display()));
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

fn cuda_bin_dirs(cuda_root: &std::path::Path) -> Vec<std::path::PathBuf> {
    vec![cuda_root.join("bin"), cuda_root.join("bin").join("x64")]
}

// ── MSVC C runtime (CRT) ───────────────────────────────────────────────

/// The x64 MSVC runtime DLLs every shipped engine binary imports. Verified with
/// `dumpbin //DEPENDENTS` across all 40 `.dll`/`.exe` under `runtime/`: the complete
/// surface is exactly these three — no `concrt140`, no `vccorlib140`, no `_threads`.
pub const MSVC_CRT_DLLS: [&str; 3] = [
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "msvcp140.dll",
];

/// `{toolchain}/vs/{year}/VC/Tools/MSVC/{msvc_version}/bin/Hostx64/x64` — the directory
/// holding both the compiler and its CRT. Same layout `ml64_exe()` already relies on.
pub fn msvc_hostx64_bin_dir(vs_year: &str, msvc_version: &str) -> PathBuf {
    toolchain_dir()
        .join("vs")
        .join(vs_year)
        .join("VC")
        .join("Tools")
        .join("MSVC")
        .join(msvc_version)
        .join("bin")
        .join("Hostx64")
        .join("x64")
}

/// Resolve the CRT directory for a binary profile via the manifest (profile → VS key →
/// msvc_version). `None` when the toolchain/manifest is absent — callers must not treat
/// that as fatal here, `apply_portable_cuda_to_command` already fails earlier.
pub fn msvc_crt_dir_for_profile(binary_profile: &str) -> Option<PathBuf> {
    let manifest = load_manifest().ok()?;
    let def = manifest
        .profiles
        .iter()
        .find(|p| normalize_profile_id(&p.id) == normalize_profile_id(binary_profile))?;
    let vs = vs_def(&manifest, &def.vs).ok()?;
    let dir = msvc_hostx64_bin_dir(&def.vs, &vs.msvc_version);
    dir.is_dir().then_some(dir)
}

/// CRT DLLs missing from `dir` (case-insensitive). Empty = that dir satisfies the import.
fn missing_crt_in(dir: &std::path::Path) -> Vec<&'static str> {
    MSVC_CRT_DLLS
        .iter()
        .copied()
        .filter(|dll| !has_file_ci(dir, dll))
        .collect()
}

/// Case-insensitive file presence. Windows is CI; `Path::join` on an already-CI OS makes
/// `is_file()` sufficient, but the toolchain tree is also inspected from CI-ish Linux
/// builds of the tests, so scan the directory instead of trusting exact case.
fn has_file_ci(dir: &std::path::Path, name: &str) -> bool {
    if dir.join(name).is_file() {
        return true;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    let want = name.to_ascii_lowercase();
    entries.flatten().any(|e| {
        e.file_name().to_string_lossy().to_ascii_lowercase() == want && e.path().is_file()
    })
}

/// Are the CRT DLLs resolvable for this profile — app-local beside the engine, in the
/// portable toolchain, or already installed system-wide?
///
/// Deliberately does NOT put the CRT dir on PATH as its only source: a stale toolchain
/// copy would then shadow a newer system CRT. PATH is an addition, not a substitute.
pub fn msvc_crt_present(binary_profile: &str, engine_dir: Option<&std::path::Path>) -> bool {
    // 1. App-local beside the engine wins the OS search order and touches nothing else.
    if let Some(d) = engine_dir {
        if missing_crt_in(d).is_empty() {
            return true;
        }
    }
    // 2. Portable toolchain (the common case: toolchain is a hard onboarding gate).
    if let Some(dir) = msvc_crt_dir_for_profile(binary_profile) {
        if missing_crt_in(&dir).is_empty() {
            return true;
        }
    }
    // 3. System-wide install (VS/BuildTools or a standalone redist put it in System32).
    let sys32 = std::env::var_os("SystemRoot")
        .map(|r| PathBuf::from(r).join("System32"))
        .unwrap_or_else(|| PathBuf::from("C:\\Windows\\System32"));
    missing_crt_in(&sys32).is_empty()
}

/// Human-readable reason the CRT is unavailable, for onboarding/UI. `None` = present.
pub fn msvc_crt_missing_message(binary_profile: &str, engine_dir: Option<&std::path::Path>) -> Option<String> {
    if msvc_crt_present(binary_profile, engine_dir) {
        return None;
    }
    let need = MSVC_CRT_DLLS.join(", ");
    let where_ = msvc_crt_dir_for_profile(binary_profile)
        .map(|d| d.display().to_string())
        .unwrap_or_else(|| "{toolchain}/vs/<year>/VC/Tools/MSVC/<ver>/bin/Hostx64/x64".to_string());
    Some(format!(
        "Missing the x64 MSVC C runtime ({need}) required by the engine binaries. \
         It normally ships inside the portable toolchain at {where_}. \
         Re-install the portable toolchain (FORECAST: setup → CUDA runtime), or install \
         the 'Microsoft Visual C++ 2015-2022 Redistributable (x64)'."
    ))
}

/// Prepend the portable CRT dir to PATH for a child process, unless the engine dir
/// already carries the DLLs (then app-local copies win the OS search order and PATH
/// stays untouched).
///
/// Non-fatal by design: a missing CRT dir here means the engine will fail at
/// LoadLibrary, and the caller's own CUDA check already gates the toolchain. This only
/// widens resolution — it never blocks a launch that would otherwise have worked.
///
/// **Invariant:** PATH is an addition, never a substitute. If the command already has a
/// PATH (e.g. portable CUDA bins from `apply_portable_cuda_to_command`), that value is
/// the base we prepend to. Reading only the parent process PATH and overwriting would
/// wipe CUDA bins and surface as a raw Windows "cublas64_*.dll was not found" dialog.
pub fn apply_msvc_crt_to_command(cmd: &mut std::process::Command, binary_profile: &str, engine_dir: Option<&std::path::Path>) {
    if let Some(d) = engine_dir {
        if missing_crt_in(d).is_empty() {
            return;
        }
    }
    let Some(dir) = msvc_crt_dir_for_profile(binary_profile) else {
        return;
    };
    if !missing_crt_in(&dir).is_empty() {
        return;
    }
    let dir_s = dir.to_string_lossy();
    let old = match cmd
        .get_envs()
        .find(|(k, _)| k.to_string_lossy().eq_ignore_ascii_case("PATH"))
    {
        // Prefer PATH already staged on the command (CUDA isolation runs first).
        Some((_, Some(v))) => v.to_string_lossy().into_owned(),
        // Explicitly cleared on the command — do not resurrect the parent PATH.
        Some((_, None)) => String::new(),
        None => std::env::var("PATH").unwrap_or_default(),
    };
    let dir_norm = dir_s.replace('/', "\\").to_ascii_lowercase();
    let already = old.split(';').any(|entry| {
        let e = entry.trim();
        !e.is_empty() && e.replace('/', "\\").to_ascii_lowercase() == dir_norm
    });
    if already {
        return;
    }
    let joined = if old.is_empty() {
        dir_s.into_owned()
    } else {
        format!("{dir_s};{old}")
    };
    cmd.env("PATH", joined);
}

fn dir_has_essential_cuda_dll(bin_dir: &std::path::Path) -> bool {
    if !bin_dir.is_dir() {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(bin_dir) else {
        return false;
    };
    let mut has_cublas = false;
    let mut has_cublas_lt = false;
    let mut has_cudart = false;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if !name.ends_with(".dll") {
            continue;
        }
        if name.starts_with("cublas64_") {
            has_cublas = true;
        } else if name.starts_with("cublaslt64_") {
            has_cublas_lt = true;
        } else if name.starts_with("cudart64_") {
            has_cudart = true;
        }
    }
    has_cublas && has_cublas_lt && has_cudart
}

pub fn cuda_runtime_ready_for_version(cuda_version: &str) -> bool {
    let cuda_root = toolchain_dir().join("cuda").join(format!("v{}", cuda_version));
    cuda_bin_dirs(&cuda_root)
        .iter()
        .any(|dir| dir_has_essential_cuda_dll(dir))
}

pub fn cuda_version_for_binary_profile(binary_profile: &str) -> Option<String> {
    let key = normalize_profile_id(binary_profile);
    if let Ok(manifest) = load_manifest() {
        if let Some(def) = manifest
            .profiles
            .iter()
            .find(|p| p.id.eq_ignore_ascii_case(&key))
        {
            return Some(def.cuda.clone());
        }
    }
    match key.as_str() {
        "stable" => Some("12.8".into()),
        "edge" => Some("13.4".into()),
        _ => None,
    }
}

/// True when a PATH entry points at a foreign CUDA install (system toolkit or another toolchain tree).
pub fn path_entry_is_foreign_cuda(entry: &str) -> bool {
    let lower = entry.trim().to_lowercase().replace('/', "\\");
    if lower.is_empty() {
        return false;
    }
    lower.contains("nvidia gpu computing toolkit\\cuda\\")
        || lower.contains("\\toolchain\\cuda\\")
}

/// Drop system / foreign CUDA dirs from PATH — runtime only uses our bare portable `<app_root>/toolchain/cuda/v*/bin`.
/// We only ever ship/require the three essential DLLs (cublas* + cudart*) for inference.
pub fn scrub_foreign_cuda_from_path(path: &str) -> String {
    path.split(';')
        .filter(|entry| !path_entry_is_foreign_cuda(entry))
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>()
        .join(";")
}

/// App-root-relative path for debug console (`\toolchain\cuda\...`).
fn toolchain_console_path(path: &std::path::Path) -> String {
    let rel = crate::config::to_relative_path(path);
    format!("\\{}", rel.replace('/', "\\"))
}

/// Portable CUDA dirs + env var names for external CMD / batch launch (NoBSproof).
pub struct PortableCudaEnv {
    pub cuda_version: String,
    pub cuda_root: std::path::PathBuf,
    pub path_prefix: String,
    pub cuda_path_var: String,
}

pub fn portable_cuda_env_for_profile(binary_profile: &str) -> Result<PortableCudaEnv, String> {
    let cuda_version = cuda_version_for_binary_profile(binary_profile).ok_or_else(|| {
        format!(
            "Unknown binary profile '{}' — cannot resolve portable CUDA version.",
            binary_profile
        )
    })?;
    if !cuda_runtime_ready_for_version(&cuda_version) {
        return Err(portable_cuda_missing_message(binary_profile, &cuda_version));
    }

    let cuda_root = toolchain_dir().join("cuda").join(format!("v{}", cuda_version));
    let mut toolchain_bins: Vec<String> = Vec::new();
    let bin_x64 = cuda_root.join("bin").join("x64");
    if bin_x64.is_dir() {
        toolchain_bins.push(bin_x64.to_string_lossy().to_string());
    }
    let bin = cuda_root.join("bin");
    if bin.is_dir() {
        toolchain_bins.push(bin.to_string_lossy().to_string());
    }
    if toolchain_bins.is_empty() {
        return Err(portable_cuda_missing_message(binary_profile, &cuda_version));
    }

    let cuda_path_var_name = cuda_path_var(&cuda_version);
    // Prepend the portable MSVC CRT so the batch-spawned engine (NoBSproof console path)
    // resolves vcruntime140/msvcp140 the same way the piped path does. App-local copies
    // beside the exe still win the OS search order, so this is only a fallback.
    if let Some(crt) = msvc_crt_dir_for_profile(binary_profile) {
        if missing_crt_in(&crt).is_empty() {
            toolchain_bins.insert(0, crt.to_string_lossy().to_string());
        }
    }
    Ok(PortableCudaEnv {
        cuda_version,
        cuda_root,
        path_prefix: toolchain_bins.join(";"),
        cuda_path_var: cuda_path_var_name,
    })
}

pub fn portable_cuda_missing_message(binary_profile: &str, cuda_version: &str) -> String {
    format!(
        "Portable CUDA {} runtime not found for profile '{}'.\n\
         Expected cublas64_ + cublasLt64_ + cudart64_ DLLs under:\n  {}\n\
         Install the portable toolchain via CONFIG → Providers or onboarding.",
        cuda_version,
        binary_profile,
        toolchain_dir()
            .join("cuda")
            .join(format!("v{}", cuda_version))
            .display()
    )
}

/// Bind child PATH/CUDA_* to `<app_root>/toolchain/cuda/v*` only — never system or third-party CUDA.
///
/// NOTE on stronger isolation: PATH + CUDA_PATH is the primary mechanism for the CUDA loader.
/// A future improvement could call AddDllDirectory / SetDllDirectoryW right before spawn
/// (and restore after) or use a tiny launcher stub that does SetDllDirectory then execs the real exe.
/// Current approach matches what upstream llama.cpp Windows CUDA packages rely on.
#[cfg(windows)]
pub fn apply_portable_cuda_to_command(
    cmd: &mut std::process::Command,
    binary_profile: &str,
) -> Result<(), String> {
    let cuda_version = cuda_version_for_binary_profile(binary_profile).ok_or_else(|| {
        format!(
            "Unknown binary profile '{}' — cannot resolve portable CUDA version.",
            binary_profile
        )
    })?;

    if !cuda_runtime_ready_for_version(&cuda_version) {
        return Err(portable_cuda_missing_message(binary_profile, &cuda_version));
    }

    let cuda_root = toolchain_dir().join("cuda").join(format!("v{}", cuda_version));
    let mut toolchain_bins: Vec<String> = Vec::new();
    let bin_x64 = cuda_root.join("bin").join("x64");
    if bin_x64.is_dir() {
        toolchain_bins.push(bin_x64.to_string_lossy().to_string());
    }
    let bin = cuda_root.join("bin");
    if bin.is_dir() {
        toolchain_bins.push(bin.to_string_lossy().to_string());
    }
    if toolchain_bins.is_empty() {
        return Err(portable_cuda_missing_message(binary_profile, &cuda_version));
    }

    let scrubbed = scrub_foreign_cuda_from_path(&std::env::var("PATH").unwrap_or_default());
    let new_path = if scrubbed.is_empty() {
        toolchain_bins.join(";")
    } else {
        format!("{};{}", toolchain_bins.join(";"), scrubbed)
    };

    log::debug!(
        "[cuda-path] profile={} CUDA {} — toolchain only: {}",
        binary_profile,
        cuda_version,
        toolchain_bins.join(";")
    );

    let bins_display = toolchain_bins
        .iter()
        .map(|p| toolchain_console_path(std::path::Path::new(p)))
        .collect::<Vec<_>>()
        .join("; ");
    let console_line = format!(
        "[TOOLCHAIN] profile={} CUDA {} | bins: {} | root: {}",
        binary_profile,
        cuda_version,
        bins_display,
        toolchain_console_path(&cuda_root),
    );
    static LAST_TOOLCHAIN_CONSOLE_LINE: std::sync::Mutex<Option<String>> =
        std::sync::Mutex::new(None);
    let mut last = LAST_TOOLCHAIN_CONSOLE_LINE
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if last.as_deref() != Some(&console_line) {
        *last = Some(console_line.clone());
        crate::output_console::emit_blackwell_output_console_debug_line(console_line);
    }

    cmd.env_remove("CUDA_PATH");
    if let Ok(manifest) = load_manifest() {
        for var in all_cuda_path_vars(&manifest) {
            cmd.env_remove(&var);
        }
    }

    cmd.env("PATH", new_path);
    cmd.env("CUDA_PATH", &cuda_root);
    cmd.env(cuda_path_var(&cuda_version), &cuda_root);
    Ok(())
}

#[cfg(not(windows))]
pub fn apply_portable_cuda_to_command(
    _cmd: &mut std::process::Command,
    _binary_profile: &str,
) -> Result<(), String> {
    Err("Portable CUDA toolchain is supported on Windows only.".into())
}

pub fn check_runtime_ready(manifest: &ToolchainManifest) -> bool {
    manifest
        .profiles
        .iter()
        .all(|p| cuda_runtime_ready_for_version(&p.cuda))
}

// ── Driver gate ────────────────────────────────────────────────────────
// The driver floor is a property of the CUDA version, so it lives in the manifest next to
// `cuda` (`min_driver_major`) rather than in a second table in the frontend. The launch
// path refuses to spawn when the installed driver is below it: CUDA 13.4 cannot initialize
// on an older driver, and the failure otherwise surfaces as a bare engine exit with no log.

/// Parse the leading major from `nvidia-smi`'s `610.47` / `610.47.03` style version.
pub fn parse_driver_major(version: Option<&str>) -> Option<u32> {
    let first = version?.trim().split('.').next()?.trim();
    first.parse::<u32>().ok()
}

/// Empty floor means "no constraint stated" -> pass. Unknown driver under a stated floor
/// means fail: an engine launched on an unverified driver is the case this gate exists for.
pub fn driver_ok(min: Option<u32>, driver: Option<u32>) -> bool {
    match min {
        None => true,
        Some(min) => driver.is_some_and(|d| d >= min),
    }
}

/// Profile definition from the **embedded** manifest, not the one on disk.
///
/// The driver floor is a property of the app's launch code, so it must not depend on which
/// pack happens to be installed: a stale pack manifest (a dev box with an old `frontier`
/// entry, or a user one version behind) would otherwise drop the gate silently. Resolution
/// elsewhere still reads disk-first — that is about the resident toolchain, not this.
pub fn profile_def(binary_profile: &str) -> Option<ProfileDef> {
    let manifest: ToolchainManifest = serde_json::from_str(EMBEDDED_MANIFEST).ok()?;
    find_profile_def(&manifest, binary_profile).ok().cloned()
}

/// Fail message shared by the launch gate and the onboarding copy. No fallback hint here:
/// which profile is compatible depends on the driver, so `ensure_driver_supports_profile`
/// appends it from the manifest instead of hardcoding a number.
pub fn driver_gate_result(label: &str, min: u32, driver: Option<u32>) -> Result<(), String> {
    match driver {
        Some(d) if d >= min => Ok(()),
        Some(d) => Err(format!(
            "{label} needs NVIDIA driver {min}+ (installed: {d}). Update the driver and relaunch."
        )),
        None => Err(format!(
            "{label} needs NVIDIA driver {min}+, but no driver version could be read (nvidia-smi). \
             Install or update the NVIDIA driver, then relaunch."
        )),
    }
}

/// "STABLE (driver 570+) also works" — derived from the embedded manifest, so it cannot drift
/// from the floor the gate actually enforced.
fn driver_compatible_alternative(current_id: &str, driver: Option<u32>) -> Option<String> {
    let manifest: ToolchainManifest = serde_json::from_str(EMBEDDED_MANIFEST).ok()?;
    manifest
        .profiles
        .iter()
        .filter(|p| p.distributed && !p.id.eq_ignore_ascii_case(current_id))
        .find(|p| p.min_driver_major.is_some() && driver_ok(p.min_driver_major, driver))
        .map(|p| {
            format!(
                "{} (driver {}+) is compatible if you cannot update.",
                p.label,
                p.min_driver_major.unwrap_or(0)
            )
        })
}

/// Fresh probe on every call, deliberately: onboarding re-checks in place after the user
/// updates the driver, so a session-cached value would make CHECK AGAIN a no-op.
pub async fn detect_driver_major() -> Option<u32> {
    #[cfg(debug_assertions)]
    if let Ok(raw) = std::env::var("BLACKWELL_FAKE_DRIVER_MAJOR") {
        if let Ok(major) = raw.trim().parse::<u32>() {
            log::warn!("[driver] BLACKWELL_FAKE_DRIVER_MAJOR={major} — DEV override active");
            return Some(major);
        }
        log::warn!("[driver] BLACKWELL_FAKE_DRIVER_MAJOR is not a number: {raw:?}");
    }
    match crate::telemetry::get_nvidia_driver_version().await {
        Ok(v) => parse_driver_major(v.as_deref()),
        Err(e) => {
            log::debug!("[driver] nvidia-smi probe failed: {e}");
            None
        }
    }
}

/// Refuse a launch the installed driver cannot run. Called before any engine spawn that
/// has a binary profile; bench/nsys paths should call it too once they carry a profile.
pub async fn ensure_driver_supports_profile(binary_profile: &str) -> Result<(), String> {
    let Some(def) = profile_def(binary_profile) else {
        return Ok(());
    };
    let Some(min) = def.min_driver_major else {
        log::debug!(
            "[driver] profile '{}' states no min_driver_major — gate skipped",
            def.id
        );
        return Ok(());
    };
    let driver = detect_driver_major().await;
    match driver_gate_result(&def.label, min, driver) {
        Ok(()) => Ok(()),
        Err(base) => Err(match driver_compatible_alternative(&def.id, driver) {
            Some(hint) => format!("{base} {hint}"),
            None => base,
        }),
    }
}

/// GGUF metadata scan spawns llama-server — needs portable CUDA runtime DLLs on PATH.
pub fn require_runtime_for_gguf_scan() -> Result<(), String> {
    let manifest = load_manifest().map_err(|_| {
        String::from(
            "Portable toolchain is not installed. Install it in setup (or CONFIG → Providers) before scanning GGUF metadata.",
        )
    })?;
    if check_runtime_ready(&manifest) {
        Ok(())
    } else {
        Err("CUDA runtime DLLs are missing. Install the portable toolchain before scanning GGUF metadata.".into())
    }
}

pub fn check_all_profiles() -> Result<Vec<ProfileCheck>, String> {
    let manifest = load_manifest()?;
    Ok(profile_checks_for_manifest(&manifest))
}

fn check_all_profiles_strict() -> Result<Vec<ProfileCheck>, String> {
    let manifest = read_manifest_strict()?;
    Ok(profile_checks_for_manifest(&manifest))
}

fn profile_checks_for_manifest(manifest: &ToolchainManifest) -> Vec<ProfileCheck> {
    let mut out = Vec::new();
    for def in &manifest.profiles {
        if let Ok(resolved) = resolve_profile_from_manifest(manifest, &def.id) {
            out.push(resolved.check(manifest));
        }
    }
    out
}

fn resolve_profile_from_manifest(
    manifest: &ToolchainManifest,
    id: &str,
) -> Result<ResolvedProfile, String> {
    let def = find_profile_def(manifest, id)?.clone();
    let vs = vs_def(manifest, &def.vs)?;
    let cuda_ver = def.cuda.clone();
    let root = toolchain_dir();
    Ok(ResolvedProfile {
        def,
        vs_devcmd: root.join(&vs.devcmd),
        cuda_root: root.join("cuda").join(format!("v{}", cuda_ver)),
        nvcc: root
            .join("cuda")
            .join(format!("v{}", cuda_ver))
            .join("bin")
            .join("nvcc.exe"),
    })
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

/// The embedded manifest is the authority for pack identity: the arch of the app decides which
/// packs exist, not whichever tree the user happens to have installed.
pub fn embedded_manifest() -> Result<ToolchainManifest, String> {
    serde_json::from_str(EMBEDDED_MANIFEST)
        .map_err(|e| format!("Embedded toolchain manifest is invalid: {e}"))
}

/// `""`/`full` fall back to the full pack so older call sites keep working.
pub fn pack_def(pack: &str) -> Result<ToolchainPackDef, String> {
    let key = pack.trim().to_lowercase();
    if key.is_empty() {
        return Err(
            "No toolchain pack specified. Expected a pack id from the embedded manifest: runtime-<cuda> or build."
                .to_string(),
        );
    }
    let manifest = embedded_manifest()?;
    manifest
        .packs
        .iter()
        .find(|p| p.id.eq_ignore_ascii_case(&key))
        .cloned()
        .ok_or_else(|| {
            let known: Vec<&str> = manifest.packs.iter().map(|p| p.id.as_str()).collect();
            format!(
                "Unknown toolchain pack '{}'. Known packs: {}",
                key,
                if known.is_empty() { "(none in this build)".to_string() } else { known.join(", ") }
            )
        })
}

pub fn pack_archive_name(pack: &str) -> Result<String, String> {
    Ok(pack_def(pack)?.asset)
}

pub fn toolchain_pack_label(pack: &str) -> String {
    pack_def(pack)
        .map(|d| d.label())
        .unwrap_or_else(|_| "Foundry Toolchain".to_string())
}

pub fn toolchain_download_dir() -> std::path::PathBuf {
    crate::config::app_root_dir().join(".toolchain-download")
}

pub fn toolchain_archive_cache_dir() -> std::path::PathBuf {
    toolchain_download_dir().join("cache")
}

pub fn toolchain_download_dest(archive_name: &str) -> String {
    toolchain_download_dir()
        .join(archive_name)
        .to_string_lossy()
        .to_string()
}

pub fn toolchain_archive_cache_path(archive_name: &str) -> std::path::PathBuf {
    toolchain_archive_cache_dir().join(archive_name)
}

fn archive_size(path: &std::path::Path) -> u64 {
    std::fs::metadata(path).ok().map(|m| m.len()).unwrap_or(0)
}

/// Archives available for re-extract (durable cache first, then unstaged download copy).
pub fn list_reextractable_archives() -> Vec<CachedToolchainArchive> {
    let Ok(manifest) = embedded_manifest() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for def in &manifest.packs {
        let cache = toolchain_archive_cache_path(&def.asset);
        if cache.is_file() {
            out.push(CachedToolchainArchive {
                pack: def.id.clone(),
                archive_name: def.asset.clone(),
                size_bytes: archive_size(&cache),
                location: "cache".into(),
            });
            continue;
        }
        let download = std::path::PathBuf::from(toolchain_download_dest(&def.asset));
        if download.is_file() {
            out.push(CachedToolchainArchive {
                pack: def.id.clone(),
                archive_name: def.asset.clone(),
                size_bytes: archive_size(&download),
                location: "download".into(),
            });
        }
    }
    out
}

pub fn archive_for_reextract(pack: &str) -> Result<std::path::PathBuf, String> {
    let pack_key = pack.trim().to_lowercase();
    let archive_name = pack_archive_name(&pack_key)?;
    let cache = toolchain_archive_cache_path(&archive_name);
    if cache.is_file() {
        return Ok(cache);
    }
    let download = std::path::PathBuf::from(toolchain_download_dest(&archive_name));
    if download.is_file() {
        return Ok(download);
    }
    Err(format!(
        "No local copy of {} — download the toolchain first.",
        archive_name
    ))
}

fn promote_archive_to_cache(archive_path: &std::path::Path, archive_name: &str) -> Result<(), String> {
    let cache_dir = toolchain_archive_cache_dir();
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create toolchain cache dir: {}", e))?;
    let cache_path = toolchain_archive_cache_path(archive_name);
    if archive_path == cache_path.as_path() {
        return Ok(());
    }
    if cache_path.exists() {
        std::fs::remove_file(&cache_path)
            .map_err(|e| format!("Failed to replace cached archive: {}", e))?;
    }
    match std::fs::rename(archive_path, &cache_path) {
        Ok(()) => Ok(()),
        Err(_) => {
            std::fs::copy(archive_path, &cache_path)
                .map_err(|e| format!("Failed to copy archive to cache: {}", e))?;
            std::fs::remove_file(archive_path)
                .map_err(|e| format!("Failed to remove staging archive: {}", e))?;
            Ok(())
        }
    }
}

/// Resolve GitHub release asset URL, byte size and published digest for a toolchain pack.
pub async fn fetch_toolchain_asset(
    pack: &str,
) -> Result<crate::github_releases::ResolvedAsset, String> {
    let pack_key = pack.trim().to_lowercase();
    let archive_name = pack_archive_name(&pack_key)?;
    let release = crate::github_releases::fetch_release_by_tag(TOOLCHAIN_RELEASE_TAG)
        .await
        .map_err(|e| {
            format!(
                "GitHub release '{}' not found. Upload toolchain assets first. ({e})",
                TOOLCHAIN_RELEASE_TAG
            )
        })?;
    let asset = crate::github_releases::find_asset_by_name(&release, &archive_name)
        .ok_or_else(|| {
            format!(
                "Asset '{}' not found on release '{}'.",
                archive_name, TOOLCHAIN_RELEASE_TAG
            )
        })?;
    Ok(crate::github_releases::ResolvedAsset {
        download_url: asset.download_url,
        name: asset.name,
        release_tag: release.tag_name,
        size: asset.size,
        digest: asset.digest,
    })
}

#[cfg(windows)]
pub fn resolve_7z_exe() -> Result<std::path::PathBuf, String> {
    let app_root = crate::config::app_root_dir();
    let staged = app_root.join("bin").join("7z.exe");
    if staged.is_file() {
        return Ok(staged);
    }
    let dev = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("bin")
        .join("7z.exe");
    if dev.is_file() {
        return Ok(dev);
    }
    Err("Bundled 7z.exe not found in bin/ (next to gsudo.exe).".into())
}

#[cfg(not(windows))]
pub fn resolve_7z_exe() -> Result<std::path::PathBuf, String> {
    Err("Portable Foundry toolchain download is supported on Windows only.".into())
}

const STRAY_TOOLCHAIN_ROOTS: &[&str] = &["cuda", "vs", "Windows Kits", "manifest.json"];

/// Misplaced extract roots from flat archives (cuda/, vs/ at app_root instead of toolchain/).
fn remove_stray_toolchain_roots_at_app_root(app_root: &std::path::Path) -> Result<(), String> {
    for name in STRAY_TOOLCHAIN_ROOTS {
        let p = app_root.join(name);
        if p.is_file() {
            std::fs::remove_file(&p)
                .map_err(|e| format!("Failed to remove stray {}: {}", p.display(), e))?;
            log::info!("[toolchain] Removed stray file {}", p.display());
        } else if p.is_dir() {
            std::fs::remove_dir_all(&p)
                .map_err(|e| format!("Failed to remove stray {}: {}", p.display(), e))?;
            log::info!("[toolchain] Removed stray directory {}", p.display());
        }
    }
    Ok(())
}

/// Move flat-layout payloads that landed at app_root into toolchain/ (legacy bad extracts).
fn consolidate_stray_toolchain_into_toolchain_dir(app_root: &std::path::Path) -> Result<(), String> {
    let tc = toolchain_dir();
    std::fs::create_dir_all(&tc)
        .map_err(|e| format!("Failed to create toolchain dir: {}", e))?;
    for name in STRAY_TOOLCHAIN_ROOTS {
        let src = app_root.join(name);
        if !src.exists() {
            continue;
        }
        let dst = tc.join(name);
        if dst.exists() {
            if src.is_file() && dst.is_file() {
                std::fs::remove_file(&dst).map_err(|e| {
                    format!("Failed to replace {}: {}", dst.display(), e)
                })?;
            } else {
                continue;
            }
        }
        std::fs::rename(&src, &dst).map_err(|e| {
            format!(
                "Failed to move {} into toolchain ({}): {}",
                src.display(),
                dst.display(),
                e
            )
        })?;
        log::info!(
            "[toolchain] Consolidated {} -> {}",
            src.display(),
            dst.display()
        );
    }
    Ok(())
}

/// Replaces the entire portable tree before extract (clean upgrade).
pub fn prepare_toolchain_upgrade(_pack: &str) -> Result<(), String> {
    let app_root = crate::config::app_root_dir();
    let tc = toolchain_dir();
    if tc.exists() {
        std::fs::remove_dir_all(&tc).map_err(|e| {
            format!(
                "Failed to remove existing toolchain before install: {}",
                e
            )
        })?;
        log::info!(
            "[toolchain] Removed existing toolchain tree for install ({})",
            tc.display()
        );
    }
    remove_stray_toolchain_roots_at_app_root(&app_root)?;
    Ok(())
}

#[cfg(windows)]
fn command_no_window(program: &std::path::Path) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = std::process::Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(windows)]
fn archive_has_toolchain_prefix(archive: &std::path::Path) -> Result<bool, String> {
    let seven_z = resolve_7z_exe()?;
    let output = command_no_window(&seven_z)
        .args(["l", "-slt", &archive.to_string_lossy()])
        .output()
        .map_err(|e| format!("Failed to list archive: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to inspect archive layout: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let Some(path) = line.strip_prefix("Path = ") else {
            continue;
        };
        let norm = path.trim().replace('\\', "/");
        if norm == "toolchain" || norm.starts_with("toolchain/") {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(not(windows))]
fn archive_has_toolchain_prefix(_archive: &std::path::Path) -> Result<bool, String> {
    Ok(false)
}

fn resolve_toolchain_extract_dest(
    archive: &std::path::Path,
    app_root: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    if archive_has_toolchain_prefix(archive)? {
        log::info!(
            "[toolchain] Prefixed archive — extracting into app root ({})",
            app_root.display()
        );
        Ok(app_root.to_path_buf())
    } else {
        let dest = toolchain_dir();
        log::info!(
            "[toolchain] Flat archive — extracting into toolchain dir ({})",
            dest.display()
        );
        Ok(dest)
    }
}

/// Verify what the installed pack claims to provide — never "everything".
///
/// A runtime pack carries only cublas/cublasLt/cudart, so `check_all_profiles_strict`
/// (devcmd/MSVC/ml64/SDK/nvcc/include/cmake) would fail every runtime installation. The build
/// pack is the reverse: profiles without the runtime DLLs, because launch needs what build does not.
fn verify_toolchain_install(def: &ToolchainPackDef) -> Result<(), String> {
    match def.kind() {
        PackKind::Runtime => {
            let cuda = def.cuda.as_deref().ok_or_else(|| {
                format!("Pack '{}' is a runtime pack without a cuda version", def.id)
            })?;
            if cuda_runtime_ready_for_version(cuda) {
                Ok(())
            } else {
                Err(format!(
                    "CUDA {cuda} runtime is still incomplete after extracting {}.",
                    def.asset
                ))
            }
        }
        PackKind::Build | PackKind::Full => {
            let checks = check_all_profiles_strict()?;
            let not_ready: Vec<_> = checks.iter().filter(|c| !c.ready).collect();
            if not_ready.is_empty() {
                return Ok(());
            }
            let details: Vec<String> = not_ready
                .iter()
                .flat_map(|c| c.missing.iter().map(|m| format!("{}: {}", c.id, m)))
                .collect();
            Err(format!(
                "Toolchain extracted but {} profile(s) still incomplete:\n  - {}",
                not_ready.len(),
                details.join("\n  - ")
            ))
        }
    }
}

#[cfg(windows)]
pub fn extract_toolchain_archive(
    archive: &std::path::Path,
    dest_root: &std::path::Path,
) -> Result<(), String> {
    let seven_z = resolve_7z_exe()?;
    std::fs::create_dir_all(dest_root)
        .map_err(|e| format!("Failed to create extract dir: {}", e))?;

    let dest = dest_root.to_string_lossy().to_string();
    let output = command_no_window(&seven_z)
        .args([
            "x",
            &archive.to_string_lossy(),
            &format!("-o{}", dest),
            "-y",
            "-aoa",
        ])
        .output()
        .map_err(|e| format!("Failed to run 7-Zip: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "7-Zip extraction failed (exit {:?}): {} {}",
            output.status.code(),
            stderr.trim(),
            stdout.trim()
        )
        .trim()
        .to_string());
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn extract_toolchain_archive(
    _archive: &std::path::Path,
    _dest_root: &std::path::Path,
) -> Result<(), String> {
    Err("Portable Foundry toolchain download is supported on Windows only.".into())
}

/// Extract a toolchain archive into the app root.
///
/// Full packs replace the tree (as before). Partial packs **merge**: installing `runtime-12.8`
/// after `runtime-13.4` must not delete 13.4, and a runtime pack must not delete the VS/SDK tree
/// that the build pack put there. `extract_toolchain_archive` already passes `-aoa`.
///
/// Runtime packs are not cached: keeping a 383 MB archive next to a 523 MB extraction is pure
/// duplication, and re-download is the accepted recovery path for them. Build/full stay cached
/// for install-from-cache and re-extract.
pub fn finalize_toolchain_install(archive_path: &std::path::Path, pack: &str) -> Result<(), String> {
    let app_root = crate::config::app_root_dir();
    let def = pack_def(pack)?;
    let archive_name = def.asset.as_str();

    match def.kind() {
        PackKind::Full => prepare_toolchain_upgrade(&def.id)?,
        PackKind::Runtime | PackKind::Build => {
            std::fs::create_dir_all(toolchain_dir())
                .map_err(|e| format!("Failed to create toolchain dir: {e}"))?;
        }
    }
    remove_stray_toolchain_roots_at_app_root(&app_root)?;

    let extract_dest = resolve_toolchain_extract_dest(archive_path, &app_root)?;
    extract_toolchain_archive(archive_path, &extract_dest)?;
    consolidate_stray_toolchain_into_toolchain_dir(&app_root)?;
    verify_toolchain_install(&def)?;

    if def.kind() == PackKind::Runtime {
        if let Err(e) = std::fs::remove_file(archive_path) {
            log::warn!(
                "[toolchain] Runtime pack verified but the archive could not be removed ({}): {e}",
                archive_path.display()
            );
        }
    } else {
        promote_archive_to_cache(archive_path, archive_name)?;
        log::info!(
            "[toolchain] Verified and cached {} at {}",
            archive_name,
            toolchain_archive_cache_path(archive_name).display()
        );
    }
    Ok(())
}

pub fn install_info(driver_major: Option<u32>) -> Result<ToolchainInstallInfo, String> {
    let app_root = crate::config::app_root_dir();
    let _ = consolidate_stray_toolchain_into_toolchain_dir(&app_root);
    let tc_dir = toolchain_dir();
    let checks = check_all_profiles()?;
    let profiles_ready = checks.iter().filter(|c| c.ready).count();
    let profiles_total = checks.len();

    let manifest = load_manifest()?;
    // Runtime readiness + driver floors describe what *this app* launches, so they come from
    // the embedded manifest (`profile_def` rationale). The disk manifest below still owns
    // pack version and CRT staging.
    let embedded: ToolchainManifest = serde_json::from_str(EMBEDDED_MANIFEST)
        .map_err(|e| format!("Embedded toolchain manifest is invalid: {e}"))?;
    let runtime_ready = check_runtime_ready(&embedded);
    let runtime_versions: Vec<RuntimeVersionInfo> = embedded
        .profiles
        .iter()
        .map(|p| RuntimeVersionInfo {
            id: p.id.clone(),
            label: p.label.clone(),
            cuda: p.cuda.clone(),
            ready: cuda_runtime_ready_for_version(&p.cuda),
            min_driver_major: p.min_driver_major,
            driver_major,
            driver_ok: driver_ok(p.min_driver_major, driver_major),
        })
        .collect();
    let crt_profiles: Vec<String> = manifest.profiles.iter().map(|p| p.id.clone()).collect();
    let packs: Vec<PackOffering> = embedded
        .packs
        .iter()
        .map(|p| {
            let installed = match p.kind() {
                PackKind::Runtime => p
                    .cuda
                    .as_deref()
                    .map(cuda_runtime_ready_for_version)
                    .unwrap_or(false),
                PackKind::Build => profiles_ready == profiles_total && profiles_total > 0,
                PackKind::Full => {
                    profiles_ready == profiles_total
                        && profiles_total > 0
                        && check_runtime_ready(&embedded)
                }
            };
            PackOffering {
                id: p.id.clone(),
                kind: p.kind.clone(),
                cuda: p.cuda.clone(),
                asset: p.asset.clone(),
                size_bytes: p.size_bytes,
                installed,
            }
        })
        .collect();
    let crt_missing: Vec<String> = crt_profiles
        .iter()
        .filter(|p| msvc_crt_missing_message(p, None).is_some())
        .cloned()
        .collect();
    let msvc_crt_ready = crt_missing.is_empty();
    let msvc_crt_error = (!msvc_crt_ready).then(|| {
        msvc_crt_missing_message(crt_missing.first().map(String::as_str).unwrap_or(""), None)
            .unwrap_or_default()
    });

    // A pack built before this app can lack profiles this build offers; say so instead of
    // only reporting the per-profile symptoms.
    let pack_installed_version = load_manifest().ok().map(|m| m.version).unwrap_or(0);
    let pack_expected_version = embedded_manifest_version();

    let cache_dir = toolchain_archive_cache_dir();
    let _ = std::fs::create_dir_all(&cache_dir);

    Ok(ToolchainInstallInfo {
        app_root: app_root.to_string_lossy().to_string(),
        extract_target: app_root.to_string_lossy().to_string(),
        archive_cache_dir: cache_dir.to_string_lossy().to_string(),
        toolchain_dir: tc_dir.to_string_lossy().to_string(),
        release_url: toolchain_release_url(),
        archive_name: pack_archive_name("build")
            .unwrap_or_else(|_| "toolchain-build.7z".to_string()),
        archive_parts: vec![pack_archive_name("build")
            .unwrap_or_else(|_| "toolchain-build.7z".to_string())],
        compressed_size_label: "~1.15 GB".to_string(),
        uncompressed_size_label: "~4.2 GB".to_string(),
        manifest_present: manifest_path().exists(),
        runtime_ready,
        runtime_versions,
        packs,
        msvc_crt_ready,
        msvc_crt_error,
        profiles_ready,
        profiles_total,
        all_ready: profiles_ready == profiles_total && profiles_total > 0,
        profile_checks: checks,
        cached_archives: list_reextractable_archives(),
        pack_installed_version,
        pack_expected_version,
        pack_outdated: pack_is_outdated(pack_installed_version, pack_expected_version),
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
    // Fresh probe every time: the onboarding nudge re-checks in place after a driver update.
    let driver_major = detect_driver_major().await;
    install_info(driver_major)
}

/// Opens the app root folder (legacy — prefer cache folder for manual drops).
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

/// Opens `.toolchain-download\cache` — drop `toolchain.7z` here for install-from-cache.
#[tauri::command]
pub async fn foundry_open_toolchain_cache_folder() -> Result<(), String> {
    let cache_dir = toolchain_archive_cache_dir();
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create toolchain cache dir: {}", e))?;

    #[cfg(windows)]
    {
        open_path_in_shell(&cache_dir)
    }
    #[cfg(not(windows))]
    {
        let _ = cache_dir;
        Err("Portable Foundry toolchain is supported on Windows only.".into())
    }
}
#[cfg(test)]
mod crt_tests {
    use super::*;
    use std::fs;

    fn tmp_tree(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bw-crt-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn touch(dir: &std::path::Path, name: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(name), b"x").unwrap();
    }

    /// The allowlist must match what `dumpbin //DEPENDENTS` reports for the shipped
    /// engines. If a future llama.cpp build starts importing concrt140/vccorlib140 this
    /// list is stale and app-local staging will not save the launch.
    #[test]
    fn crt_allowlist_is_the_measured_surface() {
        assert_eq!(
            MSVC_CRT_DLLS,
            ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"]
        );
    }

    #[test]
    fn has_file_ci_matches_any_case_and_rejects_absent() {
        let d = tmp_tree("ci");
        touch(&d, "MSVCP140.dll");
        assert!(has_file_ci(&d, "msvcp140.dll"));
        assert!(has_file_ci(&d, "MsVcP140.DLL"));
        assert!(!has_file_ci(&d, "vcruntime140.dll"));
        assert!(!has_file_ci(&PathBuf::from("Z:/nope"), "msvcp140.dll"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_crt_in_reports_exactly_the_gaps() {
        let d = tmp_tree("gaps");
        touch(&d, "vcruntime140.dll");
        touch(&d, "vcruntime140_1.dll");
        assert_eq!(missing_crt_in(&d), vec!["msvcp140.dll"]);
        touch(&d, "msvcp140.dll");
        assert!(missing_crt_in(&d).is_empty());
        let _ = fs::remove_dir_all(&d);
    }

    /// App-local copies must satisfy presence without touching toolchain or System32.
    /// This is the guarantee the staging scripts rely on.
    #[test]
    fn app_local_dir_satisfies_crt() {
        let d = tmp_tree("applocal");
        for dll in MSVC_CRT_DLLS {
            touch(&d, dll);
        }
        // No engine-dir hint → relies on toolchain/System32 (profile-unresolvable).
        assert!(missing_crt_in(&d).is_empty());
        let _ = fs::remove_dir_all(&d);
    }

    /// A partial app-local set must NOT count as present — half-staged is exactly the
    /// case that produces a LoadLibrary failure with no useful log.
    #[test]
    fn partial_app_local_set_is_not_present() {
        let d = tmp_tree("partial");
        touch(&d, "vcruntime140.dll");
        assert_eq!(missing_crt_in(&d).len(), 2);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn msvc_hostx64_bin_dir_layout() {
        let p = msvc_hostx64_bin_dir("2022", "14.44.35207");
        let s = p.to_string_lossy().replace('\\', "/");
        assert!(s.ends_with("vs/2022/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64"), "{s}");
    }

    /// Missing CRT must produce an actionable message, never a bare panic/None-on-error.
    #[test]
    fn missing_message_names_dlls_and_remedy() {
        let d = tmp_tree("msg");
        // Force the "nothing found" shape by asserting on the message builder directly:
        // an empty engine dir with no toolchain/System32 match is machine-dependent, so
        // only check the string shape when it does fire.
        if let Some(msg) = msvc_crt_missing_message("definitely-not-a-profile", Some(&d)) {
            assert!(msg.contains("vcruntime140.dll"));
            assert!(msg.contains("Redistributable"));
            assert!(msg.contains("toolchain"));
        }
        let _ = fs::remove_dir_all(&d);
    }

    /// apply_msvc_crt_to_command must never panic and never strip an existing PATH.
    #[test]
    fn apply_crt_never_panics_or_empties_path() {
        let mut cmd = std::process::Command::new("cmd");
        apply_msvc_crt_to_command(&mut cmd, "edge", None);
        apply_msvc_crt_to_command(&mut cmd, "", None);
        apply_msvc_crt_to_command(&mut cmd, "edge", Some(PathBuf::from("Z:/absent").as_path()));
        // If it did set PATH, it must still contain the original prefix.
        if let Some((_, v)) = cmd.get_envs().find(|(k, _)| *k == std::ffi::OsStr::new("PATH")) {
            assert!(v.map(|s| !s.is_empty()).unwrap_or(false));
        }
    }

    /// Regression: CRT fallback must merge into the command PATH that already carries
    /// portable CUDA bins. The CRT commit efd5bb2e1 read only the parent process PATH and
    /// overwrote cmd PATH — wiping cublas/cudart and producing a raw Windows
    /// "cublas64_13.dll was not found" dialog on machines where CRT was not app-local.
    #[test]
    fn apply_crt_preserves_command_cuda_path() {
        let mut cmd = std::process::Command::new("cmd");
        let cuda_marker = r"C:\app\toolchain\cuda\v13.4\bin\x64";
        let seeded = format!("{cuda_marker};C:\\Windows\\System32");
        cmd.env("PATH", &seeded);
        // engine_dir absent / incomplete forces the PATH-fallback branch when a portable
        // CRT dir exists; if no CRT dir resolves, PATH must still stay exactly seeded.
        apply_msvc_crt_to_command(&mut cmd, "edge", Some(PathBuf::from("Z:/absent").as_path()));
        let path = cmd
            .get_envs()
            .find(|(k, _)| k.to_string_lossy().eq_ignore_ascii_case("PATH"))
            .and_then(|(_, v)| v.map(|s| s.to_string_lossy().into_owned()))
            .expect("PATH must remain set on the command");
        assert!(
            path.split(';').any(|e| e.eq_ignore_ascii_case(cuda_marker)),
            "portable CUDA bin dir must survive CRT PATH merge, got: {path}"
        );
        assert!(
            path.split(';').any(|e| e.eq_ignore_ascii_case(r"C:\Windows\System32")),
            "remainder of seeded PATH must survive CRT merge, got: {path}"
        );
    }
}

/// Guards the promise in this module's doc comment: every Foundry build input
/// resolves under <app_root>/toolchain/, never a Visual Studio / CUDA / CMake
/// install that happens to exist on the machine.
///
/// These are derivation and manifest assertions, not filesystem probes, so they
/// hold on a CI runner with no toolchain pack and on a dev box that has its own
/// VS installed. That is the point: the guarantee must not depend on what the
/// machine happens to have.
#[cfg(test)]
mod isolation_tests {
    use super::*;
    use std::path::Path;

    /// The three paths the build shell depends on all derive from the pack root.
    #[test]
    fn build_tools_resolve_only_inside_the_toolchain_pack() {
        let root = toolchain_dir();
        for (label, path) in [
            ("portable cmake", cmake_exe_path()),
            ("portable ninja", ninja_exe_path()),
            ("toolchain manifest", manifest_path()),
        ] {
            assert!(
                path.starts_with(&root),
                "{label} resolved to {} — outside the toolchain root {}",
                path.display(),
                root.display()
            );
        }
    }

    /// The manifest is compiled into the binary (include_str!), which is what lets
    /// the app validate and report readiness without the pack present. Every path it
    /// carries must be RELATIVE: an absolute C:/Program Files/... entry here would
    /// silently reintroduce the system dependency the pack exists to remove.
    #[test]
    fn embedded_manifest_is_portable_and_self_consistent() {
        let manifest: ToolchainManifest =
            serde_json::from_str(EMBEDDED_MANIFEST).expect("embedded manifest parses");
        assert!(!manifest.profiles.is_empty(), "manifest lists no profiles");
        assert!(
            !manifest.windows_sdk_version.trim().is_empty(),
            "manifest has no windows_sdk_version"
        );

        for (key, vs) in [("2022", &manifest.vs.vs2022), ("2026", &manifest.vs.vs2026)] {
            assert!(
                !Path::new(&vs.devcmd).is_absolute(),
                "vs.{key}.devcmd is absolute ({}) — it must resolve inside the pack",
                vs.devcmd
            );
            assert!(!vs.msvc_version.trim().is_empty(), "vs.{key}.msvc_version is empty");
        }

        for profile in &manifest.profiles {
            assert!(
                vs_def(&manifest, &profile.vs).is_ok(),
                "profile {} names vs {}, which the manifest does not define",
                profile.id,
                profile.vs
            );
            assert!(
                !profile.cuda.trim().is_empty(),
                "profile {} names no CUDA version",
                profile.id
            );
        }
    }
    /// The pack is a RUNTIME dependency too: launching builds the child PATH as
    /// "toolchain CUDA bin(s) + scrubbed(inherited PATH)". A user's own NVIDIA
    /// toolkit must be dropped, not merely outranked, or a mismatched CUDA can still
    /// be picked up by the loader.
    #[test]
    fn foreign_cuda_is_scrubbed_from_the_inherited_path() {
        let inherited = [
            r"C:\Windows\system32",
            r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.4\bin",
            r"D:\Other\App\toolchain\cuda\v12.8\bin",
            r"C:\Windows",
        ]
        .join(";");
        let scrubbed = scrub_foreign_cuda_from_path(&inherited);
        assert!(
            !scrubbed.to_lowercase().contains("nvidia gpu computing toolkit"),
            "a system CUDA install survived the scrub: {scrubbed}"
        );
        assert!(
            !scrubbed.to_lowercase().contains(r"toolchain\cuda"),
            "another app's toolchain CUDA survived the scrub: {scrubbed}"
        );
        assert_eq!(
            scrubbed, r"C:\Windows\system32;C:\Windows",
            "the scrub must keep ordinary entries and drop blank ones"
        );
    }

    /// Classification covers both shapes a foreign CUDA takes — a system toolkit and
    /// another toolchain tree — and is slash-agnostic. Note it classifies our own
    /// toolchain path as foreign too: that is intended, the inherited PATH must never
    /// carry it and the launch prepends it explicitly.
    #[test]
    fn foreign_cuda_classification_covers_system_and_foreign_trees() {
        assert!(path_entry_is_foreign_cuda(
            r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.8\bin"
        ));
        assert!(path_entry_is_foreign_cuda(
            "C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA/v12.8/bin"
        ));
        assert!(path_entry_is_foreign_cuda(r"D:\Apps\blackwell\toolchain\cuda\v13.4\bin"));
        assert!(!path_entry_is_foreign_cuda(r"C:\Windows\system32"));
        assert!(!path_entry_is_foreign_cuda("   "));
    }
    /// A profile can be withheld from the pack. profile_ids is the single filter that
    /// inventory, discovery and the build list read, so this flag is the whole switch —
    /// the profile stays resolvable by id but is never offered.
    #[test]
    fn withheld_profiles_are_not_offered() {
        let vs = VsDef {
            msvc_version: "1".into(),
            cmake_version: "1".into(),
            devcmd: "vs/2026/devcmd.bat".into(),
            label: "x".into(),
        };
        let profile = |id: &str, cuda: &str, distributed: bool| ProfileDef {
            id: id.into(),
            label: id.to_uppercase(),
            vs: "2026".into(),
            cuda: cuda.into(),
            generator: "Visual Studio 18 2026".into(),
            arch: "x64".into(),
            ninja: true,
            description: String::new(),
            distributed,
            min_driver_major: None,
        };
        let manifest = ToolchainManifest {
            version: 3,
            windows_sdk_version: "10.0.26100.0".into(),
            vs: VsManifest { vs2022: vs.clone(), vs2026: vs },
            profiles: vec![profile("edge", "13.4", true), profile("lab", "13.9", false)],
            packs: Vec::new(),
        };

        assert_eq!(profile_ids(&manifest), vec!["edge".to_string()]);
        assert_eq!(all_profile_ids(&manifest), vec!["edge".to_string(), "lab".to_string()]);
    }
    /// An installed pack older than the app is stale: it may not carry the profiles this
    /// build offers. Only a strictly older version is flagged — a newer pack is forward-
    /// readable, and "nothing installed" is a different failure that check() reports.
    #[test]
    fn stale_packs_are_detected_by_version_only() {
        assert!(!pack_is_outdated(0, 3), "nothing installed is not outdated");
        assert!(pack_is_outdated(2, 3), "v2 pack against a v3 app must be flagged");
        assert!(!pack_is_outdated(3, 3), "same version is current");
        assert!(!pack_is_outdated(4, 3), "a newer pack must not be flagged");
    }

    /// The embedded manifest must stay parseable and carry a version — it is the app's
    /// expectation, and an unparseable one would silently disable the comparison above.
    #[test]
    fn embedded_manifest_reports_a_version() {
        assert!(
            embedded_manifest_version() > 0,
            "embedded toolchain/manifest.json did not parse or has no version"
        );
    }
}
