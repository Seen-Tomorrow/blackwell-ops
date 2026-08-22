# VRAM forecast

Current product law. Measured only — no GGUF formula paint.

UI glass / heights / SOURCE chrome traps: `docs/VRAM-FORECAST-UI.md`.

---

## Estimate

```
LEARNED(split) @ live ctx   (+ draft addon if launch lacked draft buffers)
  else  LEARNED≈ curve      (+ draft addon if needed)
  else  PROBE(none @ user knobs) + tax(mode, live ctx) + draft addon
  else  null → skeleton (auto-probe in flight)
```

```
tax(mode, ctx) = library FIT  (VRAM_split − VRAM_none) @ ctx   // piecewise vs CTX
              or fallback     (layer 6 GB / tensor 2 GB)

draft addon (dflash/dspark/eagle only; not pure MTP) =
  draft GGUF weights + max(0.4, 0.55×weights) GB
  skipped when LEARNED snapshot already has mtp_context/draft buffers
FIT probe never loads the draft GGUF — always additive on probe path.
```

---

## Unwired / archived formula path

| Location | Status |
|---|---|
| `src/services/vram/forecast/**` | **Live** measured path |
| `src/services/vram/shared.ts` | **Live** helpers + `resolveSplitTax` |
| `src/services/vram/scenarios/scenarios_factory.ts` | Thin **compat re-export** only (`evaluate` → forecast) |
| `src/services/vram/memorySource.ts` | Thin **compat re-export** → `forecast/memorySource` |
| `src/services/vram/scenarios/auto_fit.ts` | **Deleted** from tree |
| `src/services/vram/scenarios/hw_locked.ts` | **Deleted** from tree |
| `tmp/archive_vram_formula/` | **Disk archive only** (gitignored `tmp/`). Not imported. Safe to delete anytime. |

Do **not** re-wire formula from the archive. Scenario enum still has `AUTO_FIT` | `HW_LOCKED` as chrome labels (`fits=false` still blocks factory launch); there is no separate formula evaluator.

---

## Keys (`useScenarioEvaluator.ts`)

| Key | Contains | Invalidates |
|---|---|---|
| `placementConfigKey` | `device\|split\|gpu_sync` | re-slice bars only |
| `fitProbeKey` | backend, kv, batch, ubatch, flash, auto flag | session FIT probe |
| `learnedIdentityKey` | fitProbeKey + spec + draft basename + **split** | learned fetch |
| `liveEvalKey` | placement + learnedIdentity + **ctx** | re-eval |

CTX is not a hard probe knob. Probe session stores `hardKey` (= fitProbeKey) + `anchorCtx` + placement.

- CTX-only slider → evaluate **immediately** (curve / tax math).
- Other config → debounced (~150 ms).

---

## Auto-probe (session FIT)

- After learned fetch, if there is **no** measured level yet for this identity.
- Always `splitMode: "none"`, `offloadMode: "regular"`, live `ctx` as `parseCtx`.
- One in-flight (`validatingRef`, cleared in `finally`).
- Skip only if best free GPU &lt; 2.5 GB.
- Fail / nothing yet → skeleton (`commitManifest(null)`), never formula.

---

## Split tax

```
live_estimate(split) = live_none_level(user knobs, live ctx) + tax(mode, live ctx)
```

Tax is **independent** of live KV/batch/quant (those live in the none probe/learned level).

| Mode | Library FIT Δ | Forecast when no LEARNED(split) |
|---|---|---|
| **layer** | Real (CUDA0+CUDA1 − none) | library Δ @ ctx, else **+6 GB** fallback |
| **tensor** | Usually **noΔ** (Meta ≈ none) | **+2 GB** fallback until LEARNED tensor launch |

`resolveSplitTax` in `shared.ts`: library anchor only if `taxMib > 64`; else fallback.

---

## Tensor: LEARN vs library FIT

| Path | What prints | Parse |
|---|---|---|
| **Launch LEARN** | Per-GPU shards; often virtual **`Meta()`** = one GPU’s weight shard | Expand Meta × N devices (`launch_memory_parse`) |
| **Library `--fit-print` tensor** | Single **`Meta()`** row ≈ full none total | **Do not** ×N — that doubled weights (reverted) |

Live Fara 27B @64K fit-print: none `17.42G` / layer `18.36G` (+0.95G) / tensor Meta `17.34G` (**noΔ**).

FIT table T columns show **`noΔ`** when `|T − none| ≤ 128 MiB`. Upstream llama must emit real multi-GPU tensor totals before library tensor tax works.

---

## Learned curve

- Write key (`vram_learn.rs`): full model path + provider + ctx + kv + device + split + mode + offload + optional spec/draft/cache_ram.
- Curve read: same path/provider/kv/spec/draft/**split**; device ignored; newest `measured_at` per ctx.
- Frontend refetches when `learnedIdentityKey` or placement split changes.
- Session none-FIT probe may join the **none** curve only. Layer/tensor never inherit that probe as a curve point without tax.

**Path move:** main model is full-path keyed → move/rename loses LEARNED/FIT rows (orphan keys remain). Draft is basename-only. Content-hash keys deferred.

---

## SOURCE chips

| Kind | Chip | When |
|---|---|---|
| `learned` | **LEARNED** cyan | Exact launch @ this ctx + split |
| `learned_curve` | **LEARNED ≈** cyan | Between curve points (and none-probe on none curve) |
| `fit_probe` | **FIT PROBE** amber | Probe(none) ± library/fallback tax |

No formula chip. Skeleton until one of the above lands.

---

## CTX slider

`CockpitCtxStrip` (above-dock `standalone`, in-cockpit `standalone={false}`).

- Fluid: hard key unchanged → re-eval interpolates.
- `layout="hero"` rail: value labels sit above; ticks run label→through-rail→below; hit target ~16px wide × full host height.
- Cyan ticks = `manifest.learnedCurveCtxs` (custom/non-preset = dotted + italic label). Clickable. Drag **snaps** to LEARNED marks (~12px); hold **Alt/Shift** for free drag.
- **Fits ghost** on the track: green ≤ max fitting ctx, red beyond (from `forecastCurve` + `forecastFreeGb`). Amber dashed edge at the boundary.
- Footer (when any LEARNED): legend `LEARNED · custom ctx · snap` + filter **ALL → REG → OFF** (right-aligned).
- Storage: `BlackOps-ctx-learned-marks` (legacy `custom` → `all`).

---

## Library FIT scan

`SCAN_PLAN` (10 points):

- Spine none: 4k / 32k / 64k / 128k / 256k / 512k (`q4_0`, batch 512)
- Split tax: L64K, T64K, L256, T256

Cache: `config/cache/fit_scan_full.json` partitioned by `fit_adapter`. No prune/TTL. Path-keyed (same move caveat as LEARNED).

---

## Split chrome

- Forecast does **not** write `split` into config. `hideSplitNone` is overlay.
- Launch injects `split: layer` via `buildAutoVramLaunchParams` when `resolveAutoLayerSplit` says so.
- `resolveAutoLayerSplit` = need vs free from `bestVramEstimateGb(manifest)` (LEARNED or FIT probe total only).

---

## Forecast log

`{exe_dir}/config/cache/forecast-log.jsonl`
- `prelaunch` at spawn (`__forecast` on extra_params, not CLI)
- `measured` when launch buffer inventory persists
- Join on `learn_key`

---

## Live files

| File | Role |
|---|---|
| `src/hooks/useScenarioEvaluator.ts` | Keys, probe session, auto-probe, learned fetch |
| `src/services/vram/forecast/evaluate.ts` | Adapter pick → evaluate |
| `src/services/vram/forecast/adapters/ggml_master.ts` | Measured compose + tax |
| `src/services/vram/forecast/memorySource.ts` | SOURCE attach / labels |
| `src/services/vram/forecast/types.ts` | `ForecastInput` / adapter contract |
| `src/services/vram/shared.ts` | Curve math, tax, GPU bars, slots |
| `src/services/vram/scenarios/scenarios_factory.ts` | Compat re-exports only |
| `src/lib/autoVramLaunch.ts` | One split number from measured total |
| `src/lib/fitScanTable.ts` | FIT table columns + `noΔ` |
| `src/components/VramBadge.tsx` | One ASSISTED glass (SOURCE / NEED / bars); fusion fill when running |
| `src/components/CockpitCtxStrip.tsx` | CTX rail + marks toggle |
| `src-tauri/src/vram_learn.rs` | Store + curve IPC |
| `src-tauri/src/launch_memory_parse.rs` | Buffer inventory (LEARN Meta×N) |

| `src-tauri/src/fit_scanner.rs` | SCAN_PLAN + fit-print parse (**no** Meta×N) |
| `src-tauri/src/forecast_log.rs` | JSONL |

---

## Still open

- **`moe_optimal`** — peel off; factory JSON / MoeBadge leftovers.
- Tensor library tax — wait for llama fit-print multi-GPU; until then LEARNED or +2G.
- Learned write key still includes device; path-keyed (content-hash deferred).
- Auto-probe costs ~1–2 GB on one GPU (`split: none`); skip if best free &lt; 2.5 GB.

---

## Verify

1. No learned: select → skeleton → FIT PROBE. Drag CTX; hero moves; SOURCE stays FIT PROBE until launch.
2. Launch 64K then 128K: cyan ticks; 65K near 64K (LEARNED≈); park 64K → LEARNED.
3. none → layer: layer curve or probe+library tax; none probe does not paint layer without tax.
4. Tensor FIT table: **noΔ** (not 2×). Tensor launch LEARNED shows multi-GPU inventory.
5. Library scan: 10 points; L64K slightly above 64K; T64K ≈ 64K.
