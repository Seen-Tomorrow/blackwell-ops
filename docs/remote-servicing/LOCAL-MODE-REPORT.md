# Local Power Mode — implementation report

Status: implementation slice complete, independently verified; owner testing pending  
Date: 2026-10-30  
Spec: [LOCAL-MODE-SPEC.md](LOCAL-MODE-SPEC.md)  
Deliverable: `tmp/blackwell-link-local.exe` (not committed, `tmp/` is gitignored)

## What was implemented

1. **Routes-only gateway request/response.** `ClientMessage::RoutesRequest` →
   `ServerMessage::Routes { routes }`, answered from `RemoteState` with no
   session record, no PTY, and no route/session side effects.
2. **Routes-only WebSocket role.** Local mode connects to
   `/agent?role=routes`. This socket can list routes and relay model calls, but it
   is not registered as the device's operator connection, so launching local Pi
   cannot replace or terminate a live remote session that uses the same device
   token. PTY/session frames on it are rejected.
3. **App-side route freshness.** A background task refreshes
   `remote.set_routes(running_routes(get_status()))` 3 s after startup and every
   5 s afterward, off the startup path. Route ids are now slot-based
   (`route_<slot+1>`) instead of filtered-enumeration-based, so starting or
   stopping an unrelated engine cannot re-point an existing session's route id
   at a different engine. Session start still refreshes routes as a fallback.
4. **Client `--local` mode.** Paired identity → routes-only WSS → home
   `blackwell/*` routes, and/or a direct `cloud/*` OpenAI-compatible endpoint.
   Pi runs in the current console via `std::process::Command` with inherited
   stdio (no ConPTY), writes `models.json` with provider names exactly
   `blackwell` and `cloud`, shares `<data-dir>/pi-sessions`, ignores
   `SessionOpen`/`SessionStop`, closes the proxy/link on Pi exit, and exits with
   Pi's code.
5. **Loopback model proxy.** Remote mode keeps its per-route
   `/r/<route-id>/v1` surface unchanged. Local mode additionally gets `/v1`
   where Pi's model name selects the route. Both require the per-process random
   bearer token; only models/routes assigned to that launch resolve.
6. **Cloud config.** `<data-dir>/cloud.json` (`baseUrl`, `model`,
   `contextWindow`, `vision`, optional `apiKey`), key fallback from Windows
   Credential Manager `BlackwellCloud` / `cloud-api-key`, https enforced except
   loopback test endpoints, key never printed or logged.

Default remote behavior is unchanged: no `--local` → the original remote
session/ConPTY/proxy flow, same startup output, same pairing behavior.

## Changed files

| File | Change |
|---|---|
| `remote/src/protocol.rs` | `ClientMessage::RoutesRequest`, `ServerMessage::Routes`, wire-shape test |
| `remote/src/state.rs` | `RemoteState::routes()` (deterministic, port-free snapshot) + ordering helper + unit test |
| `remote/src/gateway.rs` | `?role=routes` handling, `RoutesRequest` arm, refusal of session/PTY frames on routes-only sockets, marker unit test |
| `src-tauri/src/main.rs` | Background route-refresh task (3 s initial delay, 5 s interval) |
| `src-tauri/src/remote_cmds.rs` | `running_routes` is slot-id based and `pub(crate)`; new `refresh_routes` helper; `remote_session_start` reuses it |
| `remote-client/src/main.rs` | `--local` dispatch + cloud overrides, `ProxyShared` model map, model-routed `/v1` proxy surface, help text, remote loop ignores `Routes` |
| `remote-client/src/local.rs` | New: cloud config/keyring, models/settings construction, routes-only link, Pi launcher, Ctrl+C guard, 10 unit tests |
| `remote-client/tests/routes_handshake.rs` | New: standalone gateway handshake/model-proxy/no-takeover integration tests |
| `remote-client/Cargo.toml` | `Win32_System_Console` for `SetConsoleCtrlHandler` |
| `remote-client/README.md` | Local Power Mode usage, cloud config, limitations |
| `docs/remote-servicing/LOCAL-MODE-REPORT.md` | This report |

Test-only artifacts: `tmp/local-e2e/` (fake engine, fake Pi, driver script,
run logs). No app files outside these were touched; no commit was made.

## Test commands and results

All run from the repo root with the pinned toolchain.

| Command | Result |
|---|---|
| `cargo check --manifest-path remote/Cargo.toml --locked` | pass |
| `cargo test --manifest-path remote/Cargo.toml --locked` | 4 passed (protocol wire, routes snapshot ordering/session-free, routes-only marker, existing UI event contract) |
| `cargo check --manifest-path src-tauri/Cargo.toml --locked` | pass (finished clean, no warnings) |
| `cargo check --manifest-path remote-client/Cargo.toml --locked --all-targets` | pass |
| `cargo test --manifest-path remote-client/Cargo.toml --locked` | 10 unit + 3 integration passed |
| `cargo build --release --manifest-path remote-client/Cargo.toml --locked` | pass |
| `cargo build --manifest-path remote/Cargo.toml --locked --bin blackwell-gateway` | pass (used only by the test harness) |

### Standalone end-to-end harness

`pwsh -NoProfile -ExecutionPolicy Bypass -File tmp\local-e2e\run-local-e2e.ps1`

Runs a real `blackwell-gateway` on **127.0.0.1:7555** (never 7443) with a temp
data dir and a fake OpenAI-compatible engine on 127.0.0.1:8899 (the box's 8888 is
a live `llama-server`, so it was left alone), plus a fake Pi that records its
argv/env. Last run: `tmp/local-e2e/run-20261030-014722/summary.txt`, 16/16 PASS:

- standalone gateway up on 7555, route `route_1` → fake engine
- device paired through the normal remote pairing path (token in Credential Manager)
- `models.json` has exactly the `blackwell` provider with selector `blackwell/ENGINE_1`
- Pi launched with the spec args, shared `pi-sessions` store, `local-pi-home` agent dir
- proxy rejects requests without the random bearer token (401)
- proxy lists the assigned route model for the bearer token
- `blackwell/ENGINE_1` request reached the engine through WSS + loopback proxy
- proxy rejects a model that was not assigned to this launch (404)
- per-route surface accepts only assigned route ids (`/r/route_1` 200, `/r/route_9` 404)
- gateway shows zero active sessions and no forensic session record while local Pi runs
- local client exited with Pi (code 0) and closed the link
- cloud-only mode starts Pi with provider `cloud/fake-cloud-model` and never logs the key
- paired identity + unreachable home falls back to cloud-only
- no home and no cloud fails clearly with pairing/`cloud.json` instructions (exit 1)
- non-loopback `http` cloud baseUrl is rejected before launch; key never printed
- remote CLI surface unchanged: `--server`/`--pair` still documented, unknown args still exit 2

Deliverable hash at the time of this report (superseded by the admin-gate build
under "Verification update"):

```text
tmp/blackwell-link-local.exe
sha256 05E1426FDEB0864FE8554A9D1437F6F9F6186C5A5F704407B3ECE96C0F267162
size   6,877,184 bytes
```

The four test device tokens created in Windows Credential Manager by the
harness were deleted afterwards. Pre-existing credentials were not touched.

## Tested vs untested

Tested:

- `RoutesRequest` returns routes with no session record, no PTY, no forensic log;
  empty route table returns an empty list.
- A routes-only socket can relay model calls end to end (client model name →
  loopback proxy → WSS → gateway route → fake engine → streamed body back).
- Local model connect does not detach or kill an operator connection using the
  same device token.
- Provider names and `/model` selectors: exactly `blackwell/ENGINE_1` and
  `cloud/<model>`; cloud-only and blackwell-only catalogs; no-endpoint error;
  duplicate-alias ids.
- Cloud config resolution: file, CLI overrides, Credential Manager fallback,
  https/loopback validation, key never in the summary/logs/argv.
- Local Pi launch argv/env (`--tools`, `--no-approve`, `--tui-mode regular`,
  `--session-dir <data-dir>/pi-sessions`, `--name local-<COMPUTERNAME>`,
  `PI_CODING_AGENT_DIR=<data-dir>/local-pi-home`, no `--model`).
- Pi exit code propagation (fake Pi exited 0 → client exited 0).

Untested (and why):

- **Real Pi 1.4.0 TUI in local mode.** Needs an interactive console; the harness
  used a stand-in exe and real Pi was run in `--print` mode. The owner must run
  the TUI once by hand.
- **A real model request from Pi to a real cloud provider.** Pi was run against a
  local fake OpenAI-compatible endpoint; no vendor account was configured.
- **Windows Credential Manager `BlackwellCloud/cloud-api-key`.** The keyring
  branch was exercised by injecting a key into `resolve_cloud`; no real
  Credential Manager entry was written or read.
- **App live route refresh.** Would require restarting the running DEV app, which
  this task forbids. Compile-checked only; `running_routes`/`refresh_routes` are
  covered by the gateway integration test only at the protocol level.
- **Multiple engines / vision routes / duplicate aliases against a live stack.**
  Model construction is unit-tested for these shapes; no multi-engine stack was
  running.
- **Ctrl+C with a real Pi.** The console handler is installed and the fake Pi
  path is exercised, but interrupt handling is only proven manually later.
- **Remote-mode ConPTY flow.** Unchanged by inspection and by the release build;
  not re-run live (a remote session may have been active).

## Manual test steps

### Home (`blackwell/*`) — owner

Prerequisite: an engine is RUNNING in Blackwell OPS and the app is running the
**new build** so the gateway answers `RoutesRequest` and refreshes routes.

1. Pair this PC once if needed: run `blackwell-link.exe` without `--local`,
   enter the code from CONFIG → REMOTE. Identity goes to
   `%LOCALAPPDATA%\BlackwellLink\identity.json`, token to Credential Manager.
2. Start an engine and wait for RUNNING.
3. In a terminal, from the repo root:

   ```text
   tmp\blackwell-link-local.exe --local --pi tmp\blackwell-link-package\pi\pi.exe
   ```

   The build lives in `tmp\`, so the default `<exe dir>\pi\pi.exe` does not
   exist; either pass `--pi` as above or copy the exe beside a Pi package. If the
   identity was paired to a different host, add
   `--server wss://<public-host>/agent`.

4. Expected console output: `Home: gateway ready …`,
   `Home: 1 route(s) — blackwell/ENGINE_x`, `Proxy: http://127.0.0.1:<port>/v1`,
   then Pi's TUI in the same window.
5. In Pi, `/model` must list `blackwell/ENGINE_x`. Send a prompt; the running
   engine serves it and CONFIG → REMOTE shows **zero** active sessions.
6. `/resume` must list the shared `<data-dir>/pi-sessions` history.
7. Exit Pi (`/exit` or Ctrl+D) and confirm the console returns and the client
   exits with Pi's code.

### Cloud (`cloud/*`) — owner

1. Choose the provider and store the key either way:
   - `<data-dir>\cloud.json` (default data dir
     `%LOCALAPPDATA%\BlackwellLink\cloud.json`):

     ```json
     {
       "baseUrl": "https://api.example.com/v1",
       "model": "provider-model-id",
       "contextWindow": 131072,
       "vision": false
     }
     ```

   - or omit `apiKey` and store it in Windows Credential Manager as generic
     credential **BlackwellCloud** / user **cloud-api-key**.
2. Run `tmp\blackwell-link-local.exe --local --pi tmp\blackwell-link-package\pi\pi.exe`
   (add `--server` only if the identity's saved server is stale).
   - `Cloud: https://… · model …` must print.
   - `/model` must list `cloud/provider-model-id`.
   - Send a prompt; the provider's endpoint is called directly (no home gateway
     needed). No proxy line appears in cloud-only mode.
3. Combined check: with home routes available and cloud configured, `/model`
   lists both `blackwell/*` and `cloud/*` and switching works per request.
4. Cloud-only check: stop all engines (or use an unpaired data dir) and launch
   with cloud configured — it must start with only `cloud/*`.

## Owner actions / decisions

1. **Rebuild and restart the DEV app** when no remote session is active. The
   currently running DEV app (PID 106100) predates this change, so its gateway
   answers `RoutesRequest` with an "invalid client message" error; local mode
   then reports home unavailable and falls back to cloud. The new build is
   compile-checked only — this task must not restart the app.
2. **Cloud vendor + key.** Pick the OpenAI-compatible base URL, model id, and
   where the key lives (file vs Credential Manager). No vendor is hard-coded.
3. **Pi package.** Put `pi\pi.exe` beside the client or pass `--pi`.
4. **Security review of the routes-only socket.** `?role=routes` deliberately
   skips operator attachment so local mode cannot kill a live session; review
   whether that is the desired trust split.
5. Confirm the **models.json catalog is written once at launch** is acceptable;
   a changed engine stack needs a Pi restart to appear in `/model`.
6. `local-pi-home\models.json` contains the cloud key (Pi needs it). Protect the
   data dir; the alternative is to keep the key only in Credential Manager and
   accept the same file, since Pi requires it at runtime.

## Notes and limitations

- No remote `SessionOpen`, PTY, or forensic session log is created in local mode;
  Pi output stays on the local console only.
- If the WSS link drops while Pi runs, `blackwell/*` calls return
  "gateway link is closed" until Pi/client is restarted. There is no reconnect in
  this slice.
- Cloud models are declared non-reasoning (`"reasoning": false`) because the
  endpoint is generic OpenAI-compatible. Cloud vision is config-driven.
- `--pair` is ignored with a warning in local mode; pairing remains a remote-mode
  action.
- Only the `--local` path changed for local mode; the default remote path still
  uses ConPTY and the per-route proxy exactly as before.

## Verification update 2026-10-30 (owner decisions applied)

After the worker report, the owner answered the three open questions
([DECISIONS.md](DECISIONS.md) D-015…D-017). This pass added the admin gate,
tested it, and re-verified the slice with an independent harness.

### Added after the report

1. **Owner / administrator gate** (`remote-client/src/admin.rs`). `--local`
   refuses to write any file when the process token does not carry
   `BUILTIN\Administrators`, matching the SID even when UAC marks it
   `SE_GROUP_USE_FOR_DENY_ONLY`, so a normal (non-elevated) admin console works.
   Standard accounts are refused before any file is written; that refusal is
   unit tested through the injected entry point, and the positive path is
   exercised by every e2e run. `--help` and `remote-client/README.md` document
   the restriction, and the decision is recorded in the spec (acceptance 10).
2. **Route-projection and multi-route tests.** `src-tauri/src/remote_cmds.rs`
   asserts slot-keyed route ids, RUNNING-only filtering, vision/context mapping,
   and the one-token floor without a live app.
   `remote-client/tests/routes_handshake.rs` now also starts two routes against
   two fake engines and proves each model request is answered by its own engine
   (models never cross routes).
3. **Independent e2e harness** (`tmp/local-mode-test/run-e2e.mjs`): its own
   gateway on 7444, its own fake engine/cloud endpoint on 8901, and its own Pi
   stand-in. Unlike the worker harness it also runs the **real bundled
   `pi.exe`** in `--print` mode. Results, run
   `tmp/local-mode-test/run/run-2026-10-30T01-02-21`, 14/14 PASS:
   - routes-only handshake, pairing, `models.json` with exactly `blackwell` and
     `cloud`, selectors `blackwell/ENGINE_FAKE` and `cloud/fake-cloud`
   - gateway reports zero active sessions / zero online devices while local Pi
     runs; no forensic session directory is created
   - **real Pi** `-p` answered through the proxy → WSS → gateway → engine, and
     separately through the direct cloud endpoint
   - `pi --list-models` lists both providers with the expected model ids
   - Pi argv is the spec argv, `--session-dir` is the shared store, no `--model`
     pin
   - key/token never appear in client output
   - cloud-only mode with no paired identity works end-to-end with real Pi
   - no home + no cloud errors clearly with exit 1
   - **live engine**: the local proxy on 7445 → live `llama-server` on 8888
     answered a request (713-byte body)
4. **Real Pi against the real 177B engine** through local mode: `pi -p "Reply
   with exactly one word: PONG"` printed `PONG` (1–3 s across runs,
   `tmp/local-mode-test/real-pi/`). This closes the "real model request from
   real Pi" gap at the blackwell route.
5. **Cloud key from Windows Credential Manager** exercised for real: with a
   `cloud.json` that has no `apiKey`, the client read
   `cloud-api-key.BlackwellCloud`, wrote it into `models.json` for Pi, the
   request reached the endpoint, and the key never appeared in console output.
   The test credential was deleted afterwards.

### Test commands and results

| Command | Result |
|---|---|
| `cargo test --manifest-path remote-client/Cargo.toml --locked` | 13 unit + 4 integration pass (incl. admin SID matcher, standard-user refusal, two routes → two engines) |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 424 passed, 0 failed, 2 ignored (incl. 3 new route-projection tests) |
| `cargo check --manifest-path remote-client/Cargo.toml --locked --all-targets` | pass |
| `node tmp/local-mode-test/run-e2e.mjs --real-engine 8888` | 14/14 PASS, ~91 s |
| real Pi + live engine (above) | exit 0, output `PONG`, 3 s |

Deliverable rebuilt with the gate:

```text
tmp/blackwell-link-local.exe            (also copied beside the Pi package)
sha256 67E7F1E6DFC1BA943075ECFC67100A1037A1BDFF691B928922C3D23CBF4C0047
size   6,877,696 bytes
```

### Still not executed

- **Interactive Pi TUI** in local mode (owner must run it once by hand).
- **Real cloud provider** (no vendor account); only a local fake endpoint was
  used.
- **Live app route refresh** — the running DEV app hosts an active remote session
  (`Lazne-F1`) and must not be restarted while it is live; projection is now unit
  tested, the 5 s refresh loop is compile-checked only until the owner restarts.
- **Refusal for a real standard Windows account** — no such account exists on
  this box. The refusal entry point is unit tested by forcing the admin result
  to `false`: it returns the explicit error and creates no data directory.
  SAFER `/trustlevel:0x20000` keeps the deny-only admin SID, so it is not a
  negative test; a restricted admin token is still the owner's account and is
  intentionally accepted.

### Owner actions, updated

1. Rebuild/restart the DEV app when no remote session is active, then run the
   manual home test in this report.
2. Cloud: one **owner** key (D-015). Pick the OpenAI-compatible base URL and
   model id; store the key in Credential Manager (`BlackwellCloud` /
   `cloud-api-key`) or `cloud.json`.
3. Local transcripts stay local; the dashboard fetch is the next slice
   ([TRANSCRIPT-FETCH.md](TRANSCRIPT-FETCH.md)).
4. Local Pi is owner/admin only (D-017), implemented and tested for the positive
   path.
