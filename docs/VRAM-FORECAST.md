# VRAM Forecast — Current State

> **Partially stale (2026-08-19).** Live law, keys, and leftover list:
> [`docs/VRAM-FORECAST-HANDOFF.md`](VRAM-FORECAST-HANDOFF.md).
> This file is still useful for file map and older sections; §1 estimate order
> and “ctx invalidates probe” are **wrong** now.

Three facts, one number, one split check.

1. **How much** the model wants (footprint).
2. **Where** it sits (placement: device / split / `gpu_sync`).
3. **Whether it fits** that placement.

---

## 1. The law

### 1.1 Estimate priority

```
LEARNED  →  FIT probe  →  formula
```

| Source | What it is | When it exists |
|---|---|---|
| **LEARNED** | Last *real* launch for this footprint (`learned-vram.json` via `get_learned_vram`) | After at least one successful launch that persisted a row |
| **FIT probe** | On-demand `llama-fit-params` session in the evaluator | User ran FIT; session still valid for this footprint |
| **Formula** | `computeValues()` GGUF math (+ optional FIT *library cache* interpolation) | Always; last resort |

Learned is the most precise number we have. A FIT probe is a synthetic load, not a full engine. Formula is a guess.

First run of a new footprint: no learned row → probe if you ran one, else formula. After a launch saves, **learned wins even if a probe is still sitting in memory**.

**Exception (temporary):** `offload_mode=moe_optimal` still ignores learned. Those stored rows are regular-mode GPU footprints and would lie. See §6.

Learned is used in **FULL AUTO and ASSISTED**. FULL AUTO used to skip it; that is gone.

### 1.2 Placement never invalidates a measurement

**Footprint** (probe invalidates if any of these change):

`ctx`, `kv_quant`, `batch`, `ubatch`, `flash_attn`, `vision`, `unified_kv`, `rope_scaling`, `rope_scale`, `cache_ram`, `spec_type`, draft GGUF, `backend_type`, `offload_mode`, `--fit` on/off, full-auto vs assisted.

**Placement** (probe *stays*; bars re-slice):

`device`, `split`, `gpu_sync`.

Picking a GPU or toggling `split: none` must not throw away a FIT probe. That was the borderline-model trap (formula forces split → probe proves single GPU → user picks a card → fingerprint dropped the probe → formula forced split again).

### 1.3 One number for split / chrome / launch

`bestVramEstimateGb(manifest)` is the only GPU-side total those three may use:

- Learned → `manifest.vramTotalGb` (AUTO_FIT already committed learned + draft overlay).
- Else probe → `manifest.vramTotalGb` (probe + draft overlay).
- Else formula → `manifest.formulaVramTotalGb` so a *clamped bar* cannot shrink the decision.

`resolveAutoLayerSplit` is only:

```ts
needsAutoLayerSplit(bestVramEstimateGb(manifest), perGpuAvailable)
```

No `max(measurement, formula)`. No `weight × 1.05` floor on a measurement. No `autoLayerSplit` flag override. No “bars already span two GPUs so we must split” override.

`needsAutoLayerSplit`: estimate exceeds the *best single GPU’s free VRAM* minus `max(1 GB, 3%)` headroom. One GPU in the box → never auto-split.

### 1.4 Forecast must not write `split` into config

Auto-promoted `split: layer` is **not** a user choice. The old `EngineConfigPanel` effect that wrote / un-wrote `split` is deleted.

- Chrome: `hideSplitNone` is a *live overlay* (shows ALL / hides `none` when the estimate needs multi-GPU).
- Launch: `buildAutoVramLaunchParams` injects `split: layer` at spawn if the estimate needs it and the user did not pick a split.
- Stored `config.split` is only what the user picked.

---

## 2. Pipeline

```
useScenarioEvaluator
  ├─ footprintKey / placementKey / configKey
  ├─ learned fetch (IPC get_learned_vram)     ─┐
  ├─ FIT library points (get_fit_scan_points) ─┤
  └─ optional FIT probe session                ─┤
                                                ▼
evaluate(input)
  computeValues()          formula + optional FIT-cache residual
  auto_fit.tryEvaluate()   overlay LEARNED → probe → formula
                           one estimateGb → split, bars, hero
  attachMemorySource()     SOURCE label matches the overlay that won
  attachProbeManifest()    stamps validated* if probe still valid
```

`hw_locked` is only “zero GPUs” or “auto_fit declined” (`autoVramLaunch` off). It is not a third physics.

---

## 3. What AUTO_FIT actually computes

File: `src/services/vram/scenarios/auto_fit.ts`

```
estimateGb =
    learnedGb          // prior launch, + draft addon if Boost on and row is main-only
 ?? probeWithDraftGb   // FIT session + draft addon (probe never loads draft GGUF)
 ?? computed.vramTotalGb

autoSplit = needsAutoLayerSplit(estimateGb, freeVRAM[])

gpuProjectionGb = same priority as estimate (learned / probe / formula).
  Formula-only path may clamp the *bar* to free VRAM; formulaVramTotalGb stays unclamped.

perGpuLoad =
    learned breakdown   if learned won and length matches
 ?? probe breakdown     if placement still matches the probe
 ?? autoSplitPerGpuLoad or single-GPU targetGpuIdx
```

`learnedFromPreviousRun` on the manifest is true only when learned actually drove the overlay. SOURCE uses that flag, not “a learned row exists somewhere.”

Draft: FIT never loads the external draft GGUF. Forecast adds `draftWeightsGb + draftOverheadGb`. A learned row with `mtp_context_mib > 64` already includes draft; do not add again.

---

## 4. Probe session (evaluator)

File: `src/hooks/useScenarioEvaluator.ts`

| Key | Contents | Used for |
|---|---|---|
| `footprintKey` | §1.2 footprint params | Drop / keep probe |
| `placementKey` | `device\|split\|gpu_sync` | Re-slice bars if mismatch |
| `configKey` | placement + footprint | Re-eval, manifest cache, **learned re-fetch** |

Learned IPC is still keyed by `device` + `split` in Rust (`vram_learn.rs`). A GPU pick re-fetches; a missing row for that device falls back to probe/formula. Making learned *totals* placement-agnostic is a follow-on (backend fuzzy ignore device/split).

---

## 5. File map

| File | Owns |
|---|---|
| `src/lib/autoVramLaunch.ts` | `bestVramEstimateGb`, `needsAutoLayerSplit`, `resolveAutoLayerSplit`, `resolveSplitDriver`, launch param assembly |
| `src/lib/launchChromePolicy.ts` | Device/split chrome locks; uses the same estimate |
| `src/services/vram/scenarios/auto_fit.ts` | Overlay + hero / bars |
| `src/services/vram/scenarios/scenarios_factory.ts` | Formula, FIT-cache residual, `buildManifest`, orchestrator |
| `src/hooks/useScenarioEvaluator.ts` | Keys, probe session, learned fetch, FIT validate |
| `src/services/vram/memorySource.ts` | SOURCE label: learned → probe → FIT cache → formula |
| `src/lib/buildLaunchConfig.ts` | Calls `buildAutoVramLaunchParams` (no `weightGb`) |
| `src/components/EngineConfigPanel.tsx` | Does **not** persist forecast split |
| `src/components/GpuAssignPanel.tsx` | `hideSplitNone` treated as live split for ALL-GPU chrome |

---

## 6. `moe_optimal` — leave in place, scheduled for removal

`offload_mode=moe_optimal` is a **legacy product knob**. It peels expert FFN to host RAM in the formula and the badge. It is **obsolete as a strategy** and will be replaced (engine `--fit` + real learned launches already do a better job of host offload).

**Do not delete the path in this pass.** Marked in code. Known lies if you treat it as current architecture:

- Learned rows are regular-mode; AUTO_FIT skips learned when MoE-optimal is on.
- FIT library scans measure all experts on GPU; formula then “peels” experts — approximate.
- MoE-optimal launches with `--fit off`.
- `computeMoeAlternative` / `MoeBadge` still advertise it.

Replacement (later): drop the offload-mode fork. Regular + `--fit` + learned is the whole story. MoE expert placement becomes whatever the engine actually did on the last launch.

---

## 7. What this rewrite did *not* do

- **No formula calibration.** Formula is last resort; starving it with learned/probe is the maintainable path.
- **No hysteresis band** near the single-GPU boundary (old intent C5).
- **Learned backend key still includes `device` + `split`.** Totals are conceptually placement-agnostic; lookup is not. Follow-on.
- **C3 “fallback to next-best on footprint invalidation”** is implicit (drop probe → learned if row exists → else formula). No extra state machine.

---

## 8. Debug

“Why did it split?”

1. SOURCE chip: `LEARNED` / `FIT` / `FIT CACHE` / `FORMULA`.
2. `bestVramEstimateGb(manifest)` vs `max(gpu.vramAvailableGb) - headroom`.
3. If SOURCE is FORMULA after a probe: footprint changed (`ctx` / kv / batch / …), or you are on `moe_optimal`.
4. If SOURCE is FORMULA after a launch: learned key miss (ctx/kv/offload/draft/device/split) — check `get_learned_vram` args.

Do not add a fourth estimate. If chrome and launch disagree, one of them is not calling `bestVramEstimateGb`.

## 9. Forecast vs measured log

Each launch stamps `extra_params.__forecast` (not a CLI flag) and Rust appends JSONL:

`{exe_dir}/config/cache/forecast-log.jsonl`

| `kind` | When | Join |
|---|---|---|
| `prelaunch` | Engine spawn | `launch_id`, `learn_key`, SOURCE, `estimate_gb`, formula/KV split, arch dims, knobs |
| `measured` | Launch buffer inventory persisted | same `learn_key`, `vram_gb`, `host_mib` |

Session log also gets `[forecast] prelaunch source=… estimate_gb=…`.

Tune later: `ratio = measured.vram_gb / prelaunch.estimate_gb` grouped by `n_head_kv`, `source`, `kv_quant`.

## 10. Library FIT scan (CTX spine)

`SCAN_PLAN` is **6 ctx points** (`4k…512k`, q4_0, batch 512). Incremental: models that
already have those labels are complete; extra legacy points are ignored.

Live session FIT / learned remain the badge **level**. Library points are the
slider **spine** (piecewise interpolate). Hard knobs still need a live re-probe
(not in this slice).


## 11. Auto-FIT + CTX slider (B/C)

- **Hard knobs** (kv, batch, ubatch, flash, draft, vision, spec, backend) trigger a live FIT
  after learned miss. CTX is **not** a hard knob.
- Until probe/learned exists (and no engine is occupying GPUs), forecast stays on the
  skeleton — no formula flash.
- Live **level** = learned ?? FIT probe. CTX drag adds `adjustMeasuredGbForCtx`
  (library CTX spine if ≥2 points, else textbook GQA KV).
- Probe session key is `hardKey` (no ctx). Slider does not drop the probe.

`moe_optimal` peel is off (`gpuWeightFraction = 1`). Badge hidden. Factory JSON /
CLI sub_params may still exist until a later template cleanup.


