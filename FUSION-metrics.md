# FUSION — Metrics, Logic & Data Sources

Reference for **Fusion Brain** (`fusion_brain.rs`): how `/slots`, `/metrics`, and stderr logs are fused into `FusionUpdate`, and how the UI consumes them.

**Last aligned with code:** 2026-06-05

---

## 1. Architecture

```
stderr ──► log_hub::spawn_slot_reader
              └─► fusion_logparser::parse_line ──► route_log_event(slot_idx)
                        └─► FusionBrain::process_log_event (mpsc, immediate fusion-update)

HTTP ~100ms ──► fusion_poller::poll_slots  ──┐
              fusion_poller::poll_metrics ──┼─► FusionBrain::process_slots / process_metrics
                                            └─► build_update ──► emit "fusion-update"
```

| Concept | Detail |
|--------|--------|
| **Instances** | One `FusionBrain` per **engine process** (stack `slot_idx` + HTTP `port`), not per llama parallel slot |
| **Poll order** | `/slots` first, then `/metrics` (so PP state is current before metrics heuristics) |
| **Poll interval** | 100 ms (`fusion_brain::run`) |
| **Log path** | Log events also emit `fusion-update` immediately (not only on poll ticks) |
| **Frontend map** | `useFusionData.ts` → `Map<slotIdx, FusionUpdate>` |

**Source files**

| File | Role |
|------|------|
| `fusion_poller.rs` | Deserialize `/slots`, parse Prometheus `/metrics` |
| `fusion_logparser.rs` | Regex parse llama-server `-lv` lines → `LogEvent` |
| `fusion_brain.rs` | State machine, fusion, `FusionUpdate` build |
| `log_hub.rs` | Stderr reader → `parse_line` → `route_log_event` |
| `bench_pp_burst.rs` | PP bench (uses `/completion` + `/tokenize` calibration) |
| `FusionOverlay.tsx` | Hero PP/TG, LIVE/AVG toggle, phase banner |
| `SlotCtxBars.tsx` | Per-slot CTX bars + unified shared label |
| `SlotLogPanel.tsx` | **LP** (log-parsed) comparison/debug |

---

## 2. Source priority (belt + suspenders)

| Concern | Primary | Secondary (belt) | Fallback |
|--------|---------|-------------------|----------|
| **Phase `PP` / `TG` / `IDLE`** | `/slots` + `reconcile_phase` | Logs: `log_request_open`, `log_prefill_done` | `/metrics` `requests_processing` |
| **Prefill progress %** | `/slots` `n_prompt_tokens_processed` ÷ `prefill_tokens_total` | `max()` with log progress/tokens | — |
| **`prefill_tokens_total`** | Log `NewPrompt` (`task.n_tokens`) | `PromptEvalComplete` / `SamplerInit` | — |
| **Hero PP AVG TPS** | `prefill_tokens / request_elapsed_ms` | `prefill_tps_eval` after eval line | `logPrefillTps` |
| **Hero PP LIVE TPS** | Per-poll token delta | `logPrefillTps` from `print_timing` PP | `prefillTpsMetrics` gauge |
| **Hero TG AVG TPS** | Sum `n_decoded` since TG start ÷ elapsed | — | `last_gen_tps` |
| **Hero TG LIVE TPS** | Per-poll `n_decoded` delta | `logGenTps` | — |
| **CTX bar height** | `/slots` cache + processed + decoded | — | — |
| **LP fields in UI** | Debug / comparison only (`SlotLogPanel`) | — | — |

**Do not use** `/slots` `n_prompt_tokens` as the prefill progress **denominator** — it is `prompt.tokens.size()` in the server and grows during eval; it is not `task.n_tokens`.

---

## 3. Phase state machine

### 3.1 `engine_state`

| Value | Meaning |
|-------|---------|
| `LOADING` | Brain started; waiting for first successful `/slots` poll while idle |
| `READY` | Server up, no active request |
| `ACTIVE` | At least one slot `is_processing` or request in flight |

### 3.2 `phase` (`IDLE` | `PP` | `TG`)

Computed in `reconcile_phase()` after each `/slots` poll.

**In-flight** when any of:

- Any slot `is_processing`
- `/metrics` `requests_processing > 0`
- `log_request_open` (from `NewPrompt` until `stop processing`)
- `engine_state == ACTIVE` (belt against 100 ms poll lag)

**If not in-flight** → `IDLE`, stop request clock, reset prefill counters.

**If in-flight:**

1. **`log_request_open && !log_prefill_done`** → force **`PP`**  
   (covers long text prefill / WebUI before `sampler_init`; ignores brief `n_decoded` flicker)

2. Else if **any busy slot has real generation** → **`TG`**  
   Rule (WebUI-aligned):
   ```text
   is_processing && n_decoded > 0 && n_remain > 0
   ```
   - **`n_remain > 0` required** so PP bench (`n_predict: 0`) does not flip to TG after the single mandatory eval token.

3. Else → **`PP`** (prefill-only tail, between chunks, PP bench measured run)

**Logs do not set TG by themselves** — `PrintTimingGen` only updates `lp_gen_tps` / instant TPS.

### 3.3 Request clock

| Event | Action |
|-------|--------|
| `NewPrompt`, `/metrics` new request, slot `new_request` | `start_request_clock()` |
| Slot idle, `StopProcessing`, idle reconcile | `stop_request_clock()` → freeze `request_elapsed_frozen_ms` |
| TG hero AVG | Uses frozen elapsed when clock stopped |

---

## 4. Log parser (`fusion_logparser.rs`)

Wired: every stderr line → `parse_line` → `route_log_event` → `process_log_event`.

| `LogEvent` | Regex trigger (summary) | Brain handler | Active use |
|------------|-------------------------|---------------|------------|
| `NewPrompt` | `new prompt` + `task.n_tokens = N` | `handle_new_prompt` | **Yes** — reset PP, set `prefill_tokens_total`, `log_request_open`, start clock |
| `CachedPromptTokens` | `cached n_tokens = N` | `handle_cached_prompt_tokens` | **Yes** — live PP tokens/progress when `print_timing` PP sparse; throttled ~80 ms |
| `SamplerInit` | `init sampler` + `total = N` | `handle_sampler_init` | **Yes** — `log_prefill_done = true`, progress → 100%; stay PP until slots TG |
| `PromptEvalComplete` | `prompt eval time = X ms / N tokens` | `handle_prompt_eval_complete` | **Yes** — authoritative N, `prefill_tps_eval`, lock progress |
| `PrintTimingPP` | `prompt processing, n_tokens, progress, … t/s` | `handle_print_timing_pp` | **Yes** — LP fields, instant PP TPS, regression reset |
| `PrintTimingGen` | `n_decoded, tg = X t/s` | `handle_print_timing_gen` | **Yes** — LP + instant TG TPS only |
| `StopProcessing` | `stop processing` | `handle_stop_processing` | **Yes** — idle + reset (guarded by slots in metrics path) |

**Known server quirk:** `print_timing` PP is skipped when prefill &lt; ~3 s → logs alone miss short PP; `/slots` + `cached n_tokens` cover that.

**`lp_phase` / `logPhase`:** Updated by log handlers for **SlotLogPanel**; hero banner uses fused `phase`, not `logPhase`.

---

## 5. `/slots` semantics (`fusion_poller::SlotData`)

| Field | Meaning | Used for |
|-------|---------|----------|
| `is_processing` | Slot busy | Phase, per-slot tracking |
| `n_prompt_tokens_processed` | Tokens evaluated so far this request | **Prefill progress numerator** |
| `n_prompt_tokens` | `prompt.tokens.size()` (grows during eval) | CTX bar fallback sizing — **not** progress total |
| `n_prompt_tokens_cache` | Reused prefix tokens | CTX live fill |
| `next_token[0].n_decoded` | Output tokens this request | TG TPS, gen token counts |
| `next_token[0].n_remain` | Decode budget remaining | **TG detection** (`> 0`) |
| `speculative` | MTP / draft slot flag | UI only (`SlotCtxInfo`); not phase math |

**Per-slot CTX live used** (bar + `session_n_decoded`):

```text
if cache + processed > 0:
  current_used = cache + processed + n_decoded
else if n_prompt_tokens > 0:
  current_used = n_prompt_tokens + n_decoded
else:
  current_used = n_prompt_tokens_processed + n_decoded  (or n_decoded)
```

Supports growth and **downward** correction after compaction/shift.

**Multi-slot (`parallel > 1`):**

- One brain aggregates **all** slots on the port.
- Prefill processed = **max** across busy slots; single `prefill_tokens_total` from last `NewPrompt`.
- TG `gen_tps` sums **`n_decoded`** across slots — aggregate throughput, not per-client.
- Concurrent requests on multiple slots can **cross-talk** (phase/progress/totals).
- **Bench** releases all slots before/after warmup; safe for single-client bench.

**KV unified:** `unified_kv` is config for UI bar capacity (shared pool label vs partitioned). Fusion math unchanged; `ctx_fill_pct` sums per-slot usage vs full `ctx_total`.

**MTP:** Does not change PP path; TG TPS may read higher (more accepted tokens per step). `speculative` exposed on `slotCtx` only.

---

## 6. `/metrics` (`MetricsSnapshot`)

Parsed keys (see `fusion_poller::parse_prometheus_text`):

| Prometheus key | Field | Use |
|----------------|-------|-----|
| `llamacpp:prompt_tokens_total` | `prompt_tokens_total` | Delta → internal `prefill_tps` |
| `llamacpp:prompt_seconds_total` | `prompt_seconds_total` | — |
| `llamacpp:tokens_predicted_total` | `predicted_tokens_total` | TTFT / TG timing hint |
| `llamacpp:prompt_tokens_seconds` | `prompt_tps_gauge` | → `prefillTpsMetrics` (smoothed; hero fallback) |
| `llamacpp:requests_processing` | `requests_processing` | Request start/end guard |
| `llamacpp:predicted_tokens_seconds` / `tokens_predicted_seconds` | `predicted_tps_gauge` | Reserved |
| `llamacpp:n_decode_total` | `n_decode_total` | Reserved |
| `llamacpp:n_busy_slots_total` | `n_busy_slots_total` | Reserved |

**TTFT:** First `predicted_tokens_total` delta while request clock running → `ttft_ms`.

---

## 7. TPS & display caps

| Output | Formula | Notes |
|--------|---------|-------|
| `prefillTpsSession` | `prefill_tokens / request_elapsed_ms * 1000` | Min elapsed **400 ms**; overridden by `prefill_tps_eval` when eval line seen |
| `prefillTpsInstant` | Poll Δtokens / Δt; log PP line; capped | First poll after reset ignores Δ &gt; **2048** tokens |
| `prefillTpsMetrics` | Gauge from `/metrics` | Hero `--` fallback only |
| `genTps` | `(Σ n_decoded − tg_start) / elapsed` | Only while `phase == TG` and request clock live |
| `genTpsInstant` | Poll Δdecoded / Δt; log `tg =` | First poll Δ ≤ **64** tokens |
| **Display cap** | `MAX_DISPLAY_TPS = 200_000` | Prevents million-TPS flash when elapsed ≈ 0 |

### Frontend hero (`FusionOverlay.tsx`)

- **LIVE/AVG** toggle: `localStorage` key `blackops-fusion-hero-tps` (`useFusionHeroTpsMode`).
- **Location:** top-right inside **TG hero** (must call hook before any `if (!fusion) return`).
- **PP LIVE:** `max(prefillTpsInstant, logPrefillTps)`.
- **PP AVG:** `prefillTpsSession`.
- **TG LIVE:** `max(genTpsInstant, logGenTps)`.
- **TG AVG:** `genTps`.
- **Prefill UI:** `max(prefillProgress, logPrefillProgress)`, `max(prefillTokens, logPromptTokens)`; progress line only when `isPrefillPhase` (PP or ACTIVE≠TG).
- **Phase banner:** fused `phase` / `engine_state`, not `logPhase`.

---

## 8. `merged_prefill_display()` (emit safety)

Before emit, progress/tokens are merged so UI never shows stale totals:

- Progress = `max(lp_prefill_progress, prefill_progress)` capped with log progress vs `prefill_tokens_total`.
- Tokens = log `lp_prompt_tokens` if ahead, else `/slots` processed; capped below total until ~100%.

---

## 9. PP bench alignment (`bench_pp_burst.rs`)

| Step | Behavior |
|------|----------|
| Warmup | Fixed **1024**-token target; releases all slots after |
| Measured | `build_prompt_for_token_target`: **POST `/tokenize`** loop (~5 probes) to match chip within ~4% (min ±256 tok) |
| Request | `n_predict: 0`, `cache_prompt: false` |
| Result TPS | `tokens_evaluated / prompt_ms` — same family as `prefillTpsSession` + eval lock-in |

Chip target can exceed server `n_ctx` → truncation or HTTP 400; not a calibration bug.

---

## 10. `FusionUpdate` field reference

Serde renames → camelCase in TypeScript (`types.ts`).

### Config & lifecycle

| Rust | TS | Source | Description |
|------|-----|--------|-------------|
| `alias` | `alias` | Config | Engine alias |
| `slot_idx` | `slotIdx` | Config | Stack index (brain registry key) |
| `port` | `port` | Config | HTTP port |
| `engine_state` | `engine_state` | Computed | `LOADING` \| `READY` \| `ACTIVE` |
| `phase` | `phase` | Computed | `IDLE` \| `PP` \| `TG` |
| `parallel` | `parallel` | Config | Llama `-np` parallel slots |
| `unified_kv` | `unified_kv` | Config | Shared KV mode (UI bars) |
| `ctx_total` | `ctxTotal` | Config | `-c` context size |

### Prefill (primary `/slots` + logs)

| Rust | TS | Source | Description |
|------|-----|--------|-------------|
| `prefill_progress` | `prefillProgress` | `/slots` + merge | 0→1 vs `prefill_tokens_total` |
| `prefill_tokens` | `prefillTokens` | `/slots` + merge | Processed prompt tokens |
| `prefill_tokens_total` | `prefillTokensTotal` | Log `NewPrompt` / eval | Task size (**not** `n_prompt_tokens`) |
| `prefill_tps_session` | `prefillTpsSession` | Wall × tokens / eval | Hero **AVG** PP |
| `prefill_tps_instant` | `prefillTpsInstant` | Poll + logs | Hero **LIVE** PP |
| `prefill_tps_metrics` | `prefillTpsMetrics` | `/metrics` gauge | Smoothed fallback |

### Generation (`/slots`)

| Rust | TS | Source | Description |
|------|-----|--------|-------------|
| `gen_tps` | `genTps` | `/slots` | Hero **AVG** TG |
| `gen_tps_instant` | `genTpsInstant` | Poll + logs | Hero **LIVE** TG |
| `gen_tokens_per_request_slots` | `genTokensPerRequestSlots` | `/slots` | Σ per-slot decode deltas |
| `gen_tokens_per_session` | `genTokensPerSession` | `/slots` | Session cumulative gens |

### Context & timing

| Rust | TS | Source | Description |
|------|-----|--------|-------------|
| `ctx_used_session` | `ctxUsedSession` | `/slots` | Sum of per-slot live ctx used |
| `ctx_fill_pct` | `ctxFillPct` | Computed | `ctx_used_session / ctx_total` |
| `request_elapsed_ms` | `requestElapsedMs` | Clock | Live or frozen |
| `ttft_ms` | `ttftMs` | `/metrics` | First predicted-token delta |
| `slot_ctx` | `slotCtx` | `/slots` | Per-slot bar payload |

### Log-parsed (LP — comparison / belt)

| Rust | TS | Source | Description |
|------|-----|--------|-------------|
| `lp_prefill_progress` | `logPrefillProgress` | stderr | Engine PP progress |
| `lp_prefill_tps` | `logPrefillTps` | stderr | Engine PP TPS |
| `lp_prompt_tokens` | `logPromptTokens` | stderr | PP `n_tokens` in timing line |
| `lp_gen_tps` | `logGenTps` | stderr | `tg = X t/s` |
| `lp_phase` | `logPhase` | stderr | Log-only phase |
| `lp_reset_source` | `phaseResetSource` | Computed | `"prompt"` \| `"regression"` flash |

### `SlotCtxInfo` (per bar)

| Rust | TS | Description |
|------|-----|-------------|
| `id` | `id` | Slot index 0…3 |
| `n_decoded` | `n_decoded` | Decoded this request |
| `session_n_decoded` | `sessionNDecoded` | Live ctx used (see §5) |
| `total_tokens_lifetime` | `totalTokensLifetime` | Peak ctx observed |
| `is_processing` | `is_processing` | Busy flag |
| `prompt_tokens` | `promptTokens` | `n_prompt_tokens` |
| `prompt_tokens_processed` | `promptTokensProcessed` | Eval progress |
| `prompt_tokens_cache` | `promptTokensCache` | Cached prefix |
| `n_remain` | `nRemain` | Decode budget |
| `id_task` | `idTask` | Server task id |
| `speculative` | `speculative` | MTP flag |

---

## 11. UI consumers

| Component | Uses |
|-----------|------|
| `FusionOverlay` | Hero PP/TG, LIVE/AVG, phase banner, prefill bar, `SlotCtxBars` |
| `SlotCtxBars` | `slotCtx`, `ctxTotal`, `parallel`, `unified_kv` — unified: black **shared across** chip spanning active bars |
| `SlotLogPanel` | Raw logs + **LP** metrics side-by-side |
| `BenchWidget` | `bench_pp_burst` / `burst_bench` IPC; not fusion fields directly |
| `useFusionData` | Subscribes `fusion-update` by `slotIdx` |

---

## 12. Events

| Event | Payload | When |
|-------|---------|------|
| `fusion-update` | `FusionUpdate` | On **change** (fingerprint) or `emit_dirty` after log belt; poll 100 ms active / 500 ms idle+ready |
| `engine-log-batch` | Log lines | Stderr batching |
| `bench-pp-progress` | phase, `effectiveLength` | PP bench warmup/measured |
| `bench-tg-progress` | phase | TG bench |
| `engines-all-stopped` | `{ slots: number[] }` | After `stop_all_engines` — bulk frontend cache purge |

---

## 13. Maintenance notes

- **Emit policy (2026-06-05):** `FusionEmitFingerprint` in `fusion_brain.rs` — skip identical `fusion-update` IPC. Log events set `emit_dirty`; emit coalesces on next poll tick (≤100 ms). Idle+ready polls at 500 ms.
- **Frontend dedupe:** `useFusionData.ts` shallow-compares payloads before `map.set` / `setEngines`.
- **Listeners:** Prefer `useTauriListen.ts` (generation-guarded) over raw `listen().then()` for StrictMode safety.
- **Hooks:** `useFusionHeroTpsMode()` must run unconditionally at top of `FusionOverlay` (before `if (!fusion) return`).
- **Lifecycle:** `stop_brain` runs from `engine.rs`, `engine_stack::shutdown_slots_generic`, `stop_slot`, and reaper. Brain `run()` calls `unregister_log_receiver` on cancel.
- **Log pipeline:** `log_hub.rs` uses bounded stderr channel (4096); fusion `parse_line` runs **after** `is_idle_chatter` filter.
- **Removing log parser:** Would require replacing `NewPrompt` / `cached n_tokens` / `log_request_open` belt before dropping `fusion_logparser.rs`.

---

## 14. Changelog (summary)

| Date | Change |
|------|--------|
| 2026-06 | `/slots` primary for prefill progress + CTX fill; logs = belt + LP debug |
| 2026-06 | Phase: TG requires `n_remain > 0`; PP bench safe |
| 2026-06 | `prefill_tokens_total` from `task.n_tokens`, not `n_prompt_tokens` |
| 2026-06 | Hero LIVE/AVG, session PP TPS, instant caps, frozen request clock |
| 2026-06 | PP bench `/tokenize` calibration for chip targets |
| 2026-06 | This document rewritten as full logic spec |
| 2026-06-05 | Emit-on-change, idle poll slowdown, browser leak fixes, `stop_brain` in all stop paths |