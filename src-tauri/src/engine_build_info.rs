//! `engine_build_info` — identifying *which* engine binary is in front of us: version
//! probe, build date, and the recorded per-environment build info.
//!
//! Seam: moved out of `engine.rs`.
//! It is a separate lifecycle concern from launching: the launch path consumes a binary
//! it already trusts, while this module answers "what is this binary" for the Foundry
//! and the Config UI. `reactor_foundry` and `binary_update` both call into it without
//! going near the engine stack.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::engine::AppContext;

fn clean_version_probe_output(stdout: &[u8], stderr: &[u8]) -> String {
    use std::sync::LazyLock;
    static ANSI_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"\x1b\[[0-9;?]*[a-zA-Z]").expect("ansi regex")
    });
    let raw = format!(
        "{}{}",
        String::from_utf8_lossy(stdout),
        String::from_utf8_lossy(stderr)
    );
    ANSI_RE
        .replace_all(&raw, "")
        .chars()
        .filter(|c| *c <= '\x7F')
        .collect::<String>()
}

fn parse_llama_version_line(cleaned: &str) -> Option<String> {
    use std::sync::LazyLock;
    // Current ggml master: "version: 0.2.0-dev (build 1026, commit d7fa69b)"
    static NEW_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)version:\s*([^\r\n(]+?)\s*\([^)]*commit\s+([0-9a-f]{7,40})[^)]*\)",
        )
        .expect("new version regex")
    });
    // Legacy bXXXX style: "version: 519 (635cdd5)"
    static OLD_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)version:\s*(\d+)\s*\(([0-9a-f]{7,40})\)")
            .expect("old version regex")
    });
    // Fallback: any "version: X (…hex…)" — keep full paren body for extractors.
    static GENERIC_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)version:\s*([^\r\n(]+?)\s*\(([^)]*[0-9a-f]{7,40}[^)]*)\)")
            .expect("generic version regex")
    });

    // `llama.exe` build stub: prints a bare build id, e.g. "b9940-259f2e2a5".
    static BUILD_ID_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)^b\d+-[0-9a-f]{7,40}$").expect("build id regex")
    });
    for line in cleaned.lines() {
        let trimmed = line.trim();
        if BUILD_ID_RE.is_match(trimmed) {
            return Some(trimmed.to_string());
        }
    }

    // One identity shape everywhere: `b<build>-<commit>`. The server line carries the build
    // number inside the parens; keeping it makes bundled/installed versions comparable with
    // Foundry artifacts and published packs (which already use this shape).
    static BUILD_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)build\s+(\d+)").expect("build number regex")
    });

    if let Some(caps) = NEW_RE.captures(cleaned) {
        let build = BUILD_RE
            .captures(cleaned)
            .and_then(|b| b.get(1))
            .map(|m| m.as_str().to_string());
        return match build {
            Some(n) => Some(format!("{} (build {n})", caps[1].trim())),
            None => Some(format!("{} ({})", caps[1].trim(), short_hex(&caps[2]))),
        };
    }
    if let Some(caps) = OLD_RE.captures(cleaned) {
        return Some(format!("{} (build {})", &caps[1], &caps[1]));
    }
    GENERIC_RE
        .captures(cleaned)
        .map(|caps| format!("{} ({})", caps[1].trim(), caps[2].trim()))
}

fn short_hex(hash: &str) -> String {
    hash.trim().chars().take(8).collect()
}


/// Failures are cached by binary + mtime: a probe that cannot succeed (missing CUDA runtime,
/// broken exe) must not be retried on every provider refresh. That retry loop is what flooded
/// the log with "could not probe version … after 2 attempts".
const PROBE_FAILURE_TTL: Duration = Duration::from_secs(300);

fn probe_failures() -> &'static Mutex<HashMap<(PathBuf, u64), Instant>> {
    static CACHE: OnceLock<Mutex<HashMap<(PathBuf, u64), Instant>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn file_stamp(path: &Path) -> u64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn cached_failure(path: &Path, stamp: u64) -> bool {
    let Ok(map) = probe_failures().lock() else {
        return false;
    };
    match map.get(&(path.to_path_buf(), stamp)) {
        Some(at) => at.elapsed() < PROBE_FAILURE_TTL,
        None => false,
    }
}

fn remember_failure(path: &Path, stamp: u64) {
    if let Ok(mut map) = probe_failures().lock() {
        map.insert((path.to_path_buf(), stamp), Instant::now());
    }
}

fn forget_failure(path: &Path, stamp: u64) {
    if let Ok(mut map) = probe_failures().lock() {
        map.remove(&(path.to_path_buf(), stamp));
    }
}

/// A binary whose CUDA runtime is not installed cannot start — the loader fails before it
/// prints anything, so spawning it only burns two attempts and a warning per refresh. This is
/// the expected state for a profile whose runtime pack was never installed (e.g. STABLE on a
/// machine that only ran the EDGE onboarding).
fn probe_skip_reason(path: &Path) -> Option<String> {
    // Only a CUDA build can die on the loader. A CPU-only build (no ggml-cuda.dll beside it) has
    // no runtime to miss, and probing it is the only way to learn its version.
    let dir = path.parent()?;
    if !dir.join("ggml-cuda.dll").is_file() {
        return None;
    }
    let profile = crate::engine_utils::binary_profile_from_path(path)?;
    let cuda = crate::foundry_toolchain::cuda_version_for_binary_profile(&profile)?;
    if crate::foundry_toolchain::cuda_runtime_ready_for_version(&cuda) {
        return None;
    }
    Some(format!(
        "CUDA {cuda} runtime not installed for profile '{profile}' — version probe skipped"
    ))
}

/// `<engine dir>/build-info.txt` — one line `b<build>-<commit>`, written at build time.
fn read_build_info_sidecar(path: &Path) -> Option<String> {
    use std::sync::LazyLock;
    static ID_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)^b\d+-[0-9a-f]{7,40}$").expect("build info regex")
    });
    // Newer sidecars carry the human version: `0.7.0-dev (build 11887)`.
    static VERSION_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)^.+ \(build \d+\)$").expect("version info regex")
    });
    let sidecar = path.with_file_name("build-info.txt");
    let text = std::fs::read_to_string(sidecar).ok()?;
    let line = text.lines().next()?.trim();
    if ID_RE.is_match(line) || VERSION_RE.is_match(line) {
        Some(line.to_string())
    } else {
        log::debug!("[build-info] sidecar has an unexpected format: {line:?}");
        None
    }
}

/// A build stub beside the server is the cheapest source of identity: `llama.exe` (or a
/// `llama-version.exe`) prints the build id and does not load CUDA, so it works even when the
/// runtime pack is missing and never starts the server.
fn version_probe_exe(path: &Path) -> PathBuf {
    for name in ["llama.exe", "llama-version.exe"] {
        let sibling = path.with_file_name(name);
        if sibling.is_file() {
            return sibling;
        }
    }
    path.to_path_buf()
}

/// Blocking llama-server --version — same spawn shape as catalog `get_llama_catalog` (`--help`):
/// one `run_hidden_output`, cwd = exe dir, portable CUDA PATH, no pre-sleep / preflight.
/// Retry only if the first spawn fails or output has no parseable version line.
fn run_version_probe(executable: &Path, cuda_target: &Path) -> Result<String, Option<String>> {
    const MAX_ATTEMPTS: u32 = 2;
    const RETRY_MS: u64 = 100;

    let work_dir = cuda_target.parent().map(|p| p.to_path_buf());
    let mut last_snippet = String::new();

    for attempt in 1..=MAX_ATTEMPTS {
        let exe = executable.to_path_buf();
        let target = cuda_target.to_path_buf();
        let dir = work_dir.clone();
        let output = crate::engine_utils::run_hidden_output(move || {
            let mut cmd = std::process::Command::new(&exe);
            cmd.arg("--version")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if let Some(ref d) = dir {
                cmd.current_dir(d);
            }
            let _ = crate::engine_utils::apply_cuda_toolchain_for_binary(&mut cmd, &target);
            cmd
        });

        match output {
            Ok(o) => {
                let cleaned = clean_version_probe_output(&o.stdout, &o.stderr);
                if !cleaned.is_empty() {
                    last_snippet = cleaned.chars().take(200).collect();
                }
                if let Some(version) = parse_llama_version_line(&cleaned) {
                    return Ok(version);
                }
                log::debug!(
                    "[build-info] --version no parse for {} (attempt {}/{}, exit {:?})",
                    executable.display(),
                    attempt,
                    MAX_ATTEMPTS,
                    o.status.code()
                );
            }
            Err(e) => {
                log::debug!(
                    "[build-info] --version spawn failed for {} (attempt {}/{}): {}",
                    executable.display(),
                    attempt,
                    MAX_ATTEMPTS,
                    e
                );
            }
        }

        if attempt < MAX_ATTEMPTS {
            std::thread::sleep(std::time::Duration::from_millis(RETRY_MS));
        }
    }

    Err(if last_snippet.is_empty() { None } else { Some(last_snippet) })
}

/// Identify the engine binary: stub first (no CUDA), then the full server when its runtime is
/// installed, and cache failures so a refresh loop cannot retry or warn forever.
pub(crate) fn probe_binary_version_sync(path: &std::path::Path) -> Result<String, String> {
    // Written by Foundry from CMake's LLAMA_BUILD_NUMBER/LLAMA_BUILD_COMMIT. It is the cheapest
    // and most accurate identity: no spawn, no CUDA, and it is regenerated with the build.
    if let Some(version) = read_build_info_sidecar(path) {
        log::info!(
            "[build-info] {} -> {} (build-info.txt)",
            path.display(),
            version
        );
        return Ok(version);
    }

    let stub = version_probe_exe(path);
    if stub != path {
        match run_version_probe(&stub, path) {
            Ok(version) => {
                let name = stub
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "stub".to_string());
                log::info!("[build-info] {} -> {} ({name})", path.display(), version);
                return Ok(version);
            }
            Err(_) => log::debug!(
                "[build-info] {} did not report a version; falling back to the server",
                stub.display()
            ),
        }
    }

    if let Some(reason) = probe_skip_reason(path) {
        log::debug!("[build-info] {} ({})", reason, path.display());
        return Err(reason);
    }

    let stamp = file_stamp(path);
    if cached_failure(path, stamp) {
        return Err(format!(
            "Version probe failed for {} (cached; retried after {}s)",
            path.display(),
            PROBE_FAILURE_TTL.as_secs()
        ));
    }

    match run_version_probe(path, path) {
        Ok(version) => {
            forget_failure(path, stamp);
            log::info!(
                "[build-info] {} -> {} (--version)",
                path.display(),
                version
            );
            Ok(version)
        }
        Err(snippet) => {
            // One warning per binary+mtime, then silent for PROBE_FAILURE_TTL.
            match snippet {
                Some(out) => log::warn!(
                    "Could not parse version from binary '{}', output: {}",
                    path.display(),
                    out
                ),
                None => log::warn!("Could not probe version from binary '{}'", path.display()),
            }
            remember_failure(path, stamp);
            Err(format!("Version probe failed for {}", path.display()))
        }
    }
}

pub(crate) async fn probe_binary_version(path: &std::path::Path) -> Result<String, String> {
    let path_buf = path.to_path_buf();
    tokio::task::spawn_blocking(move || probe_binary_version_sync(&path_buf))
        .await
        .map_err(|e| format!("version probe join failed: {e}"))?
}

#[tauri::command]
pub async fn get_binary_build_info(binary_path: String) -> Result<crate::types::BuildInfo, String> {
    let path = crate::config::resolve_path(&binary_path);

    // Always try to get mtime first — this is the most reliable signal
    let build_date = tokio::fs::metadata(&path).await
        .map(|meta| meta.modified().ok())
        .map_err(|e| format!("Binary not found: {}", e))?
        .map(|mt| {
            use chrono::{DateTime, Local};
            let dt: DateTime<Local> = mt.into();
            dt.format("%Y-%m-%d %H:%M").to_string()
        })
        .unwrap_or_else(|| "unknown".to_string());

    let version = probe_binary_version(&path).await?;
    Ok(crate::types::BuildInfo {
        version,
        build_date,
        cuda_version: None,
        cuda_architectures: None,
    })
}

#[tauri::command]
pub async fn set_build_info_for_env(
    provider_id: String,
    env_label: String,
    build_info: crate::types::BuildInfo,
    app: tauri::State<'_, AppContext>,
) -> Result<(), String> {
    let mut cfg = app.config.lock().map_err(|e| e.to_string())?;
    if let Some(provider) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
        provider.build_info_per_env.insert(env_label, build_info);
    }
    crate::config::persist_user_providers_meta(&cfg.providers).map_err(|e| e.to_string())
}

// ── GGUF Metadata Scanner Commands ────────────────────────────────────────

/// Labels from mtime-only scans — not a successful `--version` probe.
pub(crate) fn is_placeholder_build_version(version: &str) -> bool {
    matches!(
        version.trim(),
        "" | "unknown"
            | "bundled"
            | "disk-scanned"
            | "foundry-artifact"
            | "downloaded"
            | "catalog"
    )
}

#[cfg(test)]
mod parse_tests {
    use super::*;

    #[test]
    fn parses_a_bare_build_id_from_the_stub() {
        assert_eq!(
            parse_llama_version_line("b9940-259f2e2a5\n").as_deref(),
            Some("b9940-259f2e2a5")
        );
    }

    #[test]
    fn parses_llama_app_version_output() {
        let out = "version: 0.7.0-dev (build 11870, commit 74bca3950)\nbuilt with MSVC 19.51.36243.0 for Windows AMD64\n";
        assert_eq!(
            parse_llama_version_line(out).as_deref(),
            Some("0.7.0-dev (build 11870)")
        );
    }

    #[test]
    fn still_parses_the_server_version_line() {
        let line = "version: 0.7.0-dev (build 11869, commit d327bf1f0)";
        assert_eq!(
            parse_llama_version_line(line).as_deref(),
            Some("0.7.0-dev (build 11869)")
        );
        assert_eq!(
            parse_llama_version_line("version: 519 (635cdd5)").as_deref(),
            Some("519 (build 519)")
        );
    }
}
