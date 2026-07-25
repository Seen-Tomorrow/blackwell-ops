# Worker 4 — Parallelism Test Report

## Timestamps

| Marker | Millis (UTC~) |
|--------|---------------|
| W4_START | 1784984505638 |
| W4_END   | 1784984528122 |
| Duration | 22484 ms |

---

## Files Discovered (5)

1. `src/lib/fusionBenchTrayStore.ts` — persisted tray open/stowed state (module singleton store)
2. `src/lib/fusionBooterStore.ts` — per-slot booter session tracking with Tauri event listeners
3. `src/lib/fusionLoadParser.ts` — engine log-line parser → LoadParseResult
4. `src/lib/fusionSlotStore.ts` — per-slot fusion telemetry state + React hooks
5. `src/context/FusionContext.tsx` — React provider wiring IPC → fusionSlotStore

---

## Symbol Index

### `src/lib/fusionBenchTrayStore.ts`

| Symbol | Kind | Exported |
|--------|------|----------|
| `trayState` | module-scope variable (`FusionBenchTrayState`) | no |
| `listeners` | module-scope `Set<() => void>` | no |
| `notifyFusionBenchTrayStore()` | function | no |
| `refreshFusionBenchTrayFromStorage()` | function | yes |
| `getFusionBenchTrayOpen()` | function | yes |
| `setFusionBenchTray(next)` | function | yes |
| `toggleFusionBenchTray()` | function | yes |
| `subscribeFusionBenchTray(listener)` | function | yes |
| `FusionBenchTrayState` | type import (from `./storage`) | re-exported via use |

**Imports:** `{ loadFusionBenchTray, saveFusionBenchTray, FusionBenchTrayState }` from `./storage`

---

### `src/lib/fusionBooterStore.ts`

| Symbol | Kind | Exported |
|--------|------|----------|
| `PHASE_DWELL_MS` | const `750` | no |
| `DWELL_PHASES` | const `["server", "ready"]` | no |
| `BooterSession` | interface | yes |
| `createSession(slotIdx, port, modelLayerTotal)` | function | no |
| `sessions` | module-scope `Map<number, BooterSession>` | no |
| `subscribers` | module-scope `Map<number, Set<() => void>>` | no |
| `notify(slotIdx)` | function | no |
| `bump(session)` | function | no |
| `applyLogPhase(session, incoming)` | function | no |
| `markLoadFailed(session, reason)` | function | no |
| `processLogText(session, text)` | function | no |
| `tickPhaseLadder()` | function | no |
| `listenersReady` | let `false` | no |
| `ensureGlobalListeners()` | function | no |
| `subscribeBooterSession(slotIdx, cb)` | function | yes |
| `getBooterSession(slotIdx)` | function | yes |
| `getBooterRevision(slotIdx)` | function | yes |
| `initBooterSession(slotIdx, port, modelLayerTotal)` | function | yes |
| `patchBooterSession(slotIdx, patch)` | function | yes |
| `clearBooterSession(slotIdx)` | function | yes |
| `clearAllBooterSessions()` | function | yes |
| `elapsedSecForSession(session)` | function | yes |

**Imports:**
- `{ listen }` from `@tauri-apps/api/event`
- `{ frontendPollEnabled }` from `./debugFlags`
- `{ LogBatch, SystemEvent }` (types) from `./types`
- `{ LOAD_PHASE_ORDER, LoadPhaseId, maxPhase, parseLoadLogLine }` from `./fusionLoadParser`

**Tauri events listened:**
- `engine-log-batch` → `processLogText`
- `engine-system` → `processLogText` + readiness detection
- `engine-load-failed` → `markLoadFailed`
- `slot-cleared` → `clearBooterSession`
- `engines-all-stopped` → `clearAllBooterSessions`

**Polling (when `frontendPollEnabled()`):**
- `tickPhaseLadder()` every 40 ms
- Ping counter increment every 500 ms

---

### `src/lib/fusionLoadParser.ts`

| Symbol | Kind | Exported |
|--------|------|----------|
| `LoadPhaseId` | type (`"spawn" \| "weights" \| "kv" \| "server" \| "ready"`) | yes |
| `LOAD_PHASE_ORDER` | const `LoadPhaseId[]` | yes |
| `LOAD_PHASE_LABELS` | const `Record<LoadPhaseId, string>` | yes |
| `LoadParseResult` | interface | yes |
| `sanitizeTicker(line)` | function | no |
| `parseGpuMask(gpu)` | function | yes |
| `parseLoadLogLine(line)` | function | yes |
| `maxPhase(a, b)` | function | yes |

**Regex patterns detected:**
- Layer progress: `(?:layer\|blck)[^\d]*(\d+)\s*\/\s*(\d+)` / `(\d+)\s*\/\s*(\d+)\s*(?:layers\|layer)`
- Block index: `blck\.(\d+)`
- CUDA device: `cuda[:\s]*(\d+)` / `gpu\s*(\d+)` / `device\s*(\d+)` / `offload.*?(\d+)`
- Tensor GPU: `tensor.*?cuda:(\d+)`

**Phase detection keywords (case-insensitive):**
- `weights`: `load_tensors`, `loading model`, `loading tensor`, `llama_model_load`, `offload`, `tensor`, `ggml_cuda`
- `kv`: `kv cache`, `llama_kv`, `cache init`, `kv_cache`
- `server`: `http server listening`, `server is listening`, `http server is listening`
- `ready`: `readiness=`, `engine ready`
- `spawn` (fallback): any line >8 chars with no other match
- `loadFailed`: `model loading error`, `error loading model`, `failed to load model`, `unable to allocate`, `exiting due to`, `launch_error:`, `llama_server ... exiting`

---

### `src/lib/fusionSlotStore.ts`

| Symbol | Kind | Exported |
|--------|------|----------|
| `fusionPayloadEqual(a, b)` | function | yes |
| `slots` | module-scope `Map<number, FusionUpdate>` | no |
| `slotSubs` | module-scope `Map<number, Set<() => void>>` | no |
| `globalSubs` | module-scope `Set<() => void>` | no |
| `liveSlots` | let `Set<number>` | no |
| `globalNotifyTimer` | let `setTimeout \| null` | no |
| `GLOBAL_NOTIFY_MS` | const `250` | no |
| `notifySlot(slotIdx)` | function | no |
| `notifyGlobalSoon()` | function | no |
| `setFusionLiveSlots(indices)` | function | yes |
| `applyFusionUpdate(update)` | function | yes |
| `clearFusionSlot(slotIdx)` | function | yes |
| `clearAllFusionSlots()` | function | yes |
| `getFusionSlot(slotIdx)` | function | yes |
| `getAllFusionSlots()` | function | yes |
| `subscribeFusionSlot(slotIdx, cb)` | function | yes |
| `subscribeFusionGlobal(cb)` | function | yes |
| `useFusionSlot(slotIdx)` | React hook | yes |
| `useFusionStoreRevision()` | React hook | yes |

**Imports:**
- `useEffect`, `useState` from `react`
- `FusionUpdate` (type) from `./types`

**Subscription model:**
- Per-slot: direct synchronous notify
- Global: debounced 250 ms via `notifyGlobalSoon()`

**React hooks:**
- `useFusionSlot`: subscribes to a single slot; re-renders on ticks; returns `FusionUpdate \| null`
- `useFusionStoreRevision`: subscribes to global; returns monotonically incrementing revision number

**`fusionPayloadEqual` compares 35+ fields of `FusionUpdate` including nested `slotCtx` array deep-equal check.**

---

### `src/context/FusionContext.tsx`

| Symbol | Kind | Exported |
|--------|------|----------|
| `isRunningEntry(s)` | function | no |
| `FusionContextValue` | interface | no |
| `FusionProvider({ children, stack })` | component | yes |
| `useFusionData()` | hook | yes |

**Imports:**
- `useCallback`, `useEffect`, `useMemo`, `useRef` from `react`
- `invoke` from `@tauri-apps/api/core`
- `FusionUpdate`, `StackEntry` (types) from `../lib/types`
- `resetAllBenchPortStates` from `../lib/benchPortStore`
- `applyFusionUpdate, clearAllFusionSlots, clearFusionSlot, getAllFusionSlots, getFusionSlot, setFusionLiveSlots` from `../lib/fusionSlotStore`
- `useTauriListen` from `../hooks/useTauriListen`
- `useFusionStoreRevision` from `../lib/fusionSlotStore`

**Tauri events handled:**
- `fusion-update` → `applyFusionUpdate(payload)`
- `slot-cleared` → `resetAllBenchPortStates()` + `clearFusionSlot(slot)`
- `engines-all-stopped` → `resetAllBenchPortStates()` + `clearAllFusionSlots()`

**Hydration:** calls `invoke("get_fusion_snapshots")` on mount and when missing slots detected.

---

## Cross-References

### Import Graph

```
fusionBenchTrayStore  ──→  ./storage                    (loadFusionBenchTray, saveFusionBenchTray, FusionBenchTrayState)
fusionBooterStore     ──→  @tauri-apps/api/event         (listen)
fusionBooterStore     ──→  ./debugFlags                  (frontendPollEnabled)
fusionBooterStore     ──→  ./types                       (LogBatch, SystemEvent)
fusionBooterStore     ──→  ./fusionLoadParser            (LOAD_PHASE_ORDER, LoadPhaseId, maxPhase, parseLoadLogLine)
fusionSlotStore       ──→  ./types                       (FusionUpdate)
FusionContext         ──→  ../lib/types                  (FusionUpdate, StackEntry)
FusionContext         ──→  ../lib/benchPortStore          (resetAllBenchPortStates)
FusionContext         ──→  ../lib/fusionSlotStore         (6 exports)
FusionContext         ──→  ../hooks/useTauriListen        (useTauriListen)
FusionContext         ──→  ../lib/fusionSlotStore         (useFusionStoreRevision — duplicate import above)
```

### Shared Tauri Events (cross-store coordination)

| Event | fusionBooterStore handler | FusionContext handler |
|-------|---------------------------|-----------------------|
| `slot-cleared` | `clearBooterSession(slot)` | `clearFusionSlot(slot)` + `resetAllBenchPortStates()` |
| `engines-all-stopped` | `clearAllBooterSessions()` | `clearAllFusionSlots()` + `resetAllBenchPortStates()` |

### Shared Types from `./types`

- `fusionBooterStore` uses `LogBatch` and `SystemEvent` (Tauri event payload shapes)
- `fusionSlotStore` uses `FusionUpdate` (telemetry data shape)
- `FusionContext` uses `FusionUpdate` and `StackEntry`

### `fusionLoadParser` consumers

- `fusionBooterStore` imports: `LOAD_PHASE_ORDER`, `LoadPhaseId`, `maxPhase`, `parseLoadLogLine`

### `benchPortStore` integration

- Only `FusionContext.tsx` imports from `../lib/benchPortStore` (`resetAllBenchPortStates`)
- Called on `slot-cleared` and `engines-all-stopped` events — couples port state lifecycle to fusion slot lifecycle

---

## Data Flow Notes

### 1. Engine Boot → Fusion Telemetry Pipeline

```
Engine (external process)
  │
  ├─ engine-log-batch ──────────────→ fusionBooterStore.processLogText
  │     (LogBatch { slot, entries[] })    parseLoadLogLine → session update → notify
  │
  ├─ engine-system ─────────────────→ fusionBooterStore (readiness detection)
  │
  ├─ engine-load-failed ────────────→ fusionBooterStore.markLoadFailed
  │
  └─ slot-cleared / engines-all-stopped ─→ clearBooterSession / clearAllBooterSessions

Engine (external process)
  │
  └─ fusion-update ────────────────→ FusionContext.useTauriListen
        (FusionUpdate { slotIdx, ... })     → applyFusionUpdate → fusionSlotStore
                                              fusionPayloadEqual dedup → notifySlot / notifyGlobalSoon
```

### 2. Boot Phase Ladder

```
BOOT LOOP (40ms poll)
  └─ tickPhaseLadder()
       for each session:
         logIdx = LOAD_PHASE_ORDER.indexOf(session.logPhase)
         dispIdx = LOAD_PHASE_ORDER.indexOf(session.phase)
         if dispIdx >= logIdx → skip
         if phase in DWELL_PHASES && under PHASE_DWELL_MS → skip
         session.phase = LOAD_PHASE_ORDER[dispIdx + 1]  (advance one step)
         bump(session) → notify(slotIdx)

LOG-DRIVEN advancement:
  processLogText() → applyLogPhase() uses maxPhase() to only advance (never regress)
  → triggers bump() on phase change
```

Phase order: `spawn → weights → kv → server → ready`

### 3. Fusion Slot Store Update Path

```
applyFusionUpdate(update)
  │
  ├─ liveSlots.has(update.slotIdx) ? → false: drop (stale/out-of-slot)
  ├─ fusionPayloadEqual(prev, update) ? → true: drop (no-op dedup)
  ├─ slots.set(update.slotIdx, update)
  ├─ notifySlot(update.slotIdx)       (sync, per-subscriber)
  └─ notifyGlobalSoon()               (debounced 250ms)
        │
        └─ setTimeout → globalSubs.forEach(cb)
```

### 4. React Integration

```
<FusionProvider stack={...}>
  │
  ├─ useMemo: compute liveSlotKey from running/loaded stack entries
  ├─ useEffect: setFusionLiveSlots(filteredStack) on key change
  ├─ useCallback: hydrateFromBackend() — invoke("get_fusion_snapshots")
  ├─ useEffect: fire hydrate on mount
  ├─ useEffect: re-hydrate if running slots missing FusionUpdate
  ├─ useTauriListen("fusion-update") → applyFusionUpdate
  ├─ useTauriListen("slot-cleared") → clearFusionSlot
  ├─ useTauriListen("engines-all-stopped") → clearAllFusionSlots
  │
  useFusionData()
    ├─ useFusionStoreRevision() → throttled counter
    └─ useMemo: { engines, getEngine } → stable ref until revision changes
```

### 5. Tray Store (Isolated)

```
Module singleton: trayState (loaded from localStorage via storage module)
  ├─ setFusionBenchTray(next) → save to storage → notify listeners
  ├─ toggleFusionBenchTray() → setFusionBenchTray(stowed↔open)
  ├─ getFusionBenchTrayOpen() → trayState === "open"
  └─ subscribeFusionBenchTray(cb) → adds cb; returns unsubscribe
       (also calls refreshFusionBenchTrayFromStorage on subscribe)
```

### 6. Key Observations

- **No direct cross-import** between `fusionBooterStore`, `fusionSlotStore`, and `fusionBenchTrayStore` — they are independent module-singleton stores coordinated purely through Tauri events.
- **`FusionContext.tsx` is the integration layer** that wires IPC events into `fusionSlotStore` and also calls `benchPortStore.resetAllBenchPortStates()`.
- **`fusionBooterStore` is the only consumer of `fusionLoadParser`** — it uses `parseLoadLogLine` to interpret engine log lines into session state transitions.
- **Deduplication strategy differs:** `fusionSlotStore` uses a 35-field `fusionPayloadEqual` shallow-ish comparison; `fusionBenchTrayStore` uses reference equality on the state value.
- **`ensureGlobalListeners()` in `fusionBooterStore`** is lazy-singleton — called once on first `subscribeBooterSession` or `initBooterSession`.
- **Dual polling in `fusionBooterStore`** (when `frontendPollEnabled`): 40 ms phase ladder + 500 ms ping counter. Both gated on the same flag — likely a dev/debug feature.
- **Potential stale-state risk:** `fusionBooterStore`'s `initBooterSession` returns existing session if `port` matches and not failed, but does not reset phase — a restarted engine on same port would retain prior phase state.
