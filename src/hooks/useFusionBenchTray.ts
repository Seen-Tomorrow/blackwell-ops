import { useEffect, useState } from "react";
import {
  getFusionBenchTrayOpen,
  refreshFusionBenchTrayFromStorage,
  setFusionBenchTray,
  subscribeFusionBenchTray,
  toggleFusionBenchTray,
} from "../lib/fusionBenchTrayStore";
import type { FusionBenchTrayState } from "../lib/storage";

export type { FusionBenchTrayState };

/** Fusion overlay benchmark tray — open exposes bench controls + results. */
export function useFusionBenchTray() {
  const [, bump] = useState(0);

  useEffect(() => {
    refreshFusionBenchTrayFromStorage();
    return subscribeFusionBenchTray(() => bump((t) => t + 1));
  }, []);

  return {
    open: getFusionBenchTrayOpen(),
    stowed: !getFusionBenchTrayOpen(),
    toggle: toggleFusionBenchTray,
    setTray: setFusionBenchTray,
  };
}