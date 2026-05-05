import { ScenarioInput, ComputedValues, buildManifest, gpuManufacturedMib, perLayerWeightGb } from "./scenarios_factory";
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
  const perLayerGb = perLayerWeightGb(input, computed);
  const kvPerLayer = kvCacheGb / nLayer;
  const availableForWeightsAndKv = gpuCapacity - overheadGb - visionGb;
  const gpuLayers = (perLayerGb + kvPerLayer) > 0
    ? Math.floor(availableForWeightsAndKv / (perLayerGb + kvPerLayer))
    : nLayer;
  const clampedGpuLayers = Math.min(gpuLayers, nLayer);
  const ramLayers = Math.max(0, nLayer - clampedGpuLayers);

  // KV cache spill risk — llama.cpp allocates KV as contiguous block in VRAM
  // If GPU is tight after weights + overhead, KV may also spill to RAM (catastrophic slowdown)
  const ramKvGb = ramLayers * kvPerLayer;
  const targetGpuMib = gpuManufacturedMib(input.gpus[targetGpuIdx]);
  const gpuVramPressure = targetGpuMib > 0 ? gpuCapacity / (targetGpuMib / 1024) : 0;

  // Dynamic threshold by GPU class — smaller cards fragment faster
  let kvSpillThreshold = 0.85; // default mid-range
  if (targetGpuMib < 24 * 1024) kvSpillThreshold = 0.82;
  else if (targetGpuMib > 48 * 1024) kvSpillThreshold = 0.90;

  const kvSpillCritical = ramKvGb > 0 && gpuVramPressure > kvSpillThreshold;

  const perGpuLoad = Array(numGpus).fill(0);
  perGpuLoad[targetGpuIdx] = gpuCapacity;

  return buildManifest(
    input, computed,
    "SOLO_SPILL",
    {
      titleColor: kvSpillCritical ? "text-telemetry-red" : "text-yellow-400",
      gpuBarColor: kvSpillCritical ? "bg-telemetry-red" : "bg-yellow-500/60",
      borderColor: kvSpillCritical ? "border-telemetry-red/40" : "border-yellow-500/30",
      bgTint: kvSpillCritical ? "bg-telemetry-red/10" : "bg-yellow-500/5",
      badgeBg: kvSpillCritical ? "bg-telemetry-red/20" : "bg-yellow-500/20",
      icon: kvSpillCritical ? "⚠" : "◐",
      label: kvSpillCritical ? "KV SPILL RISK" : "SOLO SPILL",
      ramVisible: true,
      kvSpillCritical,
    },
    clampedGpuLayers * perLayerGb, clampedGpuLayers * kvPerLayer, overheadGb + visionGb,
    ramLayers * perLayerGb, ramKvGb, 0, true,
    kvSpillCritical
      ? `SYSTEM MEMORY CASCADE: ${ramLayers} layers in RAM — weights (${(ramLayers * perLayerGb).toFixed(1)} GB) + KV risk (${(ramKvGb).toFixed(1)} GB)`
      : `${ramLayers} layers in RAM — weights on system RAM (PCIe speed limit speed)`,
    clampedGpuLayers, ramLayers, perGpuLoad,
  );
}
