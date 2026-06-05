# llama.cpp WebUI Realtime Metrics via SSE (`/v1/chat/completions`)

This document captures the definitive analysis of **how the official llama.cpp WebUI** (the modern SvelteKit UI in `tools/ui/`) obtains its "just perfect" realtime prefill (PP) progress, TG TPS/timings, and context usage metrics.

It was produced by direct source reading of the latest llama.cpp tree (as found in this repo's foundry build at the time of analysis):
`src-tauri/target/debug/foundry/engines/ggml-master/llama.cpp/`

**Key takeaway for blackwell-ops:** The mechanism is *in-band* on the actual inference request. It is not a passive observer API. This has direct implications for whether/how we can replicate equivalent fidelity in the fusion monitoring UX.

---

## How the WebUI Gets the Metrics (Exact Mechanism)

The WebUI obtains **all** its realtime per-request prefill (PP) progress, PP/TG speed/TPS, timings, and context usage **exclusively in-band** as part of the *actual user generation request's streaming response*.

There is:
- No separate "metrics SSE"
- No `EventSource` (POST + custom body/headers limitation noted in server docs)
- No dedicated `/progress` endpoint
- No reliance on `/slots` or stderr logs for the live per-turn PP/TG numbers shown in the UI during a chat

### 1. Client Request (drives the *real* prompt)
POST to `./v1/chat/completions` (relative URL; the UI is served by the same llama-server).

Body always includes (for generations that need live metrics):
```ts
{
  "messages": [{ "role": "user", "content": "..." }],
  "stream": true,
  "return_progress": true,     // critical — enables prompt_progress chunks during PP
  "timings_per_token": true,   // enables timings on chunks or final response
  "max_tokens": N,             // (n_predict alias also accepted in some paths)
  ... other sampling params
}
```

See:
- `tools/ui/src/lib/services/chat.service.ts:292` (the `fetch`)
- `214-280` (body construction, `return_progress: stream ? true : undefined`)
- `157`, `280` (timings_per_token)
- `tools/ui/src/lib/stores/chat.svelte.ts:1806` (`getApiOptions`)
- Similar in agentic flows and tests.

Types: `tools/ui/src/lib/types/api.d.ts:211` (`ApiChatCompletionRequest`).

### 2. Streaming Consumption
Uses modern `fetch` + `response.body.getReader()` + `TextDecoder` (manual buffering/split on `\n`).

- Looks for lines starting with `data: `
- Special case: `data: [DONE]`
- Extracts **top-level** (not nested inside `choices[0]`) `timings` and `prompt_progress` from the parsed JSON.
- Wires `onTimings(timings?, promptProgress?)` callbacks.
- Always releases the reader in `finally`.
- `AbortSignal` is passed to fetch and checked throughout the read loop for stop/abort.

Core code: `chat.service.ts:509-665` (`handleStreamResponse`), especially `576-635`.

Note from server README: "the browser's `EventSource` interface cannot be used due to its lack of `POST` request support."

### 3. Data Structures in the Chunks
Progress/timings can arrive in **early chunks with no content delta yet** (pure progress updates during prompt processing).

**`prompt_progress`** (`ChatMessagePromptProgress` / server `result_prompt_progress`):
```ts
{
  cache: number,
  processed: number,
  time_ms: number,
  total: number
}
```
- Emitted repeatedly during prompt eval (one per `n_batch` in the test).
- Overall: `processed / total`
- Actual/timed progress (what the UI prefers): `(processed - cache) / (total - cache)`
- See: `tools/ui/src/lib/types/chat.d.ts:43`, `api.d.ts:294`

**`timings`** (`ChatMessageTimings`):
```ts
{
  prompt_n?: number, prompt_ms?: number,
  predicted_n?: number, predicted_ms?: number,
  cache_n?: number,
  // plus prompt_per_*/predicted_per_* variants in full server output
}
```
- TG TPS computed as `(predicted_n / predicted_ms) * 1000` (or use `predicted_per_second`).
- Prefill TPS can be derived analogously from the prompt fields.
- Attached on first token / per-token (when flag) / final.

These fields are pushed at the **root** of the SSE chunk object (sibling to `"choices"`).

Parsing/usage: `chat.service.ts:597-613`; store handlers `chat.svelte.ts:710-726`, `1386-1402`.

### 4. Derivation & Display (UI side)
In `parseTimingData` / `updateProcessingStateFromTimings`:
- `contextUsed = promptTokens + cacheTokens + predictedTokens`
- `contextTotal` primarily from server `/props` (`default_generation_settings.n_ctx`), with fallbacks for router mode and prior live state.
- PP % uses the cache-adjusted formula.
- Status machine: `'preparing'` while `promptProgress` is present and no predicted tokens yet; `'generating'` once `predictedTokens > 0`.
- Values feed live `processingState` (shown while loading/streaming) and are persisted to `message.timings` for "keep stats visible".

See: `chat.svelte.ts:1731-1770`, `1743`, `1683` (`getContextTotal`), `1752`, `processing-info` hook and components.

### 5. Server-Side Emission (only for opt-in requests)
The server only emits these fields for the **specific request** that set the flags and is using a slot for its own prompt + generation work. Not global, not for other concurrent slots/requests, not for non-streaming or non-opt-in calls.

- Flags parsed in `server-task.cpp:259-266` into `task_params`.
- During prompt processing (`SLOT_STATE_PROCESSING_PROMPT` / `DONE_PROMPT`):
  - After batches (and initial at start of prompt): `send_partial_response(slot, {}, true)`
  - Populates `progress.total = slot.task->n_tokens()`, `cache = slot.n_prompt_tokens_cache`, `processed = slot.prompt.tokens.size()`, `time_ms = ...`
- Timings populated via `get_timings()` when `timings_per_token` or at stop.
- Attached in the various `to_json_*` methods (non-OAI, OAI cmpl, OAI chat, etc.) **only if** `is_progress` or timings conditions.
- Then wrapped as `data: {...}\n\n` via `format_oai_sse`.
- Progress stops once PP phase completes for that request; TG continues with normal deltas (+ optional per-token timings).

Key locations:
- Structs: `tools/server/server-task.h:49-89` (params), `281-288` (result_prompt_progress), `261` (result_timings)
- Emission: `server-task.cpp:653` (to_json), `1461/1502/1556` (attach)
- `server-context.cpp:1737-1778` (`send_partial_response`), `2836` (initial), `3256` (in batch loop), `1772` (timings), state/timing setup around prompt start (~2565, 2998+)
- SSE formatting: `server-common.cpp:1340`
- Connection close handling for aborts: `server-queue.*`, `server-context.cpp` (the `should_stop` / `is_connection_closed` checks in generators)

**Server README** (`tools/server/README.md:524`) documents the param and the exact formulas.

**Test** (`tools/server/tests/unit/test_chat_completion.py:test_return_progress`): asserts per-batch updates, strictly increasing `processed`, final `processed == total`, correct `cache` semantics on reuse, and count matches `batch_count`.

### 6. Abort / Stream Close
- Client: `AbortSignal` on fetch + frequent `aborted` checks in read loop + `reader.releaseLock()` in `finally`.
- Server: Detects via `req.is_connection_closed` / `should_stop` callback passed to queue/next/generators. Stops feeding results for that task/slot.

See server-http, server-queue, server-context generator lambdas.

### Additional (non-live-PP/TG) sources used by the WebUI
- `/props` (once at connect) for `n_ctx` / default settings.
- `/slots` for overall slot monitoring (`is_processing`, current `n_decoded`, params, etc.).
- `/metrics` (Prometheus) for aggregates.

But the "truly realtime" PP bar, PP/TG TPS, and per-turn context during an active generation come 100% from the request's own SSE chunks.

---

## Is the Same Mechanism Applicable to blackwell-ops?

**Short definitive answer:**

Only if the code that *drives the actual inference prompts* is the one issuing the streaming request with `stream + return_progress + timings_per_token` and consuming the response.

The fields are **private to that request**. They are delivered only inside its token stream. There is no passive "observer" or "tap" API that gives equivalent per-request PP detail.

### When it works directly (replicates the WebUI fidelity)
- When blackwell-ops (or a future built-in feature) itself constructs and sends the *real* user prompts to a slot's port.
- Set the three flags on the real prompt.
- Parse the response stream the same way (data: lines → top-level `prompt_progress` / `timings`).
- Derive PP %, TPS, and `contextUsed = prompt + cache + predicted` exactly as the WebUI does.
- `contextTotal` from `/props` or full `/slots` response.
- Result: perfect alignment with the actual work being done (real prompt size, real cache reuse, real batching, real elapsed times).

The project's own benchmark code (`burst_bench.rs`, `bench_pp_burst.rs`) already uses this pattern successfully (stream + flags + chunk parsing of progress/timings).

It works on `/completion` (legacy) and `/v1/completions` too — the server emits the fields for any endpoint that goes through the same task/slot machinery.

### When it does *not* work the same way (current typical usage)
If the app's role is primarily **passive monitoring / ops / launching** of engines that are being driven by *external* clients (curl, OpenAI-compatible SDKs, the llama WebUI itself, other frontends, user scripts, etc.):

- Most external clients do not set the flags (they default to `false`).
- Even when a client does set them, the data only goes into *that client's* response. The monitor has no visibility.
- `/slots` + `/metrics` + log parsing give what the server *does* expose for observers (aggregates, per-slot `n_decoded`, KV ratios, `requests_processing`, print_timing lines from stderr, etc.). These are valuable but are **not** the same as the in-band per-request `prompt_progress` the WebUI uses.
- A side-channel "probe" (starting an extra dummy request with a minimal prompt just to ride the `return_progress` path) **cannot** produce the WebUI's quality of data for the real workload.

### Why dummy-probe approaches produce the observed symptoms
- Any probe only reports metrics for *its own* (tiny) prompt → wonky PP progress and PP speed (not representative of the user's real prompt).
- The probe itself causes the server to emit NewPrompt / print_timing / sampler logs → feedback loops when the monitor reacts to logs → "logs updating constantly".
- Probe streams have unrelated lifetimes to the real work → stream-not-closing, task leaks, stale phases, duplicate events, etc.
- The WebUI never does this; its metrics *are* the real request.

This is inherent to how the server implements the feature (request-private, opt-in only).

---

## Critical Source Locations (llama.cpp tree)

**WebUI (client + derivation)**
- `tools/ui/src/lib/services/chat.service.ts` — request construction + `handleStreamResponse` + notifyTimings
- `tools/ui/src/lib/stores/chat.svelte.ts` — onTimings wiring, `parseTimingData`, `updateProcessingStateFromTimings`, `getContextTotal`, `getApiOptions`
- Types: `tools/ui/src/lib/types/chat.d.ts:43` (PromptProgress/Timings), `api.d.ts:211` (Request), `273` (StreamChunk), `370` (ProcessingState)

**Server (emission)**
- `tools/server/server-task.h` — `task_params` (return_progress, timings_per_token), `result_prompt_progress`, `result_timings`
- `tools/server/server-task.cpp` — param parsing, `result_prompt_progress::to_json`, attachment in all `to_json_*` variants
- `tools/server/server-context.cpp` — `send_partial_response`, calls during prompt batch processing and start, timings attachment, slot state machine
- `tools/server/server-common.cpp` — `format_oai_sse`
- Queue / connection close: `server-queue.*`, `server-http.cpp`

**Docs & tests**
- `tools/server/README.md:524` (param docs + formulas)
- `tools/ui/docs/flows/chat-flow.md` (full streaming + onTimings flow)
- `tools/server/tests/unit/test_chat_completion.py:test_return_progress`

---

## Recommended Forward Path (high level)

1. **Document this** (this file is the start). Reference it from `FUSION-metrics.md` and `AGENTS.md`.

2. Decide the target for "best UX" in blackwell-ops:
   - **A (passive primary)**: Continue improving the existing combination of log parser (real slot's `print_timing` lines are the closest passive analog to `prompt_progress`), `/slots`, and `/metrics`. Treat any SSE probe as secondary/TG-only or remove it if the cost (closing issues, log spam) outweighs benefit.
   - **B (when self-driving)**: Any place in the app that sends real prompts (future built-in chat, batch eval, R11 features, etc.) **must** use the three flags and can surface the in-band metrics directly.
   - **C (hybrid)**: Self-driven workloads get perfect numbers; external workloads get best-effort from passive sources.

3. If a probe path is kept long-term:
   - Make starting it explicit (not log-triggered) to avoid feedback.
   - Use clean cancellation + response drop (consider `BufReader + read_line` pattern from the existing `test_sse.rs` in the repo).
   - Document that it will only ever reflect the probe's own (tiny) work.

4. **Strong option for external clients**: Consider a per-engine MITM/transparent proxy (see the new section "Advanced Option: Man-in-the-Middle (MITM) / Transparent Proxy..." below). This lets you force the flags on real client streaming requests and extract the exact same high-quality metrics the WebUI gets, without changing user harnesses. This is the closest thing to "becoming the request driver" while still supporting arbitrary external clients.

5. Context usage across slots/session: The WebUI's `contextUsed` is strictly per-request (prompt + cache + generated for that turn). The app's current `session_n_decoded` accumulation + per-slot capacity (`ctxTotal / parallel`, with unified KV special case) is a reasonable passive approximation for multi-slot scenarios. Consider pulling fuller per-slot `n_ctx` from `/slots` responses when available.

6. Verification idea: Use `test_sse.rs` (or a small harness) against a running server to send a *realistic* prompt with the flags vs. a dummy probe, and compare the numbers + behavior against what logs + `/slots` report for the same work. (Also test the proxy approach end-to-end once prototyped.)

---

## Open Questions

- Is the primary UX goal passive monitoring of *external* client workloads, or will the app itself drive inference in the scenarios where "perfect" metrics matter most?
- Preference on next concrete step (pure docs, passive-source improvements, probe hardening with the above caveats, etc.)?
- Interest in upstreaming richer per-active-task progress to llama.cpp (e.g. via `/slots` or a new lightweight endpoint)?

---

## Advanced Option: Man-in-the-Middle (MITM) / Transparent Proxy for External Clients & Harnesses

**Question:** If external chat clients or user harnesses are talking directly to the llama-server instances launched by blackwell-ops, can we build a proxy *between* the client and the real server, intercept the SSE streams, and extract the perfect `prompt_progress` + `timings` metrics?

**Short answer: Yes — this is one of the best ways to get WebUI-quality per-request metrics for *external* clients without requiring them to change their code.**

### How It Would Work
1. **Architecture change (controlled by the app)**:
   - blackwell-ops launches the real `llama-server` on an *internal* port (e.g. 18080).
   - The app (or a dedicated proxy component) listens on the *advertised* port (e.g. the one shown to users / 8080).
   - All traffic from external clients goes through the proxy. The proxy forwards (and optionally mutates) requests/responses to the real server.

2. **On the request path (incoming from client)**:
   - Inspect the HTTP request.
   - If it looks like a chat/completions or completions endpoint **and** `stream` is true (or the client intends streaming):
     - Parse the JSON body (small for most prompts).
     - Ensure/force the two magic flags:
       ```json
       "return_progress": true,
       "timings_per_token": true
       ```
     - Re-serialize and forward the (slightly larger) body to the real server.
   - For non-streaming requests or other endpoints: forward completely unchanged.

3. **On the response path (SSE from real server)**:
   - Forward the raw bytes to the external client as fast as possible (true streaming proxy — do not buffer the whole response).
   - In parallel, feed the response bytes into an SSE line parser (exactly the same "data: " + JSON logic used by the WebUI and the current `start_sse_stream`).
   - Whenever you see a chunk containing `prompt_progress` or `timings`, extract the values and push them into the FusionBrain / slot state for that engine (you already know which engine/port this proxy instance is fronting).
   - The client still receives a perfectly valid OpenAI-style SSE stream (the extra top-level fields in the JSON objects are almost always ignored by clients and SDKs).

4. **Result for the app's UX**:
   - For every streaming request that flows through the managed server, you get the *real* prompt's progress, real prefill TPS (based on the actual prompt size and cache state), real per-token timings, and accurate `prompt_n + cache_n + predicted_n` for context usage.
   - This is exactly what the WebUI sees for its own requests — now applied to any external harness that happens to talk to your port.

### Why This Is Much Better Than the Current Dummy-Probe Approach
- You are observing (or forcing) the **actual client's prompt**, not a side "0" token probe.
- No feedback loop into the logs (the real request's NewPrompt / print_timing lines are the ones that matter; the proxy doesn't create extra inference work for metrics).
- Metrics are timely and correctly sized/speed for the workload the user actually cares about.
- Works for any external client that uses streaming (even if they never heard of `return_progress`).

### Important Caveats & Trade-offs
- **Only for streaming requests**: `prompt_progress` is a streaming-only feature. Non-stream (`stream: false`) requests won't emit the live progress chunks (they may still get final `timings` in some cases). You cannot easily "fake" streaming for a non-stream client without changing the client-visible contract.
- **Request rewriting transparency**:
  - Adding the two fields is usually safe — llama-server accepts unknown fields, and the response format change (extra keys) is tolerated by the official OpenAI Python/JS SDKs and most custom parsers.
  - However, some very strict or schema-validating harnesses might notice or reject the extra data.
  - You are increasing the wire size of every SSE chunk slightly (the progress/timings objects).
- **Performance / latency**:
  - A proxy adds a small hop. For generation at very high tokens/sec this can matter.
  - The proxy must be a true zero-copy or low-copy streaming forwarder for the response body.
- **Implementation effort** (in Rust/Tauri side):
  - You need a proper HTTP reverse proxy that understands SSE/chunked encoding and can "tee" the response bytes (forward + parse).
  - Common building blocks: `hyper` + `tower-http` (or axum as a server + reqwest/hyper as client), or a custom handler that does `body::Body::wrap_stream` style forwarding while running a concurrent parser task.
  - Body rewriting requires JSON handling (use `serde_json` or `simd-json` carefully to preserve numbers exactly).
  - You must map requests to the correct internal engine/slot (the app already has this mapping logic via the engine stack).
  - Handle graceful shutdown, client disconnects (both sides), and cancellation propagation.
  - Existing code you can reuse: the SSE chunk parsing from `fusion_poller.rs` and `test_sse.rs`, plus the FusionBrain's `process_sse_event` path.
- **Bypass risk**: If a user launches the raw `llama-server` binary themselves (or hits the internal port directly), the proxy is bypassed and you fall back to logs + /slots + /metrics.
- **Multiple concurrent requests**: The proxy must handle many in-flight requests and correctly associate each response stream with the right engine (port + possibly request id or slot id from the response).

### Practical Implementation Sketch for blackwell-ops
- When launching an engine (see `engine.rs` / `EngineStack`), allocate *two* ports: "external" (for users) and "internal" (real llama-server).
- Start the real server on the internal port (with `--port internal`).
- Start a per-engine proxy task that binds the external port and forwards to `http://127.0.0.1:internal`.
- The proxy owns the SSE parsing + metrics extraction and can emit directly into the existing fusion channels (or a new per-engine metrics sender).
- Advertise only the external port in the UI / to users.
- Optional "metrics mode" toggle: "Force high-fidelity metrics (adds return_progress/timings_per_token to all streaming requests)" — on by default for best UX.

This turns the app into a "smart gateway" that gives external users the best possible monitoring numbers while they use their normal harnesses.

### Relation to the Core Analysis
This technique is the practical realization of the statement in the main analysis:

> "Replicating the *numbers* perfectly in a monitoring scenario would require either (a) becoming (or wrapping) the actual request driver for the workloads you care about..."

A MITM proxy is a clean way to *wrap* the driver path for anything that goes through blackwell-ops-managed servers.

It is strictly superior (for fidelity) to the current dummy-probe approach for external clients.

---

*Analysis captured 2026 from the ggml-master foundry checkout. Server behavior is tied to the `return_progress` + `timings_per_token` implementation in the C++ server at that revision.*