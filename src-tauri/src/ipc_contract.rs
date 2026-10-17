//! Rust <-> TS IPC wire contract — the authoritative key list, asked of serde.
//!
//! `wire_keys::<T>()` returns the exact JSON object keys serde emits for `T`.
//! It needs no instance and parses no source text: every `#[derive(Deserialize)]`
//! calls `deserialize_struct(name, FIELDS, ..)` before anything else, and `FIELDS`
//! is the post-`rename` wire-name list. So `rename`, `rename_all` and multi-line
//! `#[serde(..)]` blocks are honoured exactly as the encoder sees them.
//!
//! That matters: three separate hand-rolled text scanners were written against
//! this repo during the audit that produced this file, and all three reported
//! fields as "drifted" that were not — one on `#[serde(skip_serializing_if)]`
//! reading as `skip`, one on nested inline TS object literals, one on a
//! multi-line `#[serde(...)]` block. Only the compiler gets to answer.
//!
//! Test-only: declared `#[cfg(test)]` in `main.rs`, so none of this ships.
//!
//! ## Why registered types derive `Deserialize`
//!
//! The probe reads serde's *field list*, which only the `Deserialize` derive
//! exposes as a constant. The `Serialize` side would need a real value, and its
//! `skip_serializing_if` predicates make the emitted key set data-dependent — a
//! `Default` instance would silently omit every empty-Vec / `None` field and the
//! guard would then report live contract fields as drift. So IPC payload types
//! that the frontend mirrors carry `Deserialize` even when nothing deserializes
//! them: it keeps the check exact and value-independent, and the derive is
//! additive.

use serde::de::{Deserializer, Error as DeError, Visitor};
use std::collections::BTreeMap;
use std::fmt;

/// Sentinel carrying serde's own field list back out of the probe.
#[derive(Debug)]
enum Probe {
    Found(&'static [&'static str]),
    NotAStruct(&'static str),
}

impl fmt::Display for Probe {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Probe::Found(k) => write!(f, "{} wire keys", k.len()),
            Probe::NotAStruct(n) => write!(f, "`{n}` is not a plain struct"),
        }
    }
}

impl std::error::Error for Probe {}

impl DeError for Probe {
    fn custom<T: fmt::Display>(_msg: T) -> Self {
        Probe::NotAStruct("custom")
    }
}

struct KeyProbe;

impl<'de> Deserializer<'de> for KeyProbe {
    type Error = Probe;

    fn deserialize_any<V: Visitor<'de>>(self, _v: V) -> Result<V::Value, Probe> {
        Err(Probe::NotAStruct("any"))
    }

    fn deserialize_struct<V: Visitor<'de>>(
        self,
        _name: &'static str,
        fields: &'static [&'static str],
        _v: V,
    ) -> Result<V::Value, Probe> {
        Err(Probe::Found(fields))
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
        bytes byte_buf option unit unit_struct newtype_struct seq tuple
        tuple_struct map enum identifier ignored_any
    }
}

/// Exact JSON keys serde emits for `T`, in declaration order.
///
/// Bound is `Deserialize<'static>`, not `DeserializeOwned`: the probe hands the
/// type a single `'static` deserializer, and a type whose nested enums carry a
/// `'static` bound (here `FusionUpdate`) satisfies that while failing the
/// stronger `for<'de>` requirement.
pub fn wire_keys<T: serde::Deserialize<'static>>() -> Vec<String> {
    match T::deserialize(KeyProbe) {
        Err(Probe::Found(fields)) => fields.iter().map(|k| (*k).to_string()).collect(),
        Err(Probe::NotAStruct(what)) => {
            panic!("ipc_contract: `{what}` is not a plain struct — register a struct type")
        }
        Ok(_) => panic!("ipc_contract: key probe unexpectedly succeeded"),
    }
}

/// Keys serde **serializes** but does not **deserialize** (`#[serde(skip_deserializing)]`).
///
/// The probe reads the `Deserialize` field list, so these keys are invisible to it
/// even though they are genuinely on the wire. Listing one here is a claim that the
/// frontend legitimately reads it; `serialize_only_keys_are_real` below fails if an
/// entry is no longer needed, so this cannot quietly rot into a place to hide drift.
///
/// Keep this list tiny. Anything here is *asserted*, not *verified*.
const SERIALIZE_ONLY_KEYS: &[(&str, &[&str])] = &[
    // Backend-owned: recomputed on load (`config::discovery`) and forced false on
    // save (`provider_mgmt::save_provider`), so it is deliberately not accepted
    // back from the frontend — but ConfigPage reads it to show the banner.
    ("ProviderConfig", &["needsTemplateAttention"]),
];

/// Declares the IPC surface: every type whose shape the frontend mirrors.
///
/// Names are given explicitly (rather than derived from the path) so a TS
/// interface that deliberately mirrors a differently-named Rust type —
/// `IntelChannel` over `IntelChannelMeta` — can still be checked. A name that
/// matches no TS interface fails the guard in `src/lib/ipcContract.test.ts`,
/// so a typo here cannot silently reduce coverage.
///
/// Adding a type is the deliberate act that puts it under the guard.
macro_rules! ipc_registry {
    ($( $name:literal => $t:ty ),* $(,)?) => {
        /// `RustTypeName -> [wire keys]`, exactly as serde reports them.
        pub fn probed_key_map() -> BTreeMap<String, Vec<String>> {
            let mut map = BTreeMap::new();
            $(
                map.insert($name.to_string(), wire_keys::<$t>());
            )*
            map
        }

        /// As above, plus `SERIALIZE_ONLY_KEYS`. This is the published contract.
        pub fn wire_key_map() -> BTreeMap<String, Vec<String>> {
            let mut map = probed_key_map();
            for (ty, extra) in SERIALIZE_ONLY_KEYS {
                map.entry((*ty).to_string())
                    .or_default()
                    .extend(extra.iter().map(|k| (*k).to_string()));
            }
            map
        }
    };
}

ipc_registry! {
    // ── engine / config ───────────────────────────────────────────────
    "ProviderConfig" => crate::types::ProviderConfig,
    "ProviderDefaultParam" => crate::templates::ProviderDefaultParam,
    "ProviderTemplate" => crate::templates::ProviderTemplate,
    "SpawnProfile" => crate::templates::SpawnProfile,
    "UserEditedTemplateParam" => crate::types::UserEditedTemplateParam,
    "ExportFactoryTemplateResult" => crate::config::export::ExportFactoryTemplateResult,
    "EnvBinaryInventory" => crate::types::EnvBinaryInventory,
    "BinaryEntry" => crate::types::BinaryEntry,
    "BuildInfo" => crate::types::BuildInfo,

    // ── model catalog / files ─────────────────────────────────────────
    "ModelEntry" => crate::types::ModelEntry,
    "ModelMetadata" => crate::types::ModelMetadata,
    "HfMetadata" => crate::types::HfMetadata,
    "GgufShape" => crate::gguf_shape::GgufShape,
    "GgufFile" => crate::types::GgufFile,
    "GgufShard" => crate::types::GgufShard,
    "CatalogScanReport" => crate::types::CatalogScanReport,
    "CatalogUpdateEntry" => crate::types::CatalogUpdateEntry,
    "ModelPathEntry" => crate::types::ModelPathEntry,
    "ModelPathScan" => crate::types::ModelPathScan,
    "ModelLibraryValidation" => crate::types::ModelLibraryValidation,
    "PathDiskUsage" => crate::types::PathDiskUsage,
    "DiskCheckResult" => crate::types::DiskCheckResult,

    // ── downloads / HF ────────────────────────────────────────────────
    "DownloadTask" => crate::types::DownloadTask,
    "DownloadHistoryEntry" => crate::download_manager::DownloadHistoryEntry,
    "DownloadTargetCheck" => crate::types::DownloadTargetCheck,
    "HfModel" => crate::types::HfModel,
    "HfModelInfo" => crate::types::HfModelInfo,
    "HfSearchResponse" => crate::types::HfSearchResponse,
    "HfFileUpdateCheck" => crate::types::HfFileUpdateCheck,
    "HfRepoUpdateStatus" => crate::types::HfRepoUpdateStatus,

    // ── engine stack / fusion / fit ───────────────────────────────────
    "StackEntry" => crate::types::StackEntry,
    "FusionUpdate" => crate::fusion::emit::FusionUpdate,
    "SlotCtxInfo" => crate::fusion::emit::SlotCtxInfo,
    "FitDataPoint" => crate::fit_scanner::FitDataPoint,
    "FitScanProgress" => crate::fit_scanner::FitScanProgress,
    "FitScanComplete" => crate::fit_scanner::FitScanComplete,
    "FitScanFull" => crate::fit_scanner::FitScanFull,

    // ── telemetry / metering / logs ───────────────────────────────────
    "GpuInfo" => crate::telemetry::GpuInfo,
    "CpuInfo" => crate::telemetry::CpuInfo,
    "SystemInfo" => crate::telemetry::SystemInfo,
    "IpcMeterSnapshot" => crate::ipc_meter::IpcMeterSnapshot,
    "LogEntry" => crate::log_hub::LogEntry,
    "LogBatch" => crate::log_hub::LogBatch,
    "SystemEvent" => crate::log_hub::SystemEvent,

    // ── intel feed ────────────────────────────────────────────────────
    // TS keeps the shorter name for this one.
    "IntelChannel" => crate::intel::IntelChannelMeta,
    "IntelItem" => crate::intel::IntelItem,
    "IntelFeed" => crate::intel::IntelFeed,

    // ── updates / plugins / distribution ──────────────────────────────
    "AppUpdateInfo" => crate::binary_update::AppUpdateInfo,
    "BinaryUpdateInfo" => crate::binary_update::BinaryUpdateInfo,
    "UpdateOfferings" => crate::github_releases::UpdateOfferings,
    "UpdateChannelOffering" => crate::github_releases::UpdateChannelOffering,
    "PluginCatalogEntry" => crate::plugin_catalog::PluginCatalogEntry,
    "PluginCatalogResponse" => crate::plugin_catalog::PluginCatalogResponse,
    "PluginProfileOffering" => crate::plugin_catalog::PluginProfileOffering,

    // ── foundry / gpu control / secrets ───────────────────────────────
    "FoundrySourcePreview" => crate::reactor_foundry::FoundrySourcePreview,
    "FoundryWorkCacheStatus" => crate::reactor_foundry::FoundryWorkCacheStatus,
    "GpuControlDeviceInfo" => crate::gpu_control::GpuControlDeviceInfo,
    "GpuControlStepResult" => crate::gpu_control::GpuControlStepResult,
    "GpuControlApplyResult" => crate::gpu_control::GpuControlApplyResult,
    "SecretStatus" => crate::secrets::SecretStatus,
}

/// Committed key list, read by `src/lib/ipcContract.test.ts`.
pub const KEYS_JSON_REL: &str = "../src/lib/generated/ipc-wire-keys.json";

pub fn render() -> String {
    let map = wire_key_map();
    let mut out = String::from("{\n");
    let last = map.len().saturating_sub(1);
    for (i, (name, keys)) in map.iter().enumerate() {
        out.push_str(&format!("  {}: [", serde_json::to_string(name).unwrap()));
        for (j, k) in keys.iter().enumerate() {
            if j > 0 {
                out.push_str(", ");
            }
            out.push_str(&serde_json::to_string(k).unwrap());
        }
        out.push(']');
        out.push_str(if i == last { "\n" } else { ",\n" });
    }
    out.push_str("}\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rewrites the committed key list. Never runs as part of `cargo test`:
    /// `#[ignore]` keeps the normal suite non-mutating.
    ///
    ///     cargo test --manifest-path src-tauri/Cargo.toml -- --ignored regenerate_ipc_wire_keys
    #[test]
    #[ignore = "writes the committed wire-key list; run explicitly after changing an IPC type"]
    fn regenerate_ipc_wire_keys() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(KEYS_JSON_REL);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).expect("create generated dir");
        }
        std::fs::write(&path, render()).expect("write key list");
        eprintln!("wrote {}", path.display());
    }

    /// The gate. Fails when a Rust IPC type's wire keys no longer match the
    /// committed list the frontend is checked against.
    #[test]
    fn ipc_wire_keys_are_fresh() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(KEYS_JSON_REL);
        let committed = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "{} is missing ({e}).\nRegenerate it:\n  cargo test --manifest-path src-tauri/Cargo.toml -- --ignored regenerate_ipc_wire_keys",
                path.display()
            )
        });
        let expected = render();
        // The checkout's `core.autocrlf` decides the file's EOL on disk — the Windows
        // CI runner produces CRLF. EOL is a property of the working copy, not of the
        // wire contract, so compare content rather than raw bytes.
        let committed_normalized = committed.replace("\r\n", "\n");
        if committed_normalized != expected {
            let want: serde_json::Value = serde_json::from_str(&expected).unwrap();
            let have: serde_json::Value = serde_json::from_str(&committed_normalized).unwrap();
            let mut detail = String::new();
            if let (Some(w), Some(h)) = (want.as_object(), have.as_object()) {
                for (ty, keys) in w {
                    let wk: Vec<&str> = keys
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(|v| v.as_str())
                        .collect();
                    let hk: Vec<&str> = h
                        .get(ty)
                        .and_then(|v| v.as_array())
                        .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                        .unwrap_or_default();
                    let added: Vec<&&str> = wk.iter().filter(|k| !hk.contains(k)).collect();
                    let removed: Vec<&&str> = hk.iter().filter(|k| !wk.contains(k)).collect();
                    if !added.is_empty() || !removed.is_empty() {
                        detail.push_str(&format!(
                            "\n  {ty}: +{added:?} -{removed:?}"
                        ));
                    }
                }
                // A type present only in the committed file is invisible to the loop above.
                for ty in h.keys() {
                    if !w.contains_key(ty) {
                        detail.push_str(&format!("\n  {ty}: present only in the committed file"));
                    }
                }
            }
            let cl: Vec<&str> = committed_normalized.lines().collect();
            let el: Vec<&str> = expected.lines().collect();
            let mut at = String::new();
            for i in 0..cl.len().max(el.len()) {
                let a = cl.get(i).copied().unwrap_or("<no such line>");
                let b = el.get(i).copied().unwrap_or("<no such line>");
                if a != b {
                    at = format!(
                        "\nFirst differing line {}:\n  committed: {a}\n  expected : {b}",
                        i + 1
                    );
                    break;
                }
            }
            panic!(
                "IPC wire keys changed but src/lib/generated/ipc-wire-keys.json is stale.{detail}{at}\n\
                 If the Rust change is intended, regenerate and update the TS interface:\n\
                 \x20 cargo test --manifest-path src-tauri/Cargo.toml -- --ignored regenerate_ipc_wire_keys"
            );
        }
    }

    /// Guards against the probe silently degrading to an empty list, which would
    /// make the gate vacuous while still passing.
    #[test]
    fn probe_reports_real_keys() {
        let keys = wire_keys::<crate::types::DownloadTask>();
        assert!(keys.len() > 10, "probe returned {keys:?}");
        assert!(keys.iter().any(|k| k == "hfModelId"), "{keys:?}");
    }

    /// `SERIALIZE_ONLY_KEYS` must stay a list of *genuine* exceptions: a key the probe
    /// already reports is not an exception, it is a stale entry that silently widens
    /// the contract the TS side is checked against.
    #[test]
    fn serialize_only_keys_are_real() {
        let probed = probed_key_map();
        for (ty, extra) in SERIALIZE_ONLY_KEYS {
            let Some(keys) = probed.get(*ty) else {
                panic!("SERIALIZE_ONLY_KEYS names `{ty}`, which is not in the registry");
            };
            for key in *extra {
                assert!(
                    !keys.iter().any(|k| k == key),
                    "`{ty}.{key}` is reported by the probe already — drop it from \
                     SERIALIZE_ONLY_KEYS (it is not a skip_deserializing field)"
                );
            }
        }
    }
}
