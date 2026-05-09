import { ScenarioInput, ComputedValues, buildManifest, gpuManufacturedMib } from "./scenarios_factory";
import type { VramManifest } from "../../../lib/types";

/**
 * MULTI_FIT — Distributed across GPUs, all under 85% utilization.
 */
export function tryEvaluate(input: ScenarioInput, computed: ComputedValues): VramManifest | null {
  const { vramTotalGb, singleMaxAvailable, multiTotalAvailable, splitActive, gpuAvailable, numGpus } = computed;

  // Guard: must be multi-GPU scenario (split active OR doesn't fit on one GPU)
  const targetGpuMib = gpuManufacturedMib(input.gpus[computed.targetGpuIdx]);
  const headroomGb = Math.max(1.0, (targetGpuMib / 1024) * 0.02);
  if (!(numGpus > 1 && (splitActive || vramTotalGb > singleMaxAvailable - headroomGb))) return null;

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

  // Guard: no GPU exceeds 90% of AVAILABLE VRAM — otherwise this is MULTI_PRESSURE
  const hasPressure = perGpuLoad.some((load, i) => {
    const available = gpuAvailable[i];
    return available > 0 && load / available > 0.9;
  });
  if (hasPressure) return null;

  const nLayer = input.modelMeta.n_layer;

  return buildManifest(
    input, computed,
    "MULTI_FIT",
    {
      titleColor: "text-cyan-400",
      gpuBarColor: "bg-nv-green",
      borderColor: "border-cyan-400/30",
      bgTint: "bg-cyan-400/5",
      badgeBg: "bg-cyan-400/20",
      icon: "◆",
      label: "MULTI FIT",
      ramVisible: computed.ramWeightsGb > 0,
      uiTemplate: {
        gpuLayerText: computed.ramWeightsGb > 0
          ? `→ ${nLayer} layers across ${numGpus} GPU(s) — ${(computed.weightsOnGpuGb).toFixed(1)} GB weights + ${(computed.ramWeightsGb).toFixed(1)} GB expert FFN in RAM`
          : `→ ${nLayer} layers across ${numGpus} GPU(s) — all weights in VRAM`,
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
