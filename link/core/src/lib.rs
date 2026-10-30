//! OYM Link core.
//!
//! Shared by the `oym-link` CLI and the OYM Link tray app so both use the same
//! identity, credential and gateway code. No UI and no process supervision live
//! here.

pub mod identity;
pub mod pairing;
pub mod status;

pub const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PI_VERSION: &str = "1.4.0";

/// Server baked into the portable trial build. The tray app lets the owner
/// override it in Settings, so this is only the first-run default.
pub const DEFAULT_SERVER: &str = "wss://favorite-fountain-begin-field.trycloudflare.com/link";
