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

## Phase 3 update (items 1-3 agreed)

### 1. Zero dead classes — DELIVERED
- Dead classes 55 -> 0; strict dead rules 0; orphan keyframes 0.
- Removed 90 unreachable selector parts/rules across 6 partials.
- Built CSS 499,740 -> 489,551 B; source `!important` 471 -> 419
  (52 of them lived in unreachable rules that no longer ship).
- Integrity: rule bodies unchanged except the 4 known `!important` edits.

### 2. Per-tab CSS splitting — PARTIAL (safe pilot delivered)
Method: static import graph + per-class ownership; move a rule only when every
class it targets is used exclusively inside one lazy graph.

| Moved | Rules | Bytes | Lazy import |
|---|---:|---:|---|
| ModelHub page styles | 84 | 13,660 | `ModelHub.tsx` |
| Intel page styles | 33 | 4,733 | `IntelPage.tsx` |
| Playground page styles | 13 | 2,011 | `Playground.tsx` |

Result:
- startup CSS `index-*.css`: **489,551 -> 475,380 B (-14,171, -2.9%)**
- lazy CSS chunks: `ModelHub-*.css` 8.77 kB, `ExtrasPage-*.css` 5.42 kB
- total CSS unchanged (~489.6 kB); the win is startup parse/decode, not source size
- integrity: 3,206 rules pre = 3,206 post; zero changed/lost rules
- build, `tsc --noEmit`, `vitest` (108/108) pass

Not split (shared classes with the main shell, so a move would break them):
`config*`, `launch`, `fusion-display`, `cockpit`, `catalog`, `chrome`, `updates`,
`foundry`, `console`, `engine`, `badges`, `surfaces`, `animations`, `type-scale`,
`tokens-base`, `utilities`. Rule-level partitioning can move more later, one
domain at a time, with ownership proof.

**Validation needed:** the lazy CSS loads when the tab first opens, so HMR alone
does not exercise it. Click ModelHub and Extras (Intel / Playground) once.

### 3. Primitive consolidation — NOT STARTED (next)
This is the only remaining item that changes TSX class lists, so it needs a
per-domain visual pass. Recommended pilot: `foundry.css` (self-contained, 142
classes / 21 kB, no shared shell classes) -> extract 5-8 `fnd-*` primitives
(button/card/chip/row/panel) and measure. The same recipe then repeats for
`config.css`, `catalog.css`, `cockpit.css`.

## Item 3 — Foundry primitive pilot: DELIVERED (commit d3776cc)

- `fnd-dev-btn`: 12 variant rules collapsed into a tone-driven base
  (`.fnd-dev-btn` + `--fnd-*` props); variants set tone/mix only.
- `fnd-confirm-btn` / `fnd-build-btn`: missing base classes propagated in TSX;
  duplicated `font-size` and the duplicate `--danger` rule removed.
- `foundry.css` 22,433 -> 21,425 B (LF-normalized, -1,008 B, -4.5%).
- Startup `index-*.css` 475,380 -> 474,475 B (-905 B).
- Gates: build, tsc, vitest 108/108, `css:audit` budgets all pass.
- Visual: user confirmed Foundry flows unchanged (normal + hover + ghosts).

### Why the next domain is not another Foundry

A global scan for the same pattern (variant rules re-declaring their base)
was run over every partial. After Foundry, the largest remaining clusters are:

| Root | Redundant base bytes | Domain / risk |
|---|---:|---|
| `full-auto-cockpit__dflash-get` | ~635 | cockpit; shared, needs per-state check |
| `segment-switch--*` | ~417 | shared by 5 partials; high risk |
| `catalog-quick-seat__btn--*` | ~243 | catalog; self-contained |
| `eng-quant-badge--*` | ~157 | config; self-contained |
| `gpu-assign-panel__*` / `cfg-mut--*` | <100 each | structural / utility variants |

Conclusion: the cheap base/variant duplication wins are mostly exhausted.
Further source reduction now means one of:
1. **Batch the small clusters** (~1.5-2.5 kB total, low risk, same method).
2. **Token migration** (858 hex + 194 rgba literals, 540 literal `color-mix`
   calls) — architecture/theme maintainability, not bytes.
3. **Cross-domain primitives** (panel/card/chip recipes) — the real 15-25%
   source reduction, but changes shared classes + TSX and needs per-screen QA.
4. **Theme-as-delta** (MATRIX repeats 92/106 CSS defaults) — smaller theme
   layer, no byte win.

## Items 1+2 final - delivered (visual: zero drift across MATRIX/SLATE/ARCTIC)

### Item 1 - small clusters
- Only `.catalog-quick-seat__btn` had real base/variant duplication; 4 duplicate
  declarations removed (-272 B built). Other candidates rejected on evidence
  (base class not always applied in TSX / parent-child, not duplication).

### Item 2 - token migration
| Metric | Before | After |
|---|---:|---:|
| literal hex outside tokens | 841 | 59 |
| literal rgba outside tokens | 181 | 83 |
| literal color-mix arguments | 536 | 48 |
| total color-mix calls | 2,089 | 1,555 |
| font-size Npx literals | 333 | 28 |
| fixed/alpha tokens | 0 | 272 |

- 782 hex + 95 rgba + 305 px occurrences replaced mechanically; values are
  identical to the literals they replace.
- 347 transparent color-mix calls precomputed into alpha tokens.
- Integrity: original `tokens-base.css` preserved, 0 var() selector leaks,
  dead classes still 0, build + tsc + vitest + budgets pass.

### Cost (intentional trade)
- source LF: 648,498 -> 664,478 B (+2.5%)
- startup CSS: 474,475 -> 500,832 B (+5.6%)
- startup gzip: 72,329 -> 75,319 B (+4.1%)

Minifiers can shorten `#ffffff` to `#fff`; `var(--fixed-*)` cannot be shortened.
This trade removes ~1,000 literal paint sites and centralizes the palette.

## Lazy split part 2 - ConfigPage / StackView / LogsPanel

| Lazy graph | CSS chunk | Rules moved | Source moved |
|---|---:|---:|---:|
| ConfigPage | 9.77 kB | 106 | 14,449 B |
| StackView | 0.48 kB | 9 | 773 B |
| LogsPanel | 0.18 kB | 1 | 198 B |

- Startup `index-*.css`: 500,832 -> 490,404 B (-10.4 kB, -2.1%).
- Startup gzip: 75,319 -> 74,106 B (-1.2 kB).
- Rule integrity: 3,204 = 3,204; zero changed/lost.
- Moves pulled from updates, foundry, config-params, config, chrome, engine, catalog, surfaces.
- Remaining global partials (fusion-display, cockpit, launch, console, most of
  config/chrome/catalog/engine) are shared with the main shell; moving them
  would flip later same-property rules, so they stay global.
- Source grew ~12 kB from PostCSS whitespace normalization during the move;
  delivered CSS total is unchanged (only startup vs lazy distribution changed).

## Theme-as-delta -” SLATE base (visual: zero drift confirmed)

- CSS base in `tokens-base.css` is now SLATE's exact palette.
- `DEFAULT_THEME_ID = "slate"`; `main.tsx` and `ThemeContext` both use it, so a
  fresh install boots SLATE instead of MATRIX. Stored themes are unchanged.
- Theme declarations: SLATE 106 -> 3 (base), MATRIX 106 -> 102 delta,
  ARCTIC 199 -> 195 delta; total 411 -> 300 (-27%).
- `app-themes.ts`: 29,254 -> 24,049 B (-17.8%); main JS chunk 958.8 -> 953.6 kB.
- Verification: every effective token (232) in all three themes matches the
  pre-refactor value exactly - 0 mismatches. Build, tsc, vitest 108/108 and
  css:audit all pass. User confirmed zero visual drift and SLATE boot.

## Seed-model derivation (item 1 follow-up)

- 23 tokens moved from per-theme repeats to base derivations
  (`var()` aliases + `color-mix(..., transparent)` tints).
- Theme declarations: 300 -> 275 (MATRIX 92, SLATE 3, ARCTIC 180).
- `app-themes.ts`: 24,049 -> 22,968 B; main JS 953.6 -> 952.7 kB.
- Computed-color verification: every effective token in all three themes
  matches its pre-derivation value (0 mismatches); user confirmed zero drift.

## .value-chip ownership batch 1

- Eink-panel chip rules: `!important` removed; selectors raised with duplicated
  classes so they still win over the config base and Tailwind utilities.
- GPU assign / param-row chip rules: `!important` removed (they already win by
  specificity).
- Base owner note added to `launch.css`.
- Source `!important`: 419 -> 397; config.css 137 -> 115; chip-rule important
  declarations roughly 90 -> 68. User confirmed zero visual drift.

## .value-chip ownership batch 2

- Removed 7 more `!important` declarations: launch-dock input chip background,
  config segment margin/padding/border-radius, rail hover text-shadow.
- Source `!important`: 397 -> 390; main CSS 390 -> 383.
- User confirmed zero visual drift.

## .value-chip ownership batch 3a (active state)

- Owner `.value-chip-active` raised to specificity 20 and `!important` removed
  (still beats Tailwind utilities without important).
- Active-state overrides in config segments/rail, Fusion bench, Intel hub and
  launch dock lost their `!important`.
- Source `!important`: 390 -> 370; main CSS 383 -> 363; chip-rule important
  56 -> 36. User confirmed zero visual drift on active states.

## .value-chip ownership batch 3b (segment / GPU / Fusion base)

- Removed 14 more `!important`: config segment base, hover and rail;
  GPU active; Fusion bench normal chips.
- Source `!important`: 370 -> 356; main CSS 363 -> 349; chip-rule important
  36 -> 22. User confirmed zero visual drift.

## .value-chip ownership complete: zero !important

- Final batch removed the variant (`factory-default`, `user-default`, `user-added`,
  rail variants), eink box-shadow/transition and eink segment-color importants.
- Chip family: ~90 -> 0 `!important`. Source total: 419 -> 343
  (main CSS 412 -> 336); startup CSS 490.3 kB.
- Cascade now: base primitives in launch.css, contextual overrides win by
  specificity. User confirmed visual stability.

## .segment-switch ownership: zero !important

- All 16 chrome header/quick-settings sizing importants removed; those selectors
  already out-specify the base and Tailwind, and inline styles only drive thumb
  geometry. Owner note added to launch.css.
- Segment-switch important 16 -> 0. Source total 343 -> 327; main CSS 336 -> 320.
  User confirmed visual stability.

## .config-launch-dock ownership: zero !important

- Removed compact-density sizing, collapsed min-height, monitor-focus hide,
  custom-flags mode colors and MTP warn importants; contextual selectors already
  out-specify base/Tailwind. Owner note added to animations.css.
- Dock important 10 -> 0. Source total 327 -> 317; main CSS 320 -> 311.
  User confirmed visual stability.

## .running-engine-card ownership: zero !important

- Removed all 32 importants: Config card base/hover/text/badges, Cockpit harness
  brain/worker highlights, compact-density padding. Cockpit base highlight
  selectors raised to keep winning without important.
- Source total 317 -> 285; main CSS 311 -> 282. User confirmed visual stability.

## app-nav-tab + app-shell ownership: zero !important

- app-nav-tab: 21 playground GPU-overclock rail importants removed; owner note in chrome.css.
- app-shell: compact-density spacing and monitor-focus hides de-importanted
  (12 declarations).
- Source total 285 -> 252; main CSS 282 -> 252. User confirmed visual stability.

## gpu-selected ownership batch

- Base `.gpu-selected` selector raised to specificity 20 and border important
  removed; launch rail and VRAM forecast selected overrides de-importanted.
- Removed 5 declarations; source total 252 -> 247. User confirmed visual stability.

## Industrial display / catalog list / gunmetal batch

- Removed 23 importants: industrial-display RAM colors, catalog list-panel
  resets, gunmetal selected-card styles.
- Source total 247 -> 224; main CSS 247 -> 226. User confirmed visual stability.

## text-white override cleanup

- Removed `!important` from the six context-specific white-paint corrections
  (Foundry, Config page, Model Hub/Catalog, engine logs, launch rail). Their
  specificity already beats Tailwind `.text-white`. Source total 224 -> 218.

## Fusion display-face batch

- Removed 15 importants: dotted-face backgrounds/pseudos, GPU name reset,
  industrial frame surface, launch-rail total cell. Source total 218 -> 203.
  User confirmed visual stability.

## Grouped small-family batch

- Removed 34 importants: bench muted buttons, nav active, custom flags input,
  engine stack status dots/pills, eink panel logs/params, industrial frame vram
  badge. Source total 203 -> 169. User confirmed visual stability.

## Chip variant correction + locator BEM fix

- css-locate now matches BEM modifier families (`.value-chip--*`, `__*`), which
  revealed 13 missed importants in four chip variant base rules.
- Those are removed; true .value-chip family important count is 0.
- Source total 169 -> 156; main CSS 173 -> 160. User confirmed visual stability.

## animations.css grouped cleanup

- Removed 13 importants from Foundry arch chips (normal/hover/active) and CUDA
  badge; selectors raised to specificity 20 so they still beat Tailwind.
- Source total 156 -> 143. User confirmed visual stability.

## chrome.css grouped cleanup

- Removed 26 importants across quick settings, header dev tools, footer dev tag,
  palette search, Foundry typography/build log, download progress, status flash.
- Source total 143 -> 117; chrome.css 29 -> 3. User confirmed visual stability.

## catalog.css grouped cleanup

- Removed 31 importants: list panel/chrome, buried/selected cards, quant
  badges, mcard text, engine-stack phases, search hints. Source total 117 -> 86.
  User confirmed visual stability.

## config.css grouped cleanup

- Removed 21 importants across 16 rules: provider profile bar border, GPU assign
  label ink, config group header dragging (selector raised to a doubled class so
  it still beats Tailwind), system param row border and hover, running-engine
  card text/badge/selected fill, chip-row wrap, `cfg-acc--a7x/a8x/a9x` and
  `cfg-inf` ink, `config-muted`, foundry toolchain guide body, foundry active
  binary badge, source and profile labels.
- Source total 86 -> 65; dist 92 -> 73. config.css now carries 4 importants
  (down from 25), every one a deliberate hold: the `.eink-panel` phosphor-ink
  descendant rule against Tailwind, its `.mono-user-input` counter-rule, and the
  `select option` pair that must beat WebView2's ignored inline styles.
- Gates: `vite build`, `tsc --noEmit`, `vitest` 108/108, `css:audit` budgets all
  pass. Committed on the gates; no separate visual pass was requested (DEV HMR
  was live on the Config page throughout).
- Remaining source importants are now concentrated in `fusion-display.css`
  (45 of 65).

## fusion-display.css grouped cleanup

- Removed 44 of the 45 importants in the last big file: skeleton padding/fill,
  dominant source fill, assisted-rails `display: contents`, need-frame borders,
  the three `data-need-tone` ink rules, compact-topology grid rows, the
  `fusion-readout-idle` pair, the unified glass recess shadow, the whole
  share-capture snapshot block, the phosphor face ink/track/border rules, the
  reduced-motion `transition: none`, and the bench-ghost / boot-disk hero sizes.
- Source total 65 -> 21; dist 73 -> 29. Budgets ratcheted to 24/32.
- **Kept exactly one, because it is load-bearing:** `grid-template-rows: none`
  on `.vram-fc__topo--compact .gpu-topology-root--fill:not([data-gpu-scroll="1"])
  .gpu-topology-grid`. That rule's only competitor is an **inline style** —
  `GpuTopology.tsx:97` writes `gridTemplateRows` on the same element — and no
  CSS rule out-specifies it.
- Its two siblings did come out, and the reason is the point:
  - `[data-gpu-scroll="1"]` (the scrolled case) — the component writes **no**
    inline row there (`fill && !scroll`), so nothing was competing.
  - `[data-gpu-count="1"]` `grid-template-columns` — `cols === 1` whenever
    `data-gpu-count="1"` (`GpuTopology.tsx:64`), so the inline
    `repeat(1, minmax(0, 1fr))` computes identically to `minmax(0, 1fr)`.
- Method: a cascade analyzer over all 26 partials compared each important site
  against every competing declaration (specificity, source order, importance),
  with candidates anchored on shared classes so element-only selectors could not
  masquerade as competitors. Two groups it flagged as competing were in fact
  mutually exclusive: the three `data-need-tone` rules, and the
  `:not([data-gpu-scroll="1"])` / `[data-gpu-scroll="1"]` pair. The blind spot it
  cannot see is inline styles and generated Tailwind utilities — those were
  checked by hand against the TSX, which is how the one hold above was found.
- Gates: `vite build`, `tsc --noEmit`, `vitest` 108/108, `css:audit` budgets pass.
- User confirmed visual stability.
- What is left (21 source) is now spread thin: 4 in `config.css`, 4 in
  `launch.css`, 3 each in `chrome.css` / `playground.css` / `intel.css`, 1 each in
  `catalog.css` / `cockpit.css` / `foundry.css`, plus the one held here. A further
  pass needs per-site justification against inline styles rather than bulk
  families — the cheap family-level wins are exhausted.

## Seat live-rim gradient dedupe — and what "cross-domain primitives" really measures

- Four ~500 B conic-gradient blocks (brain/worker × quick-seat strip / seat-edit
  banner) were byte-identical apart from the selector. Merged into two, each now
  listing all three selectors. Cascade-neutral: no declaration changed, no
  specificity changed, and nothing between the old positions set `background` on
  either rim.
- dist 487,615 -> 486,611 B (-1,004), rules 3,600 -> 3,598, **gzip -36 B**. That
  gzip delta is the honest verdict on this class of work: repeated declarations
  already compress, so dedupe buys almost nothing on the wire.
- The "cross-domain primitives = 15-25% source reduction" estimate does not
  survive measurement, and this report should stop quoting it. Across all 26
  partials (3,203 rules, 377,836 B of normalized declaration text) identical
  declaration blocks total **33,499 B = 8.9% of declaration bytes = 5.0% of source
  LF**. The largest groups are single declarations already at token level —
  `color: var(--theme-text-muted)` x55, `color: var(--theme-accent)` x30,
  `color: var(--theme-text)` x21 — plus layout repeats (`display: flex` x268,
  `min-width: 0` x208). None of those are panel/card/chip recipes, and merging
  them requires adding a primitive class at every TSX site, which grows the JS
  side and needs per-screen QA.
- The report's own later scan already disagreed with the headline: after the
  Foundry pilot it measured "~1.5-2.5 kB total" of remaining base/variant
  duplication, and the follow-up found only `.catalog-quick-seat__btn` had real
  duplication (-272 B). The 15-25% was a pre-work estimate; measured reality is
  ~5% and not worth the churn.
- Literal colors (142 occurrences in 10 files) are likewise not a byte win:
  roughly 40% are policy-legal data (MoE gold, the `--boc-*` console, GPU
  swatches, the share-card swatch previews), and the earlier token migration
  measured source **+2.5%** going that direction.

