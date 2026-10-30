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
/// `OYM_DATA_DIR` overrides it for isolated support/invite testing.
pub fn default_data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("OYM_DATA_DIR") {
        return PathBuf::from(dir);
    }
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

#[cfg(windows)]
pub fn delete_token(identity: &Identity) -> Result<(), String> {
    match token_entry(&identity.device_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("delete device token: {error}")),
    }
}

#[cfg(not(windows))]
pub fn load_token(_identity: &Identity) -> Result<String, String> {
    Err("Credential Manager is only available on Windows".into())
}

#[cfg(not(windows))]
pub fn save_token(_device_id: &str, _token: &str) -> Result<(), String> {
    Err("Credential Manager is only available on Windows".into())
}

#[cfg(not(windows))]
pub fn delete_token(_identity: &Identity) -> Result<(), String> {
    Err("Credential Manager is only available on Windows".into())
}

/// The optional cloud API key lives under the same service with its own user
/// entry; it is never written to disk or returned to the UI.
pub const CLOUD_SERVICE: &str = "OYMLink";
pub const CLOUD_KEY_ENTRY: &str = "cloud-api-key";

#[cfg(windows)]
fn cloud_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(CLOUD_SERVICE, CLOUD_KEY_ENTRY)
        .map_err(|error| format!("cloud credential entry: {error}"))
}

#[cfg(windows)]
pub fn cloud_key_stored() -> bool {
    cloud_entry()
        .and_then(|entry| entry.get_password().map_err(|error| error.to_string()))
        .is_ok()
}

#[cfg(windows)]
pub fn read_cloud_key() -> Result<String, String> {
    cloud_entry()?
        .get_password()
        .map_err(|error| format!("read cloud key: {error}"))
}

#[cfg(windows)]
pub fn save_cloud_key(key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("cloud API key is empty".into());
    }
    cloud_entry()?
        .set_password(key)
        .map_err(|error| format!("store cloud key: {error}"))
}

#[cfg(windows)]
pub fn clear_cloud_key() -> Result<(), String> {
    match cloud_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("delete cloud key: {error}")),
    }
}

#[cfg(not(windows))]
pub fn cloud_key_stored() -> bool {
    false
}

#[cfg(not(windows))]
pub fn read_cloud_key() -> Result<String, String> {
    Err("Credential Manager is only available on Windows".into())
}

#[cfg(not(windows))]
pub fn save_cloud_key(_key: &str) -> Result<(), String> {
    Err("Credential Manager is only available on Windows".into())
}

#[cfg(not(windows))]
pub fn clear_cloud_key() -> Result<(), String> {
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
