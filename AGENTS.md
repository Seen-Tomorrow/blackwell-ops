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

**Spec decoding group (`SPECULATIVE-DECODING`)** — Exception to normal per-group hiding. Engine config has an ON/OFF toggle that flips `hidden` on the whole group (`toggle_group_hidden`); spec flags must be fully omitted from CLI — zero/off is not enough. Toggle state reads **all** group params (any visible = ON). Rows shown in engine config and values in `useConfigResolver` must still respect per-param `hidden` from ConfigPage — use `specVisibleParams` (`!hidden`), not the full `allGroupedParams` list. Rust `build_cmd` already skips `param.hidden`.

---

## Known gaps / flags

- Reaper cleans up slots only while status is `Loading`; engine death after `Running` is not auto-cleared.
- `BINARY_UPDATES_ENABLED = false` in `binary_update.rs` until GitHub releases exist.
- Fusion prefill % needs `prefill_tokens_total` from `NewPrompt` log; `/slots` `n_prompt_tokens_processed` is the numerator. Do not call `reset_prefill_counters()` on `/slots` new_request after NewPrompt — it zeroes total and forces fallback to sparse `print_timing` stderr lines.
- Bench warmup→measured has no `/slots` idle gap — call `reset_bench_meters_for_port` at each bench phase start or hero AVG/LIVE TPS bleeds warmup into measured.
- **Telemetry tick:** Single constant `log_hub::TELEMETRY_TICK_MS` drives stderr batch flush, `fusion_brain` active `/slots` poll, and `FusionContext` `RENDER_INTERVAL_MS` — keep them synced (one knob). Currently **25ms** (~80 HTTP polls/s per active engine). 10ms was most reliable but heavy; 50ms is lighter if phase detection still holds.
- **SWA / long-lived slots (Opencode):** TG detection must use **per-request** `n_decoded > request_start_n_decoded`, not `n_decoded > 0`. Parse `forcing full prompt re-processing` → PP. Slot may never idle between turns — also detect `id_task` change as `new_request`. Raw `n_decoded` from prior chat looks like TG during SWA re-prefill.
- **Agent burst micro-idle:** Opencode file-read cadence &lt;1s — don't `stop_request_clock` / IDLE / zero CTX on brief `/slots` idle; use `INTER_REQUEST_GAP_HOLD_MS` + `max(live, sessionNDecoded)` on bars.

---

## Optional reference

`FUSION-metrics.md` — fusion poller field names when working on metrics/TG-PP, if that file is still current.