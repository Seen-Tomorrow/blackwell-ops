# Remote Servicing documentation

Product and operations notes for the Blackwell remote-servicing capability.

| Doc | Purpose |
|---|---|
| [PRODUCT-PLAN.md](PRODUCT-PLAN.md) | Family-first product direction, DSH architecture, phased roadmap, backlog, risks |
| [DECISIONS.md](DECISIONS.md) | Decided items, implementation defaults, and the few owner decisions still open |
| [LOCAL-MODE-SPEC.md](LOCAL-MODE-SPEC.md) | Local Power Mode: home Blackwell or cloud model routing, routes-only gateway, local Pi launcher |
| [LOCAL-MODE-REPORT.md](LOCAL-MODE-REPORT.md) | Implementation result, tests, untested items, and owner manual steps |
| [LINK-SHAPE.md](LINK-SHAPE.md) | Device app shape: Portable vs Integrated, vocabulary, UI, credentials, rename plan |
| [TRANSCRIPT-FETCH.md](TRANSCRIPT-FETCH.md) | Design for on-demand local transcript retrieval from the dashboard (not implemented yet) |
| [HANDOFF.md](HANDOFF.md) | Current state, guardrails, next implementation slice, test constraints |
| [DSH-ORCHESTRATOR.md](DSH-ORCHESTRATOR.md) | DeepSeek Harness as the server-side orchestrator: fit, profile constraints, plugin seams, spike |
| [RUSTDESK-EMERGENCY-DESKTOP.md](RUSTDESK-EMERGENCY-DESKTOP.md) | Self-hosted RustDesk as an optional emergency desktop companion (not part of the servicing loop) |

Implementation references:

- [remote client](../../remote-client/README.md) — portable Windows station
- [remote gateway](../../remote/README.md) — gateway crate

The current proof of concept is a portable `blackwell-link.exe` that pairs to a
Blackwell gateway, runs Pi on the target, and exposes a Pi terminal and
PowerShell tool calls to REMOTE (top-level). The product plan separates this
"Power Mode" from the thinner, service-based agent intended for the product.
Local Power Mode (`blackwell-link.exe --local`) runs Pi on the machine in front
of the user with `blackwell/*` home models or a direct `cloud/*` endpoint; it is
owner/administrator only and opens no remote session.
