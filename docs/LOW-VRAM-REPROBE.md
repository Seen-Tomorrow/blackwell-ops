# Low-VRAM RE-PROBE (free-aware spill)

Design + implementation notes for honest spill / OOM chrome when free VRAM is tight.
Keep this path **isolated** — do not grow a second forecast graph.

## Why

Live FIT probes (2026-08) showed:

| Mode | Host row |
|------|----------|
| App default `--fit-print --fit off -ngl 999` | ~1 GB **host buffer only** |
| Forced `-ngl 20` | Host **weights + KV** (tens of GB) |
| `--fit on` alone | Often `-ngl -1` because FIT free ≠ NVML free |

On a stuffed GPU, nvidia-smi free was ~55 GB while FIT `--list-devices` reported ~95 GB free.
So UI “HOST OFFLOAD · 4 GB” from full-need fit-print is **not** weight spill.
Soft OOM bands (85% / 92% free util) are still valid as “tight if we stay full-GPU.”

Product choice: **never auto-probe on CTX drag**. Fluid slider stays on full-need curve/tax.
When tight, **nudge** the existing RE-PROBE control → `RE-PROBE LOW VRAM` (manual).

## Architecture (minimal)

```
full probe (auto / normal RE-PROBE)
  --fit-print on --fit off -ngl 999
  → true total GPU need (SOURCE)

tight free / over free  →  UI nudge only (no auto FIT)

manual RE-PROBE LOW VRAM
  --fit on  (no ngl 999)
  --fit-target corrected from NVML free vs FIT list-devices free
  → parse last memory breakdown Host + CUDA
  → session.mode = "low_vram"
```

### Isolated modules

| Path | Role |
|------|------|
| `src/services/vram/lowVramProbe.ts` | needs-reprobe, free fingerprint, real-spill threshold, bar inset copy |
| `src-tauri/src/fit_low_vram.rs` | build args, list-devices free parse, fit-target math, fitted `-ngl` parse |
| Session field `mode` + `freeFingerprint` | stale when free pool moves |

No second cache file, no second evaluator, no ngl binary-search loop in TS.

## Paint rules

1. **LOW / HIGH OOM RISK** — only while still **fit** (full-GPU plan) and freeUtil crosses 0.85 / 0.92.
2. **OVER FREE · RE-PROBE** — estimate > free−headroom and **no** fresh low_vram probe. Do **not** invent multi-GB host spill.
3. **HOST OFFLOAD / SPILL** — only if **live estimate exceeds free−headroom** *and* host is weight-class or low_vram fitted ngl is partial. A leftover LEARNED host from a stuffed-GPU run must **not** paint offload at low usage.
4. Full-need Host ~1 GB → never labeled “offload.”
5. Auto-probe / normal RE-PROBE is always **full** (`ngl 999`). `low_vram` only when the button flashes and the user clicks.

## Fit-target correction

```
fitFree     = FIT list-devices free (often overstates free)
nvmlFree    = app NVML free for target GPU(s)
headroom    = max(1024 MiB, 3% nvmlFree)
wantUsable  = nvmlFree - headroom
fitTarget   = max(1024, fitFree - wantUsable)
```

Pass `--fit-target {fitTarget}` so free-aware fit budgets against **our** free.

## Session freshness

Low-vram probe is fresh when:

- `hardKey` matches (existing FIT hard knobs)
- `freeFingerprint` matches live free (rounded)
- `mode === "low_vram"`

CTX may still slide; estimate adjusts from anchor like full probe.
If free fingerprint changes (other engine stop/start), nudge returns.

## Non-goals

- Auto FIT when slider enters OOM territory
- Dual continuous probes
- Second LEARNED curve partition for low_vram
- Claiming spill from free-pool overshoot guess alone

## Thresholds (tune later)

- `FREE_POOL_OOM_CAUTION = 0.85`
- `FREE_POOL_OOM_WARN = 0.92`
- `HOST_BUFFER_CEILING_GB = 2.5`
- free fingerprint: free GB rounded to 0.5

## Manual test checklist

1. Empty GPU, small CTX — RE-PROBE normal; no LOW VRAM flash.
2. Stuff GPU + aggressive CTX — LOW/HIGH OOM or OVER FREE · RE-PROBE; button flashes LOW VRAM.
3. Click RE-PROBE LOW VRAM — Host weight-class if FIT spills; chrome SPILL · SLOWER.
4. Drag CTX after low_vram — still fluid; no auto re-probe.
5. Stop other engine (free jumps) — low_vram stale; nudge returns if still tight.

## LEARNED cache vs free-dependent spill

**RE-PROBE / FIT session probe never writes LEARNED.** Only real engine load
tables + launch buffer inventory do (`log_hub` → `vram_learn`).

Learn key = model + launch knobs (ctx, kv, device, split, …). **Free VRAM is not
in the key** — stuffing another model then launching with layer spill must not
replace a fuller full-GPU measurement, or empty-GPU forecasts under-read forever.

Rule (2026-08): primary `entry.vram_mib` only **promotes upward** (max GPU
footprint). Lower-GPU spill attempts still append to `fit_attempts` history and
`launch_snapshot` keeps “what just ran,” but forecast primary need stays the
fuller measurement. Host RAM is shown on console lines and stored with the
promoted primary (buffer-sized on full-GPU path).

We do **not** key LEARNED by free fingerprint — combinations explode.


## DEV-only (feat/low-vram-reprobe)

Gated by `isDevBuild()`:

1. Discard LEARNED GPU/host when the row looks like a free-dependent spill
   (`host > 2.5 GB` and `host >= 0.35 × GPU`) **and** that GPU slice already
   fits live free. Full-GPU + leftover smaller host stays. Allows auto
   **full** probe again.
2. Ignore in-session `low_vram` unless fingerprint matches **and** probe GPU
   is still over free.
3. Header shows **both** `RE-PROBE` (ngl 999) and `RE-PROBE LOW VRAM`
   (free-aware). LOW VRAM still pulses when tight. REL keeps the single
   swapped button.

