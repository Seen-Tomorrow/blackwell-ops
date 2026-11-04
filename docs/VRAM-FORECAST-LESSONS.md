# VRAM forecast — facts worth not rediscovering

Written 2026-11-04 after a day of measuring, breaking, and re-measuring the layer-plan forecast on
2 × RTX PRO 6000 (96 GB, TCC) with Qwen3.8-27B / Qwen3.8-Flash. Everything below is measured on this
box unless marked otherwise. Keep it short; add only facts that cost time to learn.

## What "reality" is

The number a launch reports in `learned-vram.json` (`vram_mib`) is the **sum of the GPU buffer
lines**, not NVML `used`:

```
model + kv + compute + rs + vision_compute   (CUDA<digits> only)
```

- `model` = weights the engine actually placed on that GPU — **not** the GGUF total. Host-side
  tensors are excluded (Q6_K: 21,814 MiB of file vs 20,475 on the devices; UD-IQ3_XXS: 10,418 vs
  9,685).
- `kv` = `llama_kv_cache`, linear in ctx.
- `compute` = `sched_reserve`, **affine in ctx** for a fixed shape/batch/split: `a + b·ctx`,
  measured `a ≈ 2,826 MiB`, `b ≈ 70 MiB per 1k tokens` on Qwen3.8-27B (batch 8192, split layer).
  Scales strongly with batch (14,064 MiB at batch 2048 vs 20,119 at 8192, same ctx) and ~4×
  between `split=none` and `split=layer`.
- `rs` = `llama_memory_recurrent` — recurrent/hybrid state, the KV equivalent for SSM layers, not
  "reserved system". Roughly constant in ctx.
- `vision_compute` = vision encoder buffers (`reserve_compute_meta`) when an mmproj is loaded.
- **The CUDA context (~625 MiB/device, calibrated) is in neither side.** `NEED`/`MEASURED`/`LEARNED`
  and the plan all describe the buffer inventory. NVML `used` = inventory + context. Decide which
  basis you want before comparing numbers; do not mix them.

Buffer parsing must use `CUDA<digits>` only: `CUDA_Host` starts with "CUDA" and carries 3–9 GB of
host compute, which a prefix test charges to every GPU (`vram_learn::cuda_device_index`).

## What transfers between models

Compute buffers depend on the **shape**, not the weights. Q4_K_M (15.9 GB) and UD-IQ3_XXS (10.2 GB),
same architecture and ctx/batch/split: compute identical to the MiB (7,411 @64K, 21,075 @256K).
So a shape profile learned from any sibling predicts the others — this is what the cold forecast
(`vram_profile.rs`) uses. Weights are exact from the GGUF tensor table.

KV is **not** derivable from `n_embd / n_head` on every arch: Qwen3.8 has `n_embd 2560`, 24 heads
(106.7) but real head size 256 via `attention.key_length`. Hybrid models keep KV in only some blocks
(12 of 48/65 seen) — that fraction is what `kv_layer_ratio` measures; raw geometry over-reads ~7×.

GGUF tensors: size them from **file offsets** (`next_offset − offset`), not only the type table.
A model shipped 202 tensors of ggml type 42 that the table did not know, silently dropping 32 GiB.

## Learned store

- Key: `provider|ctx|kv|topo|split|batch|ubatch|offload|cache_ram` (+ draft when external).
  `mode` (assisted/full_auto) is **not** in it — a UI mode, no memory effect.
- `batch`/`ubatch` **must** be in the key: same model/ctx/kv/split differed by 43 % between batch
  2048 and 8192.
- Lookup: exact ctx → interpolation between the two bracketing rows → nothing. Never splice rows:
  an earlier `.or(Some(entry))` produced KV from the 256K row with compute from the 64K row.
- kv / split / batch / ubatch are **hard filters**, not score bonuses. Scoring kv at +2 let an f16
  row win for a q8_0 config (1.88× the KV).
- The learned-curve display clamps outside the measured range (`beyondMeasured`) instead of
  extrapolating: linear extrapolation of the total under-reads above the top point, which is the
  direction that lets a launch spill.

## Forecast / plan pitfalls hit today

- **Tauri `fn` commands run on the main thread.** Header parsing (`get_model_layer_bytes`) froze the
  window for seconds until made `async` + `spawn_blocking`; cache by (path, mtime).
- **Never recurse while holding `STORE_MUTEX`** — plain `std::sync::Mutex`, so the second lock
  deadlocks the whole command surface (app shows "not responding" + spinner).
- A FIT probe measures **one ctx**. Reusing it raw at another ctx was off by tens of GB; dropping it
  left an empty manifest (infinite `EVALUATING`). Scale it with `adjustMeasuredGbForCtx`.
- `block_in_place` panics on a current-thread runtime; use `spawn_blocking` in commands.
- Plan total: derive overhead as `vram_mib − model_mib − kv_mib` rather than transporting per-device
  compute arrays — arrays arrived short and a card silently got zero. This makes the plan total equal
  the learned total by construction; the plan's value is **per-GPU placement**, not a better total.
- Between measured points the plan total ≡ the learned curve. A better total needs the component
  model (`weights + kv + a + b·ctx`), which is the only way to extrapolate past the last point.
- Foregoing the last point's extrapolation cost us a mis-read at 1M until it was measured.

## Dev tooling built today (keep)

- `scripts/engine-test.py` + `src-tauri/src/automation.rs` — DEV-only folder queue
  (`config/automation/queue|results`) that runs the app's own `launch_engine`: launch/hold/stop,
  status, and `cold` forecasts. No UI, no screenshots, no second launch path. ~5 s per launch.
- `scripts/forecast-compare.py` — prints fit / plan / measured per configuration from
  `forecast-log.jsonl`, recovering a `measured` row's config from its `learn_key`.
- `forecast-log.jsonl` rows: `prelaunch` (FIT), `measured` (launch), `plan` (with `kv_source` and
  raw inputs), `fit_probe`. Plan rows are throttled to one per configuration; per-recompute logging
  produced 6,000 rows in a session.
- `PRUNE CFG` (far left of the CTX footer) wipes every learned point of the current model+kv/split.
  It ignores batch, so it also clears other batch variants.

## Still open

- **SPEC/ draft is not in the learned key** (`spec_type`/`draft_key` accepted and ignored), so DSpark
  and non-spec runs collide, and the plan budget has no draft term.
- **The plan is not wired to placement** — nothing consumes it to set `-ts`/`-ngl`; it is a second
  opinion in the UI only.
- `split=tensor` writes a key the layer path will not match.
- ctx above `n_ctx_train` is capped by the engine ("exceeding the training context - capping"), so a
  forecast above that describes a configuration the launch will not run unless rope scaling
  (`--rope-scaling` / `--yarn-*`) is exposed in the template.
## The engine's own fit log is the ground truth for "does it fit"

On load with `-fit on`, llama-server prints the decision and the placement it will use. Parse these,
do not infer them:

```
common_params_fit_impl: - CUDA0 (...): 97475 total, 80524 used, 16394 free vs. target of 1024
common_params_fit_impl: projected to use 176042 MiB of device memory vs. 193840 MiB of free
common_fit_params: targets for free memory can be met on all devices, no changes needed
```

- `no changes needed` = it fits as requested. Any other variant means it **shrunk something** - the
  speed cliff (compute/batch reduced) with the model still loading.
- Its per-device split can be very unbalanced (80,524 / 95,517 MiB seen on 2x96 GB), and it will not
  match our plan's split. Painting our placement against free VRAM therefore contradicts the engine:
  a 512K run printed `OVER FREE - SPILL` while the engine reported 176,042 vs 193,840 free.
- Capture `fit_verdict`, `fit_projected_mib`, `fit_changed` and the per-device used/free into the
  learned entry. That is the squeeze detector's input and it removes the guesswork from SPILL paint.

- Runs here use `--mlock` + mmap: GPU inventory stays comparable, host accounting does not. Never
  compare host totals across mlock/mmap runs; use GPU terms only.
