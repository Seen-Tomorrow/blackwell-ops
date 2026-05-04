import { ScenarioInput, ComputedValues, buildManifest } from "./scenarios_factory";
import type { VramManifest } from "../../../lib/types";

/**
 * SOLO_BUSY_FIT — Model fits on one GPU but card has existing engines.
 */
export function tryEvaluate(input: ScenarioInput, computed: ComputedValues): VramManifest | null {
  const { vramTotalGb, singleMaxAvailable, targetGpuIdx, splitActive, numGpus } = computed;

  // Guard: must fit within fill target on best GPU, split not active
  if (vramTotalGb > singleMaxAvailable * 0.95) return null;
  if (splitActive) return null;

  // All layers on GPU
  const perGpuLoad = Array(numGpus).fill(0);
  perGpuLoad[targetGpuIdx] = vramTotalGb;

  return buildManifest(
    input, computed,
    "SOLO_BUSY_FIT",
    {
      titleColor: "text-yellow-400",
      gpuBarColor: "bg-yellow-400",
      borderColor: "border-yellow-400/30",
      bgTint: "bg-yellow-400/5",
      badgeBg: "bg-yellow-400/20",
      icon: "◉",
      label: "BUSY FIT",
      ramVisible: false,
    },
    computed.weightsGb, computed.kvCacheGb, computed.overheadGb + computed.visionGb,
    0, 0, 0, true, "",
    input.modelMeta.n_layer, 0, perGpuLoad,
  );
}
