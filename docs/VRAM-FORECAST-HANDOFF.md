# VRAM forecast — session handoff (2026-08-19)

Continue from here. Canonical product law is this file **plus** `docs/VRAM-FORECAST.md` (that doc is **stale in §1** — ctx is no longer a probe-killer; estimate order is not a flat LEARNED>probe). Prefer this handoff until someone rewrites the canonical doc.

---

## What we were solving

1. Formula overestimate forced layer-split; FIT probe proved single-GPU; **picking a GPU dropped the probe** (fingerprint included `device`/`split`).
2. Forecast wrote `split: layer` into user config (sticky).
3. Formula is ancient; live path should be **measurement + CTX curve**, slider stays fluid.
4. Learned was “last row only” and blocked probes; interpolation then lied by tens of percent.

User confirmed the new shape is the right call. Last live bugs we just fixed: hero GB frozen vs bars, bezel jump, probe-vs-curve overshoot (4K FIT stretched past a 128K launch).

---

## Live law (as implemented)

### Estimate (AUTO_FIT)

```
exact LEARNED at this ctx
  → piecewise interp of measurement curve
       (all learned ctx points ∪ session FIT probe at its anchor ctx)
  → FIT probe GQA-stretched only if the curve has <2 points
  → one-point learned + GQA delta (same)
  → formula (last resort)
```

`manifest.vramTotalGb` is the number chrome, hero, bars, and launch must use. Do **not** display `validatedVramMib` for the hero — that is the raw probe at one ctx.

### Keys (`useScenarioEvaluator.ts`)

| Key | Contains | Invalidates |
|---|---|---|
| `placementConfigKey` | `device\|split\|gpu_sync` | nothing (re-slice bars) |
| `hardFootprintKey` | kv, batch, ubatch, flash, vision, rope, cache_ram, spec, draft, backend, fit, mode | probe session + auto-FIT + learned **fetch** |
| `liveEvalKey` | placement + hard + **ctx** | re-eval only (slider) |

CTX is **not** a hard knob. Probe session stores `hardKey` + `anchorCtx`.

### Auto-FIT

- Fires after learned fetch if **no exact ctx** on the learned curve.
- **One in-flight** (`validatingRef` set and cleared in `finally`).
- Probe IPC: **`splitMode: "none"`**, `offloadMode: "regular"`, `parseCtx` for ctx.
- Skip auto-FIT only if **best free GPU < 2.5 GB**. Engines on other cards do **not** skip.
- Fail → `scheduleEvaluation` (formula), not a permanent empty shell.
- While probe in flight and no learned/probe yet → `commitManifest(null)` (skeleton). After fail, formula paints.

### Learned curve

- Backend: `get_learned_vram_curve` in `vram_learn.rs`.
- Matcher: key starts with `{path_norm}|{provider}|` + same `kv` + spec/draft + **same split** (`none` vs `layer` vs `tensor`). Device ignored.
- Writes still include device/split in the key (separate rows). Curve **read** no longer mixes split-none with layer/tensor — a layer launch cannot overwrite the none interpolation point.
- Newest `measured_at` wins per ctx.
- Frontend: `learnedCurveRef` + `input.learnedCurve`; refetch when `config.split` changes.
- Merge session probe as a curve **point** at `fitProbeAnchorCtx` if that ctx has no learned row **and chrome split is none**. Layer/tensor never inherit the none-FIT probe.
- Then interpolate.
### SOURCE

| Kind | Chip | When |
|---|---|---|
| `learned` | **LEARNED** cyan | Exact launch at this ctx |
| `learned_curve` | **LEARNED ≈** same cyan | Between stored (and probe) points |
| `fit_probe` | FIT PROBE amber | Probe-only / GQA stretch |
| `fit_cache` | FIT CACHE violet | Library spine, no live measure |
| `formula` | FORMULA muted | Fallback |

### CTX slider

- Fluid: hard key unchanged → re-eval applies curve interp.
- **Arrow keys** when thumb focused (`CustomSliderParam`: role=slider, tabIndex=0). Page/Home/End too.
- **Cyan ticks** at `manifest.learnedCurveCtxs` (`learnedMarks` → `CockpitCtxStrip`).

### Phosphor height

- Forecast canvas pinned to `FORECAST_PHOSPHOR_HEIGHT_PX` (250) for skeleton **and** live.
- `useForecastContentHeight(..., false)` so content observer does not re-hug after probe.
- Skeleton: 250px + sweep animation (basic; user said “will do for now”).

### Library FIT scan

- `SCAN_PLAN` = **6 ctx points**: 4k / 32k / 64k / 128k / 256k / 512k (`q4_0`, batch 512).
- `FIT_SCAN_POINTS_TOTAL = 6`. Incremental: old 26-point caches still complete if those 6 labels exist.
- Model list: `model_catalog::is_launchable_main_model` (same Regular-tab draft filter).
- `detect_gpu_count()` is **process-cached** (`LazyLock`) — no nvidia-smi per model.

### Split / chrome

- Forecast does **not** write `split` into config (`EngineConfigPanel` auto-promote effect deleted).
- `hideSplitNone` is live overlay. Launch injects `split: layer` in `buildAutoVramLaunchParams` if needed.
- `resolveAutoLayerSplit` = `needsAutoLayerSplit(bestVramEstimateGb(manifest), free)`.

### Forecast vs measured log

- `{exe_dir}/config/cache/forecast-log.jsonl`
- `prelaunch` at spawn (`__forecast` on extra_params, not CLI).
- `measured` when launch buffer inventory persists.
- Join `learn_key`. Session line: `[forecast] prelaunch source=…`.

---

## Files that matter

| File | Role |
|---|---|
| `src/hooks/useScenarioEvaluator.ts` | Keys, probe session, auto-FIT, learned+curve fetch |
| `src/services/vram/scenarios/auto_fit.ts` | Estimate merge / hero / bars |
| `src/services/vram/scenarios/scenarios_factory.ts` | Formula leftover, `adjustMeasuredGbForCtx`, `interpolateLearnedCurveGb`, `gpuWeightFraction = 1` |
| `src/services/vram/memorySource.ts` | SOURCE chips |
| `src/lib/autoVramLaunch.ts` | One split number |
| `src/lib/launchChromePolicy.ts` | Chrome locks |
| `src/lib/buildLaunchConfig.ts` | `__forecast` stamp |
| `src-tauri/src/vram_learn.rs` | Store + **curve IPC** |
| `src-tauri/src/forecast_log.rs` | JSONL |
| `src-tauri/src/fit_scanner.rs` | 6-point plan + catalog filter |
| `src-tauri/src/telemetry.rs` | Cached GPU count |
| `src/components/CustomSliderParam.tsx` | Keys + learned ticks |
| `src/components/VramBadge.tsx` | Hero uses `vramTotalGb`; height pin |
| `docs/VRAM-FORECAST.md` | Older writeup — update or ignore §1 |

---

## Leftovers (do not treat as done)

**`moe_optimal`** — peel disabled (`gpuWeightFraction = 1`), badge `hideMoeBadge`. Still in factory JSON (`ggml-master` / tom / bee-llama), `templates.rs` `--fit off` if the chip is selected, `MoeBadge.tsx`, CSS gold/hatched. User asked delete; UI is hidden, templates not scrubbed.

**Formula** — `computeValues` still exists for probe-fail / <2.5 GB skip / no measurement. KV is still textbook GQA (`n_embd/n_head`). No MLA/SWA fields on `ModelMetadata`. Do not invent those slopes until GGUF scan grows them.

**`computeMoeAlternative`** — still in factory, no longer attached in `evaluate`.

**Library scan** — still q4_0/batch 512 spine only; live probe owns level at user knobs.

**Learned backend key** still includes device/split for **writes**. Curve **read** now filters by split. Device still ignored on read. Split-agnostic *totals* on write were explicitly not this pass.

**Auto-FIT VRAM spike** — probe is `split: none` on one GPU (~1–2 GB). Tight VRAM → skip auto if best free < 2.5 GB; manual RE-PROBE remains. Cannot make FIT free.

**Scan animation** — basic sweep; user OK for now. Bezel should stay 250px.

---

## How to verify after rebuild (Rust + UI)

1. Model with **no** learned: select → skeleton/sweep ~1s → FIT PROBE. Drag CTX; hero **and** bars move. SOURCE FIT PROBE until a launch.
2. Launch at 64K then 128K: cyan ticks on those ctxs. 65K ≈ just above 64K, **not** above 128K. SOURCE **LEARNED ≈**. Park on 64K → **LEARNED**.
3. Manual probe at a ctx with no launch: probe is a curve point; between probe and a learned ctx should interpolate, not GQA-stretch.
4. Tensor-split + unsupported model: probe `split: none` should not hang; fail → formula, slider still live.
5. Library FIT: no draft GGUFs; one `[telemetry] Detected N GPU(s)`; 6 points.

---

## Suggested next session (priority)

1. Rewrite `docs/VRAM-FORECAST.md` §1 to match this handoff (stale law will mislead).
2. Finish **moe_optimal** template/CLI deletion if still wanted.
3. Mine `forecast-log.jsonl` after a few launches (ratio by arch / kv).
4. Richer scan phosphor if the sweep is too thin.
5. Only then: MLA/SWA KV once metadata exists.

Do **not** put auto-FIT on the CTX slider. Do **not** reintroduce formula as the live level.
