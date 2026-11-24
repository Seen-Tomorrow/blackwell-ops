//! OS credential store for API tokens (Windows Credential Manager, macOS Keychain, etc.).
//! Never persist secrets in app_config.json or frontend localStorage.

use keyring::Entry;
use serde::{Deserialize, Serialize};

pub const SERVICE: &str = "blackwell-ops";

#[derive(Clone, Copy)]
pub struct SecretDefinition {
    pub key: &'static str,
    pub label: &'static str,
    pub description: &'static str,
}

pub const SECRET_DEFINITIONS: &[SecretDefinition] = &[
    SecretDefinition {
        key: "hf_token",
        label: "Hugging Face",
        description: "hf_… token — gated models, downloads, and higher Hub rate limits",
    },
    SecretDefinition {
        key: "github_pat",
        label: "GitHub",
        description: "ghp_… or fine-grained PAT — private repos and higher API limits",
    },
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStatus {
    pub key: String,
    pub label: String,
    pub description: String,
    pub configured: bool,
    pub preview: Option<String>,
}

fn credential_entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| format!("Keyring unavailable: {e}"))
}

fn validate_key(key: &str) -> Result<(), String> {
    if SECRET_DEFINITIONS.iter().any(|d| d.key == key) {
        Ok(())
    } else {
        Err(format!("Unknown secret key: {key}"))
    }
}

pub fn mask_secret(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.chars().count() <= 8 {
        return "••••••••".to_string();
    }
    let prefix: String = trimmed.chars().take(4).collect();
    let suffix: String = trimmed
        .chars()
        .rev()
        .take(3)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{prefix}…{suffix}")
}

/// Read a stored secret (backend only — never expose via a generic frontend getter).
pub fn get_secret(key: &str) -> Result<Option<String>, String> {
    validate_key(key)?;
    match credential_entry(key)?.get_password() {
        Ok(v) if v.trim().is_empty() => Ok(None),
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to read {key}: {e}")),
    }
}

pub fn set_secret(key: &str, value: &str) -> Result<(), String> {
    validate_key(key)?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Token cannot be empty".to_string());
    }
    credential_entry(key)?
        .set_password(trimmed)
        .map_err(|e| format!("Failed to store {key}: {e}"))
}

pub fn delete_secret(key: &str) -> Result<(), String> {
    validate_key(key)?;
    match credential_entry(key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to delete {key}: {e}")),
    }
}

pub fn list_secret_status() -> Result<Vec<SecretStatus>, String> {
    let mut out = Vec::with_capacity(SECRET_DEFINITIONS.len());
    for def in SECRET_DEFINITIONS {
        let stored = get_secret(def.key)?;
        let (configured, preview) = match stored {
            Some(v) => (true, Some(mask_secret(&v))),
            None => (false, None),
        };
        out.push(SecretStatus {
            key: def.key.to_string(),
            label: def.label.to_string(),
            description: def.description.to_string(),
            configured,
            preview,
        });
    }
    Ok(out)
}

// ── Tauri commands ────────────────────────────────────────────────────

#[tauri::command]
pub fn list_app_secrets() -> Result<Vec<SecretStatus>, String> {
    list_secret_status()
}

#[tauri::command]
pub fn set_app_secret(key: String, value: String) -> Result<SecretStatus, String> {
    set_secret(&key, &value)?;
    list_secret_status()?
        .into_iter()
        .find(|s| s.key == key)
        .ok_or_else(|| format!("Secret slot missing after save: {key}"))
}

#[tauri::command]
pub fn delete_app_secret(key: String) -> Result<(), String> {
    delete_secret(&key)
}

#[cfg(test)]
mod tests {
    use super::mask_secret;

    #[test]
    fn mask_secret_handles_multibyte_utf8() {
        let masked = mask_secret("hf_αβγδεζηθικ");
        assert!(masked.starts_with("hf_α"));
        assert!(masked.ends_with("ηθικ") || masked.ends_with("θικ"));
    }
}