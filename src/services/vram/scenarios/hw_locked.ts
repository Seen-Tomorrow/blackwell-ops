import { ScenarioInput, ComputedValues, buildManifest } from "./scenarios_factory";
import type { VramManifest } from "../../../lib/types";

/**
 * HW_LOCKED — Nothing works. Fallback scenario (always matches).
 */
export function evaluate(input: ScenarioInput, computed: ComputedValues, reason: string): VramManifest {
  const perGpuLoad = Array(computed.numGpus).fill(0);

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
      label: "HW LOCKED",
      ramVisible: false,
    },
    computed.weightsGb, computed.kvCacheGb, computed.overheadGb + computed.visionGb,
    0, 0, 0, false, reason,
    0, input.modelMeta.n_layer, perGpuLoad,
  );
}
