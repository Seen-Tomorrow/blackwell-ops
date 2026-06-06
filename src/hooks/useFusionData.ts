import { useState, useEffect, useRef } from "react";
import type { FusionUpdate } from "../lib/types";
import { useTauriListen } from "./useTauriListen";

const RENDER_INTERVAL_MS = 100;

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

export function useFusionData() {
  const [engines, setEngines] = useState<Map<number, FusionUpdate>>(new Map());
  const mapRef = useRef<Map<number, FusionUpdate>>(new Map());
  const lastRenderTime = useRef(0);
  const dirtyRef = useRef(false);

  const flushIfDue = () => {
    if (!dirtyRef.current) return;
    if (Date.now() - lastRenderTime.current < RENDER_INTERVAL_MS) return;
    dirtyRef.current = false;
    lastRenderTime.current = Date.now();
    setEngines(new Map(mapRef.current));
  };

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
    const map = mapRef.current;
    if (!map.has(payload.slot)) return;
    map.delete(payload.slot);
    dirtyRef.current = true;
    lastRenderTime.current = 0;
    flushIfDue();
  });

  useTauriListen<{ slots: number[] }>("engines-all-stopped", () => {
    if (mapRef.current.size === 0) return;
    mapRef.current.clear();
    dirtyRef.current = true;
    lastRenderTime.current = 0;
    setEngines(new Map());
  });

  useEffect(() => {
    const id = window.setInterval(flushIfDue, RENDER_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  return {
    engines: Array.from(engines.values()),
    getEngine: (slotIdx: number) => engines.get(slotIdx) ?? null,
  };
}