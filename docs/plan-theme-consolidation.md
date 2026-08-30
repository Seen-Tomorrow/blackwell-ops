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
