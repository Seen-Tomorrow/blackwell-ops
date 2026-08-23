# Low-VRAM / offload forecast

Working memo for ASSISTED forecast paint when free VRAM is tight, plus the
manual free-aware FIT path. Product law (measured-only estimate) stays in
`docs/VRAM-FORECAST.md`. UI height/chrome traps stay in `docs/VRAM-FORECAST-UI.md`.

**Do not grow a second forecast graph.** This path is isolated helpers + one
FIT regime flag on the existing session.

Branch that landed the first cut: `feat/low-vram-reprobe`.

---

## The questions this UI answers (they are not the same)

| Question | Denominator | Chrome |
|----------|-------------|--------|
| Will it **launch** on this free pool? | `estimate` vs `NVML free − headroom` | bar fill green / orange / red |
| How **full** will the card look? | `estimate` vs **manufactured** | uncolored `%` on GPU cards |
| Will it **spill weights to host**? | measured Host **model** or fitted `-ngl` | `HOST OFFLOAD` / `SPILL · SLOWER` |
| Might unknown load buffers **OOM** while still full-GPU? | `estimate / free` | `LOW/HIGH OOM RISK` |

We originally painted NEED from manufactured 85/95% and the bar from the
launch gate. NEED went amber/red first. Unify: **bar + NEED share launch
paint**; manufactured `%` is capacity context only (uncolored).

Soft OOM bands (85% / 92% of **free**) are an early-warn on the full-GPU
plan — not a claim that FIT will offload.

---

## What we measured live (2026-08, stuffed GPU0)

Model: `Qwen3.8-27B-Uncensored-Cyber-Q6_K.gguf`  
Binary: `runtime/ggml-master/frontier/llama-fit-params.exe`  
nvidia-smi GPU0: ~40 GB used / ~55 GB free. GPU1 empty.

| FIT command | Result |
|-------------|--------|
| App path `--fit-print on --fit off -ngl 999` | Full GPU need. Host ~1.1–1.5 GB = **buffer only** |
| Forced `-ngl 20` | CUDA shrinks; Host `15494+5737+158` ≈ **21 GB** weight+KV. Log: `offloaded 20/65 layers` |
| `--fit on` (free-aware) | Still `-ngl -1` — FIT thought free ≈ **95 GB** |
| `--list-devices` | Both cards **~95 GB free** while nvidia-smi showed 55 GB on GPU0 |

Conclusions that still hold:

1. FIT **can** print real spill (Host model column + `offloaded A/B`).
2. App FIT **never produced it** because we force `-ngl 999` (true total need) on the full probe.
3. `--fit on` alone is not enough — FIT’s free ≠ NVML free on a stuffed card.
4. UI “HOST OFFLOAD · ~4 GB” from full-need Host was **host buffer**, not 10–20 GB layer spill.
5. We already parse the Host row. We were running the wrong command for spill truth.


Logs from that session (gitignored): `tmp/fit-offload-probe/`.

---

## Two FIT regimes (same runner, one session slot)

```
full  (auto + RE-PROBE)
  --fit-print on --fit off -ngl 999
  → true total GPU need (SOURCE)
  → Host ≈ 1 GB buffer — never call this “offload”

low_vram  (manual RE-PROBE LOW VRAM only)
  --fit on   (no ngl 999)
  --fit-target from NVML vs FIT list-devices
  → fitted -ngl + last memory-breakdown Host/CUDA
  → session.mode = "low_vram"
```

**Never auto-FIT on CTX drag.** Slider stays on full-need curve/tax.
Tight free → nudge only (REL: swap one button; DEV: both buttons, LOW VRAM pulses).

**Split is a probe hard-key.** Toggling none / layer / tensor drops the session
(EVALUATING radar) and FIT uses the live `--split-mode`. Library split-tax is
not added on top of a this-split probe or LEARNED row.


`--fit-target` correction (because FIT free overstates):

```
headroom    = max(1024 MiB, 3% of nvmlFree)
wantUsable  = nvmlFree − headroom
fitTarget   = max(1024, fitFree − wantUsable)
```

`usable ≈ fitFree − fitTarget` then tracks **our** NVML free.

---

## Paint rules (current)

Shared helpers: `src/services/vram/lowVramProbe.ts`, `src/services/vram/shared.ts`.

```
headroom     = max(1 GB, 3% of free)     // same as CTX ghost / fits gate
exceedsFree  = estimate > free − headroom
freeUtil     = estimate / free
caution      = freeUtil > 0.85           // LOW OOM RISK
warn         = freeUtil > 0.92           // HIGH OOM RISK
weightHost   = hostGb > 2.5              // HOST_BUFFER_CEILING_GB
partialNgl   = 0 ≤ fittedNgl < 900       // −1 / 999 = all GPU

realSpill    = exceedsFree && measurementAtThisCtx && (weightHost || partialNgl)
```

The CTX slider **amber fits-line** (`findMaxFittingCtx`, same 3%/1G headroom)
is the honest “offload starts here.” SPILL / HOST OFFLOAD only if we measured
at **this CTX** (exact LEARNED host or low_vram session whose `anchorCtx`
equals live ctx). A low_vram `ngl=63` from another CTX must not paint 610k.
The 85/92% band is LOW/HIGH OOM RISK only — it must not jump to SPILL.

Offload LEARNED rows stay off the GPU lerp (slider ticks only).


| State | Bar / NEED | Inset |
|-------|------------|--------|
| fits, freeUtil ≤ 0.85 | green / ok | none |
| fits, 0.85–0.92 | amber / caution | `LOW OOM RISK` |
| fits, > 0.92 until headroom | orange / warn | `HIGH OOM RISK` |
| exceedsFree, no measured spill | orange | `OVER FREE · RE-PROBE` |
| exceedsFree + weight host / partial ngl | orange | `OVER FREE · SPILL · SLOWER` + RAM `HOST OFFLOAD · SLOWER` |
| system OOM | red / hot | `NO FIT` / `NO FIT · SYSTEM` |

**Do not** invent multi-GB host from `estimate − (free − headroom)`.
**Do not** paint HOST OFFLOAD from ~1 GB fit-print Host.
**Do not** paint spill from leftover LEARNED/session host when `estimate` already fits free
(that was the “20% usage still says OFFLOAD” bug).

Manufactured `%` on GPU cards stays **uncolored**.

---
### Learn key (`vram_learn.rs`)

`model|provider|ctx|kv|dev={vramGB}|split|mode|offload` + optional spec/draft/cache_ram.

| In key? | |
|---------|--|
| ctx, kv, split, offload mode | yes |
| **manufactured VRAM GB** of selected device(s) (`96`, `24+96`) | **yes** |
| GPU index / SKU / arch | **no** — two 96 GB cards share |
| **free VRAM** | **no** |
| fitted ngl | no |

Identical 96 GB pair → same key on GPU-0 or GPU-1. Mixed 24+96 is a different
key. Do **not** add free or ngl — combinations explode.

Launch writes `__vram_topo`. Lookups pass the same tag. Legacy `dev=GPU-N`
keys still fuzzy-match when no topo tag is sent.
**Offload launches must not join the GPU-vs-CTX lerp.** Host &gt; 2.5 GB
(weight-class) rows stay in the store and as slider ticks. Interpolation
uses only full-GPU points (host buffer or missing). Host is applied only
at an **exact** CTX — never lerped (that invented 2.8 GB HOST OFFLOAD).
The full-GPU curve is the 100% path; edge-case offload is isolated.

A **same-CTX** `low_vram` session (just probed) wins the glass over a stored
full-GPU LEARNED row at that CTX. It does **not** rewrite `learned-vram.json`.
Slide off that CTX and the regular curve returns.


Identical 96 GB pair → same key on GPU-0 or GPU-1. Mixed 24+96 is a different
key. Do **not** add free or ngl — combinations explode.

Launch writes `__vram_topo`. Lookups pass the same tag. Legacy `dev=GPU-N`
keys still fuzzy-match when no topo tag is sent.

### Promote rule

Primary `entry.vram_mib` only goes **up** (`new + 1 MiB >= existing`).
A spill launch (small GPU + fat host) must not replace a fuller full-GPU need.

- `fit_attempts` still appends every distinct table.
- `launch_snapshot` is **always overwritten** (diagnostics / “what just ran”).
- First-ever launch that is a spill **does** become primary (`existing == 0`).
  Later empty-GPU same ctx then under-forecasts unless we discard that row
  (DEV heuristic below) or the user runs a full RE-PROBE.

### Frontend host source (easy to get wrong)

Hook prefers `launch_snapshot.host` (latest launch, including spill).
Adapter prefers **curve host**, and curve host is **not ctx-adjusted**
(lerp between ctx points). Those can disagree.

After the live-over-free gate this no longer flashes OFFLOAD at 20% usage.
If you later go over free, the host **GB** may still be a stale/interpolated
spill number until a fresh low_vram probe or a full-GPU launch promotes.

### Session hard-key (`fitProbeKey`)

`backend|kv_quant|batch|ubatch|flash_attn|autoVramLaunch`

**Not** in hard-key: ctx, device, split, free. Intentional — CTX slider must
not drop a full probe. Side effect: a `low_vram` session survives device
switch and engine-stop unless DEV ignore-rules fire.

---

## Isolated files

| Path | Role |
|------|------|
| `src/services/vram/lowVramProbe.ts` | spill/OOM helpers, insets, fingerprints, DEV discard |
| `src/services/vram/shared.ts` | `freePoolHeadroomGb`, `needToneFromLaunchPaint`, OOM constants |
| `src/services/vram/forecast/adapters/ggml_master.ts` | estimate + paint; DEV spill-LEARNED discard |
| `src/hooks/useScenarioEvaluator.ts` | ProbeSession, auto full-probe, validate(mode) |
| `src/components/MemorySourcePanel.tsx` | RE-PROBE button(s) |
| `src-tauri/src/fit_low_vram.rs` | args, list-devices free, fit-target, fitted `-ngl` |
| `src-tauri/src/engine.rs` `fit_scan_model` | `mode` + `free_budget_mib` |
| `src-tauri/src/vram_learn.rs` | promote-upward primary |
| `src-tauri/src/log_hub.rs` | learn console includes `+ N MiB RAM` |

No second cache file. No ngl binary-search in TS. No second evaluator.

---

## Thresholds (tune from live launches)

| Constant | Default | Meaning |
|----------|---------|---------|
| `FREE_POOL_OOM_CAUTION` | 0.85 | LOW OOM RISK (still fit) |
| `FREE_POOL_OOM_WARN` | 0.92 | HIGH OOM RISK (still fit) |
| free headroom | max(1 GB, 3% free) | launch / CTX-ghost / exceedsFree |
| `HOST_BUFFER_CEILING_GB` | 2.5 | above this ≈ weight/KV, not buffer |
| spill-LEARNED host/GPU | 0.35 | DEV: fat host relative to GPU |
| free fingerprint | 0.5 GB buckets | session freshness |

---

## DEV vs REL (`isDevBuild()`)

REL:

- One RE-PROBE button; label swaps to `RE-PROBE LOW VRAM` + pulse when tight.
- Click then runs low_vram; otherwise full.
- Auto-probe always **full**.
- Spill chrome still live-over-free gated (all builds).

DEV extra (`feat/low-vram-reprobe`):

1. **Both buttons** always: `RE-PROBE` (ngl 999) and `RE-PROBE LOW VRAM`.
   Pulse only on the low_vram control when tight. Use this to compare
   results in the 85–97% band.
2. **Discard spill-shaped LEARNED** when `host > 2.5` **and**
   `host ≥ 0.35 × GPU` **and** that GPU slice already fits free.
   Full-GPU + leftover smaller host is kept. Unblocks auto full-probe.
3. **Ignore `low_vram` session** unless fingerprint matches **and**
   probe GPU is still over free.

---

## Known holes (do not “fix” by exploding keys)

1. **First-and-only launch was spill** — primary LEARNED is small GPU + fat
   host for that ctx. Empty GPU later under-reads until DEV discard + full
   probe, or a fuller same-key launch promotes.
2. **FIT list-devices free still wrong** — `--fit-target` is a workaround.
   If it undershoots, low_vram returns `-ngl -1` + ~1 GB host → we correctly
   refuse to claim spill, but the click was a no-op.
3. **Skeleton** if `autoVramLaunch` off and nothing measured, or **all** GPUs
   free &lt; 2.5 GB and no LEARNED. Hard-knob EVALUATING should recover via
   forced full probe (do not skip auto on curve-only).
4. Failed FIT does **not** clear a previous session.

---

## Later — persist + RAM (do not start until VramBadge logic settles)

`FusionOverlay` stays mounted; **`useScenarioEvaluator` does not**. Leave CONFIG
and the hook remounts. Manifest has a small in-memory cache (seed paint) but
**ProbeSession is a ref** → gone on remount → auto-FIT + CTX ribbon flash.

When paint rules freeze:

1. Module-level `ProbeSession` map next to `manifestCacheByKey` (session only,
   no disk). Survive CONFIG remount. Do **not** persist FIT/low_vram to
   `learned-vram.json`.
2. Ribbon hover: skip `setState` when the tooltip string is unchanged.
3. Then, if REL heap still climbs: profiler on CTX drag (`evaluate()` per
   step). DEV Strict Mode doubles fetches — ignore that for REL.

Not worth a persist/memory project while split/probe/SOURCE are still moving.

---

## What not to build

- Auto FIT when the CTX slider enters OOM territory
- Dual continuous probes / second LEARNED curve for low_vram
- Learn key by free VRAM / ngl / “every combo”
- Spill GB guessed from free-pool overshoot
- Manufactured 85/95 as NEED color (bar is launch/free, not card-fullness)
- Second forecast adapter or second JSON cache

---


## Manual test checklist

1. Empty GPU, small CTX — green; DEV shows both buttons; no LOW VRAM pulse.
2. Stuff GPU + aggressive CTX — LOW/HIGH OOM or `OVER FREE · RE-PROBE`; LOW VRAM pulses.
3. Click **RE-PROBE LOW VRAM** — if FIT spills, Host weight-class + `SPILL · SLOWER`.
4. Click **RE-PROBE** (DEV) at the same point — Host stays ~1 GB; NEED is full GPU.
5. Drag CTX — fluid; no auto FIT.
6. Stop stuffing engine — no leftover HOST OFFLOAD at ~20% usage; DEV may auto full-probe if LEARNED looked like spill.
7. Hard-knob change (kv) — EVALUATING then full probe or LEARNED paint; not infinite skeleton.

---

## History (why the code looks like this)

1. NEED vs bar used different math (manufactured 85/95 vs free-pool fits).
2. Soft 85% band on NEED only → amber before the bar. Then locked together.
3. Two OOM tiers + bar insets (`LOW/HIGH OOM RISK`, `HOST OFFLOAD · SLOWER`).
4. Live FIT proved Host-from-ngl999 is buffer; real spill needs a second regime.
5. Leftover LEARNED/session host painted OFFLOAD at 20% usage →
   `isLiveWeightSpill` requires **live exceedsFree**.
6. Auto-probe skipped on `curve.length >= 2` → hard-knob skeleton. Skip only
   identity-matched LEARNED; auto is always full.
7. DEV dual buttons + discard spill-LEARNED / stale low_vram session so we
   can tune thresholds without another full archaeology pass.

## CTX slider learned marks

Cyan ticks are **launch measurements** from `get_learned_vram_curve`, not FIT
session probes.

**Curve query matches:** model path, provider, `kv`, `spec`, draft basename,
`split`. **Ignores device and ctx.** Batch/ubatch/flash are not in the curve
key (same as “identical hard knobs” for marks).

**Why they vanish while you swear the launches exist**

1. **Was: marks only on `manifest.learnedCurveCtxs`.** `evaluate() == null`
   (skeleton, discarded spill LEARNED, hard-knob EVALUATING) dropped the
   ticks even after curve IPC succeeded. **Fixed:** slider reads
   `learnedCurveCtxs` from the fetch, independent of the glass.
2. **Toggle ALL / REGULAR / OFF** on the CTX strip (`ctx-learned-marks`
   localStorage). OFF hides everything; REGULAR hides custom ctx that is
   not a template preset.
3. **Mark outside slider min/max** (filtered in `CustomSliderParam`).
4. **Identity miss on fetch:** Boost/`spec_type` or draft path on when you
   launched, off now (or the reverse) → curve IPC returns `[]`. Split
   none vs layer is also a different curve.
5. Track width 0 briefly hides ticks (`visibility: hidden`) until layout.

**PRUNE N** on the CTX footer deletes **custom** (non-preset) LEARNED rows for
the **current curve key** only (model + kv/spec/draft + split). Preset CTX
ticks stay. Emits `learned-vram-changed` so the rail refreshes. Does not wipe
the whole `learned-vram.json` file.

If ticks are still missing with ALL + in-range ctx: check learn keys in
`learned-vram.json` for `|kv=` `|spec=` `|draft=` `|split=` vs the live cockpit.

## CPU affinity vs host offload

Default X3D pin is V-Cache CCD, high-half, `-t ≤ 8` (best GPU-decode TPS).
That starves **CPU-layer** offload (8 of 32 cores).

When launch is host-offload (`__host_offload=1` from forecast spill, or
`--n-gpu-layers` / `__ngl` in `0..899`), affinity inject is **skipped** so
ggml can use all cores. User `--cpu-mask` still wins.


## Three different host RAM numbers

| Source | When | What it is |
|--------|------|------------|
| `[FIT] PROBE` Host `model+ctx+compute` | llama-fit-params, no real load | **Estimate.** `model=` is FIT’s Host MODEL column (~1 GB metadata on a full ngl=999 print — **not** layer offload). `compute=` grows with CTX. |
| `[ENGINE] Learned launch memory` | Real llama-server load | **Inventory.** CPU + pinned host buffers after load. Often **lower** than FIT Host (1151 vs 1822 at 256k). This is what `learned-vram.json` `host_mib` / snapshot stores. |
| Glass RAM NEED | Session or LEARNED at **this CTX** | Last **FIT session** host if you just probed that CTX; else LEARNED host at that CTX. Probes **never write** the cache. Slide off the probe CTX → session host gone unless LEARNED has that ctx. |

FIT `wgt=` in older console lines was a bad label for Host.model. Current print is `model=/ctx=/compute=`.

