

# Template Merge Overhaul + Config Cleanup Plan

## Goal
Make provider config merging resilient to template updates, remove dead features (Template Update / Validate buttons), and fix override system bugs — all while keeping user-added values alive until they choose RESET TO DEFAULTS.

---

## A) Philosophy

**Three layers:**
1. **Factory defaults** (`runtime/<provider>/config/*.json`) — immutable source of truth, managed by admin only
2. **User config** (`{id}-user-config.json`) — disposable copy with user UI preferences on top (hidden, order, custom values)
3. **localStorage overrides** — per-session selection state in ConfigPage, disposable

**Merge rule:** We add, we never remove user values, we only force-reset `defaultValue` when orphaned. User's escape hatch is RESET TO DEFAULTS which deletes user config and regenerates from factory 1:1.

---

## B) Changes to Make

### 1. `merge_template_into_user_params` — Overhaul in `config.rs` (~line 972-1078)

**Current behavior:** Backfill only empty fields, append new params.
**New behavior:**

| Field | Current | New | Rationale |
|---|---|---|---|
| `values` | Only backfill if empty | Merge: keep existing + userAddedValues, **append any NEW values from template not already present**. Don't remove anything. | User's custom additions survive; new template options get added automatically |
| `defaultValue` | Never touched | If current value exists in merged (template + userAdded) array → keep. If NOT → force reset to new factory default. | Prevents orphaned defaults that crash the binary at runtime |
| `factoryDefault` | Set on param creation, never updated | Always sync from fresh template's `.default` | Keeps green/yellow bubble styling correct after updates |
| `label`, `key` | Never touched | Sync from template (structural truth) | Admin can rename/adjust labels without requiring full reset |
| `ptype` | Only backfill if still "arg_select" | Keep current — only backfill if empty/default. If admin changed it to something specific, don't overwrite. | Ptype change is deliberate user choice |
| `flag`, `step`, `dock`, `pattern`, `sub_params` | Backfill if empty | Keep current behavior | Structural fields fill on first run |
| `note`, `ui_group` | Backfill if empty | Keep current behavior | Admin may customize these |
| `hidden` | Never touched ✓ | Never touch ✓ | User UI preference |
| `order` | Kept for existing, auto for new ✓ | Keep: user ordering preserved. New params appended at end. ✓ | User UI preference |
| `userAddedValues` | Never touched ✓ | Never touch ✓ | Pure admin addition |
| `hidden_values` | Never touched ✓ | Never touch ✓ | Pure admin choice |

**Orphaned params (in user config but removed from template):** Keep alive until admin removes via UI or hits reset. No silent deletion.

---

### 2. Factory Reset — New Rust Command + Instant Frontend Update

**Rust side (`config.rs`, new function):**
```rust
#[tauri::command]
async fn reset_provider_template(provider_id: String) -> Result<(), String> {
    let user_config_path = resolve_path(&format!("config/{}-user-config.json", provider_id));
    if tokio::fs::metadata(&user_config_path).await.is_ok() {
        tokio::fs::remove_file(&user_config_path).await?;
    }
    // Reload providers from disk — regenerates fresh copy on next load
    Ok(())
}
```

**Frontend side (`ConfigPage.tsx`, replace `confirmReset` at ~line 237):**
- Remove the current multi-step dance (get template, map params, save_provider, etc.)
- Replace with single IPC call: `invoke("reset_provider_template", { providerId })`
- Then dispatch `"blackops-reload-providers"` to trigger instant refresh
- App.tsx listener at line 194 will reload all providers from backend → ConfigPage re-renders with fresh state

**Why this works:** Deleting the user config file means `build_config_with_providers_full` falls through to `discover_providers()` which loads fresh defaults and creates a pristine `{id}-user-config.json` on next save. The `"blackops-reload-providers"` event forces frontend to re-fetch immediately, no reload needed.

---

### 3. Template Version Tracking + Banner Notification

**Rust side:**
- Add `template_version: u32 = 1` field to provider default JSON configs (e.g., `ggml-master-default-config.json`)
- Add corresponding field to `ProviderConfig` struct in Rust
- On merge, compare template's version vs user config's saved version
- If mismatch, set a flag on the returned provider: `needs_template_attention: bool`

**Frontend side:**
- In ConfigPage.tsx, check `currentProvider.needs_template_attention`
- If true, show a dismissible banner at top of the config panel:
  > ⚠️ Factory template updated. Your saved settings are preserved, but if engines fail to launch after an update, try **RESET TO DEFAULTS**.
- Banner dismisses on click and stores dismissed version in localStorage so it doesn't reappear for same version

**Admin workflow:** Increment `template_version` in the default config JSON whenever they make template changes. No code deploy needed — just a number bump.

---

### 4. Remove Template Update + Validate Buttons

Remove from ConfigPage.tsx:
- **TEMPLATE UPDATE button** and all associated state/handlers (~line 278-360): `handleCheckUpdate`, `confirmApplyUpdate`, `showUpdateModal`, `templateDiff`, `selectedNewParams`, `selectedOrphanedParams`
- **VALIDATE button** and handler (~line 296-315): `handleValidate`
- Any related imports (modal components, diff types)
- The Rust commands these call can be removed from backend too: `check_template_update`, `apply_template_update`, `validate_user_providers_meta`

This simplifies ConfigPage significantly and removes dead code paths. Merge happens silently on load now — no admin action needed for template syncs.

---

### 5. ValueBubbles — Suppress Override Bubble for Slider

**File:** `ValueBubbles.tsx`, lines 261-270

Add condition: skip rendering the yellow override chip when `ptype === 'slider'`. A slider value between min/max is expected behavior, not an "override."

Also fix the broken × button (line 266) — it currently calls `onOverrideChange(currentValue)` which just resaves the same value. Wire up to a new `onClearOverride` prop that actually removes the override.

---

### 6. ConfigPage — Fix setOverride Merge Bug + Add Clear Override

**File:** `ConfigPage.tsx`, line 231

Current:
```typescript
localStorage.setItem(key, JSON.stringify({ [defKey]: value }))
// Overwrites ALL overrides with single key!
```

New:
```typescript
const stored = localStorage.getItem(overridesKey(selectedProviderId));
const existing = stored ? JSON.parse(stored) : {};
localStorage.setItem(key, JSON.stringify({ ...existing, [defKey]: value }));
```

**Add `clearOverride` handler:**
```typescript
const clearOverride = useCallback((defKey: string) => {
  const stored = localStorage.getItem(overridesKey(selectedProviderId));
  if (stored) {
    const existing: Record<string, any> = JSON.parse(stored);
    delete existing[defKey];
    localStorage.setItem(overridesKey(selectedProviderId), JSON.stringify(existing));
  }
  setUserOverrides(prev => { const n = { ...prev }; delete n[defKey]; return n; });
  window.dispatchEvent(new CustomEvent("param-config-changed"));
}, [selectedProviderId]);
```

Pass to ValueBubbles as `onClearOverride={() => clearOverride(def.key)}`.

---

## C) Files Modified (Summary)

| File | Changes |
|---|---|
| `src-tauri/src/config.rs` | Rewrite `merge_template_into_user_params`; add `reset_provider_template` command; remove `check_template_update`, `apply_template_update`, `validate_user_providers_meta`; add `template_version` field handling & `needs_template_attention` flag |
| `src-tauri/src/types.rs` | Add `template_version: u32 = 1` to `ProviderConfig`; add `needs_template_attention: bool = false` to `ProviderConfig` |
| `src-tauri/runtime/*/config/*-default-config.json` | Add `"templateVersion": 1` field to each provider's default config JSON |
| `src/components/ConfigPage.tsx` | Replace `confirmReset` with single IPC call; add template update banner + dismiss logic; remove Template Update modal/buttons/state (~80 lines of dead code); remove Validate button/handler; fix `setOverride` merge bug; add `clearOverride` handler |
| `src/components/ValueBubbles.tsx` | Suppress override bubble for slider ptype; fix broken × button with new `onClearOverride` prop |
| `src/lib/types.ts` | Add `templateVersion`, `needsTemplateAttention` to `ProviderConfig` interface |

---

## D) Implementation Order

1. **Types** — add fields to Rust `types.rs` and frontend `types.ts` (no behavior change)
2. **Rust merge rewrite** — `config.rs:972-1078`, new logic with aggressive sync + orphaned default reset
3. **Factory reset command** — `reset_provider_template` in Rust, update frontend handler
4. **Template version tracking** — field in config JSONs, comparison logic in merge, banner in ConfigPage
5. **Remove Template Update / Validate** — delete buttons, handlers, state, and backend commands
6. **ValueBubbles slider fix + setOverride merge fix** — smallest changes, lowest risk

## E) Verification Checklist

- [ ] Fresh provider loads with factory defaults (no user config exists yet)
- [ ] Existing user config merges: new values appended, old values retained, orphaned default reset to factory
- [ ] `factoryDefault` syncs on merge so bubble styling is correct
- [ ] RESET TO DEFAULTS deletes user config and instantly reloads fresh state
- [ ] Template update banner appears when version mismatch, dismisses once
- [ ] Template Update / Validate buttons gone from UI, no console errors
- [ ] Slider custom values don't show override bubble in ValueBubbles
- [ ] Setting one param's override doesn't destroy another param's override
- [ ] × button on override chip actually clears the override
