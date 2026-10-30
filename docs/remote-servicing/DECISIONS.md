# Decisions and defaults

This is the working decision log for Blackwell Remote Servicing. It records what
is already decided, what was delegated to the implementation, and what genuinely
needs the owner later.

## Decided

| ID | Decision | Rationale |
|---|---|---|
| D-001 | **Family/Home first, Pro second** | Narrow scope, one device/conversation, earlier value; Pro inherits safety primitives. |
| D-002 | **Thin Windows service agent** is the product target runtime | Small install, auto-start, legacy Windows potential, central updates. |
| D-003 | **Pi-on-target / Power Mode stays** | Current PoC, technical users, local on-machine access. |
| D-004 | **Local Pi uses Blackwell Link for home models and can use cloud directly** | User can call home Blackwell LLM or a cloud provider from the machine in front of them. |
| D-005 | **DSH is the server-side orchestrator for Home/Pro managed mode** | Agent loop, tools, sessions, approvals, subagents, workflows already exist. |
| D-006 | **DSH is contained, pinned, and replaceable** | Developer preview; must not become the product's data model or UI. |
| D-007 | **Thin agent protocol is Blackwell-owned** | Independent of DSH and Pi; survives orchestrator changes. |
| D-008 | **Canonical transcript/audit is Blackwell-owned** | Never make DSH session files the only record. |
| D-009 | **No remote desktop in the servicing product** | Separate RustDesk companion note; not the core loop. |
| D-010 | **No raw terminal or PowerShell in Home mode** | Family safety; runbooks and approved actions only. |
| D-011 | **Local Power Mode is owner/technician only** | Full local tools; not the family surface. |
| D-012 | **Cloud provider is OpenAI-compatible and configurable** | Avoid hard-coding a single vendor; user can choose later. |
| D-013 | **Home model default is local Blackwell engines** | Private, no per-token cost; cloud opt-in. |
| D-014 | **Local sessions are local-only by default** | No automatic transcript upload; optional sharing later. |
| D-015 | **Cloud API keys are per owner** | One key per owner account, provisioned by the owner and used on the owner's machines. The machine stores it in Credential Manager for that owner; a key is not minted per device. Revocation and spend control are owner-wide. |
| D-016 | **Local transcripts are fetched on demand, never uploaded automatically** | The local Pi session files stay on the machine. "Fetch them home for review" is an explicit owner action in the Blackwell dashboard; until that pull path ships, sessions stay local. |
| D-017 | **Local Power Mode is limited to the owner / local administrator** | Home PCs are single-user administrator machines, so the administrator account is the boundary. Standard/family users get Home mode. |

## Defaults chosen for now

These are implementation choices, not irreversible product decisions. Override
them after seeing the build.

- **Local model selector:** Pi's `/model`; two providers:
  - `blackwell/<engine>` — home routes fetched through Blackwell Link
  - `cloud/<model>` — direct OpenAI-compatible endpoint
- **Local default:** `blackwell` if the home route list is available; otherwise
  cloud if configured; otherwise show an explicit “no model endpoint” error.
- **Cloud key storage:** one owner key, kept in Windows Credential Manager on
  each owner machine and injected into the per-session models.json; never
  written to logs.
- **Local session storage:** same `pi-sessions` directory as remote Power Mode;
  `/resume` works across local and remote sessions on that machine. Local
  transcripts are not uploaded automatically; the dashboard fetch is an explicit
  owner pull (D-016).
- **Remote-to-local handoff:** same machine and data directory only. No cloud
  sync of sessions in the first build.
- **Local Pi tools:** read, PowerShell, edit, write; full local permissions.
  Launch is restricted to the owner / local administrator account (D-017).
- **Local Pi privacy:** local-only session transcript. If sessions should be
  uploaded to Blackwell automatically, that is a product/privacy decision, not
  an implementation detail; the current answer is on-demand retrieval only.
- **Home runbooks:** 5–10 initially; disk cleanup, updates, printer,
  performance, startup apps, browser/network checks.
- **Home UI:** Blackwell Tauri UI, not the DSH coding Web UI.
- **DSH integration:** start with the SDK/API adapter and one tool; choose the
  exact transport in the Phase 0 spike.
- **DSH profile:** restricted, no host-local shell/fs/browser/computer-use,
  no runtime plugin installation.
- **Secrets:** device token in Credential Manager; cloud key in Credential
  Manager; no plaintext secrets in logs.
- **Support floor:** Tier 1 Windows 10 1809+/Server 2019+; legacy via thin
  agent; no Pi on 2012 R2.

## Genuinely needs owner input later

1. **Pricing/packaging.** Free Home tier, paid Pro/self-host; later.

Resolved 2026-10-30: cloud keys are per owner (D-015); local transcripts are
fetched on demand, not uploaded (D-016); local Pi is owner/admin only (D-017).

## Not needed now

- exact DSH version (pick and pin in the spike)
- Home UI visual design
- cloud model choice
- remote desktop
- multi-tenant/RBAC details
- Linux/macOS

## Working rule

When a choice is reversible, pick the simplest default, record it here, and
move on. When it is a security/privacy choice (consent, secrets, transcript
upload), do not make it silently; leave it open for the owner.
