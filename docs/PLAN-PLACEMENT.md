# Layer placement - one owner, N cards, mixed VRAM

Date: 2026-11-15. Supersedes the placement half of `PLAN-TAKEOVER-HANDOVER.md`.

## Decision

The app owns placement for every **multi-card layer split**. There is no `ENGINE FIT` /
`APP TAKEOVER` switch anymore: a launch either carries the app's boundaries or there is no
split to place (one card, `split=none`, or no layer table yet). `SPLIT EQ` is the manual
nudge for the last case - it re-reads free VRAM, balances the split and arms it for the next
launch.

Why one owner: `--fit` reads CUDA's WDDM budget, not physical free memory, so it cannot see a
card that already hosts another engine (measured 2026-11-09: NVML 3,518 MiB free while a fresh
`llama-server` reported 36,549 MiB). The app can see it, has the exact block table, and can
express whole-layer boundaries. Two owners meant the glass could not tell whether "takeover"
produced the plan or the engine's defaults.

## Geometry

`planLayerSplit()` in `src/lib/vramLayerPlan.ts` now takes two or more budgets:

- Contiguous layers per device, found by a min-max DP over `(device, blocks consumed)`.
  It minimises the worst `perCardTotal / perCardBudget`; a second key (sum of squared
  utilisations) spreads the remaining slack.
- Mixed capacities therefore balance by **utilisation**, not by bytes: a 24 GiB and a 48 GiB
  card both finish at the same fill fraction, so neither hits its ceiling and neither keeps
  20 GiB idle.
- Per-device totals include weights (per-block weights, plus `output` on the last card;
  `token_embd` is CUDA_Host and stays out),
  KV on the layers that carry it, and measured compute buffers / calibration residuals.
  A device with extra unplanned buffers gets fewer layers - that is the GPU0-buffer correction
  the planner can express today.
- `boundaries` is the cumulative whole-layer tuple; `deviceLayers` is the per-card count.

### `-ts` is a layer fraction

The engine normalises the fractions to cumulative split points and assigns layer `il` with
`upper_bound(split, il / (n_layer + 1))`. That is `ceil(cumulative * (n_layer + 1))`, measured
on DeepSeek-V4.1 (40 blocks, `--fit off`): `0.550 -> 23`, `0.575 -> 24`, `0.563 -> 24`.
The writer puts each boundary in the middle of its band, `(b - 0.5) / (n_layer + 1)`, and
emits 3 decimals. For N cards the same rule applies to every cumulative prefix.

## Launch contract

- `buildLaunchConfig` takes a `placement: { tensorSplit }`. It writes `tensor_split`, forces
  `split=layer` and adds `__fit_off` **into `extra_params`**, which the template resolves ahead
  of the saved provider row. The CLI sees the exact boundaries on the same click.
- No provider save is involved. The old `save_provider -> reloadProviders -> launch` path was
  async and a same-tick launch could miss the value.
- When the launch is not app-placed, `tensor_split` is explicitly blanked in `extra_params`.
  A leftover `-ts` makes `--fit` abort with `tensor_split already set by user`.
- Only `split=layer` on more than one GPU uses the layer geometry. Row/tensor split and single
  card launches keep the engine's own fit.

## Glass contract

- `AUTO` - this launch carries the plan's `-ts` and fit off. The detail is
  `layers-per-card · -ts`, and the tooltip lists per-card MiB against budget.
- `ENGINE` - no multi-card layer split to place. The engine keeps its own fit.
- `SPLIT EQ` - re-reads free VRAM, turns on `split=layer` if needed, and re-arms the plan.
  It is a trigger, not a mode.

## Verify

```powershell
npm run check
# Optional live check: launch a 2-card layer split, then
Get-Content src-tauri/target/debug/config/logs/sessions/<session>/slot-N_*/launch.cmd.txt
#   -> expect "-ts <plan ts>" and "--fit off"
python scripts/engine-test.py snapshot
```

Compare `kind:"plan"` rows (`boundaries`, `device_layers`, `gpu_mib`, `ts`) against the
`ready` snapshot or `/memory` ledger. The 27B (uniform-ish blocks) and DSV4.1 (growing blocks)
are the two useful models.

## Not done / next lever

Unplanned buffers that land on one card are only modelled when a measured launch exists
(`overheadMib`, calibration). A learned per-card placement residual (actual minus planned,
next launch) would close that loop; the learned store already keeps `gpu_breakdown_mib`, but
nothing yet feeds it back into `planLayerSplit`.

The KV term is still `kvPerLayer * layerCount`. Hybrid attention models (Qwen3.8-Flash caches
KV in 12 of 48 blocks) make that an overestimate because the planner spreads KV across every
block. It does not move a uniform split (the factor is the same on both cards), but a per-block
`kv_blocks` flag from the header would make the plan's absolute totals honest and sharpen the
mixed-capacity case.

## Landmines

- `--fit` on WDDM reads a budget, not physical free. Never trust "will leave N free".
- A stale `-ts` makes `--fit` refuse to run. Blank it on every non-placed launch.
- Do not reintroduce the library-wide FIT scan (stale per-card numbers).
- `STORE_SCHEMA` is a hand bump, never tied to build ids.
- The plan is placement, never a second forecast in NEED.
