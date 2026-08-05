# VRAM Forecast — Redesign Intent & Observed Failure

> **STATUS: DESIGN NOTE — NOT YET ACTED ON.** Captured by the user after hitting a
> concrete borderline-model failure. This documents the *intent* of what the VRAM
> forecast / split auto-switching *should* do, plus a real reproduction of where the
> current tier system (FORMULA → FIT → LEARNED) fights the user.

This is intentionally a problem statement + design intent, not a patch. The current
auto-switching and temp-locking between learned / fit / formula is fine for normal
use (especially with a large VRAM pool). The failure is **specific to borderline /
tiny models near a single-GPU boundary**, and would be genuinely painful on modest
dual-16GB setups. Read the reproduction, then the intent, then the concrete fixes
ranked by impact.

---

## 1. The real failure (user reproduction)

System: ~188 GB VRAM used of 192 GB across GPUs (tiny free slices on each).
Model: small enough to fit one GPU's leftover VRAM.

1. **FORMULA** estimates the model at **~1.2 GB**. Because that (wrongly) exceeds
   the best single GPU's free slice, the system **forces `split: layer`**, so the
   estimate is shown spread across GPUs (~0.6 GB each).
2. User runs a **FIT probe** → real footprint is **~0.1 GB** (tiny model). But the
   persisted config still says `split: layer` (the sticky auto-promoted value from
   step 1). The accurate probe does **not** clear it.
3. User manually sets `split: none`.
4. **Config change invalidates the probe** (probe is keyed to a `configKey` that
   includes `split`). The UI reverts to **FORMULA**, which re-estimates ~0.7 GB —
   still too high, but now it *marginally* fits a single GPU, so it "works" but
   shows the wrong number and the user had to fight it.

### Root causes (each is independently fixable)

- **C1 — Sticky auto-promoted split.** The auto-promote-to-layer effect
  (`EngineConfigPanel.tsx` ~L1016-1037) commits `split: layer` *into the config*
  based on the **greedy formula**. That persisted value then has inertia and a
  later, more-accurate measurement (FIT probe) cannot override it. The split
  decision is treated as a *user choice* when it was actually a *forecast*.
- **C2 — Probe invalidation is too eager.** The probe session is keyed
  (`scenarioConfigKey`) to `device`, `split`, `offload_mode`, `ctx`, `kv_quant`,
  `batch`, `ubatch`, `flash_attn`, `vision`, `unified_kv`, `rope_*`, `gpu_sync`,
  `cache_ram`, `spec_type`, `backend_type`. Changing **any** of these drops the
  probe. For a tiny model the probe measured the engine's *real* footprint, which
  is largely **split-agnostic** — toggling `split` should not throw that
  measurement away.
- **C3 — Formula is the fallback for every config change.** Any edit that
  invalidates the probe immediately reverts to the **worst** estimator (formula),
  which is the greedy one that caused the bad split in the first place.
- **C4 — The weight-only floor overrode a measurement** (since fixed — see §4).
  That fix addresses the *computation*, but the sticky-split + eager-invalidation
  problems above remain and are the user-visible pain.

---

## 2. Design intent — what the system SHOULD do

### 2.1 A measurement is authoritative until it isn't
Priority is already **FIT probe → LEARNED → FIT cache → FORMULA**. That is correct.
The gap: a **measurement should not be silently discarded just because a knob that
doesn't change the measurement changed**. Invalidate a probe only when a change
could genuinely alter the footprint it measured. `split`/`device`/`gpu_sync`
re-route *where* weights go, not *how much* — a probe of total footprint should
survive those.

### 2.2 Forecast decisions must not masquerade as user choices
The auto-promote-to-split must **not** write `split: layer` into the user's config.
It should be a **live, recomputable overlay** — the way the forecast hero and
`autoLayerSplit` flag already work — so a later, better measurement can flip it
back to single-GPU without leaving a sticky value behind.

### 2.3 The fallback on invalidation must be the *next-best*, not the *worst*
When a probe is invalidated by a real footprint-affecting change, fall back to the
next-most-trustworthy tier (LEARNED, then FIT cache, then formula) — **not always
FORMULA**. And never let a greedy FORMULA re-latch a split that a measurement just
disproved.

### 2.4 Borderline hysteresis (the "marginally fits" trap)
Near a single-GPU boundary, tiny estimate wobble causes split/single flip-flop.
Add a **hysteresis band**: once a measured value proves single-GPU fit with some
margin, require a *larger* delta (e.g. crossing the boundary + a few % or a fixed
GB) before re-promoting to split, so the UI doesn't thrash as the estimate nudges.

### 2.5 Predictable outcome for modest dual-GPU users
The whole flow must "just work" for 2×16 GB without manual split wrangling: probe
proves fit → stays single GPU; genuinely needs both → split, clearly. The current
behavior forces a manual dance exactly in the cases that matter most.

---

## 3. Where the logic lives today (for the future implementer)

- **Tier resolution / source label:** `src/services/vram/memorySource.ts`
  (`resolveMemorySource` — FORMULA / FIT CACHE / FIT PROBE / LEARNED).
- **Estimate + component math:** `src/services/vram/scenarios/scenarios_factory.ts`
  (`computeValues`, `extrapolateVramFromPoints`, `computeDefaultOverhead`).
- **AUTO_FIT scenario (split + hero):** `src/services/vram/scenarios/auto_fit.ts`.
- **Split decision helpers:** `src/lib/autoVramLaunch.ts`
  (`needsAutoLayerSplit`, `resolveAutoLayerSplit`, `bestVramEstimateGb`,
  `resolveSplitDriver`).
- **Chrome lock policy:** `src/lib/launchChromePolicy.ts` (`resolveLaunchChromePolicy`).
- **Auto-promote-to-split effect:** `src/components/EngineConfigPanel.tsx` ~L1016-1037
  (the sticky-split root cause C1).
- **Probe session key + invalidation:** `src/hooks/useScenarioEvaluator.ts`
  (`scenarioConfigKey`, `ProbeSession`, `probeScenarioFields`).
- **Split chrome badge (contextual FIT/FORMULA):** `src/components/GpuAssignPanel.tsx`
  + `resolveSplitDriver` in `autoVramLaunch.ts`; also shown in `MemorySourcePanel.tsx`.

---

## 4. What was ALREADY changed in this session (do not re-litigate)

A focused fix landed for the "formula/weight-floor overrides a measurement" class
(C4 above). It is safe to keep and is the foundation for the rest:

- `src/lib/autoVramLaunch.ts` — added `bestVramEstimateGb()` (priority probe →
  learned → formula) and `weightFloorGb()`; `resolveAutoLayerSplit` trusts a
  measured value instead of `max(greedy formula, weights*1.05)`.
- `src/lib/launchChromePolicy.ts` — uses the measured estimate for single/multi-GPU
  chrome instead of the greedy formula + floor.
- `src/services/vram/scenarios/auto_fit.ts` — weight floor no longer overrides a
  probe/learned measurement.
- `src/lib/autoVramLaunch.ts` — `resolveSplitDriver()` shared indicator (used by
  `GpuAssignPanel` badge + `MemorySourcePanel` chip) so the UI and the actual launch
  agree on what drives the split decision.

These make the *computation* correct. The remaining pain (C1 sticky split, C2 eager
invalidation, C3 fallback-to-worst) is **not** covered by that fix and is the target
of the design intent above.

---

## 5. Suggested next steps (ranked by impact / effort)

1. **C2 — Narrow the probe invalidation key.** Split `scenarioConfigKey` into
   *footprint-affecting* (ctx, kv_quant, batch, ubatch, flash_attn, rope, vision,
   cache_ram, backend) vs *placement-affecting* (device, split, gpu_sync). Keep the
   probe valid across placement changes. **Low effort, high payoff** — directly
   removes the "set split:none → revert to formula" trap.
2. **C1 — Stop writing auto-promoted split into config.** Make auto-split a live
   overlay (like `autoLayerSplit`), not a persisted param. Then a better measurement
   can un-promote without a user edit. **Medium effort.**
3. **C3 — Invalidation falls back to next-best tier, not always formula.**
   Reuse `bestVramEstimateGb`-style priority across the fallback path. **Low effort.**
4. **C5 — Borderline hysteresis band** in `needsAutoLayerSplit` / the chrome policy
   to stop split/single flip-flop near the boundary. **Medium effort.**
5. **C6 — Validation test:** a tiny model + a nearly-full GPU (the exact repro above)
   should end at **single GPU + FIT**, not split, after a probe.

---

## 6. Open questions (need user input before designing)

- When a probe is kept across a `split` toggle, should the **per-GPU breakdown**
  still re-slice by the new split (even though the *total* is unchanged)? Probably
  yes — the total is authoritative, the distribution is derived.
- Should the user be able to **pin a probe** (make it survive even footprint-affecting
  edits, with a "stale" warning)? That's a bigger UX decision.
- What margin defines "borderline" for the hysteresis band — a fixed GB (e.g.
  0.5 GB) or a % of free VRAM? Depends on the target GPU sizes.
