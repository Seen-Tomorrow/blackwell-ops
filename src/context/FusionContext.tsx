import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FusionUpdate, StackEntry } from "../lib/types";
import { resetAllBenchPortStates } from "../lib/benchPortStore";
import { useTauriListen } from "../hooks/useTauriListen";

/** Match backend fusion poll + log_hub stderr batch tick (`TELEMETRY_TICK_MS`). */
const RENDER_INTERVAL_MS = 25;

function isRunningEntry(s: StackEntry): boolean {
  return s.status === "RUNNING" || s.status === "LOADING";
}

/** Shallow compare hero + progress fields — skip map churn when IPC payload unchanged. */
function fusionPayloadEqual(a: FusionUpdate, b: FusionUpdate): boolean {
  return (
    a.phase === b.phase
    && a.engine_state === b.engine_state
    && a.prefillProgress === b.prefillProgress
    && a.prefillTokens === b.prefillTokens
    && a.prefillTokensTotal === b.prefillTokensTotal
    && a.prefillTpsSession === b.prefillTpsSession
    && (a.prefillTpsInstant ?? 0) === (b.prefillTpsInstant ?? 0)
    && a.prefillTpsMetrics === b.prefillTpsMetrics
    && a.genTps === b.genTps
    && (a.genTpsInstant ?? 0) === (b.genTpsInstant ?? 0)
    && a.genTokensPerRequestSlots === b.genTokensPerRequestSlots
    && a.genTokensPerSession === b.genTokensPerSession
    && a.ctxUsedSession === b.ctxUsedSession
    && a.ctxFillPct === b.ctxFillPct
    && a.requestElapsedMs === b.requestElapsedMs
    && (a.ttftMs ?? null) === (b.ttftMs ?? null)
    && (a.logPrefillProgress ?? 0) === (b.logPrefillProgress ?? 0)
    && (a.logPrefillTps ?? 0) === (b.logPrefillTps ?? 0)
    && (a.logPromptTokens ?? 0) === (b.logPromptTokens ?? 0)
    && (a.logGenTps ?? 0) === (b.logGenTps ?? 0)
    && a.logPhase === b.logPhase
    && a.slotCtx.length === b.slotCtx.length
    && a.slotCtx.every((s, i) => {
      const t = b.slotCtx[i];
      return (
        t != null
        && s.id === t.id
        && s.sessionNDecoded === t.sessionNDecoded
        && s.n_decoded === t.n_decoded
        && s.is_processing === t.is_processing
        && s.promptTokensProcessed === t.promptTokensProcessed
        && s.promptTokensCache === t.promptTokensCache
      );
    })
  );
}

interface FusionContextValue {
  engines: FusionUpdate[];
  getEngine: (slotIdx: number) => FusionUpdate | null;
}

const FusionContext = createContext<FusionContextValue | null>(null);

/** App-wide fusion telemetry — survives tab navigation (single listener + shared map). */
export function FusionProvider({
  children,
  stack,
}: {
  children: React.ReactNode;
  stack: StackEntry[];
}) {
  const [engines, setEngines] = useState<Map<number, FusionUpdate>>(new Map());
  const mapRef = useRef<Map<number, FusionUpdate>>(new Map());
  const lastRenderTime = useRef(0);
  const dirtyRef = useRef(false);
  const stackRef = useRef(stack);
  stackRef.current = stack;

  const flushIfDue = useCallback(() => {
    if (!dirtyRef.current) return;
    if (Date.now() - lastRenderTime.current < RENDER_INTERVAL_MS) return;
    dirtyRef.current = false;
    lastRenderTime.current = Date.now();
    setEngines(new Map(mapRef.current));
  }, []);

  const hydrateFromBackend = useCallback(async () => {
    try {
      const snapshots = await invoke<FusionUpdate[]>("get_fusion_snapshots");
      const runningSlots = new Set(
        stackRef.current.filter(isRunningEntry).map((s) => s.idx),
      );
      if (snapshots.length === 0 || runningSlots.size === 0) return;

      let changed = false;
      for (const snap of snapshots) {
        if (!runningSlots.has(snap.slotIdx)) continue;
        mapRef.current.set(snap.slotIdx, snap);
        changed = true;
      }
      if (changed) {
        dirtyRef.current = true;
        lastRenderTime.current = 0;
        flushIfDue();
      }
    } catch {
      // Backend may be older build during dev — live events still work
    }
  }, [flushIfDue]);

  useEffect(() => {
    void hydrateFromBackend();
  }, [hydrateFromBackend]);

  // Rehydrate when running engines exist but map lost entries (HMR, remount, missed idle emits)
  useEffect(() => {
    const missing = stack.some(
      (s) => isRunningEntry(s) && s.supportsFusion !== false && !mapRef.current.has(s.idx),
    );
    if (missing) void hydrateFromBackend();
  }, [stack, hydrateFromBackend]);

  useTauriListen<FusionUpdate>("fusion-update", (payload) => {
    const map = mapRef.current;
    const prev = map.get(payload.slotIdx);
    if (prev && fusionPayloadEqual(prev, payload)) {
      return;
    }
    map.set(payload.slotIdx, payload);
    dirtyRef.current = true;
    flushIfDue();
  });

  useTauriListen<{ slot: number }>("slot-cleared", (payload) => {
    if (payload?.slot === undefined) return;
    resetAllBenchPortStates();
    const map = mapRef.current;
    if (!map.has(payload.slot)) return;
    map.delete(payload.slot);
    dirtyRef.current = true;
    lastRenderTime.current = 0;
    flushIfDue();
  });

  useTauriListen<{ slots: number[] }>("engines-all-stopped", () => {
    resetAllBenchPortStates();
    if (mapRef.current.size === 0) return;
    mapRef.current.clear();
    dirtyRef.current = true;
    lastRenderTime.current = 0;
    setEngines(new Map());
  });

  const hasLiveEngines = stack.some(isRunningEntry);

  useEffect(() => {
    if (!hasLiveEngines) return;
    const id = window.setInterval(flushIfDue, RENDER_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [hasLiveEngines, flushIfDue]);

  const getEngine = useCallback(
    (slotIdx: number) => engines.get(slotIdx) ?? null,
    [engines],
  );

  const value = useMemo(
    () => ({
      engines: Array.from(engines.values()),
      getEngine,
    }),
    [engines, getEngine],
  );

  return <FusionContext.Provider value={value}>{children}</FusionContext.Provider>;
}

export function useFusionData(): FusionContextValue {
  const ctx = useContext(FusionContext);
  if (!ctx) {
    throw new Error("useFusionData must be used within FusionProvider");
  }
  return ctx;
}