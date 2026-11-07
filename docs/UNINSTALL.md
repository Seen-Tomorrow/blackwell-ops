# Uninstall — what goes, what stays

The uninstaller removes the program and every re-downloadable cache, but keeps the files that
make a reinstall feel like the same setup. Nothing outside the install folder is touched except
the WebView/AppData profile when the settings checkbox is ticked, and **model files are never
deleted**, wherever they live.

The uninstall handler is `src-tauri/nsis/installer.nsi` (`Section Uninstall`); the extra copy
lives in `src-tauri/nsis/languages/English.nsh`.

## Kept by default (vitals)

| Path (inside the install folder) | Why |
|---|---|
| `config\app_config.json` | model paths (including external folders), HF token, download default |
| `config\*-user-config.json` | per-engine user params / overrides |
| `config\runtime_settings.json` | session logging, CPU affinity |
| `config\automation\` | user automation scripts |
| `config\cache\` | `fit_scan_full`, `learned-vram`, `gpu-calibration`, `model_cache`, `download_history` — measured VRAM/FIT and learned metadata; expensive to relearn, tiny on disk |
| `config\external-tools\pi-home\` | pi harness `auth.json`, `models.json`, sessions, missions, `AGENTS.md` |
| Model files | every path in `app_config.model_paths` (`C:\AI-MASTER\models` by default); never touched by the uninstaller |

The vitals are ~35 MB in a typical install.

## Removed by default

| Path | What | Reinstall cost |
|---|---|---|
| `blackwell-ops.exe`, `uninstall.exe` | program | installer |
| `bin\`, `pi-ext\`, `runtime\`, `foundry\patches\` | installer payload | installer |
| `tmp\`, `.toolchain-download\` | scratch / interrupted-download cache | — |
| `toolchain\` | CUDA / VS / CMake packs (~4.4 GB) | re-download via setup wizard |
| `foundry\engines\` | llama.cpp source + build trees (~4.9 GB) | re-clone + rebuild |
| `foundry\artifacts\` | built engines (~0.6 GB) | rebuild in Foundry |
| `runtime-catalog\` | downloaded engine packs | re-download from the engines channel |
| `external-tools\pi` | pi harness binary (~113 MB) | Harness UPDATE |
| `config\logs\`, `config\nsys\`, `config\bench\`, `config\engine-locks\`, `config\remote\` | diagnostics / runtime state | — |

That is roughly 14–17 GB on a full install.

## The checkbox

**"Also delete my settings, agent sessions and UI preferences"** (unchecked by default):

- removes `config\` entirely (including `pi-home` and the learned cache),
- removes `%APPDATA%\com.blackwell-ops.app` and `%LOCALAPPDATA%\com.blackwell-ops.app`
  (WebView profile, localStorage UI prefs),
- leaves model files and any external model folders untouched.

## Old builds / leftovers

Older installers only deleted the exe and files listed as resources; directory resources were
not removed, so a "successful" uninstall could leave `runtime\`, `toolchain\`, `foundry\`,
`bin\`, `pi-ext\` and `.toolchain-download\` behind. The current uninstaller removes those
explicitly. If a machine was uninstalled with an older build, delete those folders manually
(or reinstall then uninstall) — the current uninstaller will also clean any that remain in the
folder it is uninstalling.

## Update in place

Updates never run this logic: `--UPDATE` skips the checkbox and uninstall section entirely, so
config, engines, toolchain and foundry builds stay in place across updates.
