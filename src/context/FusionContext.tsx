import { useCallback, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FusionUpdate, StackEntry } from "../lib/types";
import { resetAllBenchPortStates } from "../lib/benchPortStore";
import {
  applyFusionUpdate,
  clearAllFusionSlots,
  clearFusionSlot,
  getAllFusionSlots,
  getFusionSlot,
  setFusionLiveSlots,
} from "../lib/fusionSlotStore";
import { useTauriListen } from "../hooks/useTauriListen";
import { useFusionStoreRevision } from "../lib/fusionSlotStore";

function isRunningEntry(s: StackEntry): boolean {
  return s.status === "RUNNING" || s.status === "LOADING";
}

interface FusionContextValue {
  engines: FusionUpdate[];
  getEngine: (slotIdx: number) => FusionUpdate | null;
}

/** App-wide fusion telemetry — external store + per-slot subscriptions (no 25ms React map clone). */
export function FusionProvider({
  children,
  stack,
}: {
  children: React.ReactNode;
  stack: StackEntry[];
}) {
  const stackRef = useRef(stack);
  stackRef.current = stack;

  const liveSlotKey = useMemo(
    () => stack.filter(isRunningEntry).map((s) => s.idx).join(","),
    [stack],
  );

  useEffect(() => {
    setFusionLiveSlots(stack.filter(isRunningEntry).map((s) => s.idx));
  }, [liveSlotKey, stack]);

  const hydrateFromBackend = useCallback(async () => {
    try {
      const snapshots = await invoke<FusionUpdate[]>("get_fusion_snapshots");
      const runningSlots = new Set(
        stackRef.current.filter(isRunningEntry).map((s) => s.idx),
      );
      if (snapshots.length === 0 || runningSlots.size === 0) return;

      for (const snap of snapshots) {
        if (!runningSlots.has(snap.slotIdx)) continue;
        applyFusionUpdate(snap);
      }
    } catch {
      // Backend may be older build during dev — live events still work
    }
  }, []);

  useEffect(() => {
    void hydrateFromBackend();
  }, [hydrateFromBackend]);

  useEffect(() => {
    const missing = stack.some(
      (s) => isRunningEntry(s) && s.supportsFusion !== false && !getFusionSlot(s.idx),
    );
    if (missing) void hydrateFromBackend();
  }, [stack, hydrateFromBackend]);

  useTauriListen<FusionUpdate>("fusion-update", (payload) => {
    applyFusionUpdate(payload);
  });

  useTauriListen<{ slot: number }>("slot-cleared", (payload) => {
    if (payload?.slot === undefined) return;
    resetAllBenchPortStates();
    clearFusionSlot(payload.slot);
  });

  useTauriListen<{ slots: number[] }>("engines-all-stopped", () => {
    resetAllBenchPortStates();
    clearAllFusionSlots();
  });

  return <>{children}</>;
}

export function useFusionData(): FusionContextValue {
  const revision = useFusionStoreRevision();
  const getEngine = useCallback((slotIdx: number) => getFusionSlot(slotIdx), []);
  return useMemo(
    () => ({
      engines: getAllFusionSlots(),
      getEngine,
    }),
    [revision, getEngine],
  );
}