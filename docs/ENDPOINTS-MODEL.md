# Endpoints model — the shape change

**Status: spec, not implemented.** Written 2026-11-17 while the catalog block was still wired
through the preset join. Execute it in one pass; do not do halves.

## 1. Target shape

Today the pairing lives twice: `catalogQuickAccess.seatSets[i]` (three optional role keys) and
`launchPresets.ComboPreset.seats[]`, joined by `comboIds[i]`. Endpoints must be the only source.

```ts
// catalogQuickAccess v4 (hard bump; no migration — local store, owner can reset)
type EndpointRole = "brain" | "worker";          // draft is gone

type Endpoint = {
  id: string;        // stable, generated on add
  role: EndpointRole;
  path: string;      // model GGUF
};

type EndpointSet = Endpoint[];                   // 0..MAX_ENDPOINTS

type CatalogQuickStoreV4 = {
  version: 4;
  pins: string[];
  recents: CatalogRecentEntry[];
  activeSet: number;            // 0..SET_COUNT-1, clamped on read
  sets: EndpointSet[];          // SET_COUNT entries
};

export const CATALOG_SET_COUNT = 5;
export const CATALOG_ENDPOINTS_MAX = 6;          // see §4
```

## 2. Invariants (enforce in `sanitize`, not in components)

1. **Exactly one `brain`** per set — zero or two is invalid, collapse to the first brain found.
2. At most `CATALOG_ENDPOINTS_MAX` endpoints per set.
3. No duplicate `path` inside a set; no empty paths or ids.
4. `activeSet` clamped to `0..CATALOG_SET_COUNT-1` (there is a `clampSetIndex` today — keep it).
5. Unknown fields dropped. A malformed store degrades to fewer endpoints, never throws.

## 3. Call sites to change

| file | what changes |
|---|---|
| `src/lib/catalogQuickAccess.ts` | v4 shape, `sanitize*`, add/remove/update endpoint, set index clamp |
| `src/lib/launchPresets.ts` | `seatOnCombo`, `ensureCatalogSetCombo`, `ComboPreset.seats` — pairing now derived or deleted; `draft` removed from role unions |
| `src/lib/catalogSeatLearnedMem.ts` | `draft` removed |
| `src/components/CatalogQuickStrip.tsx` | rows from `Endpoint[]`; `+` row; set tabs `1..5`; roles fixed (BRAIN first row, `+` adds workers) |
| `src/components/HarnessConnectPanel.tsx` | one brain rule stays; worker list may be >1 — decide whether harness uses the first worker or requires a pick |
| launch-detail types (`catalogLaunchSeats`, `catalogLaunchSeatSolo`) | carry endpoint ids / worker list instead of `brainPath`/`workerPath` |
| `src/components/EngineConfigPanel.tsx` | delete `LaunchPresetsMenu` import, `LaunchPresetsModal`, `handleSaveSolo/TwinPreset`, `presetsManageOpen` once combos are unused |

## 4. UI

- **Five set tabs**, `1..5`.
- Rows: BRAIN first (fixed), then workers, then a `+ ADD ENDPOINT` row.
- **Three rows visible; the list scrolls inside the block** with a bottom fade. A modal only
  earns its keep past ~6 endpoints, and the sidebar already shows the model list you pick from.
- Empty row = dimmed row with `+`, same height as a filled one, so the block does not jump.
- While expanded: favourites hidden (done), help block persistent on top and closable.

## 5. Preset retirement order

1. Endpoints own the pairing; `comboIds` and the write-through deleted. ✔ behaviour unchanged.
2. `ComboPreset` becomes derived → no writers.
3. Delete the menu, the modal, the handlers, `LaunchPresetsModal` state, and the store file's
   preset half. Do **not** leave the modal unused-but-present: an unreachable feature is worse
   than an absent one.

## 6. Acceptance

- `npm run check` green.
- Fresh profile: favourites open, endpoints closed, 5 empty sets, `+` row visible.
- Add 6 endpoints → 7th refused with a reason; scroll works; BRAIN stays first.
- Two brains impossible via UI **and** via a hand-edited store (`sanitize` collapses).
- `grep -ri "seat" src/components src/lib` returns only code identifiers slated for rename, no
  user-facing copy.
- Engine config still has no endpoint/preset UI: any knob, including spec decoding, stays the
  cockpit's responsibility.
