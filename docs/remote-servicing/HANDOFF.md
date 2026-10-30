# Session handoff

Date: 2026-10-30  
Purpose: continue autonomously without the full conversation context.

## Current state

- Blackwell OPS DEV app is running as PID **106100**
  (`src-tauri/target/debug/blackwell-ops.exe`).
- Gateway is listening on `127.0.0.1:7443`; public quick tunnel is live.
- At least one remote device/session may be active (`Lazne-F1`). **Do not kill
  or restart the app** while a remote session is active.
- The current working tree is uncommitted and contains the remote-servicing PoC
  changes. Do not revert unrelated modifications.
- `tmp/blackwell-link-remote.exe` is the latest client build with startup
  output, regular TUI, Ctrl+C/paste, stop acknowledgement, and persistent
  `/resume` sessions. `tmp/blackwell-link-package/blackwell-link.exe` may be an
  older copy; do not overwrite it while a client is running.

## Already decided

See [DECISIONS.md](DECISIONS.md) and [PRODUCT-PLAN.md](PRODUCT-PLAN.md).

Key points:

- Family/Home first, Pro second.
- Thin Windows service agent is the product target runtime.
- DSH is the server-side orchestrator for managed mode, but pinned, contained,
  and replaceable.
- Power Mode stays: remote Pi and local on-machine Pi.
- Local Pi must use **Blackwell Link home models or a direct cloud provider**,
  selectable with Pi `/model`.
- Home mode is restricted: no terminal, no raw shell.
- No remote desktop.

## Current implementation slice

**Local Power Mode is implemented**; see
[LOCAL-MODE-REPORT.md](LOCAL-MODE-REPORT.md) and
[LOCAL-MODE-SPEC.md](LOCAL-MODE-SPEC.md).

- Gateway routes-only handshake and `/agent?role=routes`
- app route-refresh task
- client `--local` with `blackwell/*` and `cloud/*`
- local Pi direct console launch, shared `pi-sessions`
- cloud config/keyring, https guard, key non-leakage
- owner/administrator gate for `--local` (D-017)
- 16/16 worker e2e + 14/14 independent e2e; real Pi against the live engine
  answered `PONG`

Verification detail: [LOCAL-MODE-REPORT.md](LOCAL-MODE-REPORT.md)
("Verification update"). Current build:
`tmp/blackwell-link-local.exe`, sha256
`67E7F1E6DFC1BA943075ECFC67100A1037A1BDFF691B928922C3D23CBF4C0047`.

Owner action: the running app (PID 106100) is the old build. It must be
rebuilt/restarted when no remote session is active, then local mode can fetch
home routes. Until then it runs cloud-only (or reports no endpoint if cloud is
not configured). Do not restart while `Lazne-F1` is live.

The local build is also copied to
`tmp/blackwell-link-package/blackwell-link-local.exe`, beside the Pi package, so
it can be tested without `--pi`.

Next after local-mode owner testing: the on-demand transcript fetch designed in
[TRANSCRIPT-FETCH.md](TRANSCRIPT-FETCH.md). DSH Phase 0 stays after that gate.

## Guardrails for the worker

- Never kill/restart `blackwell-ops.exe`; it may be serving a live session.
- Do not overwrite a running remote client’s exe. Build to
  `tmp/blackwell-link-local.exe` (new file) for testing.
- Use `cargo check/build --locked`; do not run the full app test suite unless
  needed.
- Do not commit; leave a concise report with changed files, test commands, and
  anything the owner must do.
- Do not start a second Blackwell OPS/gateway on 7443. Use a separate port for a
  standalone gateway test.
- Keep remote-mode behavior byte-compatible where possible; local mode must be
  opt-in via `--local`.

## Testing without the owner

- Unit-test model/config construction.
- Use a standalone gateway on a spare port and a temporary client data dir for
  the routes handshake.
- Cloud can be tested against a local fake OpenAI-compatible endpoint if time
  allows; otherwise document the manual steps and leave a known limitation.
- Do not depend on the owner’s current live remote session for tests.

## Open owner decisions

Resolved 2026-10-30 (see [DECISIONS.md](DECISIONS.md) D-015…D-017):

- Cloud keys are **per owner**; the machine stores the owner's key in
  Credential Manager (or `cloud.json`).
- Local transcripts are **local-only**; the Blackwell dashboard may fetch a
  session **on demand**. No automatic upload.
- Local Pi launch is **owner / local administrator only**.

## Next after local mode

DSH Phase 0 spike: pinned DSH version, restricted profile, one remote tool,
tool/approval transcript, decision gate. Do not start the Home UI before that
gate.
