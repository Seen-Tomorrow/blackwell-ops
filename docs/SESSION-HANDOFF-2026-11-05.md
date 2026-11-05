# VRAM forecast + placement — session handoff (2026-11-05)

Fresh session: read this, then `docs/VRAM-FORECAST-LESSONS.md` for the measured facts. Everything
below is what exists in the tree today, not a plan.

## What this is for

Users need one honest answer: **will this model at these knobs fit, and if so where do the layers
go**. We build: (a) an exact VRAM forecast, (b) a layer plan with per-GPU split, (c) a handover that
takes placement away from llama.cpp's fit (`-ts`), so the engine cannot silently shrink the graph
for speed. One glass (`VramBadge`), one plan, one journal.

## State

- `main` = `82cd0a920`, gate green (`npm run check`: 198 TS, 451 Rust). Tree clean.
- **`main` is a protected branch** — no force push. Fix forward with a new commit; do not rebase
  published commits (one attempt cost a diverged branch and an interrupted rebase).
- DEV app: `npm run dev` (no watch; Rust changes need restart, TS reloads via Vite). App root is
  `src-tauri/target/debug/`.

## Pieces and where they live

| Concern | File |
|---|---|
| Engine log → memory inventory | `src-tauri/src/launch_memory_parse.rs` (`LaunchMemorySnapshot`, `fit_attempts`) |
| Learned store, keys, lookups | `src-tauri/src/vram_learn.rs` |
| Layer table from GGUF (offsets, not type table) | `src-tauri/src/layer_plan.rs` |
| Cold forecast + FIT projections | `src-tauri/src/vram_profile.rs` |
| Runtime cost per device | `src-tauri/src/gpu_calibration.rs` |
| DEV automation queue | `src-tauri/src/automation.rs` + `scripts/engine-test.py` |
| Journal | `src-tauri/src/forecast_log.rs` (`config/cache/forecast-log.jsonl`) |
| Planner (pure) | `src/lib/vramLayerPlan.ts` |
| Plan assembly for UI | `src/hooks/useLayerPlan.ts` |
| Glass | `src/components/VramBadge.tsx`, `PlanPopover.tsx` |
| Forecast source resolution | `src/services/vram/forecast/` (adapter `ggml_master.ts`) |
| Comparison tool | `scripts/forecast-compare.py` |

## Two bases — never mix them

- **Inventory** = `model + kv + compute + rs + vision` over `CUDA<digits>`. This is what the learned
  rows, FIT rows and the plan all speak. `rs` = `llama_memory_recurrent` (hybrid/SSM state).
- **NVML used** = inventory + CUDA context + graph pools/allocator. Measured per device by
  `gpu_calibration` as `used − buffers`.
- The glass prints **inventory + calibrated runtime** (one number), with the split in its tooltip and
  in the state file. The plan and comparisons stay on inventory.

## Learned store rules (hard-won)

- Key: `provider|ctx|kv|topo|split|batch|ubatch|offload|cache_ram` (+ draft when external).
  `mode` is **not** in it. `batch`/`ubatch` **must** be: 14,064 vs 15,299 MiB at 64K for 2048/1536.
- `kv`, `split`, `batch`, `ubatch` are **hard filters** in lookups. Soft scoring let an f16 row win
  for a q8_0 config (1.88× the KV).
- Lookup returns: exact row → interpolation between the two bracketing rows → nothing. **Never
  splice** rows from different ctx (that produced KV from 256K with compute from 64K).
- Probe measures **one** ctx. It is scaled to another ctx, never reused raw and never dropped
  (dropping left an empty manifest = eternal "EVALUATING").
- Learned curve extrapolates outside its range and sets `beyondMeasured`; clamping froze the number.

## Measured facts worth trusting

- Compute buffers are **affine in ctx** for a fixed shape/batch/split: `a ≈ 2,826 MiB`,
  `b ≈ 70 MiB per 1k tokens` (Qwen3.8-27B, batch 8192, layer). They depend on **shape, not weights**
  (Q4_K_M vs IQ3_XXS identical to the MiB).
- KV is linear in ctx; hybrid models keep it in only some blocks (`kv_layer_ratio` per architecture).
- Plan vs measured on the test model: ±0.1–1 %. DSV4.1 @768K after handover: inventory 181.44 GB,
  runtime ~1.2 GB, monitor ~185 GB, free per card 1.6/1.5 GB, `-ts 0.55,0.45` reaching the CLI.

## How to work without screenshots

1. `python scripts/engine-test.py launch --model <gguf> --ctx N --kv q8_0 --split layer --batch 3072 --ubatch 512 --hold 8000`
   — runs the app's own launch path; also `status`, `stop`, `cold`, and the raw `param` action.
2. The glass publishes itself to `src-tauri/target/debug/config/automation/ui/vram-badge.json`:
   model, knobs, `sourceKind/Exact/Detail`, `vramNeedGb`, `vramInventoryGb`, `runtimeOverheadGb`,
   `gpuLoadsGb` (bars), `fits`, `needTone`, `launchPaint`, `plan{totalMib,budgetSumMib,gpuMib,ts,
   boundary,kvSource,squeezed}`. **Read this instead of asking for a screenshot.**
3. `python scripts/forecast-compare.py [model]` — fit / plan / measured per configuration.
4. `config/cache/forecast-log.jsonl` rows: `prelaunch`, `measured`, `plan`, `fit_probe`.
5. Screenshots only for layout, and small crops.
6. `node scripts/ui-probe.mjs "<js>"` — press a control and read the glass without a screenshot.
   Start the app with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'`, then
   `node scripts/ui-probe.mjs "document.querySelector('[data-takeover]').click()"`. The badge file
   above is still the artifact to read; this only clicks and evaluates JS (`--reload`, `--console`).

## Known open items (in the order I would take them)

1. **`-ts` round trip — done, and it needed a correction.** `-ts` is a fraction of LAYERS and
   llama.cpp ceils it (`il < ts*n_layer`, float fractions): `-ts 0.550` loaded 23 of 40 blocks,
   not 22. The plan now reads an applied split that way and writes `0.549` for 22/40; TAKEOVER
   persists it through `save_provider` (a file-only write left the provider state stale, so the
   glass and the CLI disagreed until restart). The bars paint the plan's per-card MiB, not the
   fraction. Verified: 22/40 → 89.7/91.4 GB painted against 92.1/91.9 measured.
2. **Bars repaint on TAKEOVER without restart — verified.**
3. **SPEC/draft is not in the learned key** and has no budget term — DSpark and non-spec runs collide.
4. **Auto-arming the handover** (plan over free, or previous run `fit_changed: true`) with the
   `arch_capabilities::tensor_split_denial` guard. Today TAKEOVER is a click only.
5. **`ptype: text` in the config editor** — root cause of "persists and reaches the CLI but the UI
   has no row": `useConfigResolver` skips params with no `values` (line ~147), so `config` never
   carries `tensor_split`. The glass reads the param's `defaultValue` instead; the editor row is
   still missing.
6. **Runtime residual sampling** — a second sample is taken 8 s after load; decide if a settled
   30 s sample is better for the accuracy/speed trade.
7. **Per-card compute at an unmeasured ctx** — the plan splits the compute total evenly when the
   planned ctx has no learned row (DSV4.1 @795648: painted 89.7/91.4 vs measured 92.1/91.9).
   The measured per-device pair is used when the ctx matches; a components-bearing learned curve
   would let it follow the placement, since the last device's buffer is ~1.7× the first.
8. Deferred: multi-GPU (>2) planning, per-layer KV variance, `split=tensor` keys.

## Traps that cost real time here

- Tauri `fn` commands run on the main thread → freeze. Use `async` + `spawn_blocking`.
- Never recurse while holding `STORE_MUTEX` (plain std mutex) → whole UI "not responding".
- `CUDA_Host` starts with "CUDA" — a prefix test charges host memory to GPUs.
- GGUF tensor size must come from file offsets; a type table misses unknown ggml types (silently
  dropped 32 GiB).
- If the session log's per-device fit lines are missing from a snapshot, parse the slot's
  `stderr.log` (rolling buffer scrolls them out).
- Gate before commit. A red commit on a protected branch cannot be amended away.
