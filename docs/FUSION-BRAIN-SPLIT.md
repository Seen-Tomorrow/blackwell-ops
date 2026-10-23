# Fusion brain split — SSE-only brain for ggml-master

Status: **design agreed, not implemented.** This document is the execution plan. Everything below
assumes the checkpoint commit `3ab678fda` (373 Rust tests green, working tree clean).

## Start here (next session)

1. `git log --oneline -3` — expect `3ab678fda feat(fusion): windowed decode rate`, then
   `ae4dc6504 docs: plan the fusion brain split`. If the tree is dirty, stop and look.
2. `npm run check` — 373 tests, css/tsc/vitest included. Anything red is not yours.
3. Read *Where we are* + *Migration steps*, then start at step 1 (`RequestLifecycle` extraction).

Already landed and reusable: the reader (`engine_events.rs`) with per-slot state, lane aggregate,
windowing (`gen_tps_window`), staleness clearing; the engine patch (`foundry/patches/`, three
patches, ordered); the steady-PP calibration; the probe has **not** been written.

### Tomorrow's test checklist (one category at a time)

| category | what to watch |
| --- | --- |
| PP single-slot | hero from first batch, steady value vs report `PP steady` (≈3 %) |
| PP long prompt (8k) | progress steps per ubatch, no stalls |
| TG single-slot | AVG reaches true rate within ~1 s, no frozen-hero flicker |
| TG x4 / x16 / x32 | AVG starts when the last lane decodes, never ramps from ~500 |
| ctx bars x16 | fill matches per-lane budget (4K slot → 100 % at 4K, not at 8K) |
| frozen hero | value holds between requests, no blink to 0 |
| STABLE / ggml-tom | badge `POLL`, behaviour identical to pre-SSE |
| engine restart | no stale `SSE` badge, reconnect within ~2 s |

Record the outcome of each row before touching step 1 — the split must preserve all eight.

Scope: `ggml-master` (the bearer engine) gets a dedicated SSE brain. `cafe-llama`, `ggml-tom`,
`ggml_quiet` and any unpatched engine keep today's brain, restored to its pre-SSE behaviour.

## Why

1. **Fluency.** A stream pushes every batch; polling samples at 25 ms and aliases. Watched
   side-by-side on the same engine, the SSE hero is smooth and the poll hero stutters — a
   user-visible difference, not a measurement nicety.
2. **Maintenance.** Today `brain.rs` (3.3k lines) answers two questions per field: what is it, and
   which source owns it. Every new field re-opens that. One owner per path collapses it to one.
3. **Cost.** Polling a 25 ms cadence costs ~80 HTTP requests/s per active engine, plus stderr
   regexes and `/metrics` scrapes, to reconstruct what the engine already knows.

## Where we are

| piece | file | role |
| --- | --- | --- |
| reader | `engine_events.rs` | SSE parse, per-`(port, slot)` state, aggregate, reconnect |
| contract | `fusion/emit.rs` | `FusionUpdate` — the only thing the UI knows |
| math | `fusion/meter.rs` | pure rate/clamp helpers, `ParallelMeter` walls |
| state machine | `fusion/brain.rs` | phases, meters, freeze/latch, log belt, poll loop |
| poller | `fusion/poller.rs` | `/slots` + `/metrics` deserialization |
| slots | `fusion/slotstate.rs` | `SlotBank`, per-slot KV/decode bookkeeping |
| selection | `engine.rs` `start_brain` | one spawn per engine, today always `FusionBrain` |

The SSE work landed as a ~90-line **overlay** inside `build_update`, not as a second brain. That is
the thing being promoted.

## Target

```
engine launch
   │
   ├─ provider == ggml_master AND GET /events/sse answers (300 ms probe)
   │        └─ SseBrain    — no /slots, no /metrics, no stderr.  25 ms render tick over the stream.
   │
   └─ otherwise
            └─ PollBrain   — today's brain, overlay deleted, behaviour identical to pre-SSE.
```

Rules that keep it honest:

- Both emit the **same** `FusionUpdate`. A field the SSE brain cannot fill stays `Option` and the
  UI degrades, it never guesses.
- **Neither brain reads the other's source.** If SseBrain needs a number the stream lacks, the fix
  is an engine event (see *Stream additions*), not a fallback poll.
- Metric definitions live in `meter.rs` and are called by both. A definition change cannot drift.
- The probe happens once, at launch. No per-tick re-evaluation, no flapping between brains.

## Glue

`registry` currently maps `slot_idx -> mpsc::Sender<BrainInbound>`. Make it an enum:

```rust
enum BrainHandle {
    Poll { tx: Sender<BrainInbound>, cancel: CancellationToken, join: JoinHandle<()> },
    Sse  { cancel: CancellationToken, join: JoinHandle<()> },
}
```

- `stop_brain(slot)` cancels whichever variant is present.
- `set_fusion_quiet_mode` is meaningful only for `Poll`; for `Sse` it is a no-op (a stream needs no
  quiet mode — there are no stderr parsers to silence).
- `route_log_event` is a no-op for `Sse` (it can still feed the log tab, but fusion ignores it).

That is the whole coupling: one enum, three call sites, no trait objects needed.

## SseBrain — what it owns

Loop: wait on the reader's broadcast channel, and emit on a 25 ms render tick (this is the
render/poll decoupling the old brain needs anyway, and here it is free).

Derived per engine (aggregate over lanes when `parallel > 1`):

| value | source |
| --- | --- |
| phase | `state` events (`PP` / `TG` / `IDLE` / `WAIT`) |
| PP progress, tokens | `prompt_progress` (`processed - cache`, `total`) |
| PP rate | `prompt_progress` elapsed, steady-state deduction (`PREFILL_SETUP_MS`) |
| TG instant | `gen_progress.tps` (windowed, see below) |
| TG average | accumulated decoded ÷ wall since **first token of the wave** (last-lane rule) |
| TTFT / decode TTFT | request start → first `gen_progress`; TG transition → first `gen_progress` |
| request close / frozen hero | `request_end` then next PP |
| spec counters | accumulated `request_end` counters (until the engine reports totals) |
| ctx gauges | `state.n_ctx` / `state.n_ctx_used` summed over lanes |

Freeze/latch policy (frozen hero at close, bench phase boundaries, inter-request gap hold) is
**behaviour, not data**. Port it from `brain.rs` into a shared `RequestLifecycle` with the existing
tests moved across, then have both brains call it. That is the piece most likely to regress.

## Stream additions

Ranked by value; all are small engine-side changes and all are optional to start.

| field | where | why |
| --- | --- | --- |
| `tok_s_window` (e.g. 1 s) per slot | `gen_progress` | The UI currently derives rate from two samples; a windowed rate is smooth and kills the "~50k flash" class of bug at the source instead of clamping it. |
| cumulative `spec_accepted_total` / `spec_draft_total` | `request_end` | Removes client-side accumulation, which resets on reconnect and loses history. |
| `t_request_start` (us) | `state` on PP | TTFT today is measured from frame arrival, so it carries IPC jitter. |
| `queued`, `running`, `waiting` | `state` | What a 16-lane engine looks like while requests queue; we only have busy/peak. |

## Prior art — Strata (`C:\AI-MASTER\StrataAPP`, Python control server)

Their `/metrics` is a single aggregated document rather than an event stream, but the shape is
worth copying:

```jsonc
{
  "engine": {"model": ..., "max_context": ..., "images": false, ...},
  "live": {
    "state": "idle|reading|generating", "queued": 0, "phase": "reading|generating",
    "prompt_tokens": ..., "prompt_read": ..., "prompt_total": ...,
    "generated": ..., "max_tokens": ..., "elapsed_s": 3.2,
    "tok_s": 108.4, "tok_s_mean": 97.1, "prefill_tok_s_mean": 4516.2, "tok_s_window_s": 2.0,
    "parallel": 16, "running": 16, "slots": [ {state, prompt_read, generated, ...} ],
    "outside_slots": 0, "waiting": 0, "admitting": 0
  },
  "requests": [ /* last 12 finished, timings in llama.cpp's own names */ ],
  "totals": {...}, "requests_kept": 12,
  "hardware": {gpu load, vram, temp, power, pcie}, "history": {series: last minute},
  "time": 1761...
}
```

What to take:

- **`tok_s` vs `tok_s_mean` vs a declared `tok_s_window_s`.** They name the window in the payload.
  Our hero has the same two concepts but the window is implicit — making it explicit (and moving
  the instant rate to a server-side window) is the fix for aliasing.
- **`state: idle|reading|generating`** as a three-value vocabulary, with `busy` and `first_token`
  tracked separately. Cleaner than our phase enum plus flags.
- **Per-slot array inside the live block.** We have per-lane events; the UI wants the array shape.
- **`requests` ring (last N finished, engine-native timings).** We emit `request_end` but keep no
  history in the app; a small ring in `engine_events` would give the fusion panel a "last requests"
  strip and feed the bench archive comparison for free.
- **`queued` / `waiting` / `admitting`.** Naming for what we call busy/peak, and the three are
  genuinely different states on a 16-lane engine.
- **NVML read in-process** for hardware (we already do this in `telemetry.rs`; no change needed).

What not to take: their Prometheus endpoint and latency histograms — solved problem for a server
metric stack, overkill for a desktop panel.

## Migration steps

Each step is shippable on its own and leaves the tree green.

1. **Extract `RequestLifecycle`** (phases, freeze, TTFT, close) out of `brain.rs`, with the existing
   tests moved. `FusionBrain` calls it. No behaviour change; gate is the full suite.
2. **Registry enum + probe.** `start_brain` probes `/events/sse`, logs which brain it chose, and
   still spawns `FusionBrain` for both variants. Behaviour unchanged — the probe only reports.
3. **SseBrain skeleton.** Renders `FusionUpdate` from the stream for phase/PP/TG/TTFT/ctx, calls the
   shared lifecycle, no HTTP at all. Wired for `ggml_master` engines behind a DEV flag.
4. **Bench validation.** PP and TG on `ggml_master`, single-slot and 16/32-lane, against llama-bench
   and against the old brain on the same engine. Accept: no regression on the frozen-hero behaviour,
   hero updates ≥ the poll cadence, numbers within noise of `lib_prompt_ms`-based values.
5. **Stream additions** from the table above (windowed rate first), then delete client-side
   workarounds the engine now does better.
6. **Delete the overlay** from `brain.rs`; `PollBrain` is now exactly pre-SSE behaviour.
7. **Docs + invariants**: update `AGENTS.md` (one owner per path), retire the fallback language,
   keep the 54 ms calibration note wherever it now lives.

## Verification

- `npm run check` green at every step (371 Rust tests today).
- On `ggml_master`: SSE badge `SSE`, hero smooth, PP steady within ~3 % of the report's `PP steady`.
- On `stable` and `ggml-tom`: badge `POLL`, behaviour identical to today's — the regression you
  already ran on the unpatched engine is the baseline.
- Parallel 16 and 32: aggregate sums lanes, AVG reaches true rate within ~1 s, ctx bars per lane.

## Risks

- **Freeze/latch policy** — the only part that is behaviour rather than data. Port it with tests,
  never re-derive it.
- **Provider matrix** — `has_log_belt`, `ggml_quiet`, TTS/transcribe slots. Keep all of it in
  `PollBrain`; `SseBrain` only claims what `ggml-master` actually emits.
- **Two brains drifting** — mitigated by the shared contract, `meter.rs`, and `RequestLifecycle`.
  If a rule exists in one brain only, it is either a bug or missing from the doc.

## Open questions

1. Does `SseBrain` take over the per-lane ctx bars too (dropping polling entirely), or only the
   hero? The stream can supply both; the bars currently read from `SlotBank`.
2. Do we keep the stderr log belt in `SseBrain` for the *log tab* (not for metrics)? Today the same
   pipe feeds both.
3. Should the probe be sticky per provider id, or re-run per launch? Per launch is simpler and
   self-healing after an engine patch lands.
