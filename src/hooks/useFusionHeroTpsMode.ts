import { useCallback, useState } from "react";
import {
  loadFusionHeroTpsMode,
  saveFusionHeroTpsMode,
  type FusionHeroTpsMode,
} from "../lib/storage";

export type { FusionHeroTpsMode };

/** LIVE = per-chunk/poll TPS; AVG = session average (bench-aligned). */
export function useFusionHeroTpsMode() {
  const [mode, setMode] = useState<FusionHeroTpsMode>(loadFusionHeroTpsMode);

  const toggle = useCallback(() => {
    setMode((prev) => {
      const next: FusionHeroTpsMode = prev === "live" ? "avg" : "live";
      saveFusionHeroTpsMode(next);
      return next;
    });
  }, []);

  return { mode, toggle };
}