# AGENTS.md

Traps and invariants only — not a code map. Read the source for flows, schemas, and file layout.

---

## Regressions to avoid

**Engine ports** — Do not reintroduce port-based taskkill (`kill_process_by_port` or netstat carpet-bomb) on launch, stop, or fail paths. Launch uses `engine_port_lock::reclaim_our_ghost_or_fail` (verified orphan only); teardown is PID-only via `stop_child_fast` / `kill_process_by_pid`. Old behavior killed ESTABLISHED fusion/health clients and sibling app instances.

**Tauri listeners** — Use `useTauriListen`; raw `listen()` in `useEffect` leaks under StrictMode because unsubscribe resolves after first cleanup.

**Frontend persistence** — New localStorage keys → `storage.ts`. New window events → `events.ts`. Tauri event names (`engine-log-batch`, etc.) are backend-owned strings.

**Windows `is_process_alive`** — `PROCESS_QUERY_INFORMATION` only. `PROCESS_VM_READ` is denied on child processes → false “dead” reads.

---

## Foundry paths

`work/` is nuked every build exit. `foundry/artifacts/.../Release/` is the only durable binary location. Provider `binary_path` / `binary_path_per_env` must point at artifacts after a foundry build, never at cmake temp output under `work/`.

---

## Provider config merge

`merge_template_for_provider` syncs structure from factory templates on every load/save. User-owned fields that must not be overwritten: `hidden`, `order`, `userAddedValues`, `hidden_values`. Bump factory `templateVersion` when shipping param changes — mismatch surfaces `needs_template_attention` in ConfigPage.

---

## Known gaps / flags

- Reaper cleans up slots only while status is `Loading`; engine death after `Running` is not auto-cleared.
- `BINARY_UPDATES_ENABLED = false` in `binary_update.rs` until GitHub releases exist.
- Fusion prefill % needs `prefill_tokens_total` from `NewPrompt` log; `/slots` `n_prompt_tokens_processed` is the numerator. Do not call `reset_prefill_counters()` on `/slots` new_request after NewPrompt — it zeroes total and forces fallback to sparse `print_timing` stderr lines.
- Bench warmup→measured has no `/slots` idle gap — call `reset_bench_meters_for_port` at each bench phase start or hero AVG/LIVE TPS bleeds warmup into measured.
- **TODO — 10ms telemetry tick (trial):** Active fusion poll + frontend render were lowered from 100ms → `log_hub::TELEMETRY_TICK_MS` (10ms) to sync with stderr log batching. Idle poll still 500ms. **Revisit:** keep or revert after checking CPU/localhost load — each active engine ≈ 200 HTTP polls/s (`/slots` + `/metrics` @ 10ms). Touch `TELEMETRY_TICK_MS`, `fusion_brain` `POLL_ACTIVE_MS`, `FusionContext` `RENDER_INTERVAL_MS`.

---

## Optional reference

`FUSION-metrics.md` — fusion poller field names when working on metrics/TG-PP, if that file is still current.