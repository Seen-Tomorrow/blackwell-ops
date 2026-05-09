import { ScenarioInput, ComputedValues, buildManifest, gpuManufacturedMib } from "./scenarios_factory";
import type { VramManifest } from "../../../lib/types";

/**
 * SOLO_FIT — Model fits entirely on one GPU with ≥1GB headroom.
 */
export function tryEvaluate(input: ScenarioInput, computed: ComputedValues): VramManifest | null {
  const { vramTotalGb, singleMaxAvailable, targetGpuIdx, splitActive, numGpus } = computed;

  // Guard: must fit on one GPU with at least 1GB headroom remaining, split not active
  const minimumHeadroomGb = 1.0; // Absolute minimum for model to load safely
  if (vramTotalGb > singleMaxAvailable - minimumHeadroomGb) return null;
  if (splitActive) return null;

  // All layers on GPU
  const perGpuLoad = Array(numGpus).fill(0);
  perGpuLoad[targetGpuIdx] = vramTotalGb;

  const nLayer = input.modelMeta.n_layer;

  return buildManifest(
    input, computed,
    "SOLO_FIT",
    {
      titleColor: "text-nv-green",
      gpuBarColor: "bg-nv-green",
      borderColor: "border-nv-green/30",
      bgTint: "bg-nv-green/5",
      badgeBg: "bg-nv-green/20",
      icon: "◉",
      label: "FIT",
      ramVisible: computed.ramWeightsGb > 0,
      uiTemplate: {
        gpuLayerText: computed.ramWeightsGb > 0
          ? `→ ${nLayer} layers on GPU — ${(computed.weightsOnGpuGb).toFixed(1)} GB weights + ${(computed.ramWeightsGb).toFixed(1)} GB expert FFN in RAM`
          : `→ ${nLayer} layers on GPU — all weights in VRAM`,
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
