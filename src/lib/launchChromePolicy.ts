import type { GpuInfo, VramManifest } from "./types";
import type { RunningSlotInfo } from "../services/vram/shared";

type LaunchMemoryMode = "full_auto" | "assisted";

export interface LaunchChromePolicy {
  mode: LaunchMemoryMode;
  /** FULL AUTO — hatched, non-interactive chrome. */
  chromeDisabled: boolean;
  deviceLocked: boolean;
  splitLocked: boolean;
  hideSplitNone: boolean;
}

export function resolveLaunchChromePolicy(opts: {
  fullAutoMode: boolean;
  gpus: GpuInfo[];
  config: Record<string, unknown>;
  manifest: VramManifest | null;
  runningSlots: RunningSlotInfo[];
}): LaunchChromePolicy {
  const mode: LaunchMemoryMode = opts.fullAutoMode ? "full_auto" : "assisted";

  if (mode === "full_auto") {
    return {
      mode,
      chromeDisabled: true,
      deviceLocked: true,
      splitLocked: true,
      hideSplitNone: false,
    };
  }

  return {
    mode,
    chromeDisabled: false,
    deviceLocked: false,
    splitLocked: opts.gpus.length <= 1,
    hideSplitNone: false,
  };
}
