# AGENTS.md — Development Notes & Known Fixes

This document tracks critical fixes, architectural decisions, and operational notes for the Blackwell-Ops codebase. It serves as a reference for future development sessions.


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
