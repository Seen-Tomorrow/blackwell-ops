# Local Power Mode — implementation spec

Status: implementation slice  
Owner: next worker  
Related: [PRODUCT-PLAN.md](PRODUCT-PLAN.md), [DECISIONS.md](DECISIONS.md), [HANDOFF.md](HANDOFF.md)

## Goal

A user sitting at the Windows machine can launch Pi locally with:

- **home Blackwell models** through Blackwell Link (`blackwell/*`), or
- **a direct cloud provider** (`cloud/*`),

selectable with Pi `/model`, without opening a remote PTY/session.

## Non-goals

- DSH integration
- Home UI
- thin agent service
- remote desktop
- automatic transcript upload
- multi-user/RBAC

## Owner decisions (2026-10-30)

These answers close the three questions left open in the first handoff:

1. **Cloud keys are per owner.** One key per owner account, held by the owner
   and used on the owner's machines. The machine keeps its copy in Windows
   Credential Manager (`BlackwellCloud` / `cloud-api-key`) or `cloud.json`; keys
   are never minted per device and never printed. The provider stays
   OpenAI-compatible until the owner names a vendor.
2. **Local transcripts are fetched on demand, never uploaded automatically.**
   The dashboard pull ("fetch them home for review") is the only upload path.
   Local mode must keep writing sessions only to the local `pi-sessions`
   directory until that pull path exists.
3. **Local Pi is owner / local-administrator only.** Home PCs are single-user
   administrator machines, so the account is the boundary. Local mode checks for
   membership of `BUILTIN\Administrators` (including a UAC-filtered token, so a
   normal non-elevated admin console works) and refuses to launch for a standard
   user with a clear message. Family users get Home mode.

## UX

```text
blackwell-link.exe --local
```

- If a paired identity exists, use it to fetch home model routes.
- If home is unreachable, continue in cloud-only mode if cloud is configured.
- If neither home nor cloud is available, print a clear error and exit.
- Launch Pi in the current console; the client stays alive to serve the
  Blackwell model proxy while Pi runs.
- Pi's `/model` lists:
  - `blackwell/<engine>` for each running engine route
  - `cloud/<model>` when cloud is configured
- Local Pi has full read/PowerShell/edit/write tools.
- Persistent sessions use the same `<data-dir>/pi-sessions` as remote Power Mode.
- On Pi exit, close the proxy/WebSocket and exit with Pi's code.

## Gateway changes

### Routes-only handshake

Add protocol messages:

```rust
// ClientMessage
RoutesRequest

// ServerMessage
Routes { routes: Vec<ModelRoute> }
```

- Gateway handles `RoutesRequest` by returning the current route list from
  `RemoteState` without creating a session.
- No PTY, no session record, no task/approval.
- If no routes, return an empty list; client falls back to cloud.

### Route freshness

Currently routes are populated only by `remote_session_start`. Local mode needs
them before a session. Add an app-side background refresh:

- every few seconds, or on stack changes, read `stack.get_status()` and call
  `remote.set_routes(running_routes(...))`.
- Do not disturb active sessions; routes are used for model calls only.
- Keep the existing start-session refresh as a fallback.

Alternative acceptable: a gateway HTTP `GET /routes` backed by the same state,
but the WSS message fits the existing client and is preferred.

## Client local mode

### Parse

Add `--local` flag. Optional overrides:

```text
--cloud-base-url <url>
--cloud-model <model>
--cloud-context-window <n>
```

Do not accept an API key on the command line (process list leak). Use the cloud
config/keyring.

### Identity and connection

- Load identity/token; if present, connect WSS and request routes.
- If no identity or home connection fails:
  - if cloud config is complete, start Pi cloud-only;
  - otherwise error with instructions to pair and/or configure cloud.
- Local mode must not create a remote `SessionOpen` and must not accept
  `SessionOpen`/`SessionStop` as an operator session. If the server sends one,
  ignore it or reject it; local Pi is owned by the local user.
- Keep the 15 s heartbeat while connected.

### Models file

Create a local Pi home, e.g. `<data-dir>/local-pi-home/`, and write
`models.json` / `settings.json`:

- `blackwell` provider:
  - `api: "openai-completions"`
  - `baseUrl: http://127.0.0.1:<proxy-port>/r/<route-id>/v1`
  - `apiKey: <random proxy token>`
  - one model per route; use route model/label/context/vision.
- `cloud` provider:
  - `api: "openai-completions"`
  - `baseUrl`, `apiKey` from config/keyring
  - one model from config
- `defaultProvider`:
  - `blackwell` if routes exist
  - otherwise `cloud`
- `defaultModel`: first route model or cloud model.
- `settings.defaultTools`: `read`, `powershell`, `edit`, `write`.

The Blackwell provider's proxy must only accept assigned route IDs and its
random bearer token. Cloud calls go directly from Pi to the provider; no proxy.

### Pi launch

- Use direct `std::process::Command` with inherited stdio, not ConPTY; the local
  user already has a real console.
- Args:
  - `--model <provider>/<model>` only when a single provider is available?
    Prefer no `--model` and let settings default; then `/model` can switch.
  - `--tools read,powershell,edit,write`
  - `--no-extensions --no-mcp --no-skills --no-context-files`
  - `--no-prompt-templates --no-approve`
  - `--session-dir <data-dir>/pi-sessions`
  - `--thinking medium --tui-mode regular`
  - `--name "local-<COMPUTERNAME>"`
- Set `PI_CODING_AGENT_DIR` to the local Pi home.
- Wait for Pi; when it exits, shut down WSS/proxy and exit.
- Do not write Pi output to the forensic remote session logs; local mode is
  local-only.

### Cloud config

Minimum viable config file `<data-dir>/cloud.json`:

```json
{
  "baseUrl": "https://api.example.com/v1",
  "model": "provider-model-id",
  "contextWindow": 131072,
  "vision": false,
  "apiKey": "..."
}
```

- If `apiKey` is absent, read from Windows Credential Manager under
  `BlackwellCloud` / `cloud-api-key`.
- Never print the key; never put it in logs.
- Validate baseUrl is https (allow http only for localhost testing).
- Clear error if config incomplete.

The owner will choose the actual provider later; keep the code generic.

## Files likely touched

- `remote/src/protocol.rs` — routes request/response
- `remote/src/state.rs` — route response helper if needed
- `remote/src/gateway.rs` — handle `RoutesRequest`
- `src-tauri/src/main.rs` — route refresh task
- `remote-client/src/main.rs` — `--local`, local Pi launcher, cloud config, proxy
- `remote-client/README.md` — usage
- possibly `src-tauri/src/remote_cmds.rs` for a route refresh helper

## Acceptance

1. `cargo check --manifest-path remote/Cargo.toml --locked` passes.
2. `cargo check --manifest-path src-tauri/Cargo.toml --locked` passes.
3. `cargo build --release --manifest-path remote-client/Cargo.toml --locked`
   passes.
4. Unit test: local models JSON with two providers is valid and `/model` naming
   is exactly `blackwell/<engine>` and `cloud/<model>`.
5. Standalone gateway test: `RoutesRequest` returns the current routes without
   a session.
6. With a fake/real OpenAI-compatible endpoint, cloud-only Pi starts and can
   list/send a model request.
7. With a live gateway route, `blackwell/<engine>` is selectable and a request
   reaches the engine through the proxy.
8. Default `blackwell-link.exe` remote behavior is unchanged.
9. No app restart/kill and no overwrite of a running client exe.
10. A standard (non-administrator) account is refused before Pi starts; an
    administrator account, elevated or not, is accepted.

## Deliverable

Build a new `tmp/blackwell-link-local.exe` (or equivalent) for owner testing.
Leave a report with:

- changed files
- exact test commands/results
- what is tested vs untested
- manual test steps for home and cloud
- any config the owner must provide
