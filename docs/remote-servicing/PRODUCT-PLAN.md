# Blackwell Remote Servicing — Product Plan

Status: draft for review  
Date: 2026-10-30  
Working names: **Blackwell Remote Servicing**, power mode, managed mode  
Related: [RustDesk emergency desktop note](RUSTDESK-EMERGENCY-DESKTOP.md)

## 1. One sentence

**A private AI technician for Windows machines: outbound-only, no RDP or
firewall changes, with approvals, a complete audit trail, and a small agent
that stays available after reboot. Family-first, Pro later.**

The product is not "remote terminal with an LLM." It is a remote servicing
system where the AI diagnoses, proposes, executes, verifies, and reports — under
a policy the owner can trust.

## 2. What the proof of concept already proves

The current implementation is a working PoC on Windows 11 and Windows Server
2022:

- portable `blackwell-link.exe`, no install, no inbound port
- one-time pairing code → per-device token in Windows Credential Manager
- outbound WSS through a Cloudflare tunnel
- Pi 1.4.0 on the target, terminal in CONFIG → REMOTE
- PowerShell tool calls with real output
- all running engines selectable as model routes
- device rename, gateway start/stop, session termination
- regular TUI mode, scrollback, Ctrl+C/paste
- Pi `/resume` with a persistent session directory
- append-only forensic JSONL session logs
- server-side gateway ON/OFF control

It also proves the hard boundary: **Server 2012 R2 cannot run Pi**, because Pi's
Bun runtime imports `ClosePseudoConsole`. The client itself can run there, but
the Pi harness cannot. That is an architectural constraint, not a packaging
detail.

## 3. Product decision

### 3.1 Primary wedge: family / home mode

Start with the family and small-home audience:

- one technically capable family member managing everyone else's PCs
- a small home office with 2–10 Windows machines
- non-technical owners who need “fix my computer,” not a terminal
- people who want a private helper without opening RDP or installing a full
  remote-support suite

Why first:

- one device and one conversation at a time — far less surface than a fleet
- the scope is intentionally narrow: diagnostics, a few fixes, restart,
  updates, files
- value is immediate and easy to explain
- every Home restriction becomes a reusable safety primitive for Pro
- the owner decided family-first; this plan follows that decision

The “less can go wrong” property is only true if Home mode is genuinely
restricted. No terminal, no raw PowerShell prompt, no unrestricted file browser,
no arbitrary command from the model. Home exposes runbooks and approved actions.
That narrow tool surface is the product, not a temporary limitation.

Family-first also means safety and consent are designed before Pro’s extra
power. Pro inherits a system that already has approvals, action classes, and
audit.

### 3.2 Secondary: technical prosumer / small MSP

Pro mode comes after Home mode proves the core loop:

- one-person MSPs
- IT generalists managing 5–100 Windows machines
- prosumers who want the terminal and full runbook control
- people who already understand PowerShell, elevation, and approvals

Pro adds:

- terminal and unrestricted PowerShell (with policy)
- multi-device groups, tags, schedules, bulk runbooks
- RBAC, audit export, API/webhooks
- self-hosted/team deployment

Pro is not “Home with more buttons.” It is a later, higher-power surface built on
the same agent, policy, and transcript core.

### 3.3 One core, two surfaces

Share:

- device identity and pairing
- target agent
- transport and gateway
- model orchestration
- runbook/tool policy
- audit and file transfer

Differentiate:

- **Pro mode:** terminal, PowerShell, multi-device, RBAC, schedules, API
- **Home mode:** chat, task cards, approvals, plain-language reports

## 4. Product principles

1. **Outbound-only by default.** No inbound ports, no RDP enablement, no
   domain-account requirement.
2. **Always available.** A service, not a console. Survives reboot, logoff, and
   network changes.
3. **Consent is visible.** The target owner can see an active session and stop
   it. Family mode requires explicit approval for mutations.
4. **Least privilege.** Standard user by default; elevation is a deliberate,
   audited step.
5. **Every mutation is auditable.** Command, output, approval, actor, timestamp,
   result, rollback information.
6. **AI proposes, policy decides.** The model is never the final authority on a
   destructive action.
7. **Small target footprint.** The target should not need Bun, a browser, or a
   desktop runtime to be serviceable.
8. **Recoverable.** Reconnect, resume, reboot-and-continue, rollback, kill
   switch.
9. **Private by default.** Local models are a first-class option; data retention
   is explicit.
10. **No remote desktop in this product.** It is a separate, high-risk feature.

## 5. Target architecture

### 5.1 Current PoC

```text
Windows target
  blackwell-link.exe (portable console)
    ├─ Pi 1.4.0 + PowerShell tool
    └─ local OpenAI proxy
          │ outbound WSS
          ▼
Blackwell host
  gateway (inside Tauri app)
    ├─ device/session registry
    ├─ model routes → local llama engines
    └─ CONFIG → REMOTE UI

Public edge: Cloudflare quick tunnel → 127.0.0.1:7443
```

Strengths: proves the entire loop, minimal server changes, Pi agent behavior is
mature.

Weaknesses: target carries Bun + Pi; requires ConPTY; no service/auto-start;
no auto-reconnect; a TUI is required even for simple fixes; large client; hard
to support legacy Windows.

### 5.2 Product architecture: thin agent + DeepSeek Harness

```text
Windows target
  blackwell-agent (Windows service, small Rust binary)
    ├─ tool executor: powershell, files, services, processes, events, registry,
    │                 reboot, upload/download
    ├─ consent/tray helper (interactive session)
    ├─ device identity + signed auto-update
    └─ local audit buffer
          │ outbound WSS (mutual device auth, E2E payload)
          ▼
Blackwell control plane
  Blackwell Home/Pro UI
    │ local API / DSH SDK
    ▼
  DeepSeek Harness runtime (server-side, pinned)
    ├─ agent loop, model adapters, session log, tools, guards
    ├─ blackwell-remote-servicing plugin
    │    ├─ device registry + pairing
    │    ├─ remote tool definitions + streaming
    │    ├─ action classes + approval policy
    │    └─ runbook/skill package
    ├─ local Blackwell model engines (default)
    └─ optional cloud fallback
```

Key decisions:

1. **Move the agent loop off the target.** The target becomes a capability
   executor. This supports legacy Windows, shrinks the target footprint, and
   keeps prompts/tools/policy centrally updatable.
2. **Use DeepSeek Harness as the server-side orchestrator.** DSH already owns
   the agent loop, tools, sessions, approvals/guards, subagents, workflows,
   skills, and a UI. Rebuilding those would be waste. The detailed evaluation
   and integration shape are in
   [DSH-ORCHESTRATOR.md](DSH-ORCHESTRATOR.md).
3. **Do not expose DSH's host-local tools.** The default coding profile has
   shell, filesystem, browser, and computer-use tools. The product profile must
   expose only remote-servicing tools, curated skills, and read-only context.
4. **Pi-on-target remains Power Mode.** It is useful for the current PoC and
   for technical Pro users on supported Windows; it is not the Home runtime.

DSH is contained behind a Blackwell `RemoteServicingRuntime` adapter: pinned
version, fixed sidecar/container, no runtime plugin installs, and no DSH types
in the UI or database. Blackwell owns the canonical device/incident/approval/
transcript model. A Pi-server-side or deterministic-runbook fallback remains a
credible exit. The containment rules and decision gate are in
[DSH-ORCHESTRATOR.md](DSH-ORCHESTRATOR.md#containment-and-exit-strategy).

### 5.3 DeepSeek Harness runtime

DSH is an **everything-is-a-plugin** agent harness built on Cordis. It can run
server-side as a pinned Node application, with a Web UI, headless profile, SDK
JSON-RPC profile, and API gateway. Relevant pieces:

- `ctx.tools` — register remote-servicing tools as model-facing capabilities
- `tools/pre-execute` — approval/guard waterfall before a mutation runs
- session log — durable transcript, resume, and audit
- subagents/workflows/skills — later fleet/bulk runbooks
- model adapters — point at local Blackwell engines and optional cloud
- API gateway / SDK — drive DSH from the Blackwell Home/Pro UI
- plugin bundles/profiles — compose a restricted product profile

Constraints:

- DSH is a **developer preview**; APIs and session formats can break. Pin an
  exact version and own the upgrade process.
- DSH is large and Node-based; acceptable server-side, not on the target.
- The default profile is a coding agent with host-local shell/filesystem
  access. The product profile must be a curated, restricted composition, not
  the default `web` profile with extra tools.
- Do not enable runtime plugin installation/self-modification for end users.
- Use DSH's session log as the canonical conversation record; add Blackwell
  device/approval metadata and export rather than relying on DSH internals.

### 5.4 Target tool protocol

JSON-RPC-style over the existing outbound WSS, with request IDs and streaming
output:

- `system.info`
- `exec` (PowerShell/cmd with timeout, working directory, env allowlist)
- `file.read`, `file.write`, `file.list`, `file.hash`, `file.upload`,
  `file.download`
- `service.list`, `service.start`, `service.stop`, `service.restart`
- `process.list`, `process.kill`
- `eventlog.query`
- `registry.read`, `registry.write` (Pro only, approval-gated)
- `reboot`, `shutdown`, `power.status`
- `agent.update`, `agent.logs`

Properties:

- every call has a deadline and cancellation
- every mutation is classified (`read`, `low`, `high`, `critical`)
- output is streamed and capped
- binary/file transfers are chunked and hashed
- no arbitrary shell in Home mode; only runbook-declared commands

### 5.5 Hosting and transport

- Named Cloudflare tunnel with a stable hostname; no client pinned to a quick
  tunnel URL.
- Gateway remains loopback-only on Blackwell; Cloudflare is the public edge.
- Target always connects outbound 443.
- Device authentication: pairing code → device key/token; long-term token in
  Credential Manager/DPAPI.
- Prefer per-device mutual authentication and payload encryption end-to-end;
  the gateway should not need plaintext command contents.
- Gateway start/stop control stays; stopping closes all device connections.

### 5.6 Model/runtime

- DSH model adapters point at local Blackwell engines by default: private, no
  per-token cost.
- Cloud fallback is optional and policy-controlled.
- Model router chooses by task: fast triage vs deep reasoning.
- Per-session token/time budget.
- Prompts, tools, and runbooks are versioned with the DSH profile, not edited
  per machine.
- Tool results are structured; no screen scraping of terminal output for logic.

### 5.7 Local Pi / on-machine mode

The product should not make the AI only reachable from a remote operator. A user
sitting at the machine should be able to open the same Pi harness locally, with
the same Blackwell Link identity and model access:

- a tray/shortcut **“Open Pi”** (Power Mode) on supported Windows
- Pi runs locally in a console; no remote operator and no target-side DSH
- **Blackwell Link is still used for model routing**: the local client connects
  to the home gateway, fetches the current model routes, and proxies Pi's
  `blackwell/*` model calls through the outbound WSS. It does not open a remote
  PTY/session.
- **direct cloud is a second provider**: `cloud/<model>` uses an
  OpenAI-compatible endpoint and key configured on the machine. It goes
  directly from the laptop/PC to the provider; no home gateway required.
- the user selects at runtime with Pi's `/model`:
  - `blackwell/ENGINE_1` — home Blackwell LLM
  - `cloud/<model>` — cloud provider
- if home is unreachable, `cloud/*` still works; if cloud is not configured,
  `blackwell/*` is the only route; if neither is reachable, Pi starts but says
  the model is unavailable and exits the request cleanly.
- the local launcher uses the same persistent `pi-sessions` store, so a remote
  operator can `/resume` a locally started session and vice versa.
- local tools are the same read/PowerShell/edit/write surface; this is the
  owner/technician mode, not the restricted Home surface.

This is **Power Mode**, not the Home flow. It gives the product a credible
offline/nearline story: the person at the console can use home Blackwell models
or cloud, with or without a remote operator.

Implementation implications:

- gateway needs a routes-only request/response (or authenticated HTTP route
  endpoint) so local mode can fetch model routes without opening a remote
  session
- local client writes a models.json with both `blackwell` and `cloud` providers;
  cloud key comes from Credential Manager or a local config, never logs
- Pi `/model` is the selector; no custom model picker needed for the PoC
- local mode is a separate launcher path from remote session supervision

## 6. Release plan

Estimates assume one experienced developer plus AI assistance; they are
planning ranges, not commitments.

### Phase 0 — Foundations and DSH spike (3–5 weeks)

Goal: prove the product architecture before building the Home UI.

Deliverables:

- pin an exact DSH version; run a restricted server-side profile
- one custom DSH tool that can call a paired Windows agent
- thin Windows agent service spike: read-only system info, services, events
- service/boot start and automatic reconnect
- stable named Cloudflare endpoint
- signed agent installer and updater
- action-class/approval design and a consent/kill-switch surface
- DSH session transcript viewer/export
- per-tool deadline and cancellation
- clean Windows 11 + Server 2022 test; read-only thin-agent test on 2012 R2

Exit criteria:

- DSH opens a session and runs a read-only tool on two different target devices
- reboot → agent service returns → device online without human action
- gateway restart → reconnect works
- DSH profile exposes no Blackwell-host shell/filesystem/browser tools
- every DSH session has a transcript with tool results
- no unhandled panic on unsupported Windows

### Phase 1 — Home alpha/beta (6–10 weeks)

Goal: a terminal-free experience for non-technical owners, built on DSH + the
thin agent.

Deliverables:

- one-click installer/link; pairing in under 2 minutes
- Home UI: chat, plan, task cards, plain-language reports
- consent per session and per action; visible activity indicator
- 5–10 safe runbooks: disk cleanup, updates, printer, performance, startup
  apps, browser/network checks
- read-only and assisted modes; no raw terminal
- file/photos/log handoff and support-bundle export
- remote restart and reconnect
- local Blackwell models by default; cloud off unless enabled
- DSH session transcript exposed as a simple “what I did” report

Exit criteria:

- a non-technical tester completes a real fix without a terminal
- all mutations approved; reversible where possible
- install → pair → first successful diagnosis in under 5 minutes
- no support call required to install/pair
- zero unapproved destructive actions

### Phase 2 — Pro beta (6–8 weeks)

Goal: the technical surface, built on the same core after Home proves the loop.

Deliverables:

- Pro UI: device list, groups/tags, search, version, session history
- terminal / full PowerShell with action policy
- local “Open Pi” Power Mode on the target, sharing the persistent session store
- remote/local session handoff through `/resume`
- read-only / assisted / autopilot modes
- 10–20 curated runbooks (disk, updates, services, events, performance, backup,
  security baseline)
- multi-user basics: owner/technician/viewer, invitations
- audit export (JSONL/CSV/PDF)
- schedules and bulk actions (may slip to Phase 3)
- legacy Windows 2012 R2 read-only diagnostics via thin agent
- local model routing and per-session budget

Exit criteria:

- 5 design partners use it on real machines for a week
- median time-to-diagnosis and time-to-fix measured
- zero unapproved destructive actions
- 100% of sessions have an auditable transcript

### Phase 3 — MSP / fleet (12–24 weeks)

Deliverables:

- multi-tenant workspaces, RBAC, SSO
- bulk runbooks, schedules, maintenance windows
- alerts, health checks, inventory, patch visibility
- API/webhooks and PSA/RMM export
- self-hosted deployment option
- legacy Windows tier (2012 R2 via the thin agent)

### Phase 4 — Platform (later)

- macOS/Linux agents
- software deployment, patch management, backup integration
- runbook marketplace
- optional remote desktop companion (RustDesk link, not built-in pixels)

## 7. Feature backlog

Priority: P0 = required for beta, P1 = next, P2 = later.

| Area | Feature | Priority | Notes |
|---|---|---|---|
| Availability | Windows service, boot start | P0 | Always-on requirement |
| Availability | Auto-reconnect/backoff | P0 | Client and gateway restarts |
| Availability | Stable named tunnel | P0 | No quick-tunnel coupling |
| Trust | Consent indicator + kill switch | P0 | Target owner control |
| Trust | Approval policy by action class | P0 | Read/low/high/critical |
| Trust | Signed installer/updater | P0 | Also fixes AV startup delay |
| Audit | Transcript viewer/export | P0 | DSH session log + Blackwell metadata |
| Safety | Per-tool timeout/cancel | P0 | GUI hang class |
| UX | Home chat + plan + approve | P0 | First product surface |
| UX | No terminal/raw shell in Home | P0 | Restricted tool surface |
| Ops | Home runbook library (5–10) | P0 | Safe deterministic fixes |
| Reliability | Reboot-and-continue | P1 | Service required |
| Files | Upload/download/support bundle | P1 | Hash/chunk |
| UX | Pro terminal + PowerShell | P1 | After Home beta |
| UX | Local “Open Pi” Power Mode | P1 | On-machine access; shared `/resume` store |
| UX | Home task cards/plain-language report | P1 | Non-technical UX |
| Ops | Device groups/tags/search | P2 | Pro/fleet |
| Ops | Schedules/maintenance windows | P2 | MSP |
| Ops | Alerts/health checks | P2 | MSP |
| Identity | Multi-user/RBAC/SSO | P2 | Pro/MSP |
| Platform | Thin agent protocol | P0 | Home needs it |
| Platform | DSH restricted profile + plugin | P0 | Server orchestrator |
| Platform | Local model routing | P1 | Differentiator |
| Platform | macOS/Linux | P2 | Later |

## 8. UX shape

### Home mode (first)

- “What’s wrong?” chat and a small set of big actions
- “Check my PC” produces a plain-language report
- “Free up space”, “Install updates”, “Fix printer”, “Restart”
- approve/deny each change; show exactly what will happen
- remote restart and reconnect status
- share files/photos/logs with the helper
- no terminal, no PowerShell syntax, no model/provider jargon
- a single “what I did” report after each action

### Pro mode (later)

- device list with groups, tags, online/offline, OS, version, last seen
- click device → chat/plan/approve, terminal, files, logs, history
- “Open Pi locally” on the target; local and remote sessions share `/resume`
- runbook library; “run on selected devices”
- approvals queue; change log; export
- session transcript with timestamps, commands, outputs, approvals

## 9. Security and trust model

### Identity

- Pairing code is one-time and short-lived.
- Device gets a per-device key/token; token stored in Credential Manager/DPAPI.
- Server stores hashes, never plaintext tokens.
- Revocation is immediate; stolen device can be cut off.
- Consider per-device mutual TLS/Noise; gateway relays encrypted payloads.

### Authorization

- Session open requires an authenticated operator and an online device.
- Destructive actions require an approval policy:
  - read-only: no mutations
  - assisted: per-action approval
  - autopilot: runbook allowlist + rollback
- Family mode defaults to assisted; Pro defaults to read-only + explicit elevate.
- No silent SYSTEM execution. Elevation is a visible, audited step.

### Audit

- Append-only JSONL per session: actor, device, command, args, output hash,
  approval, result, timestamp.
- Export for clients/compliance.
- Retention policy; redact secrets.
- Tamper-evident chain/hash for Pro (later).

### Supply chain

- Code-sign agent and installer.
- Signed auto-update manifests.
- Pin dependencies; reproducible builds.
- SBOM and vulnerability response.

### Abuse resistance

- Rate limits on pairing and sessions.
- Device-side visible session banner.
- Kill switch and remote revoke.
- No inbound listener on target.
- Runbooks deny destructive commands unless explicitly allowed.

## 10. Data and logs

Per device/session:

- session metadata: device, operator, profile, start/end, model, routes
- transcript events: user/assistant/tool/approval/result
- raw terminal bytes if Power Mode
- file/artifact manifests with hashes
- policy decisions and elevation events

Storage:

- Blackwell host under `config/remote/` for the trial
- Product: database + object storage for artifacts; retention per plan
- Home: shorter default retention; Pro: configurable/exportable

Never log secrets by default; redact common credential patterns. Warn that
Power Mode input is logged.

## 11. Metrics

Activation and reliability:

- install → pair → first successful session time
- device online rate
- reconnect success after reboot/network loss
- tool-call timeout/cancel rate

Outcome:

- time to diagnosis
- time to fix
- first-contact resolution
- approval rate / rejection rate
- rollback rate
- repeat issue rate

Safety:

- unapproved destructive actions (target: zero)
- audit completeness
- consent display coverage
- revoked device propagation time

Business:

- weekly active devices
- sessions per device
- design-partner retention
- support tickets per 100 sessions

## 12. Risks

| Risk | Mitigation |
|---|---|
| Remote-access tool used maliciously | consent, approvals, audit, revocation, signing, rate limits |
| Model makes destructive mistake | action classes, runbook allowlists, dry-run, rollback, no raw shell in Home |
| Cloudflare/quick-tunnel dependency | named tunnel, stable hostname, health checks, self-host option |
| Windows diversity (2012 R2, Server Core, domain policy) | thin agent, explicit support tiers, test matrix, fail-closed |
| Target agent compromise | least privilege, signed updates, no secrets in memory/logs, kill switch |
| Bun/ConPTY limits | thin agent; Power Mode only on supported Windows |
| DSH developer-preview breakage | pin exact version; restricted profile; deliberate upgrades |
| DSH host-local tools reachable by model | disable shell/fs/browser/computer-use; curated profile; sandbox |
| DSH plugin supply chain | curated bundle; no runtime plugin install; signed inputs |
| Support burden | runbooks, diagnostics bundles, logs, staged rollout |
| Unit economics of local models | model routing, budgets, local-first |
| Competition (RustDesk, MeshCentral, ScreenConnect) | AI execution + safety + audit, not screen sharing |

## 13. Open decisions

Decided:

- **First audience:** family/Home first, Pro second.
- **Server orchestrator:** DeepSeek Harness, pinned and restricted.
- **Target runtime:** thin Windows service agent; Power Mode secondary.
- **Power Mode:** keep it. On-machine users get local Pi; supported Windows only.
- **Local Pi routing:** Blackwell Link home models or direct cloud, selected with
  Pi `/model`.

Still open:

1. **Home UI shell:** Blackwell Tauri chat UI vs a Home-specific DSH Web
   profile. Recommendation: Blackwell UI for family; DSH Web for internal/Pro.
2. **DSH integration:** SDK JSON-RPC vs API gateway vs embedding DSH Web. The
   spike should choose based on session/tool streaming requirements.
3. **Power Mode cloud vendor:** which OpenAI-compatible vendor and model. Keys
   are **per owner** (D-015); the vendor is still open. Home Blackwell + direct
   cloud is decided.
4. **Local Pi privacy:** local-only transcript by default; the Blackwell
   dashboard may fetch a chosen session **on demand** (D-016, design in
   [TRANSCRIPT-FETCH.md](TRANSCRIPT-FETCH.md)). No automatic upload.
5. **Hosting:** SaaS-first, self-hosted-first, or both?
6. **E2E:** gateway-relayed plaintext vs payload encryption; affects audit and
   support.
7. **Windows floor:** Tier 1 Win10 1809+/Server 2019+; Tier 2 legacy via thin
   agent; do not promise Windows 7.
8. **Consent model for Home:** per session vs per action; default assisted.
9. **Data retention:** default days for Home; export/retention for Pro.
10. **Pricing:** free Home tier vs paid Pro per device; self-host license.

## 14. Immediate next tasks

1. Pin a DSH version and run the restricted server-side profile on Blackwell.
2. Build one DSH tool that calls a paired Windows agent for read-only system info.
3. Spike Windows service + auto-start + reconnect on a clean VM.
4. Write the thin-agent tool protocol spec (one page, versioned).
5. Move to a named Cloudflare tunnel and document the stable endpoint.
6. Design the approval/action-class model before adding mutations.
7. Add transcript viewer/export over DSH sessions.
8. Add signed installer/updater and a rollback path.
9. Build one legacy Windows 2012 R2 read-only diagnostic through the thin agent.
10. Define local Pi launcher, model endpoint, and shared `/resume` handoff —
    **implemented** ([LOCAL-MODE-REPORT.md](LOCAL-MODE-REPORT.md)); owner/admin
    only (D-017).
11. Select 5 family design partners and define success metrics.
12. Security review of pairing, token storage, DSH profile isolation, and audit.

## 15. Definition of done for the first Home beta

- clean Windows 11 install, pair in under 5 minutes, no inbound port
- service returns after reboot; device reconnects without a human
- a read-only diagnostic and one approved fix complete end to end
- a non-technical tester completes it without a terminal
- transcript is visible, exportable, and contains every action
- target owner can see and stop the session
- DSH profile exposes no Blackwell-host shell/filesystem/browser tools
- zero unapproved destructive actions
- signed binary and updater; uninstall is clean

The PoC has earned the right to become a product. The next job is not more
features; it is making the existing loop **safe enough to give to a family
member**, and provable afterward.
