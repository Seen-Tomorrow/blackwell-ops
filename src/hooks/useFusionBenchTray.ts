import { useEffect, useState } from "react";
import {
  getFusionBenchTrayOpen,
  setFusionBenchTray,
  subscribeFusionBenchTray,
  toggleFusionBenchTray,
  type FusionBenchTrayState,
} from "../lib/fusionBenchTrayStore";

export type { FusionBenchTrayState };

/** Fusion overlay benchmark tray — session memory, always starts stowed. Control knobs persist separately. */
export function useFusionBenchTray() {
  const [, bump] = useState(0);

  useEffect(() => subscribeFusionBenchTray(() => bump((t) => t + 1)), []);

  return {
    open: getFusionBenchTrayOpen(),
    stowed: !getFusionBenchTrayOpen(),
    toggle: toggleFusionBenchTray,
    setTray: setFusionBenchTray,
  };
}
