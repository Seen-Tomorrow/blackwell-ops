//! Shared plumbing for the external coding-agent launcher (pi).
//!
//! The agent is intentionally **isolated** from any user-installed copy on the
//! system — it never resolves from `PATH`, `%LOCALAPPDATA%`, or a user `~/.pi`.
//! That isolation lives in the agent's *path computation* (a bundled
//! `external-tools/<agent>` under the app root + a private
//! `config/external-tools/<agent>-home`). The helpers here only take dirs/paths as
//! parameters, so an agent can never accidentally fall back to a user-installed binary.
//!
//! AtomCode and Qwen Code harnesses were removed (archived products); this module
//! stays because `pi_code.rs` and `download_manager.rs` depend on it.

use sha2::Digest;
use std::path::Path;

/// Read a stamp/file, trim whitespace; `None` when missing or empty.
pub fn read_trimmed(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Version-stamp path inside an agent's tools dir (`<tools>/version.txt`).
pub fn version_stamp_path(tools_dir: &Path) -> std::path::PathBuf {
    tools_dir.join("version.txt")
}

/// Disclaimer marker inside an agent's private home dir (`.disclaimer_accepted`).
pub fn disclaimer_path(home_dir: &Path) -> std::path::PathBuf {
    home_dir.join(".disclaimer_accepted")
}

/// Last-selected project marker inside an agent's private home dir (`last_project.txt`).
pub fn last_project_path(home_dir: &Path) -> std::path::PathBuf {
    home_dir.join("last_project.txt")
}

fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Write the standard `.disclaimer_accepted` marker (same format for both agents).
pub fn write_disclaimer(home_dir: &Path, pinned: &str) -> Result<(), String> {
    std::fs::create_dir_all(home_dir).map_err(|e| format!("home: {e}"))?;
    std::fs::write(
        disclaimer_path(home_dir),
        format!("accepted_at_unix={}\npinned={}\n", unix_now_secs(), pinned),
    )
    .map_err(|e| format!("disclaimer: {e}"))
}

/// Emit a debug line to the Blackwell Output Console (shared by agent installs/launches).
pub fn emit_dbg(line: &str) {
    crate::output_console::emit_blackwell_output_console_debug_line(line);
}

/// Download a URL to bytes. `reqwest` default redirect policy (limited 10) — both
/// agent release URLs (GitHub / atomgit) redirect to a storage host.
pub async fn download_bytes(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("download request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download HTTP {} for {url}", resp.status()));
    }
    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("download body: {e}"))
}

/// SHA-256 hex digest (used for standalone-pack integrity).
pub fn sha256_hex(data: &[u8]) -> String {
    let mut h = sha2::Sha256::new();
    h.update(data);
    format!("{:x}", h.finalize())
}

/// Write downloaded bytes to `dest`, creating parent dirs.
pub fn write_binary(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create parent: {e}"))?;
    }
    std::fs::write(dest, bytes).map_err(|e| format!("write download: {e}"))
}
