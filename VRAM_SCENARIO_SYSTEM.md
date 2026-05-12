# VRAM Scenario System — How It Works Now

## Overview

The memory forecast system estimates whether a model will fit on available GPU/RAM hardware given the user's config (CTX, KV quant, batch, parallel, split mode). It runs entirely in TypeScript on the frontend.

## Data Flow

```
Model selected + config changed
  → useScenarioEvaluator.ts builds ScenarioInput
    → scenarios_factory.ts evaluate(input)
      → computeValues() — pre-compute shared numbers once
      → Sequential dispatch: first matching scenario wins
        soloFit || soloPressure || soloSpill || multiSpill || multiFit || multiPressure
        → hw_locked fallback if none match
    → VramManifest returned to VramBadge for rendering
```

## computeValues() — The Pre-Computation Hub

Computes shared values used by all scenarios:

| Value | Source |
|---|---|
| `weightsGb` | Model file size (sum of all shards) |
| `kvCacheGb` | Formula from GGUF metadata: layers × head_kv × headDim × ctx × kvBytesPerQuant |
| `overheadGb` | **max(FIT-derived, formula-derived)** — FIT extrapolation residual vs default formula |
| `vramTotalGb` | Always = weightsOnGpu + KV + overhead + vision (guarantees guard/display consistency) |
| `gpuAvailable[]` | Per-GPU free VRAM from nvidia-smi telemetry |
| `splitActive` | Split mode ≠ "none" |

**Critical:** `vramTotalGb` is always the sum of components. Scenario guards and UI display see the same number. This was fixed to prevent a bug where FIT extrapolation produced one number for guards while the manifest displayed another.

## The 6 Scenarios + Fallback

| # | Scenario | Guard Condition |
|---|---|---|
| 1 | `SOLO_FIT` | Fits on one GPU with ≥1GB headroom, split not active |
| 2 | `SOLO_PRESSURE` | Fits on one GPU but <1GB headroom (tight), split not active |
| 3 | `SOLO_SPILL` | Doesn't fit on one GPU, spill fits in RAM, split not active |
| 4 | `MULTI_SPILL` | Doesn't fit across all GPUs, spill fits in RAM |
| 5 | `MULTI_FIT` | Split active OR doesn't fit solo; fits across GPUs within headroom; no GPU >90% |
| 6 | `MULTI_PRESSURE` | Split active; doesn't fit solo; fits across GPUs; at least one GPU >90% |
| — | `HW_LOCKED` | Fallback — always matches if nothing else did |

Each scenario is a **self-contained silo** in its own `.ts` file. It owns: guard logic, math, style, UI template text, and manifest construction. No cross-scenario imports.

## FIT Scan Integration

### Library Scan (27 points per model)
- Runs `llama-fit-params --fit off --n-gpu-layers 999` at fixed anchor configs
- All points run with flash attention ON (required for non-f16 KV quant on modern architectures)
- Incremental: only scans missing labels, skips models with all points cached
- Cache stored in `fit_scan_full.json`, survives app restarts

### On-Demand Validation (`fit_scan_model`)
- Single scan at user's current config — gives real measured VRAM total
- Parsed memory breakdown provides per-GPU component data (model/ctx/compute)
- Result shown as "CERTIFIED" in VramBadge with scale factor vs estimate

### How FIT Data Is Used
1. `extrapolateVramFromPoints()` starts from the `base` point and extrapolates for user's ctx/batch/parallel/split
2. Overhead is derived as residual: `max(extrapolated - weights - KV, formulaOverhead)`
3. This ensures FIT data improves accuracy when available but never makes estimates worse

## VramBadge — Dumb Renderer

Reads everything from `manifest.style.uiTemplate`:
- Text strings (`gpuLayerText`, `ramLayerText`)
- Visibility flags (`showRamBar`)
- Colors (`titleColor`, `gpuBarColor`, etc.)
- Contains **zero** scenario logic or hardcoded text

## Key Gotchas

### Config Fingerprint
`useScenarioEvaluator.ts` uses a fingerprint string of config keys to trigger re-evaluation. If a param affects VRAM but isn't in the fingerprint, toggling it won't update the forecast. Current keys: Device, Split, Offload_Mode, CTX, KV-Quant, Batch, uBatch, Parallel, Flash-Attn, Offload, Vision.

### n_head_kv = 0 → KV Cache = 0
If the GGUF scanner doesn't recognize the model's key name for KV head count, `n_head_kv` stays 0 and KV cache computes to zero. This severely underestimates VRAM for large context configs. The GLM-DSA architecture was one example.

### FIT Scan Limitations
- Reports static memory only — dynamic activation from batch/ubatch is not captured by llama-fit-params
- Sharded models: FIT runs on first shard only, but catalog correctly sums all shards for file size
- `model` column in memory breakdown may be lower than file size due to GGUF overhead (headers, padding, non-weight tensors)

### Overhead Formula Constants
The activation coefficient (1.5) and workspace coefficient (0.375) are uncalibrated approximations. See `FIT_CALIBRATION_FUTURE.md` for the plan to derive them from FIT batch sweep data.

## Files

| File | Purpose |
|---|---|
| `src/hooks/useScenarioEvaluator.ts` | Hook: builds input, debounces re-eval, manages state |
| `src/services/vram/scenarios/scenarios_factory.ts` | Factory: computeValues, extrapolation, orchestrator, helpers |
| `src/services/vram/scenarios/solo_fit.ts` | SOLO_FIT scenario |
| `src/services/vram/scenarios/solo_pressure.ts` | SOLO_PRESSURE scenario |
| `src/services/vram/scenarios/solo_spill.ts` | SOLO_SPILL scenario |
| `src/services/vram/scenarios/multi_spill.ts` | MULTI_SPILL scenario |
| `src/services/vram/scenarios/multi_fit.ts` | MULTI_FIT scenario |
| `src/services/vram/scenarios/multi_pressure.ts` | MULTI_PRESSURE scenario |
| `src/services/vram/scenarios/hw_locked.ts` | HW_LOCKED fallback |
| `src/components/VramBadge.tsx` | Dumb renderer for forecast UI |
| `src-tauri/src/fit_scanner.rs` | FIT scan: command builder, output parsing, library scan |
