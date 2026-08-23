import type { GpuInfo, UserEditedTemplateParam, VramManifest } from "./types";
import { resolveVisibleParamValue } from "./paramConfigResolve";
import {
  computeGpuAvailableList,
  type RunningSlotInfo,
} from "../services/vram/scenarios/scenarios_factory";
import { fullAutoSingleDeviceLabel } from "./fullAutoGpuPick";

export {
  gpuArchFamily,
  pickFullAutoSingleGpuIndex,
  pickFullAutoSingleGpuListPos,
  fullAutoSingleDeviceLabel,
} from "./fullAutoGpuPick";

export function gpuHeadroomGb(capacityGb: number): number {
  return Math.max(1.0, capacityGb * 0.03);
}

/** True when the forecast manifest projects load on more than one GPU. */
export function forecastUsesMultiGpu(manifest: VramManifest | null): boolean {
  if (!manifest) return false;
  return manifest.gpuAllocations.filter((a) => a.projectedLoadGb > 0.1).length > 1;
}

/**
 * GPU-side total forecast already committed (measured only).
 */
export function bestVramEstimateGb(manifest: VramManifest | null): number {
  if (!manifest) return 0;
  return manifest.vramTotalGb ?? 0;
}

/** Promote layer-split when the estimate exceeds the best single GPU's free VRAM. */
export function needsAutoLayerSplit(
  estimateGb: number,
  perGpuAvailable: number[],
): boolean {
  if (perGpuAvailable.length <= 1) return false;
  const bestSingle = Math.max(...perGpuAvailable, 0);
  return estimateGb > bestSingle - gpuHeadroomGb(bestSingle);
}

export interface SplitDriver {
  label: string;
  measured: boolean;
  estimateGb: number;
  willSplit: boolean;
}

export function resolveSplitDriver(manifest: VramManifest | null): SplitDriver | null {
  if (!manifest) return null;
  const kind = manifest.memorySource?.kind;
  const measured =
    !!manifest.learnedFromPreviousRun
    || !!manifest.learnedInterpolated
    || !!manifest.validatedVramMib
    || kind === "fit_probe"
    || kind === "learned"
    || kind === "learned_curve";
  const label =
    kind === "learned" || kind === "learned_curve" || manifest.learnedFromPreviousRun || manifest.learnedInterpolated
      ? "LEARNED"
      : "FIT";
  const estimateGb = bestVramEstimateGb(manifest);
  const perGpu = manifest.gpuAllocations?.map((a) => a.vramAvailableGb) ?? [];
  const willSplit = resolveAutoLayerSplit({ manifest, perGpuAvailable: perGpu });
  return { label, measured, estimateGb, willSplit };
}

/** Same number as AUTO_FIT bars: estimate vs free VRAM. No flag / bar-shape override. */
export function resolveAutoLayerSplit(opts: {
  manifest: VramManifest | null;
  perGpuAvailable: number[];
}): boolean {
  return needsAutoLayerSplit(bestVramEstimateGb(opts.manifest), opts.perGpuAvailable);
}

/**
 * Build extra_params for an AUTO FIT launch.
 * Pass the same launch key set as MANUAL (ESS/FULL); FIT owns VRAM/RAM offload via __auto_vram.
 * Split decision follows the forecast manifest when the user has not chosen a split mode.
 */
export function buildAutoVramLaunchParams(opts: {
  config: Record<string, unknown>;
  launchKeys: string[];
  paramDefs?: UserEditedTemplateParam[];
  gpus: GpuInfo[];
  runningSlots: RunningSlotInfo[];
  manifest: VramManifest | null;
  fullAutoMode?: boolean;
  memoryMode?: "full_auto" | "assisted";
}): Record<string, unknown> {
  const { config, launchKeys, paramDefs, gpus, runningSlots, manifest, fullAutoMode, memoryMode } = opts;

  const perGpu = computeGpuAvailableList(gpus, runningSlots);
  const autoSplit = resolveAutoLayerSplit({ manifest, perGpuAvailable: perGpu });

  const params: Record<string, unknown> = {
    __auto_vram: true,
    __memory_mode: memoryMode ?? (fullAutoMode ? "full_auto" : "assisted"),
    ...(fullAutoMode ? { offload_mode: "regular" } : {}),
  };
  for (const key of launchKeys) {
    if (key === "split") continue;
    if (fullAutoMode && (key === "device" || key === "split" || key === "offload_mode")) continue;
    const value = paramDefs?.length
      ? resolveVisibleParamValue(key, config, paramDefs)
      : config[key];
    if (value !== undefined) {
      params[key] = value;
    }
  }

  // Multi-GPU split — ASSISTED: user choice wins; FULL AUTO: FIT/forecast only (no persisted chrome).
  if (gpus.length > 1 && params.split === undefined) {
    if (fullAutoMode) {
      if (autoSplit) {
        params.split = "layer";
        params.gpu_sync = config.gpu_sync ?? "1";
        // Split mask = all GPUs; device chrome ignored by CUDA mask helper.
      } else {
        // Single-GPU Full Auto: freest card among same-arch peers (not always GPU-0).
        params.device = fullAutoSingleDeviceLabel(gpus, perGpu);
      }
    } else {
      const userSplit = config.split != null ? String(config.split).trim().toLowerCase() : "";
      if (userSplit.length > 0 && userSplit !== "none") {
        params.split = userSplit;
        params.gpu_sync = config.gpu_sync ?? "1";
      }
      // NONE / unset: stay on the selected device. No auto layer-shift in ASSISTED.
    }
  } else if (fullAutoMode && gpus.length >= 1 && params.split === undefined && !autoSplit) {
    params.device = fullAutoSingleDeviceLabel(gpus, perGpu);
  }

  return params;
}

/** Per-GPU projected load when auto-split distributes proportional to free VRAM. */
export function autoSplitPerGpuLoad(
  estimateGb: number,
  gpus: GpuInfo[],
  gpuAvailable: number[],
): number[] {
  const totalAvail = gpuAvailable.reduce((a, b) => a + b, 0);
  return gpus.map((_, i) => {
    if (totalAvail > 0) {
      return estimateGb * (gpuAvailable[i] / totalAvail);
    }
    return estimateGb / gpus.length;
  });
}