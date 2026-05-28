# Foundry Build System — Deep Review & Stabilization Plan

**Status:** Active Planning Document (April 2026)  
**Purpose:** This is a self-contained, high-signal document designed so that a brand-new Grok session can load it and immediately understand the full current state, problems, and required work without needing the entire conversation history.

---

## 1. Executive Summary & Current State

The Foundry system (custom building of llama.cpp providers) has undergone major refactoring:

- Introduction of a reducer-based state machine in the frontend (`useBuildDock.tsx`).
- Split of the monolithic modal into `FoundryConfirmForm` + `FoundryBuildProgress`.
- Creation of the **Blackwell Output Console** (also referred to as Universal Output Receiver / UOR) as a power-user tabbed output system.
- Multiple attempts to fix logging, memory usage, and build directory cleanup.

**Current problems reported by the user after real testing:**

1. The React build modal (`FoundryBuildProgress`) still receives and holds the full verbose build log, leading to very high memory usage (1.7 GB observed). It does not release memory when the build ends.
2. The new Blackwell Output Console currently only receives high-level stage messages. It does **not** yet receive the actual cmake / compilation output (the user wants a proper ~200 line sliding window fed from Rust).
3. `build-{profile}` directories (`build-vanguard`, `build-stable`, `build-fresh`) are still being deleted in some paths, even after attempted fixes. These directories must be preserved.
4. Orphaned `Msbuild.exe` + `ConsoleHost` processes are left behind after builds.
5. `FoundryPage` remains stuck showing "building" after the modal closes or the build ends.

The user has requested a **full, accurate map** of the current directory structure and every place that touches `build-*` or `bin-*` directories **before** further large code changes.

---

## 2. Core Requirements & Policy (User's Stated Intent)

From recent messages, the user’s explicit policy for Foundry builds is:

- The three profile directories (`build-vanguard`, `build-stable`, `build-fresh`) **must be preserved**. These represent the built state for each profile and allow the user to switch between them at runtime.
- Only temporary build artifacts should be cleaned.
- Cleanup should preferably happen at the **end** of a build (both success and failure paths), not aggressively at the start.
- Each profile should be backed up (`bin-{profile}-bak`) before a new build for that profile begins.
- The source tree (`llama.cpp` folder) is updated via git and should generally be left alone.

Any code that deletes or risks deleting one of the three official `build-{profile}` directories without explicit user intent to rebuild that specific profile is considered incorrect.

---

## 3. Current Directory Structure (as of latest code inspection)

### Primary Paths (per provider)

- `work_dir` = `foundry_dir(provider_id)`  
  Example: `.../foundry/my-provider`

- `src_dir` = `work_dir / "llama.cpp"`  
  This is the actual llama.cpp source clone for that provider.

- For each environment:
  - `build_dir` = `src_dir / "build-{env_label}"`  
    Examples:
    - `build-vanguard`
    - `build-stable`
    - `build-fresh`

- Final build output location (before being copied elsewhere):
  - `bin_release` = `build_dir / "bin" / "Release"`

- Backup location (created before a new build of that profile):
  - `bin_bak` = `work_dir / "bin-{env_label}-bak"`

### Other Notable Paths

- Old single "build" directory (legacy):
  - `src_dir / "build"` — there is migration logic that moves this to `build-vanguard` if detected.

- Per-profile binary destination (updated in the provider config):
  - Stored in `binaryPathPerEnv[env_label]` in the saved provider JSON.

- Rollback targets during failure:
  - The `rollback_build` helper knows how to restore from `bin_bak` back into `bin_release`.

---

## 4. Every Place That Touches `build-*` or `bin-*` Directories

Below is an exhaustive list (based on current code inspection) of locations that create, rename, or delete these directories. Line numbers are approximate and may shift slightly with edits.

### 4.1 Creation / Setup

- `foundry_build()` (around line 640+)
  - Creates `work_dir`, `src_dir`, `build_dir`, `bin_release`, `bin_bak` paths.

### 4.2 Pre-build / During Build Cleanup

- Lines ~651–666 (pre-build section):
  - Currently contains logic that iterates and can delete directories starting with `build-`.
  - **This section has been the source of repeated violations** of the user's "never touch the three profile dirs" rule.

- Various early failure paths inside `foundry_build()`:
  - Multiple calls to `rollback_build(...)` which can trigger directory operations.

### 4.3 During Git Operations

- Clone failure → rollback (line ~698)
- Pull / submodule failure → rollback (lines ~723–724)

### 4.4 Post-Configure / Pre-Compilation

- WaitingForConfirm cancellation path (around line 1142):
  - `remove_dir_all(&build_dir)`

### 4.5 During Compilation / Validation Failures

- Several points in the build phase (around lines 1232, 1247, 1259, 1332):
  - `remove_dir_all(&build_dir)` on various error conditions.

### 4.6 Success Path

- End of `foundry_build()` (around line 1429 in recent versions):
  - Previously contained `remove_dir_all(&build_dir)` after success (this has been partially removed in later edits, but must be verified).

### 4.7 Cancel Path

- `foundry_cancel()` (around line 1438+):
  - Kills children.
  - May trigger rollback which touches `bin_release` / `bin_bak`.

### 4.8 Restore Path

- `foundry_restore()` (around line 1627+):
  - Works with `bin_bak` and `bin_release`.
  - Deletes current `bin_release` before restoring from backup (line ~1638).
  - This is **intentional** per the backup/restore design.

### 4.9 Rollback Helper

- `Rollback` struct and `do_rollback()` (around lines 1701–1764):
  - Restores from `bin_bak` into `bin_release` by deleting current release and renaming backup.
  - Used in many error paths.

### 4.10 Legacy Migration

- Around line 1523–1533:
  - Detects old `src_dir / "build"` directory.
  - Renames it to `build-vanguard` if appropriate.
  - This is one-time migration logic.

---

## 5. Current Problems with the Above Logic (Honest Assessment)

- The pre-build loop that deletes any directory starting with `build-` is fundamentally at odds with keeping three persistent profile directories.
- There are multiple independent `remove_dir_all(&build_dir)` calls scattered across error and cancel paths. These delete the entire profile build tree on any failure.
- There is no single, clear "post-build cleanup" function with an explicit policy. Cleanup is scattered and opportunistic.
- The success path has historically also contained deletion of the just-built tree (this is being actively removed in recent edits).
- Process killing (`kill_all_children()`) is not reliably cleaning up the full msbuild tree, leading to locked files and orphaned processes when deletion is later attempted.

---

## 6. The 5 Points the User Wants Addressed

(From recent conversation — numbered as user referenced them)

1. **Log buffer size** — User is happy with ~200 lines as a sliding window in the console.
2. **Modal vs Console responsibility** — Modal should stop being the primary full-log holder.
3. **Directory policy** — `build-{profile}` directories must be preserved. Only artifacts cleaned, preferably at end of build.
4. **Process cleanup** — User is unsure aggressive tree-killing is always necessary if the build completes naturally. Needs investigation.
5. **Frontend state synchronization** — `FoundryPage` must not get stuck in "building" after a build ends.

---

## 7. Recommended Phased Approach Going Forward

**Phase 0 (Immediate — No large refactors yet)**
- Produce this document (done).
- Produce a clean, visual directory structure diagram + annotated list of every touch point (can be an appendix or separate file).

**Phase 1: Policy Enforcement & Safety**
- Remove or heavily restrict the pre-build deletion of `build-*` directories.
- Ensure `build-vanguard`, `build-stable`, and `build-fresh` are never deleted except when the user explicitly starts a rebuild for that specific profile (with backup).
- Centralize post-build artifact cleanup with clear rules.

**Phase 2: Logging Architecture**
- Route actual verbose build output into the `BlackwellOutputConsoleManager` (real sliding window).
- Stop (or severely limit) the modal from accumulating the full log.
- Make the console the primary place power users go for detailed output.

**Phase 3: Lifecycle & Process Hygiene**
- Improve (or decide against) aggressive child process tree killing.
- Guarantee that every exit path from a build emits a clear terminal state so the frontend can update correctly.

**Phase 4: Console UI & Real Window**
- Implement proper 1-line docked → 3-line peek → full separate OS window behavior.
- Address drag selection, refresh flicker, and close button spacing.

**Phase 5: Documentation & Testing**
- Update AGENTS.md with the final directory policy.
- Define test cases for multi-profile coexistence, memory behavior, and state correctness.

---

## 8. Notes for Future Sessions

- This document is intentionally written to be largely self-contained.
- The most important single artifact for any new session is **Section 3 and 4** (the directory structure and every touch point).
- Before making changes to cleanup logic, always cross-reference the current list of `remove_dir_all` sites.
- The user's non-negotiable rule is: **the three `build-{profile}` directories must survive** unless the user is explicitly rebuilding that specific profile.

---

**End of Plan Document**

This file (plus the directory map appendix when produced) should give a new session enough context to continue the deep review and stabilization work without needing the entire previous conversation history.