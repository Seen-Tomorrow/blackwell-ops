# CSS Refactor — Plan vs Delivery (2026-10-16)

Plan: `docs/css-refactor-plan.md` (written before edits).
This report grades the delivery against it. Nothing here claims visual equivalence
that was not verified; the app UI was not screenshot-tested in this environment.

## Scorecard

| Measure | Baseline | Target | Delivered | Grade |
|---|---|---|---|---|
| CSS source bytes (LF-normalized) | 738,557 B / 22 files | -10% | **660,495 B / 21 files (-78,062, -10.6%)** | PASS |
| CSS source lines | 25,713 | — | **22,733 (-2,980, -11.6%)** | PASS |
| Built CSS | 557,584 B | -8% | **499,740 B (-57,844, -10.4%)** | PASS |
| Built CSS gzip | 82,869 B | — | **75,284 B (-7,585, -9.2%)** | PASS |
| Built rules | 4,337 | — | **3,903 (-434, -10.0%)** | PASS |
| Source `!important` | 525 | <=475 (>=50 removed) | **471 (-54)** | PASS numerically |
| — of which Phase 2 redundancy removal | 0 | 50-150 beyond Phase 1 | **7** | FAIL (Phase 2 promise) |
| Strictly dead rules | 427 / ~73 KB | 0 | **0 / 0 B** | PASS |
| Dead classes | 378 | 0 | **55 (only inside mixed selectors)** | PARTIAL |
| Orphan keyframes | 14 | 0 | **0** | PASS |
| Explicit cascade layers | no | base/components/utilities | **NOT SHIPPED — rejected after experiment** | FAIL, by design |
| Type-scale last-import hack | undocumented fragility | removed | **kept, now enforced by `css:audit` import-order check** | PARTIAL |
| Guardrails | none | audit + budgets | **css-tools, budgets, npm scripts, import-order check** | PASS |

## What was actually removed

- `src/controls.css` (341 lines / 8,054 B) — imported by `main.tsx` but every
  control class (`switch`, `slider`, `toggle-*`, `texture`, `light`) was unused.
- 368 rules removed across 11 partials (391 including nested at-rules), plus 14
  orphaned keyframes, from `harness-wizard__*` (retired wizard), dead
  `full-auto-cockpit`/`vram-fc`/`launch-rail-tel` subfamilies, legacy
  `mono-panel`/`runtime-section*` override layer, old `text-[Npx]`/`divide-*`
  remnants.
- 54 `!important` declarations: 47 lived inside dead rules, 7 were proven
  redundant statically (no competing `!important` for the property anywhere, no
  normal rule with equal/higher specificity, property not used in inline styles).
- `src/controls.css` import removed from `src/main.tsx`.

## Verification performed

- Build: `npx vite build` succeeds.
- TypeScript: `npx tsc --noEmit` exits 0.
- Tests: `npx vitest run` 12 files / 108 tests pass.
- Rule-level diff against `tmp/css-pre-prune/`: 3,258 kept rules byte-identical
  (whitespace-normalized), 373 removed, 5 changed (the 7 intentional
  `!important` removals), 0 unexpected new/modified rules.
- Audit: strict-dead rules 0; budgets pass via `npm run css:audit`.
- Files: test `repoInvariants.test.ts` now tolerates a tracked file deleted in
  the working tree (needed while `src/controls.css` deletion is uncommitted).

## Phase 2: why cascade layers were not shipped

The experiment (`scripts/postcss-tailwind-layers.mjs`, archived, not wired into
`postcss.config.js`) wrapped partials in native layers through a PostCSS plugin
running after import-inlining and before Tailwind. It built cleanly and produced
`bw-tokens -> bw-components -> bw-utilities`.

It was rejected because the cascade semantics change more than the plan assumed:

1. Unlayered normal declarations beat **all** layered normal declarations
   regardless of specificity. Tailwind v3 emits unlayered CSS, so every Tailwind
   utility would start beating high-specificity component overrides that
   currently win by specificity. That is a real visual-behavior change across a
   large surface, not a mechanical move.
2. To preserve the old "specificity first, order breaks ties" behavior, all
   rules would have to stay in one layer — i.e. layers would buy nothing.
3. Tailwind's own `@layer base/components/utilities` directive is not usable for
   wrapping the existing partials: it tree-shakes rules by content scanning and
   drops classes that exist only as dynamically composed strings.

So the honest state is: the deterministic-layer goal is **not delivered**. What
was delivered instead is an enforced canonical import order (`css:audit` fails if
`index.css` imports change), so the documented type-scale ordering hazard cannot
regress silently.

## Remaining backlog (unchanged, measured)

- 55 dead classes still referenced only inside rules that also contain live
  classes (e.g. `.dead-ancestor .live-descendant`); safe removal needs per-rule
  review because the live class owns the rule.
- 471 `!important` declarations; static analysis finds only 7 more provably
  redundant. The rest encode visual decisions and need per-screen QA to move
  into lower-specificity/layered form.
- 858 hex + 194 rgba literals, 540 `color-mix()` calls with literal colors,
  337 px font sizes, 159 font-family declarations.
- Theme-as-delta (MATRIX repeats 92/106 CSS defaults), primitives consolidation,
  route-level CSS splitting, CSS Modules for new components.

## Rollback

- Pre-prune originals: `tmp/css-pre-prune/`.
- Removed-selector manifest: `tmp/css-prune-manifest.json`.
- `git restore src/styles src/index.css src/main.tsx src/controls.css` (will also
  discard the intentional refactor, so use the manifest/backup for partial).
