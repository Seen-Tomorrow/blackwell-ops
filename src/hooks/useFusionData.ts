import { useState, useEffect, useRef } from "react";
import type { FusionUpdate } from "../lib/types";

export function useFusionData() {
  const [engines, setEngines] = useState<Map<number, FusionUpdate>>(new Map());
  const mapRef = useRef<Map<number, FusionUpdate>>(new Map());

  useEffect(() => {
    // Check if we're in Tauri environment
    const tauriListen = (window as any).__TAURI__?.event?.listen;
    if (!tauriListen) return;

    let unlistenFusion: (() => void) | null = null;
    let unlistenCleared: (() => void) | null = null;

    tauriListen("fusion-update", (event: any) => {
      const payload: FusionUpdate = event.payload;
      const map = mapRef.current;
      // Key by slotIdx — unique per engine, no alias collision possible
      map.set(payload.slotIdx, payload);
      setEngines(new Map(map));
    }).then((u: any) => { unlistenFusion = u; });

    // Remove fusion entry when slot is cleared — prevents stale overlay
    tauriListen("slot-cleared", (event: any) => {
      const payload = event.payload as { slot: number };
      if (payload && payload.slot !== undefined) {
        const map = mapRef.current;
        map.delete(payload.slot);
        setEngines(new Map(map));
      }
    }).then((u: any) => { unlistenCleared = u; });

    return () => {
      unlistenFusion?.();
      unlistenCleared?.();
    };
  }, []);

  return {
    engines: Array.from(engines.values()),
    getEngine: (slotIdx: number) => engines.get(slotIdx) ?? null,
  };
}
