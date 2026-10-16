# CSS Architecture Refactor — Plan (written before execution)

## Goal
Make styling deterministic and cheap to change, and shrink the source without visual regressions.

## Success measures (graded at the end)
| Measure | Baseline | Phase 1+2 target |
|---|---|---|
| CSS source bytes | 747,330 B (22 files incl. controls.css) | -10% or better |
| Built CSS | 557,584 B (82,869 gzip) | -8% or better |
| `!important` in source | 525 | <= 475 (>=50 removed), no increase |
| Cascade order | implicit, type-scale.css must be last | explicit layers, no last-import hack |
| Dead classes | ~368 estimated, not enforceable | zero by audit, CI budget in place |
| Guardrails | none | `npm run css:audit` checks dead classes, !important, literal colors |

## Phase 0 — measure + guardrails
- Record baseline (done: src 747,330 B / 25,713 lines; dist 557,584 B / 82,869 gzip / 4,337 rules / 514 !important).
- Add `scripts/css-audit.mjs`:
  - builds a class-usage index from className/string literals in `src`, tests, scripts, Rust/HTML where relevant;
  - detects dynamic class construction (`foo-${bar}`, `'foo-' + x`, `classList`, string literals in tests);
  - reports dead classes, strictly-dead rules, `!important`, literal colors, px font sizes, color-mix literals;
  - `--check` exits 1 on budget violations.
- Add `css:audit` / `css:audit:ci` npm scripts.
- Add one-off `scripts/css-prune.mjs --write` that removes only rules where every class is statically dead, plus keyframes orphaned by those removals; emits a removal manifest.

## Phase 1 — delete dead and retired CSS
1. Remove `src/controls.css` and its import in `main.tsx`; remove the orphaned `.toggle-switch`/`.switch`/`.slider`/`.texture`/`.light` rules in chrome/config/launch/animations (all classes have zero literal usage).
2. Remove retired `harness-wizard__*` family in cockpit.css (~108 rules / ~21 KB; component replaced by HarnessConnectPanel).
3. Prune the strict-dead set from the audit (rules whose every class is statically dead and not dynamic; includes legacy `.mono-panel`, `.runtime-section-green`, `.runtime-profile-*` override layer in config.css, old `text-[Npx]`/`divide-stealth-border` remnants).
4. Remove orphaned `@keyframes` (audit found 5; ~673 B).
5. Keep a removal manifest (selector, file, reason) so regressions are one `git restore` away.

Expected: source -80..110 KB (11-15%); built CSS -40..70 KB; `!important` -50..80 (most dead rules carry them).
Risk: false-positive dead class if runtime composition is exotic. Mitigation: conservative usage index incl. dynamic prefixes, tests and scripts; prune only all-classes-dead rules; build + test after.

## Phase 2 — deterministic cascade
1. Wrap index.css imports in Tailwind layers:
   - base: tokens-base
   - components: domain partials (chrome/catalog/cockpit/launch/fusion/...)
   - utilities: utilities.css + type-scale.css
   Verify Vite/PostCSS inlines imports inside layer blocks and the built order is base < components < utilities.
2. Delete the "type-scale.css must be last" load-order hack and its warnings; layer position now enforces the outcome.
3. Convert the highest-leverage context overrides (`[data-config-panel] ...`, `[data-model-catalog] ...`, compact-density contexts) to `:where(context) target` and drop `!important` where the rule already wins by order/specificity. Automate only provably-redundant ones; do not hand-wave the rest.
4. Move Tailwind-paint corrections (e.g. `.text-white` inside app surfaces) into the utilities layer and drop `!important` where layer position replaces it.
5. Guardrail: audit records `!important` count and fails if it grows above the post-refactor budget; type-scale ordering tests replaced by a built-order assertion.

Expected: explicit base/components/utilities order; last-import hack gone; 50-150 `!important` removed beyond phase 1. **Not expected:** all 525 gone. The remainder encode visual decisions that need per-screen QA; they stay behind a budget and a follow-up list.
Risk: moving files between Tailwind layers can change cascade outcomes (currently partials are emitted before `@tailwind base`). Mitigation: verify built ordering, diff emitted selector/declaration sets, run tests/build.

## Phase 3+ — not in this pass
- 15-25 shared primitives (panel/chip/button/label/bar/input) to collapse repeated recipes.
- Token completion: 949 hex + 256 rgba literals, 573 literal color-mix calls, 403 px font sizes, 185 font-family repeats.
- Theme-as-delta: MATRIX currently repeats 92/106 CSS defaults; ARCTIC has ~92 extra tokens.
- Route/tab-level CSS splitting and CSS Modules for new components.
- Replace remaining paint utilities in TSX and delete their override rules.

## Honest stop rule
If phase 2's layer move cannot be verified as order-equivalent, I ship phase 1 + the layer scaffold and report the exact shortfall rather than claim success.
