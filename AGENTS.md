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
4. **Manifest construction** — calls shared `buildManifest()` from factory

### ENFORCEMENT RULES (STRICT)

1. **NO cross-scenario imports.** A scenario file must NEVER import another scenario file. Each module only imports from `scenarios_factory.ts` and `lib/types`.

2. **NO global UI template dependency.** There is no external JSON template. Style lives inline in each scenario's code. If a scenario needs a new visual element, add it to the `StyleObject` interface in `lib/types.ts`, then enable it via that scenario's style map.

3. **Orchestrator is strict sequential dispatch.** The factory's `evaluate()` function calls scenarios in order using `||`. If a scenario returns `null`, it moves to the next instantly. No logic bleeding between scenarios.

4. **Factory contains ONLY shared infrastructure:**
   - Constants (`CUDA_BASE_OVERHEAD_GB`, `GPU_FILL_TARGET`, etc.)
   - Pure helpers (`parseCtx()`, `kvBytesForQuant()`, `gpuManufacturedMib()`)
   - Pre-computation (`computeValues()` — weights, KV cache, overhead, GPU availability)
   - Formatter (`buildManifest()` — GPU allocation loop + rounding)
   - Orchestrator (`evaluate()` — sequential dispatch chain)

5. **Evaluation is fully TypeScript.** The Rust `scenario.rs` module has been removed. All VRAM evaluation runs in the frontend via `useScenarioEvaluator.ts` → factory. No IPC call for scenario evaluation.

6. **Types are unified in `lib/types.ts`.** Components import `VramManifest`, `StyleObject`, `GpuAllocation`, etc. from there. The factory produces objects matching these interfaces.

### Adding a New Visual Element to a Scenario
1. Add the property to `StyleObject` interface in `src/lib/types.ts` (mark as optional if not all scenarios need it)
2. Set the value inline in the target scenario's style object
3. Read the property from `manifest.style` in the UI component (`VramBadge.tsx`, `GpuTopology.tsx`)

### Tuning a Scenario Without Breaking Others
1. Open the single `.ts` file for that scenario (e.g., `solo_spill.ts`)
2. Adjust guard thresholds, math formulas, or style values
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
