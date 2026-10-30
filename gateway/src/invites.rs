//! One-time support invite tokens.
//!
//! An invite is created locally by the owner (CLI now, main-app UI later) and
//! stored as a SHA-256 hash in `{data_dir}/invites.json`. The plaintext token is
//! printed once and goes into the helper package. Redemption is single-use and
//! only touches `/pair`; there is no remote endpoint that can mint invites.

use crate::devices::{hash_matches, hash_token, new_token, unix_now};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DEFAULT_TTL_HOURS: u64 = 72;
pub const MAX_TTL_HOURS: u64 = 24 * 30;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteRecord {
    pub id: String,
    pub token_hash: String,
    #[serde(default)]
    pub owner: Option<String>,
    pub created_at: u64,
    pub expires_at: u64,
    #[serde(default)]
    pub used_at: Option<u64>,
    #[serde(default)]
    pub revoked: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteFile {
    #[serde(default)]
    pub invites: Vec<InviteRecord>,
}

pub fn path(data_dir: &Path) -> PathBuf {
    data_dir.join("invites.json")
}

pub fn load(data_dir: &Path) -> InviteFile {
    std::fs::read_to_string(path(data_dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save(data_dir: &Path, file: &InviteFile) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|error| format!("create data dir: {error}"))?;
    let raw = serde_json::to_string_pretty(file).map_err(|error| error.to_string())?;
    std::fs::write(path(data_dir), raw).map_err(|error| format!("write invites: {error}"))
}

pub fn create(
    data_dir: &Path,
    owner: Option<String>,
    ttl_hours: u64,
) -> Result<(String, InviteRecord), String> {
    if ttl_hours == 0 || ttl_hours > MAX_TTL_HOURS {
        return Err(format!("ttl must be 1..={MAX_TTL_HOURS} hours"));
    }
    let token = format!("oym_inv_{}", new_token());
    let now = unix_now();
    let record = InviteRecord {
        id: format!("inv_{}", &new_token()[..16]),
        token_hash: hash_token(&token),
        owner: owner.map(|value| value.trim().to_string()).filter(|v| !v.is_empty()),
        created_at: now,
        expires_at: now + ttl_hours * 3600,
        used_at: None,
        revoked: false,
    };
    let mut file = load(data_dir);
    file.invites.push(record.clone());
    save(data_dir, &file)?;
    Ok((token, record))
}

/// Validate and consume an invite. The caller creates the device only after
/// this succeeds, so a bad token cannot create a device record.
pub fn redeem(data_dir: &Path, token: &str) -> Result<InviteRecord, String> {
    let token = token.trim();
    if !token.starts_with("oym_inv_") {
        return Err("invalid invite token".into());
    }
    let now = unix_now();
    let candidate = hash_token(token);
    let mut file = load(data_dir);
    let Some(record) = file
        .invites
        .iter_mut()
        .find(|record| hash_matches(&record.token_hash, &candidate))
    else {
        return Err("unknown invite token".into());
    };
    if record.revoked {
        return Err("invite was revoked".into());
    }
    if record.used_at.is_some() {
        return Err("invite was already used".into());
    }
    if record.expires_at <= now {
        return Err("invite expired".into());
    }
    record.used_at = Some(now);
    let record = record.clone();
    save(data_dir, &file)?;
    Ok(record)
}

pub fn list(data_dir: &Path) -> Vec<InviteRecord> {
    load(data_dir).invites
}

pub fn revoke(data_dir: &Path, id: &str) -> Result<bool, String> {
    let mut file = load(data_dir);
    let Some(record) = file.invites.iter_mut().find(|record| record.id == id) else {
        return Ok(false);
    };
    record.revoked = true;
    save(data_dir, &file)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("oym-invites-{name}-{}", std::process::id()))
    }

    #[test]
    fn invite_is_single_use() {
        let dir = temp_dir("single");
        let (token, record) = create(&dir, Some("Alex".into()), 1).expect("create");
        assert!(token.starts_with("oym_inv_"));
        assert_eq!(record.owner.as_deref(), Some("Alex"));
        let redeemed = redeem(&dir, &token).expect("redeem");
        assert_eq!(redeemed.id, record.id);
        assert!(redeem(&dir, &token).is_err(), "second redemption must fail");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn revoked_invite_is_rejected() {
        let dir = temp_dir("revoked");
        let (token, record) = create(&dir, None, 1).expect("create");
        assert!(revoke(&dir, &record.id).expect("revoke"));
        let error = redeem(&dir, &token).expect_err("revoked must fail");
        assert!(error.contains("revoked"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_invite_is_rejected() {
        let dir = temp_dir("unknown");
        assert!(redeem(&dir, "oym_inv_not-a-real-token").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
