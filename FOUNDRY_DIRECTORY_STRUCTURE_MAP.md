# FOUNDRY_DIRECTORY_STRUCTURE_MAP.md

**Purpose:** This is the single authoritative, standalone reference document for the entire Foundry build directory and cleanup system.  
**Date:** April 2026 (post major refactor)  
**Status:** **IMPLEMENTED** (core directory redesign + publish + nuke discipline + batch simplification landed; see implementation plan and git history for the exact diff).

**Intended Audience:** Any future Grok session or developer who needs to understand or change how builds create, move, or delete directories — without reading hundreds of lines of chat history.

> **Current State section below now describes the historical (pre-redesign) layout for reference.**  
> New sessions should treat Sections 5 (Approved Future Layout), 6 (Policy), and 8 (Verification Checklist) as the live contract. The code in `reactor_foundry.rs` + `config.rs` now follows the "work/ disposable, artifacts/ sacred" rule.

A brand-new session should be able to open **only this file + AGENTS.md** and immediately have a correct mental model of the current mess, the policy, and the approved future direction.

---

## 1. One-Sentence Policy (Memorize This)

> **"Everything under `foundry/engines/<provider>/work/` (or any `build-*` tree inside the source) is disposable and may be deleted at the end of any build. Everything that ends up in `foundry/artifacts/<provider>/<profile>/Release/` is sacred and must never be touched by automatic cleanup."**

The current code does **not** yet follow this clean rule. That is the root cause of the "my head spins" problem.

---

## 2. Current State — Directory Layout (What Actually Exists Today)

### High-Level Tree (per provider)

```
<app_root>/foundry/engines/<provider_id>/          ← work_dir = crate::config::foundry_dir(provider_id)
├── llama.cpp/                                     ← src_dir (the git repo)
│   ├── .git/
│   ├── CMakeLists.txt
│   ├── ... (full llama.cpp + submodules)
│   │
│   ├── build-vanguard/                            ← One of the three "sacred" profile trees
│   │   └── bin/
│   │       └── Release/
│   │           ├── llama-server.exe               ← Final blessed binary for vanguard profile
│   │           ├── llama-cli.exe
│   │           └── ...
│   │
│   ├── build-stable/                              ← Sacred profile tree #2
│   │   └── bin/Release/...
│   │
│   ├── build-fresh/                               ← Sacred profile tree #3
│   │   └── bin/Release/...
│   │
│   └── build/                                     ← Legacy single "build" dir (migration logic still exists)
│
├── bin-vanguard-bak/                              ← Backup created before a new vanguard build (rename dance)
├── bin-stable-bak/
├── bin-fresh-bak/
│
└── (various _build_*.bat scripts written during builds)
```

### Key Path Construction (Exact Code)

All paths originate from two functions:

- `config.rs:35`
  ```rust
  pub fn foundry_dir(provider_id: &str) -> PathBuf {
      app_root_dir().join("foundry").join("engines").join(provider_id)
  }
  ```

- `reactor_foundry.rs:267-269`
  ```rust
  fn foundry_src_dir(provider_id: &str) -> PathBuf {
      crate::config::foundry_dir(provider_id).join("llama.cpp")
  }
  ```

Inside `foundry_build()` (reactor_foundry.rs:640-644):

```rust
let work_dir    = crate::config::foundry_dir(&provider_id);
let src_dir     = work_dir.join("llama.cpp");
let build_dir   = src_dir.join(format!("build-{}", env.env_label()));   // "build-stable" etc.
let bin_release = build_dir.join("bin").join("Release");
let bin_bak     = work_dir.join(format!("bin-{}-bak", env.env_label()));
```

The three profile directories (`build-vanguard`, `build-stable`, `build-fresh`) live **inside the source tree** and are simultaneously:
- The working directory for CMake (`-B build-stable`)
- The final resting place of the Release binaries for that profile

This dual role is the source of almost all the complexity and accidental deletion bugs.

---

## 3. Every Single Place That Touches build-*/bin-*/Release (Exhaustive Map)

This list was produced by direct code inspection (April 2026). Line numbers are from the current `reactor_foundry.rs` at the time of writing.

### 3.1 Creation / Setup

| Location | Action | Line(s) | Notes |
|----------|--------|---------|-------|
| `foundry_build()` entry | `create_dir_all(work_dir)` | 646 | Creates the per-provider engine root |
| Git clone | `git clone ... <src_dir>` | 684-689 | Only when `.git` does not exist |
| Batch script (configure phase) | `mkdir <env_build_name>` inside src_dir | 387 (in `build_isolated_batch_script`) | `if fresh { mkdir build-stable }` |
| CMake itself | Creates the full `build-*/...` tree | N/A (external) | Triggered by the generated `_build_cfg.bat` |

### 3.2 Pre-build / During-Build "Cleanup" (Highest Risk Area)

| Location | Action | Line(s) | Danger Level |
|----------|--------|---------|--------------|
| Historical pre-build loop (commented intent but previously active) | `for entry in src_dir { if name.starts_with("build-") { remove_dir_all } }` | ~651-679 (old versions) | **CRITICAL** — this is the code that repeatedly deleted sibling profiles in real testing |
| Current code still contains defensive comments but no blanket loop | (see comments at 652-658) | 652-658 | The comments claim the right policy; the implementation has not always matched |
| `src_dir` removal on fresh clone | `remove_dir_all(&src_dir)` if no `.git` | 681 | Correct for first-time clone, but dangerous if ever called on existing tree |
| Batch script (configure) | `if exist build-xxx rmdir /s /q build-xxx` | 386 | Runs under `@echo off` — silent failures common on Windows when files are locked |

### 3.3 Cancellation & Failure Paths (Many Independent `remove_dir_all`)

| Location | Action | Line(s) | Notes |
|----------|--------|---------|-------|
| Cancel during WaitingForConfirm | `remove_dir_all(&build_dir)` | 1142 | After user clicks cancel or timeout |
| Cancel during compilation (stream_child_output returns None) | `do_rollback(...)` + `remove_dir_all(&build_dir)` | 1233-1235 | |
| Build failure (MSBuild returned error) | `rollback_build(...)` + `remove_dir_all(&build_dir)` | 1244-1250 | |
| Validation failure (missing core binaries) | `rollback_build(...)` + `remove_dir_all(&build_dir)` | 1329-1335 | |
| CMake configure failure | `rollback_build(...)` (no build_dir delete here) | 1106 | |
| Git clone/pull failure | `rollback_build(...)` | 698, 723 | |
| `foundry_cancel()` command | `kill_all_children()` + emit + `end_foundry_build_session` (no explicit dir delete here) | 1440-1475 | Relies on earlier paths |

### 3.4 Success Path (Partial Cleanup + Sacred Binary Registration)

| Location | Action | Line(s) | Notes |
|----------|--------|---------|-------|
| Post-build "keep only bin" | Walk `build_root`, delete everything except the `bin` subdir | 1356-1373 | Attempts to be surgical but still operates inside the sacred `build-*` tree |
| Binary path registration | Writes `binaryPathPerEnv[env]` pointing at `build-*/bin/Release/llama-server.exe` | 1395-1400 | This is why the three build-* trees are currently "sacred" — the provider JSON literally points inside them |
| `persist_providers_atomic` | Writes the user config JSON with the above paths | 1673 (via helper) | |

### 3.5 Rollback / Restore Machinery

| Location | Action | Line(s) | Notes |
|----------|--------|---------|-------|
| `RollbackBuilder::execute` | If both `bin_bak` and `bin_release` exist → `remove_dir_all(bin_release)` + `rename(bak → release)` | 1718-1720 | Used on almost every failure path |
| `do_rollback` (free function) | Same rename dance, no event | 1761-1764 | Called from compilation cancel path |
| `foundry_restore()` command | `remove_dir_all(current bin_release)` + `rename(bak → release)` | 1638-1641 | This one is intentional user action |

### 3.6 Legacy Migration (Still Present)

| Location | Action | Line(s) | Notes |
|----------|--------|---------|-------|
| `refresh_build_info` | If old `src_dir/build` exists and no per-env paths, rename it to `build-vanguard` | 1526-1533 | One-time migration for users who built before the three-profile era |

### 3.7 Batch Script Generator (The Silent Killer)

Function: `build_isolated_batch_script` (reactor_foundry.rs:363-392)

When `fresh == true` (configure phase) it emits:

```
if exist build-stable rmdir /s /q build-stable
mkdir build-stable
cd /d build-stable
cmake ...
```

This runs inside the source tree, under a hidden `cmd /c` with `@echo off`. When MSBuild locks files, the `rmdir` fails silently and the subsequent build can be corrupted or leave partial trees that later confuse the "sacred" logic.

---

## 4. Why the Current Design Causes "Head Spins"

1. The final Release artifacts live **inside** the build working tree (`build-*/bin/Release`).
2. The same three directories must be preserved across builds of *other* profiles.
3. Every cleanup rule therefore needs an ever-growing list of exceptions.
4. A single variable (`build_dir`, `env_build_name`, etc.) being computed for the wrong profile instantly deletes another profile's sacred binaries.
5. The batch scripts have their own independent deletion logic that the Rust side cannot easily see or control.
6. `bin-*-bak` lives at the wrong level (sibling to `llama.cpp`) creating yet another set of paths that must be coordinated.

The user correctly diagnosed: "instead of writing complex guards... the build resulting /bin/release could be setup to be produced elsewhere."

---

## 5. Approved Future Layout (Radical Simplification — Design Delegated & Accepted)

### Guiding Rule (One Sentence)

> Everything under `foundry/engines/<provider_id>/work/` is **always safe to delete recursively** at the end of any build (success, failure, cancel). The sacred final binaries live in a completely separate `foundry/artifacts/<provider_id>/<profile>/Release/` tree that automatic cleanup code is **forbidden** from touching.

### New Recommended Directory Tree

```
foundry/
├── engines/
│   └── <provider_id>/
│       ├── source/                              ← (can keep the name "llama.cpp" for minimal diff)
│       │   └── .git/ + full source (kept for fast incremental rebuilds)
│       │
│       └── work/                                ← **DISPOSABLE — nuke with one remove_dir_all on every exit**
│           ├── build-stable-<build_id>/         ← ephemeral, unique per build attempt
│           │   └── bin/Release/...
│           ├── _build_cfg.bat
│           ├── _build_run.bat
│           └── (any other cmake/msbuild droppings)
│
└── artifacts/                                   ← **SACRED — only written on success or explicit user restore**
    └── <provider_id>/
        ├── vanguard/
        │   └── Release/
        │       ├── llama-server.exe
        │       └── ...
        ├── stable/
        │   └── Release/...
        └── fresh/
            └── Release/...
```

### What Changes in the Build Flow

- CMake configure is invoked with `-B <absolute-path-to-work/build-xxx-<id>>` (never a relative name inside source).
- The batch script generator no longer emits any `rmdir /s /q build-*` lines.
- On successful validation the contents of the temp `bin/Release` are **copied** (not renamed/moved) into `artifacts/<id>/<profile>/Release/`.
- Provider JSON `binaryPathPerEnv` entries now point at `foundry/artifacts/...` paths (still relative via `to_relative_path`).
- **Every single exit path** (including early cancel) ends with exactly one line:
  ```rust
  let _ = tokio::fs::remove_dir_all(&work_dir_for_this_provider).await;
  ```
- The entire `work/` subtree (including any `build-*` inside it) can be deleted with zero risk to other profiles or previous successful builds.

### Backup/Restore Semantics Become Trivial

- The previous sacred `artifacts/<id>/<profile>/Release/` **is** the backup.
- `foundry_restore` can simply copy from a timestamped sibling or just instruct the user to re-run the build for that profile.
- All the `bin-*-bak` rename dance inside the source tree disappears.

### Migration Path (For Existing Users)

On first run after the change (or via an explicit "migrate foundry layout" command):

1. For every provider + profile, if `engines/<id>/llama.cpp/build-<profile>/bin/Release` exists, copy its contents to `artifacts/<id>/<profile>/Release`.
2. Update the provider JSON `binaryPathPerEnv` entries.
3. (Optional) Delete the old `build-*` trees inside `llama.cpp` once the copy succeeds.
4. Future builds will use the new `work/` + `artifacts/` layout automatically.

---

## 6. Policy Statements (These Must Be Enforced in Code After the Redesign)

1. **work/ is always disposable.** Any code path that finishes a build (success or any failure) **must** delete the work tree for that provider. There is no "keep some build artifacts for debugging" exception unless the user explicitly opts in via a power-user flag.
2. **artifacts/ is sacred.** No automatic cleanup code is ever allowed to call `remove_dir_all` on anything under `foundry/artifacts/`. Only explicit user actions (`foundry_restore`, a future "delete this profile build" button) may touch it.
3. **source/ is kept by default.** The git repository under `engines/<id>/source/` (or `llama.cpp/`) is preserved after builds so the next build can do a fast `git pull` instead of a full re-clone. A user may still choose a "full clean" that also deletes source.
4. **One nuke to rule them all.** After the redesign, the Rust side should not need more than a single `remove_dir_all(work_root)` call on exit paths. Complex "except these three directories" loops must not be re-introduced.

---

## 7. Remaining Non-Directory Work (Also Required)

While the directory redesign is the biggest win, the following must still be addressed (they were the original triggers for the deep review):

- React modal (`FoundryBuildProgress`) still accumulates the full legacy `foundry-progress` log → cap at ~200 lines and clear on termination.
- Blackwell Output Console (UOR) currently only receives hand-rolled stage strings. The real CMake + MSBuild stdout/stderr must be piped into per-build-session bounded buffers in the `BlackwellOutputConsoleManager`.
- Status-bar 1-line collapsed preview must live-update from the console manager.
- Real detachable Tauri `WebviewWindow` for the full Output Console (while keeping the nice docked 1-line / 3-line peek behavior inside the main app).
- Child process tree cleanup on Windows (user is uncertain whether aggressive `taskkill /T` is needed on clean exits).
- `FoundryPage` must never remain stuck in "building" after a build terminates.

---

## 8. Verification Checklist (Run These After the Redesign Lands)

1. Build the same provider on Stable → Vanguard → Fresh. All three `artifacts/<id>/*/Release/llama-server.exe` must exist and be untouched by later builds.
2. After any build (success or cancel), `engines/<id>/work/` must be gone (or empty). Source tree may remain.
3. Open the power-user Output Console during a real build. It must contain actual CMake "Configuring done", "Linking", MSBuild "ClCompile", etc. — not just five stage messages.
4. The React modal log viewer caps itself and releases memory on build end (webview process memory stays <300 MB even on long builds).
5. `FoundryPage` shows the correct non-building state within seconds after every exit path.
6. Status bar 1-line preview updates live.
7. `foundry_restore` for a profile still works and points the provider config at the correct sacred artifact path.
8. No orphaned `msbuild.exe` / `cl.exe` / `conhost.exe` trees remain after a clean build (check with Process Explorer or PowerShell `Get-Process`).

---

## 9. Critical Files to Read When Working on This System

**Must-read for any directory or cleanup change:**
- `src-tauri/src/reactor_foundry.rs` (entire file, especially path construction at ~640, batch script at ~363, every `remove_dir_all` call)
- `src-tauri/src/config.rs` (`foundry_dir`, `app_root_dir`, `to_relative_path`)

**Logging ownership:**
- `src-tauri/src/output_console.rs` (the manager that will become the home of real build output)

**Frontend consumers:**
- `src/hooks/useBuildDock.tsx`
- `src/components/FoundryBuildProgress.tsx` (the 200-line cap lives here)
- `src/components/Layout.tsx` + `FoundryPage.tsx` (status bar + page state)

---

## 10. How to Use This Document in a Fresh Session

1. Open this file.
2. Read Sections 1–4 to understand why the current system is painful.
3. Read Section 5 to understand the approved clean future.
4. When implementing, treat Sections 6 (policy) and 8 (verification) as non-negotiable.
5. After the redesign lands, update this document (especially the "Current State" section) so it remains the single source of truth.

**This file is intentionally the only artifact a future session should need for the directory/cleanup part of the Foundry problem.**

---

*End of FOUNDRY_DIRECTORY_STRUCTURE_MAP.md*  
Created as the mandatory first deliverable per the approved stabilization plan.
