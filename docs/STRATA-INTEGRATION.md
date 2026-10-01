# STRATA — Integration Assessment & Implementation Checklist

**Status:** PARKED — re-evaluate in ~2 weeks.
**Assessed:** 2026-10-01 against Strata **0.1.31** (`C:/Users/GHOST-TOWER/INFRA/STRATA`, engine `strata.exe` at repo root) and Blackwell OPS fusion (`src-tauri/src/fusion/`).
**Author cadence:** ships daily — expect API drift; pin a version before any build.

> Deep fusion contract lives in [`FUSION-metrics.md`](./FUSION-metrics.md). This doc covers only the **Strata-specific delta**: architecture, observability surface, the field mapping, the launch model, and a pick-up-later checklist.

---

## Verdict

**Doable, but it is not "llama-server with different knobs."** Strata is a **C++ inference engine wrapped by a bespoke Python HTTP server** — the serving layer that Blackwell OPS keys off (HTTP API, `/slots`, `/metrics`, `/health`, tokenizer, chat template, queue) is **Python**, not the binary. The dashboard data is a clean fit (Strata's JSON is a *superset* of what fusion needs, minus format differences) and would actually **replace fragile log archaeology with structured data**. The **launch/lifecycle** is the real work: you integrate a Python-wrapped, single-sequence engine, not a self-contained server exe.

**Recommendation:** park. Benchmark decode TPS first (the go trigger below); otherwise wait.

---

## Go / No-Go triggers (owner decision logic)

| Trigger | Action |
|---|---|
| **300–400 tok/s decode out of the box** on the 2× RTX PRO 6000 | Integrate immediately |
| Llama performs similarly (expected) | **Wait** |
| **Baked-in MTP lands in vanilla llama.cpp** | The reason to switch evaporates — stay on llama |

**Strata's current edge is its integrated MTP / speculative path** (`--spec`, the `rt` draft, exposed as `draft_n`/`draft_n_accepted` in `/v1/status.last_timings` → fusion `specDraft*`). Once llama.cpp ships equivalent baked-in MTP, llama matches on the axis that makes Strata interesting, and the architecture delta is no longer worth paying. **Re-eval cadence:** ~2 weeks; pin the version; re-run the Phase-0 benchmark.

---

## 1. What Strata is (and isn't)

**`strata.exe --serve` is NOT an HTTP server.** It is a resident inference core speaking a **line protocol over stdin/stdout** (`serve/server.py:158-179`):

```
Python → engine :  GEN <max_new> <sampling> <token_ids>   (GENI … <embeddings> for images)
engine → Python :  T <id> … T <id> … DONE …
control         :  STOP (cancel) · QUIT (shutdown) · READY <ctx> (on load)
```

No port, no `/slots`, no `/metrics`, no `/health`, no tokenizer, no chat template. It consumes/produces **token ids**.

**The Python `serve.server` is the actual server.** It owns the OpenAI/Anthropic HTTP API, `/slots` `/metrics` `/health` `/v1/status`, tokenization, chat-template application, the single-sequence FIFO, the web app, MCP tools, and vision orchestration (spawns `strata-vision.exe`, feeds `GENI` embeddings). It holds the port; `strata.exe` has none.

**Process tree (one engine):**
```
python.exe serve/server.py --config <cfg> --port <n>   ← HTTP listener (tracked PID)
  ├─ strata.exe --serve --pack …                        ← inference core (stdio child)
  └─ strata-vision.exe --mmproj … (optional)            ← vision encoder (stdio child)
```
Children are reaped by the Python job object (`winjob.contain()`).

**llama.cpp lineage:** real but partial — quant kernels, GGUF loading, and `mtmd` for vision. The *serving* layer is bespoke Python.

**Concurrency:** single-sequence FIFO (`total_slots: 1`, `concurrency: {serving:1, requested:1}`). No llama-style parallel slots → the fusion multi-slot machinery collapses to one slot (the common case).

---

## 2. Observability surface (verified)

| Endpoint | Format | Returns |
|---|---|---|
| `GET /health` | JSON | `{status, max_context, model, images, api_key, loaded}` |
| `GET /slots` | JSON | **minimal**: `[{id, n_ctx, is_processing}]` — no `n_decoded`, no `n_prompt_tokens_processed` |
| `GET /metrics` | **JSON** (not Prometheus) | the Monitor payload — see below |
| `GET /v1/status` | JSON | identity + **`last_timings` in llama.cpp names** + `machine` (GPU/RAM) |
| `GET /props` `/models` `/settings` `/mcp` | JSON | misc |

**`/metrics` payload:**
- `live`: `state` (`reading`/`generating`/`idle`/`unloaded`), `phase`, `prompt_tokens`, `prompt_read`/`prompt_total` (prefill progress), `generated` (decode tokens), `tok_s`/`tok_s_mean`, `prefill_tok_s_mean`
- `totals`: since-start `prompt_tokens`/`reused`/`output_tokens`/`prompt_ms`/`decode_ms`
- `hardware`/`hardware_static`/`history`: GPU util/VRAM/temp/power, CPU/RAM (1 Hz NVML+psutil sampler, `serve/telemetry.py`)

**`/v1/status.last_timings`** (`request_timings()`, `server.py:1162`) — **exactly llama.cpp's names**:
`cache_n, prompt_n, prompt_ms, prompt_per_second, predicted_n, predicted_ms, predicted_per_second, draft_n, draft_n_accepted`

---

## 3. Blackwell OPS fusion contract (summary — see FUSION-metrics.md)

Three sources, **not equally weighted**:
- **`/slots` (rich llama.cpp shape)** = backbone: `next_token[].n_decoded`, `n_prompt_tokens_processed`, `n_prompt_tokens`, `n_prompt_tokens_cache`, `is_processing`, `id_task`, `speculative`.
- **stderr archaeology** = the engine-precise layer: `prefillMs`, authoritative `prefillTokensTotal`, KV occupancy, spec-draft acceptance, instant PP/TG (`print_timing`, `new prompt`, `stop processing: n_tokens`, `init sampler total`).
- **`/metrics` is vestigial** — parsed as **Prometheus text**, contributes exactly **one** emitted number (`prefillTpsMetrics`); the rest is parsed-then-discarded.

**Adapter trait** (`adapters/mod.rs`): `parse_log_line`, `normalize_slots`, `slots_expose_prompt_processed`, `has_log_belt`. **Precedent:** the **IK** adapter (`ik_llama`) already maps a foreign `/slots` shape (`state`/`command` → `is_processing`) via `normalize_slots`.

---

## 4. Gap analysis: Strata → FusionUpdate

| FusionUpdate (TS) | Current source | Strata source | Fit |
|---|---|---|---|
| `phase` / `engine_state` | `/slots` + logs | `/metrics.live.state` | direct, better |
| `prefillProgress` / `prefillTokens` | `n_prompt_tokens_processed` + log total | `live.prompt_read` / `prompt_total` | direct |
| `prefillTokensTotal` | log `NewPrompt` | `live.prompt_total` | direct (no log) |
| `genTps` / `genTpsInstant` | `n_decoded` deltas + `print_timing tg` | `live.tok_s`/`tok_s_mean`; `last_timings.predicted_per_second` | direct |
| `prefillTpsSession/Instant` | processed deltas + `print_timing pp` | `live.prefill_tok_s_mean`; `last_timings.prompt_per_second` | direct |
| `prefillTpsMetrics` | Prometheus gauge | `live.prefill_tok_s_mean` | direct |
| `genTokensPerRequestSlots/Session` | `next_token[].n_decoded` | `live.generated`; `last_timings.predicted_n` | direct (1 slot) |
| `ctxFillPct` / `ctxTotal` / `slotCtx` | logs + processed | `live.prompt_tokens`+`generated`+`cache_n`; `cache_max_tokens` | derivable |
| `prefillMs` / `decodeTtftMs` | `prompt eval time` log | `last_timings.prompt_ms` | direct via JSON |
| `specDraftAccepted/Generated/AcceptRate` | `print_timing draft acceptance` | `last_timings.draft_n`/`draft_n_accepted` | direct via JSON |
| `ttftMs` | `predicted_tokens_total` delta | **not exposed** | **gap** (0, or add to Strata) |

**Three format mismatches (data exists, plumbing differs):**
1. **`/slots` is minimal** — `n_decoded` / `n_prompt_tokens_processed` are **not in `/slots`**; they live in `/metrics.live`.
2. **`/metrics` is JSON, not Prometheus** — `parse_prometheus_text` would yield nothing.
3. **No stderr belt** — fine: set `has_log_belt = false` (like `ggml_quiet`); Strata's JSON replaces archaeology.

**The one architectural gap:** `normalize_slots(&mut [SlotData])` only sees the already-parsed `/slots` slice — it **cannot inject `/metrics.live` data** into the rows the brain needs. So a `strata` adapter needs **more than the current trait**: a poll path that fetches JSON `/metrics` + `/v1/status` and **synthesizes** a llama.cpp-shaped `Vec<SlotData>`, plus a small inbound feeding `last_timings` into the engine-precise fields (which today arrive only via logs).

---

## 5. The two integration axes

### 5a. Dashboard data — the `strata` adapter (agreed approach)
Treat Strata like `ggml_quiet` (`has_log_belt=false`, `slots_expose_prompt_processed=true`) **plus**:
- A **Strata poll** that fetches JSON `/metrics` + `/v1/status` and synthesizes `SlotData`:
  `is_processing ← live.state∈{reading,generating}` · `n_ctx ← /slots.n_ctx` · `next_token[0].n_decoded ← live.generated` · `n_prompt_tokens ← live.prompt_tokens` · `n_prompt_tokens_processed ← live.prompt_read` · `n_prompt_tokens_cache ← last_timings.cache_n` · `speculative ← last_timings has draft_n`.
  → drives phase, prefill %, decode tokens, KV occupancy, and poll-derived TPS with **no logs**.
- A **JSON-timings inbound** applying `last_timings` → `prefillMs`, instant PP/TG, `specDraft*` (replaces the `print_timing` regex).
- This requires **extending the adapter contract so an adapter can own its poll** (fetch+parse), not just normalize a pre-fetched slice — the single architectural change that lets non-llama engines plug in.

### 5b. Launch / lifecycle — the real work
- **Unit to launch = the Python server** (`python.exe serve/server.py --config <cfg> --port <n>`), or a **packaged exe** of it (PyInstaller/Nuitka). Either way it spawns the engine child → **2–3 process tree**, tracked PID is Python.
- **Param editor → config JSON.** Strata knobs are not a flat `--flag` CLI; they live in the config's `args` array (`--pack`, `--expert-cache`, `--prefill`, `--spec`, `--mtp`, `--kv`, `--vision`) + top-level server fields (`port`, `gpu`, `api_key`, `vision` block). The provider template should **emit a config JSON** and launch `--config <generated.json>`.
- **PID / job handling:** Blackwell OPS's `engine_job` (KILL_ON_JOB_CLOSE) + PID-only teardown must wrap the Python parent; the engine child is in Python's own job (`contain()`). Verify **nested-job** semantics (child inherits unless breakaway — and breakaway is forbidden per repo rules).
- **VRAM forecast:** Strata has **no `llama-fit-params`** → measured-only (the existing ASSISTED/FIT-probe path already tolerates `null` → skeleton). No formula adapter.
- **Version / identity:** from `/v1/status.engine` (or `BUILD.json`), **not** `--version`.
- **Port lock:** reuse `reclaim_our_ghost_or_fail` on the Python PID; no port-based taskkill.

---

## 6. Simplified implementation checklist

**Phase 0 — Benchmark (the go trigger; do first, ~1 h)**
- [ ] Decode TPS on 2× RTX PRO 6000 (single-card, `--prefill 8192`, `--spec` on/off) — **is it 300–400?**
- [ ] Compare vs current llama build on the same model/quant.
- [ ] If ≤ llama → **stop, park.** If clearly ahead → continue.

**Phase 1 — Launch spike (no UI)**
- [ ] Pin a Strata version; freeze the API surface you depend on.
- [ ] Provider type that launches `python serve/server.py --config <generated.json> --port <n>`.
- [ ] Generate the config JSON from provider param rows (engine `args` + server fields).
- [ ] PID/job teardown + `reclaim_our_ghost_or_fail`; confirm engine child reaped on stop.

**Phase 2 — Dashboard adapter**
- [ ] `FusionAdapterId::Strata` (`has_log_belt=false`, `slots_expose_prompt_processed=true`).
- [ ] Strata poll: JSON `/metrics` + `/v1/status` → synthesized `Vec<SlotData>`.
- [ ] JSON-timings inbound → `prefillMs`, instant TPS, `specDraft*`.
- [ ] Unit test with a captured `/metrics` + `/v1/status` sample (mirror the adapter-test convention).

**Phase 3 — Polish**
- [ ] VRAM forecast: measured-only path, no fit adapter.
- [ ] `specDraft*` from `draft_n`/`draft_n_accepted`; confirm accept-rate math.
- [ ] Vision seat wiring (optional) — see §8.
- [ ] `ttftMs`: leave 0, or request a first-token timestamp from Strata upstream.

---

## 7. Risks / watch-for
- **API drift** — daily commits; pin + re-verify endpoints each re-eval.
- **Nested job objects** — confirm engine child dies with the Python parent under Blackwell OPS's `engine_job`.
- **Single-sequence** — no parallel-slot throughput; the multi-slot fusion paths are inert (fine, but don't expect `genTpsPerSlot`).
- **No fit/forecast** — VRAM stays measured-only.
- **Python runtime dependency** — packaging or a managed venv; not a static binary.

---

## 8. Reference — this machine (current working setup)

**Paths**
- Repo: `C:/Users/GHOST-TOWER/INFRA/STRATA` · engine `strata.exe` (root, 0.1.31) · `engine/strata.exe` is **stale** (0.1.30).
- venv python: `C:/Users/GHOST-TOWER/INFRA/STRATA/.venv/Scripts/python.exe`
- Launch: `.venv/Scripts/python.exe serve/server.py --engine strata --config <cfg> --port <n>`
- One-shot launcher: **`STRATA/run-both.bat`** (starts BRAIN + WORKER in two windows).

**Twin topology (live now)**
| Seat | Model | GPU/Port | Thinking | Vision |
|---|---|---|---|---|
| BRAIN (session) | Q4_K_XL | GPU1 / 8888 | `:low` | off |
| WORKER | IQ3_S | GPU0 / 8889 | `:minimal` (off) | **on** |

**Vision config (WORKER `strata-iq3_s.json`)** — two gotchas found the hard way:
```jsonc
"args": [ …, "--vision" ],                 // engine needs --vision to accept GENI; engine_args() does NOT inject it
"vision": {
  "exe":  "…\\STRATA\\strata-vision.exe",   // NOT strata.exe (→ "unknown argument: --mmproj")
  "mmproj": "…\\unsloth\\Qwen3.8-Flash-Next-GGUF\\UD-Q4_K_XL\\mmproj-BF16.gguf",  // IQ3_S repo ships none; arch-matched, quant-independent
  "model": "…\\ISTA-DASLab\\…\\IQ3_S\\…-00001-of-00002.gguf",
  "gpu": true                               // MUST be truthy — 0 is falsy in Python → --gpu omitted → CPU warm-up hang
}
```
Functional proof: WORKER read `ZEBRA 7749` from a generated image in 1.19 s, `reasoning_content: null`.

**Perf notes (observed / expected — NOT a decode benchmark)**
- Q4_K_XL prefill: ~128 tok/s cold, ~3000 warm (Q4 prompt path dequantizes to FP16).
- Maintainer single-vs-split prefill: 1776 vs 1244 tok/s → **single-card wins** on 96 GB cards (layer split = pipeline parallelism, adds hand-off).
- **Decode TPS: unmeasured** → this is the Phase-0 go trigger.

**OMP config (persisted):** WORKER roles → `:minimal` (thinking off; Strata maps `reasoning_effort ∈ {none,minimal,off,disabled,false}` → `enable_thinking:false`). `vision` role → WORKER.
