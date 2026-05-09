import { ScenarioInput, ComputedValues, buildManifest } from "./scenarios_factory";
import type { VramManifest } from "../../../lib/types";

/**
 * SOLO_PRESSURE — Model fits on one GPU but leaves <1GB headroom (tight fit).
 */
export function tryEvaluate(input: ScenarioInput, computed: ComputedValues): VramManifest | null {
  const { vramTotalGb, singleMaxAvailable, targetGpuIdx, splitActive, numGpus } = computed;

  // Guard: must still fit on one GPU (even if tight), split not active
  if (vramTotalGb > singleMaxAvailable) return null; // Doesn't fit at all → spill scenarios
  if (splitActive) return null;

  // All layers on GPU
  const perGpuLoad = Array(numGpus).fill(0);
  perGpuLoad[targetGpuIdx] = vramTotalGb;

  const nLayer = input.modelMeta.n_layer;

  return buildManifest(
    input, computed,
    "SOLO_PRESSURE",
    {
      titleColor: "text-orange-400",
      gpuBarColor: "bg-orange-400/60",
      borderColor: "border-orange-400/30",
      bgTint: "bg-orange-400/5",
      badgeBg: "bg-orange-400/20",
      icon: "◉",
      label: "PRESSURE",
      ramVisible: computed.ramWeightsGb > 0,
      uiTemplate: {
        gpuLayerText: computed.ramWeightsGb > 0
          ? `→ ${nLayer} layers on GPU — ${(computed.weightsOnGpuGb).toFixed(1)} GB weights + ${(computed.ramWeightsGb).toFixed(1)} GB expert FFN in RAM`
          : `→ ${nLayer} layers on GPU — tight fit, low VRAM headroom`,
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
