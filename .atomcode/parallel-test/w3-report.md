# Worker 3 — Parallel Test Report

## Timestamps
- **W3_START:** 1784984505522 (ms)
- **W3_END:** 1784984555270 (ms)
- **Duration:** 49,748 ms

## File List & Line Counts

| # | File | Lines |
|---|------|------:|
| 1 | `src/components/FusionOverlay.tsx` | 841 |
| 2 | `src/components/FusionShareMenu.tsx` | 320 |
| 3 | `src/components/FusionBooter.tsx` | 248 |
| 4 | `src/components/FusionTpsDisplay.tsx` | 63 |
| 5 | `src/components/FusionSlotCtxBar.tsx` | 36 |
| 6 | `src/components/FusionFuelTank.tsx` | 33 |
| 7 | `src/components/FusionBenchTrayLatch.tsx` | 29 |
| 8 | `src/components/FusionPhaseBadge.tsx` | 26 |
| | **Total** | **1,596** |

---

## Props Interfaces

### FusionOverlayProps (22 lines)
```typescript
interface FusionOverlayProps {
  alias?: string;
  enginePort?: number;
  fusion: FusionUpdate | null;
  supportsFusion?: boolean;
  engineStatus?: string;
  slotIdx?: number;
  gpus?: GpuInfo[];
  gpuMask?: string;
  vramTargetMib?: number;
  modelLayerTotal?: number;
  gpuLoadTargetsMib?: Record<number, number>;
  modelName?: string;
  modelQuant?: string;
  providerName?: string;
  providerBuildVersion?: string;
  profileLabel?: string;
  cudaVersion?: string;
  launchConfig?: FusionShareLaunchConfig;
  hwTopo?: string;
}
```

### FusionShareMenuProps (extends FusionShareMeta, 6 lines)
```typescript
interface FusionShareMenuProps extends FusionShareMeta {
  labeled?: boolean;
  triggerStyle?: "swatch" | "share-icon";
}
// Inherited from FusionShareMeta:
//   providerName, providerBuildVersion, modelName, modelQuant, profileLabel,
//   cudaVersion, launchConfig, hwTopo, shareGpus, shareGpuMask, shareSplitMode, tgTps
```

### FusionBooterProps (10 lines)
```typescript
interface FusionBooterProps {
  slotIdx: number;
  alias: string;
  port: number;
  gpus: GpuInfo[];
  gpuMask: string;
  vramTargetMib?: number;
  modelLayerTotal?: number;
  gpuLoadTargetsMib?: Record<number, number>;
}
```

### FusionBenchTrayLatchProps (4 lines)
```typescript
interface FusionBenchTrayLatchProps {
  open: boolean;
  onToggle: () => void;
}
```

### FusionSlotCtxBarProps (6 lines)
```typescript
interface FusionSlotCtxBarProps {
  slotId: number;
  totalTokens: number;
  ctxTotal: number;
  isProcessing: boolean;
}
```

### Inline Props (no named interface)

| Component | Props |
|-----------|-------|
| FusionPhaseBadge | `phase: string` |
| FusionFuelTank | `used: number; total: number; pct: number` |
| FusionTpsDisplay | `tps: number; smoothedTps: number; history: number[]` |

---

## Internal Interfaces & Types

### FusionOverlay.tsx (within file)
- `LastRequestStats` — `genTokensSlots: number; prefillMs: string \| null; decodeTtftMs: string \| null; elapsedMs: string`
- `MicroStatsLatch` — `genTokens, prefillMs, decodeTtftMs, elapsedMs, sessionOpen, lastBusyAt, lastElapsedRaw, lastMeterSeq`
- `EngineStateData` — `microLatch: MicroStatsLatch`

### FusionShareMenu.tsx (external)
- `FusionShareMeta` — shared meta interface (from `../lib/fusionShareCapture`)
- `FusionShareVariant` — `"white" | "black"`

### FusionBooter.tsx (external)
- `GpuInfo` — from `../lib/types`
- `GpuVramLoad` — from `../hooks/useFusionBooterState`
- `LoadPhaseId` — from `../lib/fusionLoadParser`

---

## Hooks & Contexts Map

| Component | Hooks Used | Contexts / External Deps |
|-----------|-----------|------------------------|
| **FusionOverlay** | `useState`, `useEffect`, `useRef`, `useCallback` | `useTauriListen`, `useFusionHeroTpsMode`, `useFusionBenchTray` |
| **FusionShareMenu** | `useState`, `useEffect`, `useLayoutEffect`, `useRef`, `useCallback` | `createPortal` (react-dom), Tauri `invoke` |
| **FusionBooter** | `useFusionBooterState` (custom hook) | `LOAD_PHASE_ORDER`, `LOAD_PHASE_LABELS`, `phaseIndex` from `../lib/fusionLoadParser` |
| **FusionTpsDisplay** | `useRef`, `useEffect`, `useState` | — |
| **FusionPhaseBadge** | — (pure component) | — |
| **FusionSlotCtxBar** | — (pure component) | — |
| **FusionFuelTank** | — (pure component) | — |
| **FusionBenchTrayLatch** | — (pure component) | — |

### External imports summary (FusionOverlay — the most connected)
- `invoke` from `@tauri-apps/api/core`
- `FUSION_HERO_ROW_PX` from `../lib/benchPanelLayout`
- `getBenchPortState`, `notifyBenchPortStore`, `subscribeBenchPortStore` from `../lib/benchPortStore`
- `BenchWidget`, `BenchHeroPatch`, `BenchSessionMode` from `./BenchWidget`
- `FusionBooter` from `./FusionBooter`
- `FusionShareLaunchConfig` from `../lib/fusionShareCapture`
- `FusionBenchTrayLatch` from `./FusionBenchTrayLatch`
- `SlotCtxBars`, `formatTokenCount`, `fusionSlotColumnLayout` from `./SlotCtxBars`
- `GpuInfo` from `../lib/types`
- `useFusionBenchTray` from `../hooks/useFusionBenchTray`
- `useFusionHeroTpsMode` from `../hooks/useFusionHeroTpsMode`
- `useTauriListen` from `../hooks/useTauriListen`

---

## Architecture Notes
- **FusionOverlay** is the largest component (841 lines) — it orchestrates the full Fusion dashboard: hero TPS display (PP + TG), per-slot context bars, micro-stats latches, bench tray, engine stop, and booter overlay during launch.
- **FusionShareMenu** (320 lines) renders variant swatches + portal menu for clipboard/PNG capture via Tauri IPC.
- **FusionBooter** (248 lines) visualizes GPU VRAM loads, disk I/O, phase ladder, and stderr ticker during engine launch.
- Remaining 5 components are pure/small presentational: TPS sparkline, phase badges, context bars, fuel tanks, and the bench tray latch button.
- Total line count across all 8 Fusion components: **1,596 lines**.
