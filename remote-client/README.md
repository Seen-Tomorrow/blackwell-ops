# blackwell-link

Portable Windows client for the Blackwell Ops remote maintenance trial.

It owns only transport and process supervision:

- pair once with a one-time code
- keep the device token in Windows Credential Manager
- connect outbound to the Blackwell gateway over WSS
- start a bundled Pi in ConPTY when the operator opens a session
- expose a loopback OpenAI-compatible proxy so Pi's model calls travel through
  the same tunnel

It also has an opt-in **local Power Mode** (`--local`) that runs Pi in the
console in front of you without opening a remote session. See
[Local Power Mode](#local-power-mode). Default remote behavior is unchanged
when `--local` is absent.

It does **not** run a model, install a service, open an inbound port, or write a
terminal transcript.

## Windows support

The minimum technical floor is **Windows 10 version 1809 (build 17763) x64** or
**Windows Server 2019 (build 17763) x64**. Both the client (`CreatePseudoConsole`)
and Pi's Bun runtime (`ClosePseudoConsole`) require ConPTY, which was introduced
in that release.

| OS | Direct Blackwell Link + Pi |
|---|---|
| Windows 11 22H2+ | yes — tested on build 26200 |
| Windows 10 22H2 / 21H2 / 21H1 / 20H2 | yes, but out of support |
| Windows 10 1809 / LTSC 2019 | technical minimum; 1809 is out of support, LTSC 2019 runs to 2029 |
| Windows Server 2025 / 2022 | yes — Server 2022 tested |
| Windows Server 2019 | yes — minimum supported server |
| Windows Server 2016 | no — build 14393 has no ConPTY |
| Windows Server 2012 R2 / 2012 | no — build 9600; Pi fails at load |
| Windows 8.1 / 7 / Server 2008 R2 | no |

Only x64 is shipped. Server Core is expected to work (ConPTY and PowerShell are
present), but validate it before rollout. Windows 8.1 / Server 2012 R2 fail
before Pi starts with:

```text
pi.exe - Entry Point Not Found
ClosePseudoConsole could not be located in kernel32.dll
```

There is no WinPTY fallback for Pi; run the link on a supported Windows machine
or manage legacy servers through a supported jump host with PowerShell
Remoting/SSH.

## Build

```powershell
cargo build --release --manifest-path remote-client/Cargo.toml
```

The release binary is `remote-client/target/release/blackwell-link.exe`.

## Package layout

```text
blackwell-link.exe
vcruntime140.dll
pi/
  pi.exe
  package.json
  photon_rs_bg.wasm
  native/
  assets/
  theme/
  docs/
  vcruntime140.dll
```

Pi is a folder runtime, not a single file. Do not ship `pi.exe` alone; Pi needs
`package.json` and its assets/native addon.

## Trial build: no arguments

The trial build has the current gateway URL baked in. Double-click it (or run it
with no arguments):

```text
blackwell-link.exe
```

On the first run it prints the server, asks for the one-time pairing code, and
stores the resulting device token in Windows Credential Manager. Later runs use
that token and do not ask for a code. The code is generated on demand in
REMOTE → STATUS → PAIR DEVICE, is one-time, and expires after five minutes.

When the Pi folder is already present, updating the client means replacing only
`blackwell-link.exe`. The existing identity in `%LOCALAPPDATA%\BlackwellLink`
and the Pi folder stay in place.

For a different gateway or a scripted invocation:

```powershell
.\blackwell-link.exe `
  --server wss://<public-host>/agent `
  --pair <CODE> `
  --name <DEVICE-NAME> `
  --pi .\pi\pi.exe `
  --cwd C:\
```

After pairing, the identity file is under `--data-dir` (default
`%LOCALAPPDATA%\BlackwellLink`) and the token is in Windows Credential Manager.
Subsequent runs need only `--server`, `--name`, `--pi`, and `--cwd`.

Use an **absolute** `--data-dir` when you override it. The client launches Pi
through a batch wrapper that changes the working directory; a relative data dir
makes `PI_CODING_AGENT_DIR` relative to the wrong cwd and Pi starts with no
models. The client normalizes relative paths, but absolute paths are the safest
portable form.

The gateway sends `session.open` from REMOTE → DEVICES. The client launches Pi with:

```text
--tools read,powershell,edit,write
--no-extensions --no-mcp --no-skills --no-context-files
--no-prompt-templates --no-approve --no-session
```

Pi's model routes are written into a per-session `PI_CODING_AGENT_DIR`. The local
proxy is bound to `127.0.0.1`, requires a random bearer token, and only accepts
the assigned route IDs.

## Pi sessions and `/resume`

The client stores Pi sessions in a stable per-device directory:

```text
<data-dir>/pi-sessions/
```

It launches Pi with `--session-dir` and without `--no-session`, so `/resume`
lists earlier maintenance sessions. The per-session agent home still contains
the current `models.json`/`settings.json`; only the session files are shared.
Sessions created before this change were ephemeral and cannot be recovered.

Local Power Mode uses the **same** `<data-dir>/pi-sessions`, so `/resume` lists
local and remote sessions on this machine.

## Local Power Mode

```text
blackwell-link.exe --local
```

Runs Pi in the current console. Pi's `/model` lists two providers:

| selector | path |
|---|---|
| `blackwell/<engine>` | home Blackwell Ops engine, proxied over the outbound WSS |
| `cloud/<model>` | direct OpenAI-compatible endpoint, no home gateway required |

- The device must be paired (run the client once without `--local` and enter the
  code from REMOTE → STATUS). Local mode never pairs and never opens a remote
  session or PTY; it uses a **routes-only** WSS connection
  (`/agent?role=routes`) that cannot replace an active remote session.
- If home is unreachable or no engine is running, local mode starts cloud-only
  when cloud is configured. If neither is available it prints an explicit error
  and exits.
- Pi keeps full `read`, `powershell`, `edit`, `write` tools; this is the
  owner/technician mode, not the restricted Home surface. Launch is limited to
  the owner / local administrator account: membership of
  `BUILTIN\Administrators` is required (a normal UAC-filtered administrator
  console is accepted), and a standard account is refused before Pi starts.
- Pi is launched with direct inherited stdio, not ConPTY, so the console that
  started the client stays Pi's TUI. `Ctrl+C` interrupts Pi, not the launcher.
- On Pi exit the client closes the proxy/WebSocket and exits with Pi's code.
- Local Pi is written to `<data-dir>/local-pi-home/`; sessions go to the shared
  `<data-dir>/pi-sessions/`. No forensic remote session log is written.

### Cloud provider

`<data-dir>/cloud.json`:

```json
{
  "baseUrl": "https://api.example.com/v1",
  "model": "provider-model-id",
  "contextWindow": 131072,
  "vision": false
}
```

- `apiKey` may be included in the file, but the preferred storage is Windows
  Credential Manager: service **BlackwellCloud**, user **cloud-api-key**.
- `baseUrl` must be `https`; plain `http` is accepted only for a loopback test
  endpoint (`127.0.0.1`, `localhost`, `[::1]`).
- The key is never printed, never logged, and never accepted as a command-line
  argument. It is written into the per-launch `local-pi-home/models.json` for Pi,
  as the spec requires.
- Optional overrides, which never include the key:

  ```text
  --cloud-base-url <url>
  --cloud-model <model>
  --cloud-context-window <n>
  ```

### Model catalog notes

- Provider names are exactly `blackwell` and `cloud`.
- The `blackwell` provider uses one loopback base URL
  (`http://127.0.0.1:<port>/v1`); Pi's model name selects the route. The
  per-route `/r/<route-id>/v1` surface is still served for compatibility.
- The loopback proxy only accepts its random per-process bearer token and the
  route models written for this launch. Unknown models and unknown route ids
  are rejected.
- The catalog is written once at launch. Start engines **before** launching
  local mode; a changed stack needs a Pi restart (`/model` is re-read then).
- `cloud` is configured as non-reasoning (`"reasoning": false`) because the
  trial endpoint is generic OpenAI-compatible.

## Terminal input

- `Ctrl+C` — copies the current selection; with no selection it sends interrupt (`0x03`).
- `Ctrl+V` / `Shift+Insert` — pastes clipboard text into Pi (bracketed paste is honored).
- `Ctrl+Shift+C` — copies the current selection.
- `Ctrl+Shift+V` — paste fallback using the clipboard API.
- Pi launches with `--tui-mode regular` so xterm keeps a 50,000-line scrollback.

## Gateway on/off

REMOTE → STATUS has a **STOP GATEWAY / START GATEWAY** control. Stopping the
gateway closes the listener, disconnects all remote clients, and marks their
sessions exited. The device records and tokens remain; clients must be
restarted to reconnect when the gateway is turned back on. The Cloudflare
tunnel can stay up; the public endpoint returns 502 while the gateway is off.

## Forensic session logs

Every operator-started session creates an append-only JSONL file under:

```text
<app-root>/config/remote/sessions/<device-id>/<unix-seconds>-<sequence>.jsonl
```

Each line is one event: `start`, `ready`, `out`, `in`, `stop`, and `exit`.
PTY payloads are base64 so arbitrary terminal bytes survive untouched. Logging
is best-effort; a full disk or locked file does not stop the session. There is
no rotation or automatic deletion in the trial.

## Startup output

The client prints `Blackwell Link … — starting` before the Tokio runtime is
created, then flushes progress lines for identity lookup, connection, and
pairing. A multi-second gap before that first line is process loading and
Defender/AV scanning of the unsigned exe, not a Cloudflare wait.

## Trial limitations

- Single active session per device.
- No automatic reconnect after the tunnel drops; restart the client.
- No DPAPI-wrapped file fallback: the token lives in Windows Credential Manager.
- No file transfer, clipboard channel, or multi-client steering yet.
- The binary is unsigned; sign it before handing it to other admins.
- Pi's optional `fd`/`ripgrep` helpers are not bundled. Pi tries to download
  them at startup; on an offline target it prints a warning and continues. The
  PowerShell/read/edit/write tools are unaffected.
- `VCRUNTIME140.dll` is required by Pi on clean images; ship it beside `pi.exe`
  if the target does not have the VC++ redistributable.
