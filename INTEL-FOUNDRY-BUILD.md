# Intel → Foundry “Build Now” — Post-Ship Plan

**Status:** Backlog (do not block current release)  
**Scope:** INTEL tab only + thin Foundry context bridge  
**Estimated effort:** PR path ~½ day · Release tag path +½–1 day

---

## Goal

From INTEL feed rows (PR, OPEN PR, RELEASE), let the user start a Foundry build for the matching provider **without leaving context**. One polished **BUILD** control per row; profile (`vanguard` / `stable` / `fresh`) chosen **on click**, not as permanent inline chips.

---

## UX (preferred)

### Row actions

| Source   | Primary action label              | Secondary |
|----------|-----------------------------------|-----------|
| `pr`     | `⚒ BUILD PR IN FOUNDRY`           | Open on GitHub (existing link) |
| `open_pr`| `⚒ BUILD PR IN FOUNDRY`           | same |
| `release`| `⚒ BUILD RELEASE IN FOUNDRY`      | same |

- **Visual:** small foundry-styled button (hammer icon, theme accent border, matches `foundry-status-chip` / `catalog-scan-btn` tone).
- **Placement:** right side of row meta line, or footer of pinned breaking cards — always `stopPropagation` so row link still opens GitHub.
- **Disabled states:**
  - Provider not enabled / no `git_url`
  - Build already in progress for same provider (offer “Attach to build” via existing `foundry_status` reconcile)

### Profile picker (on BUILD click)

**Not** inline chips on every row (too noisy in dense feed).

On click → compact popover / anchored menu:

```
BUILD IN FOUNDRY — GGML
────────────────────────
  ○ VANGUARD   (VS2026 + CUDA 13.2)   ← default from binaryProfileKey
  ○ STABLE     (VS2022 + CUDA 12.8)
  ○ FRESH      (VS2022 + CUDA 13.1)
────────────────────────
  [ CANCEL ]  [ OPEN FOUNDRY → ]
```

- Default highlight = `readStorage(binaryProfileKey(providerId))` or `vanguard`.
- **OPEN FOUNDRY →** calls intent + `openBuildModal` (same as picking a profile).
- Optional: remember last profile per provider in existing `BlackOps-binary-profile:{id}` (already exists — no new key).

For **PR rows:** after profile pick → open Foundry with PR pre-filled.  
For **RELEASE rows:** after profile pick → open Foundry with tag intent (needs backend; see Phase 2).

---

## What already works (no backend for PR)

| Piece | Location |
|-------|----------|
| `openBuildModal(providerId, env)` | `useBuildDock.tsx` |
| PR URL field in confirm form | `FoundryModal.tsx` → `prUrl` |
| PR patch apply | `reactor_foundry.rs` → `parse_pr_input`, GitHub diff |
| Provider ↔ channel mapping | `intel.rs` `channel` = provider `id` |
| PR number from item | `intelUtils.ts` → `extractPrNumber` |

---

## Implementation phases

### Phase 1 — PR builds (ship candidate for next patch)

**Frontend**

1. Extend Foundry context with optional **build intent** (does not change running builds):
   ```ts
   type FoundryBuildIntent = {
     providerId: string;
     environment: Env;
     prUrl?: string | null;
     releaseTag?: string | null;
   };
   ```
2. `openBuildModalWithIntent(intent)` in `useBuildDock.tsx`:
   - Same reconcile/attach logic as `openBuildModal`.
   - Store intent in context; `FoundryModal` reads it on mount/open and sets `prUrl` state.
3. `IntelBuildButton` component (intel-only):
   - Props: `item`, `provider`, `variant: 'pr' | 'release'`.
   - Click → profile popover → `openBuildModalWithIntent`.
   - PR URL: use `item.url` (GitHub PR HTML URL works with existing parser) or `#{number}`.
4. Wire into `IntelWidget.tsx` `IntelRow` for `pr` / `open_pr` / `release` (release button visible but Phase 2 functional).

**Files touched (isolated)**

- `src/hooks/useBuildDock.tsx`
- `src/components/FoundryModal.tsx` (read intent once on open)
- `src/components/IntelWidget.tsx` (+ new `IntelBuildButton.tsx` or colocated)
- `src/index.css` (`.intel-build-btn`, `.intel-profile-picker`)
- `src/lib/intelUtils.ts` (helper: `prUrlFromIntelItem`)

**No changes:** catalog, engine launch, config merge, `intel.rs` fetch logic.

### Phase 2 — Release tag builds

**Backend** (`reactor_foundry.rs`)

- Add optional `release_tag: Option<String>` to build start payload.
- After clone/pull: `git fetch --tags` + `git checkout tags/{tag}` (or commit from release API).
- Validate tag exists; rollback on failure (existing rollback path).

**Frontend**

- Pass `releaseTag` from INTEL item title/tag (releases already in feed).
- Enable `BUILD RELEASE IN FOUNDRY` button functionally.

### Phase 3 — Polish (optional)

- Toast when attaching to in-flight build instead of starting duplicate.
- Badge on INTEL tab when breaking PR > `lastPrPerEnv` (reuse `isBuildBehindBreaking`).
- Persist “don’t ask profile again this session” toggle.

---

## Isolation checklist

- [ ] INTEL remains read-only for config (only invokes Foundry open).
- [ ] New UI scoped to `[data-intel-page]` + Foundry context.
- [ ] No new `localStorage` keys unless profile memory is desired (reuse `binaryProfileKey`).
- [ ] No AGENTS.md banned patterns (`as any`, raw event strings).
- [ ] Feature flag optional: `const INTEL_FOUNDRY_BUILD_ENABLED = true` in component if needed for hotfix disable.

---

## Testing (when implemented)

1. INTEL → PR row → BUILD → pick vanguard → Foundry opens with PR URL filled → confirm → patch fetches.
2. Same provider build already running → BUILD → attaches / warns, no duplicate spawn.
3. IK channel PR → correct provider id (`ik`), not ggml-master.
4. Release row (Phase 2) → checkout correct tag.
5. All themes: button contrast (ARCTIC) — reuse `--theme-accent-bright` like `catalog-scan-btn`.

---

## Out of scope (for now)

- Auto-start build without Foundry confirm forms (two consent points must stay).
- Building from DISC / discussion threads.
- Custom providers without GitHub `git_url`.

---

## Reference

- Intel feed: `src-tauri/src/intel.rs`, `src/components/IntelPage.tsx`
- Foundry entry: `src/hooks/useBuildDock.tsx` → `FoundryModal.tsx`
- Profile storage: `binaryProfileKey()` in `src/lib/storage.ts`