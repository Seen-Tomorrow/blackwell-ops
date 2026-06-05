import { useCallback, useState } from "react";

export type FusionHeroTpsMode = "live" | "avg";

const STORAGE_KEY = "blackops-fusion-hero-tps";

function readMode(): FusionHeroTpsMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "avg" ? "avg" : "live";
  } catch {
    return "live";
  }
}

/** LIVE = per-chunk/poll TPS; AVG = session average (bench-aligned). */
export function useFusionHeroTpsMode() {
  const [mode, setMode] = useState<FusionHeroTpsMode>(readMode);

  const toggle = useCallback(() => {
    setMode((prev) => {
      const next: FusionHeroTpsMode = prev === "live" ? "avg" : "live";
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  return { mode, toggle };
}