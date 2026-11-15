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
  service stops or crashes. On start the service also kills any `oym-link.exe`
  left in session 0 by a previous run, and drops a stale `link-status.json`, so a
  reconnect cannot read a session that no longer exists.
- Children get `TEMP`/`TMP` pointed at `service-data\tmp`, which the link creates.
  Under LocalSystem `%TEMP%` is
  `...\config\systemprofile\AppData\Local\Temp`, which often does not exist; Pi's
  PowerShell tool wrote its log there and the ENOENT took whole sessions down.
- `service-child.log` **appends** a `--- service start <ts> ---` marker instead of
  being truncated, so a crash/restart loop keeps its history.
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

The installer copies the service host, `oym-link.exe`, and `pi/` beside it, then
starts `OymLink`.

## Updating

`scripts\install-oym-service.ps1` **stops** the service, replaces the files, and
starts it again — it does not uninstall. Tearing the registration down on every
update logged a 7045, cost ~13 s, and widened the window in which the old child
tree could outlive the service. WinSW reads `OymLink.xml` at every start, so
runtime settings (executable, arguments, `<env>`, logging) change with a
stop/start; only SCM-owned settings (service account, start mode, dependencies)
need `uninstall-oym-service.ps1` followed by a fresh install.

WinSW is **pinned** to 2.12.0 and verified by SHA-256
(`05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA`). An update
reuses the installed wrapper when its hash matches, so there is no 18 MB download
and a tampered copy is rejected instead of silently accepted.

`-TestShell` adds `<env name="OYM_TEST_SHELL" value="1"/>` to the installed XML for
this service only (see [TEST-SHELL.md](TEST-SHELL.md)); it is off by default and
disappears with an uninstall.

The app launches the packaged copy of this script, found next to its own
executable — editing the repo does not change what an already-installed app runs
until that package is rebuilt.

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
