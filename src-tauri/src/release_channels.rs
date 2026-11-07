//! Release channels and `channel.json` manifests — the frozen layout in
//! `docs/RELEASE-CHANNELS.md`.
//!
//! The channel table is committed at `src-tauri/release-channels.json` and embedded here so
//! the client and the packer read the same tags. Clients never parse asset filenames: the
//! channel manifest is the interface, assets are opaque blobs.

use std::sync::OnceLock;

use serde::Deserialize;

pub const CHANNELS_JSON: &str = include_str!("../release-channels.json");

/// Fixed manifest asset name inside every product channel (`docs/RELEASE-CHANNELS.md` §4).
pub const MANIFEST_ASSET: &str = "channel.json";

pub const TAG_APP: &str = "app";
pub const TAG_FULL: &str = "full";
pub const TAG_ENGINES: &str = "engines";

#[derive(Deserialize)]
struct ChannelsFile {
    channels: Vec<ChannelRow>,
}

/// One channel row from `src-tauri/release-channels.json`. The client only needs the names;
/// `retention` / `title` / `blurb` stay the packer's business.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelRow {
    pub tag: String,
    pub asset_class: Option<String>,
    pub product: String,
    pub kind: String,
    pub version_token: String,
    #[serde(default)]
    pub title: String,
}

fn channels() -> &'static [ChannelRow] {
    static ROWS: OnceLock<Vec<ChannelRow>> = OnceLock::new();
    ROWS.get_or_init(|| match serde_json::from_str::<ChannelsFile>(CHANNELS_JSON) {
        Ok(file) => file.channels,
        Err(e) => {
            // Embedded at build time: a parse failure is a programming error, but it must not
            // panic at startup. `embedded_channel_table_parses` fails the build instead.
            log::error!("[release-channels] embedded release-channels.json is invalid: {e}");
            Vec::new()
        }
    })
}

pub fn channel(tag: &str) -> Option<&'static ChannelRow> {
    channels().iter().find(|c| c.tag == tag)
}

pub fn has_tag(tag: &str) -> bool {
    channel(tag).is_some()
}

/// Canonical asset name for a product channel: `<CLASS>_<Product>-<Version>.<ext>`.
/// `None` for channels without class naming (toolchain) or unknown tags.
pub fn asset_name(tag: &str, version: &str) -> Option<String> {
    let row = channel(tag)?;
    let class = row.asset_class.as_deref()?;
    let ext = if row.kind == "installer" { "exe" } else { "7z" };
    let token = if row.version_token == "semver" {
        format!("v{version}")
    } else {
        version.to_string()
    };
    // Channels whose class already names the product (OYM_link) leave `product` empty.
    let product = if row.product.is_empty() {
        String::new()
    } else {
        format!("{}-", row.product)
    };
    Some(format!("{class}_{product}{token}.{ext}"))
}

/// `channel.json` of an app/full/link channel.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductChannelManifest {
    pub schema_version: u32,
    pub channel: String,
    pub latest: ChannelRelease,
    #[serde(default)]
    pub releases: Vec<ChannelRelease>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelRelease {
    pub version: String,
    pub asset: String,
    pub size_bytes: u64,
    pub sha256: String,
    #[serde(default)]
    pub notes: Option<String>,
}

impl ProductChannelManifest {
    /// Structural checks before any bytes are requested: a manifest with a bad digest is a
    /// publishing bug, and downloading from it would defeat the point of pinning.
    pub fn validate(&self, expected_tag: &str) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err(format!(
                "channel.json schemaVersion {} (expected 1)",
                self.schema_version
            ));
        }
        if self.channel != expected_tag {
            return Err(format!(
                "channel.json says channel '{}' but was fetched from '{}'",
                self.channel, expected_tag
            ));
        }
        validate_release(&self.latest, expected_tag)?;
        for release in &self.releases {
            validate_release(release, expected_tag)?;
        }
        Ok(())
    }
}

fn validate_release(release: &ChannelRelease, tag: &str) -> Result<(), String> {
    if release.version.trim().is_empty() {
        return Err(format!("channel '{tag}': release without a version"));
    }
    if release.asset.trim().is_empty() {
        return Err(format!(
            "channel '{tag}': release {} without an asset",
            release.version
        ));
    }
    if !is_sha256(&release.sha256) {
        return Err(format!(
            "channel '{tag}': release {} has an invalid sha256",
            release.version
        ));
    }
    Ok(())
}

/// `channel.json` of the `engines` channel.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineChannelManifest {
    pub schema_version: u32,
    pub channel: String,
    #[serde(default)]
    pub engines: Vec<EngineChannelEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineChannelEntry {
    pub provider: String,
    pub profile: String,
    /// Engine identity, `b<build>-<sha8>`.
    pub build: String,
    /// Human-readable llama version (`0.8.0-dev`); empty when upstream prints no semver.
    #[serde(default)]
    pub version: String,
    pub asset: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub cuda: String,
}

impl EngineChannelManifest {
    pub fn validate(&self, expected_tag: &str) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err(format!(
                "channel.json schemaVersion {} (expected 1)",
                self.schema_version
            ));
        }
        if self.channel != expected_tag {
            return Err(format!(
                "channel.json says channel '{}' but was fetched from '{}'",
                self.channel, expected_tag
            ));
        }
        for engine in &self.engines {
            if engine.build.trim().is_empty() || engine.asset.trim().is_empty() {
                return Err(format!(
                    "channel '{expected_tag}': engine {}/{} without build/asset",
                    engine.provider, engine.profile
                ));
            }
            if !is_sha256(&engine.sha256) {
                return Err(format!(
                    "channel '{expected_tag}': engine {}/{} has an invalid sha256",
                    engine.provider, engine.profile
                ));
            }
        }
        Ok(())
    }

    /// The current entry for a profile. `engines[]` keeps retained builds for rollback and
    /// prune input (newest first today), so never trust the order — pick the highest build.
    pub fn entry(&self, provider: &str, profile: &str) -> Option<&EngineChannelEntry> {
        self.engines
            .iter()
            .filter(|e| {
                e.provider.eq_ignore_ascii_case(provider)
                    && e.profile.eq_ignore_ascii_case(profile)
            })
            .max_by_key(|e| engine_build_number(&e.build))
    }
}

/// Numeric part of an engine build id (`b12190-f7591a6a` -> 12190).
fn engine_build_number(build: &str) -> u64 {
    build
        .strip_prefix('b')
        .and_then(|rest| rest.split('-').next())
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

pub fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .chars()
            .all(|c| c.is_ascii_hexdigit())
        && value == value.to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn product_manifest(channel: &str, version: &str, sha: &str) -> ProductChannelManifest {
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "channel": channel,
            "product": "Blackwell-Ops",
            "generatedAt": "2026-11-07T12:00:00Z",
            "latest": {
                "version": version,
                "asset": format!("APP_UPDATE_Blackwell-Ops-v{version}.7z"),
                "sizeBytes": 1234567,
                "sha256": sha,
                "notes": "notes"
            },
            "releases": []
        }))
        .unwrap()
    }

    #[test]
    fn embedded_channel_table_parses() {
        // The packer reads the same file; a typo here must fail the build, not the ship.
        for expected in ["full", "app", "engines", "toolchain", "link", "link-setup"] {
            assert!(has_tag(expected), "missing channel {expected}");
        }
        assert!(!has_tag("v1.1.13"));
    }

    #[test]
    fn asset_names_come_from_the_channel_table() {
        assert_eq!(
            asset_name("app", "1.1.13").as_deref(),
            Some("APP_UPDATE_Blackwell-Ops-v1.1.13.7z")
        );
        assert_eq!(
            asset_name("full", "1.1.13").as_deref(),
            Some("FULL_SETUP_Blackwell-Ops-v1.1.13.exe")
        );
        assert_eq!(
            asset_name("link", "b2047").as_deref(),
            Some("OYM_link_b2047.7z")
        );
        assert_eq!(
            asset_name("link-setup", "0.1.0").as_deref(),
            Some("OYM_link_SETUP_v0.1.0.exe")
        );
        // Toolchain names come from its manifest, not the channel table.
        assert!(asset_name("toolchain", "4.7").is_none());
        assert!(asset_name("nope", "1").is_none());
    }

    #[test]
    fn product_manifest_requires_matching_channel_and_digest() {
        let sha = "a".repeat(64);
        let manifest = product_manifest(TAG_APP, "1.1.13", &sha);
        assert!(manifest.validate(TAG_APP).is_ok());
        assert!(manifest.validate(TAG_FULL).is_err());

        let bad_sha = product_manifest(TAG_APP, "1.1.13", "not-a-digest");
        assert!(bad_sha.validate(TAG_APP).is_err());

        let mut short = product_manifest(TAG_APP, "1.1.13", &sha);
        short.latest.asset.clear();
        assert!(short.validate(TAG_APP).is_err());
    }

    #[test]
    fn engine_manifest_lookup_is_case_insensitive() {
        let sha = "b".repeat(64);
        let manifest: EngineChannelManifest = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "channel": "engines",
            "engines": [{
                "provider": "ggml-master",
                "profile": "edge",
                "build": "b12017-5047748f",
                "version": "0.8.0-dev",
                "asset": "ENGINE_ggml-master-edge-0.8.0-dev-b12017-5047748f.7z",
                "sizeBytes": 10,
                "sha256": sha,
                "cuda": "13.4",
                "recommended": true
            }]
        }))
        .unwrap();

        assert!(manifest.validate(TAG_ENGINES).is_ok());
        assert!(manifest.entry("GGML-MASTER", "EDGE").is_some());
        assert_eq!(
            manifest.entry("ggml-master", "edge").unwrap().version,
            "0.8.0-dev"
        );
        assert!(manifest.entry("ggml-master", "stable").is_none());
    }

    #[test]
    fn engine_manifest_entry_picks_newest_build_not_first() {
        let sha = "b".repeat(64);
        let entry = |build: &str, version: &str| {
            serde_json::json!({
                "provider": "ggml-master",
                "profile": "edge",
                "build": build,
                "version": version,
                "asset": format!("ENGINE_ggml-master-edge-{version}-{build}.7z"),
                "sizeBytes": 10,
                "sha256": sha,
                "cuda": "13.4"
            })
        };
        // Oldest first: retained builds are history, order must not decide the offer.
        let manifest: EngineChannelManifest = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "channel": "engines",
            "engines": [
                entry("b12017-5047748f", "0.8.0-dev"),
                entry("b12190-f7591a6a", "0.9.0-dev")
            ]
        }))
        .unwrap();

        let current = manifest.entry("ggml-master", "edge").unwrap();
        assert_eq!(current.build, "b12190-f7591a6a");
        assert_eq!(current.version, "0.9.0-dev");
    }
}
