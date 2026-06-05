# FUSION Metrics Reference

## FusionUpdate Fields

| Rust Field | Serde Rename | TypeScript Field | Data Source | Description |
|---|---|---|---|---|
| `alias` | `alias` | `alias` | Config | Engine alias name |
| `slot_idx` | `slotIdx` | `slotIdx` | Config | Engine slot index (0-based) |
| `port` | `port` | `port` | Config | Engine HTTP port |
| `engine_state` | `engine_state` | `engine_state` | Computed | Lifecycle: LOADING/READY/ACTIVE |
| `phase` | `phase` | `phase` | Computed | Phase: IDLE/PP/TG |
| `prefill_tps_metrics` | `prefillTpsMetrics` | `prefillTpsMetrics` | `/metrics` | Prefill TPS from metrics gauge |
| `gen_tps` | `genTps` | `genTps` | `/slots` | Generation TPS (cumulative average) |
| `gen_tokens_per_request_slots` | `genTokensPerRequestSlots` | `genTokensPerRequestSlots` | `/slots` | Tokens generated this request |
| `gen_tokens_per_session` | `genTokensPerSession` | `genTokensPerSession` | `/slots` | Tokens generated this session |
| `ctx_used_session` | `ctxUsedSession` | `ctxUsedSession` | `/slots` | Context used this session |
| `ctx_fill_pct` | `ctxFillPct` | `ctxFillPct` | Computed | Context fill percentage |
| `ctx_total` | `ctxTotal` | `ctxTotal` | Config | Total context window size |
| `request_elapsed_ms` | `requestElapsedMs` | `requestElapsedMs` | Computed | Request elapsed time |
| `ttft_ms` | `ttftMs` | `ttftMs` | `/metrics` | Time to first token |
| `slot_ctx` | `slotCtx` | `slotCtx` | `/slots` | Per-slot CTX bar info |
| `parallel` | `parallel` | `parallel` | Config | Parallel slots count |
| `unified_kv` | `unified_kv` | `unified_kv` | Config | Unified KV cache mode |
| `lp_prefill_progress` | `logPrefillProgress` | `logPrefillProgress` | stderr log | Prefill progress 0→1 |
| `lp_prefill_tps` | `logPrefillTps` | `logPrefillTps` | stderr log | Prefill TPS from log |
| `lp_prompt_tokens` | `logPromptTokens` | `logPromptTokens` | stderr log | Prompt tokens processed |
| `lp_gen_tps` | `logGenTps` | `logGenTps` | stderr log | Generation TPS from log |
| `lp_phase` | `logPhase` | `logPhase` | stderr log | Phase from log events |
| `lp_reset_source` | `phaseResetSource` | `phaseResetSource` | Computed | Reset source indicator |
| `prefill_progress` | `prefillProgress` | `prefillProgress` | `/slots` (primary) | Prefill progress 0→1 from n_prompt_tokens_processed / n_prompt_tokens (real-time, no log throttle) |
| `prefill_tokens` | `prefillTokens` | `prefillTokens` | `/slots` (primary) | Prompt tokens processed this request (from /slots) |
| `prefill_tokens_total` | `prefillTokensTotal` | `prefillTokensTotal` | `/slots` + NewPrompt log | Target n_prompt for current request |

## MetricsSnapshot Fields (from /metrics)

| Field | Used by | Description |
|---|---|---|
| `prompt_tokens_total` | `process_metrics()` | Cumulative prompt tokens |
| `prompt_seconds_total` | `process_metrics()` | Cumulative prompt seconds |
| `predicted_tokens_total` | `process_metrics()` | Cumulative predicted tokens |
| `prompt_tps_gauge` | `build_update()` | Prompt TPS gauge |
| `requests_processing` | `process_metrics()` | Requests currently processing |

## SlotCtxInfo Fields (per-slot CTX bars)

| Rust Field | Serde Rename | TypeScript Field | Description |
|---|---|---|---|
| `id` | `id` | `id` | Slot index |
| `n_decoded` | `n_decoded` | `n_decoded` | Tokens decoded this request |
| `session_n_decoded` | `sessionNDecoded` | `sessionNDecoded` | Full ctx used this session (prompt/cache + decoded; grows with chat history) |
| `total_tokens_lifetime` | `totalTokensLifetime` | `totalTokensLifetime` | Total tokens lifetime |
| `is_processing` | `is_processing` | `is_processing` | Whether slot is processing |
| `prompt_tokens` | `promptTokens` | `promptTokens` | n_prompt_tokens (full task prompt / history size) |
| `prompt_tokens_processed` | `promptTokensProcessed` | `promptTokensProcessed` | n_prompt_tokens_processed (evaled so far this req) |
| `prompt_tokens_cache` | `promptTokensCache` | `promptTokensCache` | n_prompt_tokens_cache (reused from prior) |

## Summary

- **Total fields in FusionUpdate:** 26 (+3 primary prefill)
- **Fields from /metrics:** 2 (prefillTpsMetrics, ttftMs)
- **Fields from /slots:** 11 (genTps, ..., ctxUsedSession, slotCtx..., + prefillProgress, prefillTokens, prefillTokensTotal, + per-slot prompt* in slotCtx)
- **Fields from stderr logs:** 6 (log* — kept for red "LP" comparison/debug; NewPrompt also seeds prompt total)
- **Fields from config:** 3 (alias, slotIdx, port)
- **Fields computed:** 4 (engine_state, phase, ctxFillPct, prefill* fallbacks)

## 2026-06 Improvements to Prefill + CTX Tracking

**Problem (pre-edit):**
- PREFILL progress + "n tok" came only from `print_timing` PP lines in stderr (log parser).
- `print_timings_pp()` in llama.cpp server **skips entirely if t_prompt_processing < 3000ms** → short requests missed 100%, long prompts start logging after ~20%+ work done.
- `ctxUsedSession` / `sessionNDecoded` / `totalTokensLifetime` only accumulated `n_decoded` (generated tokens). Prefill tokens + cached history tokens never added → bars only showed "cumulative gens", not real KV fill vs user 128k ctx.
- For correct "full context fill" bars (user watches bars close on 128k during long chat/coding session) the prefill token counts had to be perfect.

**Solution:**
- `/slots` JSON (polled @ ~100ms) now primary for prefill:
  - `n_prompt_tokens` = full target prompt size for this request (history length)
  - `n_prompt_tokens_processed` + `n_prompt_tokens_cache` → exact `prefillProgress = processed / total`, `prefillTokens`
  - No 3s throttle, catches short prompts (as long as a poll lands in PP window), live ramp for huge cold prompts.
- New primary fields: `prefillProgress`, `prefillTokens`, `prefillTokensTotal` (UI prefers these; LP kept red for comparison).
- CTX fill now uses `cache + processed + n_decoded` (during) / `prompt_tokens + n_decoded` (post) per slot.
  - `sessionNDecoded` (and bar heights) now grow with net prefill + gens + reused history length.
  - `current_used = cache + processed + decoded` during PP → bar *ramps live* as prefill happens (great for 128k loads).
  - At request end, lifetime snaps to full committed size.
  - `ctxUsedSession` takes high-water of per-slot session ctx used.
- `SlotCtxInfo` now carries the 3 prompt_* fields for UI or future.
- Log parser / NewPrompt still used for instant "belt" reset + LP comparison visuals + seeding total on first tick.

**Result:**
- PREFILL section (TPS + progress bar + tok count) is now driven by HTTP /slots (solid) + /metrics gauge.
- CTX bars accurately reflect conversation history growth toward the engine's -c / parallel limit.
- Short requests and early % of long PP now visible; no more "20% lost".

See code: fusion_poller.rs (SlotData enrich), fusion_brain.rs (process_slots + build + state), SlotCtxBars/FusionOverlay (prefer primary).

## Data Flow

```
RUST BACKEND (data sources)
  fusion_poller.rs ─── HTTP poll /slots + /metrics ──→ MetricsSnapshot, SlotData
  fusion_logparser.rs ── stderr regex parse ──────────→ LogEvent (PP/TG/IDLE)
  fusion_brain.rs ───── state machine + fuses data ──→ FusionUpdate struct

  Tauri events emitted:
    "fusion-update" ────────────────────────────────────┘
    "engine-log-batch"
    "slot-cleared"

FRONTEND (consumers)
  useFusionData.ts ── listens to fusion-update ──→ Map<number, FusionUpdate>
  FusionOverlay.tsx ── renders real-time dashboard
  SlotLogPanel.tsx ─── renders log + fusion metrics
  SlotCtxBars.tsx ──── renders context window fill bars
  BenchWidget.tsx ──── benchmark controls
```