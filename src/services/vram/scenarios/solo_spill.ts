import { ScenarioInput, ComputedValues, buildManifest } from "./scenarios_factory";
import type { VramManifest } from "../../../lib/types";

/**
 * SOLO_SPILL — Fill target GPU to 95%, spill remainder layers to RAM.
 */
export function tryEvaluate(input: ScenarioInput, computed: ComputedValues): VramManifest | null {
  const { vramTotalGb, singleMaxAvailable, overheadGb, visionGb, weightsGb, kvCacheGb, targetGpuIdx, splitActive, numGpus } = computed;

  // Guard: spill must be positive and fit in available RAM, split not active
  const gpuCapacity = singleMaxAvailable * 0.95;
  const spillGb = vramTotalGb - gpuCapacity;
  if (spillGb <= 0) return null;
  if (spillGb > input.ramAvailableGb) return null;
  if (splitActive) return null;

  // Calculate layer split
  const nLayer = input.modelMeta.n_layer;
  const perLayerGb = weightsGb / nLayer;
  const kvPerLayer = kvCacheGb / nLayer;
  const availableForWeightsAndKv = gpuCapacity - overheadGb - visionGb;
  const gpuLayers = (perLayerGb + kvPerLayer) > 0
    ? Math.floor(availableForWeightsAndKv / (perLayerGb + kvPerLayer))
    : nLayer;
  const clampedGpuLayers = Math.min(gpuLayers, nLayer);
  const ramLayers = Math.max(0, nLayer - clampedGpuLayers);

  const perGpuLoad = Array(numGpus).fill(0);
  perGpuLoad[targetGpuIdx] = gpuCapacity;

  return buildManifest(
    input, computed,
    "SOLO_SPILL",
    {
      titleColor: "text-red-500",
      gpuBarColor: "bg-red-500",
      borderColor: "border-red-500/30",
      bgTint: "bg-red-500/5",
      badgeBg: "bg-red-500/20",
      icon: "◐",
      label: "SOLO SPILL",
      ramVisible: true,
    },
    clampedGpuLayers * perLayerGb, clampedGpuLayers * kvPerLayer, overheadGb + visionGb,
    ramLayers * perLayerGb, 0, true,
    `${ramLayers} layers in RAM — expect slower inference`,
    clampedGpuLayers, ramLayers, perGpuLoad,
  );
}
