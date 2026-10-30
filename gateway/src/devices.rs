//! Device identity and persistence.
//!
//! The registry is intentionally a small JSON file. There is no user account
//! system in the trial: a one-time pairing code creates a device token; the
//! server stores only the SHA-256 of that token.

use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;
use subtle::ConstantTimeEq;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    pub id: String,
    /// Lowercase SHA-256 hex of the bearer token. Never serialized to the UI.
    pub token_hash: String,
    /// System-reported computer name. The client sends this on every Hello.
    pub name: String,
    /// Operator-assigned display name; survives reconnects and Hello updates.
    #[serde(default)]
    pub custom_name: Option<String>,
    #[serde(default)]
    pub os: Option<String>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub integrity: Option<String>,
    #[serde(default)]
    pub client_version: Option<String>,
    #[serde(default)]
    pub pi_version: Option<String>,
    pub paired_at: u64,
    pub last_seen: u64,
    #[serde(default)]
    pub revoked: bool,
}

/// UI-facing projection. `online` and `session_state` come from the live
/// connection/session maps, not from disk.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub id: String,
    pub name: String,
    pub custom_name: Option<String>,
    pub online: bool,
    pub os: Option<String>,
    pub user: Option<String>,
    pub integrity: Option<String>,
    pub client_version: Option<String>,
    pub pi_version: Option<String>,
    pub paired_at: u64,
    pub last_seen: u64,
    pub revoked: bool,
    pub session_state: String,
    pub session_profile: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct DeviceFile {
    #[serde(default)]
    devices: Vec<DeviceRecord>,
}

pub fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn new_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

pub fn new_device_id() -> String {
    let mut bytes = [0u8; 8];
    OsRng.fill_bytes(&mut bytes);
    format!("dev_{}", hex::encode(bytes))
}

pub fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    hex::encode(digest)
}

/// Constant-time comparison of two lowercase hex hashes.
pub fn hash_matches(stored: &str, candidate_hash: &str) -> bool {
    if stored.len() != candidate_hash.len() {
        return false;
    }
    stored.as_bytes().ct_eq(candidate_hash.as_bytes()).into()
}

pub fn load(path: &Path) -> Vec<DeviceRecord> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<DeviceFile>(&raw)
        .map(|f| f.devices)
        .unwrap_or_default()
}

pub fn save(path: &Path, devices: &[DeviceRecord]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let file = DeviceFile {
        devices: devices.to_vec(),
    };
    let raw = serde_json::to_string_pretty(&file).map_err(|e| format!("serialize devices: {e}"))?;
    std::fs::write(path, raw).map_err(|e| format!("write {}: {e}", path.display()))
}
