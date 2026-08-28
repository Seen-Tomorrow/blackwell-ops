# Catalog seats — granular control plan

Status: **Stage 1 shipped** (this branch)  
Branch: `feat/catalog-quick-access`  
Date: 2026-08-28  
Review lock: panel seat-edit + capture; dual forecast strip = **stage 2**

---

## One-liner

**Catalog seats are an assigner + memory bag only.**  
Edit knobs in the **existing config panel + VramBadge**. Save into the seat. Do not fork a second editor or a second forecast glass.

---

## What is shipped (actual)

| Layer | Owns | Persists |
|---|---|---|
| **Catalog seats** | BRAIN / WORKER **paths** only (no DRAFT tile), 3 sets, ▶ TWIN, **E** / **R** / SAVE chrome | `catalog-quick-access` **v3** (paths + `comboIds[3]`) |
| **Linked combos** | Full twin bags (`source: "catalog-set"`) | `launchPresets` store (hidden from casual PRESETS via `listUserCombos`) |
| **Config panel + VramBadge** | Live knobs + measured forecast for **one** selected model | Session + templates |

**Not a third engine.** Boost / MTP / DFLASH / DSPARK / draft path live on each **engine seat bag** (BRAIN and WORKER), saved from the natural cockpit — no catalog DRAFT seat.

### UX (current)

```
[1][2][3]  SEATS  [▶ TWIN]
┌ BRAIN (harness colors)  R E × ┐  ┌ WORKER  R E × ┐
```

| Control | Behavior |
|---|---|
| Empty seat click | Assign selected catalog model (path only) |
| Filled seat click | **Select only** — never silent overwrite |
| **R** | Replace path → seat flips to **YES / NO** (no dialogs) |
| **E** | Enter edit: seat goes **full width**, peer hidden; NEED-style live rim on seat + section |
| **×** | Clear path → **YES / NO** |
| Edit mode SAVE | On the seat: mono `▣ SAVE` + CANCEL |
| Toolbar `SEAT →B / →W` | Save current panel config to that seat (active set) |
| Running rail `→B / →W` | `captureSeatFromStack` into seat |
| AGENTIC HARNESS | Hidden until ≥1 RUNNING engine |

While editing:

```
Strip header: EDITING BRAIN|WORKER
Seat:         full-width + live rim + ▣ SAVE / CANCEL
Panel banner: same harness BRAIN/WORKER colors + live rim
VramBadge:    single-model (unchanged)
Boost/spec:   natural cockpit; bag hydrates without applyFullAutoCockpit replan loop
```

### Storage

```ts
// catalog-quick-access v3
{
  version: 3,
  pins, recents,
  activeSeatSet: 0|1|2,
  seatSets: [seats, seats, seats],  // brain?/worker? (draft? legacy only)
  comboIds: [string|null, string|null, string|null],
}
```

- Knobs on `LaunchSeat` inside linked twin `ComboPreset` (`paramOverrides`, `boostMethod`, `policyId`, `providerId`, …).  
- Lazy create on first SAVE.  
- Orphan `comboId` cleared → ephemeral TWIN fallback.  
- Path pin write-through on SAVE.

### Seat-edit hydrate (race fix)

Do **not** call `applyFullAutoCockpit` during EDIT load (it replans parallel/kv/draft and fought the bag → endless CTX/SPEC re-eval).

Shipped path:

1. Latch `applied` immediately + `hydrateLockRef` (blocks cockpit capability re-snap ~120ms).  
2. Policy / provider / profile.  
3. `setSpeedBoost` + `applySpecBoostProfiles` only.  
4. Clear stale `mtp_*` / `dflash_*` not in bag; `updateParams(seat.paramOverrides)` **last**.

### Capture

`CAPTURE_KEYS` + prefix `mtp_` / `dflash_` + `device` + draft path keys.  
`LaunchSeat.boostMethod` for product Boost (not a CLI key).  
Shared helpers: `captureSeatFromPanel`, `captureSeatFromStack`.

### TWIN launch

1. Prefer linked combo for set; `syncComboModelPaths` from pins (overrides kept).  
2. Else ephemeral twin from paths + current panel snapshot.  
3. `applyComboPreset` + fusion dual.

---

## Product rules (locked)

1. **Isolate** — thin mode + buttons on standing panel/capture/apply.  
2. **Don’t duplicate** — reuse `LaunchSeat` / `ComboPreset` / capture / apply / real VramBadge.  
3. **Seats mental model** — seat path → **E** → tune panel → **SAVE** on seat.  
4. **Anytime capture** — panel toolbar →B/→W; running rail →B/→W.  
5. **Boost/spec = normal config** — both seats; no DRAFT catalog editor.  
6. **Twin combined forecast** — **stage 2**.  
7. **No popup dialogs** for REPLACE / clear / save-overwrite — inline YES/NO on the seat.  
8. **Harness colors** — seats + edit banner use `--theme-atom-brain-*` / `--theme-atom-worker-*` (same as harness connect).

```
Catalog SEATS (paths + set + TWIN + E/R/SAVE)
        │
        ├─ E seat     → load bag into real panel + real VramBadge
        │                 SAVE on seat → captureSeatFromPanel → linked combo
        │
        ├─ →B / →W    → panel or running stack → seat bag
        │
        └─ ▶ TWIN     → linked combo or ephemeral paths
                         fusion dual on launch
```

---

## Non-goals (still)

### Stage 1 (done / out of scope)
- Dual twin VramBadge  
- Third live engine / catalog DRAFT tile  
- Auto multi-seat VRAM packer  
- Second param editor / second forecast glass  

### Stage 2 (explicit later)
- Twin memory composition: live glass + peer `lastForecast` + total vs free  
- Optional tile mini badges (ctx · parallel · gpu)  
- Two live `evaluate()` panes only if snapshot strip is insufficient  

---

## Decision log

| # | Decision | Choice | Status |
|---|---|---|---|
| 1 | Knob storage | Linked `launchPresets` twin combo per set | **Shipped** |
| 2 | Preset visibility | Hidden via `listUserCombos` / `source: "catalog-set"` | **Shipped** |
| 3 | Policy scope | Per-seat `LaunchSeat.policyId` | **Shipped** |
| 4 | Knob UI | Existing panel only | **Shipped** |
| 5 | Path vs overrides | Path replace keeps knobs until SAVE | **Shipped** |
| 6 | Boost/draft/spec | Natural cockpit; both seats | **Shipped** |
| 7 | Catalog DRAFT tile | **Removed** — cockpit only | **Shipped** |
| 8 | Twin forecast | Stage 2 | Deferred |
| 9 | Overwrite UX | **R** / clear → YES/NO on seat; no `window.confirm` | **Shipped** |
| 10 | Bare TWIN | Ephemeral until first SAVE creates combo | **Shipped** |
| 11 | Edit hydrate | No `applyFullAutoCockpit`; bag last + hydrate lock | **Shipped** |
| 12 | AGENTIC HARNESS | Show only when ≥1 RUNNING engine | **Shipped** |

---

## Key files

| Area | Path |
|---|---|
| Path store v3 | `src/lib/catalogQuickAccess.ts` |
| Bags / capture | `src/lib/launchPresets.ts` |
| Events | `src/lib/events.ts` |
| Strip UI | `src/components/CatalogQuickStrip.tsx` |
| Edit/save/TWIN | `src/components/EngineConfigPanel.tsx` |
| Hydrate lock | `src/hooks/useCockpit.ts` (`hydrateLockRef`) |
| Styles | `src/styles/catalog.css` |

---

## Stage 1 acceptance

- [x] **E** BRAIN → panel shows that model/knobs; badge forecasts that model only  
- [x] Change ctx/GPU/Boost/spec → SAVE on seat → re-**E** restores bag  
- [x] Same for WORKER (own Boost/spec/draft path)  
- [x] Running →B/→W and toolbar →B/→W write seat bags  
- [x] ▶ TWIN uses linked bags when present  
- [x] Casual PRESETS not spammed with Catalog set combos  
- [x] No second forecast glass; no second param editor  
- [x] No DRAFT seat; harness-colored BRAIN/WORKER; full-width edit + live rim  
- [x] No dialogs for R/clear; edit hydrate does not thrash CTX/SPEC  

---

## Stage 2 backlog

1. On SAVE, store `lastForecast` from current manifest.  
2. Twin composition strip (live + peer snapshot + total) outside fusion dual height law.  
3. Optional seat-tile badges from overrides/snapshot.  
