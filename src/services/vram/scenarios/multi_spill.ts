import { ScenarioInput, ComputedValues, buildManifest, gpuManufacturedMib, perLayerWeightGb, gpuPerLayerWeightGb } from "./scenarios_factory";
import type { VramManifest } from "../../../lib/types";

/**
 * MULTI_SPILL — Fill ALL GPUs to 95%, spill rest of layers to RAM.
 */
export function tryEvaluate(input: ScenarioInput, computed: ComputedValues): VramManifest | null {
  const { vramTotalGb, multiTotalAvailable, overheadGb, visionGb, weightsGb, kvCacheGb, gpuAvailable, numGpus } = computed;

  // Guard: spill must be positive and fit in available RAM
  // Per-GPU headroom: min 1 GB or 2% of card — summed across all GPUs
  const totalHeadroomGb = input.gpus.reduce((sum, g) => {
    const mfgGb = gpuManufacturedMib(g) / 1024;
    return sum + Math.max(1.0, mfgGb * 0.02);
  }, 0);
  const totalCapacity = multiTotalAvailable - totalHeadroomGb;
  const spillGb = vramTotalGb - totalCapacity;
  if (spillGb <= 0) return null;
  if (spillGb > input.ramAvailableGb) return null;

  // Calculate layer split across all GPUs
  const nLayer = input.modelMeta.n_layer;
  const perLayerGb = perLayerWeightGb(input, computed);
  const gpuPerLayerGb = gpuPerLayerWeightGb(input, computed);
  const kvPerLayer = kvCacheGb / nLayer;
  const availableForWeightsAndKv = totalCapacity - overheadGb - visionGb;
  const gpuLayers = (gpuPerLayerGb + kvPerLayer) > 0
    ? Math.floor(availableForWeightsAndKv / (gpuPerLayerGb + kvPerLayer))
    : nLayer;
  const clampedGpuLayers = Math.min(gpuLayers, nLayer);
  const ramLayers = Math.max(0, nLayer - clampedGpuLayers);

  // KV cache spill risk — contiguous block may not fit in fragmented VRAM
  const ramKvGb = ramLayers * kvPerLayer;
  const largestGpuMib = Math.max(...input.gpus.map(g => gpuManufacturedMib(g)));
  const maxPressure = input.gpus.reduce((max, g, i) => {
    const total = gpuManufacturedMib(g) / 1024;
    return total > 0 ? Math.max(max, (totalCapacity * (gpuAvailable[i] / multiTotalAvailable)) / total) : max;
  }, 0);

  // Dynamic threshold by GPU class — smaller cards fragment faster
  let kvSpillThreshold = 0.85; // default mid-range
  if (largestGpuMib < 24 * 1024) kvSpillThreshold = 0.82;
  else if (largestGpuMib > 48 * 1024) kvSpillThreshold = 0.90;

  const kvSpillCritical = ramKvGb > 0 && maxPressure > kvSpillThreshold;

  // Distribute load proportionally by available VRAM
  const perGpuLoad = gpuAvailable.map(avail =>
    multiTotalAvailable > 0 ? totalCapacity * (avail / multiTotalAvailable) : totalCapacity / numGpus,
  );

  const gpuLayerPct = vramTotalGb > 0 ? (clampedGpuLayers * perLayerGb / vramTotalGb * 100) : 0;
  const ramOffloadPct = vramTotalGb > 0 ? (ramLayers * perLayerGb / vramTotalGb * 100) : 0;

  return buildManifest(
    input, computed,
    "MULTI_SPILL",
    {
      titleColor: kvSpillCritical ? "text-telemetry-red" : "text-red-400",
      gpuBarColor: kvSpillCritical ? "bg-telemetry-red" : "bg-red-400/60",
      borderColor: kvSpillCritical ? "border-telemetry-red/40" : "border-red-400/30",
      bgTint: kvSpillCritical ? "bg-telemetry-red/10" : "bg-red-400/5",
      badgeBg: kvSpillCritical ? "bg-telemetry-red/20" : "bg-red-400/20",
      icon: kvSpillCritical ? "⚠" : "◐",
      label: kvSpillCritical ? "KV SPILL RISK" : "MULTI SPILL",
      ramVisible: true,
      kvSpillCritical,
      uiTemplate: {
        gpuLayerText: `→ ${clampedGpuLayers} layers on GPU ~ ${(clampedGpuLayers * perLayerGb).toFixed(1)} GB (${gpuLayerPct.toFixed(0)}%)`,
        ramLayerText: `→ ${ramLayers} layers in RAM — ${(ramLayers * perLayerGb).toFixed(1)} GB offload (${ramOffloadPct.toFixed(0)}%)`,
        showRamBar: true,
        offloadWarningText: "RAM offload — slower inference",
        kvSpillRiskText: ramKvGb > 0 ? `⚠ KV cache may spill — ${ramKvGb.toFixed(1)} GB` : null,
      },
    },
    clampedGpuLayers * gpuPerLayerGb, clampedGpuLayers * kvPerLayer, overheadGb + computed.visionGb,
    ramLayers * perLayerGb, ramKvGb, spillGb, true,
    "",
    clampedGpuLayers, ramLayers, perGpuLoad,
  );
}
