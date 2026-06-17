import { ScenarioInput, ComputedValues, buildManifest } from "./scenarios_factory";
import { autoSplitPerGpuLoad, needsAutoLayerSplit } from "../../../lib/autoVramLaunch";
import type { VramManifest } from "../../../lib/types";

/**
 * AUTO_FIT — Engine will auto-tune VRAM at launch (--fit / --fit on).
 * When the formula estimate exceeds GPU VRAM, --fit offloads to host RAM — forecast reflects that.
 */
export function tryEvaluate(input: ScenarioInput, computed: ComputedValues): VramManifest | null {
  if (!input.autoVramLaunch) return null;

  const learnedGb = input.learnedVramMib ? input.learnedVramMib / 1024 : null;
  const learnedHostGb = input.learnedHostMib ? input.learnedHostMib / 1024 : null;
  const weightGb = input.modelMeta.file_size_bytes / (1024 ** 3);
  const formulaGb = computed.vramTotalGb;
  const estimateGb = Math.max(learnedGb ?? 0, formulaGb, weightGb * 1.05);

  const autoSplit = needsAutoLayerSplit(estimateGb, computed.gpuAvailable);

  const targetAvail = autoSplit
    ? computed.multiTotalAvailable
    : (computed.gpuAvailable[computed.targetGpuIdx] ?? computed.singleMaxAvailable);
  const headroomGb = Math.max(1.0, targetAvail * 0.03);
  const exceedsGpuPool = estimateGb > targetAvail - headroomGb;

  // --fit on will search host offload when GPU pool is tight — don't show red NO_FIT.
  const trustFitAtLoad = exceedsGpuPool || learnedHostGb != null;
  const fits = trustFitAtLoad || estimateGb <= targetAvail - headroomGb;

  const gpuProjectionGb = learnedGb ?? Math.min(estimateGb, Math.max(targetAvail - headroomGb, 0));
  const hostOffloadGb = learnedHostGb ?? (exceedsGpuPool ? Math.max(0, estimateGb - gpuProjectionGb) : 0);

  const perGpuLoad = (() => {
    if (
      input.learnedGpuBreakdownMib
      && input.learnedGpuBreakdownMib.length === input.gpus.length
    ) {
      return input.learnedGpuBreakdownMib.map((mib) => mib / 1024);
    }
    if (autoSplit) {
      return autoSplitPerGpuLoad(gpuProjectionGb, input.gpus, computed.gpuAvailable);
    }
    const loads = Array(input.gpus.length).fill(0);
    loads[computed.targetGpuIdx] = gpuProjectionGb;
    return loads;
  })();

  const fitHint =
    input.fitStyle === "ik_native"
      ? "IK --fit auto-offloads tensors at load"
      : "GGML --fit on pre-tunes before load";

  const splitHint = autoSplit
    ? `auto layer-split across ${input.gpus.length} GPU(s) + ${fitHint}`
    : fitHint;

  const headroomThreshold = targetAvail - headroomGb;
  const totalProjectedGb = gpuProjectionGb + hostOffloadGb;
  // Host line in memory breakdown includes engine buffers — not always tensor offload.
  const isRealHostOffload = totalProjectedGb > headroomThreshold + 0.1;

  const layerText = learnedGb
    ? isRealHostOffload && hostOffloadGb > 0.5
      ? `→ ${gpuProjectionGb.toFixed(1)} GB GPU + ${hostOffloadGb.toFixed(1)} GB host measured — ${splitHint}`
      : `→ ${gpuProjectionGb.toFixed(1)} GB GPU measured — ${splitHint}`
    : exceedsGpuPool
      ? `→ ~${gpuProjectionGb.toFixed(1)} GB GPU + ~${hostOffloadGb.toFixed(1)} GB host offload — ${splitHint}`
      : `→ ~${estimateGb.toFixed(1)} GB estimated — ${splitHint}`;

  const recommendation = !fits && !trustFitAtLoad
    ? "Reduce ctx or free VRAM — model exceeds available GPU memory"
    : "";

  const showHostRam = hostOffloadGb > 0.5 || exceedsGpuPool;
  const useOffloadPalette = trustFitAtLoad && exceedsGpuPool;

  const manifest = buildManifest(
    input,
    computed,
    "AUTO_FIT",
    {
      titleColor: useOffloadPalette ? "text-orange-400" : fits ? "text-nv-green" : "text-red-400",
      gpuBarColor: useOffloadPalette ? "bg-orange-400/70" : fits ? "bg-nv-green" : "bg-red-500",
      borderColor: useOffloadPalette ? "border-orange-400/30" : fits ? "border-nv-green/30" : "border-red-400/30",
      bgTint: useOffloadPalette ? "bg-orange-400/5" : fits ? "bg-nv-green/5" : "bg-red-400/5",
      badgeBg: useOffloadPalette ? "bg-orange-400/20" : fits ? "bg-nv-green/20" : "bg-red-400/20",
      icon: useOffloadPalette ? "◐" : "◎",
      label: "AUTO",
      ramVisible: showHostRam,
      uiTemplate: {
        gpuLayerText: layerText,
        ramLayerText: showHostRam
          ? isRealHostOffload
            ? learnedHostGb
              ? `→ ${hostOffloadGb.toFixed(1)} GB on host RAM (measured on prior launch)`
              : `→ ~${hostOffloadGb.toFixed(1)} GB will spill to host RAM — decided by --fit at load`
            : learnedHostGb
              ? `→ ${hostOffloadGb.toFixed(1)} GB host buffer (measured on prior launch)`
              : `→ ~${hostOffloadGb.toFixed(1)} GB host buffer — engine overhead at load`
          : autoSplit
            ? "→ VRAM spread across GPUs — offload decided at load"
            : "→ Layer offload decided by engine at launch",
        showRamBar: showHostRam,
        offloadWarningText: isRealHostOffload
          ? "Host RAM offload — slower inference"
          : undefined,
      },
    },
    gpuProjectionGb,
    computed.kvCacheGb * (gpuProjectionGb / Math.max(estimateGb, 0.01)),
    computed.overheadGb + computed.visionGb,
    0,
    0,
    hostOffloadGb,
    fits,
    recommendation,
    0,
    0,
    perGpuLoad,
  );
  return {
    ...manifest,
    autoLayerSplit: autoSplit,
    vramTotalGb: Math.round((gpuProjectionGb + hostOffloadGb) * 100) / 100,
    learnedFromPreviousRun: learnedGb != null,
  };
}