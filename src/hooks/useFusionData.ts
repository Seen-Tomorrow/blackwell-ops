import { useState, useEffect, useRef } from "react";
import type { FusionUpdate } from "../lib/types";

export function useFusionData() {
  const [engines, setEngines] = useState<Map<number, FusionUpdate>>(new Map());
  const mapRef = useRef<Map<number, FusionUpdate>>(new Map());

  useEffect(() => {
    // Check if we're in Tauri environment
    const tauriListen = (window as any).__TAURI__?.event?.listen;
    if (!tauriListen) return;

    const unlisten = tauriListen("fusion-update", (event: any) => {
      const payload: FusionUpdate = event.payload;
      const map = mapRef.current;
      // Key by slotIdx — unique per engine, no alias collision possible
      map.set(payload.slotIdx, payload);

      setEngines(new Map(map));
    });

    return () => {
      unlisten.then((u: any) => u()).catch(() => {});
    };
  }, []);

  return {
    engines: Array.from(engines.values()),
    getEngine: (slotIdx: number) => engines.get(slotIdx) ?? null,
  };
}
