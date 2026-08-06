# Launch presets — design (twin harness + general)

**Status:** product locked — implement on branch `ENGINE-PRESETS` (v1+v2 in one go)  
**Depends on:** ENGINE-CONFIG-refactor (merged) — policies + sparse mode profiles + pure `buildLaunchConfig`  
**Related:** `docs/engine-config-pipeline.md` (layers — do not collapse)

---

## 1. Problem

Today you can tune BRAIN and WORKER carefully (model, provider, Full Auto/Assisted, CTX, agents, KV, Boost, FIT…), launch them, open harness **Twin**, and click seats. Next session you rebuild the same combo by hand.

**Wanted:** save a named “coding twin” (or any multi-seat recipe) and later **1-click recall / edit**, especially for harness connect — without hard-coding dead ports as the only identity.

---

## 2. What a preset is *not*

| Existing layer | Role | Preset relation |
|----------------|------|-----------------|
| Factory template | Param structure | Unchanged |
| User catalog | CONFIG editor defaults | Unchanged |
| **Mode profiles** (full_auto / assisted_*) | Per-provider *current* chip bag | Preset **snapshots** selected values; does not replace mode profiles |
| Model-spec | mtp/dflash per GGUF path | Copy into seat snapshot or re-resolve by path on apply |
| Running stack | Live ports / aliases | Apply *creates or matches* seats; ports are ephemeral unless opted in |

**Invariant:** a preset is a **named launch recipe**, not a fourth mode profile and not a second CONFIG.  
Apply = load recipe → run pure `buildLaunchConfig` per seat → launch (or bind running engines).

---

## 3. Product shapes (progressive)

### 3.1 Seat (atomic unit)

One engine you would launch from the Launch rail:

```text
Seat = {
  role?: "brain" | "worker" | "solo" | "custom"
  label?: string                    // UI name, e.g. "BRAIN · 32k orchestrator"
  modelPath: string                 // durable identity (normalized)
  providerId: string
  binaryProfile?: "frontier" | "stable" | …
  policyId: LaunchPolicyId          // full_auto | assisted_essentials | assisted_full
  // Sparse overrides only — same spirit as mode profiles (not full sludge bag)
  paramOverrides: Record<string, string | number>
  // Optional model-spec knobs if you want draft pairing frozen
  modelSpecOverrides?: Record<string, string | number>
  // Port policy — see §5
  portPolicy: PortPolicy
}
```

### 3.2 Combo (what you actually save for twin)

```text
ComboPreset = {
  id: string                        // uuid
  name: string                      // "Coding twin · Qwen big + small"
  version: 1
  kind: "solo" | "twin" | "multi"   // multi = N seats, general case
  seats: Seat[]                     // twin: exactly 2 with roles brain+worker
  harness?: {
    tool: "pi" | "atomcode" | "qwen"
    defaultMode: "solo" | "twin"
    // agents N usually comes from WORKER parallel — optional override
    agentsOverride?: number
  }
  createdAt / updatedAt
  notes?: string
}
```

- **Twin** is the star product: `kind: "twin"`, two seats, harness defaults.
- **Solo** is one seat + optional harness solo mode.
- **Multi** unlocks “unlimited model combos” later without a new product — N seats, roles free-form.

### 3.3 What you tune today that must round-trip

Minimum useful for coding twin:

| Field | Why |
|-------|-----|
| Model path + display name | Identity |
| Provider + binary profile | Which binary |
| Policy id (Full Auto vs Assisted) | Which value bag / key set |
| Cockpit: ctx, parallel, kv_quant, reasoning | Day-to-day coding |
| Boost method + draft path if DFlash | Spec setup |
| FIT-relevant: offload/split only if Assisted + user chrome | Topology |
| Vision / flash / load_mode | Flags |

Do **not** require saving every advanced chip unless the user is in Assisted Full — snapshot **active policy bag** (sparse keys that differ from factory) at save time.

---

## 4. UX — where it lives

Two surfaces, **one data model** (don’t fork schemas).

### A. Standalone **PRESETS** control (recommended home)

On the Launch rail (toolbar or dock chrome), not buried only in harness:

```text
[ PRESETS ▾ ]  Coding twin · Qwen…    [Save current…] [Edit…]
```

- **Dropdown:** list combos (twin badges, solo badges).
- **Apply:** confirm if engines already running / VRAM tight.
- **Save current…**
  - Solo: snapshot active panel model + active mode profile.
  - Twin: “Save as twin” needs **two seats** — wizard: pick BRAIN seat (running or panel) + WORKER seat (running or second snapshot).
- **Edit…** modal: rename, reorder seats, tweak overrides, delete, duplicate.

This is the “unlimited combos” surface.

### B. Harness connect integration (high leverage)

Inside the AtomCode/pi wizard (Twin / Solo):

```text
Twin mode
  BRAIN  [running card / Apply preset seat]
  WORKER [running card / Apply preset seat]

  [ Load combo ▾ ]   Coding twin · Qwen…
  [ Save as combo ]  (from current BRAIN+WORKER assignment)
```

- **Load combo:** if engines matching model paths already Running → **bind roles by model/alias** (no re-launch). Else → **launch missing seats** then bind.
- **Save as combo:** from currently tagged BRAIN+WORKER cards (or solo seat) + harness tool + agent count.

Harness does **not** own storage; it only **applies** ComboPresets and **captures** them.

### Recommendation

Ship **data model + Apply/Save** first; UX entry points:

1. **v1:** Harness Twin “Save combo / Load combo” + small Launch toolbar dropdown (same list).  
2. **v2:** Full PRESETS editor (multi-seat, notes, duplicate).

Do not put presets only inside harness — power users will want 1-click without opening the wizard.

---

## 5. Port policy (your question)

Ports are **runtime**, models are **identity**.

```ts
type PortPolicy =
  | { mode: "auto" }                          // base_port / next free (default)
  | { mode: "prefer"; port: number }          // try this; fall back if busy
  | { mode: "fixed"; port: number };          // require free or fail with clear error
```

| Mode | Harness twin | Other uses |
|------|--------------|------------|
| **auto** (default) | Best — connect by whatever ports land | Scripts that don’t care |
| **prefer** | Optional “usually 8080/8081” | Lab machines with habits |
| **fixed** | Rare for harness | External tools hard-coded to a port |

**Harness connect** should always treat **running engine identity** as:

1. `model_path` (primary)  
2. `alias` (secondary)  
3. `port` only after bind  

Toggle in UI: **“Remember preferred ports”** on the combo (maps to prefer/fixed). Off → `auto`.

Port check on apply:

- fixed/prefer: probe busy → toast + offer auto / stop other seat.  
- Never silently kill unrelated listeners (AGENTS.md: no port carpet-bomb).

---

## 6. Apply semantics (critical)

### 6.1 Resolve seats

For each seat in order (BRAIN first is nice for VRAM psychology, but WORKER-first may free fit — product call):

1. If a **Running** stack entry matches `modelPath` (and optional alias) → **reuse** (no second process).  
2. Else **launch** via `buildLaunchConfig` with:
   - seat’s `policyId` + `paramOverrides` as the profile bag for that build  
   - do **not** permanently stomp the user’s live mode profile unless “Also set as my current panel config” is checked  
3. Wait Running / health.  
4. Harness: assign BRAIN/WORKER ports from resolved seats.

### 6.2 Isolation from live panel

**Default Apply:** launch engines for the combo without rewriting Launch panel chips (less surprise).

**Optional “Load into panel”:** write seat overrides into that provider’s **active mode profile** so the rail matches what you launched (good for editing a preset).

### 6.3 Partial failure

- BRAIN up, WORKER OOM → leave BRAIN running, surface error, don’t open harness twin half-bound unless user confirms.  
- Model path missing on disk → mark seat broken in list, block apply.

---

## 7. Save capture

### From panel (solo)

Snapshot: `model.path`, provider, binary profile, `activePolicy`, sparse `config` keys (or full sparse profile), optional model-spec, port policy default `auto`.

### From harness twin

Snapshot two seats from **running** stack entries (authoritative for parallel/ctx actually loaded) **plus** optional overlay from panel if user is editing the same model.

Prefer **runtime stack** for “what I just used successfully”; allow “from panel” when engine not running yet.

### Diff storage

Store **sparse overrides** (key → value), not entire resolved bag — same lesson as mode profiles (no factory freeze).

---

## 8. Storage

```text
localStorage BlackOps-launch-presets:v1
  { version: 1, combos: ComboPreset[] }

// Optional later: disk file under config/ for portable/sync
// config/launch-presets.json
```

- Cap list (e.g. 50) with prune/export later.  
- Export/import JSON for sharing recipes between machines.

---

## 9. UI sketches (text)

### Launch toolbar

```text
┌ PRESETS ─────────────────────────────────────┐
│ ★ Coding twin · Qwen 72B + 7B          Twin  │
│   Bench solo · DS4                     Solo  │
│ ───────────────────────────────────────────  │
│ + Save current seat…                         │
│ + Save twin from running engines…            │
│ Manage presets…                              │
└──────────────────────────────────────────────┘
```

### Harness Twin footer

```text
[ Load combo ▾ ]  [ Save combo ]     [ Open pi ]
```

### Manage modal

List → Edit seats (model picker, policy, key chips or “open in panel”), port policy toggle, harness defaults, Delete / Duplicate.

---

## 10. Implementation order (v1 + v2 in one go)

1. **Schema + storage + pure apply plan**  
   `resolveComboApply(combo, stack, …) → { launch[], bind[], errors[] }` — unit tested.  
2. **Save/apply solo** (panel + toolbar).  
3. **Save/load twin** (harness + toolbar); bind running / launch missing.  
4. **Cold launch order:** default **parallel** seat launches; optional **“Sequence BRAIN first”** on combo.  
5. **Manage / edit modal** (full editor — large modal, not permanent panel chrome).  
6. Multi-seat `kind: "multi"` if time allows inside same editor (same schema).

**Do not** invent a parallel launch builder — always call existing `buildLaunchConfig` + `launch_engine`.

**Do not** store only ports as seat identity.

### Editor UX (locked)

- **Full preset editor = large modal** opened from Launch **PRESETS → Manage** (and “Edit…” on a combo).  
- **Not** a permanent third column or always-on block inside the config rail (too heavy).  
- Launch block keeps a **compact** control: dropdown + Save + Manage.  
- Harness keeps **compact** Load/Save combo only; deep edit opens the same modal.

---

## 11. Risks / non-goals

| Risk | Mitigation |
|------|------------|
| Preset sludge freezes old factory | Sparse overrides only |
| Stomping mode profiles on every apply | Default apply doesn’t write panel profile |
| Port fights / kill wrong process | auto default; fixed never taskkill-by-port |
| VRAM twin OOM | Pre-check FIT/forecast if both seats need launch; order seats |
| Stale model paths | Validate on list render + apply |
| Scope creep into CONFIG editor | Presets stay Launch/harness; CONFIG remains catalog |

**Non-goals v1:** cloud sync, team sharing, auto-save every launch, rewriting PI config by hand (harness launch path already writes providers).

---

## 12. Decision log (locked 2026-08-06)

| Decision | Choice | Date |
|----------|--------|------|
| Port policy | **All 3 available** (`auto` / `prefer` / `fixed`); **default `auto`** for new seats/combos | 2026-08-06 |
| Apply mutates panel profile? | **No by default**; **optional checkbox** “Also load into Launch panel” | 2026-08-06 |
| Twin / multi cold launch order | **Parallel first** (fast workstation); optional per-combo **“Sequence BRAIN first”** checkbox | 2026-08-06 |
| Capture source default | **Running stack first** (authoritative); **panel second** if that seat’s model is not running | 2026-08-06 |
| Storage | localStorage v1; disk export/import later OK | 2026-08-06 |
| UX entry | **Both** Launch block (toolbar) **and** harness block | 2026-08-06 |
| Agents N | **From WORKER seat `parallel`** by default; **overridable in editor** | 2026-08-06 |
| Scope | **v1 + v2 in one go** (dropdown + harness + full manage modal) | 2026-08-06 |
| Full editor placement | **Large modal** from Manage/Edit — not permanent engine-config chrome | 2026-08-06 |

---

## 13. One-liner

> **A Launch Combo is a named list of seats (model + policy + sparse overrides + port policy); Twin is just two seats with BRAIN/WORKER roles. Harness loads/saves combos; Apply reuses running engines by model path and only launches what’s missing — pure builder stays the only launch path.**

---

## Why this waited for the refactor

Before mode profiles + pure builder, a “preset” would have been another shared sludge bag and another set of Full Auto `if`s. Now:

- Seat overrides = same shape as a mode profile snapshot  
- Launch = `buildLaunchConfig` + policy key set + ESS snap  
- Harness stays a **consumer** of Running ports, not a second config system  

Ready to implement when you lock §12.
