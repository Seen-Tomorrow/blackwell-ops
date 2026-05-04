import { ScenarioInput, ComputedValues, buildManifest, gpuManufacturedMib } from "./scenarios_factory";
import type { VramManifest } from "../../../lib/types";

/**
 * MULTI_PRESSURE — Distributed across GPUs, at least one GPU exceeds 85%.
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

  // Guard: at least one GPU must exceed 85% — otherwise this is MULTI_PERFECT
  const hasPressure = perGpuLoad.some((load, i) => {
    const total = gpuManufacturedMib(input.gpus[i]) / 1024;
    return total > 0 && load / total > 0.85;
  });
  if (!hasPressure) return null;

  return buildManifest(
    input, computed,
    "MULTI_PRESSURE",
    {
      titleColor: "text-orange-400",
      gpuBarColor: "bg-orange-400",
      borderColor: "border-orange-400/30",
      bgTint: "bg-orange-400/5",
      badgeBg: "bg-orange-400/20",
      icon: "◆",
      label: "MULTI PRESSURE",
      ramVisible: false,
    },
    computed.weightsGb, computed.kvCacheGb, computed.overheadGb + computed.visionGb,
    0, 0, true, "",
    input.modelMeta.n_layer, 0, perGpuLoad,
  );
}
