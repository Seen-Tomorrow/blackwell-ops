# Handover — PLAN / TAKEOVER review

> Superseded 2026-11-15 by `docs/PLAN-PLACEMENT.md`: the manual ENGINE FIT / APP TAKEOVER
> switch is gone, placement is automatic for every multi-GPU layer split, and SPLIT EQ is
> the manual nudge. Keep this file for the measurements and landmines it records.

Date: 2026-11-15. For a fresh session whose job is to review the *placement* feature: the layer plan
and the ENGINE FIT ↔ APP TAKEOVER switch. It is functional but clumsy; this file is what to know
before touching it.

## What the app does, in one line

Solo-dev desktop app for running local GGUF engines (llama.cpp forks under `ggml-master`). The glass
(a heavy bezel-styled badge) answers one question: does this model fit, and where do the layers go.

## Where we are after this week

- **Forecast is measured-only.** Learned rows per model family (weights / KV / compute / host), an
  affine compute fit over (ctx, ubatch), and a single on-demand FIT probe for models with no launch
  yet. Validated to ±0.3 % on the 27B across four ubatch levels.
- **Learned store has a schema stamp** (`STORE_SCHEMA` in `src-tauri/src/vram_learn.rs`). Bump it by
  hand when the *maths* changes, never per build; a mismatched store is discarded, not converted.
- **Library-wide FIT scan is gone** (`c21e54eb5`, `2a8a006cf`). No background GPU passes, no catalog
  fit badges. The metadata pass and its strip remain.
- **Vendor patches** (4): `memory-endpoint`, `memory-ledger` (both ours), `single-model-load-sse`,
  `telemetry-sse`. They give `/memory` (ledger of actual allocations) and the SSE telemetry stream.
- **WDDM fit is blind** (measured): `--fit` reads CUDA's *budget* (VRAM + shared system RAM), not
  physical free. Guard: when the target GPU already has >4 GiB in use (ours or external) the launch
  gets `--fit off` and logs the numbers. Confirmed live.

## The placement pipeline as it exists

1. **Plan** — `src/lib/vramLayerPlan.ts` `planLayerSplit()`: given per-block MiB, per-GPU budgets
   (after reserve + runtime overhead + draft), KV per layer, writes `boundary` (blocks on GPU0),
   `ts`, `applyTs`, `optimalBoundary`, per-GPU `weightsMib`/`kvMib`/`totalMib`/`util`, `sumMib`.
   Consumed by `src/hooks/useLayerPlan.ts` and displayed in the glass.
2. **Switch** — `VramBadge` "VRAM PLACEMENT": `ENGINE FIT` (fit on, no `-ts`) vs `APP TAKEOVER`
   (fit off + `split=layer` + `-ts` from `applyTs`). State is `fitOff` in `EngineConfigPanel`
   (persisted under `KEYS.fitOff`).
3. **Apply** — `EngineConfigPanel` `onApplyPlan(tensorSplit)`: `updateParam("split","layer")`,
   `updateParam("tensor_split", …)`, then **`save_provider`** with the row's `defaultValue` replaced,
   then `reloadProviders` + `paramConfigChanged`. Release path clears `-ts` first (a leftover makes
   `--fit` bail with "tensor_split already set").
4. **Launch** — `buildLaunchConfig` adds `__fit_off` when takeover is on; `tensor_split` rides as a
   flat config key and reaches the CLI as `-ts` through the provider template's text row.
5. **Forecast consumption** — `layerSplitMib` (plan per-card MiB) is passed to the adapter, which
   scales the learned/probe total by each card's share, then adds the measured per-card runtime
   residual. Plan is **placement only**: it must never appear as a second forecast number (we removed
   the "plan 41.0" chip from NEED for exactly that reason).

## Why it feels clumsy — concrete evidence from this session

- **The switch is not the whole story.** `fitOff` + no `-ts` (the busy-card guard, a fresh profile, a
  takeover that failed to persist) means llama picks its own split. So "APP TAKEOVER" can mean "plan
  honoured" *or* "llama defaults", and the glass cannot tell you which.
- **`-ts` persistence is asynchronous.** `save_provider` → `reloadProviders` → launch. A launch in
  the same tick can miss the new value (observed: one launch without `-ts`, the next with
  `0.480,0.520`). No "placement applied, safe to launch" state exists.
- **Two numbers describe the layout.** One badge dump had `need 77.25 GB` while `plan.totalMib`
  was 50.5 GB. Plan is placement, forecast is need — but nothing on screen says why they differ.
- **`-ts` is a layer fraction; bytes are not uniform.** DSV4.1 blocks grow 2.9 → 4.5 GiB, so a
  fraction of layers is not a fraction of bytes. `applyTs` comes from the byte-balanced boundary and
  the forecast scales by `layerSplitMib`, but a plan's prediction and the engine's actual per-card
  placement have never been compared on a real launch.
- **The plan is silent about takeover confidence.** `plan.appliedBoundary` / `squeezed` /
  `fit_changed` exist; none of them reach the switch's tooltip.

## Verify first (cheap, before changing anything)

```powershell
python scripts/engine-test.py launch --model <27B gguf> --ctx 262144 --kv q8_0 --device 0 `
    --split layer --parallel 1 --alias PLAN-CHECK        # leaves it running
# after it is RUNNING:
Get-Content src-tauri/target/debug/config/logs/sessions/<session>/slot-N_*/launch.cmd.txt
#   → expect "-ts <plan ts>" and "--fit off" when takeover was applied
python scripts/engine-test.py snapshot
blackwell-ops.exe --nvram-diff <a.json> <b.json>          # ready vs pre_launch
```

Then compare **planned** vs **measured** per card:

- plan: `config/cache/forecast-log.jsonl`, rows `kind:"plan"` (`ts`, `boundary`, `gpu_mib`,
  `measured_compute_mib`).
- measured: the same journal's `kind:"measured"` row, the `ready` snapshot, or `/memory` from the
  patched engine (the memory log's `CORE` chip means the ledger answered).

The 27B and DSV4.1 are the two useful models: uniform-ish blocks vs blocks that grow.

## Design questions to settle

1. **One owner for placement.** Either the engine's fit owns it (takeover impossible) or the app owns
   it (logical: fit is blind on WDDM and cannot see neighbours). Today both exist and the switch is
   manual. Proposal to review: takeover by default whenever the card is shared, probe/fit only for a
   free card, and delete the manual switch.
2. **A real "applied" state.** `onApplyPlan` should resolve only when the provider save round-trips,
   and the LAUNCH control should be disabled (or the launch should await) until then.
3. **One number on screen.** Decide whether the plan total must equal the forecast need; if not, the
   glass must label them unambiguously (e.g. "need 77.3 · planned 50.5" only in takeover).
4. **Plan confidence.** Surface `appliedBoundary` vs `optimalBoundary`, `squeezed`, and the per-card
   util next to the switch, so "takeover" is a decision with numbers, not a toggle.
5. **Is the plan needed at all with one GPU?** Split none + one card means the plan only adds noise.

## Landmines

- `--fit` on WDDM is blind (budget). Never trust its "will leave N free".
- A leftover `-ts` makes `--fit` refuse to run ("tensor_split already set"). Clear it when handing
  placement back, always.
- Do not reintroduce the library-wide FIT scan: it wrote `fit_scan_full.json`, which fed committed
  VRAM estimates and produced per-card nonsense when stale. Deleted for that reason.
- `STORE_SCHEMA` is a hand bump; do not tie it to build ids (engines are rebuilt several times a day).
- Keep the plan out of the NEED chip. It is placement, not a second forecast.

## Where things live

| area | file |
|---|---|
| plan geometry | `src/lib/vramLayerPlan.ts`, `src/hooks/useLayerPlan.ts` |
| switch + apply | `src/components/VramBadge.tsx`, `src/components/EngineConfigPanel.tsx` |
| launch config | `src/lib/buildLaunchConfig.ts` |
| forecast math | `src/services/vram/forecast/adapters/ggml_master.ts` |
| learned store / fit / guard | `src-tauri/src/vram_learn.rs`, `fit_scanner.rs`, `engine_utils.rs` |
| engine ledger + `/memory` | `src-tauri/src/engine_memory_view.rs`, `foundry/patches/*.patch` |
| checks | `npm run check` (the one command), `npm run check:patches` |
