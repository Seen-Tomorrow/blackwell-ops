# AGENTS.md — Development Notes & Known Fixes

This document tracks critical fixes, architectural decisions, and operational notes for the Blackwell-Ops codebase. It serves as a reference for future development sessions.

---

## 1. Banned Coding Patterns

### `as any` — DO NOT USE

**Status:** BANNED as of 2026-06-04.

**Why:** `as any` bypasses TypeScript's type checking, hiding real bugs and making code harder to maintain. It was used extensively in the codebase (32 occurrences) due to missing type definitions and developer shortcuts.

**What to do instead:**
- Use proper type assertions: `as SomeType` instead of `as any`
- Add missing properties to type definitions
- Use `unknown` with type guards when the type is truly unknown
- Augment `Window` interface for runtime globals (e.g., `__TAURI__`, `__blackopsToasts`)
- Use union types for string literals: `as "4" | "6" | "8" | "all"` instead of `as any`

**Examples:**
```typescript
// BAD
const value = localStorage.getItem(KEY) as any;

// GOOD
const value = localStorage.getItem(KEY) as "4" | "6" | "8" | "all";

// BAD
const payload = event.payload as any;

// GOOD
interface MyPayload { field: string }
const payload = event.payload as MyPayload;
```

**Files affected by cleanup:**
- ConfigPage.tsx (16 casts removed)
- EngineConfigPanel.tsx (3 casts removed)
- ProvidersConfig.tsx (4 casts removed)
- ModelHubSearch.tsx (1 cast removed)
- ModelHub.tsx (1 cast removed)
- BlackwellOutputConsole.tsx (1 cast fixed)
- useModelCatalog.ts (1 cast fixed)
- useFusionData.ts (1 cast fixed)
- FoundryModal.tsx (1 cast fixed)
- Toast.tsx (2 casts fixed)
- R11_DiagnosticOverlay.tsx (1 cast fixed)

### Other Anti-Patterns to Avoid

1. **`any` type** — Same as `as any` — avoid entirely. Use `unknown` with type guards.
2. **`@ts-ignore`** — Suppresses errors without fixing them. Use `@ts-expect-error` with a comment if you must suppress.
3. **Magic strings** — Use enums or string literal types instead of raw strings.
4. **`console.log` in production** — Use proper logging framework or remove.
5. **Hardcoded paths** — Use `config::resolve_path()` for portable path resolution.
6. **`delete obj[key]`** — Use `const { [key]: _, ...rest } = obj;` for type-safe object manipulation.
7. **`setTimeout` without cleanup** — Always clear intervals/timeouts in React useEffect cleanup.

---

## 2. React StrictMode Duplicate Event Listeners (Fixed)

**File:** `src/App.tsx`

**Problem:**
React StrictMode in dev mode causes `useEffect` to mount → unmount → remount. Tauri's `listen()` returns a **Promise**, so the local `unsub` variable is still `null` when cleanup runs on the first unmount — meaning listener #1 never gets removed and listener #2 registers alongside it. Result: every event fires twice, causing duplicate log lines in the UI.

**Why previous attempts failed:**
Using a local `let unsub = null;` inside `useEffect` means cleanup captures `null` because `.then()` hasn't resolved yet. The first listener leaks permanently.

**Fix:**
Declared 7 `useRef<(() => void) | null>` refs at component body level (not inside effects). Each effect stores its unsubscribe function in the ref via `.then()`, and cleanup calls `ref.current?.()`. A `cancelled` flag guards against stale handler invocations after unmount.

```tsx
// Component body — refs survive StrictMode mount/unmount/remount cycle
const unsubEngineLogBatch = useRef<(() => void) | null>(null);

// Inside useEffect
useEffect(() => {
  let cancelled = false;
  listen("engine-log-batch", (e: any) => {
    if (cancelled) return; // guard against stale calls
    // ... handler
  }).then((u) => { if (!cancelled) unsubEngineLogBatch.current = u; });

  return () => { cancelled = true; unsubEngineLogBatch.current?.(); };
}, []);
```

**Affected listeners:** `engine-log-batch`, `engine-system`, `slot-cleared`, `fusion-update`, `gguf-scan-progress`, `gguf-scan-complete`, `stack-changed`.

---

## 2b. Log Pipeline Cleanup (Done)

**File:** `src-tauri/src/log_hub.rs`

**What was removed:**
- **`OutputCategory` enum** (~35 lines) — dead code, never imported externally. `BlackwellOutputConsoleCategory` from `output_console.rs` is the real type used everywhere.
- **Fanout channel** (`fanout_tx`/`fanout_rx`) — created for a planned `PerfMonitor` feature that was never built. Every stderr line did an unnecessary String clone + channel send into an unused receiver. Removed entirely; `spawn_slot_reader` now returns `()` instead of the dead `mpsc::UnboundedReceiver<String>`.
- **Noise suppression** (`is_poll_noise`) — filtered `"done request"` and `"update_slots: all slots are idle"` from batch buffer. Removed per user preference — no filtering, full pipeline transparency.
- **`emit_sanity_log` method + 6 call sites** — emitted `"sanity-log"` event with zero frontend listeners. Replaced with `emit_console_line(category, text, style)` helper that routes to Blackwell Output Console (General/Error tabs).

**What was added:**
- `LogHub::emit_console_line()` — convenience wrapper around `blackwell_output_console_manager.emit_line_to_category()`. Usage: `log_hub.emit_console_line(BlackwellOutputConsoleCategory::General, &msg, BlackwellOutputConsoleLineStyle::Warning)`.

**Pipeline after cleanup (lean):**
```
stderr pipe → spawn_blocking BufReader → mpsc channel → process_lines async loop
                                      ↓
                              readiness check / batch_buffer push / fusion parse / emit
```

**Batching:** Still disabled (`BATCH_INTERVAL_MS = 1`, `MAX_BATCH_SIZE = 1`) until LP performance metrics are finalized.

---

## 3. Binary Update Feature Flag

**File:** `src-tauri/src/binary_update.rs`

**Problem:**
Binary update checks fail with HTTP 403/404 because GitHub releases haven't been uploaded yet. This causes warnings in the Tauri console and may interfere with app startup.

**Fix:**
Added a feature flag at line 12:
```rust
const BINARY_UPDATES_ENABLED: bool = false;
```

When disabled, all three functions return empty/default results immediately:
- `check_binary_updates` → returns `Vec::new()`
- `check_app_update` → returns "not available"
- `get_startup_updates` → returns empty results

**To enable:** Change `BINARY_UPDATES_ENABLED` to `true` when releases are uploaded.

---

## 4. Vite Ignore Patterns for Foundry Build Directory

**File:** `vite.config.ts`

**Problem:**
Vite's file watcher detects tsconfig.json changes inside `src-tauri/target/debug/foundry/engines/ggml-master/llama.cpp/tools/ui/` (Svelte UI from llama.cpp repos), causing full-reload and React restarts during builds.

**Fix:**
Added `server.watch.ignored` patterns:
```typescript
server: {
  host,
  port: 1420,
  watch: {
    ignored: [
      '**/src-tauri/target/**',
      '**/foundry/**',
      '**/llama.cpp/tools/**',
    ],
  },
},
```

This prevents Vite from watching files in the build directory, eliminating tsconfig change detection that causes full-reload.

---

## 5. Architecture Notes

### Foundry Build Process
- **Build environments:** vanguard (VS2026 + CUDA 13.2), stable (VS2022 + CUDA 12.8), fresh (VS2022 + CUDA 13.1)
- **Directory policy (post-2026-04 redesign — see FOUNDRY_DIRECTORY_STRUCTURE_MAP.md):**
  - `engines/<provider>/llama.cpp/` — kept source tree (git operations only)
  - `engines/<provider>/work/` — **DISPOSABLE** (nuked with one remove_dir_all on every build exit + defensively at next build entry)
  - `artifacts/<provider>/<env>/Release/` — **SACRED** (never touched by automatic cleanup; only explicit publish on success or legacy restore)
- **No more build-* inside source, no bin-*-bak created by builds.** The previous sacred artifact is the backup.
- **Cancellation handling:** Build can be cancelled during configure, confirmation, or compilation phases; work/ tree is always cleaned.

### File Permissions (Windows)
- Files created by build process have standard permissions (user has FullControl)
- No special file attributes set by Visual Studio build tools in our codebase
- If files can't be deleted manually, it's typically due to file locking by running processes

---

## 6. Foundry Binary Path System (Post-Refactor)

**File:** `src-tauri/src/reactor_foundry.rs`

### Directory Model (clear naming after refactor)
```
engine_root = foundry/engines/<provider_id>
  src_dir     = engine_root/llama.cpp          ← kept for git reuse, never touched by cleanup
  work_root   = engine_root/work               ← DISPOSABLE, nuked on every exit
    build_dir = work_root/build-{env}        ← ephemeral CMake tree for this attempt

cmake_build_output_dir = build_dir/bin/Release  ← where cmake puts binaries during build
sacred_binary_path     = foundry/artifacts/<provider>/<env>/Release  ← permanent, never nuked
```

### Binary Path Resolution Order (engine_utils::find_provider_binary)
```rust
1. binary_path_per_env[vanguard] → per-env paths from foundry builds or downloads
2. binary_path                  → main path (foundry, download, or manual)
3. First provider's binary_path  → last resort fallback
```

binary_path_per_env — per-environment sacred paths (vanguard/stable/fresh)
binary_path — convenience fallback / display value in UI for custom providers
They're not redundant, they're just both present. The resolution function has a clear priority rule.

### How Each Scenario Sets Paths

**Bundled binaries (from resources):**
- `config.rs::discover_providers()` scans `runtime/<provider>/<env>/llama-server.exe`
- Sets `binary_path_per_env` to `runtime/{}/{}/llama-server.exe`
- Sets `binary_path` to first vanguard path

**Downloaded from git:**
- `binary_update.rs::update_binary()` updates `binary_path_per_env[profile]` with downloaded location
- Tracks `downloaded_version_per_env`

**User-built (foundry):**
- After successful build:
  - `binary_path_per_env[vanguard]` → sacred artifacts path ✅
  - `binary_path` → sacred artifacts path ✅

### Manual Path Override
- User can manually set `binary_path` in config file
- It takes precedence initially on app startup
- **Foundry builds always override both paths** to point to sacred artifacts
- This is by design — sacred artifacts are the source of truth for foundry-built binaries

### Key Variables (reactor_foundry.rs)
| Variable | Purpose |
|---|---|
| `cmake_build_output_dir` | Where cmake puts binaries during build (temp, disposable) |
| `sacred_binary_path` | Permanent artifacts location (never nuked) |
| `validated_binary_dir` | Found during validation step |

### Validation (reactor_foundry.rs lines 1265-1300)
- **Purpose:** After cmake build completes, checks that core binaries (`llama-server.exe`, `llama-cli.exe`, `llama-quantize.exe`) exist in candidate directories
- **Candidate dirs:** `cmake_build_output_dir`, `src_dir/bin/Release`, `src_dir/build/Release`
- If any core binary missing → rollback and fail

### Bug Fix (line 1368)
**Problem:** `binary_path_per_env` was being set to temp build dir path (gets nuked after build).
**Fix:** Now uses `sacred_binary_path` for both `binary_path_per_env` and `binary_path`.

---

## 7. Provider Config System — Three-Layer Model + Template Merge

### Layers

| Layer | File/Location | Persistence | Managed By |
|---|---|---|---|
| **Factory defaults** | `runtime/<provider>/config/<id>-default-config.json` | Bundled in release, read-only at runtime | Admin (you) — edit JSON before shipping |
| **User config** | `config/<id>-user-config.json` | On disk, editable copy of factory + user preferences | User — UI toggles hidden, reorders params, adds custom values |
| **localStorage overrides** | Browser localStorage (`blackops-override-{providerId}`) | Per-session only, disposable | Frontend — tracks which value is "currently selected" in ConfigPage UI |

### Factory defaults JSON structure

Each provider has a default config JSON at `runtime/<id>/config/<id>-default-config.json` containing:
- Top-level identity fields: `id`, `display_name`, `git_url`, `branch`, `template_type`, `build_profile`
- **`templateVersion`** — integer bumped whenever you change the template. Triggers a banner in ConfigPage when it differs from user's saved version. Increment this number before each release that modifies params.
- `params[]` array of `ProviderDefaultParam`:

```jsonc
{
  "key": "kv_quant",
  "label": "KV-QUANT (K+V)",
  "ptype": "arg_select",              // arg_select | slider | switch_onoff | switch_inverted | path_scanner | logic_only | arg_select_double
  "flag": "--cache-type-k",           // null for logic_only
  "values": ["q4_0", "q8_0", "f16"],
  "default": "q4_0",                 // current factory default value
  "step": null,                      // slider step increment (only for ptype="slider")
  "ui_group": "CORE",
  "note": "KV cache data type...",
  "pattern": "",                     // file scan pattern for path_scanner
  "sub_params": {},                  // extra CLI flags per selected value
  "dock": "",                        // dock key for grouped rendering above PARAMETERS
  "hidden_default": false            // excluded from catalog by default if true
}
```

**template_type mapping:** `"ggml-llama"` → `runtime/ggml-master/`, `"ik-llama"` → `runtime/ik/`, empty string → custom (no template).

### Merge: `merge_template_into_user_params` (`config.rs`)

Runs on every app load when loading providers. Takes fresh factory template + saved user config and produces merged result. **Merge philosophy:** aggressively sync structural fields from factory, preserve purely cosmetic user choices.

| Field | Behavior | Rationale |
|---|---|---|
| **values** | Keep existing user values + userAddedValues, **append any new values from template** not already present. Never remove. | User's custom additions survive; new factory options get added automatically |
| **defaultValue** | If current default exists in merged values array → keep. If orphaned (not in array) → force reset to new factory default | Prevents stale defaults crashing binary at runtime |
| **factoryDefault** | Always sync from fresh template's `default` | Keeps green/yellow bubble styling correct after updates |
| **label, key** | Sync from template | Admin can rename params without requiring full user reset |
| **ptype** | Only backfill if still default `"arg_select"`. If admin deliberately changed it → don't overwrite. | Ptype change is deliberate |
| **flag, step, dock, pattern, sub_params** | Backfill only if empty/missing in user config | Fill on first run, preserve after set |
| **note, ui_group** | Backfill only if empty | Admin may customize these |
| **hidden** | Never touch ✅ | User UI preference |
| **order** | Kept for existing params. New params appended at end. ✅ | User UI preference |
| **userAddedValues** | Never touch ✅ | Pure user addition via ValueBubbles "+ add" input |
| **hidden_values** | Never touch ✅ | Pure user choice |

Orphaned params (in user config but removed from template) are kept alive — no silent deletion. Admin can remove them via UI or hit RESET TO DEFAULTS.

### Template version tracking

1. Admin bumps `templateVersion` number in default config JSON before release
2. On app load, `build_config_with_providers_full` compares factory's `template_version` against user meta's saved `template_version`
3. If mismatch: sets `needs_template_attention = true` on the loaded provider
4. Frontend (ConfigPage.tsx) shows a yellow warning banner with RESET NOW button when flag is true
5. After next save, the factory version syncs to disk → banner disappears automatically

**`needs_template_attention` has `#[serde(skip_serializing)]`** — it's computed at load time and never persisted.

### Factory Reset: `reset_provider_user_config`

Rust command that deletes `{id}-user-config.json` entirely. Frontend calls via IPC then dispatches `"blackops-reload-providers"` for instant refresh. On reload, provider regenerates 1:1 from factory defaults — guaranteed correct state. This is the user's escape hatch when config drift causes issues.

### Override system (localStorage)

ConfigPage stores "which value is currently picked" in localStorage (`blackops-override-{providerId}`). The `setOverride` function merges into existing overrides so multiple params can have simultaneous selections. Each param row passes its override handler and a clear handler to ValueBubbles:
- Clicking a bubble calls `setOverride(key, value)` — stores selection for that param
- Clicking × on an orphaned override chip calls `clearOverride(key)` — deletes just that key from localStorage

Slider ptype suppresses the "override chip" display entirely because any numeric value between min/max is expected behavior.

### Removed features (no longer exist)

**TEMPLATE UPDATE button / modal** — removed. Merge happens silently on every load. No manual sync needed.
**VALIDATE button / handler** — removed. Validation runs inline during save_provider as a block-guard. The old `check_template_update` / `apply_template_update` Rust commands are deleted.

---

## 8. Foundry Build Flow (reactor_foundry.rs)
```
cmake build → validation → publish to sacred artifacts → update config → nuke work/
```

### Validation Step (lines 1265-1300)
- Checks `llama-server.exe`, `llama-cli.exe`, `llama-quantize.exe` exist in candidate dirs
- If found, sets `validated_binary_dir`
- If missing, rollback and fail

### Publish to Sacred Artifacts (line 1342)
```rust
sacred_binary_path = publish_artifacts_to_sacred(&provider_id, env, &build_dir, &src_dir).await?;
```

### Config Update (lines 1365-1376)
- `binary_path_per_env[vanguard]` → sacred artifacts path ✅
- `binary_path` → sacred artifacts path ✅

### Work Directory Cleanup (line 1408)
```rust
let work_root = crate::config::foundry_work_dir(&provider_id);
let _ = tokio::fs::remove_dir_all(&work_root).await;
```

---

## 9. Portability Design

The app is designed as portable:
- **App root** = directory containing the main exe (DEV: `target/debug/`, REL: wherever user installed)
- All paths are relative to app root
- `config::resolve_path()` converts relative → absolute against app_root
- `config::to_relative_path()` converts absolute → relative from app_root

### Path Resolution Examples
```
relative: "foundry/artifacts/ggml-master/vanguard/Release/llama-server.exe"
absolute: C:\Users\GHOST-TOWER\INFRA\blackwell-ops\src-tauri\target\debug\foundry\artifacts\ggml-master\vanguard\Release\llama-server.exe
```

---

## 10. Mirror DEV to REL Workflow

### Purpose
Mirror fresh foundry-built artifacts from DEV build directory into `runtime/` so they are bundled in the NSIS release installer.

### Script: `scripts/mirror-artifacts.ps1`
- **Source:** `src-tauri/target/debug/foundry/artifacts/<provider>/<env>/Release/`
- **Destination:** `src-tauri/runtime/<provider>/<env>/`
- Clears stale binaries from destination profile dir before copying
- Preserves `runtime/<provider>/config/` (default configs, cmake flags)
- Skips `.prev` backup directories

### How it runs
```powershell
# Manual run:
.\scripts\mirror-artifacts.ps1

# Automatic via npm:
npm run release  # triggers prerelease hook → mirror-artifacts.ps1 → tauri build
```

### What gets mirrored
| Source | Destination |
|---|---|
| `foundry/artifacts/<provider>/<env>/Release/*` (exe, dll) | `runtime/<provider>/<env>/` |

### What does NOT get mirrored
- `runtime/<provider>/config/` — default configs stay in place, edited manually by developer
- `.prev` backup directories

### NSIS compression
Set to `"off"` in `tauri.conf.json` under `plugins.nsis.compression`. 

### Developer workflow
1. Build providers via foundry (artifacts land in `foundry/artifacts/`)
2. Edit `runtime/<provider>/config/*.json` if cmake flags or params change
3. Run `npm run release` — mirrors artifacts, bundles everything into NSIS installer

---

## 11. Framer-Motion Cleanup (Done)

Framer-motion has been fully removed from all components. All animations migrated to pure CSS keyframes and transitions in `index.css`.


### Reference
See `FUSION-metrics.md` for complete field table.
