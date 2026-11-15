# Test shell profile (DEV tooling)

Status: implemented 2026-11-15  
Related: [LINK-SHAPE.md](LINK-SHAPE.md), [HANDOFF.md](HANDOFF.md)

## Why this exists

Testing a REL build needs a real user machine: no dev toolchain, no CUDA kit,
Defender on, different hardware. The operator can already open a **Pi** session
there, but that is the wrong tool for "read this log and tell me whether the
update landed": every command becomes a TUI round trip through a model.

The shell profile is the same session transport with a plain PowerShell on the
end of it. It is deliberately **DEV tooling, not product surface**.

## What it is not

- Not a Home-mode capability. [DECISIONS.md](DECISIONS.md) D-010 still stands: no
  raw terminal in Home mode.
- Not offered by any UI. The REMOTE tab behaves exactly as before and always
  sends `pi-maintenance`.
- Not open by default, and not open in a shipped build unless the device's own
  environment says so.

## How it works

| Layer | Change |
|---|---|
| `gateway/src/protocol.rs` | `SHELL_PROFILE = "shell"`, next to `SessionOpen` |
| `gateway/src/state.rs` | the routes gate does not apply to this profile |
| `src-tauri/src/gateway_cmds.rs` | `remote_session_start` takes an optional `profile`, default unchanged |
| `link/src/shell.rs` | ConPTY + `powershell.exe -NoLogo -NoProfile` |
| `link/src/main.rs` | one `start_session` dispatch; both spawn sites call it |

The Pi path is untouched: no model proxy files, no per-session agent home, no
routes. The forensic JSONL log still records `start` / `out` / `in` / `exit`, so
a shell session is auditable like any other.

## Enabling it

The device only spawns a shell when the process that hosts the link has:

```text
OYM_TEST_SHELL=1
```

Without that variable the profile is refused before any process is created
(`link/src/shell.rs`), so a build that contains this code stays inert.

For an Integrated install, prefer the **scoped** form — it is set on the service
rather than the machine, and disappears with an uninstall:

```powershell
pwsh -File scripts\install-oym-service.ps1 -Bootstrap <path-to-service-bootstrap.json> -TestShell
```

Or edit the installed `%ProgramData%\OYM\Link\service\OymLink.xml`, add
`<env name="OYM_TEST_SHELL" value="1" />` before `</service>`, and restart the
service. WinSW reads its XML at every start, so no reinstall is needed — and a
machine-wide variable set earlier should be removed once the scoped one is in
place.

## Privilege

The shell inherits the Link process's token, nothing more:

- **Integrated** (service installed, LocalSystem) → SYSTEM. This is what makes
  elevated testing possible.
- **Portable / tray** → the signed-in user.

The operator-visible `integrity` on the device tells you which one is live, and
it reflects the *connection that wrote last*, not the installed mode. Confirm
before trusting an elevated claim:

```powershell
Get-Process oym-link | Select-Object Id, SessionId
Get-CimInstance Win32_Service -Filter "Name='OYMLink'" | Format-List State, StartMode, StartName
```

`SessionId 0` plus `LocalSystem` is the service; a second `oym-link` in the
user's session id means something else is also connected.

## Headless readers must answer DSR

The shell is a real ConPTY, and PowerShell's console host opens with a
cursor-position query (`ESC[6n`) and **blocks until the terminal answers**. The
embedded xterm.js answers it for a human; a script reading the event stream must
answer it too, or the session sits silent forever with no prompt and no error —
the only symptom is a single 8-byte `out` frame in the forensic log.

Reply with `ESC[1;1R`. `scripts/remote-exec.ps1` does this in its event listener:

```js
if (text.indexOf("\u001b[6n") >= 0) {
  window.__TAURI__.core.invoke("remote_session_input", { deviceId: id, data: btoa("\u001b[1;1R") });
}
```

This is a property of the transport, not of the profile: any future headless
consumer of a shell session needs the same reply.

## Verifying it works

`session_ready` carries the **spawning process's** integrity, which is the only
authoritative answer about privilege:

```text
[session_ready pid 38208 integrity High]
```

The `integrity` in the device list is just the last `Hello` and can be stale or
flap between two link processes on one machine — do not use it to decide whether
a session will be elevated.

## Removing it

Delete `link/src/shell.rs`, remove `mod shell;` and the `start_session` dispatch
in `link/src/main.rs` (call `start_pi_session` directly from both sites), remove
the `pub(crate)` markers added for the module, delete `SHELL_PROFILE` and the two
gates keyed on it. No persisted state, no migration, no data shape change.
