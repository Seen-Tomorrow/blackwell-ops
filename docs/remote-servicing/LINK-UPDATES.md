# OYM Link updates

OYM Link uses the same release-asset pattern as the main app: a 7z payload on
GitHub, downloaded and applied by the app.

## Build and pack

```powershell
pwsh scripts/build-link.ps1 -Profile installer
pwsh scripts/pack-link-update.ps1
```

`pack-link-update.ps1` reads `link/app/.build_counter.json` and writes:

```text
.majestic-out/LINK_OYM-Link-<build>.7z
```

The archive contains `OYM-Link-Setup.exe`, not a raw app tree. The installer is
already responsible for closing the running app, replacing the install and
relaunching one instance.

## Ship

Upload to the current app release:

```powershell
pwsh scripts/ship-link.ps1 -Tag v1.1.9
```

The app queries the latest GitHub release for the highest
`LINK_OYM-Link-<build>.7z` asset. It compares that build with its own compiled
`BUILD` and shows **UPDATE** in the header when a newer asset exists.

## Apply

1. The app downloads the asset with `curl.exe` into
   `%LOCALAPPDATA%\OYM\Link\update`.
2. It extracts with the bundled `7z.exe` / `7z.dll` (shipped in the install and
   portable package).
3. It launches the extracted installer silently.
4. The installer closes the current app, replaces files and relaunches.

No UAC is required because both the app and installer are per-user.
