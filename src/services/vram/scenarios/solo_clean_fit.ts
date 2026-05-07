import { ScenarioInput, ComputedValues, buildManifest, gpuHasRunningEngines, gpuManufacturedMib } from "./scenarios_factory";
import type { VramManifest } from "../../../lib/types";

/**
 * SOLO_CLEAN_FIT — Model fits entirely on one GPU, no existing engines on that card.
 */
export function tryEvaluate(input: ScenarioInput, computed: ComputedValues): VramManifest | null {
  const { vramTotalGb, singleMaxAvailable, targetGpuIdx, splitActive, numGpus } = computed;

  // Guard: must fit within fill target on best GPU, no running engines, split not active
  // Per-GPU headroom: min 1 GB or 2% of card capacity — whichever is larger
  const targetGpuMib = gpuManufacturedMib(input.gpus[targetGpuIdx]);
  const headroomGb = Math.max(1.0, (targetGpuMib / 1024) * 0.02);
  if (vramTotalGb > singleMaxAvailable - headroomGb) return null;
  if (splitActive) return null;
  if (gpuHasRunningEngines(targetGpuIdx, input.runningSlots)) return null;

  // All layers on GPU
  const perGpuLoad = Array(numGpus).fill(0);
  perGpuLoad[targetGpuIdx] = vramTotalGb;

  const nLayer = input.modelMeta.n_layer;

  return buildManifest(
    input, computed,
    "SOLO_CLEAN_FIT",
    {
      titleColor: "text-nv-green",
      gpuBarColor: "bg-nv-green",
      borderColor: "border-nv-green/30",
      bgTint: "bg-nv-green/5",
      badgeBg: "bg-nv-green/20",
      icon: "◉",
      label: "CLEAN FIT",
      ramVisible: false,
      uiTemplate: {
        gpuLayerText: `→ ${nLayer} layers on GPU — all weights in VRAM`,
        ramLayerText: `→ 0 layers offloaded to RAM`,
        showRamBar: true,
      },
    },
    computed.weightsGb, computed.kvCacheGb, computed.overheadGb + computed.visionGb,
    0, 0, 0, true, "",
    nLayer, 0, perGpuLoad,
  );
}
