import { ScenarioInput, ComputedValues, buildManifest } from "./scenarios_factory";
import type { VramManifest } from "../../../lib/types";

/**
 * HW_LOCKED — Nothing works. Fallback scenario (always matches).
 */
export function evaluate(input: ScenarioInput, computed: ComputedValues, reason: string): VramManifest {
  const perGpuLoad = Array(computed.numGpus).fill(0);

  const nLayer = input.modelMeta.n_layer;

  return buildManifest(
    input, computed,
    "HW_LOCKED",
    {
      titleColor: "text-gray-500",
      gpuBarColor: "bg-gray-800",
      borderColor: "border-gray-800/30",
      bgTint: "bg-gray-800/5",
      badgeBg: "bg-gray-800/20",
      icon: "!",
      label: "DO NOT FIT",
      ramVisible: false,
      uiTemplate: {
        heroText: "WON'T LAUNCH",
        heroSubtext: reason,
        showDetailedForecast: input.fullAutoMode !== true,
        gpuLayerText: `→ 0 layers on GPU — insufficient VRAM`,
        ramLayerText: `→ ${nLayer} layers in RAM — ${computed.ramWeightsGb > 0 ? `${computed.ramWeightsGb.toFixed(1)} GB expert FFN + ` : ''}${computed.weightsOnGpuGb.toFixed(1)} GB weights (cannot launch)`,
        showRamBar: true,
        offloadWarningText: null,
      },
    },
    computed.weightsOnGpuGb, computed.kvCacheGb, computed.overheadGb + computed.visionGb,
    computed.ramWeightsGb, 0, 0, false, reason,
    0, nLayer, perGpuLoad,
  );
}
