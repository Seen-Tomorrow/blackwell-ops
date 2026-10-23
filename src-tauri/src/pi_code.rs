//! pi coding agent external harness — external tool (not core app).
//!
//! Install: `{app_root}/external-tools/pi/`
//! Home:    `{app_root}/config/external-tools/pi-home/`  (PI_CODING_AGENT_DIR)
//! Never uses the user's PATH or global `~/.pi` / npm install.
//! pi is distributed as a Bun-compiled standalone Windows binary
//! (`pi-windows-x64.zip` from GitHub releases) — self-contained, no Node/Bun at runtime.
//! Launch is always a detached external console.

use serde::{Deserialize, Serialize};
use crate::external_agents::emit_dbg;
use std::path::{Path, PathBuf};

/// Pinned release we verified against local OpenAI-compatible engines.
///
/// Sourced from `src-tauri/pi-pinned-version.txt` at build time (see the majestic
/// `bump-pi` release step) so the release binary embeds the same pi version the
/// developer tested in DEV — no hand-editing Rust. Keep the file in sync before
/// packing a release; `pi-ext/` is bundled as-is at build time too. The file is
/// written without a trailing newline; the install path trims anyway.
pub const PINNED_VERSION: &str = include_str!("../pi-pinned-version.txt");

/// Pinned `pi-subagents` version for the bundled extension.
///
/// Pinned because "latest" is not usable: on Windows, every version from 0.70.0 up
/// (0.70/0.76.1/0.77/0.79.2/0.80) crashes the host on any **workflow/parallel** run —
/// pi exits 3 and the embedded Bun 1.3.14 panics with
/// `Internal assertion failure: cannot resolve DirInfo for non-absolute path:` (empty
/// path), while single-subagent runs are fine. 0.58.0 was measured 3/3 clean on the same
/// machine/engine/cwd, so it is what ships until upstream fixes that spawn path.
///
/// The pin also decouples the two bumps: `UPDATE HARNESS` may move pi to a newer release
/// while the extension stays here. Written without a trailing newline, like the pi pin.
pub const PINNED_SUBAGENTS_VERSION: &str = include_str!("../pi-subagents-pinned-version.txt");

const GITHUB_RELEASE_BASE: &str = "https://github.com/earendil-works/pi/releases/download";

// ── Paths ──────────────────────────────────────────────────────────────

fn tools_dir() -> PathBuf {
    crate::config::app_root_dir()
        .join("external-tools")
        .join("pi")
}

/// Extracted standalone package root (contains pi.exe + assets/theme/docs).
fn package_dir() -> PathBuf {
    tools_dir().join("pi")
}

/// Outer launcher (Blackwell shim) — sets PI_CODING_AGENT_DIR then runs pi.exe.
pub fn launcher_path() -> PathBuf {
    tools_dir().join("bin").join("pi.cmd")
}

fn package_binary() -> PathBuf {
    package_dir().join("pi.exe")
}

pub fn home_dir() -> PathBuf {
    crate::config::config_dir()
        .join("external-tools")
        .join("pi-home")
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

// ── Status ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiCodeStatus {
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
    launcher_path().is_file() && package_binary().is_file()
}

fn probe_version() -> Option<String> {
    let launcher = launcher_path();
    if !launcher.is_file() {
        return None;
    }
    let out = std::process::Command::new("cmd")
        .args(["/c", &launcher.to_string_lossy(), "--version"])
        .env("PI_CODING_AGENT_DIR", home_dir())
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

/// Reinstall pi when the install on disk is not the pinned version.
///
/// An app update replaces the bundled `pi-ext` tree but leaves `external-tools/pi`
/// untouched, so a stale host ends up loading a newer extension. The two are a matched
/// pair — `pi-subagents` declares a peer range on the host's API surface — and the
/// failure is a cryptic `(0, _piAi.toToolDeclaration) is not a function` with no
/// `subagent` tool, which reads as a packaging bug rather than as version skew.
/// `PINNED_VERSION` is the single source of truth for that pair, so reconcile here
/// instead of letting the extension discover the mismatch at load time.
#[cfg(windows)]
async fn ensure_pinned_pi_version() -> Result<(), String> {
    let pinned = PINNED_VERSION.trim();
    if pinned.is_empty() {
        return Ok(());
    }
    // No stamp to compare means a pre-stamp install; leave it alone rather than
    // reinstalling on every launch.
    let Some(installed) = read_version_stamp() else {
        return Ok(());
    };
    if installed == pinned {
        return Ok(());
    }

    // Replacing the package directory under a running pi.exe is a sharing violation on
    // Windows, and the caller is about to spawn exactly that binary.
    let live = running_pi_consoles();
    if !live.is_empty() {
        let ids = live
            .iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "pi {installed} is running (PID {ids}) but this build requires {pinned}. \
             Close the pi window — Blackwell updates pi on the next launch."
        ));
    }

    emit_dbg(&format!(
        "[Pi] installed {installed} != pinned {pinned} — reinstalling before launch"
    ));
    install_pi_version(pinned).await?;
    Ok(())
}

#[tauri::command]
pub async fn pi_code_status() -> Result<PiCodeStatus, String> {
    let installed = is_installed();
    let version = if installed {
        read_version_stamp().or_else(probe_version)
    } else {
        None
    };
    let last_project = crate::external_agents::read_trimmed(&last_project_path());
    Ok(PiCodeStatus {
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
pub async fn pi_code_accept_disclaimer() -> Result<(), String> {
    crate::external_agents::write_disclaimer(&home_dir(), PINNED_VERSION)
}

#[tauri::command]
pub async fn pi_code_set_project(project_dir: String) -> Result<PiCodeStatus, String> {
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
    pi_code_status().await
}

// ── Install ────────────────────────────────────────────────────────────

fn windows_arch_tag() -> Result<&'static str, String> {
    let arch = std::env::var("PROCESSOR_ARCHITEW6432")
        .or_else(|_| std::env::var("PROCESSOR_ARCHITECTURE"))
        .unwrap_or_else(|_| "AMD64".into());
    match arch.to_uppercase().as_str() {
        "AMD64" | "X86_64" => Ok("x64"),
        "ARM64" => Ok("arm64"),
        other => Err(format!("Unsupported architecture for pi: {other}")),
    }
}

fn release_zip_url(version: &str) -> String {
    // Tag uses v-prefix on GitHub releases.
    let tag = if version.starts_with('v') {
        version.to_string()
    } else {
        format!("v{version}")
    };
    let arch = windows_arch_tag().unwrap_or("x64");
    format!("{GITHUB_RELEASE_BASE}/{tag}/pi-windows-{arch}.zip")
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
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next()?.trim_start_matches('*');
        if name.eq_ignore_ascii_case(archive_name) && hash.len() == 64 {
            return Some(hash.to_ascii_lowercase());
        }
    }
    None
}

/// Write the Blackwell outer shim. ROOT = package (pi/) relative to bin/.
///
/// **Always** forces `PI_CODING_AGENT_DIR` to the app-isolated agent dir
/// (`{app_root}/config/external-tools/pi-home`), which **replaces** pi's default
/// `~/.pi/agent` (see pi docs). Without this, a bare `pi.cmd` / double-click
/// falls back to `%USERPROFILE%\.pi\agent` and the model will correctly claim
/// that path — which is exactly the isolation failure we must prevent.
///
/// Layout from `bin\`: `..\..\..\config\external-tools\pi-home`
/// (`bin` → `pi` tools → `external-tools` → app root).
fn write_outer_shim(tools: &Path) -> Result<(), String> {
    let bin = tools.join("bin");
    std::fs::create_dir_all(&bin).map_err(|e| format!("bin dir: {e}"))?;
    let shim = outer_shim_body(tools, &home_dir());
    std::fs::write(bin.join("pi.cmd"), shim).map_err(|e| format!("write shim: {e}"))?;
    Ok(())
}

/// Batch body for the outer shim. Pure so the spaced-path contract is testable
/// without touching the real install dir.
///
/// Anchor `PKG` and `PI_CODING_AGENT_DIR` on ABSOLUTE paths baked in at write
/// time. `%~dp0` is NOT reliable as the primary source: under the launch chain
/// (`cmd /d /s /c ""session.cmd""` → `call "launcher.cmd"`), an outer
/// `call ""path""` injects a stray `"` into the middle of `%~dp0`, so
/// `%~dp0..\pi` resolves to `…\Blackwell OPS\"…\pi` and pi.exe is "not found"
/// (the `'""C:\AI-MASTER\Blackwell' is not recognized` symptom on install dirs
/// with spaces). The app always knows its own layout, so bake it in; keep the
/// `%~dp0` form only as a guarded fallback for a moved portable install.
fn outer_shim_body(tools: &Path, home: &Path) -> String {
    let home_abs = home.to_string_lossy().replace('"', "");
    let pkg_abs = tools.join("pi").to_string_lossy().replace('"', "");
    format!(
        r#"@echo off
setlocal
REM Blackwell-isolated pi launcher (package lives in ..\pi)
REM PI_CODING_AGENT_DIR overrides pi default ~/.pi/agent - never user profile.
REM Absolute anchors first: %~dp0 is unreliable under the spaced-path launch chain.
set "PKG={pkg_abs}"
if not exist "%PKG%\pi.exe" set "PKG=%~dp0..\pi"
if not defined PI_CODING_AGENT_DIR (
  if exist "{home_abs}\" (
    set "PI_CODING_AGENT_DIR={home_abs}"
  ) else (
    set "PI_CODING_AGENT_DIR=%PKG%\..\..\..\config\external-tools\pi-home"
  )
)
if not defined PI_SUBAGENT_PI_BINARY set "PI_SUBAGENT_PI_BINARY=%PKG%\pi.exe"
"%PKG%\pi.exe" %*
exit /b %ERRORLEVEL%
"#
    )
}

#[cfg(test)]
mod shim_tests {
    use super::*;

    /// `PINNED_VERSION` addresses a real pi release and is what the shipped `pi-ext`
    /// bundle was tested against — `ensure_pinned_pi_version` reinstalls on any
    /// mismatch, so a malformed pin would break every launch rather than one download.
    #[test]
    fn pinned_version_is_a_bare_release_version() {
        let pinned = PINNED_VERSION.trim();
        assert_eq!(
            pinned,
            PINNED_VERSION.trim_start_matches('v'),
            "pin must not carry the release's 'v' prefix — the download URL adds it"
        );
        let parts: Vec<&str> = pinned.split('.').collect();
        assert_eq!(parts.len(), 3, "expected MAJOR.MINOR.PATCH, got {pinned}");
        assert!(
            parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())),
            "pin must be numeric MAJOR.MINOR.PATCH, got {pinned}"
        );
    }

    /// The shipped bundle must be exactly the pinned version. 0.70+ satisfies the peer
    /// range, loads, and then kills the host on the first workflow/parallel run, so the
    /// pin — not semver — is what decides what ships.
    #[test]
    fn pi_subagents_pin_matches_shipped_bundle() {
        let pinned = PINNED_SUBAGENTS_VERSION.trim();
        assert!(!pinned.is_empty(), "pi-subagents pin is empty");
        assert_eq!(
            pinned,
            PINNED_SUBAGENTS_VERSION.trim_start_matches('v'),
            "bundle pin must not carry a 'v' prefix"
        );
        // Compare against the REPO tree — that is what NSIS stages. (`app_root_dir()` in a
        // test binary resolves to `target/debug/deps`, so the runtime helper would skip.)
        let pkg = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("pi-ext")
            .join("pi-subagents")
            .join("package.json");
        let Ok(raw) = std::fs::read_to_string(&pkg) else {
            return; // gitignored on a clean checkout (CI fabricates a stub tree)
        };
        let v: serde_json::Value = serde_json::from_str(&raw).expect("bundle package.json");
        let shipped = v.get("version").and_then(|x| x.as_str()).unwrap_or_default();
        assert_eq!(
            shipped, pinned,
            "shipped pi-subagents bundle is not the pinned version — run Distribution > UPDATE HARNESS"
        );
    }

    /// pi 1.4.0 provides `typebox` itself and rejects extensions that ship a copy. The
    /// shipped manifest must therefore declare it as a `"*"` peer, never a dependency —
    /// otherwise every start reports the host-provided-package issue and a duplicate
    /// module can be loaded.
    #[test]
    fn shipped_bundle_declares_typebox_as_host_peer() {
        let pkg = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("pi-ext")
            .join("pi-subagents")
            .join("package.json");
        let Ok(raw) = std::fs::read_to_string(&pkg) else {
            return; // gitignored on a clean checkout
        };
        let v: serde_json::Value = serde_json::from_str(&raw).expect("bundle package.json");
        assert!(
            v.get("dependencies").and_then(|d| d.get("typebox")).is_none(),
            "typebox must not be a dependency — pi provides it as a host module"
        );
        assert_eq!(
            v.get("peerDependencies").and_then(|p| p.get("typebox")).and_then(|x| x.as_str()),
            Some("*"),
            "typebox must be declared as a \"*\" peer for pi 1.4+"
        );
    }

    /// The host/bundle pairing rule: a `>=` floor is compared numerically, and a bundle
    /// that declares no floor never blocks anything.
    #[test]
    fn peer_floor_parsing_matches_pi_semantics() {
        assert_eq!(numeric_version("1.4.0"), Some((1, 4, 0)));
        assert_eq!(numeric_version("v1.2.3"), Some((1, 2, 3)));
        assert_eq!(numeric_version("1.2"), Some((1, 2, 0)));
        assert_eq!(numeric_version("1.2.x"), Some((1, 2, 0)));
        assert_eq!(numeric_version("not-a-version"), None);

        assert_eq!(peer_floor(">=1.2.0"), Some((1, 2, 0)));
        assert_eq!(peer_floor(">= 1.2.0"), Some((1, 2, 0)));
        assert_eq!(peer_floor("*"), None);
        assert_eq!(peer_floor(""), None);
    }

    /// The exact pair that shipped broken in a REL build: bundle 0.80.0 declares
    /// `@earendil-works/pi-ai >= 1.2.0`, the machine had pi 0.84.3, and the extension
    /// died on a missing export instead of the app refusing the pair.
    #[test]
    fn host_below_bundle_floor_is_rejected() {
        let floor = (1u64, 2u64, 0u64);
        assert!(numeric_version("0.84.3").unwrap() < floor);
        assert!(numeric_version("1.2.0").unwrap() >= floor);
        assert!(numeric_version("1.4.0").unwrap() >= floor);
    }

    /// `globalConcurrencyLimit` is the only concurrency key the extension reads;
    /// `parallel.concurrency` was ignored by every version and must not come back.
    #[test]
    fn subagents_config_writes_only_keys_the_extension_reads() {
        let home = std::env::temp_dir().join(format!("boc-subcfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();

        write_subagents_config(&home, 8).expect("write config");
        let raw = std::fs::read_to_string(home.join("extensions/subagent/config.json"))
            .expect("config.json written");
        let v: serde_json::Value = serde_json::from_str(&raw).expect("valid json");

        assert_eq!(
            v.get("globalConcurrencyLimit").and_then(|x| x.as_u64()),
            Some(8),
            "the engine's slot count must reach globalConcurrencyLimit"
        );
        assert_eq!(v.get("artifactDir").and_then(|x| x.as_str()), Some("session"));
        assert!(
            v.get("parallel").is_none(),
            "config.parallel is read by no pi-subagents version — do not reintroduce it"
        );

        let _ = std::fs::remove_dir_all(&home);
    }

    /// The documented per-batch cap must be the extension's actual constant, otherwise the
    /// generated PI.md/AGENTS.md tell the orchestrator something untrue.
    #[test]
    fn subagent_batch_cap_matches_bundle() {
        let p = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("pi-ext")
            .join("pi-subagents")
            .join("src")
            .join("runs")
            .join("shared")
            .join("parallel-utils.js");
        // gitignored on a clean checkout (CI fabricates a stub tree) — nothing to compare.
        let Ok(raw) = std::fs::read_to_string(&p) else {
            return;
        };
        let needle = "MAX_PARALLEL_CONCURRENCY =";
        let Some(idx) = raw.find(needle) else {
            return;
        };
        let digits: String = raw[idx + needle.len()..]
            .trim_start()
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        let cap: u32 = digits.parse().expect("MAX_PARALLEL_CONCURRENCY literal");
        assert_eq!(
            cap, SUBAGENT_BATCH_CONCURRENCY,
            "pi-subagents changed its per-batch cap — update SUBAGENT_BATCH_CONCURRENCY and the \
             generated fan-out instructions"
        );
    }

    /// The outer shim must anchor `PKG` on an ABSOLUTE path baked in at write
    /// time, never on `%~dp0` as the primary source. Under the spaced-path launch
    /// chain (`cmd /d /s /c ""session.cmd""` → `call "launcher.cmd"`), an outer
    /// `call ""path""` injects a stray `"` into `%~dp0`, which previously made
    /// `%~dp0..\pi` resolve to `…\Blackwell OPS\"…\pi` — the
    /// `'""C:\AI-MASTER\Blackwell' is not recognized` launch failure.
    #[test]
    fn outer_shim_anchors_pkg_on_absolute_path_not_dp0() {
        let tools = Path::new(r"C:\AI-MASTER\Blackwell OPS portable\external-tools\pi");
        let home = Path::new(r"C:\AI-MASTER\Blackwell OPS portable\config\external-tools\pi-home");
        let body = outer_shim_body(tools, home);

        // Primary PKG anchor must be the absolute package dir, not %~dp0.
        let primary = body
            .lines()
            .find(|l| l.starts_with("set \"PKG="))
            .expect("PKG assignment present");
        assert!(
            !primary.contains("%~dp0"),
            "primary PKG anchor must not use %%~dp0 (polluted by spaced-path launch chain): {primary}"
        );
        assert!(
            primary.contains(&tools.to_string_lossy().replace('"', "")),
            "primary PKG anchor must be the absolute package dir: {primary}"
        );
        // The %~dp0 fallback may still exist (moved portable install), but only
        // behind an `if not exist` guard.
        assert!(
            body.contains("if not exist \"%PKG%\\pi.exe\" set \"PKG=%~dp0..\\pi\""),
            "%%~dp0 fallback must remain guarded for moved installs"
        );
    }
}

fn extract_zip_windows(zip: &Path, dest: &Path) -> Result<(), String> {
    // Prefer bundled 7z: silent (CREATE_NO_WINDOW), no PowerShell console flash.
    // 7z extracts .zip the same as .7z.
    if crate::archive_util::extract_7z_archive(zip, dest).is_ok() {
        return Ok(());
    }

    // Fallback: Expand-Archive with CREATE_NO_WINDOW so no external console pops.
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let zip_s = zip.to_string_lossy().replace('\'', "''");
    let dest_s = dest.to_string_lossy().replace('\'', "''");
    let ps = format!(
        "Expand-Archive -LiteralPath '{zip_s}' -DestinationPath '{dest_s}' -Force"
    );
    let out = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &ps,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Expand-Archive spawn: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Expand-Archive failed: {err}"));
    }
    Ok(())
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

/// Install (or reinstall) a specific pi binary version into `external-tools/pi`.
/// Shared by the pinned install command and the DEV-only update-to-latest path.
#[cfg(windows)]
async fn install_pi_version(version: &str) -> Result<(), String> {
    if !disclaimer_path().is_file() {
        return Err("Accept the pi disclaimer first (pi_code_accept_disclaimer).".into());
    }
    let ver = version.trim().trim_start_matches('v').to_string();
    if ver.is_empty() {
        return Err("pi version must not be empty.".into());
    }

    let tools = tools_dir();
    std::fs::create_dir_all(&tools).map_err(|e| format!("tools dir: {e}"))?;
    std::fs::create_dir_all(home_dir()).map_err(|e| format!("home: {e}"))?;

    let archive_name = format!("pi-windows-{}.zip", windows_arch_tag()?);
    let zip_url = release_zip_url(&ver);
    let sums_url = release_sums_url(&ver);
    emit_dbg(&format!("[Pi] Downloading standalone {ver}…"));
    emit_dbg(&format!("[Pi] {zip_url}"));

    let zip_bytes = crate::external_agents::download_bytes(&zip_url).await?;
    if zip_bytes.len() < 10_000_000 {
        return Err(format!(
            "Standalone zip too small ({} bytes) — release may be missing: {zip_url}",
            zip_bytes.len()
        ));
    }
    let actual = crate::external_agents::sha256_hex(&zip_bytes);
    let sums_text = match crate::external_agents::download_bytes(&sums_url).await {
        Ok(b) => String::from_utf8_lossy(&b).to_string(),
        Err(e) => {
            emit_dbg(&format!("[Pi] SHA256SUMS download failed: {e}"));
            String::new()
        }
    };
    match parse_sums_expected(&sums_text, &archive_name) {
        Some(expected) if expected == actual => emit_dbg("[Pi] SHA-256 OK"),
        Some(expected) => {
            return Err(format!(
                "Checksum mismatch for {archive_name}: expected {expected}, got {actual}"
            ));
        }
        // No manifest entry (or no manifest at all) means nothing attests to these bytes.
        // This used to log and install anyway. A binary that Blackwell downloads, unpacks
        // and executes gets verified or it does not get installed.
        None => {
            return Err(format!(
                "No SHA256SUMS entry for {archive_name} on pi {ver} — refusing to install an \
                 unverified binary (got sha256={actual})."
            ));
        }
    }

    // Save with a real `.zip` extension: PowerShell Expand-Archive determines the
    // archive type from the file extension, so a `.download` suffix would be rejected.
    let zip_path = tools.join(&archive_name);
    std::fs::write(&zip_path, &zip_bytes).map_err(|e| format!("write zip: {e}"))?;

    let extract_root = tools.join("_extract");
    if extract_root.exists() {
        let _ = std::fs::remove_dir_all(&extract_root);
    }
    std::fs::create_dir_all(&extract_root).map_err(|e| format!("extract dir: {e}"))?;
    extract_zip_windows(&zip_path, &extract_root)?;

    // Zip contains top-level `pi.exe` (flat) + assets/theme/docs/etc.
    if !extract_root.join("pi.exe").is_file() {
        let _ = std::fs::remove_dir_all(&extract_root);
        let _ = std::fs::remove_file(&zip_path);
        return Err("Archive missing pi.exe.".into());
    }

    let dest_pkg = package_dir();
    if dest_pkg.exists() {
        std::fs::remove_dir_all(&dest_pkg).map_err(|e| {
            format!(
                "Cannot replace {}: {e}. Close any running pi from Blackwell and retry.",
                dest_pkg.display()
            )
        })?;
    }
    if let Err(e) = std::fs::rename(&extract_root, &dest_pkg) {
        copy_dir_all(&extract_root, &dest_pkg).map_err(|e2| {
            format!("install move failed: {e} / {e2}")
        })?;
    }

    write_outer_shim(&tools)?;
    std::fs::write(version_stamp_path(), format!("{ver}\n"))
        .map_err(|e| format!("version stamp: {e}"))?;

    let _ = std::fs::remove_file(&zip_path);
    Ok(())
}

#[tauri::command]
pub async fn pi_code_install(
    app: tauri::AppHandle,
    version: Option<String>,
) -> Result<PiCodeStatus, String> {
    #[cfg(not(windows))]
    {
        let _ = (app, version);
        return Err("pi tool install is only supported on Windows.".into());
    }

    #[cfg(windows)]
    {
        let ver = version
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.trim_start_matches('v').to_string())
            .unwrap_or_else(|| PINNED_VERSION.to_string());
        install_pi_version(&ver).await?;
        let _ = app;
        emit_dbg(&format!("[Pi] Installed → {}", launcher_path().display()));
        pi_code_status().await
    }
}

// ── Update to latest (DEV-only) ────────────────────────────────────────

/// Repo root for the bundled pi-subagents extension (DEV source tree).
/// `env!("CARGO_MANIFEST_DIR")` is `src-tauri/` at build time.
#[cfg(windows)]
fn dev_pi_ext_src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("pi-ext")
}

/// Running pi console processes whose image lives under our `external-tools/pi` package.
///
/// `install_pi_version` replaces that whole directory and `sync_dev_pi_ext` replaces
/// `target/debug/pi-ext`. Both `remove_dir_all` the tree a **live** session is executing
/// from: on Windows the running image cannot be deleted, so the update fails with a
/// sharing violation after the download, and a session that survives the call may be
/// left with its docs/assets/wasm replaced underneath it. Match on the image path, not
/// just the name `pi.exe`, so a pi installed elsewhere on the machine is not counted.
#[cfg(windows)]
fn running_pi_consoles() -> Vec<u32> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

    let pkg = match package_dir().canonicalize() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let pkg_l = pkg.to_string_lossy().to_lowercase();

    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::Always),
    );

    sys.processes()
        .iter()
        .filter(|(_, proc)| {
            proc.name().to_string_lossy().eq_ignore_ascii_case("pi.exe")
                && proc
                    .exe()
                    .map(|exe| exe.to_string_lossy().to_lowercase().starts_with(&pkg_l))
                    .unwrap_or(false)
        })
        .map(|(pid, _)| pid.as_u32())
        .collect()
}

#[cfg(not(windows))]
fn running_pi_consoles() -> Vec<u32> {
    Vec::new()
}

/// True when a pi console launched from our package is still running.
///
/// Exposed so the UI can block "UPDATE PI" behind a confirm modal instead of letting
/// the user discover the sharing violation mid-update.
#[tauri::command]
pub async fn pi_code_console_running() -> Result<Vec<u32>, String> {
    Ok(running_pi_consoles())
}

/// 1-click DEV update: fetch the newest pi release, reinstall the binary, then
/// refresh the bundled pi-subagents extension from npm and re-sync the DEV tree.
///
/// **DEV-only.** Release builds ship the pinned, verified pi (see `PINNED_VERSION`);
/// following GitHub "latest" is an unverified action a regular user shouldn't take,
/// so the UI hides the button outside dev builds and this command refuses to run
/// unless compiled as a debug build.
#[tauri::command]
pub async fn pi_code_update_latest() -> Result<PiCodeStatus, String> {
    #[cfg(not(windows))]
    {
        return Err("pi tool install is only supported on Windows.".into());
    }

    #[cfg(windows)]
    {
        if !cfg!(debug_assertions) {
            return Err(
                "pi update-to-latest is DEV-only — release builds ship the pinned, verified pi."
                    .into(),
            );
        }

        // Hard backend guard. The UI asks for confirmation, but the guard lives here so
        // no caller (or retry path) can replace a package directory a live pi.exe is
        // executing from. Err before downloading anything.
        let live = running_pi_consoles();
        if !live.is_empty() {
            let ids = live
                .iter()
                .map(|p| p.to_string())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "pi console still running (PID {ids}). Close the pi window and retry — \
                 the update replaces {pkg}, which a running pi.exe cannot survive.",
                pkg = package_dir().display()
            ));
        }

        let latest = crate::github_releases::fetch_latest_release_tag("earendil-works/pi").await?;
        let ver = latest.trim_start_matches('v').to_string();
        emit_dbg(&format!("[Pi] Latest release: {latest} — updating…"));

        install_pi_version(&ver).await?;

        refresh_pi_subagents_bundle()?;
        sync_dev_pi_ext()?;

        // Prove the pair we are about to run: pinned bundle version + loadable host.
        let bundle = assert_bundle_matches_pin()?;
        assert_bundle_matches_host(&ver)?;

        emit_dbg(&format!(
            "[Pi] Updated to {ver} (latest) + pi-subagents {bundle} (pinned)"
        ));
        pi_code_status().await
    }
}

/// Rewrite the copied manifest so the **host** provides `typebox`.
///
/// pi 1.4.0 treats `typebox` as host-provided and rejects extensions that ship their own:
/// `Host-provided extension packages must be declared in peerDependencies with a "*" range,
/// not dependencies: typebox. Installed copies can bypass the extension loader and create
/// duplicate runtime modules.` The pinned 0.58.0 predates that rule, so the refresh
/// normalises it — move the dependency to a `"*"` peer (and stop copying it, which
/// [`SUBAGENTS_RUNTIME_DEPS`] no longer lists). Without this the bundle still loads, but pi
/// reports the issue on every start and two copies of the module can coexist.
fn patch_subagents_manifest_for_host(root: &Path) -> Result<(), String> {
    let p = root.join("package.json");
    let raw = std::fs::read_to_string(&p).map_err(|e| format!("read bundle package.json: {e}"))?;
    let mut v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse bundle package.json: {e}"))?;
    let obj = v
        .as_object_mut()
        .ok_or_else(|| "bundle package.json is not an object".to_string())?;
    let moved = obj
        .get_mut("dependencies")
        .and_then(|d| d.as_object_mut())
        .map(|deps| deps.remove("typebox").is_some())
        .unwrap_or(false);
    if !moved {
        return Ok(());
    }
    let peers = obj
        .entry("peerDependencies")
        .or_insert_with(|| serde_json::json!({}));
    if let Some(pm) = peers.as_object_mut() {
        pm.insert("typebox".to_string(), serde_json::json!("*"));
    }
    let body = serde_json::to_string_pretty(&v)
        .map_err(|e| format!("serialize bundle package.json: {e}"))?;
    std::fs::write(&p, body).map_err(|e| format!("write bundle package.json: {e}"))?;
    Ok(())
}

/// Refresh `src-tauri/pi-ext/pi-subagents` to [`PINNED_SUBAGENTS_VERSION`], installing
/// only that version's runtime closure (see [`SUBAGENTS_RUNTIME_DEPS`]) — the correct way
/// to (re)build the bundle. Installing with `--omit=dev` avoids the upstream
/// `file:./test/fixtures/pi-coding-agent-shim` devDep that otherwise creates a
/// dangling junction and breaks the dev-runtime mirror.
///
/// **Installs the pinned version, never `@latest`.** Latest (0.70+) crashes the host on
/// every workflow/parallel run — see [`PINNED_SUBAGENTS_VERSION`]. Only `pi-subagents`
/// itself is requested: npm then resolves that version's own dependency tree exactly,
/// which is what the copy loop expects. Asking for `typebox` separately would install a
/// *newer* top-level copy than the pinned release depends on.
#[cfg(windows)]
fn refresh_pi_subagents_bundle() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let bundle_src = dev_pi_ext_src().join("pi-subagents");
    if !cfg!(debug_assertions) {
        return Err("pi-subagents bundle refresh is DEV-only.".into());
    }
    let want = PINNED_SUBAGENTS_VERSION.trim();
    if want.is_empty() {
        return Err("pi-subagents pin is empty (src-tauri/pi-subagents-pinned-version.txt)".into());
    }

    // Temp project so npm resolves pi-subagents + runtime deps without touching
    // the repo's own package manager state.
    let tmp = std::env::temp_dir().join("blackwell-pi-subagents-update");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("mk temp project: {e}"))?;
    std::fs::write(tmp.join("package.json"), "{}\n")
        .map_err(|e| format!("write temp package.json: {e}"))?;

    let spec = format!("pi-subagents@{want}");
    let out = Command::new("npm.cmd")
        .args([
            "install",
            spec.as_str(),
            "--omit=dev",
            "--no-audit",
            "--no-fund",
        ])
        .current_dir(&tmp)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("npm spawn: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!("npm install pi-subagents failed: {err}"));
    }

    let installed = tmp.join("node_modules").join("pi-subagents");
    if !installed.join("package.json").is_file() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err("npm install produced no pi-subagents package.".into());
    }

    // Replace the DEV bundle source with the fresh package.
    if bundle_src.exists() {
        std::fs::remove_dir_all(&bundle_src).map_err(|e| format!("clear bundle: {e}"))?;
    }
    copy_dir_all(&installed, &bundle_src)?;
    // pi 1.4.0 wants typebox as a host-provided "*" peer, not a shipped dependency.
    patch_subagents_manifest_for_host(&bundle_src)?;

    // Ship ONLY the runtime closure in `SUBAGENTS_RUNTIME_DEPS`. Everything else in the
    // temp tree is a transitive dep of an OPTIONAL `@earendil-works/*` peer — pi bundles
    // the core itself, so those must never be copied (see
    // `strip_shadowed_pi_core_modules`).
    let bnm = bundle_src.join("node_modules");
    std::fs::create_dir_all(&bnm).map_err(|e| format!("bundle node_modules: {e}"))?;
    for dep in SUBAGENTS_RUNTIME_DEPS {
        let from = tmp.join("node_modules").join(dep);
        // A missing dep used to be skipped silently, which produced a bundle that could
        // not resolve its own imports — pi then loaded no extension and reported nothing.
        // Fail loudly instead, naming the fix.
        if !from.is_dir() {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(format!(
                "npm install produced no '{dep}': the refreshed bundle would fail to load \
                 (no subagent tool). If upstream changed its closure, update \
                 SUBAGENTS_RUNTIME_DEPS and the install args in refresh_pi_subagents_bundle."
            ));
        }
        copy_dir_all(&from, &bnm.join(dep))?;
    }

    // npm may still have left `@earendil-works/*` (incl. the dangling
    // pi-coding-agent-shim junction) inside the temp tree copy → scrub it.
    strip_shadowed_pi_core_modules(&bundle_src);

    // The copy above brought the whole transitive tree in with it. Rebuild
    // node_modules to the runtime-dep allowlist only.
    prune_bundle_node_modules(&bundle_src)?;
    prune_bundle_dead_files(&bundle_src);

    let _ = std::fs::remove_dir_all(&tmp);
    emit_dbg(&format!(
        "[Pi] Refreshed pi-subagents bundle → {}",
        bundle_src.display()
    ));
    Ok(())
}

/// Mirror the refreshed DEV pi-ext source to `target/debug/pi-ext` so the running
/// DEV app (which materializes pi-ext next to the exe) picks it up immediately.
#[cfg(windows)]
fn sync_dev_pi_ext() -> Result<(), String> {
    let src = dev_pi_ext_src();
    let dst = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("debug")
        .join("pi-ext");
    if dst.exists() {
        std::fs::remove_dir_all(&dst).map_err(|e| format!("clear debug pi-ext: {e}"))?;
    }
    copy_dir_all(&src, &dst)?;
    emit_dbg(&format!("[Pi] Re-synced DEV pi-ext → {}", dst.display()));
    Ok(())
}

// ── Launch ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiEngineRef {
    pub port: u16,
    /// OpenAI model id — must match engine launch alias.
    pub model: String,
    #[serde(default)]
    pub context_window: Option<u64>,
    /// Engine `--parallel` slot count (concurrent subagent capacity).
    #[serde(default)]
    pub parallel: u32,
    /// Seat launched with mmproj — advertise image input to pi for this model.
    #[serde(default)]
    pub vision: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiLaunchRequest {
    /// `solo` | `brain_workers`
    pub mode: String,
    pub primary: PiEngineRef,
    pub worker: Option<PiEngineRef>,
    pub project_dir: String,
    /// When true, spawn the pi console elevated via bundled gsudo (UAC).
    /// Needed for system-level shell ops inside the agent (services, hosts, etc.).
    #[serde(default)]
    pub elevated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiLaunchResult {
    pub launcher_path: String,
    pub models_path: String,
    pub project_dir: String,
    pub mode: String,
    pub home_path: String,
    /// True when the console was started with elevation (or app already elevated).
    pub elevated: bool,
}

fn openai_model_id(raw: &str) -> String {
    let s = raw.trim();
    if s.is_empty() {
        "local-model".into()
    } else {
        s.to_string()
    }
}

fn models_path() -> PathBuf {
    home_dir().join("models.json")
}

fn settings_path() -> PathBuf {
    home_dir().join("settings.json")
}

/// Bundled pi-subagents package source (shipped with the app as a tauri resource,
/// then materialized to `{app_root}/pi-ext/pi-subagents` on REL first run).
/// Contains the package + leaf deps so pi can load it as a local-path package
/// without npm/network. Not the same as the pi **binary** under
/// `external-tools/pi/pi/` (exe + docs).
fn bundled_subagents_dir() -> PathBuf {
    crate::config::app_root_dir()
        .join("pi-ext")
        .join("pi-subagents")
}

/// Version of the bundled pi-subagents package, read from its package.json.
/// Used to stamp the copied tree so we only re-sync when Blackwell ships a new
/// package (never wipe a user's existing install on a routine launch).
fn bundled_subagents_version() -> Option<String> {
    let pkg = bundled_subagents_dir().join("package.json");
    let raw = std::fs::read_to_string(&pkg).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("version")?.as_str().map(|s| s.to_string())
}

/// Parse a numeric `MAJOR.MINOR.PATCH` prefix out of a version or range bound.
fn numeric_version(raw: &str) -> Option<(u64, u64, u64)> {
    let trimmed = raw.trim().trim_start_matches('v');
    let mut parts = trimmed.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next()?.parse::<u64>().ok()?;
    // `1.2` and `1.2.x` both mean PATCH 0.
    let patch = parts
        .next()
        .and_then(|p| p.trim_end_matches(|c: char| !c.is_ascii_digit()).parse::<u64>().ok())
        .unwrap_or(0);
    Some((major, minor, patch))
}

/// Lower bound of a `>=X.Y.Z` peer range, or `None` for `*` / anything not a floor.
fn peer_floor(req: &str) -> Option<(u64, u64, u64)> {
    let r = req.trim();
    if r.is_empty() || r == "*" {
        return None;
    }
    let floor = r.strip_prefix(">=").map(str::trim).unwrap_or(r);
    numeric_version(floor)
}

/// Minimum `@earendil-works/pi-ai` the bundled extension declares, if any.
fn bundled_pi_ai_floor() -> Option<(u64, u64, u64)> {
    let pkg = bundled_subagents_dir().join("package.json");
    let raw = std::fs::read_to_string(&pkg).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let req = v.get("peerDependencies")?.get("@earendil-works/pi-ai")?.as_str()?;
    peer_floor(req)
}

/// Refuse a host/bundle pair the extension cannot load on.
///
/// The probe that found this: a REL build shipped pi-subagents 0.80.0 (peer
/// `@earendil-works/pi-ai >= 1.2.0`) next to an installed pi 0.84.3. The extension
/// threw `(0, _piAi.toToolDeclaration) is not a function` at load, the `subagent` tool
/// never appeared, and nothing in the app compared the two versions. Returns the bundle
/// version on success so callers can report what they validated.
///
/// Missing peer information is not a failure — the bundle may simply declare no floor.
pub fn assert_bundle_matches_host(host: &str) -> Result<Option<String>, String> {
    let bundle = bundled_subagents_version();
    let Some(floor) = bundled_pi_ai_floor() else {
        return Ok(bundle);
    };
    let Some(host_v) = numeric_version(host) else {
        return Err(format!("Cannot compare pi '{host}' against the bundled extension floor"));
    };
    if host_v < floor {
        return Err(format!(
            "Bundled pi-subagents {} needs @earendil-works/pi-ai >= {}.{}.{} but pi {host} is \
             installed — the extension would fail to load and the subagent tool would be \
             missing. Update pi to at least that version before shipping.",
            bundle.as_deref().unwrap_or("?"),
            floor.0,
            floor.1,
            floor.2
        ));
    }
    Ok(bundle)
}

/// Refuse a bundle whose version is not [`PINNED_SUBAGENTS_VERSION`].
///
/// Separate from the peer-floor check above: that one asks "can this extension load on
/// this host", this one asks "is this the extension we verified". They diverge on Windows
/// — 0.70+ satisfies the peer range, loads, and then kills the host on the first
/// workflow/parallel run — so the pin, not semver, decides.
pub fn assert_bundle_matches_pin() -> Result<String, String> {
    let want = PINNED_SUBAGENTS_VERSION.trim();
    match bundled_subagents_version() {
        Some(v) if v == want => Ok(v),
        Some(v) => Err(format!(
            "Bundled pi-subagents is {v} but the pinned version is {want}. Releases from \
             0.70 up crash the host on every workflow/parallel run (Bun: \"cannot resolve \
             DirInfo for non-absolute path\"), so this bundle must not ship. \
             Fix: Distribution > UPDATE HARNESS (installs the pin)."
        )),
        None => Err(format!(
            "Bundled pi-subagents is missing at {} (pinned version {want}). \
             Fix: Distribution > UPDATE HARNESS, or restore app_root/pi-ext/pi-subagents.",
            bundled_subagents_dir().display()
        )),
    }
}

/// The ONLY third-party modules the pinned pi-subagents needs at runtime, as **top-level
/// `node_modules` entry names** — scoped packages are listed by scope (`@js-temporal`),
/// because both the copy loop and [`prune_bundle_node_modules`] iterate that directory.
///
/// This list is a property of [`PINNED_SUBAGENTS_VERSION`], not of "latest". For the
/// pinned 0.58.0 the shippable closure is three of its declared dependencies — `acorn`,
/// `jiti`, `yaml`. Its fourth, `typebox`, is **host-provided** on pi 1.4.0 and must not be
/// bundled: pi accepts it only as a `"*"` peer, and a shipped copy trips
/// `Host-provided extension packages must be declared in peerDependencies … Installed
/// copies can bypass the extension loader and create duplicate runtime modules.` The
/// refresh rewrites the manifest accordingly (see [`patch_subagents_manifest_for_host`]).
///
/// Newer releases (0.70+) add `undici` and `@js-temporal/polyfill` (which pulls `jsbi`) —
/// and that is also the range that crashes the host on every parallel run, so those names
/// are deliberately absent.
///
/// **Bump this together with the pin**, by running `npm install
/// pi-subagents@<pin> --omit=dev` in a scratch project and comparing `npm ls --all`.
/// A name that is listed but not installed is now a hard error (see the refresh), and
/// `pi_subagents_pin_matches_shipped_bundle` fails if the shipped tree and pin disagree.
///
/// Everything else that npm drops into the tree is a transitive dependency of an
/// OPTIONAL `@earendil-works/*` peer. pi is a compiled bun binary with the provider SDKs
/// already inlined (`@anthropic-ai/sdk`, `openai`, `@google/genai`, `@aws-sdk/client-sts`
/// are all embedded strings inside `pi.exe`), so extension-side copies are unreachable
/// dead weight: ~136 MB of AWS/Google/Anthropic/OpenAI SDKs for a 4–5 MB app. Blackwell
/// ships lean; users add packages themselves with `pi install npm:…`, which lands in
/// `{home}/npm/` as its own module root.
const SUBAGENTS_RUNTIME_DEPS: [&str; 3] = ["acorn", "jiti", "yaml"];

/// Build artifacts that are dead weight at runtime inside the bundled deps.
///
/// `.d.mts` / `.d.ts` / `.d.cts` are TypeScript declarations, read only by `tsc`. pi
/// loads the extension through jiti, which strips types and resolves **values**
/// (`Type`, `Compile`) from the `.mjs` siblings — nothing ever opens a declaration.
/// `.map` files are debugger-only. `typebox` alone ships 690 declarations against 690
/// runtime modules, so this removes ~40% of the bundled file count for free.
const BUNDLE_DEAD_EXTS: [&str; 4] = ["d.mts", "d.ts", "d.cts", "map"];

/// Delete declaration/map files under `root/node_modules` and any empty dirs left behind.
///
/// Best-effort by design: a leftover `.d.mts` costs 1 KB and nothing else, so this must
/// never be able to fail a launch.
fn prune_bundle_dead_files(root: &Path) {
    let nm = root.join("node_modules");
    if !nm.is_dir() {
        return;
    }
    let mut removed = 0usize;
    let mut walk: Vec<std::path::PathBuf> = Vec::new();
    let mut stack = vec![nm.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                if ft.is_symlink() {
                    continue; // never follow links out of the bundle
                }
                stack.push(path);
            } else if path
                .file_name()
                .map(|n| {
                    let n = n.to_string_lossy();
                    BUNDLE_DEAD_EXTS.iter().any(|ext| n.ends_with(ext))
                })
                .unwrap_or(false)
                && std::fs::remove_file(&path).is_ok()
            {
                removed += 1;
            }
        }
    }
    // Second pass, bottom-up: drop dirs the deletions emptied (npm leaves bare
    // `typebox/build/type/script` style shells otherwise).
    for _ in 0..12 {
        let mut pruned_now = 0usize;
        collect_empty_dirs(&nm, &mut walk);
        for dir in walk.drain(..) {
            if std::fs::read_dir(&dir).map(|mut d| d.next().is_none()).unwrap_or(false)
                && std::fs::remove_dir(&dir).is_ok()
            {
                pruned_now += 1;
            }
        }
        if pruned_now == 0 {
            break;
        }
    }
    if removed > 0 {
        emit_dbg(&format!(
            "[Pi] Lean bundle: removed {} declaration/map files from {}",
            removed,
            nm.display()
        ));
    }
}

/// Collect every directory beneath `root` (deepest first is not required — the caller
/// loops until a pass removes nothing).
fn collect_empty_dirs(root: &Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && !path.is_symlink() {
            out.push(path.clone());
            collect_empty_dirs(&path, out);
        }
    }
}

/// Drop `node_modules` entries that would shadow pi's own bundled core packages.
///
/// pi bundles `@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`
/// and `typebox` for extensions (see pi `docs/packages.md`): extensions list them as
/// `peerDependencies: "*"` and must **not** bundle them. When npm materialises a
/// `@earendil-works/*` entry inside a package's own `node_modules`, Node resolves that
/// first and pi's bundled core never reaches the extension — the package loads against
/// the wrong core (or a dead test shim) and reports `Extension error (…index.ts)`.
///
/// Upstream `pi-subagents` declares a devDependency
/// `@earendil-works/pi-coding-agent: file:./test/fixtures/pi-coding-agent-shim`. Even
/// with `--omit=dev`, npm 12 on Windows can leave a junction to that fixture — which is
/// never published in the tarball — so the junction dangles. Removing these links is
/// what restores resolution to pi's bundled core.
fn strip_shadowed_pi_core_modules(root: &Path) {
    let nm = root.join("node_modules").join("@earendil-works");
    let entries = match std::fs::read_dir(&nm) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // Only touch symlinks/junctions and the shim target itself — real copies of
        // pi-ai / pi-tui / pi-agent-core left by a full install are harmless to keep.
        let is_link = std::fs::symlink_metadata(&path)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        let is_shim = entry
            .file_name()
            .to_string_lossy()
            .contains("pi-coding-agent-shim");
        let is_dangling = !path.exists();
        if is_link || is_shim || is_dangling {
            let rm = if path.is_dir() && !is_link {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
            match rm {
                Ok(()) => emit_dbg(&format!(
                    "[Pi] Removed shadowing pi-core module link → {}",
                    path.display()
                )),
                Err(e) => emit_dbg(&format!(
                    "[Pi] Could not remove shadowing pi-core module {} : {e}",
                    path.display()
                )),
            }
        }
    }
}

/// Rebuild `node_modules` so only [`SUBAGENTS_RUNTIME_DEPS`] survives.
///
/// Runs on the bundle **source** after a refresh (before it is mirrored to
/// `target/debug/pi-ext` and before NSIS stages it as a Tauri resource), so REL ships
/// lean. Also runs on the installed tree in the agent home, which repairs installs
/// that were materialized while the full tree was still being copied.
fn prune_bundle_node_modules(root: &Path) -> Result<(), String> {
    let nm = root.join("node_modules");
    if !nm.is_dir() {
        return Ok(());
    }
    let mut removed = 0usize;
    for entry in std::fs::read_dir(&nm).map_err(|e| format!("read node_modules: {e}"))? {
        let entry = entry.map_err(|e| format!("node_modules entry: {e}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if SUBAGENTS_RUNTIME_DEPS.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        let is_link = std::fs::symlink_metadata(&path)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        let rm = if path.is_dir() && !is_link {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        match rm {
            Ok(()) => removed += 1,
            Err(e) => emit_dbg(&format!(
                "[Pi] Could not prune non-runtime module {} : {e}",
                path.display()
            )),
        }
    }
    if removed > 0 {
        emit_dbg(&format!(
            "[Pi] Lean bundle: pruned {} non-runtime module dirs from {}",
            removed,
            nm.display()
        ));
    }
    Ok(())
}

/// Copy the bundled pi-subagents package into the isolated home so pi can resolve
/// `./pi-subagents` from settings.json.
///
/// **Persistent** (not wiped every launch): only re-syncs when the bundled package
/// version differs from the `.blackwell-version` stamp in the installed tree, so a
/// user's pi-subagents install (and any edits under it) survive routine launches.
/// The Blackwell-owned `settings.json` merge is what keeps routing fresh.
///
/// **Fatal when the factory tree is missing** — without it new users get a solo
/// chat with no multi-agent fan-out. Call after `ensure_pi_ext_materialized`.
fn sync_bundled_subagents(home: &Path) -> Result<(), String> {
    let src = bundled_subagents_dir();
    if !src.is_dir() || !src.join("package.json").is_file() {
        return Err(format!(
            "pi-subagents bundle missing at {}.\n\
             NSIS/App must ship the pi-ext resource; on first run it is copied next to the exe.\n\
             Reinstall Blackwell Ops or restore app_root/pi-ext/pi-subagents.",
            src.display()
        ));
    }
    let dst = home.join("pi-subagents");
    let stamp = dst.join(".blackwell-version");
    let bundled = bundled_subagents_version();

    // Self-heal the installed tree before any early return: a stale `@earendil-works/*`
    // link (upstream's unpublished `pi-coding-agent-shim` devDep junction) makes pi
    // resolve the extension against the wrong core and every session starts with
    // `Extension error (…pi-subagents\index.ts)` and no `subagent` tool.
    strip_shadowed_pi_core_modules(&dst);
    if let Err(e) = prune_bundle_node_modules(&dst) {
        emit_dbg(&format!("[Pi] subagents lean prune warning: {e}"));
    }
    prune_bundle_dead_files(&dst);

    // Already installed and matches the shipped version → leave it alone.
    if dst.is_dir() {
        let installed = std::fs::read_to_string(&stamp).ok().map(|s| s.trim().to_string());
        if bundled.is_some() && installed == bundled {
            emit_dbg(&format!(
                "[Pi] pi-subagents {} up to date → {}",
                bundled.unwrap_or_default(),
                dst.display()
            ));
            return Ok(());
        }
    }

    if dst.exists() {
        std::fs::remove_dir_all(&dst)
            .map_err(|e| format!("clear pi-subagents in home: {e}"))?;
    }
    copy_dir_all(&src, &dst).map_err(|e| format!("sync pi-subagents: {e}"))?;
    // Rebuild node_modules to the runtime-dep allowlist: `copy_dir_all` mirrors
    // whatever the bundle source holds, and a missing module (e.g. `acorn`, needed by
    // the workflow-script parser) would not be re-added by a version bump alone.
    strip_shadowed_pi_core_modules(&dst);
    if let Err(e) = prune_bundle_node_modules(&dst) {
        emit_dbg(&format!("[Pi] subagents lean prune warning: {e}"));
    }
    prune_bundle_dead_files(&dst);
    // Close the gap where the stamp already matches but the tree is short a runtime
    // dep (a mirror made before `acorn` entered the allowlist) → backfill it.
    let src_nm = bundled_subagents_dir().join("node_modules");
    if src_nm.is_dir() {
        let dst_nm = dst.join("node_modules");
        for dep in SUBAGENTS_RUNTIME_DEPS {
            let to = dst_nm.join(dep);
            if to.exists() {
                continue;
            }
            let from = src_nm.join(dep);
            if from.is_dir() {
                copy_dir_all(&from, &to)?;
                emit_dbg(&format!("[Pi] Lean bundle: backfilled missing dep {dep}"));
            }
        }
    }
    if let Some(v) = bundled {
        let _ = std::fs::write(&stamp, format!("{v}\n"));
    }
    emit_dbg(&format!("[Pi] Synced pi-subagents → {}", dst.display()));
    Ok(())
}

/// Per-batch fan-out cap inside the shipped pi-subagents extension
/// (`MAX_PARALLEL_CONCURRENCY` in `src/runs/shared/parallel-utils.js`).
///
/// Not ours to raise: a `parallel` group starts at most this many agents at once even when
/// `globalConcurrencyLimit` is higher, and no config key changes it. Four is also the
/// deliberate product choice — a wave wider than this makes long-prefill requests stall the
/// GPU. The generated PI.md/AGENTS.md state the cap, and `subagent_batch_cap_matches_bundle`
/// fails if upstream moves it, so those instructions cannot silently start lying.
const SUBAGENT_BATCH_CONCURRENCY: u32 = 4;

/// Write the pi-subagents extension config so subagent run artifacts land inside the
/// agent dir (session) instead of the project cwd, and so the **global** fan-out cap
/// matches the running engine's slot count.
///
/// Default is "project", which drops a `.pi-subagents/` folder into whatever repo the
/// user is editing — this keeps all external-tool output inside its own folder
/// (`{PI_CODING_AGENT_DIR}/extensions/subagent/` — pi default is
/// `~/.pi/agent/extensions/subagent/`; our `home` **is** the agent dir).
///
/// `slots` = engine `--parallel` (concurrent capacity). `globalConcurrencyLimit` is the
/// **only** concurrency key the extension reads (`config.globalConcurrencyLimit ??
/// DEFAULT_GLOBAL_CONCURRENCY_LIMIT`, default 20), so it is the only one written here.
///
/// A `parallel` batch is capped separately at [`SUBAGENT_BATCH_CONCURRENCY`] by a constant
/// inside the extension, and **no config key raises it**. This function used to also write
/// `"parallel": { "concurrency": n }`; neither 0.58 nor 0.80 ever read `config.parallel`, so
/// it was inert and is no longer written — see the batch-cap note in the generated docs.
fn write_subagents_config(home: &Path, slots: u32) -> Result<(), String> {
    // PI_CODING_AGENT_DIR replaces ~/.pi/agent — config is extensions/subagent under
    // that dir, NOT a nested agent/extensions (legacy wrong path).
    let cfg_dir = home.join("extensions").join("subagent");
    std::fs::create_dir_all(&cfg_dir).map_err(|e| format!("subagent cfg dir: {e}"))?;
    let cfg_path = cfg_dir.join("config.json");
    let n = slots.max(1);
    let cfg = serde_json::json!({
        "artifactDir": "session",
        "globalConcurrencyLimit": n
    });
    let body = serde_json::to_string_pretty(&cfg)
        .map_err(|e| format!("subagent cfg json: {e}"))?;
    std::fs::write(&cfg_path, body).map_err(|e| format!("write subagent cfg: {e}"))?;
    // Drop legacy nested path so we never re-read a stale wrong config.
    let legacy = home.join("agent").join("extensions").join("subagent").join("config.json");
    if legacy.is_file() {
        let _ = std::fs::remove_file(&legacy);
    }
    emit_dbg(&format!(
        "[Pi] Wrote subagents config → {} (concurrency={})",
        cfg_path.display(),
        n
    ));
    Ok(())
}

/// Write the Blackwell `worker` subagent definition for parallel fan-out. Lives in
/// `{home}/agents/worker.md` so it shadows the pi-subagents package's bundled `worker`
/// agent (user source outranks package).
///
/// - `twin` mode: worker runs on the separate WORKER engine — a leaner/faster model
///   with `slots` concurrent slots. BRAIN stays the big-context orchestrator.
/// - `solo` mode: there is no separate engine — the worker resolves to the SAME
///   engine as BRAIN, so all `slots` fan-out agents are EQUAL-CAPABILITY workers on the
///   shared slots (no "1× brain + N−1 virtual workers" competing for the same slots).
///
/// `target_model` is the `provider/model` the agent front-matter pins (e.g.
/// `local/DS4` for solo, `worker/DS4` for twin). `slots` drives the concurrency
/// description (no hardcoded ×4).
fn write_worker_agent(
    home: &Path,
    target_model: &str,
    worker_ctx: u64,
    slots: u32,
    twin: bool,
) -> Result<(), String> {
    let agents_dir = home.join("agents");
    std::fs::create_dir_all(&agents_dir).map_err(|e| format!("agents dir: {e}"))?;
    let n = slots.max(1);
    let (desc, body_para) = if twin {
        (
            format!(
                "{}x-concurrent worker agent running on the WORKER engine ({}). Executes narrow tasks delegated by the BRAIN orchestrator and reports results back via contact_supervisor.",
                n, target_model
            ),
            format!(
                "You are `worker`: a fast, execution-focused subagent running on a smaller/faster model than the orchestrator with {} concurrent slots. You are one of several identical workers dispatched by the BRAIN orchestrator to distribute work across slots. Do NOT attempt deep architectural reasoning or big-picture design — that is BRAIN's job. Focus on concrete execution, file inspection, narrow edits, running commands, and reporting concrete findings.",
                n
            ),
        )
    } else {
        (
            format!(
                "{}x-concurrent equal-capability worker agent on the BRAIN engine ({}). One of several identical full-capability agents sharing the engine's {} slots; reports results back via contact_supervisor.",
                n, target_model, n
            ),
            format!(
                "You are `worker`: an execution-focused subagent on the same engine as the orchestrator, which runs {} concurrent slots. You are one of {} identical full-capability agents sharing those slots to distribute work. You have the same model and tools as the orchestrator — tackle the assigned task with full capability, but stay lean and concise because your slot is shared with other concurrent work.",
                n, n
            ),
        )
    };
    let body = format!(
        "---\n\
         name: worker\n\
         description: {desc}\n\
         tools: read, grep, find, ls, bash, edit, write, contact_supervisor\n\
         model: {target_model}\n\
         systemPromptMode: replace\n\
         inheritProjectContext: true\n\
         inheritSkills: false\n\
         defaultContext: fresh\n\
         ---\n\
         \n\
         {body_para}\n\
         \n\
         You have a context budget ({}K tokens) shared with other concurrent work in your slot. Stay lean: read only what you need, avoid dumping large files, and keep your final report concise and factual.\n\
         \n\
         Use the provided tools directly. Understand the task, then implement carefully and minimally.\n\
         \n\
         Reporting back to the orchestrator:\n\
         - After completing your task, report back via `contact_supervisor` with `reason: \"progress_update\"` containing a concise structured summary: what you did, changed files, validation results, and any open questions.\n\
         - If you are blocked or need a decision, use `contact_supervisor` with `reason: \"need_decision\"` and stay alive for the reply.\n\
         - Do not invent decisions that belong to the orchestrator. If the task requires an architectural choice you were not given, pause and escalate.\n",
        worker_ctx / 1024,
    );
    let path = agents_dir.join("worker.md");
    std::fs::write(&path, body).map_err(|e| format!("write worker agent: {e}"))?;
    emit_dbg(&format!("[Pi] Wrote worker agent → {}", path.display()));
    Ok(())
}

/// Resolved routing facts shared between `build_models_and_settings`, the worker
/// agent writer, and the subagents config writer.
#[derive(Debug, Clone)]
struct PiRouting {
    /// Provider/model the `worker` subagent front-matter pins, e.g. `worker/DS4`
    /// (twin) or `local/DS4` (solo — same engine as BRAIN, equal capability).
    worker_target: String,
    /// Engine `--parallel` slot count (concurrent subagent capacity).
    slots: u32,
    /// Per-slot KV budget advertised to pi for the WORKER seat (`ctx_total / slots`).
    worker_ctx_per_slot: u64,
    /// True when BRAIN and WORKER are separate engines.
    is_twin: bool,
}

/// Per-slot KV budget for a fused engine: llama.cpp splits `-c` across `--parallel`
/// slots (`n_ctx_seq = n_ctx / n_parallel`). A session can never exceed this, so it —
/// not the engine-level total — is what pi must be told for a shared WORKER seat.
fn ctx_per_slot(ctx_total: u64, parallel: u32) -> u64 {
    let slots = parallel.max(1) as u64;
    ctx_total / slots
}

/// Build the isolated pi `models.json` (PI_CODING_AGENT_DIR/models.json) so pi
/// routes BRAIN/WORKER to the llama engine(s), plus a minimal settings.json and the
/// PI.md routing note. Also returns the resolved `PiRouting` for the worker agent +
/// subagents config writers.
///
/// pi reads `models.json` each time `/model` opens (no restart). Providers are
/// keyed by name; the model `id` MUST equal the engine launch alias (what the
/// llama server reports as the OpenAI model id).
///
/// Topology:
/// - **twin** (`brain_workers`/`dual`): `local` = BRAIN (big context, orchestrator),
///   `worker` = the separate WORKER engine with `slots` concurrent slots.
/// - **solo**: a single engine running `slots` parallel slots. We still emit a
///   `worker` provider so subagent fan-out resolves, but it points at the SAME
///   engine/model as `local` — all `slots` fan-out agents are equal-capability
///   workers sharing the engine's slots (NOT "1× brain + N−1 virtual workers").
fn build_models_and_settings(req: &PiLaunchRequest) -> Result<(String, String, String, PiRouting), String> {
    if req.primary.port == 0 {
        return Err("Primary engine port is 0.".into());
    }
    let mode = req.mode.trim().to_lowercase();
    let primary_model = openai_model_id(&req.primary.model);
    let primary_ctx = req.primary.context_window.unwrap_or(262_144);
    let primary_url = format!("http://localhost:{}/v1", req.primary.port);
    let primary_max = if primary_ctx >= 262_144 { 65536 } else { 32768 };
    let primary_slots = req.primary.parallel.max(1);
    let primary_vision = req.primary.vision;

    let is_twin = matches!(mode.as_str(), "brain_workers" | "brain+workers" | "dual");

    // ── Hoist worker refs (needed by both models.json and the PI.md routing) ──
    // Twin: a real second engine. Solo: the worker aliases the primary engine so
    // subagents fan out across the same slots (equal capability).
    let (w_model, w_ctx, w_url, w_max, w_slots, w_vision) = if is_twin {
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
        // Engine-level `-c` total. Output budget ladder keys off THIS, never the
        // per-slot split — 512K×4 and 1M×8 both land on 128K/slot and must not
        // silently drop maxTokens to 16384.
        let w_ctx_total = worker.context_window.unwrap_or(131_072 * 4);
        let w_slots = worker.parallel.max(1);
        let w_url = format!("http://localhost:{}/v1", worker.port);
        let w_max = if w_ctx_total >= 131_072 { 32768 } else { 16384 };
        (
            w_model,
            // Advertise the PER-SLOT budget: a fused session is capped at n_ctx/slots.
            ctx_per_slot(w_ctx_total, w_slots),
            w_url,
            w_max,
            w_slots,
            worker.vision,
        )
    } else {
        // Solo → worker = same engine, same model / vision, equal capability.
        (
            primary_model.clone(),
            primary_ctx,
            primary_url.clone(),
            primary_max,
            primary_slots,
            primary_vision,
        )
    };

    // ── models.json ───────────────────────────────────────────────────
    let mut models = serde_json::json!({ "providers": {} });

    // Thinking levels exposed in pi: off/low/high/max → server none/low/high/max.
    // Retest (Qwen3.6-27B + thinking FT): all server levels work including minimal/medium
    // via identity if a client sends them — not in this map. On that SKU, none is the only
    // true OFF; minimal is lightest on-tier; low→max is a tight band (diminishing returns).
    // Larger models may separate more.
    let thinking_map = serde_json::json!({
        "off": "none",
        "low": "low",
        "high": "high",
        "max": "max"
    });

    let brain_compat = serde_json::json!({
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": true,
        "supportsUsageInStreaming": false
    });

    // Per-seat vision: only advertise image when that engine launched with mmproj.
    let brain_input = if primary_vision {
        serde_json::json!(["text", "image"])
    } else {
        serde_json::json!(["text"])
    };
    let worker_input = if w_vision {
        serde_json::json!(["text", "image"])
    } else {
        serde_json::json!(["text"])
    };

    models["providers"]["local"] = serde_json::json!({
        "baseUrl": primary_url,
        "api": "openai-completions",
        "apiKey": "local",
        "compat": brain_compat,
        "models": [{
            "id": primary_model,
            "name": "brain",
            "input": brain_input,
            "contextWindow": primary_ctx,
            "maxTokens": primary_max,
            "reasoning": true,
            "thinkingLevelMap": thinking_map
        }]
    });

    // Worker provider always present so subagent fan-out resolves in BOTH modes.
    // Solo: same engine/model as brain → equal-capability workers on shared slots.
    // Twin: still advertise the same level ladder; effort is off by default on workers
    // (execution seat). supportsReasoningEffort stays true so solo can raise if needed.
    models["providers"]["worker"] = serde_json::json!({
        "baseUrl": w_url,
        "api": "openai-completions",
        "apiKey": "local",
        "compat": {
            "supportsDeveloperRole": false,
            "supportsReasoningEffort": true,
            "supportsUsageInStreaming": false
        },
        "models": [{
            "id": w_model,
            "name": "worker",
            "input": worker_input,
            "contextWindow": w_ctx,
            "maxTokens": w_max,
            "reasoning": true,
            "thinkingLevelMap": thinking_map
        }]
    });

    let models_str =
        serde_json::to_string_pretty(&models).map_err(|e| format!("models json: {e}"))?;

    // ── settings.json ─────────────────────────────────────────────────
    // Blackwell owns ONLY a small allowlist of routing keys. Everything else
    // (theme, compaction, transport, trust, user-installed packages/extensions,
    // `/settings` changes, pi's own bookkeeping like lastChangelogVersion) is
    // pi's domain — we never write it, so pi fills in its own defaults and a
    // future pi settings-structure change cannot break us. We merge our managed
    // keys on top of any existing settings.json so user/pi state persists.
    let home_note = home_dir().to_string_lossy().to_string();
    let routing_note = if is_twin {
        "BRAIN = provider local / model <brain-alias>. WORKER = provider worker / model <worker-alias>. Subagents point at worker."
    } else {
        "SOLO — single engine, provider local (worker aliases the same engine for equal-capability fan-out)."
    };

    // Read existing settings.json (pi/user-owned) if present; start fresh otherwise.
    let settings_path = settings_path();
    let mut settings: serde_json::Value = std::fs::read_to_string(&settings_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !settings.is_object() {
        settings = serde_json::json!({});
    }

    // Overlay ONLY the keys Blackwell genuinely owns (routing + telemetry + metadata).
    // Never delete a non-Blackwell key. `packages` is handled separately as a *union*
    // so `pi install npm:…` / user extensions survive relaunch (we only guarantee
    // `./pi-subagents` is present — we do not wipe the list).
    let managed = serde_json::json!({
        "defaultProvider": "local",
        "defaultModel": primary_model,
        "defaultThinkingLevel": "off",
        "enableInstallTelemetry": false,
        "_blackwell": {
            "managed": true,
            "piHome": home_note,
            "mode": mode,
            "routing": routing_note
        }
    });
    if let Some(obj) = settings.as_object_mut() {
        for (k, v) in managed.as_object().expect("managed is an object") {
            obj.insert(k.clone(), v.clone());
        }
        // Union-merge packages: keep every existing entry, ensure ./pi-subagents.
        let mut pkgs: Vec<String> = obj
            .get("packages")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        const SHIPPED: &str = "./pi-subagents";
        if !pkgs.iter().any(|p| p == SHIPPED || p.ends_with("/pi-subagents") || p.ends_with("\\pi-subagents"))
        {
            pkgs.insert(0, SHIPPED.to_string());
        }
        // De-dupe preserving order.
        let mut seen = std::collections::HashSet::new();
        pkgs.retain(|p| seen.insert(p.clone()));
        obj.insert(
            "packages".into(),
            serde_json::Value::Array(pkgs.into_iter().map(serde_json::Value::String).collect()),
        );
    }
    let settings_str =
        serde_json::to_string_pretty(&settings).map_err(|e| format!("settings json: {e}"))?;

    // ── routing note (PI.md in home) ──────────────────────────────────
    let routing = if is_twin {
        format!(
            "# Blackwell Ops — pi (managed)\n\n\
             ## Model routing\n\n\
             pi reads `models.json` from PI_CODING_AGENT_DIR. Two providers:\n\n\
             | Provider | Role | Model id (engine alias) | Endpoint |\n\
             |----------|------|--------------------------|----------|\n\
             | `local`  | BRAIN | `{primary_model}` | `{primary_url}` |\n\
             | `worker` | WORKER | `{w_model}` | `{w_url}` |\n\n\
             - BRAIN = provider `local`, model `{primary_model}`.\n\
             - WORKER = provider `worker`, model `{w_model}` — point subagents at this for parallel fan-out.\n\
             - The worker engine runs `{w_slots}` concurrent slots; fan-out concurrency is set to `{w_slots}`.\n\
             - You (the agent) cannot switch the main session model; the user uses `/model`.\n",
            primary_model = primary_model,
            primary_url = primary_url,
            w_model = w_model,
            w_url = w_url,
            w_slots = w_slots,
        )
    } else {
        format!(
            "# Blackwell Ops — pi (managed)\n\n\
             ## Model routing\n\n\
             pi reads `models.json` from PI_CODING_AGENT_DIR. Single engine, parallel fan-out:\n\n\
             | Provider | Role | Model id (engine alias) | Endpoint |\n\
             |----------|------|--------------------------|----------|\n\
             | `local`  | BRAIN | `{primary_model}` | `{primary_url}` |\n\
             | `worker` | WORKER (same engine) | `{w_model}` | `{w_url}` |\n\n\
             - BRAIN = provider `local`, model `{primary_model}`.\n\
             - WORKER = provider `worker`, model `{w_model}` — points at the SAME engine as BRAIN so subagents fan out as `{w_slots}` equal-capability agents across the engine's `{w_slots}` slots.\n\
             - You (the agent) cannot switch the main session model; the user uses `/model`.\n",
            primary_model = primary_model,
            primary_url = primary_url,
            w_model = w_model,
            w_url = w_url,
            w_slots = w_slots,
        )
    };

    let routing_facts = PiRouting {
        worker_target: format!("{}/{}", if is_twin { "worker" } else { "local" }, w_model),
        slots: w_slots,
        // Solo: worker aliases the primary engine, so split the primary's `-c`.
        worker_ctx_per_slot: if is_twin {
            w_ctx
        } else {
            ctx_per_slot(primary_ctx, primary_slots)
        },
        is_twin,
    };

    Ok((models_str, settings_str, routing, routing_facts))
}

const PI_MD_BEGIN: &str = "<!-- BLACKWELL-PI:BEGIN -->";
const PI_MD_END: &str = "<!-- BLACKWELL-PI:END -->";

/// Upsert the managed PI.md block (home + project cwd) so the agent knows the
/// isolated home + routing (project/home PI.md managed block).
fn upsert_pi_md(path: &Path, block: &str) -> Result<(), String> {
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    let next = if existing.contains(PI_MD_BEGIN) && existing.contains(PI_MD_END) {
        let before = existing.split(PI_MD_BEGIN).next().unwrap_or("").trim_end();
        let after = existing
            .split(PI_MD_END)
            .nth(1)
            .map(|s| s.trim_start())
            .unwrap_or("");
        format!("{before}\n\n{block}\n{after}")
    } else if existing.trim().is_empty() {
        format!("{block}\n")
    } else {
        format!("{existing}\n\n{block}\n")
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("PI.md parent: {e}"))?;
    }
    std::fs::write(path, next).map_err(|e| format!("write {}: {e}", path.display()))
}

fn pi_md_block(
    home: &Path,
    project: &Path,
    models: &Path,
    mode: &str,
    routing: &str,
    slots: u32,
    is_twin: bool,
) -> String {
    let n = slots.max(1);
    let topology = if is_twin {
        format!(
            "**TWIN** — BRAIN (provider `local`) orchestrates; WORKER (provider `worker`) runs \
             up to **{n}** concurrent subagents on a separate engine. Prefer the `worker` \
             subagent for implementation / explore / parallel lanes."
        )
    } else {
        format!(
            "**SOLO** — one engine. Provider `worker` aliases the **same** endpoint as `local`. \
             Fan-out uses **{n}** equal-capability workers sharing that engine’s slots \
             (not “1× brain + N−1 weaker virtual workers”)."
        )
    };
    format!(
        r#"{PI_MD_BEGIN}
## Blackwell Ops — pi (managed)

### STOP — environment truth (read before answering path questions)

| Concept | Truth for **this** session |
|---------|----------------------------|
| **Agent config dir** | **`PI_CODING_AGENT_DIR`** = `{home}` |
| **What that replaces** | Default `~/.pi/agent` (only used when the env var is **unset**) |
| **settings / models / sessions / packages** | Under `{home}` only |
| **pi-subagents package** | `{home}/pi-subagents` via `settings.packages` → `"./pi-subagents"` |
| **Project / workspace cwd** | `{project}` |
| **pi.exe install (binary + docs)** | app `external-tools/pi/pi/` — **not** the agent home |
| **OS / Git Bash `$HOME`** | User profile only — **never** “pi config home” |

**Forbidden conclusions (always wrong in Blackwell harness):**

- Claiming config is `~/.pi`, `~/.pi/agent`, `~/.config/pi`, or `%USERPROFILE%\.pi`
- Inventing `PI_HOME`, `PI_PROJECT_DIR`, `PI_ACTIVE_PROJECT_DIR` as the config root
- Saying pi-subagents is “not wired” because pi is not on PATH or there is no `~/.config/pi/extensions`
- Equating “user home” with agent home

**Required check when asked about config:**

```bash
printf 'PI_CODING_AGENT_DIR=%s\n' "${{PI_CODING_AGENT_DIR:-<UNSET>}}"
printf 'PI_MODEL=%s PI_PROVIDER=%s\n' "${{PI_MODEL:-?}}" "${{PI_PROVIDER:-?}}"
```

If `PI_CODING_AGENT_DIR` is set, report **that** path as config home. Do not “helpfully” expand `~/.pi`.

**How packages load here:** `settings.json` → `"packages": ["./pi-subagents", …]` relative to `PI_CODING_AGENT_DIR`. That **is** the normal pi package mechanism for this isolated home. No PATH, no global symlink required. If the `subagent` tool works, the package **is** active.

### Topology

Launch mode: **{mode}**

{topology}

Fan-out: global cap **{n}** (`extensions/subagent/config.json` → `globalConcurrencyLimit`, which equals the engine's `--parallel` slots). A single `parallel` batch still runs at most **{batch}** agents at a time — that limit is compiled into the extension and no config key raises it. Split larger jobs into waves of {batch}; do not expect {n} agents from one call.

### Parallel work (use workers)

- Parallelize independent reads / searches / edits across up to **{batch}** `worker` subagents per wave (global cap {n}).
- Non-overlapping write scopes; you own synthesis and final decisions.
- Stay sequential for tiny tasks, strict data dependencies, or pure Q&A.
- Twin: keep architecture / validation on BRAIN; dump grunt work to WORKER.
- Solo: same model on all slots — still fan out when the work splits cleanly.

### Model routing

{routing}

### models.json

`{models}`
{PI_MD_END}
"#,
        home = home.display(),
        project = project.display(),
        models = models.display(),
        mode = mode,
        routing = routing,
        topology = topology,
        n = n,
        batch = SUBAGENT_BATCH_CONCURRENCY,
    )
}

/// Global agent instructions (pi loads `AGENTS.md` from the agent dir =
/// `PI_CODING_AGENT_DIR`). Overwritten each launch so path truth cannot drift.
fn write_agents_md(home: &Path, project: &Path, slots: u32, is_twin: bool) -> Result<(), String> {
    let n = slots.max(1);
    let mode_line = if is_twin {
        format!(
            "TWIN: BRAIN=`local`, WORKER=`worker`, up to {n} workers in flight ({SUBAGENT_BATCH_CONCURRENCY} per wave) on the worker engine."
        )
    } else {
        format!(
            "SOLO: `local` and `worker` share one engine and follow its `--parallel` slots; up to {n} workers in flight, {SUBAGENT_BATCH_CONCURRENCY} per wave."
        )
    };
    let body = format!(
        r#"# Blackwell Ops — pi session (managed)

You are running under **Blackwell Ops Harness Connect**, not a stock global pi install.

## Config home (mandatory)

- **Only** trust env **`PI_CODING_AGENT_DIR`** = `{home}`
- That directory **is** your agent dir (settings, models, sessions, packages).
- It **replaces** the docs default `~/.pi/agent`.
- **`$HOME` / `C:\Users\...` is NOT your config directory.**
- Do **not** mention `PI_HOME`, `~/.config/pi`, or “not on PATH” as reasons packages are inactive.
- **pi-subagents** is loaded from `{home}/pi-subagents` via `settings.packages` (`./pi-subagents`). If you have a `subagent` tool, it is active.

## Workspace

- Project cwd: `{project}`

## Topology

{mode_line}

Use the `worker` subagent for independent multi-file work: up to {batch} per wave, {n} in flight. You remain the orchestrator.

When asked “where is pi home?”, answer with the value of `PI_CODING_AGENT_DIR` only.
"#,
        home = home.display(),
        project = project.display(),
        mode_line = mode_line,
        n = n,
        batch = SUBAGENT_BATCH_CONCURRENCY,
    );
    std::fs::write(home.join("AGENTS.md"), body).map_err(|e| format!("AGENTS.md: {e}"))?;
    Ok(())
}

fn write_pi_context_files(
    home: &Path,
    project: &Path,
    models: &Path,
    mode: &str,
    routing: &str,
    slots: u32,
    is_twin: bool,
) -> Result<(), String> {
    let block = pi_md_block(home, project, models, mode, routing, slots, is_twin);
    upsert_pi_md(&home.join("PI.md"), &block)?;
    upsert_pi_md(&project.join("PI.md"), &block)?;
    write_agents_md(home, project, slots, is_twin)?;
    Ok(())
}

/// Session bat hard-codes PI_CODING_AGENT_DIR — Start-Process env inheritance
/// is unreliable on PS 5.1 (same pattern as QWEN_HOME).
fn write_session_launch_bat(home: &Path, launcher: &Path, project: &Path) -> Result<PathBuf, String> {
    let bat = home.join("launch-session.cmd");
    let home_s = home.to_string_lossy().replace('"', "");
    let launch_s = launcher.to_string_lossy().replace('"', "");
    let proj_s = project.to_string_lossy().replace('"', "");
    // Point the pi-subagents extension at the real pi.exe so child subagent processes
    // can spawn. The extension falls back to a bare `pi` on PATH (which does not exist
    // in the Blackwell standalone layout) unless PI_SUBAGENT_PI_BINARY is set.
    let pi_bin_s = package_binary().to_string_lossy().replace('"', "");
    let body = format!(
        "@echo off\r\n\
         setlocal\r\n\
         REM Blackwell managed — forces isolated home (never %USERPROFILE%\\.pi)\r\n\
         set \"PI_CODING_AGENT_DIR={home_s}\"\r\n\
         set \"PI_SUBAGENT_PI_BINARY={pi_bin_s}\"\r\n\
         cd /d \"{proj_s}\"\r\n\
         call \"{launch_s}\"\r\n\
         endlocal\r\n"
    );
    std::fs::write(&bat, body).map_err(|e| format!("write launch-session.cmd: {e}"))?;
    Ok(bat)
}

/// Detached visible pi console (normal integrity). Session bat sets PI_CODING_AGENT_DIR.
#[cfg(windows)]
fn spawn_pi_console_user(launcher: &Path, home: &Path, project: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let session_bat = write_session_launch_bat(home, launcher, project)?;
    let q = |s: &str| s.replace('\'', "''");
    let bat_s = q(&session_bat.to_string_lossy());
    let proj_s = q(&project.to_string_lossy());
    let home_s = q(&home.to_string_lossy());

    // Visible console. Prefer Windows Terminal (modern terminal); fall back to
    // Start-Process cmd.exe (legacy conhost) if wt.exe is unavailable.
    if let Some(wt) = crate::sidecar_elevate::wt_exe() {
        // Pass the bat path BARE — never with baked-in quotes. WT re-serializes
        // argv for the spawned cmd and DOUBLES any embedded quote, producing
        // `cmd /c call ""C:\path with space\x.cmd""` → cmd reports
        // `'""C:\path' is not recognized` (spaced install dirs). Rust's own
        // argv quoting is the single layer WT's parser strips.
        let bat_arg = crate::sidecar_elevate::wt_path_arg(&session_bat);
        let mut c = std::process::Command::new(wt);
        c.arg("cmd")
            .args(["/c", "call", &bat_arg])
            .current_dir(project)
            .env("PI_CODING_AGENT_DIR", home)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        if c.spawn().is_ok() {
            return Ok(());
        }
    }

    // Fallback: Start-Process cmd.exe via hidden powershell.
    let ps = format!(
        "$env:PI_CODING_AGENT_DIR = '{home_s}'; \
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
        .env("PI_CODING_AGENT_DIR", home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Failed to spawn pi: {e}"))?;

    Ok(())
}

/// Elevated detached pi console via bundled gsudo (one UAC prompt unless already admin).
///
/// The usual UI path ("Elevated (gsudo)") runs while the **app is not admin**.
/// `gsudo --new cmd <session>` would open legacy conhost — that is the window the
/// user sees. Elevate a hidden `cmd` instead and `start` Windows Terminal from
/// that cmd (`gsudo wt <args>` drops argv via UWP activation).
#[cfg(windows)]
fn spawn_pi_console_elevated(
    app: &tauri::AppHandle,
    launcher: &Path,
    home: &Path,
    project: &Path,
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const CREATE_NEW_CONSOLE: u32 = 0x00000010;

    let session_bat = write_session_launch_bat(home, launcher, project)?;
    let cmd_exe = crate::sidecar_elevate::system_cmd_exe();
    let raw_tail = crate::sidecar_elevate::cmd_script_raw_tail(&session_bat);
    let app_elevated = crate::sidecar_elevate::is_process_elevated();
    let wt = crate::sidecar_elevate::wt_exe();
    emit_dbg(&format!(
        "[Pi] elevated console: app_elevated={app_elevated} wt={}",
        wt.as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "None".into())
    ));

    // Already elevated → new console, no UAC.
    if app_elevated {
        if let Some(wt) = wt.as_ref() {
            // Same bare-argv rule as spawn_pi_console_user: the cmd-shaped
            // `/d /s /c ""path""` raw tail is for cmd, NOT for WT — WT parses
            // it, collapses the doubled quotes, and re-quotes once, so cmd's
            // /s strip leaves the spaced path unquoted. Pass argv directly.
            let bat_arg = crate::sidecar_elevate::wt_path_arg(&session_bat);
            let mut c = Command::new(wt);
            c.arg("cmd")
                .args(["/c", "call", &bat_arg])
                .current_dir(project)
                .env("PI_CODING_AGENT_DIR", home)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW);
            if c.spawn().is_ok() {
                emit_dbg("[Pi] elevated console: branch=already-admin-wt");
                return Ok(());
            }
            emit_dbg("[Pi] elevated console: already-admin wt spawn failed, falling back");
        }
        let mut c = Command::new(&cmd_exe);
        c.raw_arg(&raw_tail)
            .current_dir(project)
            .env("PI_CODING_AGENT_DIR", home)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NEW_CONSOLE);
        c.spawn()
            .map_err(|e| format!("Failed to spawn elevated pi (already admin): {e}"))?;
        emit_dbg("[Pi] elevated console: branch=already-admin-conhost");
        return Ok(());
    }

    let gsudo = crate::sidecar_elevate::stage_gsudo(app)?;

    // Preferred: gsudo elevates cmd (argv-safe). Hidden cmd `start`s wt.exe with
    // the session bat. Do not pass wt.exe as gsudo's target. Do not use --new
    // here — that is a new conhost for the elevated process.
    if let Some(wt) = wt.as_ref() {
        let bridge = home.join("launch-session-wt.cmd");
        let body = crate::sidecar_elevate::wt_start_bridge_bat_body(wt, &session_bat);
        std::fs::write(&bridge, body)
            .map_err(|e| format!("write launch-session-wt.cmd: {e}"))?;
        let bridge_tail = crate::sidecar_elevate::cmd_script_raw_tail(&bridge);
        let mut c = Command::new(&gsudo);
        c.arg("-d")
            .arg(&cmd_exe)
            .raw_arg(&bridge_tail)
            .current_dir(project)
            .env("PI_CODING_AGENT_DIR", home)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        match c.status() {
            Ok(status) if status.success() => {
                emit_dbg("[Pi] elevated console: branch=gsudo-cmd-start-wt");
                return Ok(());
            }
            Ok(status) => {
                let code = status.code().unwrap_or(-1);
                if code == 1223 || code == 999 {
                    return Err(crate::sidecar_elevate::UAC_DENIED_MESSAGE.to_string());
                }
                emit_dbg(&format!(
                    "[Pi] elevated console: gsudo-wt failed exit {code}, falling back to --new"
                ));
            }
            Err(e) => {
                emit_dbg(&format!(
                    "[Pi] elevated console: gsudo-wt spawn error ({e}), falling back to --new"
                ));
            }
        }
    }

    // No WT, or WT bridge failed: legacy elevated conhost.
    let mut c = Command::new(&gsudo);
    c.arg("--new")
        .arg(&cmd_exe)
        .raw_arg(&raw_tail)
        .current_dir(project)
        .env("PI_CODING_AGENT_DIR", home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    let status = c
        .status()
        .map_err(|e| format!("gsudo elevated pi launch failed: {e}"))?;
    if !status.success() {
        let code = status.code().unwrap_or(-1);
        if code == 1223 || code == 999 {
            return Err(crate::sidecar_elevate::UAC_DENIED_MESSAGE.to_string());
        }
        return Err(format!(
            "gsudo elevated pi launch failed (exit {code}). Approve UAC or install gsudo in bin/."
        ));
    }
    emit_dbg("[Pi] elevated console: branch=gsudo-new-conhost");
    let _ = launcher;
    Ok(())
}

#[cfg(windows)]
fn spawn_pi_console(
    app: &tauri::AppHandle,
    launcher: &Path,
    home: &Path,
    project: &Path,
    elevated: bool,
) -> Result<bool, String> {
    if elevated {
        spawn_pi_console_elevated(app, launcher, home, project)?;
        Ok(true)
    } else {
        spawn_pi_console_user(launcher, home, project)?;
        Ok(false)
    }
}

#[tauri::command]
pub async fn pi_code_launch(
    app: tauri::AppHandle,
    request: PiLaunchRequest,
) -> Result<PiLaunchResult, String> {
    #[cfg(not(windows))]
    {
        let _ = (app, request);
        return Err("pi launch is only supported on Windows.".into());
    }

    #[cfg(windows)]
    {
        if !disclaimer_path().is_file() {
            return Err("Accept the pi disclaimer first.".into());
        }
        if !is_installed() {
            return Err("pi is not installed in external-tools. Install it first.".into());
        }
        // The shipped pi-ext bundle and the pi host must be the same generation; an app
        // update refreshes the bundle and leaves the installed binary behind, so align
        // them before spawning anything.
        ensure_pinned_pi_version().await?;

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

        // REL: ensure Tauri-bundled pi-ext is on disk next to the exe (first run).
        if let Err(e) = crate::config::ensure_pi_ext_materialized(&app) {
            emit_dbg(&format!("[Pi] pi-ext materialize: {e}"));
        }

        // Refresh outer shim every launch so older installs pick up isolation fixes
        // (always set PI_CODING_AGENT_DIR; never fall through to ~/.pi/agent).
        if let Err(e) = write_outer_shim(&tools_dir()) {
            emit_dbg(&format!("[Pi] outer shim refresh warning: {e}"));
        }

        let mode = request.mode.trim().to_lowercase();
        let (models_str, settings_str, routing, routing_facts) =
            build_models_and_settings(&request)?;
        let models_file = models_path();
        std::fs::write(&models_file, &models_str).map_err(|e| format!("write models: {e}"))?;
        let settings_file = settings_path();
        std::fs::write(&settings_file, &settings_str).map_err(|e| format!("write settings: {e}"))?;
        emit_dbg(&format!(
            "[Pi] Wrote models.json → {} ({} bytes); PI_CODING_AGENT_DIR={}",
            models_file.display(),
            models_str.len(),
            home.display()
        ));

        if let Err(e) = write_pi_context_files(
            &home,
            &project,
            &models_file,
            &mode,
            &routing,
            routing_facts.slots,
            routing_facts.is_twin,
        ) {
            emit_dbg(&format!("[Pi] PI.md / AGENTS.md write warning: {e}"));
        }

        // Blackwell-shipped pi-subagents (local-path package) — required for multi-agent.
        // The lean prune (delete + backfill across ~1900 files) is housekeeping, not a
        // launch precondition: a transient FS error must not stop the agent from
        // starting. Only a genuinely missing/unusable bundle is fatal, and
        // `sync_bundled_subagents` still returns Err for that case.
        if let Err(e) = sync_bundled_subagents(&home) {
            emit_dbg(&format!("[Pi] subagents sync warning: {e}"));
        }
        // Set the subagent fan-out concurrency to the engine's slot count (both modes).
        if let Err(e) = write_subagents_config(&home, routing_facts.slots) {
            emit_dbg(&format!("[Pi] subagents config warning: {e}"));
        }
        // Write the worker agent in BOTH modes. Twin: worker engine (leaner/faster).
        // Solo: worker aliases the same engine → equal-capability fan-out on shared slots.
        // Use the per-slot budget (already split by slot count) so the worker's own
        // idea of its context matches what models.json advertises to pi.
        if let Err(e) = write_worker_agent(
            &home,
            &routing_facts.worker_target,
            routing_facts.worker_ctx_per_slot,
            routing_facts.slots,
            routing_facts.is_twin,
        ) {
            emit_dbg(&format!("[Pi] worker agent warning: {e}"));
        }

        let _ = std::fs::write(
            last_project_path(),
            format!("{}\n", project.to_string_lossy()),
        );

        let launcher = launcher_path();
        let elevated = spawn_pi_console(&app, &launcher, &home, &project, request.elevated)?;

        emit_dbg(&format!(
            "[Pi] Launched ({mode}{}) project={} PI_CODING_AGENT_DIR={}",
            if elevated { ", elevated/gsudo" } else { "" },
            project.display(),
            home.display()
        ));

        Ok(PiLaunchResult {
            launcher_path: launcher.to_string_lossy().to_string(),
            models_path: models_file.to_string_lossy().to_string(),
            project_dir: project.to_string_lossy().to_string(),
            mode,
            home_path: home.to_string_lossy().to_string(),
            elevated,
        })
    }
}
