# Catalog seats — granular control plan

Status: **design review** (not implementing yet)  
Branch: `feat/catalog-quick-access`  
Date: 2026-08-27

---

## What seats are today

| Layer | Owns | Persists |
|---|---|---|
| **Catalog seats** (this branch) | BRAIN / WORKER / DRAFT **model paths**, 3 named sets, ▶ TWIN launch | `localStorage` `catalog-quick-access` (path-only) |
| **Launch presets** | Full combo: models + provider + policy + param overrides + ports + harness | `launchPresets` store |
| **Config panel** | Live knobs for the **selected** model | Session + provider templates |

▶ TWIN builds an **ephemeral** twin combo (does **not** save a preset), attaches DRAFT path to BRAIN Boost (`dflash_draft_model`), launches via existing `applyComboPreset`, forces fusion **DUAL**.

**DRAFT seat ≠ third engine.** It is BRAIN’s speculative pack only.

---

## Product tension

Seats feel right in the catalog (contextual, always visible, set 1/2/3).  
Full control (GPU mask, split, ctx, batch/ubatch, parallel, think, draft method, …) already lives in **presets + panel**.

Duplicating every knob only on seats would fork two editors and rot.  
**Recommendation:** seats stay the **catalog face**; depth goes through a **seat-aware preset editor** (or “edit set → preset”) so one source of truth for knobs, two entry points for UX.

```
Catalog SEATS (paths + set + TWIN)
        │
        ├─ quick: ephemeral twin (today)
        │
        └─ deep: open preset editor bound to this set
                  ├─ per-seat: GPU, split, ctx, batch, ubatch, parallel, think, …
                  ├─ BRAIN-only: Boost method + DRAFT pack path
                  └─ persist combo on disk (launchPresets store)
```

---

## Goals (next slice)

1. **Per-seat launch knobs** without leaving the seats mental model  
   - GPU assignment / mask  
   - split mode  
   - ctx, batch, ubatch, parallel  
   - think / related flags that already exist as panel params  
   - BRAIN: draft/Boost settings (pack path already on DRAFT seat)

2. **Fit is user-owned** — we expose controls + existing forecast on the active main; no new auto-oracle required for v1.

3. **Persist** seat-set configs so tomorrow’s session restores knobs, not just paths.

4. **No second parallel system** — reuse `LaunchSeat` / `ComboPreset` / `applyComboPreset` / panel capture helpers.

---

## Non-goals (v1)

- Third live engine for DRAFT  
- Auto VRAM packing / multi-seat topology solver beyond what Full Auto already does at launch  
- Replacing PRESETS menu for non-catalog workflows  
- Family collapse / fit-now changes (already separate)

---

## Proposed architecture

### A. Bind each catalog seat **set** → optional `ComboPreset` id

```ts
// catalog-quick-access store (v3 sketch)
seatSets: [
  { seats: { brain?, worker?, draft? }, comboId?: string },
  ...
]
```

- Paths remain editable in the catalog strip (fast).  
- Knobs live on the linked combo (or an auto-created “Catalog set N” combo).  
- ▶ TWIN prefers linked combo if present; else ephemeral from paths + defaults (today).

### B. Expand preset editor for twin (+ draft pack)

Per seat row in editor (BRAIN / WORKER):

| Control | Source |
|---|---|
| Model path | seat / combo (catalog can still reassign path) |
| GPU mask / assign | existing param / gpu assign surface |
| split | template key |
| ctx, batch, ubatch, parallel | template keys / sparse overrides |
| think / extras | sparse overrides as today |
| policy (Full Auto / Assisted) | `LaunchSeat.policyId` |

BRAIN-only block:

| Control | Source |
|---|---|
| Boost method | existing Boost UI / overrides |
| Draft pack path | DRAFT seat path ↔ `dflash_draft_model` |

Editor opens from:

- SEATS chrome: **EDIT** (active set)  
- PRESETS menu (unchanged)

### C. Launch path (unchanged core)

1. Resolve combo for active set (linked or ephemeral).  
2. Sync DRAFT path → BRAIN overrides.  
3. `applyComboPreset(combo, { loadIntoPanel: false })`.  
4. `fusionDisplay.setMode("dual")`.

### D. Memory / fit

- Selecting BRAIN (or launching) still drives existing forecast glass.  
- Optional later: fit-now chips on seat cards (LEARNED/FIT spine only — same wall as catalog fit-now).  
- No new probe storm from seat UI.

---

## UX sketch (SEATS header)

```
[1][2][3]     SEATS      [EDIT] [▶ TWIN]
┌ BRAIN … ┐ ┌ WORKER … ┐ ┌ DRAFT … ┐   ← violet DRAFT face
```

- **1/2/3** — switch set (done)  
- **EDIT** — open expanded preset editor for this set’s combo  
- **▶ TWIN** — launch (done; dual on launch)

Optional later: mini badges on seat tiles (ctx · parallel · gpu) from linked overrides — read-only summary.

---

## Persistence choice

| Option | Pros | Cons |
|---|---|---|
| **A. Link to launchPresets** (recommended) | One editor, one apply path, already on disk | Need migration + “catalog-owned” combo naming |
| B. Expand `catalog-quick-access` with full overrides | Seats fully self-contained | Duplicates preset schema & editor forever |
| C. Session-only knobs | Simple | Lost on restart — weak for “test until it fits” |

**Pick A** unless review rejects coupling.

---

## Implementation phases (for after review)

1. **Schema** — v3 store: `comboId` per set; migrate v2 paths.  
2. **Ensure combo** — first EDIT or first TWIN with knobs creates/updates linked twin combo from current paths.  
3. **Editor expand** — twin seat rows: GPU, split, ctx, batch, ubatch, parallel, think; BRAIN draft block.  
4. **SEATS EDIT** entry + path sync (catalog path change updates combo modelPath).  
5. **TWIN** always applies linked combo when present; dual display (done).  
6. **Polish** — seat tile summaries, validation (“WORKER missing parallel”), no preset spam in menu (tag `source: "catalog-set"` and filter or group).

---

## Open questions (tweak tomorrow)

1. Should catalog-linked combos appear in the global PRESETS list, a “Catalog” folder, or stay hidden except via SEATS EDIT?  
2. Per-seat **policy** (Full Auto vs Assisted) or one policy for the twin?  
3. GPU assign: reuse panel GPU assign UI embedded in editor, or compact mask chips only?  
4. When user changes BRAIN path on a set mid-session, wipe BRAIN overrides or keep ctx/parallel?  
5. DRAFT set member: enforce `isExternalDraftOnly` on assign?  
6. EDIT opens modal vs slide-over vs existing LaunchPresetsModal tab?

---

## Already shipped on this branch (context)

- Pins / recents (name + quant rows, chrome section headers)  
- Seats path assign, 3 sets, violet DRAFT, ▶ TWIN → ephemeral combo + dual  
- Selected pin floats to top of catalog list  
- Fit-now filter (FIT spine + free VRAM only)  
- Draft models: hatch + full glass face; no FIT probe  

---

## Decision log (fill in review)

| # | Decision | Choice |
|---|---|---|
| 1 | Knob storage | A launchPresets link / B seats bag / C session |
| 2 | Preset visibility | listed / grouped / hidden |
| 3 | Policy scope | per-seat / twin-wide |
| 4 | GPU UI density | full assign / mask chips |
| 5 | Path change vs overrides | keep / reset |
