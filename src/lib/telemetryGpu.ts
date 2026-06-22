import type { GpuInfo, VramManifest } from "./types";

export function bucketGpuMib(mib: number, bucketMib: number): number {
  if (bucketMib <= 0) return mib;
  return Math.round(mib / bucketMib);
}

/** Skip React state churn when NVML noise is within bucket/tolerance. */
export function gpuScanSnapshotEqual(
  prev: GpuInfo[],
  next: GpuInfo[],
  vramBucketMib: number,
): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (a.index !== b.index || a.name !== b.name) return false;
    if (a.memory_total !== b.memory_total) return false;
    if (a.memory_total_manufactured !== b.memory_total_manufactured) return false;
    if (bucketGpuMib(a.memory_used, vramBucketMib) !== bucketGpuMib(b.memory_used, vramBucketMib)) {
      return false;
    }
    if (bucketGpuMib(a.memory_free, vramBucketMib) !== bucketGpuMib(b.memory_free, vramBucketMib)) {
      return false;
    }
    if (Math.abs(a.temperature_gpu - b.temperature_gpu) > 2) return false;
    const hotA = a.temperature_hot_spot ?? -1;
    const hotB = b.temperature_hot_spot ?? -1;
    if (hotA >= 0 && hotB >= 0 && Math.abs(hotA - hotB) > 2) return false;
    if (Math.round(a.power_draw) !== Math.round(b.power_draw)) return false;
    if (Math.abs(a.utilization_gpu - b.utilization_gpu) > 2) return false;
    if (Math.abs(a.utilization_memory - b.utilization_memory) > 2) return false;
  }
  return true;
}

export function gpuMemoryBucketKey(gpus: GpuInfo[], bucketMib: number): string {
  if (gpus.length === 0) return "0";
  return gpus.map((g) => bucketGpuMib(g.memory_used, bucketMib)).join(",");
}

/** Skip manifest state replace when scenario output is unchanged for UI. */
export function vramManifestSnapshotEqual(
  prev: VramManifest | null,
  next: VramManifest | null,
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return false;
  if (
    prev.scenario !== next.scenario
    || prev.fits !== next.fits
    || prev.recommendation !== next.recommendation
    || prev.gpuLayers !== next.gpuLayers
    || prev.ramLayers !== next.ramLayers
    || prev.validatedVramMib !== next.validatedVramMib
    || prev.fitProbeMeasuredAt !== next.fitProbeMeasuredAt
    || prev.learnedFromPreviousRun !== next.learnedFromPreviousRun
    || prev.autoLayerSplit !== next.autoLayerSplit
    || prev.memorySource?.kind !== next.memorySource?.kind
  ) {
    return false;
  }
  const nums = (a: number, b: number, eps = 0.05) => Math.abs(a - b) < eps;
  if (
    !nums(prev.vramTotalGb, next.vramTotalGb)
    || !nums(prev.vramWeightsGb, next.vramWeightsGb)
    || !nums(prev.vramKvGb, next.vramKvGb)
    || !nums(prev.vramOverheadGb, next.vramOverheadGb)
    || !nums(prev.ramTotalGb, next.ramTotalGb)
    || !nums(prev.formulaVramTotalGb, next.formulaVramTotalGb)
  ) {
    return false;
  }
  if (prev.gpuAllocations.length !== next.gpuAllocations.length) return false;
  for (let i = 0; i < prev.gpuAllocations.length; i++) {
    const a = prev.gpuAllocations[i];
    const b = next.gpuAllocations[i];
    if (a.gpuIndex !== b.gpuIndex) return false;
    if (!nums(a.projectedLoadGb, b.projectedLoadGb)) return false;
    if (!nums(a.vramAvailableGb, b.vramAvailableGb)) return false;
    if (!nums(a.vramManufacturedGb, b.vramManufacturedGb)) return false;
    if (a.runningEngines.length !== b.runningEngines.length) return false;
    for (let j = 0; j < a.runningEngines.length; j++) {
      const ra = a.runningEngines[j];
      const rb = b.runningEngines[j];
      if (ra.slotAlias !== rb.slotAlias || ra.modelShort !== rb.modelShort) return false;
      if (Math.abs(ra.vramUsedMib - rb.vramUsedMib) >= 64) return false;
    }
  }
  return true;
}