import { useState, useEffect, useRef } from "react";
import type { FusionUpdate } from "../lib/types";

const RENDER_INTERVAL_MS = 100; // 10fps — halves GC pressure vs raw 50ms polling

export function useFusionData() {
  const [engines, setEngines] = useState<Map<number, FusionUpdate>>(new Map());
  const mapRef = useRef<Map<number, FusionUpdate>>(new Map());
  const lastRenderTime = useRef(0);
  // Refs survive StrictMode mount/unmount/remount — cleanup always gets the real unsubscribe
  const unlistenFusionRef = useRef<(() => void) | null>(null);
  const unlistenClearedRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Check if we're in Tauri environment
    const tauriListen = (window as any).__TAURI__?.event?.listen;
    if (!tauriListen) return;

    let cancelled = false;

    tauriListen("fusion-update", (event: any) => {
      if (cancelled) return;
      const payload: FusionUpdate = event.payload;
      const map = mapRef.current;
      // Key by slotIdx — unique per engine, no alias collision possible
      map.set(payload.slotIdx, payload);
      // Throttle React re-renders to 10fps — data is always current in ref
      if (Date.now() - lastRenderTime.current >= RENDER_INTERVAL_MS) {
        lastRenderTime.current = Date.now();
        setEngines(new Map(map));
      }
    }).then((u: any) => { if (!cancelled) unlistenFusionRef.current = u; });

    // Remove fusion entry when slot is cleared — prevents stale overlay
    tauriListen("slot-cleared", (event: any) => {
      if (cancelled) return;
      const payload = event.payload as { slot: number };
      if (payload && payload.slot !== undefined) {
        const map = mapRef.current;
        map.delete(payload.slot);
        setEngines(new Map(map));
      }
    }).then((u: any) => { if (!cancelled) unlistenClearedRef.current = u; });

    return () => {
      cancelled = true;
      unlistenFusionRef.current?.();
      unlistenClearedRef.current?.();
    };
  }, []);

  return {
    engines: Array.from(engines.values()),
    getEngine: (slotIdx: number) => engines.get(slotIdx) ?? null,
  };
}
