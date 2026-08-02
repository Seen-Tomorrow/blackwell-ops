# ENGINE CONFIG PANEL DECOMPOSITION — Handoff / Resume Notes

> **Purpose:** a fresh-context agent will decompose the `EngineConfigPanel` frontend monolith
> into composed section components, **without changing behavior**. This file is the briefing.
> Read it fully, then explore the actual source before touching anything.

## 0. TL;DR

`src/components/EngineConfigPanel.tsx` is **4,183 lines / one default component** with ~30 hooks
and ~2,000 lines of inline orchestration + layout JSX. It already composes ~20 leaf components
(the leaves are fine) but the **body is not**. The task is to split the render into a handful of
section components, passing state/props down — **behavior-identical**, no logic rewrites.

This is the **highest-effort / highest-risk** item in `FRICTION_ASSESSMENT.md` (report section 5,
execution-table item 8). Do it deliberately, one section at a time, with behavior pinned.

---

## 1. Current state — what is already DONE (do not re-open)

`FRICTION_ASSESSMENT.md` documents completed items. **Items 1–4 are merged/green:**
- No-op `applyLearnedVramOverlay` deleted; dead `estimateOverheadMib`/`getBaseVramMib`/
  `isSystemUiGroup`/`isSpecProfileUiGroup`/`resolveGroupDisplayZone` deleted.
- Spec family table + score thresholds consolidated into `src/lib/specDraft.ts` (`FAMILY_RULES`,
  `MIN_DRAFT_PAIR_SCORE`/`HIGH_DRAFT_PAIR_SCORE`); `dflashGetDraft.ts` imports them.
- Bench dedup: `release_all_slots` + `BenchPortGuard` now live in `bench_cancel.rs`, used by both
  `burst_bench.rs` and `bench_pp_burst.rs`.
- Agent-launcher plumbing extracted to `src-tauri/src/external_agents.rs` (isolation preserved).

**Gates currently green:** `cargo check`/`cargo build` zero warnings, `cargo test` 110/0,
`npx tsc --noEmit` pass, `npm run rebuild:dev:selective` completes.

**Items still OPEN (not your task):** table items 5 (GroupDisplayZone type + group-name const
dedup — small, independent), 6 (`memorySource.wasFitCacheUsed` recompute). Don't mix them in.

---

## 2. The task (report section 5)

`EngineConfigPanel` composes ~20 leaf components (`SliderParam`, `CockpitSlider`, `ValueBubbles`,
`GroupHeaderControls`, `GpuAssignPanel`, `ConfigBelowGroups`, `LaunchRailTelemetry`,
`RunningEnginesPanel`, `MultiAgentBooster`, `CockpitCtxStrip`, `VramBadge`, …) but the
**orchestration + layout JSX stays inline**, so it's still 4k lines. The leaves are fine;
the body is not. Split the body into composed section components.

**Goal:** reduce the maintenance surface. A single 4k-line component is hard for any agent or
human to change safely. The section components should mirror how the leaf components already work.

---

## 3. Current structure map (from reading the render)

The component's state/hooks span roughly lines 400–2014; the render (`return (...)`) runs from
~2015 to the end (~4183). The render has these **major logical sections**:

| Approx. lines | Section | Notable inner pieces |
|---|---|---|
| ~2961–3120 | **Param groups grid** | scrollable group tiles, group headers (`GroupHeaderControls`), param rows (`SliderParam`), column layout (`configColumnLayout` / `useGroupLayoutControls`) |
| ~3123 | **Above-VRAM groups** | `ConfigBelowGroups` (pinned above the VRAM display) |
| ~3193–3284 | **GPU assign + VRAM forecast** | `GpuAssignPanel`, `VramBadge` (scenario manifest renderer) |
| ~3285–3357 | **Running engines** | `RunningEnginesPanel` |
| ~3358–3490 | **Launch dock controls** | alias field, port, launch action, custom-flags |
| ~3493–3622 | **Boost / Multi-agent** | `MultiAgentBooster` (+ spec profile section) |
| ~3623–3646 | **Below-groups config** | `ConfigBelowGroups` (below) |
| ~3647–3893 | **Launch dock — BOTTOM variant** | full dock: alias/port/launch + `config-launch-dock__flags-scroll` |
| ~3894–4183 | **Launch dock — RIGHT RAIL variant** | `RunningEnginesPanel` + rail flags + alias/port/launch |

**Notable duplication:** the launch dock is rendered **twice** (bottom bar and right rail) with
near-identical alias/port/action markup (`config-launch-dock__alias`, `__port`, `__action`) —
a natural candidate for ONE shared `LaunchDock` section component that takes a
`position: "bottom" | "right"` prop (the storage key `launchDockPosition` already models this).

---

## 4. Decomposition strategy (recommended)

**Do NOT rewrite logic — extract JSX + move the hooks the section needs into the section.**

The component currently holds ~30 hooks. Splitting by JSX section means each extracted section
component receives the state/props it needs via props (or a small number of narrow context
providers if prop-drilling gets pathological). Keep the top-level orchestrator owning the shared
state and passing slices down.

Recommended section boundaries (each a new file under `src/components/`):

1. **`EngineParamGroups`** — the scrollable param grid + group headers + column layout
   (needs: resolved params, group order/columns, edit caps, collapsed groups, the param-row
   renderer). Largest section.
2. **`EngineGpuForecast`** — `GpuAssignPanel` + `VramBadge` + `ConfigBelowGroups` (above)
   (needs: scenario manifest, gpus, config, running slots).
3. **`EngineLaunchDock`** — ONE component for both the bottom bar and right rail
   (position prop; owns alias/port/launch action + custom-flags pill; renders
   `RunningEnginesPanel` in the rail variant).
4. **`EngineBoostSection`** — the `MultiAgentBooster` wrapper + spec profile chrome.
5. **`EngineRunningPanel`** — `RunningEnginesPanel` (if it stays outside the dock in some layouts).

The top-level `EngineConfigPanel` keeps: provider/model resolution, config state
(`useConfigResolver`), scenario evaluation (`useScenarioEvaluator`), launch assembly, and the
overall `flex flex-col h-full` layout that composes the sections.

**Do this one section at a time, committing/verifying after each.** Extract the most self-contained
section first (e.g. the launch dock, since it's the most visually isolated and has a clear
boundary), then the forecast, then the groups.

---

## 5. Invariants — MUST preserve (from AGENTS.md + this component)

- **`VramBadge` is a dumb skeleton renderer** — it reads `manifest.style.uiTemplate` and renders.
  Do **not** move scenario/VRAM logic into it or out of the scenario system. Keep it dumb.
- **Scenario rules:** scenario files are isolated silos; `VramBadge`/components must not add
  conditional logic or hardcoded scenario text. No cross-scenario imports.
- **No `backdrop-filter: blur`** (WebView2 pegs the iGPU). Dim-only overlays.
- **No theme forks** — use `var(--theme-…)` tokens, no new `[data-theme]` component rules.
- **CSS** lives in the matching partial (`src/styles/config.css` is the engine-config panel
  partial, `launch.css` the dock). If you add section component classes, keep them in the right
  partial — do not create a new CSS file for one section unless it's clearly warranted.
- **Behavior-identical:** no logic rewrites, no reordering of the visible layout, no changes to
  the launch command / config / VRAM forecast. The point is structural decomposition only.
- **Tailwind:** prefer layout utilities + semantic theme classes; no hard-coded palettes.
- **Tauri listeners** in the extracted sections: use `useTauriListen` (raw `listen` in
  `useEffect` leaks under StrictMode). The orchestrator already owns the app-wide listeners;
  prefer passing event-derived state down over adding new listeners in sections.

---

## 6. Risks & gotchas

- **Highest risk of any item so far.** The launch path, config save, and VRAM forecast all flow
  through this component. Change ONE section, build, and visually verify before the next.
- **~30 hooks in one component** — when you move hooks into a section, the section becomes
  stateful; make sure each hook's deps stay correct (React will warn on dependency changes, but
  behavior drift is silent). Prefer **props-down** for read-only state to avoid re-creating
  effect/subscription logic.
- **The launch dock has two layout variants** — unifying them is the highest-value but also the
  highest-risk change (the rail uses `useLaunchDockRailResize` / `useLaunchRailInnerResize`).
  Consider extracting the shared alias/port/action block as an inner component first, keep the two
  outer variants, then unify only if it stays clean.
- **StrictMode double-mount** — any `useEffect` subscription the section adds must clean up
  correctly (useTauriListen handles this).
- **Do not touch FUSION** (user's standing rule).
- **`EngineConfigPanel` is imported by `ConfigPage` (lazy).** Keep the default-export name and
  the props signature identical so ConfigPage is untouched.

---

## 7. Acceptance criteria / gates

1. **Behavior unchanged** — launch, config save, VRAM forecast, boost, and both dock layouts work
   identically after each extracted section.
2. **`npx tsc --noEmit`** passes (exit 0).
3. **`npm run rebuild:dev:selective`** completes (~1 min) and the app builds. (This script purges
   only the app crate artifacts + rebuilds frontend + `cargo build` — it preserves
   foundry/runtime/config/toolchain.)
4. **`cargo check`** — the Rust side is untouched by this task, but the selective rebuild runs it;
   it must stay zero-warning.
5. **`EngineConfigPanel.tsx`** drops meaningfully (target < ~1500 lines) with the extracted
   sections in separate files, OR is clearly decomposed even if some section files are large.
6. No new CSS files / no theme forks / no `backdrop-filter: blur`.

---

## 8. Suggested order

1. Re-read this file + `AGENTS.md` + skim `FRICTION_ASSESSMENT.md` section 5.
2. Read `src/components/EngineConfigPanel.tsx` fully (it's long — use `read` with offsets; the
   tool renders faithfully, `rg` mangles long identifiers in this terminal).
3. Extract **launch dock** first (most isolated, clearest boundary) → build + verify.
4. Extract **GPU forecast + running engines** → build + verify.
5. Extract **param groups grid** (largest) → build + verify.
6. Extract **boost section** → build + verify.
7. Final: `EngineConfigPanel` becomes the slim orchestrator + overall layout; run all gates.

## 9. Environment

- CWD: `C:/Users/GHOST-TOWER/INFRA/blackwell-ops`
- Frontend: React 18 + TS + Tailwind; `npm run dev` (Tauri) / `npm run vite` (browser-only).
- Full build gate: `npm run rebuild:dev:selective` (~1 min; purges app crate, keeps runtime).
- Reference: `FRICTION_ASSESSMENT.md` (full report), `AGENTS.md` (traps/invariants).
