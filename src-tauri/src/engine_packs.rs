//! Engine pack record — committed, embedded, and used as the build-time pin.
//!
//! `runtime-catalog/engines.json` is written by `scripts/pack-provider-runtime.ps1`. Two jobs:
//!
//! 1. **Build-time record** — names/digests of the packs this app was built with, asserted by
//!    tests and used as the offline/repair fallback when the `engines` channel is unreachable.
//! 2. **Installer bookkeeping** — `recommended` marks the seeded profile.
//!
//! It is **not** the authority for what can be installed: engines ship independently of app
//! builds, so the `engines` channel manifest (`docs/RELEASE-CHANNELS.md`) is what the client
//! offers and verifies. The embedded digest is only the stronger fallback path.

use std::sync::OnceLock;

use serde::Deserialize;

pub const EMBEDDED_ENGINE_PACKS: &str = include_str!("../runtime-catalog/engines.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnginePacksFile {
    #[allow(dead_code)]
    pub schema_version: u32,
    pub engine_packs: Vec<EnginePackDef>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnginePackDef {
    pub provider: String,
    pub profile: String,
    pub label: String,
    /// Release asset name, e.g. `ENGINE_ggml-master-edge-b11869-d327bf1f.7z`.
    pub asset: String,
    /// Lowercase hex sha256 of that asset. Required — an unverifiable engine is not installable.
    pub sha256: String,
    pub size_bytes: u64,
    pub cuda: String,
    /// Engine identity, `b<build>-<sha8>` (matches the channel manifest's `build`).
    pub build: String,
    /// Human-readable llama version (`0.8.0-dev`); empty when upstream prints no semver.
    #[serde(default)]
    pub llama_version: String,
    /// Read by the packaging script and asserted in tests; the installer seed is chosen by the
    /// release build, not looked up at runtime.
    #[serde(default)]
    #[allow(dead_code)]
    pub recommended: bool,
}

fn parsed() -> &'static Vec<EnginePackDef> {
    static PARSED: OnceLock<Vec<EnginePackDef>> = OnceLock::new();
    PARSED.get_or_init(|| {
        match serde_json::from_str::<EnginePacksFile>(EMBEDDED_ENGINE_PACKS) {
            Ok(file) => file.engine_packs,
            Err(e) => {
                // Never panic at startup: a malformed manifest disables pack *offers*, and the
                // seeded engine still launches. The unit test below is what fails the build.
                log::error!("[engine-packs] embedded engines.json is invalid: {e}");
                Vec::new()
            }
        }
    })
}

pub fn all() -> &'static [EnginePackDef] {
    parsed()
}

pub fn engine_pack(provider: &str, profile: &str) -> Option<&'static EnginePackDef> {
    all().iter().find(|p| {
        p.provider.eq_ignore_ascii_case(provider) && p.profile.eq_ignore_ascii_case(profile)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The installer seeds EDGE out of the box, so the manifest must name exactly one
    /// recommended pack — otherwise the seed and the offers disagree.
    #[test]
    fn manifest_has_one_recommended_seeded_pack() {
        let recommended: Vec<_> = all().iter().filter(|p| p.recommended).collect();
        assert_eq!(recommended.len(), 1, "exactly one recommended engine pack");
        assert_eq!(recommended[0].provider, "ggml-master");
        assert_eq!(recommended[0].profile, "edge");
    }

    /// An entry without a 64-char hex digest is uninstallable by design; catch it at build time.
    #[test]
    fn every_pack_is_digest_pinned_and_named_for_its_build() {
        assert!(!all().is_empty(), "engines.json must list at least the seeded pack");
        for p in all() {
            assert_eq!(p.sha256.len(), 64, "{}: sha256 must be 64 hex chars", p.asset);
            assert!(
                p.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                "{}: sha256 must be bare hex",
                p.asset
            );
            assert_eq!(p.sha256, p.sha256.to_lowercase(), "{}: sha256 lowercase", p.asset);
            assert!(
                p.asset.starts_with("ENGINE_") && p.asset.ends_with(".7z"),
                "{}: asset naming is ENGINE_{{provider}}-{{profile}}-{{version}}-{{build}}.7z",
                p.asset
            );
            assert!(
                p.asset.contains(&p.provider) && p.asset.contains(&p.profile),
                "{}: asset name must identify its provider/profile",
                p.asset
            );
            assert!(
                p.asset.contains(&p.build),
                "{}: asset name must carry the build id {} (channel manifest points at it)",
                p.asset,
                p.build
            );
            assert!(p.size_bytes > 1_000_000, "{}: implausible size", p.asset);
        }
    }

    #[test]
    fn lookup_is_case_insensitive_and_covers_both_profiles() {
        assert!(engine_pack("GGML-MASTER", "EDGE").is_some());
        assert!(engine_pack("ggml-master", "stable").is_some());
        assert!(engine_pack("ggml-master", "frontier").is_none());
    }
}
