import type { GpuInfo, VramManifest } from "./types";
import { needsAutoLayerSplit, bestVramEstimateGb, gpuHeadroomGb } from "./autoVramLaunch";
import {
  computeGpuAvailableList,
  type RunningSlotInfo,
} from "../services/vram/scenarios/scenarios_factory";

export type LaunchMemoryMode = "full_auto" | "assisted";

export interface LaunchChromePolicy {
  mode: LaunchMemoryMode;
  /** FULL AUTO — hatched, non-interactive chrome. */
  chromeDisabled: boolean;
  deviceLocked: boolean;
  splitLocked: boolean;
  hideSplitNone: boolean;
  reason?: string;
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

  if (opts.manifest && !opts.manifest.fits) {
    return {
      mode,
      chromeDisabled: false,
      deviceLocked: true,
      splitLocked: true,
      hideSplitNone: true,
      reason: "Insufficient memory for this configuration",
    };
  }

  if (needsMultiGpu) {
    return {
      mode,
      chromeDisabled: false,
      deviceLocked: true,
      splitLocked: false,
      hideSplitNone: true,
      reason: "Model needs multiple GPUs — device locked to ALL",
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
