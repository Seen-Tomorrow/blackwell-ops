# Engine telemetry SSE — handoff

Status: **slice 1 and the SSE reader are built and verified; the poll path is still authoritative.**
Engine side: `foundry/patches/ggml-master-telemetry-sse.patch` (`+330/-5`, 14 hunks) on the
**b11841** vendor tree, rebuilt and installed into `artifacts/ggml-master/edge/Release`. It streams
`state` (with `n_ctx`/`n_ctx_used`), `prompt_progress`, `gen_progress` (50 ms throttle) and
`request_end` (slot and library boundaries). App side: `src-tauri/src/engine_events.rs` parses the
stream into a per-port snapshot and `FusionBrain::build_update` prefers it for live prefill/gen
values — behind `BLACKWELL_ENGINE_SSE=1`, falling back to the existing `/slots` + `/metrics` +
stderr path when the flag is off or the engine lacks the endpoint.

**The pp gap is settled: it is a constant ~69 ms per request, not a throughput deficit.** On the
same binary and model, llama-bench reports pp512 **4954.69** and pp2048 **5112.44**, while our slot
clock reports 171.6 ms and 470.4 ms — exactly llama-bench's 103.3 / 400.7 ms plus 68–70 ms. Flags,
mmproj, `-lv 4` logging, CUDA graphs and warmup were each ruled out by experiment. Tables,
measurements and the >4096-token anomaly are in *Why our PP is below llama-bench*.

**Which tree this applies to matters more than it should.** "App root" is the directory holding
`blackwell-ops.exe`, and each flavour has its own foundry checkout:

| flavour | engine source | foundry/patches |
| --- | --- | --- |
| DEV (`target\debug`) | `src-tauri\target\debug\foundry\engines\ggml-master\llama.cpp` | `src-tauri\target\debug\foundry\patches` |
| REL portable | `C:\AI-MASTER\Blackwell OPS portable\foundry\engines\ggml-master\llama.cpp` | `...\Blackwell OPS portable\foundry\patches` |

The first cut of this patch was written against the REL copy (b11761) while Foundry rebuilt from
the DEV copy, which had synced to b11841 — same file names, ~80 commits apart. It compiled, and
it applied nowhere. Patch the copy Foundry will actually build, or the work is invisible.

Scope for slice 1: **ggml-master only.** Other providers (`cafe-llama`, `ggml-tom`) are out of
scope until the parity test passes.

## Why

Today fusion is fed by three fragile sources:

1. `/slots` polling every 25 ms plus `/metrics` scraping.
2. stderr archeology (`print_timing`, `NewPrompt`, `prompt eval time`).
3. Per-request `/completion` SSE with `return_progress`, which only exists for that request.

Consequences we have measured and want gone:

- **PP reads 20–37 % below llama-bench** on the same engine config (3000 vs 4762 at pp512,
  4000 vs 5057 at pp2048). Traced to a **constant ~69 ms per request** in the server request
  path, which llama-bench pays once and amortizes — 40 % of a 512-token prefill, 15 % of a
  2048-token one. See *Why our PP is below llama-bench* for the measurements and for what was
  ruled out.
- **First ~3 s of PP is estimated**, then corrected when the first log line lands. Unreliable.
- The live hero meter cannot update during bench repeats (`REPS x3`) because results are
  computed at request end only.

A server-side telemetry stream fixes the two measurement bullets above at the source, and its
`lib_prompt_ms` field is what splits the fixed cost between the slot window and the library.

## Precedent (copy this pattern, do not invent a new one)

The engine already carries an additive SSE patch for cold-boot progress:

- `tools/server/server.cpp` → `handle_single_model_load_sse`, the `notify_sse` bus,
  terminal READY event, keep-alive comments.
- `tools/server/server-http.cpp` → `ctx_http.get("/models/sse", ...)` and the
  "reachable while loading" exception.

That patch is ~8 KB, touches two files, and has survived months of engine updates. The telemetry
endpoint must be built the same way: additive, self-contained, no behaviour change when unused.

## Source tree

```
<app root>\foundry\engines\ggml-master\llama.cpp\tools\server\
  server.cpp          bus, /events/sse handler, payload builders
  server-http.cpp     "reachable while loading" exception
  server-context.cpp  emit points (state / prompt_progress / request_end)
  server-common.h     server_events:: declarations
```

**This fork does not decode inside `process_single_task`.** `process_single_task` only launches
the task (`launch_slot_with_task`); the batch pipeline is
`update_slots()` → `pre_decode()` (builds the batch) → `decode()` → `post_decode()`, and the
counters advance in `metrics_post_decode()`. The emit points follow that shape, not the original
plan's. `server.cpp` is the same file that carries `handle_single_model_load_sse`, so the two SSE
endpoints share one pattern.

## Slice 1 — endpoint and events (as built)

`GET /events/sse` — no auth (same as `/models/sse`), `text/event-stream`, one worker thread per
open connection, `:\n\n` keep-alive every 15 s. Reachable while the model is still loading, so a
client can attach at cold boot and sit on keep-alives.

**The subscription is acknowledged immediately.** httplib withholds the response head until the
first body write, so the handler writes one comment frame as soon as it is called. Without that,
`curl`/`reqwest` see nothing — no status line, no headers — until the next request happens to
produce an event, which makes an attached-but-idle stream look dead. This is what made the first
app attempt look broken.

Frames are `event: <type>\ndata: <json>\n\n`. Every payload also carries `type` and a
monotonic `seq`, so a client that only parses the `data:` line still works.

### `prompt_progress`

Emitted from `post_decode()`, once per prompt sub-batch per slot, for the slot(s) that had prompt
tokens in that batch — **independent of whether the requesting client asked for
`return_progress`**. That independence is the point: our app never owns the request whose
progress it wants.

The payload is the same one `send_partial_response()` puts in `progress` for the web UI, built
from the same four values:

```json
{"type":"prompt_progress","slot":0,"total":8192,"cache":0,"processed":2048,
 "time_ms":412.3,"seq":17}
```

- `total` = the task's prompt token count, `cache` = tokens reused from the prompt cache,
  `processed` = prompt tokens currently in the slot's context (**cached prefix included** — it is
  `slot.prompt.tokens.size()`, the same value the web UI shows), `time_ms` = elapsed wall time for
  the slot so far (`t_elapsed_us`/1000).
- PP t/s for the live meter = `(processed - cache) / time_ms * 1000`. It is not estimated at any
  point; the first value is real.
- `cache` is what separates a genuine prefill from a cache hit: a 50 k tok/s reading is a cache
  hit whenever `cache` accounts for most of `total`, which is exactly what the bench's
  implausible-TPS filter keys on.

### `request_end`

Emitted from `send_final_response()` — the single choke point where the response `timings` object
is built — and only when the slot actually ran (`stats.is_set()`).

```json
{"type":"request_end","slot":0,"task":12,"prompt_ms":1234.5,"predicted_ms":880.1,
 "tokens_evaluated":8192,"tokens_predicted":512,"cache_hit_tokens":0,
 "spec_accepted":251,"spec_draft":340,"lib_prompt_ms":1240.2,
 "lib_tokens_evaluated":8192,"seq":18}
```

- `prompt_ms` / `predicted_ms` / `tokens_*` / `cache_hit_tokens` are `server_slot_stats` — the
  exact fields behind `/completion`'s `timings`, `tokens_evaluated` and `n_prompt_tokens_cache`.
- `spec_accepted` / `spec_draft` are `n_draft_accepted` / `n_draft_tokens`. They are emitted as
  numbers, and `0` genuinely means "no drafts in this request" on a build or flag set without
  speculative decoding — the archive's ACC column should agree.
- `lib_prompt_ms` / `lib_tokens_evaluated` are a **delta of the library's own
  `llama_perf_context`** (`t_p_eval_ms`, `n_p_eval`) taken from prompt start to request end —
  i.e. the counter llama-bench reports. With more than one slot busy in the window it is an
  upper bound for a single request; on a single-request bench run it is exact.

### `gen_progress`

Emitted from the sampling path after `n_gen` advances, **throttled to one event per 50 ms per
slot** (~20/s), so a live TG meter never polls `/slots`.

```json
{"type":"gen_progress","slot":0,"decoded":23,"gen_ms":219.393,"tps":100.27,"seq":9}
```

`decoded` is the slot's generated-token count for this request, `gen_ms` the decode wall time and
`tps` the slot's own decode rate (`n_gen_steps / t_gen_ms`). Speculative decoding emits from its
own accept path, so accepted drafts count once.

### `state`

Emitted on transitions only (slot start → PP, prompt done → TG, release → IDLE), not per tick.

```json
{"type":"state","slot":0,"phase":"PP","busy":1,"peak":1,"n_ctx":8192,"n_ctx_used":0,"seq":1}
```

`phase` ∈ `PP` | `TG` | `IDLE` | `WAIT`. `busy` is the number of processing slots at this
transition; `peak` is the high-water mark of `busy` since engine start (never reset);
`n_ctx` / `n_ctx_used` are the slot's context budget and current fill, which is what the fusion
context gauge needs.

## Implementation notes

- One static hub: mutex + condition_variable, `map<id, subscriber>`, one `uint64_t seq`.
  `publish()` returns early when the map is empty, so the task loop pays one mutex lock per
  emit and nothing else.
- Emit **after** updating the authoritative counters, never before — `request_end` runs after
  `res->stats = slot.stats`, `prompt_progress` after `metrics_post_decode()` has advanced
  `n_prompt_processed`.
- Never block the task loop: a subscriber whose queued bytes exceed 1 MiB is marked dropped,
  cleared and unlinked; its handler then closes the connection. Same policy as the load bus.
- One allocation per emitted event per subscriber: the frame is serialized once, then copied into
  each subscriber's queue.
- Do **not** change `/completion`, `/slots`, `/metrics`, or any existing response shape — the
  patch does not.

## How to reapply after an engine update

**Foundry applies it automatically.** `reactor_foundry::git::apply_foundry_vendor_patches` picks
up every `foundry/patches/<provider-id>-*.patch` after clone/pull, sorted by file name, and its
`git apply --reverse --check` probe means an already-patched tree reports "(already applied)"
instead of failing.

**Order is load-bearing here.** The patch is based on the tree *after*
`ggml-master-single-model-load-sse.patch`, because its `server.cpp` hunks sit inside and directly
after the block that patch creates (`handle_single_model_load_sse`, the `else` branch that
registers `/models/sse`). Names sort lexicographically, and `telemetry` > `single`, so the cold
boot patch lands first — that is why this file is no longer called `...-engine-telemetry-sse`
(which sorted before it and applied to a pristine tree that has no such block). Do not rename it
to anything that sorts before `ggml-master-single-model-load-sse.patch`.

Verified end to end on the b11841 tree: `git checkout -- tools/server` → apply
`ggml-master-single-model-load-sse.patch` → apply this patch → the result is byte-identical to
the tree those three TUs were compiled against.

If the tree has to be patched by hand (fresh clone outside Foundry, or a `--check` in review),
it applies with `-p1` from the llama.cpp root:

```
cd "<app root>\foundry\engines\ggml-master\llama.cpp"
git apply --check -p1 "...\blackwell-ops\foundry\patches\ggml-master-telemetry-sse.patch"
git apply         -p1 "...\blackwell-ops\foundry\patches\ggml-master-telemetry-sse.patch"
```

On an engine update the anchors that matter are (in order of fragility): `send_final_response`'s
`res->stats = slot.stats;`, the `SLOT_STATE_PROCESSING_PROMPT` and `SLOT_STATE_GENERATING`
assignments, the `post_decode` prompt-progress block, and the `/models/sse` route registration in
`server.cpp`. If `server-context.cpp` fails to apply, its hunks can be replayed by hand from the
patch text — none of them depends on the others. b11761 → b11841 needed no hunk changes at all;
only the file header (`index`) moved, and upstream had not touched any anchor.

## Upstream break at b11841 (`ggml-master-cuda-graph-instance.patch`)

Separate from this work, and worth knowing before blaming the telemetry patch: **the b11841 vendor
tree does not compile with CUDA at all**, with default flags, on any machine.

```
ggml/src/ggml-cuda/ggml-cuda.cu(499): error: class "ggml_cuda_graph" has no member "instance"
            n_captured += graph->instance != nullptr;
```

#30804 ("CUDA: chunk graphs to amortize graph launch") replaced the single captured graph with
`std::vector<cudaGraphExec_t> instances` in `common.cuh`, but left this one reader of the old
singular member behind, inside `#ifdef USE_CUDA_GRAPH`. `GGML_CUDA_USE_GRAPHS` is defined by
`ggml/src/ggml-cuda/CMakeLists.txt`, so the guard is always on and every CUDA build hits it.
`origin/master` still carries the stale line, so there is no upstream fix to wait for yet.

Carry `foundry/patches/ggml-master-cuda-graph-instance.patch` until upstream repairs it. It is one
line:

```diff
-            n_captured += graph->instance != nullptr;
+            n_captured += !graph->instances.empty();
```

Then delete the patch: once upstream fixes the line the hunk stops applying, and Foundry reports
it as a soft PATCH FAIL, which is the signal to drop it. This is unrelated to `tools/server` — the
failing file is `ggml/src/ggml-cuda/ggml-cuda.cu`.

## Why our PP is below llama-bench — settled to a constant

Measured 2026-10-23 on the b11841 edge build, Qwen3.8-27B IQ3_XXS, `-b 8192 -ub 4096 -fa on`,
bf16 KV, `cache_prompt=false`, medians of 5–6 warmed reps per size.

**Server request path vs llama-bench, same binary, same model, same flags:**

| prompt tokens | server ms (median) | llama-bench ms | delta |
| ---: | ---: | ---: | ---: |
| 513 | 171.6 | 103.3 (4954.69 t/s) | **+68.3 ms** |
| 2049 | 470.4 | 400.7 (5112.44 t/s) | **+69.7 ms** |

The delta is the same at both sizes: **~69 ms per request**. That is the entire explanation for
"20–37 % below llama-bench" — as a fixed cost it is 40 % of a 512-token prefill and 15 % of a
2048-token one, so the percentage depends only on the prompt size you compare at.

**Fitting the line settles it.** Four sizes on the live engine, medians of three runs each,
`cache_prompt=false`:

| tokens | measured ms | fit `54 + 0.203·n` |
| ---: | ---: | ---: |
| 513 | 161.6 | 158.3 |
| 1025 | 253.5 | 262.2 |
| 2049 | 477.6 | 470.1 |
| 4097 | 883.8 | 885.8 |

Least squares gives **slope 0.2030 ms/token = 4927 t/s** and **intercept 54 ms**. llama-bench on
the same binary measures 4915 (pp512) and 5074 (pp2048) — so the engine's steady-state prefill
throughput is the same to within a few percent, and *all* of the "slow PP" is the intercept.
llama-bench pays that ~54 ms once (warmup) and divides it across reps; every HTTP request pays it
again. TG, measured the same way, is 112.42 t/s under llama-bench against 108.2 t/s over
`/completion` (-3.7 %) — the server runs a real sampler chain per token where llama-bench samples
greedily.

Where the toll sits, from `request_end`:

- **~31 ms in the slot window, outside `t_p_eval`** (`prompt_ms - lib_prompt_ms`): batch build,
  slot setup, the final synchronise.
- **~23 ms inside `t_p_eval`**: the library's own counter is above llama-bench's per-rep time by
  that much, so it is work the library sees but llama-bench does not repeat per request.

A request with nothing to prefill still costs ~80 ms of slot time (cache-hit test), which
confirms it is a per-request floor and not per-token work.

**Keeping the prompt cache does not remove it.** With `cache_prompt=true` and alternating
different texts (so no prefix hit, pool retained between requests), a 545-token prefill still cost
166.4 ms — the same line (`54 + 0.203·545 = 164.6`). So the toll is per-request setup in the
server task path, not the slot being cleared between requests.

Ruled out by experiment, not by reasoning:

| suspect | test | result |
| --- | --- | --- |
| engine flags | llama-bench with the app's exact invocation (`--fit-ctx 131072`, mlock, cpu-mask) | reproduces 4954.69 / 5112.44 |
| `--mmproj` + `-lv 4` logging | control server without mmproj, `-lv 2` | 2989 / 4356 — unchanged |
| CUDA graph capture per request | `GGML_CUDA_DISABLE_GRAPHS=1` | 3022 / 4382 — unchanged |
| cold start / warmup only | 6 consecutive reps at one size | flat from rep 2 |
| ubatch splitting at ≤4096 | 2049-token prompt is a single ubatch | n/a |
| quant-specific kernels (IQ3_XXS fallback path) | same model as **Q6_K** (standard MMQ kernels), fitted the same way | slope 4113 t/s vs llama-bench 4224/4330, **intercept 55.3 ms** — the toll is quant-independent |
| prompt content (random tokens vs natural text) | compare slopes rather than per-request times, on both quants | HTTP slope 4927 (IQ3) / 4113 (Q6) vs llama-bench 4915–5074 / 4224–4330 — content is not a factor at steady state |

So the ~54 ms is a property of the server request path, not of the model, the quant or the prompt.
It decomposes as ~18 ms of HTTP/slot floor (a one-token request costs that much and reports
`t_p_eval` 0) plus ~40 ms of first-prefill graph/context setup charged inside `t_p_eval`, then
0.203 ms/token of real work. llama-bench pays the setup once during warmup and reuses it.

**Open, beyond 4096 tokens.** The delta stops being constant as soon as a prompt needs more than
one ubatch: at 8193 tokens the server does 3559 t/s against llama-bench's 5879. Raising
`--ubatch-size` to 16384 (so 8193 fits in one ubatch) moved the same request from 2302 ms to
1910 ms, so multi-ubatch handling is at least part of that second gap — worth a look before
trusting PP numbers on long prompts.

What this means for the bench and for fusion:

- Per-request PP is `tokens / (llama-bench_time + 69 ms)`. Reporting it as a raw t/s figure makes
  a fast engine look 40 % slow at pp512. Either normalise (subtract the fitted floor, or compare
  at the same prompt size), or fix the floor.
- `lib_prompt_ms` narrows the gap (it removes the ~31 ms slot-only part) but does not close it.
- The earlier draft of this document blamed "HTTP layer vs library" and then over-corrected to
  "the endpoint cannot move the number". Both were wrong: the number is a slot counter, and the
  slot window is exactly where a third of the fixed cost lives.

Also real, and independent of all of the above: the live meter. `prompt_progress` is emitted for
every request regardless of `return_progress`, so the hero PP figure is honest from the first
batch instead of estimated for ~3 s.

## Fallback: pinning the vendor tree

If upstream breaks the tree again faster than it can be patched, the escape hatch is a manual
reset. It is **not** durable by itself:

- `reactor_foundry::git::git_hard_sync_branch` runs on every Foundry start (`mod.rs:610`), so the
  next Build press resets to `origin/master` and wipes the pin.
- `b11761` (`119f68d7d`, "this morning") is present locally, so the reset itself is offline and
  instant.

Recipe, used only when a vendor patch is not enough:

```powershell
$eng = "<app root>\foundry\engines\ggml-master\llama.cpp"
git -C $eng reset --hard 119f68d7d
# Foundry's own build line, minus stage 1 (git sync):
cmd /d /c "<app root>\foundry\engines\ggml-master\work\_build_run_edge.bat"
# Foundry's install step does not run, so publish the binaries by hand:
Copy-Item "<app root>\foundry\engines\ggml-master\work\build-edge\bin\Release\*" `
          "<app root>\foundry\artifacts\ggml-master\edge\Release" -Force
```

Two costs, both mechanical: the telemetry patch is based on b11841, so it needs a rebase onto
b11761 (anchors are stable — the last 80 commits did not touch one), and anything upstream fixed
in those 80 commits is given up. Prefer a one-line vendor patch over a pin whenever the break is
that small, as with `ggml-master-cuda-graph-instance.patch`.

## Slice 2 — Rust client (built, opt-in)

`src-tauri/src/engine_events.rs`:

- One `tokio` task per engine port, `reqwest` streaming GET on `/events/sse`, reconnect after 2 s.
- `EngineEvent` is a serde-tagged enum over the four frame types; `take_frames()` is a pure
  incremental SSE parser (blank-line records, `:` keep-alives, `event:` lines ignored, malformed
  payloads skipped, partial record kept) with four unit tests.
- Every frame updates a `SlotTelemetry` record keyed by `(port, engine slot)` (`phase`, `n_ctx`,
  `n_ctx_used`, `pp_processed/cache/total/time_ms`, `gen_decoded`, `gen_tps`, `last_request` with
  both `prompt_ms` and `lib_prompt_ms`, plus ttft/decode-ttft timestamps). `snapshot(port)` returns
  the port's active slot; `slot_snapshot(port, slot)` reads one slot. `ensure(port)` starts the
  reader once per port.
- **Parallel engines read an aggregate, not a lane.** Fusion runs one brain per *engine*, so `aggregate(port)` reports system scope: phase is PP if any lane is prefilling, prefill/generation tokens are summed, the prefill rate is the **sum of lane rates** (summed tokens over the longest window would understate a parallel engine), context is summed, TTFT is the earliest lane's, `request_closed` only when every lane is closed, spec totals summed. Per-lane bars still come from the poller's slot bank, which is the right scope for them.
- **Two slots busy at once returns `None` on purpose.** Parallel lanes are exactly the case where
  per-slot aggregation is a policy decision, not a data question, so the poll path keeps owning
  it. A single busy slot, or a port where slots are used one at a time, is handled from the stream.
- Session counters: `request_end` carries per-request spec counters, so they are accumulated into
  `spec_accepted_total` / `spec_draft_total`; `request_closed` is derived from the same event and
  cleared on the next PP. Both reset when the stream reconnects, so a restarted engine never
  inherits another process's totals.
- While the stream is attached the `/slots` cadence is capped at 250 ms (`SSE_FALLBACK_POLL_MS`)
  instead of 25 ms — the remaining poll-driven fields stay fresh at 4 Hz, and the 10x drop is the
  "not paying twice" part of the migration.
- Fusion consumes it in `FusionBrain::build_update`: when a snapshot exists and the phase is not
  `IDLE`, it overrides `prefill_progress`, `prefill_tokens`, `prefill_tps_session` and
  `gen_tps_out`. Everything else — TTFT, spec counters, ctx gauges, the log belt — still comes
  from the existing path, unchanged.
- Gated by `BLACKWELL_ENGINE_SSE`: **primary by default** — set the variable to `0` / `false` /
  `off` / `no` to force the legacy path. A patch-missing engine costs one failed connect and a
  warning, then polling continues.
- The UI shows the live source: `FusionUpdate.telemetrySource` is `"sse"` while the stream is
  attached and `"poll"` otherwise, rendered as an `SSE` / `POLL` badge in the instrument chrome.
- When a request is finished (`phase: IDLE`), the hero PP value comes from the slot clock of that
  request with the fixed setup deducted — `tokens / (prompt_ms - 54 ms)` — so it reads ~4768 at
  pp512 where the raw figure reads ~3174 and llama-bench reports 4895. The deduction is capped at
  65 % of the window so short prompts cannot produce absurd numbers, and it is named in the SSE
  badge tooltip. `PREFILL_SETUP_MS` in `brain.rs` is the single place to change it.

Still on the poll path and safe to migrate next: TTFT, spec acceptance, per-slot gen tokens, and
anything derived from stderr (`print_timing`). Those are additive overrides in the same function.

## Verification gate (do not proceed without this)

1. Build the patched engine in Foundry (user rebuilds).
2. `curl -N http://127.0.0.1:8080/events/sse` during a request — `event:`/`data:` frames arrive
   per prompt batch with strictly increasing `seq`, then one `request_end`, and the connection
   survives idle gaps on `:\n\n` keep-alives.
3. Compare the two boundaries on one request: `request_end.lib_prompt_ms` against
   `request_end.prompt_ms` (and `lib_tokens_evaluated` against `tokens_evaluated`). This is the
   decision in the table above.
4. Run our PP bench at **512** and **2048**, `REPS x5`, median, same engine flags
   (`FA=ON KV=BF16/BF16 B=8192/4096 T=8 SPEC=MTP ...`).
5. Compare with llama-bench on the same engine/config:
   - reference: `pp512 4762.59 ± 362.08`, `pp2048 5056.90 ± 81.78`; reproduced on the b11841 edge
     build as `pp512 4954.69 ± 54.13`, `pp2048 5112.44 ± 15.06`.
   - **neither counter passes 2 % at pp512 today.** The slot clock adds the full ~69 ms; even
     `lib_prompt_ms` still carries ~38 ms of it. Either measure steady-state throughput (fit
     `tokens / tps` across sizes and read the slope, which is the real throughput), or fix the
     per-request floor first. Do not report a raw pp512 t/s against llama-bench and call the
     engine slow.
6. Also confirm `spec` counters appear and that acceptance matches the archive's ACC column.

## Constraints

- ggml-master only. Do not touch `cafe-llama` / `ggml-tom` yet.
- Additive patch only. Saved as `foundry/patches/ggml-master-telemetry-sse.patch`, with
  the reapply procedure above.
- Never kill the running REL app without asking (repo law); DEV rebuilds are fine.
- `npm run check` remains the only gate for repo changes.

## Where the previous session left things

Uncommitted work already in the tree that this handoff builds on:

- `src-tauri/src/bench_archive.rs` — run archive, quality rules, comparability hash,
  `spec_counters(port)` (engine `/metrics` deltas), flags parsing.
- `src-tauri/src/bench_prompts.rs` — `PromptMode::{Unique, Code}`, realistic code corpus.
- `src-tauri/src/bench_pp_burst.rs` — REPS + median, 50 k tok/s cache-hit filter.
- `src-tauri/src/burst_bench.rs` — TG capture, spec acceptance delta.
- `src-tauri/src/session_log.rs` — in-memory launch command + engine session id.
- `src-tauri/src/fusion/brain.rs` — `[fusion-stats]` and poll-tier lines demoted to `debug`.
- `scripts/bench/report.mjs` — grouped rows (one per engine config), dual-axis TG+PP chart,
  compact flag line, ACC column; `npm run bench:report`. **PP steady tok/s** is new: it fits
  elapsed-ms against prompt tokens across the sizes the group measured and reports the slope, with
  the fitted per-request setup in parentheses (`4975.6 (70ms)`). Raw `PP tok/s` remains, because
  it is what a single request actually feels like; the steady figure is the one comparable to
  llama-bench. Groups with a single PP size show `-` — there is nothing to fit.
  `--per-run` prints every archived run individually (the grouped table shows one row per engine
  configuration, best value); `--min-tokens 0` disables the 128-token size gate, and the header
  always reports how many runs were hidden by it.
- UI: `BenchWidget.tsx`, `benchPortStore.ts`, `storage.ts`, `types.ts` — Code mode, REPS chip,
  PP 512/2048 targets.
