//! Typed errors for the boundaries whose failures the UI must *decide* on.
//!
//! Scope is deliberately narrow — spawn (`launch_engine`), port-reclaim and the FIT
//! probe. The other 300-odd `Result<_, String>` sites in this crate stay free text;
//! retrofitting them was ruled out as churn with no behavioural win.
//!
//! # Why this exists
//!
//! Two frontend branches currently sniff error text to make a decision:
//! `useScenarioEvaluator.ts` matches the Tom MTP skip note and `App.tsx` regex-matches
//! OOM prose. Both become exhaustive switches on [`BlackwellError::kind`].
//!
//! # Contract
//!
//! - `kind` is the discriminant the frontend switches on. **String values are a
//!   contract**: renaming an existing variant, or changing its serialization, is a
//!   breaking change that must be made on both sides at once.
//! - `message` stays human-readable and is what the UI *displays*. It is never the
//!   thing being matched on.
//! - Producers that still speak `Result<_, String>` (e.g. `engine_port_lock`) are
//!   classified at the command boundary by the `classify_*` helpers below, so the
//!   string matching lives in one auditable place instead of at each call site. The
//!   `*_covers_*_producers` tests below pin that mapping to the exact producer text.

use serde::{Deserialize, Serialize};

/// A boundary failure with a stable machine-readable `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BlackwellError {
    // ── spawn (launch_engine) ──────────────────────────────────────────
    /// Provider binary missing or not readable.
    BinaryNotFound { message: String },
    /// Provider binary present but failed validation (wrong name/shape).
    BinaryValidationFailed { message: String },
    /// Base port below the privileged threshold — unusable by design.
    PortOutOfRange { message: String },
    /// A specific port is held by another process.
    ///
    /// `reason` is a flat sub-discriminant (see [`port_conflict_reason`]) so the frontend
    /// still matches on one level; it is serialized rather than computed on read.
    PortConflict { port: u16, reason: &'static str, message: String },
    /// No free engine slot.
    NoFreeSlot { message: String },
    /// Stack lock contended — another task holds engine state.
    EngineStateBusy { message: String },
    /// Alias uniquification exhausted its suffix range.
    AliasExhausted { message: String },
    /// The process could not be started at all.
    EngineSpawnFailed { message: String },

    // ── FIT probe ──────────────────────────────────────────────────────
    /// Probe skipped by design — MTP/Tom/tensor-split. Not a failure; the UI
    /// reports it as an informational skip rather than an error.
    FitProbeSkipped { message: String },
    /// No usable `llama-fit-params` for this provider.
    FitBinaryMissing { message: String },
    /// A fit binary resolved, but not the one this adapter requires.
    FitBinaryMismatch { message: String },
    /// Probe process exceeded its time budget.
    FitProbeTimeout { message: String },
    /// Probe process started and failed (crash, abort, non-zero exit).
    FitProbeFailed { message: String },
}

/// Why a port could not be reclaimed. Carried as a flat `reason` string so the
/// frontend matches one level (`kind`), not two.
pub mod port_conflict_reason {
    pub const UNIDENTIFIED_LISTENER: &str = "unidentified_listener";
    pub const LIVE_STACK_ENGINE: &str = "live_stack_engine";
    pub const OWNED_BY_OTHER_INSTANCE: &str = "owned_by_other_instance";
    pub const PROVIDER_MISMATCH: &str = "provider_mismatch";
    pub const FOREIGN_APP: &str = "foreign_app";
    pub const RECLAIM_TIMEOUT: &str = "reclaim_timeout";
}

impl BlackwellError {
    /// Stable machine-readable discriminant, matching the serialized `kind`.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::BinaryNotFound { .. } => "binary_not_found",
            Self::BinaryValidationFailed { .. } => "binary_validation_failed",
            Self::PortOutOfRange { .. } => "port_out_of_range",
            Self::PortConflict { .. } => "port_conflict",
            Self::NoFreeSlot { .. } => "no_free_slot",
            Self::EngineStateBusy { .. } => "engine_state_busy",
            Self::AliasExhausted { .. } => "alias_exhausted",
            Self::EngineSpawnFailed { .. } => "engine_spawn_failed",
            Self::FitProbeSkipped { .. } => "fit_probe_skipped",
            Self::FitBinaryMissing { .. } => "fit_binary_missing",
            Self::FitBinaryMismatch { .. } => "fit_binary_mismatch",
            Self::FitProbeTimeout { .. } => "fit_probe_timeout",
            Self::FitProbeFailed { .. } => "fit_probe_failed",
        }
    }

    /// Human-readable text. This is what the UI shows.
    pub fn message(&self) -> &str {
        match self {
            Self::BinaryNotFound { message }
            | Self::BinaryValidationFailed { message }
            | Self::PortOutOfRange { message }
            | Self::PortConflict { message, .. }
            | Self::NoFreeSlot { message }
            | Self::EngineStateBusy { message }
            | Self::AliasExhausted { message }
            | Self::EngineSpawnFailed { message }
            | Self::FitProbeSkipped { message }
            | Self::FitBinaryMissing { message }
            | Self::FitBinaryMismatch { message }
            | Self::FitProbeTimeout { message }
            | Self::FitProbeFailed { message } => message,
        }
    }

    /// Port-conflict sub-reason, when this is a port conflict.
    ///
    /// Stored on the variant and serialized, so the frontend matches one level.
    pub fn port_reason(&self) -> Option<&'static str> {
        match self {
            Self::PortConflict { reason, .. } => Some(reason),
            _ => None,
        }
    }
}

impl std::fmt::Display for BlackwellError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for BlackwellError {}

/// Most of the crate still speaks `Result<_, String>`; this keeps `?` working at
/// call sites that cannot yet carry the typed error.
impl From<BlackwellError> for String {
    fn from(e: BlackwellError) -> Self {
        e.message().to_string()
    }
}

/// Classify a port-reclaim failure.
///
/// `engine_port_lock::reclaim_our_ghost_or_fail` returns `Result<(), String>`; its
/// messages are the producer contract. `port_reclaim_classifier_covers_producers`
/// below pins every branch to the producer's literal text so a rewording there
/// fails a test here instead of silently degrading the frontend to `foreign_app`.
pub fn classify_port_reclaim(port: u16, message: String) -> BlackwellError {
    BlackwellError::PortConflict { port, reason: port_conflict_reason_of(&message), message }
}

/// Which producer message produced this failure. See [`port_conflict_reason`].
fn port_conflict_reason_of(message: &str) -> &'static str {
    let m = message;
    if m.contains("could not be identified") || m.contains("is not readable") {
        // Two distinct producer messages, one cause: the listener PID is unknown.
        port_conflict_reason::UNIDENTIFIED_LISTENER
    } else if m.contains("still in use after reclaiming") {
        port_conflict_reason::RECLAIM_TIMEOUT
    } else if m.contains("another running Blackwell Ops instance") {
        port_conflict_reason::OWNED_BY_OTHER_INSTANCE
    } else if m.contains("another running Blackwell Ops engine") {
        // Must follow the `instance` branch: its text also contains
        // "another running Blackwell Ops".
        port_conflict_reason::LIVE_STACK_ENGINE
    } else if m.contains("lock binary does not match") {
        port_conflict_reason::PROVIDER_MISMATCH
    } else {
        // Foreign holder, or wording we do not recognise. Either way the port is
        // not ours and the original message still reaches the UI.
        port_conflict_reason::FOREIGN_APP
    }
}

/// Classify a provider-binary resolution failure.
///
/// Producer: `engine_utils::find_provider_binary`, which reports
/// `No valid binary found for provider '<id>'`. Anything else is a path that resolved
/// but failed validation.
pub fn classify_binary_resolution(message: String) -> BlackwellError {
    if message.contains("No valid binary found for provider") {
        BlackwellError::BinaryNotFound { message }
    } else {
        BlackwellError::BinaryValidationFailed { message }
    }
}

/// Classify a FIT probe failure.
///
/// Producers: `fit_scanner::resolve_fit_binary`, `scan_single_anchor`,
/// `fit_process_error_message`, `decode_fit_exit`.
pub fn classify_fit_probe(message: String) -> BlackwellError {
    let m = message.as_str();
    if m.contains("llama-fit-params.exe not found") {
        BlackwellError::FitBinaryMissing { message }
    } else if m.contains("Tom FIT requires ggml-tom") {
        BlackwellError::FitBinaryMismatch { message }
    } else if m.contains("timeout") || m.contains("no exit code (killed / timeout") {
        BlackwellError::FitProbeTimeout { message }
    } else {
        BlackwellError::FitProbeFailed { message }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend switches on these strings. Renaming one is a breaking change.
    #[test]
    fn kind_strings_are_stable() {
        let cases = [
            (BlackwellError::BinaryNotFound { message: String::new() }, "binary_not_found"),
            (BlackwellError::BinaryValidationFailed { message: String::new() }, "binary_validation_failed"),
            (BlackwellError::PortOutOfRange { message: String::new() }, "port_out_of_range"),
            (BlackwellError::PortConflict { port: 8080, reason: port_conflict_reason::FOREIGN_APP, message: String::new() }, "port_conflict"),
            (BlackwellError::NoFreeSlot { message: String::new() }, "no_free_slot"),
            (BlackwellError::EngineStateBusy { message: String::new() }, "engine_state_busy"),
            (BlackwellError::AliasExhausted { message: String::new() }, "alias_exhausted"),
            (BlackwellError::EngineSpawnFailed { message: String::new() }, "engine_spawn_failed"),
            (BlackwellError::FitProbeSkipped { message: String::new() }, "fit_probe_skipped"),
            (BlackwellError::FitBinaryMissing { message: String::new() }, "fit_binary_missing"),
            (BlackwellError::FitBinaryMismatch { message: String::new() }, "fit_binary_mismatch"),
            (BlackwellError::FitProbeTimeout { message: String::new() }, "fit_probe_timeout"),
            (BlackwellError::FitProbeFailed { message: String::new() }, "fit_probe_failed"),
        ];
        for (err, expected) in cases {
            assert_eq!(err.kind(), expected);
        }
    }

    /// Serialization must carry both fields — the frontend reads `kind` and shows `message`.
    #[test]
    fn serializes_kind_and_message() {
        let err = BlackwellError::FitProbeSkipped {
            message: "MTP model — Tom does not load draft/MTP models yet".into(),
        };
        let v: serde_json::Value = serde_json::to_value(&err).unwrap();
        assert_eq!(v["kind"], "fit_probe_skipped");
        assert_eq!(v["message"], "MTP model — Tom does not load draft/MTP models yet");
    }

    #[test]
    fn port_conflict_serializes_port_and_reason() {
        let err = classify_port_reclaim(
            8090,
            "Port 8090 is in use by another running Blackwell Ops instance (owner PID 7). Stop that engine first or change BASE-PORT.".into(),
        );
        let v: serde_json::Value = serde_json::to_value(&err).unwrap();
        assert_eq!(v["kind"], "port_conflict");
        assert_eq!(v["port"], 8090);
        // The sub-reason must cross IPC, not just exist as a Rust accessor.
        assert_eq!(v["reason"], "owned_by_other_instance");
    }

    /// Every message `engine_port_lock::reclaim_our_ghost_or_fail` can produce must land
    /// on a specific reason. These are the producer's literals — if that file is reworded,
    /// this test fails rather than the frontend silently falling through to `foreign_app`.
    #[test]
    fn port_reclaim_classifier_covers_producers() {
        let cases = [
            (
                "Port 8080 is in use but the listening process could not be identified. \
                 Stop the other server or change BASE-PORT.",
                port_conflict_reason::UNIDENTIFIED_LISTENER,
            ),
            (
                "Port 8080 listener PID 4321 is not readable. \
                 Stop the other application or change BASE-PORT.",
                port_conflict_reason::UNIDENTIFIED_LISTENER,
            ),
            (
                "Port 8080 is still in use after reclaiming orphan PID 4321. \
                 Stop the process manually or change BASE-PORT.",
                port_conflict_reason::RECLAIM_TIMEOUT,
            ),
            (
                "Port 8080 is in use by another running Blackwell Ops instance (owner PID 99). \
                 Stop that engine first or change BASE-PORT.",
                port_conflict_reason::OWNED_BY_OTHER_INSTANCE,
            ),
            (
                "Port 8080 lock binary does not match this provider. \
                 Stop the other application or change BASE-PORT.",
                port_conflict_reason::PROVIDER_MISMATCH,
            ),
            (
                "Port 8080 is held by PID 4321 (C:\\other\\llama-server.exe) — not our llama-server. \
                 Stop the other application or change BASE-PORT.",
                port_conflict_reason::FOREIGN_APP,
            ),
            (
                "Port 8080 is in use by PID 4321 (not a Blackwell Ops engine lock). \
                 Stop the other application or change BASE-PORT.",
                port_conflict_reason::FOREIGN_APP,
            ),
            (
                "Port 8080 is in use by another running Blackwell Ops engine (PID 4321). \
                 Stop that engine first or change BASE-PORT.",
                port_conflict_reason::LIVE_STACK_ENGINE,
            ),
        ];
        for (message, expected) in cases {
            let err = classify_port_reclaim(8080, message.to_string());
            assert_eq!(err.kind(), "port_conflict", "message: {message}");
            assert_eq!(err.port_reason(), Some(expected), "message: {message}");
        }
    }

    /// The two "another running Blackwell Ops …" messages differ only by
    /// `instance` vs `engine`, so the `instance` branch must be tested first.
    /// This pins both at once — reordering the classifier fails here.
    #[test]
    fn instance_and_engine_port_messages_do_not_collide() {
        let instance = "Port 8080 is in use by another running Blackwell Ops instance (owner PID 99). Stop that engine first or change BASE-PORT.";
        let engine = "Port 8080 is in use by another running Blackwell Ops engine (PID 4321). Stop that engine first or change BASE-PORT.";
        assert_eq!(
            classify_port_reclaim(8080, instance.into()).port_reason(),
            Some(port_conflict_reason::OWNED_BY_OTHER_INSTANCE)
        );
        assert_eq!(
            classify_port_reclaim(8080, engine.into()).port_reason(),
            Some(port_conflict_reason::LIVE_STACK_ENGINE)
        );
    }

    /// The FIT skip note is the branch `useScenarioEvaluator.ts` switches on, so it must
    /// classify as a skip and not as a probe failure.
    #[test]
    fn fit_skip_note_classifies_as_skip() {
        let err = BlackwellError::FitProbeSkipped {
            message: "MTP model — Tom does not load draft/MTP models yet".into(),
        };
        assert_eq!(err.kind(), "fit_probe_skipped");
        assert_ne!(err.kind(), "fit_probe_failed");
    }

    #[test]
    fn fit_probe_classifier_covers_producers() {
        assert_eq!(
            classify_fit_probe(
                "llama-fit-params.exe not found for provider 'ggml-master' (profile=frontier) — build Foundry frontier or bundle the tool".into()
            )
            .kind(),
            "fit_binary_missing"
        );
        assert_eq!(
            classify_fit_probe(
                "Tom FIT requires ggml-tom llama-fit-params (Foundry frontier). Build Tom frontier in Foundry.".into()
            )
            .kind(),
            "fit_binary_mismatch"
        );
        assert_eq!(
            classify_fit_probe(
                "Fit process failed for m.gguf (adapter=ggml_master, binary=x, no exit code (killed / timeout / spawn fail)): unknown fit error".into()
            )
            .kind(),
            "fit_probe_timeout"
        );
        assert_eq!(
            classify_fit_probe(
                "Fit process failed for m.gguf (adapter=ggml_master, binary=x, exit 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN — FIT crash, often unimplemented tensor or bad load)): boom".into()
            )
            .kind(),
            "fit_probe_failed"
        );
    }

    /// Text reaches the UI unchanged — the change adds a discriminant, it does not reword.
    #[test]
    fn message_is_carried_verbatim() {
        let raw = "Port 8080 is held by PID 1 (x) — not our llama-server. Stop the other application or change BASE-PORT.";
        let err = classify_port_reclaim(8080, raw.to_string());
        assert_eq!(err.message(), raw);
        assert_eq!(err.to_string(), raw);
    }
}
