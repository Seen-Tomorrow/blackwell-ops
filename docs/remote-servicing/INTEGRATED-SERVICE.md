# Integrated service

Integrated mode is now a real link host, not just a heartbeat:

- `oym-link-service.exe` runs as `LocalSystem` under the WinSW `OymLink` wrapper.
- On install it consumes a one-shot bootstrap from the paired desktop app:
  - identity → `%ProgramData%\OYM\Link\service-data\identity.json`
  - device token → `%ProgramData%\OYM\Link\service-data\device.token`
  - the bootstrap is deleted immediately.
- `service-data` is ACLed to `SYSTEM` + `Administrators`; the interactive user
  cannot read the machine token.
- The service starts `oym-link.exe --quiet` as a hidden LocalSystem child with
  `OYM_DATA_DIR` and `OYM_DEVICE_TOKEN_FILE`, and restarts it if it exits.
- A Job Object with `KILL_ON_JOB_CLOSE` prevents an orphaned link child when the
  service stops or crashes.
- Status is written to `%ProgramData%\OYM\Link\service-status.json` with:
  `running`, `pid`, `childPid`, `connected`, `sessionActive`, `error`.
- The tray app’s **SETTINGS → INTEGRATED SERVICE** card shows
  NOT INSTALLED / STOPPED / RUNNING / ONLINE and offers install/uninstall (UAC).

Because the child runs as LocalSystem, a remote session started by the service
has **SYSTEM** access. This is intentional for Integrated mode and is the reason
install/uninstall is owner-only, behind UAC.

## Install

From the paired OYM Link app: **SETTINGS → INTEGRATED SERVICE → INSTALL SERVICE**.
The app writes a user-only bootstrap, then launches the elevated installer; the
installer moves it into ProgramData with the restricted ACL.

Manual elevated install (development only):

```powershell
cargo build --release --manifest-path link\service\Cargo.toml
pwsh -File scripts\install-oym-service.ps1 -Bootstrap <path-to-service-bootstrap.json>
```

The installer copies the service host, `oym-link.exe`, and `pi/` beside it,
downloads WinSW if needed, installs `OymLink`, and starts it.

## Uninstall

```powershell
pwsh -File scripts\uninstall-oym-service.ps1
```

The Job Object terminates the link child when the service stops.

## Still missing

- **Named pipe IPC** — the app reads file status and controls the service through
  SCM; the pipe is the next layer for session commands/telemetry.
- **Mode switch UI** — install is explicit; there is no one-click
  Portable ↔ Integrated handoff yet.
- **Signing** — service, WinSW wrapper and installers must be signed before
  distribution.
- **VM test** — Session 0 SYSTEM PTY behavior needs a snapshot test; do not test
  destructive commands on a production machine.
