//! Device identity and credential storage.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Credential Manager service name. The device token and the cloud API key are
/// separate user entries under this service.
pub const SERVICE: &str = "OYMLink";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Identity {
    pub device_id: String,
    pub server: String,
    pub name: String,
}

/// `%LOCALAPPDATA%\OYM\Link` on Windows; a relative fallback for tests/dev.
pub fn default_data_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|path| path.join("OYM").join("Link"))
        .unwrap_or_else(|| PathBuf::from(".oym-link"))
}

pub fn identity_path(data_dir: &Path) -> PathBuf {
    data_dir.join("identity.json")
}

pub fn load_identity(data_dir: &Path) -> Option<Identity> {
    let raw = std::fs::read_to_string(identity_path(data_dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn save_identity(data_dir: &Path, identity: &Identity) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|error| format!("create data dir: {error}"))?;
    let raw = serde_json::to_string_pretty(identity).map_err(|error| error.to_string())?;
    std::fs::write(identity_path(data_dir), raw).map_err(|error| format!("write identity: {error}"))
}

#[cfg(windows)]
fn token_entry(device_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, device_id).map_err(|error| format!("credential entry: {error}"))
}

#[cfg(windows)]
pub fn load_token(identity: &Identity) -> Result<String, String> {
    token_entry(&identity.device_id)?
        .get_password()
        .map_err(|error| format!("read device token: {error}"))
}

#[cfg(windows)]
pub fn save_token(device_id: &str, token: &str) -> Result<(), String> {
    token_entry(device_id)?
        .set_password(token)
        .map_err(|error| format!("store device token: {error}"))
}

#[cfg(not(windows))]
pub fn load_token(_identity: &Identity) -> Result<String, String> {
    Err("Credential Manager is only available on Windows".into())
}

#[cfg(not(windows))]
pub fn save_token(_device_id: &str, _token: &str) -> Result<(), String> {
    Err("Credential Manager is only available on Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_round_trips_in_a_data_dir() {
        let dir = std::env::temp_dir().join(format!("oym-identity-{}", std::process::id()));
        let identity = Identity {
            device_id: "dev_test".into(),
            server: "wss://example.test/link".into(),
            name: "TESTBOX".into(),
        };
        save_identity(&dir, &identity).expect("save identity");
        let loaded = load_identity(&dir).expect("load identity");
        assert_eq!(loaded.device_id, identity.device_id);
        assert_eq!(loaded.server, identity.server);
        assert_eq!(loaded.name, identity.name);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
