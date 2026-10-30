# OYM — product shape and vocabulary

Status: name locked 2026-10-30; renames in progress  
Decision log: [DECISIONS.md](DECISIONS.md) D-018…D-027  
Related: [PRODUCT-PLAN.md](PRODUCT-PLAN.md), [TRANSCRIPT-FETCH.md](TRANSCRIPT-FETCH.md),
[LOCAL-MODE-REPORT.md](LOCAL-MODE-REPORT.md)

## Product name

**OYM** is the mark. **“Own your infra.”** is the tagline.

- Use `OYM` as a standalone three-letter wordmark. No expansion is required in
  the UI.
- If an expansion is needed, **Own Your Models** is the safe long form. Do **not**
  put “Metal” in product copy: in GPU software that reads as Apple's Metal API.
  The original “Own Your Metal” stays as internal history only.
- Never brand a surface `INFRA OPS` or `INFRAOPS` — that is a category (and
  [InfraOps](https://www.infraops.com/) exists). `INFRA OPS` may describe the
  OPERATIONS page in copy, never act as the product mark.

Family: **OYM / OYM Link / OYM Foundry / OYM Remote**. Feature names stay:
**Fusion** (live multi-engine view), **Twin** (two-seat launch), **FOUNDRY**
(build page), **OPERATIONS** / **REMOTE** (nav).

## The two nouns

**OYM** is the product: the admin application and the capability. **OYM Link** is
the device-side application: one tray app, two run profiles. The gateway inside
OYM is a component, not a brand.

## Vocabulary

| Concept | UI term | Code | Notes |
|---|---|---|---|
| Capability / admin page | **REMOTE** | `remote` (docs), REMOTE nav | Host side |
| Host-side server | **GATEWAY** | `oym-gateway`, `GatewayState`, `GatewayStatus` | Loopback 7443 inside OYM |
| Public edge | **PUBLIC ENDPOINT** | `public_url` | Cloudflare tunnel URL |
| Device application | **OYM LINK** | `oym-link` | Tray + flyout |
| Windows service | **LINK SERVICE** | `oym-link-service`, `LinkService` | Integrated mode only |
| Per-user UI process | **LINK TRAY** | `link-tray` | Never called "agent" |
| Compact panel | **FLYOUT** | `flyout` | Bottom-right, auto-hide |
| Run profile | **PORTABLE / INTEGRATED** | `LinkMode::{Portable, Integrated}` | |
| Target PC | **DEVICE** | `Device`, `device_id` | |
| Person at the admin | **OPERATOR** | `operator` | |
| Person at the device | **OWNER** | `owner` | The administrator gate |
| Pairing | **PAIRING CODE** | `PairingCode`, `pairing_code` | One-time |
| Credential | **DEVICE TOKEN** | `device_token` | Credential Manager |
| Pi driven by the operator | **REMOTE SESSION** | `RemoteSession` | Wire `SessionOpen` stays |
| Pi driven by the local user | **LOCAL ASSISTANT** | `Assistant`, `assistant.rs` | Runs as the signed-in user |
| Saved Pi conversation | **TRANSCRIPT** | `Transcript` | Fetch is a REMOTE feature |
| Home engine model | **HOME MODEL** | provider `blackwell`, `ModelRoute` | `blackwell/<engine>`; the GPU architecture, not the product |
| Cloud model | **CLOUD MODEL** | provider `cloud` | DeepSeek Flash |
| Running llama-server | **ENGINE** | `engine` | |
| Transport state | **OFFLINE / CONNECTING / ONLINE** | `LinkStatus` | |
| Live activity | **IDLE / ASSISTANT / SESSION** | `LinkActivity` | Exclusive |

Retired from UI and new code: **Power Mode** (docs may keep it as the umbrella
"full-tool mode"), **agent** (only the old `/agent` path remains until renamed),
**harness** (Pi is the runtime; the UI never names it), **client** (say Link).

Naming rules:

1. One concept, one word. Synonyms are bugs.
2. A UI label maps to exactly one code noun (`LOCAL ASSISTANT` → `assistant`).
3. Nouns name the thing, not the direction (`Gateway`, not "remote server").

## Components

```text
OYM (home)                                    Device
┌──────────────────────────────┐              ┌──────────────────────────────┐
│ REMOTE page                  │              │ OYM Link (tray)              │
│  Gateway  127.0.0.1:7443     │◀── WSS ─────▶│  ├─ flyout / settings        │
│  Cloudflare tunnel           │   outbound   │  ├─ Local Assistant (user)   │
│  Devices / sessions /        │              │  └─ remote-session view      │
│  transcripts                 │              │                              │
└──────────────────────────────┘              │ Integrated only:             │
                                              │  Link Service (SYSTEM)       │
                                              │   connection, sessions,      │
                                              │   transcripts, updates       │
                                              └──────────────────────────────┘
```

Repo target:

```text
gateway/                 # was remote/        package oym-gateway
link/
  core/                  #                   package oym-link-core
  app/                   # Tauri v2 + React  package oym-link
  service/               #                   package oym-link-service
  installer/             # NSIS hooks
```

`link/core` owns the protocol client, identity, credentials, loopback model
proxy, ConPTY wrapper, assistant configuration and cloud resolution. The tray
app owns UI only. The service owns the long-lived connection and unattended
work; the tray asks the service over a named pipe when it is installed, and owns
the connection itself in Portable mode.

## Modes

| | **PORTABLE** | **INTEGRATED** |
|---|---|---|
| Artifact | `oym-link-portable.zip` | `oym-link-setup.exe` (UAC once) |
| Install | none | `C:\Program Files\OYM\Link` |
| Runs as | signed-in user | service **LocalSystem** + per-user tray |
| Connection owned by | tray | service |
| Alive when logged off | no | yes |
| Auto-start | optional per-user | service at boot, tray at logon |
| Auto-reconnect | while running | always, backoff |
| Remote session | user | SYSTEM (install-time warning) |
| Local Assistant | user | user (service cannot host it) |
| Transcript fetch while idle | no | yes |
| Updates | manual | service-driven |

The Local Assistant always runs as the signed-in user in both modes: a service
cannot own an interactive console in the user's session. Integrated remote
sessions run as SYSTEM because that is what unattended maintenance needs; the
installer states this explicitly.

## UI

- Tray icon states: offline, online, remote session live, assistant running.
- Left click: frameless flyout, **bottom-right**, ~380×560, auto-hide on blur.
- Flyout sections: **CONNECTION** (device name, mode badge, gateway, latency,
  session banner), **ASSISTANT** (home routes count / cloud model, START LOCAL
  ASSISTANT), **PAIRING** (code entry when unpaired), footer **SETTINGS · LOGS ·
  QUIT**.
- START LOCAL ASSISTANT opens a ~960×640 window with the Pi TUI embedded
  (xterm.js over ConPTY). No console window, no flags.
- Settings: device name, cloud (DeepSeek), start with Windows, install/remove
  service, unpair, diagnostics.
- Dark chrome only for now. No theme switcher in the Link app.
- No CLI is required for any user action. Internal diagnostic flags may exist
  but are not part of the product.

## Cloud and credentials

DeepSeek is the first cloud provider and the only one for now:

```text
provider  deepseek
baseUrl   https://api.deepseek.com
model     deepseek-flash        (1M context, vision, thinking on by default)
```

- The **API key belongs to the owner** (D-015). It lives in Windows Credential
  Manager as `OYMLink` / `cloud-api-key` (Portable, per user) or in a DPAPI
  machine-scope secret under `%PROGRAMDATA%\OYM\Link` (Integrated service, ACL:
  SYSTEM + Administrators). It is never logged, never displayed after entry, and
  never accepted from the command line.
- **Pi never sees the key.** Cloud requests go through the same loopback proxy
  the home routes use: Pi's `models.json` holds only a random per-launch token,
  and the proxy injects `Authorization` upstream. This replaces the current
  behaviour where the key is written into `models.json`; that file is plaintext
  and must not carry the owner key.
- The key field in Settings is write-only with a **REPLACE KEY** action and a
  stored/not-stored state. Testing uses a fake endpoint; the owner enters the
  real key.

## Identifiers and paths

```text
binaries     oym.exe                      (admin app; was blackwell-ops.exe)
             oym-link.exe  oym-link-service.exe
             oym-link-setup.exe  oym-link-portable.zip
service      OYMLink  (display "OYM Link Service")
pipe         \\.\pipe\oym-link
install      C:\Program Files\OYM\Link
per-user     %LOCALAPPDATA%\OYM\Link   (settings, pi-sessions, logs)
machine      %PROGRAMDATA%\OYM\Link    (service config, logs)
credentials  OYMLink / cloud-api-key
             OYMLink / device-token:<device_id>
commands     gateway_* (admin)   link_* (device app)
events       gateway-event  link-status  link-activity  link-assistant-output
```

## Renames

Staged so the running app is never left with a frontend that calls commands the
running backend does not have yet.

Already safe (no UI/runtime dependency):

1. `remote/` → `gateway/`, package `blackwell-remote` → `oym-gateway`,
   `RemoteState/Config/Status/Event` → `Gateway*`.
2. `remote-client/` → `link/`, package and binary `oym-link`.
3. WS path `/agent` → `/link`.
4. Credential service and data dirs → `OYMLink`, `%LOCALAPPDATA%\OYM\Link`.

Needs an app restart (one coordinated pass):

5. `remote_*` Tauri commands → `gateway_*`, event `remote-event` →
   `gateway-event`, TS contract types → `Gateway*`.
6. Main-app brand sweep: `BlackwellBrandMark`, `brandLogos`, onboarding, error
   boundary, Fusion share capture, README/docs; Tauri identifier
   `com.blackwell-ops.app` → `com.oym.app`; binary `blackwell-ops.exe` →
   `oym.exe`; `BLACKWELL_*` env vars → `OYM_*`.
7. “Blackwell” remains as the GPU **architecture** label in
   `cudaArchUtils.ts` and as the `blackwell/*` provider id — descriptive, not
   product branding.
8. Test machines re-pair once (credentials and data dir move).

## Phases

1. **Rename commit** — vocabulary only, behaviour unchanged, tests green.
2. **Portable GUI** — Tauri tray + flyout + settings + pairing + embedded Local
   Assistant; remove the CLI surface from the user path.
3. **Cloud** — DeepSeek settings, key storage, loopback proxy injection.
4. **Integrated** — NSIS installer, service, named-pipe IPC, autostart, updates;
   SYSTEM warning.
5. **Transcript fetch** — REMOTE → TRANSCRIPTS tab plus the link-side handler
   from [TRANSCRIPT-FETCH.md](TRANSCRIPT-FETCH.md).

## Open items

- Trademark: OYM is used by a Swiss group (OYM AG / Sports / Foundation) and a
  Ruby gem — different lanes. The three-letter mark is weak; always show it with
  the tagline, and run a formal clearance before commercial release.
- Service signing and update channel.
- WebView2 bootstrapper policy for clean offline images.
- Whether Integrated remote sessions may ever run as the user instead of SYSTEM
  (default: no).
- Installer brand assets.
