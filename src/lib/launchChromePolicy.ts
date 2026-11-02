import type { GpuInfo, VramManifest } from "./types";
import { needsAutoLayerSplit, bestVramEstimateGb, gpuHeadroomGb } from "./autoVramLaunch";
import {
  computeGpuAvailableList,
  type RunningSlotInfo,
} from "../services/vram/scenarios/scenarios_factory";

type LaunchMemoryMode = "full_auto" | "assisted";

export interface LaunchChromePolicy {
  mode: LaunchMemoryMode;
  /** FULL AUTO — hatched, non-interactive chrome. */
  chromeDisabled: boolean;
  deviceLocked: boolean;
  splitLocked: boolean;
  hideSplitNone: boolean;
}

function parseTargetGpuIdx(device: unknown): number {
  const deviceStr = String(device ?? "GPU-0");
  return parseInt(deviceStr.replace(/^GPU-/i, "").split("/")[0], 10) || 0;
}

function isSplitActive(split: unknown): boolean {
  const mode = String(split ?? "none").trim().toLowerCase();
  return mode.length > 0 && mode !== "none";
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

  if (opts.gpus.length <= 1) {
    return {
      mode,
      chromeDisabled: false,
      deviceLocked: false,
      splitLocked: true,
      hideSplitNone: false,
    };
  }

  const perGpu = computeGpuAvailableList(opts.gpus, opts.runningSlots);
  const targetIdx = parseTargetGpuIdx(opts.config.device);
  const splitActive = isSplitActive(opts.config.split);

  const estimateGb = bestVramEstimateGb(opts.manifest);
  const selectedAvail = perGpu[targetIdx] ?? 0;
  const fitsOnSelected = estimateGb <= selectedAvail - gpuHeadroomGb(selectedAvail);
  const needsMultiGpu =
    !fitsOnSelected && needsAutoLayerSplit(estimateGb, perGpu);

  // ASSISTED only: an explicit SPLIT=NONE is a placement decision, not a missing
  // one. A deliberate single-GPU spill is legitimate whenever VRAM+RAM can hold the
  // model, so a multi-GPU suggestion must never lock the device picker or hide NONE.
  // AUTOPILOT keeps the old auto-promotion behaviour.
  const explicitSingleGpu = mode === "assisted" && !splitActive;

  if (needsMultiGpu && !explicitSingleGpu) {
    return {
      mode,
      chromeDisabled: false,
      deviceLocked: true,
      splitLocked: false,
      /** AUTOPILOT returned above, so this is ASSISTED: always offer the way back to NONE. */
      hideSplitNone: false,
      // No amber bezel banner — locks alone communicate multi-GPU.
    };
  }

  if (splitActive) {
    return {
      mode,
      chromeDisabled: false,
      deviceLocked: true,
      splitLocked: false,
      hideSplitNone: false,
    };
  }

  return {
    mode,
    chromeDisabled: false,
    deviceLocked: false,
    splitLocked: false,
    hideSplitNone: false,
  };
}
