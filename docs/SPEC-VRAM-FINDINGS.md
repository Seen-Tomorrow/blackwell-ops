# SPEC VRAM findings - n_max, ctx, parallel, and the FIT gap

Date: 2026-11-16. For a fresh session picking up the VRAM forecast. The base forecast is in good
shape; this file records why the SPEC/draft part cannot be made exact with more learned keys.

## What was measured

On **Qwen3.8-27B dense** (built-in MTP), changing only `spec_draft_n_max` moved the total
significantly:

| n_max | VRAM need |
|---|---|
| 1 | 19.4 GB |
| 2 | 20.1 GB |
| 16 | 21.6 GB |

That is a ~2.2 GB spread from one CLI knob. The user also observed it grows with **ctx** and
**parallel**, additively. Our own launch measurements agree:

| Qwen3.8-27B, split layer, bf16, batch 2048 / ubatch 1024 | 64K | 256K |
|---|---|---|
| base | 16,079 MiB | 32,975 MiB |
| built-in MTP (default n_max 3) | +1,996 MiB | +4,300 MiB |
| external DFlash2 | +3,508 MiB | +3,508 MiB |
| vision on (`mmproj-BF16.gguf`) | +888 MiB (CUDA0) | +888 MiB (CUDA0) |

The MTP delta is not constant: it is the nextn head + draft KV + recurrent state + a second
compute graph, and it scales with ctx. DFlash's delta is flat-ish at these two ctxs because its
draft is small, but that is a model fact, not a rule.

MoE **Qwen3.8-Flash-Next UD-Q4_K_XL** at 64K/q4_0: 80,138 MiB GPU, 27,466 MiB PLE host table.
External MTP head adds 5,012 MiB GPU (+~949 MiB host net of PLE). PLE is host need, never VRAM.

## Why this cannot be expressed as more learned keys

The learned store already keys model, ctx, kv, split, offload, spec/draft and has spec deltas
interpolated over ctx. Adding `n_max` means adding a **third dimension** (`n_max x ctx x
parallel`), and adding `parallel` means a fourth. The delta is architecture-dependent (number of
nextn layers, draft head, attention type, graph buffers), so the tables do not transfer between
models. The learned cache would grow faster than it can be validated. Do not do it.

## What the forecast does today

- Base (no SPEC/vision) is exact for a measured row and interpolates over ctx between measured
  rows. This part is worth keeping.
- The spec delta is exact only for the config that was measured. The current 27B MTP delta was
  measured at the **default n_max 3**; changing n_max makes it an over/under-estimate by up to
  ~2 GB, more at high ctx/parallel.
- Vision adds `mmproj_size_mib` to CUDA0; measured +888 MiB, exact.
- PLE is added to host RAM need; it is not in the engine's host buffer ledger and is stored host
  NET of the table so it is not counted twice.
- `fitProbeKey` includes spec type/draft/parallel but not `n_max`; `fit_scan_model` and the
  stderr parser do not receive spec knobs. A FIT probe therefore measures the base config, not
  the speculative graph.

## The FIT gap (upstream)

`llama-fit-params` calls `common_fit_params` (`tools/fit-params/main.cpp`). That path plans the
main model's buffers; it does not load the speculative draft context or the mtmd projector.
Passing `--spec-type` / `--spec-draft-n-max` through the app would not make it measure them.
So a true general fix is upstream: `common_fit_params` must model the draft/nextn context and
the mmproj allocation. Until then no app-side arithmetic can be architecture-independent.

## Recommended contract

1. **Base forecast remains learned.** Weights + KV + compute, per ctx/kv/split.
2. **SPEC/vision is exact only for a measured config.** The current learned row is a real launch
   measurement; use it as the exact answer for that exact config.
3. **Unmeasured SPEC is a range, not a number.** If `n_max` / `parallel` / ctx / draft differs
   from the measured reference, the glass should say `SPEC UNMEASURED` (or show a range:
   base + measured delta ± the n_max spread) instead of claiming EXACT.
4. **One measurement per config, not a curve.** A real launch (or a future real-load probe)
   measured once and cached by `(model, ctx, kv, split, parallel, n_max, draft, mmproj)` is
   enough. That is a point, not a new family.
5. The long-term fix is the upstream `common_fit_params` support above.

## Files touched by the current implementation

- `src/lib/vramLayerPlan.ts`, `src/hooks/useLayerPlan.ts` - plan + vision GPU0 extra.
- `src/services/vram/forecast/adapters/ggml_master.ts` - exact learned first, probe fallback,
  vision add-on, host spill rules, PLE host.
- `src/services/vram/forecast/draftPath.ts`, `src/hooks/useScenarioEvaluator.ts` - spec/draft
  identity and validated draft pairing.
- `src-tauri/src/launch_memory_parse.rs` - multi-model spec launch parse, dedup re-reserve,
  h_nextn/layer_input.
- `src-tauri/src/log_hub.rs` - use stderr when the `(device, kind, tag)` ledger is partial.
- `src-tauri/src/vram_learn.rs` - additive spec deltas, sentinel normalization, host net of
  PLE, no cache_ram in the key.
- `docs/VRAM-FORECAST-LESSONS.md` - measurements and traps.

## Next steps for a fresh session

1. Decide whether to implement the `SPEC UNMEASURED` state (no more keys) or a real-load probe.
2. If probing: add `n_max`, `parallel`, `mmproj` and the validated draft to the probe identity;
   a real launch is required because `llama-fit-params` cannot see the draft.
3. Do not add `n_max` to `learned-vram.json` unless a bounded 2D table proves stable across at
   least two architectures.
4. Revisit only if upstream `common_fit_params` gains draft/mmproj support.
