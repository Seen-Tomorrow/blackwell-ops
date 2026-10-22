//! `engine_build_info` — identifying *which* engine binary is in front of us: version
//! probe, build date, and the recorded per-environment build info.
//!
//! Seam: moved out of `engine.rs`.
//! It is a separate lifecycle concern from launching: the launch path consumes a binary
//! it already trusts, while this module answers "what is this binary" for the Foundry
//! and the Config UI. `reactor_foundry` and `binary_update` both call into it without
//! going near the engine stack.

use std::process::Stdio;

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

    if let Some(caps) = NEW_RE.captures(cleaned) {
        // Normalize to "0.2.0-dev (d7fa69b)" so commit extract stays simple.
        return Some(format!("{} ({})", caps[1].trim(), short_hex(&caps[2])));
    }
    if let Some(caps) = OLD_RE.captures(cleaned) {
        return Some(format!("{} ({})", &caps[1], short_hex(&caps[2])));
    }
    GENERIC_RE
        .captures(cleaned)
        .map(|caps| format!("{} ({})", caps[1].trim(), caps[2].trim()))
}

fn short_hex(hash: &str) -> String {
    hash.trim().chars().take(8).collect()
}


/// Blocking llama-server --version — same spawn shape as catalog `get_llama_catalog` (`--help`):
/// one `run_hidden_output`, cwd = exe dir, portable CUDA PATH, no pre-sleep / preflight.
/// Retry only if the first spawn fails or output has no parseable version line.
pub(crate) fn probe_binary_version_sync(path: &std::path::Path) -> Result<String, String> {
    const MAX_ATTEMPTS: u32 = 2;
    const RETRY_MS: u64 = 100;

    let work_dir = path.parent().map(|p| p.to_path_buf());
    let mut last_snippet = String::new();

    for attempt in 1..=MAX_ATTEMPTS {
        let path_for_probe = path.to_path_buf();
        let work_dir_for_probe = work_dir.clone();
        let output = crate::engine_utils::run_hidden_output(move || {
            let mut cmd = std::process::Command::new(&path_for_probe);
            // Match llama_catalog: --help path uses arg + cwd + CUDA env only.
            cmd.arg("--version")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if let Some(ref dir) = work_dir_for_probe {
                cmd.current_dir(dir);
            }
            let _ = crate::engine_utils::apply_cuda_toolchain_for_binary(&mut cmd, &path_for_probe);
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
                    path.display(),
                    attempt,
                    MAX_ATTEMPTS,
                    o.status.code()
                );
            }
            Err(e) => {
                log::debug!(
                    "[build-info] --version spawn failed for {} (attempt {}/{}): {}",
                    path.display(),
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

    if !last_snippet.is_empty() {
        log::warn!(
            "Could not parse version from binary '{}' after {} attempts, output: {}",
            path.display(),
            MAX_ATTEMPTS,
            last_snippet
        );
    } else {
        log::warn!(
            "Could not probe version from binary '{}' after {} attempts",
            path.display(),
            MAX_ATTEMPTS
        );
    }
    Err(format!("Version probe failed for {}", path.display()))
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
