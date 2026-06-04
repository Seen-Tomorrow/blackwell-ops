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
| `session_n_decoded` | `sessionNDecoded` | `sessionNDecoded` | Tokens decoded this session |
| `total_tokens_lifetime` | `totalTokensLifetime` | `totalTokensLifetime` | Total tokens lifetime |
| `is_processing` | `is_processing` | `is_processing` | Whether slot is processing |

## Summary

- **Total fields in FusionUpdate:** 23
- **Fields from /metrics:** 2 (prefillTpsMetrics, ttftMs)
- **Fields from /slots:** 8 (genTps, genTokensPerRequestSlots, genTokensPerSession, ctxUsedSession, slotCtx, ctxFillPct, ctxTotal, requestElapsedMs)
- **Fields from stderr logs:** 6 (logPrefillProgress, logPrefillTps, logPromptTokens, logGenTps, logPhase, phaseResetSource)
- **Fields from config:** 3 (alias, slotIdx, port)
- **Fields computed:** 3 (engine_state, phase, ctxFillPct)

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