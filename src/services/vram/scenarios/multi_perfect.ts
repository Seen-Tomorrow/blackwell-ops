import { ScenarioInput, ComputedValues, buildManifest, gpuManufacturedMib } from "./scenarios_factory";
import type { VramManifest } from "../../../lib/types";

/**
 * MULTI_PERFECT — Distributed across GPUs, all under 85% utilization.
 */
export function tryEvaluate(input: ScenarioInput, computed: ComputedValues): VramManifest | null {
  const { vramTotalGb, singleMaxAvailable, multiTotalAvailable, splitActive, gpuAvailable, numGpus } = computed;

  // Guard: must be multi-GPU scenario (split active OR doesn't fit on one GPU)
  if (!(numGpus > 1 && (splitActive || vramTotalGb > singleMaxAvailable * 0.95))) return null;

  // Must fit across all GPUs within fill target
  if (vramTotalGb > multiTotalAvailable * 0.95) return null;

  // Distribute load proportionally by available VRAM
  const perGpuLoad = gpuAvailable.map(avail =>
    multiTotalAvailable > 0 ? vramTotalGb * (avail / multiTotalAvailable) : vramTotalGb / numGpus,
  );

  // Guard: no GPU exceeds 85% — if any does, this is MULTI_PRESSURE instead
  const hasPressure = perGpuLoad.some((load, i) => {
    const total = gpuManufacturedMib(input.gpus[i]) / 1024;
    return total > 0 && load / total > 0.85;
  });
  if (hasPressure) return null;

  return buildManifest(
    input, computed,
    "MULTI_PERFECT",
    {
      titleColor: "text-cyan-400",
      gpuBarColor: "bg-green",
      borderColor: "border-cyan-400/30",
      bgTint: "bg-cyan-400/5",
      badgeBg: "bg-cyan-400/20",
      icon: "◆",
      label: "MULTI PERFECT",
      ramVisible: false,
    },
    computed.weightsGb, computed.kvCacheGb, computed.overheadGb + computed.visionGb,
    0, 0, true, "",
    input.modelMeta.n_layer, 0, perGpuLoad,
  );
}
