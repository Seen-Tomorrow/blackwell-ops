# Plan: Kill mapper + Add slider ptype + Schema evolution merge

## Problem Statement

The `mapper` ptype in provider config JSON requires a `values_to_cli` array to map user-friendly display values (like `"128k"`) to CLI numeric values (like `"131072"`). When old saved user configs lack this field, the mapping silently fails and passes raw display strings (`--ctx-size 128k`) directly to the CLI. This is a recurring bug every time new structural fields are added.

**Root cause:** The config merge at `config.rs:1004-1008` blindly replaces fresh template params with saved user params, losing any new structural fields that were added since the user's config was last saved.

## Solution Overview

Three changes:
1. **Kill mapper entirely** — remove all hardcoded mapping logic
2. **Add slider ptype** — replace ctx param with a numeric range slider (min/max/step + optional presets)
3. **Schema evolution merge** — self-healing backfill of missing fields from fresh template defaults into saved user configs

---

## Part 1: Remove mapper everywhere

### Files to modify

| File | Change |
|------|--------|
| `src-tauri/src/templates.rs` | Delete `CTX_MAP`, `ctx_to_int_tokens()`, `"mapper"` dispatch case, `inject_mapper_user()` function |
| `src-tauri/src/config.rs:408` | Remove `"mapper"` from `VALID_PTYPES` array |
| `src-tauri/src/config.rs:415` | Remove `\|\| ep.ptype == "mapper"` from `needs_flag` check |
| `src-tauri/src/types.rs:334-335` | Delete `values_to_cli` field entirely (app is private, no migrations needed) |

### Callers of removed function

These call `ctx_to_int_tokens()` — replace with direct `.parse::<usize>()`:

| File:Line | Before | After |
|-----------|--------|-------|
| `src-tauri/src/engine.rs:198` | `ctx_to_int_tokens(&config.get_param_str("ctx").unwrap_or_else(\|\| "32k".to_string()))` | `config.get_param_str("ctx").and_then(\|v\| v.parse::<usize>().ok()).unwrap_or(32768)` |
| `src-tauri/src/engine.rs:560` | `ctx_to_int_tokens(&ctx_size)` | `ctx_size.parse::<usize>().unwrap_or(32768)` (or direct parse) |
| `src-tauri/src/engine_stack.rs:12` | `ctx_to_int_tokens(&ctx_str)` | `ctx_str.parse::<usize>().unwrap_or(32768)` |
| `src-tauri/src/engine_stack.rs:219` | `ctx_to_int_tokens(...)` | Same pattern |

### Frontend cleanup

| File | Change |
|------|--------|
| `src/lib/types.ts:94` | Remove `'mapper'` from ptype union, remove `values_to_cli?: (string \| number)[];` field |
| `src/components/ValueBubbles.tsx:28` | Remove `'mapper'` from ptype prop type |
| `src/services/vram/scenarios/scenarios_factory.ts:43-51` | Replace hardcoded map in `parseCtx()` with direct numeric parse + legacy "k" suffix handling |

---

## Part 2: Add slider ptype

### Provider config JSON change

**File:** `src-tauri/runtime/ggml-master/config/ggml-master-default-config.json`

Replace ctx param (lines 21-31):
```json
{
  "key": "ctx",
  "label": "CTX",
  "flag": "--ctx-size",
  "ptype": "slider",
  "min": 2048,
  "max": 1048576,
  "step": 1024,
  "default": 32768,
  "presets": [8192, 16384, 32768, 65536, 131072, 262144, 524288],
  "ui_group": "CORE",
  "note": "Context window size in tokens."
}
```

Remove `values` and `values_to_cli`. The `presets` field is optional tick marks on the slider track.

### Backend: Add slider dispatch

**File:** `src-tauri/src/templates.rs`

Add to `build_command` match (line 320-335):
```rust
"slider" => Self::inject_slider_user(&mut args, param, &final_value_str),
```

Add inject function:
```rust
fn inject_slider_user(args: &mut Vec<String>, param: &crate::types::UserEditedTemplateParam, value: &str) {
    if let Some(flag) = &param.flag {
        // Slider values are already numeric — pass directly to CLI (same as arg_select)
        args.extend([flag.clone(), value.to_string()]);
    }
}
```

### Backend: Add slider fields to types

**File:** `src-tauri/src/templates.rs` (`ProviderDefaultParam`)
- Add `min`, `max`, `step` fields with serde defaults
- Add `presets` field (optional Vec<Value>)

**File:** `src-tauri/src/types.rs` (`UserEditedTemplateParam`)
- Same fields: `min`, `max`, `step`, `presets`

### Backend: Validation update

**File:** `src-tauri/src/config.rs`
- Add `"slider"` to `VALID_PTYPES`
- Slider needs a flag → add to `needs_flag` check
- Validate slider-specific fields (if min/max/step present)

---

## Part 3: Frontend — New SliderParam component

### File: `src/components/SliderParam.tsx` (new file)

Renders:
- Range input with `min`, `max`, `step` from param definition
- Preset tick marks above slider track (if `presets` defined)
- Numeric text input beside slider for exact value entry
- Display label formatted as `"128K"` / `"1M"` etc.

### File: `src/components/EngineConfigPanel.tsx`

In `renderParamRow` function (line 302):
```tsx
if (def.ptype === 'slider') {
    return <SliderParam ... />;
}
```

---

## Part 4: Schema evolution merge

**File:** `src-tauri/src/config.rs`

New function:
```rust
fn merge_template_into_user_params(
    template_type: &str,
    user_edited: &[UserEditedTemplateParam],
) -> Vec<UserEditedTemplateParam>
```

For each user param matched by key against fresh template defaults, backfill these fields **only if empty/null in user config**:

| Field | Backfill condition |
|-------|-------------------|
| `values_to_cli` | array is empty (deprecated but keep for backward compat) |
| `flag` | None / null |
| `flag_pair` | array is empty |
| `ptype` | equals default `"arg_select"` AND template has different value |
| `values` | array is empty |
| `ui_group` | string is empty |
| `note` | string is empty |
| `pattern` | string is empty |
| `factory_default` | null or empty string |
| `sub_params` | None |
| `dock` | string is empty |

**Also:** If template has new params not in user config → append them. If user has params not in template → keep them (orphaned).

**Preserve (never overwrite):** `default_value`, `hidden`, `hidden_values`, `user_added_values`, `order`.

Replace merge sites at **config.rs:1004-1008** and **1039** with call to this function.

---

## Execution Order

| Step | Task | Files | Risk |
|------|------|-------|------|
| 1 | Write plan document (this file) | `SLIDER_AND_MAPPER_REMOVAL.md` | None |
| 2 | Remove mapper from backend | templates.rs, config.rs, types.rs | Medium — touches CLI path |
| 3 | Update engine.rs + engine_stack.rs callers | engine.rs, engine_stack.rs | Low — simple parse replacement |
| 4 | Add slider ptype to backend | templates.rs (inject), types.rs (fields) | Low |
| 5 | Update provider config JSON | ggml-master-default-config.json | None |
| 6 | Frontend: SliderParam component + render | EngineConfigPanel.tsx, new SliderParam.tsx | Medium — new UI code |
| 7 | Frontend cleanup | ValueBubbles.tsx, types.ts, scenarios_factory.ts | Low |
| 8 | Schema evolution merge function | config.rs | Low — additive |
| 9 | Verify: cargo check + npx tsc --noEmit | All | None |

---

## Key Design Decisions

1. **No migrations needed** — app is still private, so we can just change the config and be done with it.
2. **Slider combines snap + free-range** — slider snaps to step increments by default, but user can type any number in the adjacent text input for precision. Presets show as clickable markers on the track. No toggle needed.
3. **Schema evolution is additive only** — backfill missing fields from fresh template defaults into saved user configs. Never overwrite user edits (default_value, hidden, hidden_values, etc.).
4. **`values_to_cli` removed entirely** — no backward compat needed since app is private.

---

## Verification

After implementation:
1. `cargo check` in src-tauri/ — must compile cleanly
2. `npx tsc --noEmit` in project root — must pass with zero errors
3. Manual test: Launch an engine, verify CLI command shows `--ctx-size 32768` (not `--ctx-size 32k`)
4. Manual test: Change ctx slider to different value, launch again, verify correct numeric value appears in CLI
5. Verify old user configs without `values_to_cli` don't break anything