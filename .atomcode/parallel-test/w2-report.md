# Worker 2 — Fusion Module Report

## Timestamps

| Event | Time (ms epoch) |
|---|---|
| W2_START | 1784984506400 |
| W2_END | 1784984518399 |
| Duration | 11999 ms |

---

## Module Dependency Graph

```
fusion/mod.rs
├── adapters/
│   ├── mod.rs  (FusionAdapterId enum + trait-like dispatch)
│   │   ├── ggml_master.rs  (thin wrapper → parse_ggml::parse_line)
│   │   └── ggml_tom.rs     (tom-specific regex + fallback → parse_ggml::parse_line)
│   └── parse_ggml.rs  (shared regex log parser, ~300 lines)
├── brain.rs  (FusionBrain, FusionEmitFingerprint, FusionUpdate, FusionConfig, start_brain/stop_brain)
├── log.rs  (LogEvent enum — canonical events)
├── meter.rs  (ParallelMeter, FusionMeterLane)
├── poller.rs  (SlotData, MetricsSnapshot, HTTP polling + Prometheus parser)
├── registry.rs  (per-slot adapter resolution)
└── parse_and_route_log_event() / poll_slots_normalized() — public entry points
```

### Import Dependencies (reverse)

```
brain.rs    →  adapters::FusionAdapterId, meter, registry, poller::MetricsSnapshot, log::LogEvent, log_hub::LogHub
meter.rs    →  (no internal fusion deps; serde + std::time only)
poller.rs   →  (no internal fusion deps; serde, reqwest, serde_json only)
log.rs      →  (no internal fusion deps; std only)
registry.rs →  adapters::FusionAdapterId
adapters/ggml_master.rs →  log::LogEvent, poller::SlotData
adapters/ggml_tom.rs  →  log::{strip_log_prefix, LogEvent}, poller::SlotData, regex
adapters/parse_ggml.rs →  log::{strip_log_prefix, LogEvent}, regex
adapters/mod.rs →  log::LogEvent, poller::SlotData
mod.rs      →  adapters, brain, registry, poller (public re-exports + free functions)
```

### Call Flow

```
External caller
    │
    ├── parse_and_route_log_event(slot, line)
    │     └── registry::slot_adapter → adapter.parse_log_line → brain::route_log_event
    │
    └── poll_slots_normalized(client, host, port, adapter)
          └── poller::poll_slots_on → adapter.normalize_slots
```

---

## Public Symbols Catalog

### fusion/mod.rs
| Symbol | Kind | Description |
|---|---|---|
| `parse_and_route_log_event` | fn | Parse a log line with the slot's adapter and route to the brain |
| `poll_slots_normalized` | async fn | Poll /slots and normalize with the provider adapter |

### fusion/adapters/mod.rs
| Symbol | Kind | Description |
|---|---|---|
| `FusionAdapterId` | enum | GgmlMaster, GgmlTom — dispatches parse + normalize |
| `FusionAdapterId::as_str` | fn | Display string for config matching |
| `FusionAdapterId::from_config_str` | fn | Parse config string → adapter id |
| `FusionAdapterId::parse_log_line` | fn | Dispatch parse to provider-specific implementation |
| `FusionAdapterId::normalize_slots` | fn | Normalize /slots JSON quirks |
| `FusionAdapterId::slots_expose_prompt_processed` | fn | Whether /slots exposes n_prompt_tokens_processed |

### fusion/adapters/ggml_master.rs
| Symbol | Kind | Description |
|---|---|---|
| `parse_log_line` | fn | Wrapper → parse_ggml::parse_line |
| `normalize_slots` | fn | No-op for ggml-org master |
| `slots_expose_prompt_processed` | fn | Returns true |

### fusion/adapters/ggml_tom.rs
| Symbol | Kind | Description |
|---|---|---|
| `parse_log_line` | fn | Tom-specific progress regex + fallback to parse_ggml |
| `normalize_slots` | fn | No-op |
| `slots_expose_prompt_processed` | fn | Returns false |

### fusion/adapters/parse_ggml.rs
| Symbol | Kind | Description |
|---|---|---|
| `parse_line` | fn | Shared regex-based log parser (~300 lines, ~20 patterns) |

### fusion/brain.rs
| Symbol | Kind | Description |
|---|---|---|
| `FusionConfig` | struct | Config: max_slots, interval_ms, active_ms, idle_ms, port, host, provider, bench, aggregation_mode |
| `InferencePhase` | enum | PreFill, Generation |
| `EngineState` | enum | Idle, Warming, Active, Shutdown |
| `SlotCtxInfo` | struct | Per-slot ctx tracking (ctx_total, n_tokens, prefill_tokens, prefill_total, last_decode, last_pp, phase, tps) |
| `FusionUpdate` | struct | Aggregate metrics emission record |
| `FusionEmitFingerprint` | struct | Dedup key for update emissions |
| `FusionBrain` | struct | Core state machine (~110 fields, ~2350 lines of impl) |
| `BrainInbound` | enum | Inbound message channel from log_hub |
| `start_brain` | async fn | Spawn a FusionBrain for a slot |
| `stop_brain` | async fn | Stop a single brain |
| `stop_all_brains` | async fn | Stop all brains |
| `freeze_request_meters_for_port` | async fn | Freeze meter state for a port |
| `reset_bench_meters_for_port` | async fn | Reset bench meters for a port |
| `register_brain_inbound` | fn | Register inbound sender for a slot |
| `unregister_brain_inbound` | fn | Unregister inbound sender |
| `route_log_event` | fn | Route a parsed LogEvent to the correct brain |
| `get_fusion_snapshots` | fn | Get cached FusionUpdate snapshots |
| `MIN_PP_SESSION_AVG_MS` | const | 10000 ms threshold |
| `MIN_TG_PER_REQUEST_AVG_MS` | const | 500 ms threshold |
| `INTER_REQUEST_GAP_HOLD_MS` | const | 1200 ms hold |
| `MAX_INSTANT_TOKEN_JUMP` | const | 2048 token jump cap |
| `MIN_INSTANT_TPS_DT_SEC` | const | 0.02s min delta for TPS |
| `WARM_IDLE_POLL_MS` | const | 250 ms poll tier |
| `WARM_IDLE_WINDOW_MS` | const | 60_000 ms window |
| `IDLE_HEARTBEAT_MS` | const | 10_000 ms heartbeat |
| `PP_LOG_INSTANT_HOLD_MS` | const | 1500 ms |
| `PP_LOG_INSTANT_POLL_FLOOR` | const | 0.25 |
| `BRAIN_STOP_JOIN_MS` | const | 750 ms join timeout |

### fusion/log.rs
| Symbol | Kind | Description |
|---|---|---|
| `LogEvent` | enum | Canonical log event variants: NewPrompt, NewSlot, SamplerInit, PrintTimingPP, PrintTimingGen, DraftAcceptance, StopProcessing, CachedPromptTokens, PromptEvalComplete, ForcePromptReprocess, PromptProcessingProgress |
| `strip_log_prefix` | fn | Strip llama.cpp log prefix |

### fusion/meter.rs
| Symbol | Kind | Description |
|---|---|---|
| `FusionMeterLane` | enum | Single vs Parallel meter lane |
| `ParallelMeter` | struct | Bench meter: latches peak, tracks prefill/decode wall starts |
| `clamp_display_tps` | fn | Clamp TPS to MAX_DISPLAY_TPS (200_000) |

### fusion/poller.rs
| Symbol | Kind | Description |
|---|---|---|
| `SlotData` | struct | /slots response (id, is_processing, next_token, n_prompt_tokens, n_ctx, etc.) |
| `TokenInfo` | struct | Per-token decode info |
| `MetricsSnapshot` | struct | /metrics parsed counters (prompt_tokens_total, prompt_tps_gauge, requests_processing, etc.) |
| `poll_health_ok` | async fn | Liveness probe at /health |
| `poll_slots` | async fn | Poll /slots on localhost |
| `poll_slots_on` | async fn | Poll /slots on specific host+port |
| `poll_metrics` | async fn | Poll /metrics Prometheus text format |

### fusion/registry.rs
| Symbol | Kind | Description |
|---|---|---|
| `resolve_adapter` | fn | Factory override → provider → template_type resolution |
| `register_slot_adapter` | fn | Register adapter per slot |
| `unregister_slot_adapter` | fn | Unregister adapter for a slot |
| `slot_adapter` | fn | Look up adapter for a slot (defaults to GgmlMaster) |
| `clear_slot_adapters` | fn | Clear all slot adapter registrations |

---

## Architecture Notes

### Design Principles

1. **Provider-agnostic brain** — `brain.rs` contains all inference-state-machine logic (~2900 lines). Adapters translate provider-specific I/O (stderr logs, /slots quirks) into canonical `LogEvent`s and normalize `SlotData` before the brain sees them.

2. **Zero-state poller** — `poller.rs` has no fusion state; it's pure HTTP fetch + Prometheus text parsing. It returns `SlotData` and `MetricsSnapshot` which the brain consumes.

3. **Adapters as thin translators** — `adapters/ggml_master.rs` is a one-line wrapper over `parse_ggml.rs`. `adapters/ggml_tom.rs` adds one Tom-specific regex (PromptProcessingProgress) then falls through to the shared parser. This keeps the shared parser (~300 lines) as the single source of truth for common patterns.

4. **Per-slot adapter registry** — `registry.rs` stores a `HashMap<usize, FusionAdapterId>` keyed by slot index. Resolution order: factory `spawn_profile.fusion_adapter` → provider string → template_type fallback.

5. **Parallel meter design** — `meter.rs` tracks peak concurrent requests/slots (latched for a wave), uses hysteresis to smooth /slots busy-state trailing /metrics, and separates prefill vs decode wall timestamps for aggregate bench TPS calculation.

6. **Brain lifecycle** — `brain.rs` manages the full inference loop: poll cycle (`fusion_poll_cycle`), log event processing (10 handler methods), metrics reconciliation, and update emission with fingerprint-based dedup. Uses `parking_lot::Mutex` + `tokio::sync::mpsc` for cross-task communication.

7. **Fingerprint-based dedup** — `FusionEmitFingerprint` (slots ctx hash + engine state tag + phase tag) prevents duplicate `FusionUpdate` emissions across poll cycles.

8. **Idle tiering** — Brain uses adaptive poll intervals (active → warm_idle → heartbeat) based on slot activity to minimize overhead during idle periods.

### Adding a New Provider Adapter

1. Create `src/fusion/adapters/<id>.rs` implementing `parse_log_line`, `normalize_slots`, and `slots_expose_prompt_processed`
2. Add variant to `FusionAdapterId` enum + `from_config_str` in `adapters/mod.rs`
3. Register in `parse_log_line` and `normalize_slots` match arms
4. Optionally extend `LogEvent` if a new event type is needed
5. Update `resolve_adapter` in `registry.rs` if template_type mapping applies
