# Theme System Consolidation Plan

**Date:** 2026-08-30
**Baseline commit:** `bfd4a9b64` (AMBER/CYAN removed, display = DOTTED + CLEAN)
**Scope:** `src/themes/app-themes.ts`, `src/styles/tokens-base.css`, dead code in components/contexts/hooks

## Measured duplication (post-cutover)

| Theme | Tokens | Notes |
|-------|--------|-------|
| MATRIX | 184 | dark, green accent |
| SLATE | 182 | dark, neutral accent |
| ARCTIC | 235 | light, 49 unique tokens |

- 180 tokens common to all 3; **178 have divergent values** (genuine palette — untouched)
- **55 tokens identical MATRIX↔SLATE** — the consolidation target
  - 18 of those already equal the `tokens-base.css` value (pure redundancy)
  - 37 are dark-specific values that differ from base (dark-base candidates)

## Tier 1 — Dead code removal (~55 lines, zero risk)

1. Delete `src/components/ThemePicker.tsx` (47 lines, zero imports — superseded by `AppearanceControls`)
2. Delete `src/hooks/useDisplayTexture.ts` (1-line re-export, zero importers — all consumers use `context/DisplayTextureContext`)
3. Remove `position` from `DisplayTextureContext` (interface field + computed value; no consumer)
4. Remove `className`/`embedded` props from `AppearanceControls` (single callsite, both constant) — component takes no props

## Tier 2 — Redundant base copies (~36 lines, near-zero risk)

18 tokens where MATRIX **and** SLATE restate the exact `tokens-base.css` value (mostly the `--display-face-light-*` e-ink family + bezel shadows). Delete from both themes; base already provides the value.

Safety: under any theme, resolved value is unchanged (identical value from base or from the theme's own override in ARCTIC).

## Tier 3 — Dark base layer (net ~−73 lines + single source of truth)

Move the 55 M/S-identical tokens into `tokens-base.css` as **dark defaults**:

- 37 tokens: base value replaced with the M/S value (or added if absent)
- 18 tokens: no base change (already equal) — see Tier 2
- MATRIX: 184 → ~129 tokens (accent-specific deltas only)
- SLATE: 182 → ~127 tokens
- ARCTIC: untouched (already overrides everything that diverges)

**Guard:** any of the 37 that ARCTIC does *not* define would change ARCTIC's resolved value when moved to base. For those, add an explicit ARCTIC override preserving the current base value, so ARCTIC rendering is byte-identical.

Resulting model: **base = dark defaults, themes = deltas.**

## Verification (required before commit)

1. `npx tsc --noEmit` clean
2. Grep: no dangling references to deleted files/symbols
3. Browser smoke test (Vite + headless), computed face colors MUST match baseline:
   - ARCTIC + DOTTED → `rgb(231, 238, 246)` (e-ink light)
   - MATRIX + DOTTED → `rgb(4, 11, 1)` (dark CRT)
   - SLATE + DOTTED → `rgb(12, 12, 12)` (dark neutral)
   - CLEAN + DOTTED cycle works; theme chips = MATRIX/SLATE/ARCTIC

## Deferred — status (2026-08-30)

- **The 301 `[data-theme="arctic"]` CSS forks** — ✅ DONE (`65b389d`): resolved via the `data-display-face` attribute (crt/eink/paper) + `displayFaceFor()` — simpler than the container-query option; CSS is now 100% face-keyed.
- **`nativeWindowTheme.ts`** — ✅ DONE (`65b389d`): `AppTheme.native: "light"` on ARCTIC; hardcoded set removed.
- **Face helper** — ✅ DONE (`65b389d`): landed as `displayFaceFor(themeId, texture)` (three-valued, not boolean — `crt`/`eink`/`paper` distinguishes the paper face on dark themes, which the boolean could not).
- **Eink badge/topo overrides** — ✅ DONE (`1663800`): 97 eink rules removed; DOTTED badge/bars/topo now identical to CLEAN (visual pass).
- **Harness veil bugs** — ✅ DONE (`2ebe1b8`): dark bg on dark-theme CLEAN (old phosphor-light/clean grouping), full-face positioning on ARCTIC DOTTED (eink `> *` lift rule excluded the veil).
- **Texture legacy maps** — ✅ DONE (`aa0430f`): dropped, pre-user.
- **Tier 4 — texture-system unification** (~90 lines): ✅ DECIDED — leave as-is (user, 2026-08-30). Two instances don't justify the abstraction; display texture is per-component while frame texture is html-scoped. Revisit only if a third texture axis appears.
- **Group-layout legacy paths** (`MULTI-GPU` / `RUNTIME-CONFIG` in `groupLayoutUtils.ts` / `systemParams.ts`): parked — battle-tested, delicate; review with the author agent before touching.

---

# Post-consolidation follow-ups (2026-08-31, session 2)

## FIXED: HW monitor ignored the display texture

**Cause (measured on the live dev DOM via CDP + headless Chrome, not inferred).**
`65b389d` rewrote the 301 forks from
`[data-theme="arctic"] .launch-rail-tel[data-display-texture="dotted"] …` to
`[data-display-face="eink"] .launch-rail-tel …`. That moved which element the face
label is read from: the old form read it off **`.launch-rail-tel` itself**; the new
form resolves it up the **ancestor chain**.

Served-CSS facts (dev, 3 762 selector rules parsed):
- `[data-display-texture]` selectors: **0** — that attribute became inert at `65b389d`.
- Face rules that co-match `.launch-rail-tel` themselves: **none**.
- Face attribute existed on 3 component subtrees only, so the rail (and any surface
  without an attributed ancestor) resolved to **no face** on every theme.

The plan's verification matrix checked **face colors only** (3 DOTTED combos), so the
rail and the CLEAN cycle were never on the checklist — the visual pass passed
legitimately and the rail fell through the gap.

**Fix (shipped, `DisplayFaceSync`).** The face is now published on `<html>` by a
provider-mounted effect, mirroring how frame texture already worked
(`IndustrialBezelTextureContext` → `html[data-industrial-bezel]`). Single source:

| File | Change |
|---|---|
| `src/lib/applyDisplayFace.ts` | new — one place that writes `html[data-display-face]` |
| `src/context/DisplayFaceSync.tsx` | new — effect on `theme.id` + `texture`; mounted in `App.tsx` inside `ThemeProvider` + `DisplayTextureProvider` |
| `LaunchRailTelemetry.tsx` | dropped the never-consulted per-component attrs + now-unused hooks |
| `EngineConfigPanel.tsx` / `EngineGpuForecast.tsx` | same; unused `displayFaceFor` imports removed |

Verified face derivation, all 6 combos: `matrix|crt`, `matrix|paper`,
`slate|crt`, `slate|paper`, `arctic|eink`, `arctic|paper`. Verified the rail's cells
track the face by toggling `html[data-display-face]` on a probe cell:
`crt` → `rgb(8,8,8)` + radial dot grain; `eink`/`paper` → `rgb(247,250,252)` flat.
Confirmed by eye across all 3 themes × both Display settings, rail + `BELOW` grid.

`npx tsc --noEmit` clean.

## DECIDED: drop the third face — 2 faces, texture = grain only

**Decision (user, 2026-08-31):** simplicity wins. `DisplayFace` goes from three
values to **two**, keyed on **texture alone**, never on theme id:

| Texture | Face | Meaning |
|---|---|---|
| `dotted` | **`dotted`** | mesh of dots + scan bands on display surfaces |
| `clean` | **`flat`** | no pattern; surface is the theme's own colour |

- **Colour comes from theme tokens; texture only decides whether the pattern is on.**
  Exactly the independence the colour themes already have.
- `displayFaceFor(themeId, texture)` → `displayFaceFor(texture)`; theme id is not an input.
- **ARCTIC + DOTTED loses its separate light LCD surface.** It renders as a plain
  ARCTIC-coloured surface with the light grain on top. Assessment is deliberately
  **after the fact**: if the final ARCTIC face looks wrong, we tune ARCTIC's tokens
  (that is a colour fix), we do **not** re-add a face.
- Supersedes nothing in Tier 1–4. Consistent with Tier 4 ("leave texture libs separate").

### What retiring the theme-derived face means (measured, `git grep`)

Face rules per file (selector occurrences, at `214f1b0d6`):
`fusion-display.css` 200 · `launch.css` 37 · `config.css` 6 · `cockpit.css` 3.

| Old face | Rules | Becomes |
|---|---|---|
| `crt` (dark+DOTTED) | 23 | **`dotted`** — grain + dark tokens |
| `eink` (ARCTIC+DOTTED) | 72 | **`dotted`** — grain + each theme's own tokens |
| `paper` (any+CLEAN) | 22 | **`flat`** |

The merge is what collapses the `-light-` fork: `eink` ink rules and `crt` ink rules
become the *same* `dotted` rule reading `--display-face-*`, and each theme supplies
its own value. Target = CSS asks only `"is the pattern on?"`, never `"is this ARCTIC?"`.

**Token debt this exposes** (31 `-light-` tokens are referenced from face rules today,
so they cannot just be deleted): 18 of them are referenced **only** from non-face
(always-on, theme-driven) rules — `…-grain-cell/-scan`, `…-dot`, `…-band`,
`…-texture-blend`, `…-plate-ink(-soft)`, `…-source-lab`, `…-source-kind-*`,
`…-gpu-name(-selected)`, `…-gpu-selected-*`, `…-text-red`, `…-text-violet`. Those need
to become ordinary theme tokens (or fold into their non-`light` twin) before the face
attribute can go away, or the merge loses colour.

## Open: `gpu-readout` token gaps (not covered by any tier)

`--display-face-gpu-readout` / `-muted` are defined on **MATRIX + ARCTIC only** —
**SLATE has none**, so `fusion-display.css` (3 sites) and `GpuTopology.tsx` fall back
to `var(--theme-accent)` on SLATE. `--display-face-light-gpu-readout` / `-muted` exist
on MATRIX + ARCTIC but are referenced by **0 rules**. Fold into the face work above.

## Method (do not do it in one pass)

1. ~~**Rail fix**~~ — ✅ DONE. Done by making `<html>` the single face source rather
   than patching the rail, so every surface benefits and no selector is touched.
   This also removed the *reason* step 3's `themeId` coupling was load-bearing.
2. **Rename + merge faces** — `crt`/`eink` → `dotted`, `paper` → `flat`; re-key all
   246 occurrences; keep every rule's declarations byte-identical, only the selector
   changes. Now a pure CSS job: `applyDisplayFace()` is the only writer, so the
   emitted vocabulary changes in exactly one place.
   Take a screenshot baseline of all 6 combos **before** starting.
3. **Retire `-light-`** — fold the 49 tokens into theme-owned `--display-face-*`,
   drop `themeId` from `displayFaceFor`, clean `MatrixAsciiRain` (its
   `face === "paper" && theme.id === "arctic"` special case) and the
   `fusionShareCapture` variant face handling.

### Note for step 2 — why merging is now safe

The old blocker for two faces was that `crt` and `eink` were **different surfaces**
(dark glass vs light LCD) driven by theme. With the face on `<html>` and colour
already flowing from theme tokens, merging them into `dotted` keeps the grain
identical and lets each theme supply its own colour — which is exactly the intended
end state. Expect ARCTIC + DOTTED to change appearance at that step; that is the
accepted trade, assessed after.

### Verification (extends the matrix above — add the missing axes)

- All **6** theme × texture combos, not 3.
- **HW monitor rail + `BELOW` grid** in all 6 (the axis that was missed).
- `npm run build` + `npx tsc --noEmit` clean.
