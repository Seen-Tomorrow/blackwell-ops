import { ScenarioInput, ComputedValues, buildManifest, gpuManufacturedMib } from "./scenarios_factory";
import type { VramManifest } from "../../../lib/types";

/**
 * MULTI_PRESSURE — Distributed across GPUs, at least one GPU exceeds 85%.
 */
export function tryEvaluate(input: ScenarioInput, computed: ComputedValues): VramManifest | null {
  const { vramTotalGb, singleMaxAvailable, multiTotalAvailable, splitActive, gpuAvailable, numGpus } = computed;

  // Guard: multi-GPU only if split mode is active. If user explicitly set Split="none",
  // fall through to spill scenarios (single GPU + RAM offload) even if model doesn't fit.
  const targetGpuMib = gpuManufacturedMib(input.gpus[computed.targetGpuIdx]);
  const headroomGb = Math.max(1.0, (targetGpuMib / 1024) * 0.02);
  if (!splitActive) return null; // User chose single GPU — respect it
  if (!(numGpus > 1 && vramTotalGb > singleMaxAvailable - headroomGb)) return null;

  // Must fit across all GPUs within fill target (per-GPU headroom summed)
  const totalHeadroomGb = input.gpus.reduce((sum, g) => {
    const mfgGb = gpuManufacturedMib(g) / 1024;
    return sum + Math.max(1.0, mfgGb * 0.02);
  }, 0);
  if (vramTotalGb > multiTotalAvailable - totalHeadroomGb) return null;

  // Distribute load proportionally by available VRAM
  const perGpuLoad = gpuAvailable.map(avail =>
    multiTotalAvailable > 0 ? vramTotalGb * (avail / multiTotalAvailable) : vramTotalGb / numGpus,
  );

  // Guard: at least one GPU must exceed 90% of AVAILABLE VRAM — otherwise this is MULTI_PERFECT
  const hasPressure = perGpuLoad.some((load, i) => {
    const available = gpuAvailable[i];
    return available > 0 && load / available > 0.9;
  });
  if (!hasPressure) return null;

  const nLayer = input.modelMeta.n_layer;

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
      ramVisible: computed.ramWeightsGb > 0,
      uiTemplate: {
        gpuLayerText: computed.ramWeightsGb > 0
          ? `→ ${nLayer} layers across ${numGpus} GPU(s) — ${(computed.weightsOnGpuGb).toFixed(1)} GB weights + ${(computed.ramWeightsGb).toFixed(1)} GB expert FFN in RAM`
          : `→ ${nLayer} layers across ${numGpus} GPU(s) — tight fit`,
        ramLayerText: computed.ramWeightsGb > 0
          ? `→ Expert FFN offloaded to RAM (${computed.ramWeightsGb.toFixed(1)} GB)`
          : `→ 0 layers offloaded to RAM`,
        showRamBar: true,
      },
    },
    computed.weightsOnGpuGb, computed.kvCacheGb, computed.overheadGb + computed.visionGb,
    computed.ramWeightsGb, 0, 0, true, "",
    nLayer, 0, perGpuLoad,
  );
}
