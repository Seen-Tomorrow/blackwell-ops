import type { GpuInfo, UserEditedTemplateParam, VramManifest } from "./types";
import { resolveVisibleParamValue } from "./paramConfigResolve";
import {
  computeGpuAvailableList,
  type RunningSlotInfo,
} from "../services/vram/scenarios/scenarios_factory";

function headroomGb(capacityGb: number): number {
  return Math.max(1.0, capacityGb * 0.03);
}

/** True when the forecast manifest projects load on more than one GPU. */
export function forecastUsesMultiGpu(manifest: VramManifest | null): boolean {
  if (!manifest) return false;
  return manifest.gpuAllocations.filter((a) => a.projectedLoadGb > 0.1).length > 1;
}

/**
 * Promote layer-split when the estimate exceeds the best single GPU's free VRAM.
 * Does not require fitting in pooled VRAM — --fit may reduce actual usage (MoE, etc.).
 */
export function needsAutoLayerSplit(
  estimateGb: number,
  perGpuAvailable: number[],
): boolean {
  if (perGpuAvailable.length <= 1) return false;
  const bestSingle = Math.max(...perGpuAvailable, 0);
  return estimateGb > bestSingle - headroomGb(bestSingle);
}

/** Authoritative split decision — must match AUTO_FIT forecast bars. */
export function resolveAutoLayerSplit(opts: {
  manifest: VramManifest | null;
  weightGb: number;
  perGpuAvailable: number[];
}): boolean {
  const { manifest, weightGb, perGpuAvailable } = opts;
  if (manifest?.autoLayerSplit === true) return true;
  if (forecastUsesMultiGpu(manifest)) return true;
  const formulaGb = manifest?.formulaVramTotalGb ?? manifest?.vramTotalGb ?? 0;
  const learnedGb = manifest?.learnedFromPreviousRun ? manifest.vramTotalGb : 0;
  const estimateGb = Math.max(formulaGb, learnedGb, weightGb * 1.05);
  return needsAutoLayerSplit(estimateGb, perGpuAvailable);
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
  weightGb: number;
  fullAutoMode?: boolean;
  memoryMode?: "full_auto" | "assisted";
}): Record<string, unknown> {
  const { config, launchKeys, paramDefs, gpus, runningSlots, manifest, weightGb, fullAutoMode, memoryMode } = opts;

  const perGpu = computeGpuAvailableList(gpus, runningSlots);
  const autoSplit = resolveAutoLayerSplit({ manifest, weightGb, perGpuAvailable: perGpu });

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
      }
    } else {
      const userSplit = config.split != null ? String(config.split).trim().toLowerCase() : "";
      if (userSplit.length > 0 && userSplit !== "none") {
        params.split = userSplit;
        params.gpu_sync = config.gpu_sync ?? "1";
      } else if (autoSplit) {
        params.split = "layer";
        params.gpu_sync = config.gpu_sync ?? "1";
      }
    }
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