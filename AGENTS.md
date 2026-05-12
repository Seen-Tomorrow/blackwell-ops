# AGENTS.md — Blackwell Ops

## Dev Startup / Kill Procedure

**Normal restart (Rust changes only):** Just run `npm run tauri` again in the same terminal. Cargo watch auto-recompiles. Vite stays running — no need to kill it.

**Full restart (both Rust + Frontend):**
```powershell
Get-Process -Name blackwell-ops -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
npm run tauri
```
> **Important:** Do NOT use `Start-Process -WindowStyle Hidden` to launch Tauri in background — the MCP bridge WebSocket plugin fails to initialize properly. Always run `npm run tauri` directly in your terminal (foreground).

- `npm run build` — `tsc && vite build`
No tests, lint, or CI configured.

## Stack

- **Backend:** Rust (Tauri v2) + Tokio async runtime
- **Frontend:** React 18 + TypeScript + Tailwind CSS + Vite 6
- **UI:** Custom dark terminal-style, transparent/decorationless window
- **Process Manager:** Spawns `llama-server.exe` via `tokio::process::Command`
- **Dev server:** port 1420 (Vite) / 9090+ (engine stack ports)

## Architecture Docs

- `VRAM_SCENARIO_SYSTEM.md` — How the VRAM forecast and scenario evaluation system works
- `FIT_CALIBRATION_FUTURE.md` — Future work for calibrating overhead formula from FIT scan data

## Scenario System Rules (Summary)

See `VRAM_SCENARIO_SYSTEM.md` for full details. Critical rules:

1. **Scenario-specific changes stay in scenario files.** Each scenario is an isolated silo (`src/services/vram/scenarios/*.ts`).
2. **NEVER add conditional logic or hardcoded text to VramBadge.tsx.** It's a dumb skeleton renderer that reads from `manifest.style.uiTemplate`.
3. **NO cross-scenario imports.** Scenarios only import from `scenarios_factory.ts` and `lib/types`.
4. **Factory contains ONLY shared infrastructure:** constants, helpers, computeValues, buildManifest, orchestrator.

## Param Dock System

Params declare where they render via `"dock"` property in `genesis_template.json`. Docked params group together above PARAMETERS section. Current dock: `hardware` (Device, Offload, Offload_Mode, Split).

## Gotchas & Known Issues

### Release Build: Process Spawns Must Use `Stdio::null()` + `CREATE_NO_WINDOW` (CRITICAL)

Any `Command::new(...).output()` that runs frequently must use:
```rust
.stdout(Stdio::null())
.stderr(Stdio::null())
.creation_flags(0x08000000) // CREATE_NO_WINDOW
```
Both are needed — `Stdio::null()` alone still creates a console window on Windows.

**Files with this fix:** `telemetry.rs`, `engine.rs`, `config.rs`, `fit_scanner.rs`, `engine_stack.rs`

### React Hooks Violation on HMR
`EngineConfigPanel.tsx` may throw "Rendered more hooks than during the previous render" during Vite HMR. Clean reload (`npm run tauri`) to recover — it's a Vite state desync, not actual conditional hook usage.

### EngineConfigPanel Config Spread Churn
Hook uses refs (`configRef`, `gpusRef`, etc.) and reads from them inside callbacks instead of closing over state vars. Dep arrays are stripped to stable values only.
