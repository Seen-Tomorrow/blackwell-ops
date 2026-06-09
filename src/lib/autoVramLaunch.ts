import type { GpuInfo, VramManifest } from "./types";
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
 * Build extra_params for an Auto VRAM launch.
 * Split decision follows the forecast manifest (what the user sees).
 */
export function buildAutoVramLaunchParams(opts: {
  config: Record<string, unknown>;
  simpleKeys: string[];
  gpus: GpuInfo[];
  runningSlots: RunningSlotInfo[];
  manifest: VramManifest | null;
  weightGb: number;
}): Record<string, unknown> {
  const { config, simpleKeys, gpus, runningSlots, manifest, weightGb } = opts;

  const perGpu = computeGpuAvailableList(gpus, runningSlots);
  const autoSplit = resolveAutoLayerSplit({ manifest, weightGb, perGpuAvailable: perGpu });

  const params: Record<string, unknown> = { __auto_vram: true };
  for (const key of simpleKeys) {
    if (config[key] !== undefined) {
      params[key] = config[key];
    }
  }
  params.split = autoSplit ? "layer" : "none";
  if (autoSplit) {
    params.gpu_sync = config.gpu_sync ?? "1";
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