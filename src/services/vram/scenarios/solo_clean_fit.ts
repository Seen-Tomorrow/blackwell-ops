import { ScenarioInput, ComputedValues, buildManifest, gpuHasRunningEngines } from "./scenarios_factory";
import type { VramManifest } from "../../../lib/types";

/**
 * SOLO_CLEAN_FIT — Model fits entirely on one GPU, no existing engines on that card.
 */
export function tryEvaluate(input: ScenarioInput, computed: ComputedValues): VramManifest | null {
  const { vramTotalGb, singleMaxAvailable, targetGpuIdx, splitActive, numGpus } = computed;

  // Guard: must fit within fill target on best GPU, no running engines, split not active
  if (vramTotalGb > singleMaxAvailable * 0.95) return null;
  if (splitActive) return null;
  if (gpuHasRunningEngines(targetGpuIdx, input.runningSlots)) return null;

  // All layers on GPU
  const perGpuLoad = Array(numGpus).fill(0);
  perGpuLoad[targetGpuIdx] = vramTotalGb;

  return buildManifest(
    input, computed,
    "SOLO_CLEAN_FIT",
    {
      titleColor: "text-green",
      gpuBarColor: "bg-green",
      borderColor: "border-green/30",
      bgTint: "bg-green/5",
      badgeBg: "bg-green/20",
      icon: "◉",
      label: "CLEAN FIT",
      ramVisible: false,
    },
    computed.weightsGb, computed.kvCacheGb, computed.overheadGb + computed.visionGb,
    0, 0, 0, true, "",
    input.modelMeta.n_layer, 0, perGpuLoad,
  );
}
