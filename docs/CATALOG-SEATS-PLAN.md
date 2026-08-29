# Catalog seats — granular control plan

Status: **Stage 1 shipped + hardening** (this branch)  
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
| **Catalog seats** | BRAIN / WORKER paths, 3 sets, **SOLO/TWIN**, **E** / **R** / SAVE | `catalog-quick-access` **v3** |
| **Linked combos** | Twin bags (`source: "catalog-set"`) — **not** counted in PRESETS 50-cap | `launchPresets` store |
| **Config panel + VramBadge** | Live knobs + measured forecast for **one** selected model | Session + templates |
| **FAVORITE** | Pinned catalog chips (recents strip **removed**) | pins in v3 store |

**Not a third engine.** Boost / MTP / DFLASH / DSPARK / draft path live on each **engine seat bag**.

### UX (current)

```
[1][2][3]  AGENTIC HARNESS SEATS  [TWIN|SOLO] [▶]
┌ BRAIN (harness colors)  R E × ┐  ┌ WORKER  R E × ┐
```

| Control | Behavior |
|---|---|
| Empty seat click | Assign selected catalog model (path only) |
| Filled seat click | **Select only** — never silent overwrite |
| **R** | Replace path → YES/NO; writes path through on bag (**keeps knobs**) |
| **E** | Full-width edit; parks running-slot panel bind; hydrate lock for whole session |
| **×** | Clear path → YES/NO; clears bag path, keeps knobs |
| Edit SAVE | On the seat: `▣ SAVE` / CANCEL |
| Toolbar / rail `→B / →W` | Save panel or running engine into **that role only** (no cloned sibling) |
| **TWIN** `▶` | Both seats must have **saved bags with paths**; else error (use SOLO) |
| **SOLO** `▶` | Launch selected (or only) seat as solo for harness connect |
| AGENTIC HARNESS (cockpit) | Hidden until ≥1 RUNNING engine |
| Set switch mid-edit | Cancels edit |

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
### Seat-edit hydrate

Do **not** call `applyFullAutoCockpit` during EDIT load.

1. `hydrateLockRef` for the **whole edit session** (unlock on SAVE/CANCEL only).  
2. Policy / provider / profile.  
3. `setSpeedBoost` + `applySpecBoostProfiles` only.  
4. Seat bag last. No bag → clear stale SPEC, Boost off (do not keep previous model).  
5. Running-engine clicks do not steal the panel while editing.

### Capture

`CAPTURE_KEYS` + prefix `mtp_` / `dflash_` + `device` + draft path keys.  
`LaunchSeat.boostMethod` for product Boost (not a CLI key).  
Shared helpers: `captureSeatFromPanel`, `captureSeatFromStack`.

### Launch

1. **TWIN** — linked combo only; both seats must have model paths + bags (`catalogComboReadyForTwin`). No ephemeral clone of one panel onto two engines.  
2. **SOLO** — selected (or only filled) seat as `kind: "solo"` for harness connect; fusion single.  
3. Catalog-set combos are exempt from `LAUNCH_PRESETS_MAX`.


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
