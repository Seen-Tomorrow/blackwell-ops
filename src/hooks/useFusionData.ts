import { useState, useEffect, useRef } from "react";
import type { FusionUpdate } from "../lib/types";

export function useFusionData() {
  const [engines, setEngines] = useState<Map<string, FusionUpdate>>(new Map());
  const mapRef = useRef<Map<string, FusionUpdate>>(new Map());

  useEffect(() => {
    // Check if we're in Tauri environment
    const tauriListen = (window as any).__TAURI__?.event?.listen;
    if (!tauriListen) return;

    const unlisten = tauriListen("fusion-update", (event: any) => {
      const payload: FusionUpdate = event.payload;
      const map = mapRef.current;
      map.set(payload.alias, payload);

      // Remove stale entries (engines that have been stopped for 10+ seconds without updates)
      // This is handled by the Rust side emitting IDLE on shutdown
      setEngines(new Map(map));
    });

    return () => {
      unlisten.then((u: any) => u()).catch(() => {});
    };
  }, []);

  return {
    engines: Array.from(engines.values()),
    getEngine: (alias: string) => engines.get(alias) ?? null,
  };
}
