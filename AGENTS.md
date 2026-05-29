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

## 7. Provider Config Files

**Location:** `config/<provider>-user-config.json`

### Fields
- `binary_path`: Main binary path (sacred artifacts or manual)
- `binaryPathPerEnv`: Per-environment paths (vanguard/stable/fresh)

### Loading Flow
1. Load from disk via `load_user_providers_meta()`
2. Apply user overrides from config file
3. `find_provider_binary()` resolves the correct path

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
Mirror foundry-built artifacts from DEV build directory into `runtime/` so they are bundled in the NSIS release installer.

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
Set to `"off"` in `tauri.conf.json` under `plugins.nsis.compression`. Binaries don't compress well; skipping 7zip speeds up builds significantly on multi-core machines.

### Developer workflow
1. Build providers via foundry (artifacts land in `foundry/artifacts/`)
2. Edit `runtime/<provider>/config/*.json` if cmake flags or params change
3. Run `npm run release` — mirrors artifacts, bundles everything into NSIS installer
