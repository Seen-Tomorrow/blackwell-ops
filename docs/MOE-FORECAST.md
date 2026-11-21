# FORECAST + OVERDRIVE — measured regimes, no probes

This supersedes the probe-based forecast assumptions. The forecast's job is no longer "run a
fit binary to guess"; it is **read the launch history, scale it with CTX, and show the placement the
user actually chose**. OVERDRIVE is the measurement path for the CPU-expert regime, and it is now a
first-class input, not something the forecast has to tiptoe around.

## 1. The two regimes

| regime | what sits where | the forecast shows |
|---|---|---|
| **plain** | weights + KV + compute on the card (spill if it does not fit) | the existing fit/spill layout |
| **CPU experts + cache** (`cpu_moe=on`, `moe_cache_mib=N`) | non-expert weights + KV + compute + cache on the card; the expert weights in host RAM by design | a dedicated **CPU EXPERTS** scenario |

The CPU-expert regime is a placement, not a shortfall. Host experts must never be painted as
"OVER FREE · SPILL · SLOWER" or "OFFLOADING TO RAM"; that copy belongs to a plain launch that ran
out of VRAM. The measured evidence is the same either way: device memory from the engine ledger
(which does not itemise the cache — it lands in "unaccounted"), host memory from the host model
column, and the cache from the launch config.

## 2. Where the numbers come from

1. **Learned launch point** — one real launch at this CTX, keyed by model+size, CTX, KV, split,
   topology, draft, n-max **and the expert regime** (`|experts=cpu-cache:<mib>`). This is the level.
2. **Learned curve** — two or more launch points at different CTX. The curve is the live part: the
   non-expert weights and the cache are flat, the KV component grows with CTX, so dragging the
   slider moves the device number and leaves the host side alone.
3. **OVERDRIVE record** — the exact-shape calibration (`config/cache/moe-overdrive/<hash>.json`):
   cache, measured PP/TG before→after, device/host memory, age. The scenario prints these as "what
   this exact shape did" only while its cache and CTX match the live config; the learned point/curve
   supplies the live CTX math.

No formula is invented for a model with no measurement. A fresh identity shows the "not measured
yet" glass and the CTA; the first launch locks a point, the two-point calibration (below) locks the
line.

## 3. What is parked: the low-VRAM probe (fit off)

The forecast has two FIT probes, and only one of them is parked:

| probe | mode | what it does | state |
|---|---|---|---|
| **normal** (fit on) | `full` | one full-need measurement at this CTX (ngl 999) | **stays** — automatic for a never-measured identity, and the header's `RE-PROBE` |
| **low-VRAM** (fit off) | `low_vram` | free-aware; runs several FIT scenarios to find a spill plan | **parked** |

Parked means **kept, not called**:

- no `RE-PROBE LOW VRAM` variant (the normal `RE-PROBE` stays),
- no automatic `low_vram` from a tight-free or beyond-the-curve manifest — the auto path always
  asks for the normal full probe,
- the probe session never takes the source away from a usable learned point/curve (the history gate
  handles measured models; the full probe only runs when there is no history at this CTX),
- `fit_scan_model` in `low_vram` mode, the `MemorySourceReprobe` low-vram flags and
  `validate("low_vram")` stay in the repo behind `LOW_VRAM_PROBE_PARKED`.

The low-VRAM probe's job — finding a spill plan — is not the forecast's job: the CPU-experts/cache
regime is sized by OVERDRIVE, and the forecast paints the measured placement.

## 4. The CPU EXPERTS scenario

A real manifest scenario with its own layout, not a branch inside the spill template:

- **headline**: `CPU EXPERTS + CACHE` (or `CPU EXPERTS` with cache 0), with the cache size and age.
- **device**: non-expert weights + KV + compute + cache, against free VRAM. Live with CTX.
- **host**: the expert pool, labelled *by design*, not as spill. No `OFFLOADING` warning.
- **measured**: PP/TG from the stored OVERDRIVE record (one line), with the before→after gain when
  both sides exist.
- **action**: the OVERDRIVE entry (open / recalibrate). RESET returns the regime to plain.

The scenario appears whenever `cpu_moe=on`. With a stored record matching this cache + CTX it prints
the measured row; at another CTX (or cache) the learned point/curve paints the memory and the
measured t/s is not borrowed from a different shape — the glass says "no calibration for this shape".


## 5. The nudge

When a plain launch of a MoE model would spill — and the host can hold the experts — the forecast
says so **on the glass**, not in a tooltip:

- a dominant line under the memory bars, on the RAM side: `EXPERTS FIT IN RAM · CACHE THEM IN VRAM`
  with an `OVERDRIVE →` CTA, pulsing with the same accent as the launch control; clicking it starts
  OVERDRIVE (the same run as the launch half);
- the right half of the launch button gets the accent pulse, and the regular LAUNCH half is dimmed
  and desaturated — the user is steered to the expert launch, not to a plain launch that spills;
- the line disappears as soon as `cpu_moe=on` or a calibration exists.

Condition: `n_expert > 1`, `cpu_moe` off, the plain launch does not fit fully (paint `offload` /
`nofit` or `fits=false`), and `model weights + buffer <= available host RAM`. Not in AUTOPILOT.
The nudge disappears as soon as `cpu_moe=on` or a calibration exists.

## 6. Two-point calibration (`2-PT`)

A tiny persisted toggle in the forecast badge, **off by default** (power users only). When on and
the current identity has fewer than two learned points:

1. the user's launch records point 1;
2. the app stops the engine, relaunches at a **second CTX** with the same knobs/regime, and records
   point 2;
3. it restores the original CTX and relaunches, so the user ends where they asked.

The second CTX is the **furthest lower allowed value** (e.g. 512K → 64K, 64K → 32K/8K): less KV
than the first point, so the calibration launch cannot OOM the card by construction. Only at the
CTX floor does it pick the nearest higher value. **No OOM on either calibration launch** is the hard
rule, precision is secondary. The real boot screen is visible for both loads; STOP aborts and
restores the config, exactly like the OVERDRIVE cycle.

For the CPU-expert regime the cache key makes a second cache launch a cache-regime point; the
initial version scales that regime with the point's KV rate and leaves a dedicated cache curve as a
follow-up. The toggle's first target is the plain curve (dense and MoE-without-cache), which is the
line the forecast uses most.

## 7. Ownership

One owner per cycle, the same pattern that made OVERDRIVE work:

- `engineRun` (shared): stack polling, launch/wait-RUNNING, stop/wait-idle, the events.
- `moeOverdriveRun`: the calibration → tuned cycle.
- `forecastCurveRun`: the two-point calibration cycle.

The forecast itself never launches anything. It reads the learned store, the config and (for the
measured row) the OVERDRIVE record. If the OVERDRIVE files are deleted, the CPU EXPERTS scenario
falls back to the learned/config numbers without the measured t/s.

## What is wired (2026-11-21)

| piece | state |
|---|---|
| Low-VRAM (fit off) probe parked; normal full probe retained | **done** — `LOW_VRAM_PROBE_PARKED` forces `full`; the header `RE-PROBE` and the skeleton `PROBE THIS CTX` are back; `fit_scan_model` `low_vram` mode and the low-vram flags stay in the repo |
| Fresh-model state | **done** — `NO MEASUREMENT YET` + `PROBE THIS CTX`; the normal full probe also auto-runs; 2-PT builds the curve |
| CPU-expert rows not a spill; expert-aware curve | **done** — `get_learned_vram_curve` takes cpu_moe/cache and filters by the token; the evaluator keeps those points |
| `CPU EXPERTS` scenario | **done** — device / host / cache, measured PP+TG and age from the OVERDRIVE record, RECALIBRATE |
| Nudge on the glass + launch half | **done** — line under the RAM bar (clickable), accent pulse on the expert half, regular half dimmed |
| `2-PT` toggle + calibration cycle | **done** — persisted header chip, off by default; a fresh regular launch gets a second (lower) CTX point and the original launch restored; STOP/failure restores the CTX |
| Cache-regime `2-PT` after an OVERDRIVE run | **not yet** — the toggle currently hooks LAUNCH; the cache curve is the follow-up |

## 8. What is not built / limits

- **No geometry formula.** A never-measured model is measured by the normal full FIT probe (or the
  first launch); the glass shows `NO MEASUREMENT YET` with both paths. (The old formula lives in
  `tmp/archive_vram_formula` if it is ever revived.)
- **Cache curve.** The cache regime uses one point + the KV rate; two cache points at different CTX
  are a follow-up (the `2-PT` hook runs on LAUNCH, not on the OVERDRIVE cycle yet).
- **Second CTX choice** is heuristic (furthest lower); tune after real runs. The OOM guard is the
  requirement.
- **The low-vram probe** stays parked until the measured path has proven itself.
