# VRAM forecast

Current product law. There is no historical appendix.

Live level = **measurement + CTX curve**. Formula is last resort. Library FIT scan is not a SOURCE.

---

## Estimate (AUTO_FIT)

```
exact LEARNED at this ctx + this split
  → piecewise interp of the measurement curve
       (learned ctx points ∪ session FIT probe at its anchor ctx,
        probe only if chrome split is none)
  → FIT probe GQA-stretched only if the curve has <2 points
  → one-point learned + GQA delta (same)
  → formula (GGUF math only)
```

`manifest.vramTotalGb` is the number chrome, hero, bars, and launch use. Do **not** display `validatedVramMib` as the hero — that is the raw probe at one ctx.

Do **not** auto-FIT on the CTX slider. Do **not** use library FIT interpolation as the live level.

---

## Keys (`useScenarioEvaluator.ts`)

| Key | Contains | Invalidates |
|---|---|---|
| `placementConfigKey` | `device\|split\|gpu_sync` | nothing (re-slice bars) |
| `hardFootprintKey` | kv, batch, ubatch, flash, vision, rope, cache_ram, spec, draft, backend, fit, mode | probe session + auto-FIT + learned **fetch** |
| `liveEvalKey` | placement + hard + **ctx** | re-eval only |

CTX is not a hard knob. Probe session stores `hardKey` + `anchorCtx`.

CTX-only slider moves evaluate **immediately** (curve math). Other config chatter stays debounced (~150ms).

---

## Auto-FIT

- After learned fetch, if there is **no exact ctx** on the learned curve for the current split.
- One in-flight (`validatingRef`, cleared in `finally`).
- Probe IPC: `splitMode: "none"`, `offloadMode: "regular"`, `parseCtx` for ctx.
- Skip only if best free GPU < 2.5 GB. Engines on other cards do not skip.
- Fail → formula. In-flight with nothing to show → skeleton (`commitManifest(null)`).

---

## Learned curve

Writes: `vram_learn.rs` key still includes device + split (separate rows).

Curve read (`get_learned_vram_curve`): `{path}|{provider}|` + same `kv` + spec/draft + **same split** (`none` / `layer` / `tensor`). Device ignored. Newest `measured_at` wins per ctx.

Frontend refetches when `hardKey` or `config.split` changes.

Session none-FIT probe may join the **none** curve as a point at `fitProbeAnchorCtx`. Layer/tensor never inherit that probe.

### Tensor learn vs FIT library

**Launch LEARN** tensor-split stderr reports a virtual **`Meta()`** device (one GPU’s shard). Parser fans `Meta()` across `N` TP devices. Vision CLIP compute on CUDA0 is extra on GPU0 only. Measured launch tax (DEV): tensor ~1.5–2.5 GB, layer ~5–7 GB (pipeline compute, not a second weight copy).

**Library FIT `--fit-print`** is different. Tensor mode prints a single `Meta()` estimate row already ≈ **split=none** total (slightly less KV). It does **not** emit multi-GPU CUDA0/CUDA1 shards or real TP tax. Live capture (Fara 27B @64K): none `17.42G` / layer `18.36G` (+0.95G) / tensor Meta `17.34G` (noΔ). Do **not** Meta×N fit-print (that doubled weights). Table T columns show **`noΔ`** when |T−none|≤128 MiB; forecast tensor tax = **LEARNED(split=tensor)** else **fallback +2 GB** (layer uses library Δ when positive).

---

## SOURCE

| Kind | Chip | When |
|---|---|---|
| `learned` | **LEARNED** cyan | Exact launch at this ctx + split |
| `learned_curve` | **LEARNED ≈** cyan | Between stored (and none-probe) points |
| `fit_probe` | **FIT PROBE** amber | Probe(none) ± library/fallback split tax |

No formula paint. Skeleton until LEARNED or FIT probe lands. Library CTX spine stretches a real measurement when the curve has &lt;2 points.

---

## CTX slider

One component: `CockpitCtxStrip` (above-dock `standalone`, in-cockpit `standalone={false}`).

- Fluid: hard key unchanged → re-eval interpolates.
- Arrow / Page / Home / End when thumb focused.
- Cyan ticks at `manifest.learnedCurveCtxs`. Non-preset ctx = dotted. Clickable.
- Corner toggle **ALL → REG → OFF**: all learned (preset+custom) / regular CTX presets only / hidden. Absolute bottom-left of the hero (does not steal slider width).
- MARKS persistence: `BlackOps-ctx-learned-marks`.

---

## Phosphor

Pinned `FORECAST_PHOSPHOR_HEIGHT_PX` (250) for skeleton and live. Content observer does not re-hug. Skeleton sweep is basic.

---

## Library FIT scan

`SCAN_PLAN` = 6 ctx: 4k / 32k / 64k / 128k / 256k / 512k (`q4_0`, batch 512). Incremental: old 26-point caches still complete if those 6 labels exist.

Model list: `model_catalog::is_launchable_main_model` (Regular-tab draft filter). `detect_gpu_count()` is process-cached.

---

## Split chrome

Forecast does **not** write `split` into config. `hideSplitNone` is overlay. Launch injects `split: layer` in `buildAutoVramLaunchParams` when needed.

`resolveAutoLayerSplit` = `needsAutoLayerSplit(bestVramEstimateGb(manifest), free)`.

---

## Forecast log

`{exe_dir}/config/cache/forecast-log.jsonl`

- `prelaunch` at spawn (`__forecast` on extra_params, not CLI).
- `measured` when launch buffer inventory persists.
- Join `learn_key`. Session: `[forecast] prelaunch source=…`.

---

## Files

| File | Role |
|---|---|
| `src/hooks/useScenarioEvaluator.ts` | Keys, probe session, auto-FIT, learned fetch |
| `src/services/vram/scenarios/auto_fit.ts` | Estimate merge / hero / bars |
| `src/services/vram/scenarios/scenarios_factory.ts` | Formula fallback, GQA stretch, curve interp |
| `src/services/vram/memorySource.ts` | SOURCE chips |
| `src/lib/autoVramLaunch.ts` | One split number |
| `src/lib/launchChromePolicy.ts` | Chrome locks |
| `src/lib/buildLaunchConfig.ts` | `__forecast` stamp |
| `src-tauri/src/vram_learn.rs` | Store + curve IPC |
| `src-tauri/src/launch_memory_parse.rs` | Buffer inventory (incl. `Meta()`) |
| `src-tauri/src/log_hub.rs` | Persist + readiness line |
| `src-tauri/src/forecast_log.rs` | JSONL |
| `src-tauri/src/fit_scanner.rs` | 6-point plan + catalog filter |
| `src-tauri/src/telemetry.rs` | Cached GPU count |
| `src/components/CockpitCtxStrip.tsx` | Shared CTX rail |
| `src/components/VramBadge.tsx` | Hero = `vramTotalGb`; height pin |

---

## Still open (not live law)

- **`moe_optimal`** — peel off (`gpuWeightFraction = 1`), badge hidden. Factory JSON / `templates.rs` `--fit off` / `MoeBadge` still exist.
- **Formula KV** — textbook GQA (`n_embd/n_head`). No MLA/SWA on `ModelMetadata`.
- **Learned write key** still includes device. Split-agnostic totals on write not done.
- Auto-FIT costs ~1–2 GB on one GPU (`split: none`). Skip if best free &lt; 2.5 GB.

---

## Verify (Rust + UI rebuild)

1. No learned: select → skeleton → FIT PROBE. Drag CTX; hero and bars move. SOURCE stays FIT PROBE until a launch. Never FIT CACHE.
2. Launch 64K then 128K: cyan ticks. 65K just above 64K, not above 128K. SOURCE LEARNED ≈. Park 64K → LEARNED.
3. Switch none → layer: hero uses the layer curve (or formula if none). None-FIT probe does not ride along.
4. Tensor launch: readiness learned line with both GPUs, not ~0.2 GB CLIP leftover.
5. Library scan: no draft GGUFs; one GPU-count log; 6 points.
