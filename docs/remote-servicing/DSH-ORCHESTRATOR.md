# DeepSeek Harness as the server-side orchestrator

Status: evaluation / architecture decision note  
Decision: **use DeepSeek Harness (DSH) as the server-side agent runtime** for
Blackwell Remote Servicing. Keep the Windows target thin. Do not run DSH or Pi
on the target for the product path.

Official sources:

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- [Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [API Gateway](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/api-gateway.md)
- [SDK](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sdk)
- [Web UI guide](https://github.com/deepseek-ai/deepseek-harness/tree/master/docs/user/guide)

## Dogfooding

This Blackwell planning session is itself running in the DSH Web GUI. The
server-side servicing runtime can therefore be developed and exercised in the
same harness the operator already uses, then shipped as a pinned product
profile with a restricted tool set.

## What DSH is

DSH is DeepSeek's open-source agent harness, built on Cordis and an
**everything-is-a-plugin** architecture. The model, tool registry, session log,
agent loop, subagents, workflows, UI, and host services are plugins. A running
DSH is a composed profile of bundles and patches.

Relevant properties for Blackwell:

- **Server-side runtime.** DSH runs on Node.js (>=24.9 for the repository) and
  ships a Web UI, a headless profile, an SDK profile, and an API gateway. It can
  live entirely on the Blackwell host.
- **Tool seam.** New model-facing capabilities register on `ctx.tools`; a
  custom tool can call a remote Windows agent instead of the local machine.
- **Session log.** DSH persists an append-only session event log, including
  model-visible inputs and tool results. That is a strong base for transcript,
  resume, and audit.
- **Approval and policy seams.** `tools/pre-execute`, `tools/execute`,
  `agent/*` events, guards, and the interaction plugins provide places to
  require approval and to classify actions.
- **Subagents/workflows/skills.** Useful later for multi-device or multi-step
  runbooks; not required for the first Home release.
- **MIT license.** Good fit for a product; retain notices.
- **Developer preview.** The official README warns of compatibility-breaking
  changes. Pin an exact version and isolate upgrades.

## Why it fits Blackwell

The current PoC runs Pi on the target. That was correct for proving the loop,
but it makes the target carry a Bun runtime, ConPTY, and a terminal UI. The
product wants the target to be a small service that executes tools; the agent
loop, prompts, model, policy, and transcript belong on the server.

DSH already provides the server-side agent loop, sessions, tool registry,
subagents, workflows, skills, and a UI. Building those again would be waste.
The Blackwell-specific pieces are:

1. a **remote-servicing DSH plugin/profile**;
2. a **thin Windows agent** and its wire protocol;
3. **approval/safety policy** for family and professional modes;
4. the Blackwell **Home/Pro UI** and device management.

DSH is large, but it is server-side only. That cost is acceptable; the target
install stays small.

## Containment and exit strategy

The gut feeling about DSH is valid: it is a **developer preview** with
compatibility-breaking changes, a large Node dependency graph, and a fast
release cadence. Popularity is not API stability. Do not let DSH become the
product's system of record or its UI.

Rules:

1. **DSH is an implementation detail, not the product.** The product owns
   devices, incidents, approvals, runbooks, audit, and UI. DSH is one execution
   engine behind an adapter.
2. **Pin an exact DSH version.** Run it as a fixed sidecar/container with its
   own Node runtime. No auto-update, no nightly tracking, no runtime plugin
   installation.
3. **Use a narrow interface.** The Blackwell BFF talks to a
   `RemoteServicingRuntime`: open/resume incident, send message, approve,
   cancel, stream events. DSH is one implementation. Do not leak DSH session
   types or package types into the UI or database.
4. **Own the canonical transcript.** Persist device/incident/message/tool/
   approval events in Blackwell's store. Export a DSH session into that model;
   never make DSH's session file the only copy.
5. **No third-party plugins and no self-modification.** Only our
   `blackwell-remote-servicing` plugin and a curated profile. The default DSH
   coding tools are not exposed.
6. **Own the Home UI.** Use DSH Web only as an internal/Pro operator console.
   Family mode is a Blackwell UI and is insulated from DSH UI churn.
7. **Contract tests and an upgrade gate.** Maintain a golden-session suite:
   read-only diagnostic, approval, file transfer, reboot/reconnect, resume,
   cancellation. An upgrade must pass it; otherwise stay pinned.
8. **Keep a fallback execution path.** Curated runbooks must be executable
   without DSH or an LLM. If DSH is down or a bad upgrade lands, Home can still
   run approved deterministic fixes in safe mode.
9. **Budget the maintenance.** A pinned runtime plus adapter tests is a
   recurring cost, not a one-time integration. If that cost grows beyond the
   value, swap the adapter.

Decision gate after Phase 0:

- Does the DSH spike pass the golden-session tests without patching DSH?
- Can a DSH upgrade be pinned and reproduced deterministically?
- Is the adapter small enough that a Pi-server-side or minimal custom loop
  remains a credible fallback?
- If the answer is no, drop DSH before the Home UI is built. The target agent,
  tool protocol, approvals, and runbooks do not depend on it.

## Integration shape

```text
Blackwell host
  Blackwell Home/Pro UI (Tauri or web)
        │ local API / DSH SDK
        ▼
  DSH runtime (pinned, private profile)
    ├─ model adapters → local llama engines / optional cloud
    ├─ session log, agent loop, tools, guards, interactions
    └─ `blackwell-remote-servicing` plugin
         ├─ device registry + pairing
         ├─ remote tool definitions
         ├─ action classification + approval
         ├─ runbook/skill package
         └─ WSS client to target agents
                    │ outbound WSS
                    ▼
  Windows target: blackwell-agent service
    └─ exec, files, services, events, reboot, upload/download
```

The DSH Web UI can be the **internal/Pro operator console** initially. Family
mode should use a purpose-built Home UI; a coding agent's full plugin/tool
surface is not an appropriate family interface.

## DSH profile, not host default

Run a dedicated profile, not the default coding profile:

- pinned `dsh` version
- curated bundles only; no plugin-install UI
- **no host-local shell, filesystem, browser, computer-use, or unrestricted
  subprocess tools** exposed to the model
- only the remote-servicing tools, runbook skills, and read-only diagnostics
- a sandbox around the DSH process itself
- an approval guard for every mutation
- a fixed model route (local Blackwell engine by default)

The default DSH tool set is powerful and assumes a trusted coding environment.
A remote-servicing profile must not let the model read Blackwell's filesystem or
run commands on the Blackwell host just because it has a terminal tool.

## Custom plugin surface

A `blackwell-remote-servicing` plugin should own:

- target device registry and pairing
- tool registration:
  - `remote_system_info`
  - `remote_powershell` (read-only first; mutations later)
  - `remote_service` (list/start/stop/restart)
  - `remote_events`
  - `remote_files` (list/read/download/upload; write gated)
  - `remote_reboot`
- action classes: `read`, `low`, `high`, `critical`
- `tools/pre-execute` approval hook
- transcript projections for the Home/Pro UI
- runbook skills and their allowed commands
- session/device binding and cancellation

Every tool call has a deadline, a cancellation path, a size cap, and a structured
result. A hung PowerShell process must not hang the DSH step forever.

## Sessions and audit

DSH's append-only session log is the canonical conversation record. Blackwell
should add:

- device/incident metadata on the session
- raw target output attachments or references
- approval decisions as durable events
- a human-readable transcript/export
- retention policy and redaction

This is better than reimplementing `/resume` and transcript storage on the
target. Pi's `/resume` remains useful in Power Mode only.

## Model routing

DSH's LLM adapters should point at:

- the local Blackwell llama engine(s) by default
- optionally a cloud provider for hard cases
- per-session token/time budgets
- model selection by task (fast triage vs deep diagnosis)

This preserves the private/local-first value proposition.

## Risks and constraints

| Risk | Mitigation |
|---|---|
| DSH developer-preview breaking changes | pin exact version; wrap in a profile; upgrade deliberately with snapshot tests |
| Large Node dependency surface | server-side only; ship a fixed runtime; vulnerability scanning |
| Model can reach Blackwell host tools | restricted profile; disable local shell/fs/browser; sandbox |
| Plugin supply chain | curated bundle only; no runtime plugin install; signed/verified inputs |
| Session log format changes | pin DSH; export canonical transcripts; don't depend on internals |
| DSH UI is coding-oriented | custom Home UI; DSH Web as internal/Pro console |
| Node runtime on Blackwell | service supervision, health checks, auto-update |
| License notices | retain MIT and third-party notices |

## First spike

Before building the Home UI:

1. Pin one DSH version and run its `web` profile locally on Blackwell.
2. Build a minimal `blackwell-remote-servicing` plugin with one read-only tool:
   `remote_system_info`.
3. Run a tool call from DSH against a paired Windows test agent.
4. Persist the result in a DSH session and render it in the DSH Web UI.
5. Add a `tools/pre-execute` approval for a harmless mutation and verify the
   approval is a durable part of the session.
6. Repeat with a second target device to prove device routing is not global
   state.

That spike answers the important integration questions without committing to
the final Home UI.

## Decision

Adopt DSH as the server-side orchestrator. Keep the target agent thin. Keep Pi
as an optional Power Mode for supported Windows machines and Pro/technical
users, not as the Home product runtime.
