# FIT Scan Calibration — Future Work

## Problem

The current overhead formula uses uncalibrated constants for activation memory and batch workspace:

```typescript
// scenarios_factory.ts ~line 417-418
let activationOverheadGb = (ubatch * parallel / 1024) * 1.5 * (n_embd / 4096);
const batchWorkspaceGb = Math.min((batch * parallel / 1024) * 0.375, 2.0);
```

The coefficients `1.5` and `0.375` are rough approximations — directionally correct but off by ~20-40% vs real measured data from `fit_scan_model` validation runs.

## Why FIT Can't Fully Solve This

`llama-fit-params --fit off --n-gpu-layers 999` gives static memory (weights + KV cache + base CUDA overhead) but does **not** account for dynamic activation memory that depends on batch/ubatch at runtime. The `compute` column in the memory breakdown is just base context overhead, not batch-dependent activations.

## Available Data

The FIT library scan has **batch sweep points** designed to measure this:
- `batch_128`, `batch_256`, `batch_1k`, `batch_2k`, `batch_4k`, `batch_8k` — all at ctx=128K, q4_0, parallel=1
- These give a real curve of how VRAM grows with batch size for each model

## Proposed Approach

### 1. Derive Activation Rate from FIT Batch Sweep

Replace the single-point estimate:
```typescript
// Current — one data point
return (base.vram_mib - noBatch.vram_mib) / 512;
```

With linear regression across all batch sweep points to get a proper slope of VRAM growth per batch token. This is more accurate and handles non-linear scaling.

### 2. Apply Measured Rate to User Config

In `computeValues()`, when FIT data exists:
- Use the measured activation rate × user's effective batch tokens (ubatch + batch) instead of the formula guess
- The FIT-derived rate already captures both activation and workspace since they were measured together at ubatch=batch
- Activation memory is mostly fp16/bf16 regardless of KV quant, so the q4_0-measured rate should be valid across KV quants

### 3. Keep Formula as Fallback

When no batch sweep points exist (partial scan or new model), fall back to the formula with current constants. The `max(fitOverhead, formulaOverhead)` approach already in place handles this gracefully.

## What's Needed to Implement

1. Add a simple linear regression helper for the batch sweep points
2. Modify `computeValues()` to use FIT-derived activation rate when available
3. Validate against several `fit_scan_model` runs at different batch/ubatch configs
4. Tune if needed — but the data-driven approach should be within 5-10% of reality

## Current Status

The system works well enough for practical use. Estimates are conservative (slightly overestimate), which is the desired behavior — better to predict "might not fit" than to get an OOM at launch time. This calibration would tighten accuracy from ~28% margin to ~10%.
