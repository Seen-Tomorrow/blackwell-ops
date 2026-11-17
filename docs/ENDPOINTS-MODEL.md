# Endpoints model — the shape change

**Status: implemented 2026-11-17.** The v4 store, the fixed BRAIN row and the
menu/modal/preset-store retirement all landed together; `docs` still describes the shape the
catalog block now uses rather than a plan.

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

The endpoint owns the *pairing* only. Its knob bag lives beside it in
`endpointBags` (`BlackOps-endpoint-bags`), keyed by endpoint id: a saved bag is not part
of the endpoint shape, so a set can be inspected as pure pairing while the cockpit's
saved config survives for launch.

## 2. Invariants (enforce in `sanitize`, not in components)

1. **At most one `brain`** per set — a second BRAIN collapses to WORKER. Zero brains is an
   incomplete set (it cannot launch), not an illegal one.
2. At most `CATALOG_ENDPOINTS_MAX` endpoints per set.
3. No duplicate `path` inside a set; no empty paths or ids.
4. `activeSet` clamped to `0..CATALOG_SET_COUNT-1` (there is a `clampSetIndex` today — keep it).
5. Unknown fields dropped. A malformed store degrades to fewer endpoints, never throws.

## 3. Call sites to change

| file | what changes |
|---|---|
| `src/lib/catalogQuickAccess.ts` | v4 shape, `sanitize*`, add/remove/update endpoint, set index clamp |
| `src/lib/launchPlan.ts` | seat capture / apply plan only; the preset store and `ComboPreset` are gone |
| `src/lib/endpointBags.ts` | per-endpoint cockpit bag keyed by endpoint id; sanitized, pruned with the endpoint |
| `src/components/CatalogQuickStrip.tsx` | rows from `Endpoint[]`; `+` row; set tabs `1..5`; roles fixed (BRAIN first row, `+` adds workers); EDIT/SAVE per row |
| `src/components/HarnessConnectPanel.tsx` | one brain rule stays; the harness binds the first live worker, extra workers just run |
| `catalogLaunchEndpoints` detail | endpoint ids instead of `brainPath`/`workerPath` |
| `src/components/EngineConfigPanel.tsx` | preset menu/modal/handlers/state deleted; endpoint edit session and launch read `endpointBags` |

## 4. UI

- **Five set tabs**, `1..5`.
- Rows: BRAIN first (fixed), then workers, then a `+ ADD ENDPOINT` row.
- A filled row carries `EDIT`. EDIT selects the endpoint's model and hydrates its saved
  bag into the cockpit; SAVE writes the cockpit's current knobs back onto that endpoint,
  CANCEL leaves without writing. This is the only per-endpoint config surface, and it is
  the cockpit that edits the knobs.
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

## 7. Decisions recorded during implementation

- **Harness takes the first worker.** A set can hold several workers, but pi binds one BRAIN and
  one WORKER; `deriveHarnessBinding` takes the first live worker by slot index. The other workers
  keep running and remain reachable by any OpenAI-compatible client.
- **Launch uses each endpoint's saved bag.** EDIT → SAVE stores the cockpit's knobs on
  that endpoint id; launch reads them back. An endpoint with no bag falls back to the
  cockpit's current config when it is the model the cockpit is showing, otherwise to
  factory defaults.
- **No BRAIN, no worker.** `+` is disabled until the fixed BRAIN row is filled, so a set can never
  reach the endpoint cap without a brain. `putCatalogEndpoint` refuses the same case in the store.
- **Zero brains is an incomplete set, not an illegal one.** Only *two* brains are illegal; sanitize
  keeps the first and collapses the extras to WORKER.

