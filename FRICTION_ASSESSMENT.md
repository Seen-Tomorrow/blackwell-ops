# Blackwell Ops — Read-Only Friction Assessment

> **STATUS:** Items 1–4 from the execution table are **DONE** (all gates green:
> `cargo check`/`cargo build` zero warnings, `cargo test` 110/0, `npx tsc --noEmit` pass,
> `npm run rebuild:dev:selective` completes). Items 5–8 remain open. See the table below.

**Scope:** Everything EXCEPT engine-config / provider-config / binary-inventory (done on
`ENGINE-CONFIG-DIET`, see `CONFIG_DIET_HANDOFF.md`). Also FUSION is off-limits (user rule).

**Goal:** Find places that *work perfectly but are more complex than they need to be now
that they're complete* — the iterative-build residue of ~3000h across 5+ agents.

All findings are read-only, with file paths + evidence. Sorted by **maintenance ROI**
(value of simplifying ÷ risk of touching it).

---

## 0. Scale context (why this matters)

| Metric | Value |
|---|---|
| Frontend `src/` | ~52k lines TS/TSX |
| Backend `src-tauri/src/` | ~42k lines Rust |
| Tauri IPC commands | **153** (main.rs registry = 1094-line god-file) |
| CSS (`src/styles/`) | **13,949 lines** |
| Biggest single component | `EngineConfigPanel.tsx` = **4,183 lines** |

The app is enormous and mostly *does* work. The friction is: (a) a few giant monoliths,
(b) several subsystems that were built twice by different agents, (c) dead/no-op residue
from refactors, (d) heavy memoization that's tuned but fragile.

---

## 1. HIGH ROI / LOW RISK — dead + no-op code (pure deletions)

These are the cheapest wins. They compile fine today (exported-but-unused or a no-op wrapper)
so tsc/cargo never flags them, but every reader has to parse them.

**1a. `applyLearnedVramOverlay` is a no-op** — `src/services/vram/scenarios/scenarios_factory.ts:837`
```ts
export function applyLearnedVramOverlay(manifest, _input, validatedVramMib?) {
  if (validatedVramMib != null) return manifest;
  return manifest;            // <-- both branches return manifest
}
```
It's called in `evaluate()` at line 870 wrapping `attachMemorySource(...)`. The "learned
VRAM overlay" feature was refactored into `AUTO_FIT` (per its own comment), but this wrapper
was left behind. **Delete it + the call site** → `evaluate` just does
`attachMemorySource(manifest, input)`.

**1b. Dead exported FIT helpers** — `scenarios_factory.ts`
- `estimateOverheadMib` (line 469) — **0 callers** anywhere
- `getBaseVramMib` (line 462) — **0 callers**
Both are relics of an earlier FIT estimation approach (superseded by `extrapolateVramFromPoints`).
Exported so the compiler won't flag them. Delete.

**1c. `isSystemUiGroup` is deprecated + orphaned** — `src/lib/systemParams.ts:161`
Marked `@deprecated` ("Prefer isProtectedGroup") and has **0 callers** (only its own def).
Delete.

**1d. `resolveGroupDisplayZone` dead** — `src/lib/paramDisplayZone.ts`
**0 callers** (only `partitionGroupsByDisplayZone` uses the logic inline). Delete.

**1e. `default_parallel_one` has `#[allow(dead_code)]`** — `src-tauri/src/burst_bench.rs:61`
Serde-default fn with an explicit allow. Could be removed if the field's default is handled
differently, or kept — minor.

**1f. Unused params** (small): `skipSpecParamForLaunch(p, _specActive)` in
`launchProfile.ts:28`; `extrapolateVramFromPoints(..., _userKvQuant, ...)` in
`scenarios_factory.ts:514` — dead params that document a now-removed knob.

> **Verdict:** 1a–1d are clean deletions. ~10 min each, zero behavioral risk. Do these first.

---

## 2. HIGH ROI / LOW-MED RISK — speculative-decoding was built twice

The Boost / DFlash / MTP feature spans **4+ frontend files** and two of them contain
**exact duplicate tables and constants** — textbook "two agents each wrote their own copy":

**2a. Duplicate family-detection regex table**
- `src/lib/specDraft.ts:72` `FAMILY_RULES` (13 entries)
- `src/lib/dflashGetDraft.ts:32` `FAMILY_DETECT` (13 entries)

These are **byte-for-byte identical** (same ids, same patterns, same order). If a new model
family is added, it must be updated in **two places** or detection silently diverges.

**2b. Duplicate scoring thresholds**
- `specDraft.ts:67/70` `MIN_DRAFT_PAIR_SCORE = 50`, `HIGH_DRAFT_PAIR_SCORE = 80`
- `dflashGetDraft.ts:69/70` `DFLASH_SCORE_SUGGEST = 50`, `DFLASH_SCORE_HIGH = 80`

Same numbers, different names, two modules. If you tune the threshold you must tune both.

**2c. Overlapping role/method enums**
- `specDraft.ts` `DraftRole` = `"mtp_embedded" | "external_dflash" | "external_eagle3"`
- `specProfiles.ts` `SpecBoostMethod` = `"off" | "mtp" | "dflash"`
Both encode "which speculative decoding path" with different shapes.

**2d. Group-name constants defined twice**
- `SPEC_PROFILE_MTP/DFLASH` = `"SPECULATIVE-MTP"/"SPECULATIVE-DFLASH"` in BOTH
  `specProfiles.ts` **and** `systemParams.ts`.

**Also:** `dflashMatchTier` (dflashGetDraft) and `scoreDraftPair` (specDraft) implement the
same 50/80 tiering concept independently.

> **Verdict:** Consolidate the shared family table + thresholds into ONE module (e.g.
> `specDraft.ts` or a new `draftModel.ts`), import it from both. Pure detection logic, no
> process/state — LOW risk, and it kills the exact-duplication class of bug (silent
> divergence). **Highest ROI of the "built twice" items.**

---

## 3. HIGH ROI / LOW-MED RISK — benchmark slot-release duplication

- `burst_bench.rs` factors `release_all_slots(&client, port, label)` into a helper (line 281).
- `bench_pp_burst.rs` **re-inlines the same HTTP `/slots` release loop 3 separate times**
  (before-bench, after-warmup) instead of importing `burst_bench::release_all_slots`.
- Both files define an identical `struct BenchPortGuard(u16)` (burst_bench:19, bench_pp_burst:12).

`bench_prompts.rs` is correctly shared (good), but the release/slot logic + guard are copied.

> **Verdict:** Extract `release_all_slots` + `BenchPortGuard` into `bench_cancel.rs` (already
> the shared bench module) and use from both. Low risk (HTTP POST loop), removes 3 copies.

---

## 4. MED-HIGH ROI / LOW-MED RISK — the AI-coding-agent launchers are near-parallel

Two backend modules do the *same job* (install → download → write config → spawn a coding
agent CLI) with different vendored agents:

- `atomcode.rs` (1,168 lines) — `atomcode_status/install/launch/open_webui/accept_disclaimer`
- `qwen_code.rs` (923 lines) — `qwen_code_status/install/launch/accept_disclaimer`

Both duplicate the whole plumbing shape:
`tools_dir` / `home_dir` / `migrate_legacy_paths` / `version_stamp_path` / `disclaimer_path` /
`last_project_path` / `read_version_stamp` / `download_*` / `emit_dbg` / `spawn_*_console` /
`openai_model_id` / config-TOML-or-settings building.

Frontend mirrors it: `MultiAgentBooster.tsx` (2,192 lines) + `atomcode.ts` + `qwenCode.ts`.
Plus a third agent surface (`playground.rs` + `playgroundCodegen.ts`), and a disabled
`reactor11` feature + removed SENTINEL.

> **Verdict:** The install/download/spawn/console scaffolding is genuinely shared and could
> be a single `agent_launcher` helper. **BUT** the two agents have real differences
> (atomcode = binary release; qwen = npm/zip + shim), and this is process/network code —
> higher regression risk. **Recommend:** extract only the *pure* shared helpers
> (`version_stamp`, `disclaimer`, `tools_dir`, `download_bytes`, `sha256`/`emit_dbg`) and
> leave the launch/TOML building separate. Medium value, medium risk — do after 1–3.

---

## 5. MED ROI / MED-HIGH RISK — the frontend monoliths

These are the single biggest maintenance surface. They work, but a single file this large is
hard for any agent (or human) to change safely:

| File | Lines | Character |
|---|---|---|
| `EngineConfigPanel.tsx` | 4,183 | ONE default component, ~30 hooks, huge inline JSX (no internal sub-components) |
| `ConfigPage.tsx` | 2,630 | config god-file (editor + providers + updates + distribution tabs) |
| `MultiAgentBooster.tsx` | 2,192 | boost UI + all agent orchestration inline |
| `App.tsx` | 716 | global state + ALL tab routing + log management + event wiring inline |

`EngineConfigPanel` already composes ~20 leaf components (SliderParam, CockpitSlider,
ValueBubbles, GroupHeaderControls, GpuAssignPanel, …) — but the **orchestration + layout
JSX stays inline**, so it's still 4k lines. The leaves are fine; the body is not.

> **Verdict:** This is the biggest *structural* win but the highest effort/risk. Not a quick
> fix — a deliberate refactor. Recommend splitting `EngineConfigPanel` by logical section
> (VRAM/forecast, param groups, launch dock, HW monitor, boost) into composed section
> components, mirroring how the leaf components already work. Do LAST, carefully, with the
> existing behavior pinned.

---

## 6. MED ROI / MED-HIGH RISK — over-optimized hooks & engines

**6a. `useScenarioEvaluator.ts` (715 lines)** — extreme manual memoization to avoid re-evals:
~20 `useRef`s, a module-level manifest cache Map with eviction, 5 fingerprint keys
(topology / gpuMemory / config / stack / sysInfo), debounce + immediate paths, and a
generation counter. It *works and is tuned for NVML noise*, but every change here is a
minefield. This is the clearest "iteratively tuned until it works, now too clever" file.

**6b. `scenarios_factory.ts` (922 lines)** — a large pure-computation engine (FIT
interpolation + MoE weight-fraction math + overhead formula + auto-split + per-layer weight
estimation). Well-structured (pure fns) but very deep. The strict AGENTS.md "scenario silo"
rules add governance overhead. The dead fns in §1 live here.

**6c. `memorySource.ts`** — re-implements `cfgStr`/`cfgNum` (duplicated from
`scenarios_factory`), and `wasFitCacheUsed()` **re-runs the entire `extrapolateVramFromPoints`
computation just to check `!== null`** (wasted recompute every render path). The
`extrapolateVramFromPoints` call is already computed in `computeValues`; the source resolver
should reuse that result instead of recomputing.

> **Verdict:** Don't rewrite 6a/6b wholesale (risk). Do fix 6c (reuse the already-computed
> extrapolation), and treat 6a/6b as "known complex — add comments + a smoke test, don't
> touch casually." The dead-code deletions in §1 already reduce their surface.

---

## 7. LOW-MED ROI / LOW RISK — small duplicate types & param taxonomy sprawl

**7a. `GroupDisplayZone` type is defined TWICE**
- `src/lib/storage.ts:586`
- `src/lib/paramDisplayZone.ts:1`
Every real import uses `./storage` (4 sites). The `paramDisplayZone` copy is dead. Delete one.

**7b. Param-classification key sets are sprawling and overlapping** (all describe "which
params are special / where they render"):
- `PANEL_CHROME_PARAM_KEYS` — paramDisplayZone
- `LAUNCH_DOCK_PARAM_KEYS` — launchProfile
- `ENGINE_ONLY_PARAM_KEYS`, `SYSTEM_CATALOG_PARAM_KEYS`, `COCKPIT_OWNED_PARAM_KEYS` — systemParams
- `SPEC_DECODING_UI_GROUP` / `isModelSpecParamKey` — specDraft
- `SPEC_PROFILE_MTP/DFLASH` groups — specProfiles + systemParams (dup, §2d)

This is a *taxonomy*, not necessarily wrong — but the keys overlap (`device`/`split`/
`base_port`/`ctx` appear in several sets) and the group-name constants are duplicated
(`SPEC_PROFILE_MTP` in 2 files, `SPECULATIVE-DECODING` referenced in specDraft +
specProfiles). Consolidating the constants into one source (like the config-diet did for
inventory) would shrink the surface. Medium effort, low risk (pure constants).

---

## 8. LOW ROI / HIGH EFFORT — CSS bloat

`src/styles/` = **13,949 lines**; the big partials are `cockpit.css` (86KB/390 selectors),
`fusion-display.css` (68KB), `config.css` (70KB/380), `chrome.css` (50KB/300), `launch.css`
(47KB/260). Pruning this safely needs a dead-selector tool + visual regression, which the
app has no harness for. **Defer** unless CSS maintenance is actively hurting.

---

## 9. Low value / note — IPC surface

153 commands, `main.rs` is a 1094-line registry. The commands are individually small and the
split into `engine.rs`/`config/commands.rs`/`binary_update.rs`/etc. is reasonable. This is
inherent to the app's breadth, not a simplification target — but **every new feature should
be asked whether it needs a new command** before adding one.

---

## Recommended execution order (by ROI)

| # | Change | Risk | Effort | Status |
|---|---|---|---|---|
| 1 | Delete no-op `applyLearnedVramOverlay` + call site | none | ~15m | ✅ DONE |
| 2 | Delete dead `estimateOverheadMib`, `getBaseVramMib`, `isSystemUiGroup`, `resolveGroupDisplayZone` (+ orphaned `isSpecProfileUiGroup`) | none | ~20m | ✅ DONE |
| 3 | Consolidate spec family table + score thresholds into one module (§2a/2b) | low | 1–2h | ✅ DONE |
| 4 | Reuse `release_all_slots` + `BenchPortGuard` in bench_pp_burst (§3) | low | 1h | ✅ DONE |
| 5 | Dedupe `GroupDisplayZone` type + group-name constants (§7) | low | 30m | ✅ DONE |
| 6 | Fix `memorySource.wasFitCacheUsed` to reuse computed extrapolation (§6c) | low-med | 1h | ✅ DONE |
| 7 | Extract shared pure helpers from atomcode/qwen_code (§4) | med | 2–4h | ✅ DONE (new `src-tauri/src/external_agents.rs`) |
| 8 | Split `EngineConfigPanel`/`ConfigPage`/`MultiAgentBooster` into composed sections (§5) | high | multi-day, deliberate | ✅ DONE (separate session: `EngineConfigPanel` 4183→3229; new `EngineParamGroups`/`EngineGpuForecast`/`EngineLaunchDock`/`EngineBoostSection`/`EngineProviderProfileBar`/`EngineToolbar`/`ParamPlaceDialog`) |

> **Note on #7 (agent launchers):** shared helpers (`read_trimmed`, `write_disclaimer`,
> `download_bytes`, `sha256_hex`, `write_binary`, path fns, `emit_dbg`) were extracted into
> `external_agents.rs`. The **isolation invariant is preserved**: each agent still computes its
> own bundled `tools_dir()`/`home_dir()` paths (never user PATH / `%LOCALAPPDATA%` / `~`), and
> the shared helpers only take dirs as parameters. `emit_dbg` is imported (`use
> crate::external_agents::emit_dbg`) so all 20 call sites resolve to the shared one; the no-arg
> path wrappers in each agent delegate to the shared parameterized helpers. Launch/TOML/settings
> building stays per-agent (genuinely different).
>
> **Gotcha hit during #7:** bare `external_agents::…` from sibling modules failed to resolve
> (E0433) even though the module compiled — fixed by using the explicit `crate::external_agents::`
> prefix, which matches the existing `crate::config`/`crate::output_console` convention in those
> files.

> **All 8 items are now complete** (items 1–7 in this line of work, item 8 in a separate
> decomposition session). Remaining open notes from the report that are *not* in this table
> (deferred by user / not worth the risk): `EngineConfigPanel` is down to 3,229 lines but still
> above the 1,500 target — a future pass could split it further, but it's now structurally
> decomposed into section components. `ConfigPage` (2,630) and `MultiAgentBooster` (2,192) remain
> large monoliths if a future pass wants to extend the same treatment.

Items 1–6 are "it's complete now, simplify to the same result" — exactly the ask. Items 7–8
are the bigger structural debt worth planning but not rushing.

---

## Appendix — evidence quick-reference

- No-op: `scenarios_factory.ts:837-843`, called `:870`
- Dead exports: `scenarios_factory.ts:462` (`getBaseVramMib`), `:469` (`estimateOverheadMib`)
- Deprecated orphan: `systemParams.ts:161` (`isSystemUiGroup`, 0 callers)
- Dead fn: `paramDisplayZone.ts` `resolveGroupDisplayZone` (0 callers)
- Dup regex tables: `specDraft.ts:72` `FAMILY_RULES` == `dflashGetDraft.ts:32` `FAMILY_DETECT`
- Dup thresholds: `specDraft.ts:67,70` vs `dflashGetDraft.ts:69,70`
- Dup group consts: `specProfiles.ts:20-21` vs `systemParams.ts` (`SPEC_PROFILE_MTP/DFLASH`)
- Dup type: `storage.ts:586` vs `paramDisplayZone.ts:1` (`GroupDisplayZone`)
- Bench dup: `burst_bench.rs:281` helper vs `bench_pp_burst.rs` 3 inline copies; `BenchPortGuard` in both
- Agent dup: `atomcode.rs` (1168) vs `qwen_code.rs` (923) — same helper shape
- Monoliths: `EngineConfigPanel.tsx` 4183, `ConfigPage.tsx` 2630, `MultiAgentBooster.tsx` 2192, `App.tsx` 716
- Over-optimized: `useScenarioEvaluator.ts` 715 (~20 refs), `scenarios_factory.ts` 922
- memorySource recompute: `memorySource.ts` `wasFitCacheUsed` calls `extrapolateVramFromPoints`
- Scale: 153 commands; main.rs 1094 lines; CSS 13,949 lines
