# Harness Connect — catalog-bound panel plan

Status: **Implemented (bake-off)** — both surfaces live; pick one and delete the other  
Date: 2026-08-29  

### Shipped presentation (dual bake-off)

| Surface | Where | How to open | How to drop later |
|---|---|---|---|
| **Strip** | Above Running Engines (below VramBadge bezel) | Auto when ≥1 LOADING/RUNNING; collapsible chrome | Uncheck `strip` in strip chrome, or delete `harness.stripNode` mount + prefs |
| **Veil** | Overlay inside phosphor (sibling of VramBadge — **not** a face) | Auto once on 0→live; bezel **CONNECT**; catalog strip **CONNECT**; strip **VEIL** btn | Uncheck `veil`, or delete `harness.veilNode` + CONNECT chips |

Veil opacity: **dim** while any bound seat LOADING; **full opaque** when seats RUNNING. Hides on successful `pi_code_launch` or dismiss.  
Prefs: `KEYS.harnessConnectSurfaces` `{ strip, veil }` — keep ≥1 enabled during bake-off.  
Core: `src/lib/harnessBinding.ts`, `src/components/HarnessConnectPanel.tsx`, `src/components/HarnessConnectHost.tsx`.  
Wizard takeover deleted from `MultiAgentBooster` (launch cockpit only).

---

Status: **Ready to implement**  
Date: 2026-08-29  
Depends on: Catalog seats Stage 1 (`docs/CATALOG-SEATS-PLAN.md`)  
Review lock: placement, visibility, role derivation, aggressive wizard delete

---

## One-liner

**Catalog assigns BRAIN/WORKER. Harness Connect only binds to the live stack and opens pi.**  
Connect lives as a compact panel **below the VramBadge bezel, above Running Engines** — not a wizard, not a VramBadge face, not a second glass. Engine config stays untouched.

---

## Why

Today `MultiAgentBooster.tsx` (~2360 LOC) still owns a full-screen harness **wizard** that:

| Mechanism | ~LOC | vs catalog seats |
|---|---|---|
| Click-cycle role tagging (`NONE→BRAIN→WORKER`, `harnessEngineClick`, cycle rules) | ~150 | **Duplicate** — catalog assigns seats |
| Soft-seed first two engines, twin flip, `cycleTwinSeat` | ~100 | **Duplicate** of catalog order semantics |
| `pendingRelaunch` rematch (arm/vacate/timeout/alias, timers, `roleSyncTick`) | ~200 | Exists because hand-tags die across stop→launch |
| `presetTwinBind` + `rolesLocked` + Unlock + parent plumbing | ~120 | Dead weight — catalog TWIN ▶ already binds via linked combo |
| Wizard footer Combo Load/Save/Manage | ~60 | Duplicate of catalog sets + PRESETS |
| Duplicated BRAIN/WORKER blurbs ×3 | ~80 | Copy bloat |
| Cockpit takeover lattice (dock move, tray stow, param dim, scroll class) | ~150 | Only needed for full-screen wizard |

**Genuinely connect-owned (keep):** pi status / install / disclaimer / phase strip / DEV update, project dir, elevated, SOLO-vs-TWIN **readout** (derived), AGENTS concurrency + parallel-mismatch relaunch, confirm modal, `pi_code_launch`.

After catalog seats shipped, seat assignment has one product home. The wizard’s remaining job is **open pi against already-tagged engines** — that does not need a takeover or role editor.

---

## Target mental model

```
CATALOG STRIP                         LAUNCH COCKPIT
(assign seats, bags, SOLO/TWIN, ▶)    (engine config — untouched)
        │
        │  role-bearing live stack
        ▼
┌─────────────────────────────────────────────────────────────┐
│  VramBadge bezel / phosphor glass                           │
│  forecast | fusion | draft | skeleton  (UNCHANGED LAW)      │
├─────────────────────────────────────────────────────────────┤
│  HarnessConnectPanel          ← NEW, always when live       │
│  pi · seats readout · project · agents · OPEN               │
├─────────────────────────────────────────────────────────────┤
│  RunningEnginesPanel          ← BRAIN/WORKER colors stay    │
└─────────────────────────────────────────────────────────────┘
```

**Collapse the catalog after ▶** — user still sees:

1. Who is BRAIN / WORKER on the connect panel  
2. Matching harness colors on Running Engines  

One assigner. One connect surface. One forecast glass.

---

## Product laws (locked)

1. **Seat assignment exists in exactly one UI — the catalog strip.**  
   Harness Connect never cycles, flips, soft-seeds, or locks roles.

2. **Harness Connect only reads the live stack + catalog seat paths.**  
   It derives SOLO / TWIN / empty and the brain/worker ports. It does not write seat bags.

3. **VramBadge is measure + fusion only.**  
   No `face: "harness"`. No harness content inside the phosphor glass. Height law stays in `EngineGpuForecast`.

4. **One glass.**  
   Harness is **outside** the phosphor screen, same tier as Running Engines (eject panel family) — not a second industrial glass, not a modal takeover.

5. **Running Engines keep seat coloring.**  
   `html[data-harness-open]` + `EVENTS.harnessHighlight` stay one-way. Retire `EVENTS.harnessEngineClick`.

6. **Engine config never replaced.**  
   Launch cockpit (Memory / Agents / Boost / Think / CTX / flags / spec) stays usable while connect is visible. No param dim, no dock teleport, no bench-tray stow for harness.

7. **Backend untouched.**  
   `pi_code_launch` request contract unchanged (`solo` | `brain_workers`, primary/worker refs). No Rust role field required for v1.

8. **pi-only harness.**  
   Neutral `harness-*` chrome + `--theme-harness-brain-*` / `--theme-harness-worker-*`. Do not revive AtomCode/Qwen product paths.

---

## Placement (locked)

**File:** `src/components/EngineGpuForecast.tsx`  
**Slot:** between the industrial bezel / phosphor block and `RunningEnginesPanel`.

```
industrial-display-frame
  top chrome (FIT / GPU assign)
  phosphor-screen-inner → VramBadge
  DisplayBezelGridControls
HarnessConnectPanel          ← insert here (outside phosphor)
industrial-eject-panel
  RunningEnginesPanel
```

### Visibility (locked)

| Condition | Panel |
|---|---|
| ≥1 stack entry `LOADING` or `RUNNING` with `port > 0` | **Visible** (auto) |
| No live engines | **Hidden** |
| User collapses catalog | **Still visible** (lives in config column) |
| Engines panel toggled off via bezel ENG control | Connect **stays** (independent of engines-panel collapse) unless product later ties them — v1: connect visibility follows live engines only |

### Post-catalog ▶ (locked)

Catalog SOLO / TWIN ▶ success → connect is already auto-visible once engines enter LOADING.  
Optional polish: scroll/focus the panel once after ▶ (no separate open state machine required).

### Open/close state

- **No** “wizard open” boolean that takes over the cockpit.  
- Panel presence = f(live engines).  
- `html[data-harness-open]="1"` while panel is mounted and has a derived binding (or always while panel visible — prefer **while visible** so rail dimming matches “connect context on”).  
- After successful `pi_code_launch`: panel **stays**; show success toast / CTA idle state. Do **not** auto-unmount.

---

## Role source of truth

### Reality today (do not assume tags on stack)

`StackEntry` has **no `role` field**. Roles exist as:

- Catalog seat bags (path → brain/worker) in `catalog-quick-access` v3  
- Launch alias base `"BRAIN"` / `"WORKER"` (may uniquify to `BRAIN-2`, …)  
- Ephemeral wizard state (`twinRoles`, `presetTwinBind`) — **deleted in this plan**

### New pure helper

**File:** `src/lib/harnessBinding.ts` (+ vitest)

```ts
export type HarnessMode = "none" | "solo" | "twin";

export type HarnessBinding = {
  mode: HarnessMode;
  brain: StackEntry | null;
  worker: StackEntry | null;
  /** Human-readable empty/partial reason for UI. */
  reason?: string;
};

export function deriveHarnessBinding(
  stack: StackEntry[],
  catalogSeats: CatalogSeatsState,
): HarnessBinding;
```

### Resolution order (locked)

Live set = entries with `(status === "LOADING" || status === "RUNNING") && port > 0`.

1. **Alias prefix** — case-insensitive match on alias:
   - brain: `/^BRAIN\b/` or `/^BRAIN[-_]/`
   - worker: `/^WORKER\b/` or `/^WORKER[-_]/`
2. **Path match** — `normalizePath(entry.model_path)` equals active catalog seat path for brain/worker.
3. **Fallback**
   - exactly **1** live → `solo`, that entry is brain  
   - exactly **2** live and neither side resolved → slot-order: lower `idx` = brain, other = worker  
   - else → `none` + reason (e.g. “Launch seats from catalog”, “Need 2 running for twin”)
4. **Conflict** — same port resolved as both → `none` + reason.

Never silent wrong bind when ≥3 untagged live engines without alias/path hits.

### Optional session map (only if derive flakes on hot-swap)

```ts
// FE session only — not StackEntry, not Rust, not localStorage unless proven needed
Map<port, "brain" | "worker">
```

- Seed when catalog/combo launch binds ports, or when →B/→W captures a running engine.  
- Clear when that port leaves the live set.  
- Consult **after** alias, **before** path (or after path — pick one in implementation; prefer after alias, before path).  

v1 default: **derive-only**. Add session map in the same PR only if hot-swap parallel bump loses roles in manual test.

### Hot-swap / RESTART parallel

- Keep the **RESTART seat to match AGENTS ×N** button.  
- Delete `pendingRelaunch` arm/vacate/timeout/alias rematch machine.  
- After relaunch, alias `"WORKER"` / `"BRAIN"` (or path match) re-derives.  
- `onRelaunchSeat` parent path stays (`hotSwapEngineSeat`).

### agentsN seed

- Default = `max(1, worker.parallel)` in twin, else `max(1, brain.parallel)` in solo.  
- Chips override for the session open only.  
- No new localStorage key in v1.  
- `presetTwinBind.agentsN` path goes away; catalog combo `harness.agentsOverride` may still feed launch, but connect seeds from **live engine parallel** after seats are up.

---

## HarnessConnectPanel (new)

**File:** `src/components/HarnessConnectPanel.tsx`  
**Target size:** ~300–450 LOC  
**Styles:** extend `src/styles/cockpit.css` harness section; reuse `--theme-harness-brain-*` / `--theme-harness-worker-*`; neutral `harness-*` classes. Prefer compact density (1440p vertical is scarce).

### Content blocks (bare minimum)

| Block | Content |
|---|---|
| **Status** | pi chip: installed version **or** “~46 MB on first open”; DEV-only UPDATE; install phase strip + indeterminate bar (**verbatim** anti-stuck affordance from current wizard) |
| **Seats readout** | SOLO → one BRAIN row; TWIN → BRAIN + WORKER rows. Role + alias + `:port` + `∥N`. **Read-only** — no click to assign. Empty/`none` → short CTA pointing at catalog seats |
| **Project** | POINT THE AGENT + path (`pi_code_set_project` / pick folder) |
| **Concurrency** | AGENTS ×N chips; single “RESTART \<seat\> to match ×N” when `agentsN > engine.parallel` |
| **CTA** | elevated (gsudo) checkbox; OPEN pi; disclaimer path pre-install; slim confirm (summary + Confirm / Cancel / Change project) |

### Confirm modal (slim)

- Title: `Open pi — SOLO` | `Open pi — TWIN`  
- Summary: engine id(s) + AGENTS ×N + project basename + elevated flag  
- **No** multi-paragraph BRAIN/WORKER blurbs  

### Launch contract (unchanged)

```ts
PiLaunchRequest = {
  mode: "solo" | "brain_workers",
  primary: { port, model, contextWindow, parallel, vision },
  worker?: { … },  // twin only
  projectDir,
  elevated,
}
invoke("pi_code_launch", { request })
```

`canLaunch`:

- pi ready (or install+disclaimer flow)  
- project resolved (pick if missing)  
- `mode === "solo"` → brain live **RUNNING** (LOADING = show wait, disable OPEN)  
- `mode === "twin"` → brain + worker live **RUNNING**, distinct ports  

### Props (sketch)

```ts
type HarnessConnectPanelProps = {
  stack: StackEntry[];
  catalogSeats: CatalogSeatsState; // or pre-derived binding from parent
  onRelaunchSeat?: (opts: {
    slotIdx: number;
    port: number;
    alias: string;
    parallel: number;
  }) => Promise<void>;
  onSelectEngine?: (slotIdx: number) => void;
  className?: string;
};
```

Parent (`EngineGpuForecast` or `EngineConfigPanel`) supplies stack + seats. Prefer deriving inside the panel from stack + seats to keep the mount thin.

### Highlight wiring

While panel visible:

```ts
document.documentElement.dataset.harnessOpen = "1";
dispatchAppEvent(EVENTS.harnessHighlight, {
  open: true,
  soloPort: mode === "solo" ? brain.port : null,
  brainPort: mode === "twin" ? brain.port : null,
  workerPort: mode === "twin" ? worker.port : null,
});
```

On unmount / no live engines: clear dataset + `{ open: false }`.

`RunningEnginesPanel`: **keep** `harnessHighlight` listener + role chips/classes; **delete** `dispatchAppEvent(EVENTS.harnessEngineClick, …)` on card click.

---

## Delete list (aggressive)

### `MultiAgentBooster.tsx`

Remove entirely:

- `harnessOpen` takeover render (`if (harnessOpen) { … }` ~wizard tree)  
- `wizardMode` / `twinRoles` / `twinWorkerOnLeft` / `cycleTwinSeat`  
- soft-seed effect, click-cycle `harnessEngineClick` listener  
- `pendingRelaunch*` + `roleSyncTick` + arm/clear/prune effects  
- `presetTwinBind` consume effect + `presetRolesLocked` + Unlock UI  
- wizard footer combo Load/Save/Manage  
- duplicated BRAIN/WORKER blurbs  
- header **AGENTIC HARNESS** open button  
- `onHarnessOpenChange` prop and calls  

**Keep:** launch cockpit only (coding/speed/brains/think sliders, CTX embed, flags, violet spec strip, dflash hooks).

Rename → `LaunchCockpit.tsx` is **optional, separate cosmetic commit** after the cut — not required in the functional PR.

### `EngineBoostSection.tsx`

- Drop `presetTwinBind`, `onPresetTwinBindConsumed`, `onHarnessOpenChange` props and pass-through.

### `EngineConfigPanel.tsx`

- `harnessWizardOpen` state and all effects:
  - param live-dim suppress while harness open  
  - launch dock auto-move to right + restore  
  - bench tray stow + restore  
  - `config-params-scroll--harness-wizard` class  
  - Boost wrapper `flex-1` takeover class  
- `presetTwinBind` state + `setPresetTwinBind` after twin combo apply  
- Pass-through of harness open / preset bind into Boost section  
- `EngineLaunchDock` `harnessWizardOpen={…}`  

**Replace twin post-launch behavior:** after catalog/combo twin seats bind, **do not** open a wizard. Engines go LOADING → HarnessConnectPanel auto-shows. Optionally `onSelectEngine(brain)` as today.

Wire `catalogSeats` (or active set seats) + stack into `EngineGpuForecast` for the new panel.

### `EngineLaunchDock.tsx`

- Remove `harnessWizardOpen` prop and `data-launch-dock-dim` harness branch.

### `events.ts`

- **Delete** `EVENTS.harnessEngineClick` + `HarnessEngineClickDetail`  
- **Keep** `EVENTS.harnessHighlight` + `HarnessHighlightDetail`

### `RunningEnginesPanel.tsx`

- Remove click → `harnessEngineClick` dispatch  
- Keep highlight-driven `harness-engine--brain|worker|live|picked` classes

### CSS (`cockpit.css`)

- Delete or gut unused `.harness-wizard*` takeover layout once panel ships its own compact rules  
- Keep `html[data-harness-open]` engine coloring rules  
- Keep role chip token rules  
- Remove `.config-params-scroll--harness-wizard` if unused

### Docs touch-ups (same PR or follow-up)

- `docs/CATALOG-SEATS-PLAN.md` — add: connect binds derived seats; panel under bezel above engines; wizard deleted  
- `docs/DEFERRED-CLEANUP.md` — resolved entry for wizard/rematch/presetTwinBind  
- `AGENTS.md` harness paragraph — one line: harness UX = catalog seats + HarnessConnectPanel (below VramBadge, above Running Engines)

---

## Explicit non-goals

- No change to engine config panel knobs, sliders, or apply paths  
- No VramBadge face prop / harness inside phosphor glass  
- No fusion overlay behavior change; harness must **not** preempt fusion  
- No second forecast glass; no twin combined forecast (still catalog stage 2)  
- No backend / `pi_code.rs` / StackEntry.role field in v1  
- No new localStorage keys in v1 (elevated + last project stay as today)  
- No catalog strip CONNECT chip required (panel auto-lives with engines)  
- No MultiAgentBooster → LaunchCockpit rename in the functional commit  
- No PRESETS manage modal changes beyond deleting wizard’s duplicate row  

---

## Implementation phases

### Phase 0 — binding foundation

1. Add `src/lib/harnessBinding.ts` with `deriveHarnessBinding`  
2. Vitest: alias uniquify, path match, solo/twin fallback, conflict/none, empty stack  
3. No UI  

### Phase 1 — panel leaf

1. Extract pi status / install phase / project / agents / elevated / confirm / launch from wizard into `HarnessConnectPanel.tsx`  
2. Seats readout driven only by `deriveHarnessBinding`  
3. Story-complete in isolation (props + stack fixtures)  

### Phase 2 — mount

1. `EngineGpuForecast`: render panel above `RunningEnginesPanel` when live engines exist  
2. Pass `stack`, seats (from parent), `onRelaunchSeat`, `onSelectEngine`  
3. Wire `data-harness-open` + `harnessHighlight`  
4. Verify fusion glass unchanged while panel visible  
5. Verify catalog collapse still shows panel + colored engines  

### Phase 3 — delete takeover

1. Strip wizard + role machines from `MultiAgentBooster`  
2. Strip lattice from `EngineConfigPanel` / Boost / LaunchDock / events / RunningEngines click  
3. Remove twin `presetTwinBind` open path; rely on auto panel  
4. CSS cleanup of dead wizard takeover rules  

### Phase 4 — docs + verify

1. Update CATALOG-SEATS-PLAN, DEFERRED-CLEANUP, AGENTS.md  
2. `npx tsc --noEmit`  
3. Manual acceptance (below)  

**Do not** interleave Phase 3 deletes before Phase 2 mount is visibly working — avoid a window with no connect UI.

---

## Key files

| Area | Path |
|---|---|
| Binding (new) | `src/lib/harnessBinding.ts` |
| Panel (new) | `src/components/HarnessConnectPanel.tsx` |
| Mount | `src/components/EngineGpuForecast.tsx` |
| Seats source | `src/lib/catalogQuickAccess.ts` |
| Stack type | `src/lib/types.ts` → `StackEntry` |
| Events | `src/lib/events.ts` |
| Engine colors | `src/components/RunningEnginesPanel.tsx` |
| Delete wizard | `src/components/MultiAgentBooster.tsx` |
| Delete lattice | `src/components/EngineConfigPanel.tsx`, `EngineBoostSection.tsx`, `EngineLaunchDock.tsx` |
| pi client | `src/lib/piCode.ts` |
| Styles | `src/styles/cockpit.css` |
| Catalog plan | `docs/CATALOG-SEATS-PLAN.md` |

---

## Acceptance

- [ ] Seat assignment only possible in catalog strip (no connect-side role cycle)  
- [ ] ≥1 LOADING/RUNNING → HarnessConnectPanel visible below bezel, above Running Engines  
- [ ] 0 live engines → panel gone; `data-harness-open` cleared  
- [ ] Catalog TWIN ▶ → both seats LOADING/RUNNING → panel shows BRAIN + WORKER without clicks  
- [ ] Catalog SOLO ▶ → panel shows SOLO/BRAIN only  
- [ ] Catalog collapsed → panel + engine colors still visible  
- [ ] Running Engines show harness brain/worker colors while panel visible  
- [ ] Engine card click does **not** change roles (select only)  
- [ ] Fusion / ASSISTED / draft / skeleton faces unchanged with panel visible  
- [ ] Launch cockpit sliders usable while panel visible (no takeover dim)  
- [ ] AGENTS ×N > engine parallel → RESTART button; after hot-swap, derive still correct  
- [ ] OPEN pi solo/twin → `pi_code_launch` success; panel stays with success state  
- [ ] First-run install phase strip still communicates progress (not “stuck”)  
- [ ] `EVENTS.harnessEngineClick` gone; `presetTwinBind` / `rolesLocked` / `pendingRelaunch` gone  
- [ ] `npx tsc --noEmit` clean; `harnessBinding` tests green  

---

## Net effect

| | Before | After |
|---|---|---|
| Connect UX | Full cockpit takeover wizard | Compact panel under bezel |
| Seat assignment | Catalog **and** wizard clicks | Catalog only |
| Role survival | `pendingRelaunch` state machine | `deriveHarnessBinding` (+ optional session map) |
| Forecast glass | Unrelated but height-collided via tray stow | Untouched |
| Config while connecting | Hidden / dimmed / dock moved | Fully usable |
| LOC (order of magnitude) | Wizard + lattice ~1.2–1.5k connected | Panel ~300–450; cockpit slimmed |

---

## Decision log

| # | Decision | Choice | Status |
|---|---|---|---|
| 1 | Stop assigning seats in connect | Catalog-only assignment | **Locked** |
| 2 | Placement | Below VramBadge bezel, **above** Running Engines | **Locked** |
| 3 | Not a VramBadge face | Sibling eject-tier panel; glass law unchanged | **Locked** |
| 4 | Visibility | Auto when ≥1 LOADING/RUNNING | **Locked** |
| 5 | Post catalog ▶ | Auto-visible via live engines (focus polish optional) | **Locked** |
| 6 | Role source | `deriveHarnessBinding` (alias → path → 1/2 fallback) | **Locked** |
| 7 | Hot-swap rematch machine | Delete; rely on derive | **Locked** |
| 8 | Session port→role map | Only if derive fails hot-swap in manual test | **Contingent** |
| 9 | agentsN seed | Live worker/solo `parallel` | **Locked** |
| 10 | After OPEN pi | Panel stays + success | **Locked** |
| 11 | Backend role field | Not in v1 | **Locked** |
| 12 | Engine config | Untouched; no takeover lattice | **Locked** |
| 13 | Rename MultiAgentBooster | Optional later commit | **Deferred** |

---

## Open polish (non-blocking)

- Scroll/focus connect panel once after catalog ▶  
- Tie connect visibility to engines-panel bezel toggle (probably **don’t**)  
- Persist last agents chip override  
- Compact dual-row layout vs single stacked row at 1080p marginal height  
- Rename `MultiAgentBooster` → `LaunchCockpit`  

None of these block the functional cut.
