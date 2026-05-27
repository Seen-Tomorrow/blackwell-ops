# AGENTS.md — Development Notes & Known Fixes

This document tracks critical fixes, architectural decisions, and operational notes for the Blackwell-Ops codebase. It serves as a reference for future development sessions.

---

## 1. React setState Anti-Pattern Fix

**File:** `src/hooks/useBuildDock.tsx` (lines 78-88)

**Problem:**
Calling `setState` on another component (`DockProvider`) while rendering a different component (`FoundryProvider`). This violates React's rules and causes the error:
```
Cannot update a component (`DockProvider`) while rendering a different component (`FoundryProvider`)
```

**Root Cause:**
Nested setState calls inside a functional updater for `setFoundryModal`:
```typescript
setFoundryModal(prev => {
  setBuildProgress(null);      // ← setState inside setState!
  clearSlot(DOCK_SLOT_BUILD);  // ← updating DockProvider while rendering FoundryProvider!
  return { providerId, environment };
});
```

**Fix:**
Move all side effects out of the `setFoundryModal` functional updater:
```typescript
const openBuildModal = useCallback((providerId: string, environment: Env) => {
    closedRef.current = false;
    clearSlot(DOCK_SLOT_BUILD);
    setBuildProgress(null);
    setFoundryModal(prev => { /* no nested setState */ });
    setFoundryModalVisible(true);
}, [clearSlot]);
```

---

## 2. Foundry Build Cleanup Fixes

**File:** `src-tauri/src/reactor_foundry.rs`

### 2a. Pre-build cleanup (lines 618-633)
Added Rust-level cleanup to remove ALL `build-*` directories from the source tree before each new build:
```rust
if src_dir.exists() {
    let entries = std::fs::read_dir(&src_dir);
    if let Ok(entries) = entries {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name.starts_with("build-") {
                    log::info!("[foundry] Removing old build directory: {}", path.display());
                    let _ = tokio::fs::remove_dir_all(&path).await;
                }
            }
        }
    }
}
```

**Why:** The batch script's `rmdir /s /q` runs silently behind `@echo off` and fails when files are locked. Rust-level cleanup ensures proper deletion.

### 2b. Validation failure cleanup fix (line 1302)
Fixed incorrect directory path from `"build"` to `format!("build-{}", env.env_label())`.

### 2c. Cancellation during build phase cleanup (lines 1203-1205)
Added build directory removal when user cancels mid-build.

### 2d. Post-build cancellation check cleanup (lines 1230-1232)
Added build directory removal after successful compilation if cancelled.

### 2e. Minimize / Visibility Recovery for WaitingForConfirm Builds (2026)
**File:** `src/hooks/useBuildDock.tsx` (FoundryProvider), with small callers in Layout.tsx + FoundryPage.tsx

**Problem:**
When a build reached the "PAUSED — REVIEW CMAKE..." prompt (backend `WaitingForConfirm`), using the in-app MINIMIZE TO STATUS BAR (or OS window minimize/maximize) could cause the status-bar dock widget (`DOCK_SLOT_BUILD`) to vanish while `CURRENT_BUILD` was still live on the Rust side. `FoundryPage` would show the row as "BUILDING..." (disabled) with no way to reach the PROCEED/REJECT controls because the only entry point (dock click → restore modal) was gone. Root cause: control state (buildProgress + modal + dock registration) was purely ephemeral event-driven; the `WaitingForConfirm` backend phase emits only a single progress event then goes silent. No reconciliation against `foundry_status`.

**Fix:**
Added `rehydrateFromStatus()` (calling the existing `foundry_status` command) + mount + `visibilitychange` listener inside `FoundryProvider`. It seeds `buildProgress`/`foundryModal`, forces the dock registration via `updateDock`, and for `waiting-confirm` forces the modal visible so the paused UI is reachable. Also exported `attachToActiveBuild()` (exposed on the context) and wired:
- Automatic call on mount, visibility restore, `restoreBuildModal`, and the dock sync effect (instead of blind clear).
- A visible "RESTORE BUILD CONTROLS" recovery banner + button on FoundryPage when desync is detected.
- Defensive call in Layout dock click handler.

The event-driven path remains primary for live updates; status reconciliation is the safety net that prevents permanent loss of the control surface for paused builds after minimize + visibility cycles (including HMR scenarios).

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
- **Build directories:** `build-vanguard`, `build-stable`, `build-fresh` inside each provider's llama.cpp source
- **Backup strategy:** Previous binaries backed up to `bin-{env}-bak/` before building new ones
- **Cancellation handling:** Build can be cancelled during configure, confirmation, or compilation phases

### File Permissions (Windows)
- Files created by build process have standard permissions (user has FullControl)
- No special file attributes set by Visual Studio build tools in our codebase
- If files can't be deleted manually, it's typically due to file locking by running processes

### HMR/Hot Reload Issues
- The `useBuildDock` export may cause HMR invalidation warnings (Vite React plugin expects consistent exports)
- This is a separate issue from the binary update / Vite watcher problems