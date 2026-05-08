# AGENTS.md — Blackwell Ops VRAM Scenario Architecture

## Dev Startup / Kill Procedure

**Normal restart (Rust changes only):** Just run `npm run tauri` again in the same terminal. Cargo watch auto-recompiles. Vite stays running — no need to kill it.

**Full restart (both Rust + Frontend):**
```powershell
# Only kill Tauri's CMD.exe, NOT node/Vite
Get-Process -Name blackwell-ops -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
npm run tauri
```
> **Important:** Do NOT use `Start-Process -WindowStyle Hidden` to launch Tauri in background — the MCP bridge WebSocket plugin fails to initialize properly. Always run `npm run tauri` directly in your terminal (foreground).
>
- `npm run build` — `tsc && vite build`

No tests, lint, or CI configured.

## Stack

- **Backend:** Rust (Tauri v2) + Tokio async runtime
- **Frontend:** React 18 + TypeScript + Tailwind CSS + Vite 6
- **UI:** Custom dark terminal-style, transparent/decorationless window
- **Process Manager:** Spawns `llama-server.exe` via `tokio::process::Command`
- **Dev server:** port 1420 (Vite) / 9090+ (engine stack ports)


## VRAM Scenario System: Isolated Silos

### Directory Structure
```
src/services/vram/scenarios/
├── scenarios_factory.ts      ← Constants, types, helpers, orchestrator ONLY
├── solo_clean_fit.ts         ← Self-contained scenario A
├── solo_busy_fit.ts          ← Self-contained scenario B
├── multi_perfect.ts          ← Self-contained scenario C (all GPUs <85%)
├── multi_pressure.ts         ← Self-contained scenario D (at least one GPU >85%)
├── solo_spill.ts             ← Self-contained scenario E (single GPU fill, RAM offload)
├── total_spill.ts            ← Self-contained scenario F (all GPUs filled, RAM offload)
└── hw_locked.ts              ← Self-contained fallback G (always matches)
```

### Unified Interface — Every Scenario Module Must Export

```typescript
// tryEvaluate returns VramManifest | null
export function tryEvaluate(
  input: ScenarioInput,
  computed: ComputedValues
): VramManifest | null;

// hw_locked exports evaluate (not tryEvaluate) since it always matches
export function evaluate(
  input: ScenarioInput,
  computed: ComputedValues,
  reason: string
): VramManifest;
```

### What Each Scenario Owns (Self-Contained)
1. **Guard condition** — returns `null` if this scenario doesn't apply
2. **Internal math** — layer splits, per-GPU load distribution, spill calculations
3. **Style object** — inline `StyleObject` with ALL visual properties:
   - `titleColor`, `gpuBarColor`, `borderColor`, `bgTint`, `badgeBg`
   - `icon`, `label`, `ramVisible`
4. **UI Template** — inline `UiTemplate` that controls what VramBadge renders:
   - `gpuLayerText`, `ramLayerText` — scenario-specific text strings
   - `showRamBar` — visibility flag for RAM bar section
   - `offloadWarningText`, `kvSpillRiskText` — optional warning messages
5. **Manifest construction** — calls shared `buildManifest()` from factory

### UiTemplate Architecture (CRITICAL)
VramBadge is a **dumb skeleton renderer**. It reads text, visibility flags, and colors from `manifest.style.uiTemplate`. It contains ZERO scenario logic.

```
Scenario .ts file → defines uiTemplate inline with all text + visibility
  ↓
buildManifest() → passes through to VramManifest
  ↓
VramBadge.tsx → reads s.uiTemplate.xxx and renders conditionally on truthiness
```

**If you want to change what the forecast block shows for a scenario:** Edit that scenario's `.ts` file. Never touch VramBadge for scenario-specific changes.

### ENFORCEMENT RULES (STRICT) — DO NOT VIOLATE

0. **GOLDEN RULE: Scenario-specific changes stay in scenario files.** Styling, guard logic, math, text, visibility — if it belongs to a particular scenario, it lives in that scenario's `.ts` file. Not in VramBadge, not in EngineConfigPanel, not in shared helpers. Each scenario is an isolated silo.

1. **NEVER add conditional logic to VramBadge.tsx.** If you find yourself writing `if (manifest.ramLayers > 0)` or similar inside VramBadge — STOP. That decision belongs in the scenario's `uiTemplate`. VramBadge only reads from `s.uiTemplate` and renders what it says.

2. **NEVER add hardcoded text strings to VramBadge.tsx.** All user-facing text (layer info, warnings, labels) comes from `s.uiTemplate.gpuLayerText`, `s.uiTemplate.ramLayerText`, etc. The only static text allowed in VramBadge is universal layout labels ("MEMORY FORECAST", "You need //").

3. **Adding a new UI element to the forecast block:**
   1. Add property to `UiTemplate` interface in `src/lib/types.ts` (optional, with default)
   2. Set value inline in target scenario's `uiTemplate` object
   4. Read from `s.uiTemplate.xxx` in VramBadge skeleton — render conditionally on truthiness
   Never add a new `<div>` or `<p>` to VramBadge without a corresponding `UiTemplate` property driving it.

4. **NO cross-scenario imports.** A scenario file must NEVER import another scenario file. Each module only imports from `scenarios_factory.ts` and `lib/types`.

5. **Orchestrator is strict sequential dispatch.** The factory's `evaluate()` function calls scenarios in order using `||`. If a scenario returns `null`, it moves to the next instantly. No logic bleeding between scenarios.

6. **Factory contains ONLY shared infrastructure:**
   - Constants (`CUDA_BASE_OVERHEAD_GB`, `GPU_FILL_TARGET`, etc.)
   - Pure helpers (`parseCtx()`, `kvBytesForQuant()`, `gpuManufacturedMib()`)
   - Pre-computation (`computeValues()` — weights, KV cache, overhead, GPU availability)
   - Formatter (`buildManifest()` — GPU allocation loop + rounding)
   - Orchestrator (`evaluate()` — sequential dispatch chain)

7. **Evaluation is fully TypeScript.** The Rust `scenario.rs` module has been removed. All VRAM evaluation runs in the frontend via `useScenarioEvaluator.ts` → factory. No IPC call for scenario evaluation.

8. **Types are unified in `lib/types.ts`.** Components import `VramManifest`, `StyleObject`, `UiTemplate`, `GpuAllocation`, etc. from there. The factory produces objects matching these interfaces.

### Tuning a Scenario Without Breaking Others
1. Open the single `.ts` file for that scenario (e.g., `solo_spill.ts`)
2. Adjust guard thresholds, math formulas, style values, or uiTemplate text
3. Save — only that scenario's output changes
4. No other scenario is affected because there are zero cross-dependencies

### Scenario Evaluation Order (Fixed)
1. `solo_clean_fit` — fits one GPU, no existing engines
2. `solo_busy_fit` — fits one GPU, card has engines
3. `multi_perfect` — distributed across GPUs, all under 85%
4. `multi_pressure` — distributed, at least one GPU over 85%
5. `solo_spill` — single GPU fill to 95%, rest in RAM
6. `total_spill` — all GPUs filled to 95%, rest in RAM
7. `hw_locked` — fallback (always matches)

### Key Data Flow
```
useScenarioEvaluator.ts
  → builds ScenarioInput from model metadata + config + GPU telemetry
  → calls evaluate(input) from scenarios_factory.ts
    → computeValues() pre-computes shared numbers once
    → sequential dispatch: soloCleanFit || soloBusyFit || multiPerfect || ...
    → first non-null result is returned as VramManifest
  → manifest passed to VramBadge component for rendering
```

## Param Dock System — SOC, Backend-Agnostic

### Concept
Params declare where they render via `dock` property on `ParamDef`. Params with the same `dock` value group together in a recessed block above PARAMETERS. Params without `dock` render normally in their `ui_group`.

### How It Works
1. Add `"dock": "<key>"` to any param in `genesis_template.json` (e.g., `"dock": "hardware"`)
2. EngineConfigPanel filters docked params, renders them grouped by key in an inset block
3. Docked params are skipped from normal group rendering — no duplication

### Current Dock Groups
- **`hardware`** — Device (dynamic), Offload, Offload_Mode, Split, GPU-Sync (all Multi-GPU group params)

### Rules
- NEVER hardcode param rendering in VramBadge or other components — always go through the param array
- NEVER duplicate params between docked block and PARAMETERS section
- To move a param to/from the docked block: just add/remove `"dock"` in genesis_template.json
- The app is backend-agnostic — future providers may have different Multi-GPU params; they dock by adding `"dock": "hardware"`

### Files
- `src/lib/types.ts` — `ParamDef.dock?: string`
- `src-tauri/config/genesis_template.json` — param definitions with optional `dock`
- `src/components/EngineConfigPanel.tsx` — filters, renders docked block, skips from normal groups

## Gotchas & Known Issues

### Release Build: Process Spawns Must Use `Stdio::null()` (CRITICAL)

**Problem:** In release builds, any `std::process::Command` or `tokio::process::Command` that calls `.output()` **without** redirecting stdout/stderr will spawn a visible CMD window on Windows. This is because there's no parent console to inherit — Windows creates one per orphaned process.

**Impact:** The GPU telemetry poller runs `nvidia-smi` every 250ms → hundreds of CMD windows flash open, causing UI freeze and resource exhaustion. Running as admin makes it worse (hundreds of persistent windows).

**Fix applied to all affected spawns:**
```rust
use std::os::windows::process::CommandExt; // required for creation_flags

Command::new("...")
    .stdout(Stdio::null())   // suppress stdout window creation
    .stderr(Stdio::null())   // suppress stderr window creation
    .creation_flags(0x08000000) // CREATE_NO_WINDOW — CRITICAL, Stdio::null() alone is NOT enough on Windows
    .output()
```

**Why both are needed:** `Stdio::null()` redirects the streams but Windows still allocates a console window for the process. `CREATE_NO_WINDOW` (0x08000000) tells the OS not to create one at all. Both must be present together.

**Note:** This app is Windows-only, so `CommandExt` imports and `creation_flags` calls are unconditional (no `#[cfg(windows)]`). The `#[cfg(windows)]` attribute cannot be placed on a single method call in a builder chain — Rust doesn't support that syntax.

**Files that have this fix:**
- `src-tauri/src/telemetry.rs` — `nvidia-smi` polling + PowerShell WMI RAM query
- `src-tauri/src/engine.rs` — port cleanup PowerShell (2 calls)
- `src-tauri/src/config.rs` — GPU count detection
- `src-tauri/src/fit_scanner.rs` — GPU count detection
- `src-tauri/src/engine_stack.rs` — port cleanup PowerShell

**What's NOT affected:** Conpty engine logs (`engine_stack.rs` spawn with conpty crate) use a completely different mechanism (pseudo-console). Reactor Foundry build commands (`reactor_foundry.rs`) intentionally pipe stdout/stderr for progress streaming. Git clone/pull in foundry reads stderr for error messages — those are fine since they're one-shot, not polled.

**Rule:** Any new `Command::new(...).output()` call that runs frequently or in release must use `.stdout(Stdio::null()).stderr(Stdio::null())` unless you actually need the output captured. If you need the output, use `.stdout(Stdio::piped()).stderr(Stdio::piped())` instead — both prevent window creation.

### Dev vs Release Telemetry Interval
- Dev: 250ms GPU poll (fast feedback during config tuning)
- Release: Same interval, but invisible due to `Stdio::null()` fix above
- Low-power mode: 2000ms GPU / 5000ms CPU (toggle in UI)

### React Hooks Violation on HMR
`EngineConfigPanel.tsx` may throw "Rendered more hooks than during the previous render" during Vite HMR transitions. This is a transient hot-reload artifact — does a clean reload (`npm run tauri`) to recover. Do NOT reorder hooks to fix this; it's a Vite state desync, not actual conditional hook usage.

### EngineConfigPanel Config Spread Churn
`EngineConfigPanel.tsx:165` spreads `{ ...config, backend_type }` every render, creating a new object reference. This caused `useCallback` deps in `useScenarioEvaluator.ts` to churn constantly with telemetry polling. **Fix:** Hook uses refs (`configRef`, `gpusRef`, etc.) and reads from them inside callbacks instead of closing over state vars. Dep arrays are stripped to stable values only.
