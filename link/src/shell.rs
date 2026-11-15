//! Test-only remote shell profile.
//!
//! `SessionOpen { profile: "shell" }` runs a plain PowerShell inside the same
//! ConPTY the Pi profile uses, so the operator can read logs, check whether a
//! build landed, and inspect installed versions on a real user machine — without
//! driving a TUI and without paying a model round trip per command.
//!
//! Why it is separate from the Pi path:
//!   - no model proxy, no `models.json`, no per-session agent home, no routes
//!   - the gateway exempts it from the routes gate, so it opens with no engine
//!   - nothing in the UI offers it, so the servicing workflow is unchanged
//!
//! It inherits the privilege of *this* process: SYSTEM only when the integrated
//! service hosts the link, the signed-in user in Portable mode. The process
//! refuses to spawn anything unless `OYM_TEST_SHELL=1` is set in its own
//! environment, so a shipped build with this code present stays inert.
//!
//! Removal: delete this file, the `mod shell;` line and the `start_session`
//! dispatch (which then calls `start_pi_session` directly) in `main.rs`, the
//! `pub(crate)` markings listed there, and `SHELL_PROFILE` in the gateway
//! protocol. No persisted state, no migration.

use oym_gateway::protocol::{ClientMessage, SessionOpen};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

use crate::{conpty_available, encode_b64, now_secs, PtySession};

/// Set this to `1` in the device's environment to allow the profile.
const ENABLE_VAR: &str = "OYM_TEST_SHELL";

/// True when the operator asked for the test shell rather than Pi.
pub(crate) fn wants(profile: &str) -> bool {
    profile == oym_gateway::protocol::SHELL_PROFILE
}

/// Read once per call. A missing or unrecognised value means "refuse".
fn enabled() -> bool {
    std::env::var(ENABLE_VAR)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            )
        })
        .unwrap_or(false)
}

pub(crate) async fn start(
    cwd: &Path,
    temp_dir: &Path,
    session: &SessionOpen,
    outbound: mpsc::UnboundedSender<ClientMessage>,
    last_activity: Arc<AtomicU64>,
) -> Result<PtySession, String> {
    if !enabled() {
        return Err(format!(
            "{ENABLE_VAR} is not set on the device; refusing the test shell profile"
        ));
    }
    if !conpty_available() {
        return Err("this Windows build has no ConPTY; the test shell needs Windows 10 1809+".into());
    }

    // `-NoProfile` keeps the shell deterministic (no user profile output or slow
    // modules); `-ExecutionPolicy Bypass` only affects this process, so a test
    // script can still be piped in on a machine whose policy blocks scripts.
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: session.rows.max(8),
            cols: session.cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("open ConPTY: {e}"))?;
    let mut command = CommandBuilder::new("powershell.exe");
    command.args(["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass"]);
    // Same reason as the Pi path: never rely on the ambient %TEMP%, which does not
    // exist for a LocalSystem profile.
    command.env("TEMP", temp_dir);
    command.env("TMP", temp_dir);
    command.cwd(cwd);
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| format!("spawn test shell: {e}"))?;
    drop(pair.slave);

    let pid = child.process_id();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("pty reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("pty writer: {e}"))?;

    // Same forwarding shape as the Pi path: base64 PTY bytes out, `SessionExit`
    // when the pipe closes, so the operator UI and the forensic log see a normal
    // session.
    std::thread::spawn(move || {
        let mut buffer = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    last_activity.store(now_secs(), Ordering::Relaxed);
                    if outbound
                        .send(ClientMessage::PtyData {
                            data: encode_b64(&buffer[..n]),
                        })
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = outbound.send(ClientMessage::SessionExit { code: None });
    });

    Ok(PtySession {
        writer,
        master: pair.master,
        pid,
    })
}
