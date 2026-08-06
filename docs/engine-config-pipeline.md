# Engine config + CONFIG editor pipeline

**Status:** living notes after ENGINE-CONFIG-refactor  
**Branch context:** `ENGINE-CONFIG-refactor`  
**Audience:** next agent / self — do not lose this when the panel is slimmed later

This file is **git-tracked** (unlike `docs/internal/`). Internal design proposal: `docs/internal/ENGINE-CONFIG-MODES.md` (local only).

---

## One-liner

> **Three launch policies + three sparse value profiles + one pure builder; CONFIG editor is global defaults; Launch chips write only the active profile; factory merge never stomps user ESS hides.**

---

## Layers (do not collapse)

| Layer | Where | Owns |
|-------|--------|------|
| **Factory template** | `runtime/<id>/config/*-default-config.json` | Structure, flags, factory defaults, `essentialParamKeys`, factory `essentialsHiddenValues`, protected groups |
| **User catalog** | `config/<id>-user-config.json` | Per-param values list, hide row, hiddenValues, **essentialsHiddenValues**, group, order, defaults |
| **Launch profiles (v2)** | `localStorage` `BlackOps-catalog-override:<id>` | Per-mode **selected values** for launch |
| **Model spec** | `BlackOps-model-spec:<path>` | `mtp_*` / `dflash_*` only |

### Launch profile store (v2)

```json
{
  "version": 2,
  "activePolicy": "full_auto" | "assisted_essentials" | "assisted_full",
  "profiles": {
    "full_auto": { "...sparse overrides..." },
    "assisted_essentials": {},
    "assisted_full": {}
  }
}
```

- Flat v1 map migrates once: assisted bags get full copy; `full_auto` gets **seed** (Joe defaults + only parallel/kv/reasoning/ctx from legacy).
- **Sparse only** — never flush the full resolved React config bag into a profile (that freezes factory defaults as “overrides”).
- Launch chips → `patchProfileValues(activePolicy, …)` only.
- CONFIG star/override → `writeConfigEditorDefault` writes **all three** profiles (global catalog UX). Full Auto CLI still filters via policy key set.

---

## Pure modules (source of truth)

| Module | Role |
|--------|------|
| `src/lib/launchPolicy.ts` | Policy table, Joe defaults, key set, batch policy (`factory` for Smart) |
| `src/lib/launchProfiles.ts` | v2 storage, migrate, seed, CONFIG helpers |
| `src/lib/buildLaunchConfig.ts` | Pure launch payload |
| `src/hooks/useConfigResolver.ts` | Active profile load; mode switch = activePolicy + reload (no full-bag flush) |
| `src/lib/paramConfigResolve.ts` | Visible value resolve (cockpit + profile knobs even if row hidden) |
| `src/lib/systemParams.ts` | Cockpit-owned / chrome / protected groups |
| `src/lib/launchProfile.ts` | Essentials helpers, value filters (UI) |
| `src-tauri/src/config/merge.rs` | Template ↔ user merge |

Unit tests: `src/lib/launchPolicy.test.ts` (`npm test`).  
Rust merge tests: `config.rs::merge_tests` (`cargo test`).

---

## Product locks

| Decision | Choice |
|----------|--------|
| Full Auto non-cockpit | factory + Joe `fallbackDefaults`; seed carries only Agents/Memory/Think/CTX |
| Smart batch | **factory** middle ground (Smart = Joe “Off” wording until a real algo) |
| vision / load_mode Joe | `off` / `mmap` |
| Profile shape | nested v2 under catalog-override |
| CONFIG overrides | write all profiles; Launch isolation via key set + active patch |
| ESS hide empty list | **user-owned** — merge does not re-apply factory |

---

## Hide / show / essentials (easy to confuse)

| Mechanism | Scope | Launch CLI? |
|-----------|--------|-------------|
| `hidden` / `userHidden` on row | Catalog + Launch matrix | Skipped (except cockpit-owned / profile knobs) |
| `hiddenValues` | Value chip catalog-hidden | Still usable if currently selected |
| `essentialsHiddenValues` | Essentials + Full Auto cockpit **and** launch | **Hard on Full Auto / Assisted Essentials** — `snapEssentialsHiddenInValues` in `buildLaunchConfig` replaces ESS-hidden chips with factory/default visible value. **Assisted Full** keeps the value (power). |
| `essential` / `essentialParamKeys` | Which params show in Essentials matrix | Key set for essentials / full_auto launch |
| `protectedGroups` | CONFIG structure lock | N/A |
| Cockpit-owned keys | Header / MultiAgentBooster only | Always on key set when template has key |

**Invariant:** ESS hide ≠ launch ban. If product later wants hard ban, snap invalid values on mode enter in pure builder — do not scatter `if`s in the panel.

---

## Mode map

| UI | Policy id | Matrix | Batch | Topology |
|----|-----------|--------|-------|----------|
| FIT ON / Full Auto | `full_auto` | hidden | factory | FIT-owned |
| Assisted + Essentials | `assisted_essentials` | essentials | profile | user chrome |
| Assisted + Full | `assisted_full` | full | profile | user chrome |

`resolveLaunchPolicyId({ fullAutoMode, configView })` is the only derivation point.

---

## Validation findings (2026-08-06)

### Fixed on branch

1. Per-mode profiles + pure builder (no shared sludge on CLI).
2. Smart no longer maxes batch/ubatch.
3. Mode switch no longer full-replaces profile with resolved config.
4. CONFIG overrides write all profiles + reload on `paramConfigChanged`.
5. Cockpit-owned values resolve even if catalog row hidden.
6. Rust merge: empty `essentials_hidden_values` no longer re-filled from factory.
7. EngineParamGroups: Full Auto path uses essentials value filter if chips ever show.

### Remaining / optional

| Item | Severity | Notes |
|------|----------|--------|
| ~~ESS hide UI-only~~ | — | **Done** — hard snap on full_auto / assisted_essentials in `buildLaunchConfig` |
| Rapid mode toggle + chip edit race | Low | rare |
| Launch “reset profiles” button | Low / product | **Not** auto-reset after launch. Optional explicit “clear overrides for this mode”. CONFIG RESET already wipes v2 store. |
| Protected groups: ESS toggle needs structure cap | Low | Users can catalog-hide; ESS-toggle may stay structure-gated |

---

## Do not reintroduce

- Shared single override bag for Full Auto + Assisted.
- `if (fullAutoMode)` purity hacks in `EngineConfigPanel` instead of policy.
- Mode-switch flush of **entire** `config` object into a profile.
- Smart max-batch push without arch-aware FIT-aware algo.
- Merge backfill that treats empty ESS list as “unset.”
- Writing only assisted bags from CONFIG while UI reads active Full Auto bag.
- Port-based taskkill / blur overlays (see AGENTS.md — unrelated but never mix in).

---

## Hooks (post extract)

| Hook | File | Owns |
|------|------|------|
| `useLaunchMode` | `src/hooks/useLaunchMode.ts` | FIT / configView / policy id / essentials keys |
| `useConfigResolver` | `src/hooks/useConfigResolver.ts` | Per-mode profile values |
| `useCockpit` | `src/hooks/useCockpit.ts` | Agents/Memory/Think/Boost + apply plan + flag toggles |
| `useDflashDraft` | `src/hooks/useDflashDraft.ts` | Get/Change draft modal + HF download |

`EngineConfigPanel` composes these — do not re-inline applyFullAutoCockpit.

## Suggested next coding order

1. Optional: ESS value snap on launch for essentials/full_auto (product call).
2. ~~Extract `useCockpit` / slim panel~~ done.
3. Only then more presentational file splits / optional Launch reset-profiles UI.

---

## Smoke checklist (manual)

1. Assisted Full `load_mode=mlock` → Full Auto launch → **mmap**.
2. Smart → factory batch, not 16k residue.
3. CONFIG set temp override → remount → still shown; Full Auto CLI **no** temp.
4. Clear all ESS hides on a param → save/reload → still all visible in Essentials.
5. Launch change CTX → open CONFIG → override chip matches.
6. Multi-GPU Full Auto → FIT topology, not Assisted device chrome.
