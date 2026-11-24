# Pre-Launch Audit & Hardening Plan

**Goal:** Final pre-public-release cleanup, schema freeze, and hardening pass while there are no external users yet (no migration paths needed).

## Context & Constraints
- **Windows-only, portable:** `app_root = current_exe().parent()`. Must work cleanly under **spaced install paths** (e.g., `Blackwell Ops`) and Unicode `%USERPROFILE%`.
- **Single-provider v1:** Shipping `ggml-master` only for v1.
- **Targeted simplification only:** Prune dead code, unused IPC, and leftover scaffolding; do **not** rewrite working feature-rich code right before launch.
- **Related docs:** `docs/SELF-SUFFICIENT-INSTALL.md`, `docs/ENGINE-PACKS.md`, `docs/UNINSTALL.md`, `AGENTS.md`.

## Baseline Snapshot (2026-11-24)
- **Largest Rust files:** `reactor_foundry/mod.rs` (3,169), `download_manager.rs` (3,156), `pi_code.rs` (2,418), `foundry_toolchain.rs` (2,329), `vram_learn.rs` (2,033), `engine.rs` (1,802), `templates.rs` (1,793), `engine_stack.rs` (1,714), `distribution.rs` (1,662).
- **Largest TS/TSX files:** `EngineConfigPanel.tsx` (3,788), `ParamConfigPanel.tsx` (1,950), `fusionShareCapture.tsx` (1,618), `types.ts` (1,385), `storage.ts` (1,381), `useScenarioEvaluator.ts` (1,379).
- **Largest CSS file:** `fusion-display.css` (6,943 LOC — combines industrial bezel, VRAM forecast, GPU topo, Fusion telemetry/share-card, and calibration overlay).
- **Surface area:** 211 `#[tauri::command]` handlers, 154 `.unwrap()` + 165 `.expect()` (tests + prod), 23 `#[allow(dead_code)]`, 13 `: any`, 37 dead CSS classes.

---

## Pass 1 — Freeze & Audit Persisted Schemas (Highest Priority)
Everything written to `{app_root}/config/` and `localStorage` becomes permanent once users install.
1. Inventory every `{app_root}/config/*.json`, `{app_root}/config/cache/*.json`, and every `BlackOps-*` key in `src/lib/storage.ts`.
2. Prune dead serialized fields (e.g., plaintext `hf_token` on `AppConfig`, unused `CustomProviderCapabilities` fields).
3. Verify `schema_version` / corrupt-JSON resilience and atomic writes on every persisted file.
4. Verify NSIS Full Install ↔ App-Only `.7z` ↔ Engine Packs ↔ `docs/UNINSTALL.md` parity.

## Pass 2 — Production Hardening for Real Windows Machines
1. Audit **non-test** Rust `.unwrap()` / `.expect()` / slice indexing / `Path::to_str().unwrap()`.
2. Audit spaced install paths (`"Blackwell Ops"`) and Unicode `%USERPROFILE%` across `.cmd`/`.bat`, Foundry, `pi`, `gsudo`, and engine spawns.
3. Audit subprocess spawns: no `tokio::process` + `CREATE_NO_WINDOW` in REL; Defender file-lock retries on newly extracted `.exe`/`.dll`.
4. Audit degraded environments: offline startup / GitHub 403 rate-limit, non-Blackwell GPUs, driver `< 610`, missing `nvml.dll`/`nvidia-smi`, and zero DEV-tool leakage (`VIEW`, `GPU+`, `DISTRIBUTION`, CDP 9222, `automation`) in REL.

## Pass 3 — Dead-Code & IPC Surface Pruning
1. Run `npm run lint:dead`, `npm run lint:dead:rust`, and `npm run css:audit`.
2. Cross-check all 211 `#[tauri::command]` handlers against live `invoke(...)` callers in `src/`.
3. Audit all 23 `#[allow(dead_code)]` sites in Rust and dead CSS rules (`fusion-display.css` and other partials).

## Pass 4 — Targeted Simplification (No Rewrites)
- Prune dead branches only (e.g., unused multi-provider / optional-fork scaffolding not shipped in v1, dead helpers in `storage.ts` / `EngineConfigPanel.tsx`).

## Pass 5 — Self-Contained Dependency Verification & Clean-Path Rehearsal
Even on a polluted dev/home PC, we can verify the app loads **zero** host dependencies (beyond OS + GPU driver) with an automated check (`scripts/check-self-contained.ps1`):
1. **Stripped-`PATH` spaced-folder launch:** Launch REL `blackwell-ops.exe` from a spaced folder (e.g., `tmp\Blackwell Ops\`) with `$env:PATH = "C:\Windows\System32;C:\Windows;C:\Windows\System32\Wbem"` and `CUDA_PATH`, `VSINSTALLDIR`, `VSCMD_*`, `LIB`, `INCLUDE`, `PYTHONPATH` unset. Exercise model scan, engine launch, bench, and Foundry check.
2. **Runtime Loaded-DLL Audit:** Inspect `(Get-Process -Id $pid).Modules | Select-Object FileName` for `blackwell-ops.exe`, `llama-server.exe`, `llama-fit-params.exe`, `pi.exe`, etc. Fail if any loaded DLL is outside:
   - `{app_root}\**` (`runtime/`, `runtime-catalog/`, `foundry/artifacts/`, `toolchain/`, `bin/`, `pi-ext/`)
   - `C:\Windows\System32\**` and `C:\Windows\WinSxS\**` (OS + NVIDIA driver `nvml.dll`, `nvapi64.dll`, `nvcuda.dll`)
   - `C:\Program Files (x86)\Microsoft\EdgeWebView\**` (WebView2)
   Flag anything from `Program Files\NVIDIA GPU Computing Toolkit`, `Microsoft Visual Studio`, `Program Files\Git`, `AppData`, `Python`, `msys64`, etc.
3. **Static PE Import Check:** Run `dumpbin /dependents` (from our portable VS toolchain) on `blackwell-ops.exe`, `llama-server.exe`, `ggml-cuda.dll`, `llama-fit-params.exe`, and `llama-bench.exe` to verify every imported DLL is either a known Windows/driver DLL or present inside `{app_root}`.
4. **Upgrade/Uninstall Rehearsal:** NSIS install → App-Only `.7z` update → Engine Pack update → Uninstall (verify models + `config/` survive).

---

## Execution Strategy for Fresh Session
Kick off Passes 1–3 with parallel read-only `research` subagents to produce exact file/line hit lists first, then execute fixes in small per-concern commits gated by `npm run check`.
