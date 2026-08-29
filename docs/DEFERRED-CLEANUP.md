# Deferred cleanup — frontend slop (findings 4–7)

Working memo for the **non-decision** findings from the frontend AI-slop audit.
Written so a later pass can pick these up cold, without re-running the audit.

**Audit date:** 2026-08-29. **Coverage:** 250/250 files under `src/` (~90K LOC:
114 `.tsx`, 120 `.ts`, 15 `.css`). **Tree state at time of writing: clean — no
findings here have been fixed.**

**Scope of this doc: findings 4, 5, 6, 7 only.** Findings 1–3 are deliberately
NOT here —
1. **Resolved (2026-08-29):** archived AtomCode/Qwen backends are gone; cockpit chrome
   renamed to neutral `harness-*` (no dual-stack product path left).
2. `VramFitBadge` formula fit label vs measured-only law — **product decision**, not cleanup.
3. `FIT_SCAN_POINTS_TOTAL` = 10 in `src/lib/fitScanTable.ts:4` vs `SCAN_PLAN` = 8 entries in
   `fit_scanner.rs:31` is a live correctness defect and should be fixed on its own, not
   batched into cleanup.

Every item below was re-verified against the tree, not just relayed from a
subagent. Verification commands are inline so claims can be re-checked after
drift.

---

## 4. Raw Tailwind palette classes bypass the theme system

### Root cause (read this before touching anything)

`tailwind.config.js` maps **only four families** to CSS variables:

| Family | Maps to |
|---|---|
| `stealth.*` | `--theme-stealth-dark`, `--theme-bg`, `--theme-panel`, `--theme-border`, `--theme-text-muted` |
| `nv.*` | `--theme-accent`, `--theme-accent-dim` |
| `telemetry.*` | `--theme-secondary-bright`, `--theme-accent-bright` (+ `telemetry.red` = literal `#ff3333`) |
| `theme.*` | `--theme-bg`, `--theme-text`, `--theme-text-muted`, `--theme-panel`, `--theme-border`, `--theme-accent` |

`yellow-400`, `red-400`, `orange-400`, etc. are **not** in `extend.colors`, so
they resolve to Tailwind's fixed default palette. They are structurally
incapable of following the theme picker. This is why Arctic / e-ink renders
wrong on these surfaces — not a per-file bug, one missing token vocabulary.

There is **no semantic warn/critical token today**:

```
rg -o "\-\-theme-[a-z0-9-]*(warn|amber|alert|danger|crit)[a-z0-9-]*" src/themes/app-themes.ts
--theme-tel-amber
--theme-tel-amber-deep
--theme-tel-amber-ink
```

`--theme-tel-amber*` is telemetry-panel chrome, not a general warn state.

### Measured usage (whole `src/`)

| Class | Uses | Class | Uses |
|---|---|---|---|
| `text-yellow-400` | 73 | `bg-red-500` | 14 |
| `text-red-400` | 57 | `bg-red-400` | 9 |
| `border-yellow-400` | 55 | `bg-orange-400` | 8 |
| `bg-yellow-400` | 44 | `text-orange-400` | 6 |
| `border-red-400` | 18 | `text-blue-400` | 6 |
| `text-yellow-300` | 11 | `text-amber-400` | 6 |

≈350 occurrences total. 25 files use `yellow-400`/`yellow-300`.

Heaviest files:

```
39 src/components/DistributionDevPanel.tsx   ← DEV-only, isDevBuild() gated — lowest priority
32 src/components/UpdatesConfig.tsx
29 src/components/ModelHubSearch.tsx
19 src/components/ParamConfigPanel.tsx
18 src/components/DownloadProgressRow.tsx
18 src/components/ParamCreatorModal.tsx     ← itself orphaned, see finding 7
16 src/components/FoundryToolchainPanel.tsx
15 src/components/FoundryBuildProgress.tsx
15 src/components/ModelCard.tsx
15 src/components/ProvidersConfig.tsx
15 src/components/ValueBubbles.tsx
15 src/services/vram/shared.ts
```

### Inconsistency worth noting (the real smell)

Two components theme **one** state and hard-code the rest:

- `FusionFuelTank.tsx:5-11` — "ok" uses `bg-nv-green` (themed), warn/critical use
  `bg-red-500` / `bg-orange-400` / `text-red-500` / `text-orange-400` (not themed).
- `VramBadge.tsx` — the **VRAM** bar uses `s.gpuBarColor` (theme-aware, from the
  manifest) while the adjacent **RAM** bar hard-codes `bg-red-500` /
  `bg-orange-400/70` / `bg-blue-700`.

`src/services/vram/shared.ts:648-656` is a legitimate palette *source*
(`gpuBarColor`, `bgTint`, `badgeBg` are emitted as class strings by the
forecast layer) — treat it as the migration point, not as another offender to
patch in place.

### Fix (one pass, in this order)

1. Add semantic tokens to **all** themes in `src/themes/app-themes.ts` —
   `--theme-warn`, `--theme-warn-dim`, `--theme-crit`, `--theme-crit-dim`,
   `--theme-info`. Per project law: every token on **every** theme, no Arctic
   special-casing.
2. Register them in `tailwind.config.js` `extend.colors` (e.g. `warn: { DEFAULT, dim }`)
   so existing utility-class idioms keep working.
3. Migrate the shipped UI. `DistributionDevPanel.tsx` and `ParamCreatorModal.tsx`
   can be skipped (DEV-gated / slated for deletion).
4. Then grep-gate: no `-(red|yellow|orange|amber|green|blue)-[0-9]` in `src/**/*.tsx`
   outside the token-definition sites.

Do **not** add `[data-theme="…"]` component rules to patch these — that is the
exact fork pattern `AGENTS.md` prohibits.

---

## 5. Hard-coded hex literals outside `src/themes/`

95 occurrences. `src/themes/app-themes.ts` is the sanctioned location; these are not.

| Count | File |
|---|---|
| 18 | `src/components/AnsiText.tsx` |
| 17 | `src/lib/fusionShareCapture.tsx` |
| 14 | `src/components/LaunchPresetsModal.tsx` |
| 9 | `src/components/GpuTopology.tsx` |
| 8 | `src/lib/benchHwTopo.ts` |
| 4 | `src/components/EngineConfigPanel.tsx` |
| 4 | `src/components/ctxForecastRibbonMath.ts` |
| 3 | `src/components/LaunchPresetConfirmModal.tsx` |
| 3 | `src/components/MoeBadge.tsx` |
| 3 | `src/components/ParamMetaEditor.tsx` |
| 3 | `src/lib/playgroundCodegen.ts` |
| 2 | `src/components/FusionTpsDisplay.tsx` (orphaned, finding 7) |
| 2 | `src/components/ParamCreatorModal.tsx` (orphaned, finding 7) |
| 1 | `src/App.tsx` |
| 1 | `src/components/ErrorBoundary.tsx` |

### Named cases

**`MoeBadge.tsx:14`** — three raw hexes driving an inline style, zero theme adaptation:

```ts
const textColor = isGold ? "#451A03" : shouldHighlight ? "#FB923C" : "#6B7280";
```

Related: `bg-gold-metallic` in `src/styles/config.css:2274` hard-codes
`#dfc9a8`, `#FBBF24`, `#b08700` in a gradient.

**`ErrorBoundary.tsx:33`** — full-screen crash surface:

```tsx
<div className="flex h-screen w-screen items-center justify-center bg-[#0a0c0f] p-8">
```

Wrong on any non-dark theme — and the error screen is the one surface the
operator most needs legible.

**`bg-[#1a1a2e]` — a leak being worked around in CSS.** 7 TSX uses
(`Layout.tsx:649`, `ParamCreatorModal.tsx:218,292`,
`ParamMetaEditor.tsx:54,78,125`) plus a CSS rule that exists **only** to patch
them:

```
src/styles/config.css:2047:  [data-config-page] .bg-\[\#1a1a2e\] {
```

Note `#1a1a2e` is already the fallback inside `stealth.border` →
`var(--theme-border, #1a1a2e)`. These should simply be `bg-stealth-border`.
Fixing the call sites deletes the CSS rule. Verify:

```
rg -n "1a1a2e" src
```

**`config.css` runtime blocks** — `#76B900`, `#b87a00`, `#4ade80`, `#1a1a1a`,
`#ffffff`, with `.runtime-section-green` applying `!important` on every property
to override theme tokens (8+ rules). The `!important` cascade is the tell that
the token system isn't covering this surface — that is a theme fork under
AGENTS.md ("Do not reintroduce hard-coded multi-theme palettes"). Fix by adding
the missing token, not by strengthening the override.

**Caveat — do not blind-migrate:** `AnsiText.tsx` (18) and `benchHwTopo.ts` (8)
are *data* palettes (ANSI 16-color table, per-GPU series colors). Those are
intentionally fixed hues, not chrome. Audit each hex for "chrome vs data"
before tokenizing; only chrome belongs in `--theme-*`.

---

## 6. Dead exports (triage required — do not bulk-delete)

Mechanical sweep result: **435 exported symbols appear in no file other than
their own**, across 114 files.

```
25 src/lib/benchPanelLayout.ts
25 src/lib/storage.ts
22 src/lib/types.ts
19 src/lib/fusionShareCapture.tsx
19 src/lib/launchPresets.ts
16 src/lib/onboardingDisplay.ts
14 src/lib/specProfiles.ts
13 src/lib/foundry_constants.ts
10 src/lib/dflashGetDraft.ts
 9 src/lib/launchPolicy.ts
 9 src/lib/multiAgentBooster.ts
 9 src/lib/specDraft.ts
 8 src/lib/configColumnLayout.ts   8 src/lib/launchProfiles.ts
 7 src/lib/customProvider.ts       7 src/lib/devFakeGpuTopo.ts
 7 src/lib/launchProfile.ts        7 src/lib/sliderParamUtils.ts
 6 src/components/BenchWidget.tsx  6 src/lib/playgroundCodegen.ts
 6 src/lib/uiShell.ts              6 src/services/vram/lowVramProbe.ts
 6 src/services/vram/shared.ts
```

Full list: `tmp/dead-exports.txt` (`file:line⇥symbol`). Regenerate with the
sweep recipe at the bottom of this doc.

### ⚠️ Why this number is NOT a to-do list

The 435 figure **includes legitimate API surface.** Verified counter-example:
`storage.ts` contributes 25 entries, yet `lib/storage` is imported by **40
files** — the flagged symbols are mostly *internal helpers used inside their own
module* (e.g. `autoVramKey` is called by its own sibling functions at
`storage.ts:824,831`) or types consumed positionally. `export` on a
module-internal helper is a lint style question, not dead code.

**Treat 435 as a candidate pool. Only remove what survives the grep below.**

### Confirmed-dead subset (each individually verified, zero references)

| Symbol | Location | Note |
|---|---|---|
| `parseCmakeFlags` | `components/FoundryComponents.tsx:19` | no importer anywhere |
| `resolveManualLaunchKeys` | `lib/launchProfile.ts:270` | no reference outside its own file |
| `isLowVramMode` | `services/vram/lowVramProbe.ts:265` | type-guard helper, unused |
| `normalizeColumnCount` | `lib/configColumnLayout.ts:22` | unused |
| `fusionShareExportPixelSize` | `lib/fusionShareCapture.tsx:226` | unused |
| `LM_STUDIO_MODEL_PATH_TEMPLATE` | `lib/onboarding.ts:5` | unused |
| `clearLastModel` | `lib/storage.ts:1032` | unused |
| `formatPerSlotTokenLabel` | `lib/sliderParamUtils.ts:90` | `@deprecated` bare alias of `formatCtxChipLabel`, zero usages |
| `ribbonFitsBoundary` | `components/ctxForecastRibbonMath.ts:94` | no call sites |

Verification recipe (a symbol is dead iff the result is exactly its own file):

```
rg -l "\bSYMBOL\b" src
```

Also check `src-tauri/src` before deleting anything a Rust command payload might
reference by name, and check for stringly-typed use in `.cmd`/batch templates.

### Sub-category: self-only helpers

Many hits are helpers called only from inside their own module. Correct fix is
to **drop the `export` keyword**, not delete the function. Do not report these
as removals.

---

## 7. Orphaned components (zero references)

Six components under `src/components/` are never imported. Safe to delete along
with their now-orphan CSS.

| Component | Lines | Verification note |
|---|---|---|
| `ParamCreatorModal.tsx` | 225 | zero external refs. Owns `bg-[#1a1a2e]` ×2 and pulls `loadParamCreatorMode` / `saveParamCreatorMode` / `ParamCreatorMode` from `storage.ts` — those become dead with it. |
| `ThemePicker.tsx` | ~40 | zero refs; theme switching lives in `AppearanceControls.tsx`. |
| `FusionTpsDisplay.tsx` | ~30 | zero refs; also carries 2 hard-coded hexes (finding 5). Superseded by the fusion hero. |
| `FusionSlotCtxBar.tsx` | ~20 | zero refs; superseded by `SlotCtxBars.tsx`. |
| `FusionPhaseBadge.tsx` | ~15 | zero refs. |
| `MiniModelCard.tsx` | ~20 | **only** remaining reference is a stale section-header comment at `src/styles/animations.css:229` (`/* ── MiniModelCard animations ─── */`) — that is not a use. Delete the component and the comment block. |

Before deleting, confirm each against Rust too (a Tauri command name or asset
path can coincidentally match) and re-run:

```
rg -l "\bComponentName\b" src src-tauri/src
```

`SlotLogPanel.tsx` and `AnsiText.tsx` were also flagged by the sweep and are
**NOT** orphaned — verified in use (`StackView.tsx`, `LogLineText.tsx`
respectively). Do not delete.

---

## Not slop — checked and cleared

Recorded so a future pass doesn't re-litigate these:

- **`SegmentSwitch.tsx` is not a fork.** `HeaderNavSegment.tsx` and
  `ProviderProfileSegment.tsx` serve genuinely different contexts (header nav
  tabs vs provider profile switching). `GpuSegmentSwitch` is a small 2-option
  wrapper used in 3 places — not one-use.
- **Comment hygiene is good.** Exactly 1 real TODO in all of `src/`:
  `components/AnsiText.tsx:32` — *"Investigate why llama.cpp sends terminal
  control codes to a ConPTY — may be related…"* (legitimate open question, keep
  it). 6 decorative banner separators, all in `fusion-display.css`. No
  FIXME/HACK/XXX, no chatbot narration, no "let's…" / "now we…" /
  "as you can see" phrasing anywhere.
- **No `@ts-ignore` / `@ts-expect-error` / `@deprecated` escape hatches, and no
  bare `as any`.** The only `any`-adjacent hit is
  `hooks/useConfigResolver.ts:73`, and that is a *comment* explaining why the
  param bag is heterogeneous — not a type escape. Type discipline is clean.
- **`tmp/archive_vram_formula/`** — deliberate archive per AGENTS.md, not dead code.
- **`scenarios/scenarios_factory.ts`** — intentional thin compat re-export, not slop.
- **`--mmproj` / `input: image` seat config, `SPECULATIVE-MTP`/`-DFLASH` template
  groups** — as designed.

---

## Recommended order

1. **Finding 3 first** (out of scope here) — `FIT_SCAN_POINTS_TOTAL` 10 vs 8 is
   small and currently wrong.
2. **Finding 7** — delete 6 orphans. Zero risk, shrinks the surface for 4/5/6.
3. **Finding 4 steps 1–2** — define tokens once, on all themes. Unblocks 4 and 5.
4. **Finding 5** — migrate chrome hexes; leave data palettes alone.
5. **Finding 4 step 3** — migrate raw palette classes.
6. **Finding 6** — triage the confirmed-dead subset; de-`export` self-only helpers.

Steps 3–5 are one coherent theme-token pass. Do them together, or the same
files get touched twice.

---

## Appendix — reproducing the sweep

Scratch scripts belong in `tmp/` (gitignored) per AGENTS.md. The dead-export
sweep is ~20 lines of Python:

1. Build `tmp/all-src-files.txt` from `find src -name '*.ts' -o -name '*.tsx' -o -name '*.css'`.
2. Read every file with **`newline=''`** — CRLF matters, see gotcha below.
3. Index identifier → set-of-files with `\b[A-Za-z_][A-Za-z0-9_]+\b`.
4. Collect declared exports via
   `^export\s+(?:(?:declare|abstract|default|async)\s+)*(?:const|let|var|function|class|interface|type|enum)\s+(\w+)`,
   **plus** a second pass for `export { A, type B, C as D }` brace lists
   (split on `,`, strip `type `, take the side after ` as `).
5. A symbol is a candidate iff its file set ⊆ {its own file}.

**Gotcha that produces garbage results:** opening files without `newline=''`
makes Python translate CRLF→LF, which desynchronizes `str.count('\n')` line
numbers against the raw text. Also, skipping the `export { … }` brace pass
under-counts, and matching only `export const|function` **over-counts** by
missing that the same identifier may be re-exported elsewhere. Always confirm
any single candidate with a real `rg -l` before acting on it — the sweep is a
candidate generator, never a verdict.
