import { ScenarioInput, ComputedValues, buildManifest } from "./scenarios_factory";
import type { VramManifest } from "../../../lib/types";

/**
 * TOTAL_SPILL — Fill ALL GPUs to 95%, spill rest of layers to RAM.
 */
export function tryEvaluate(input: ScenarioInput, computed: ComputedValues): VramManifest | null {
  const { vramTotalGb, multiTotalAvailable, overheadGb, visionGb, weightsGb, kvCacheGb, gpuAvailable, numGpus } = computed;

  // Guard: spill must be positive and fit in available RAM
  const totalCapacity = multiTotalAvailable * 0.95;
  const spillGb = vramTotalGb - totalCapacity;
  if (spillGb <= 0) return null;
  if (spillGb > input.ramAvailableGb) return null;

  // Calculate layer split across all GPUs
  const nLayer = input.modelMeta.n_layer;
  const perLayerGb = weightsGb / nLayer;
  const kvPerLayer = kvCacheGb / nLayer;
  const availableForWeightsAndKv = totalCapacity - overheadGb - visionGb;
  const gpuLayers = (perLayerGb + kvPerLayer) > 0
    ? Math.floor(availableForWeightsAndKv / (perLayerGb + kvPerLayer))
    : nLayer;
  const clampedGpuLayers = Math.min(gpuLayers, nLayer);
  const ramLayers = Math.max(0, nLayer - clampedGpuLayers);

  // Distribute load proportionally by available VRAM
  const perGpuLoad = gpuAvailable.map(avail =>
    multiTotalAvailable > 0 ? totalCapacity * (avail / multiTotalAvailable) : totalCapacity / numGpus,
  );

  return buildManifest(
    input, computed,
    "TOTAL_SPILL",
    {
      titleColor: "text-red-600",
      gpuBarColor: "bg-red-700",
      borderColor: "border-red-700/30",
      bgTint: "bg-red-700/5",
      badgeBg: "bg-red-700/20",
      icon: "◐",
      label: "TOTAL SPILL",
      ramVisible: true,
    },
    clampedGpuLayers * perLayerGb, clampedGpuLayers * kvPerLayer, overheadGb + visionGb,
    ramLayers * perLayerGb, spillGb, true,
    `${ramLayers} layers in RAM across ${numGpus} GPU(s) — expect slower inference`,
    clampedGpuLayers, ramLayers, perGpuLoad,
  );
}
