# Integrated service (skeleton)

The Integrated mode is being built in layers. This first layer is the install /
status foundation only:

- `oym-link-service.exe` — a LocalSystem service host that writes a heartbeat to
  `%ProgramData%\OYM\Link\service-status.json` every 2 s.
- WinSW wrapper (`OymLink`) provides install, uninstall, auto-start, restart on
  failure and log rotation.
- The tray app’s **SETTINGS → INTEGRATED SERVICE** card shows
  NOT INSTALLED / STOPPED / RUNNING and can trigger the elevated install or
  uninstall. UAC confirmation is required.
- The service does **not** own the remote link or a PTY yet. Portable remains the
  functional servicing mode. The UI says so.

## Build

```powershell
cargo build --release --manifest-path link\service\Cargo.toml
```

## Install (elevated)

```powershell
pwsh -File scripts\install-oym-service.ps1
```

The script downloads WinSW if needed, copies the host and XML to
`%ProgramData%\OYM\Link\service`, installs `OymLink`, and starts it. It refuses to
run without an elevated token.

## Uninstall (elevated)

```powershell
pwsh -File scripts\uninstall-oym-service.ps1
```

Add `-RemoveFiles` to delete the service directory.

## Guardrails for the next layer

- The service runs as `LocalSystem`; the remote PTY will therefore be SYSTEM.
  This is the feature, not a side effect. Treat every remote session as full
  machine access.
- Never let the helper SFX install this service automatically. Only the owner can
  install it, behind UAC and an explicit warning.
- The device token must move to a machine-scoped store before the service owns
  the link — the SYSTEM account cannot read the interactive user’s Credential
  Manager entry.
- The service and WinSW wrapper must be signed before distribution.
- Test the SYSTEM PTY path on a VM/snapshot; Session 0 has no interactive desktop.
