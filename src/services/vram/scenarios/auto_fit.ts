import {
  ScenarioInput,
  ComputedValues,
  buildManifest,
  exceedsSystemMemory,
  systemMemoryAvailableGb,
} from "./scenarios_factory";
import { autoSplitPerGpuLoad, needsAutoLayerSplit } from "../../../lib/autoVramLaunch";
import type { VramManifest } from "../../../lib/types";

/**
 * AUTO_FIT — Engine will auto-tune VRAM at launch (--fit / --fit on).
 * When the formula estimate exceeds GPU VRAM, --fit offloads to host RAM — forecast reflects that.
 */
export function tryEvaluate(input: ScenarioInput, computed: ComputedValues): VramManifest | null {
  if (!input.autoVramLaunch) return null;

  const fullAuto = input.fullAutoMode === true;
  const probeGb = input.fitProbeVramMib ? input.fitProbeVramMib / 1024 : null;
  const probeHostGb = input.fitProbeHostMib ? input.fitProbeHostMib / 1024 : null;
  const moeRamGb = computed.ramWeightsGb;
  const moeOptimalActive = moeRamGb > 0.5;
  const weightGb = input.modelMeta.file_size_bytes / (1024 ** 3);

  // Prior-launch learned totals are regular-mode GPU footprints — not valid for FULL AUTO live forecast or MOE_OPTIMAL.
  const rawLearnedGb = !probeGb && input.learnedVramMib ? input.learnedVramMib / 1024 : null;
  const useLearnedProjection = !fullAuto && !moeOptimalActive && rawLearnedGb != null;
  const learnedGb = useLearnedProjection ? rawLearnedGb : null;
  const learnedHostGb = useLearnedProjection
    ? (probeHostGb ?? (input.learnedHostMib ? input.learnedHostMib / 1024 : null))
    : null;

  const formulaGb = probeGb ?? computed.vramTotalGb;
  const weightFloorGb = moeOptimalActive ? computed.weightsOnGpuGb * 1.05 : weightGb * 1.05;
  const estimateGb = Math.max(learnedGb ?? 0, formulaGb, weightFloorGb);

  // GPU-side only — MoE expert weights live in ramWeightsGb, not stacked on VRAM.
  const gpuNeedGb = moeOptimalActive ? computed.vramTotalGb : estimateGb;

  const autoSplit = needsAutoLayerSplit(estimateGb, computed.gpuAvailable);

  const targetAvail = autoSplit
    ? computed.multiTotalAvailable
    : (computed.gpuAvailable[computed.targetGpuIdx] ?? computed.singleMaxAvailable);
  const headroomGb = Math.max(1.0, targetAvail * 0.03);
  const exceedsGpuPool = estimateGb > targetAvail - headroomGb;
  const systemAvailableGb = systemMemoryAvailableGb(computed, input);
  const modelFootprintGb = weightGb + computed.kvCacheGb + computed.overheadGb + computed.visionGb;
  const overSystemMemory = exceedsSystemMemory(modelFootprintGb, computed, input);

  // --fit on can offload to host when GPU pool is tight — MOE_OPTIMAL launches with --fit off.
  const trustFitAtLoad = !overSystemMemory && !moeOptimalActive && (exceedsGpuPool || learnedHostGb != null);
  const fits = !overSystemMemory && (trustFitAtLoad || gpuNeedGb <= targetAvail - headroomGb);

  const gpuProjectionGb = probeGb != null
    ? probeGb
    : moeOptimalActive
      ? computed.vramTotalGb
      : learnedGb != null
        ? learnedGb
        : Math.min(estimateGb, Math.max(targetAvail - headroomGb, 0));
  const hostOffloadGb = learnedHostGb ?? (exceedsGpuPool && !moeOptimalActive
    ? Math.max(0, estimateGb - gpuProjectionGb)
    : 0);

  const perGpuLoad = (() => {
    const probeBreakdown = input.fitProbeGpuBreakdownMib;
    if (probeBreakdown && probeBreakdown.length === input.gpus.length) {
      return probeBreakdown.map((mib) => mib / 1024);
    }
    if (
      useLearnedProjection
      && input.learnedGpuBreakdownMib
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

  const fitHint = "ENGINE pre-tunes on load";

  const splitHint = autoSplit
    ? `auto split across ${input.gpus.length} GPU(s) + ${fitHint}`
    : fitHint;

  const headroomThreshold = targetAvail - headroomGb;
  const totalProjectedGb = gpuProjectionGb + hostOffloadGb;
  // Host line in memory breakdown includes engine buffers — not always tensor offload.
  const isRealHostOffload = totalProjectedGb > headroomThreshold + 0.1;

  const layerText = learnedGb
    ? `${gpuProjectionGb.toFixed(1)} GB GPU measured — ${splitHint}`
    : `~${gpuProjectionGb.toFixed(1)} GB GPU estimated — ${splitHint}`;

  const recommendation = overSystemMemory
    ? `Needs ~${modelFootprintGb.toFixed(0)} GB — ~${systemAvailableGb.toFixed(0)} GB available (VRAM + RAM)`
    : !fits && !trustFitAtLoad
      ? "Reduce ctx or free VRAM — model exceeds available GPU memory"
      : "";

  const showHostRam = hostOffloadGb > 0.5 || exceedsGpuPool || moeRamGb > 0.5;
  const useOffloadPalette = trustFitAtLoad && exceedsGpuPool;
  const assisted = !fullAuto;

  const multiGpuLoad = perGpuLoad.filter((gb) => gb > 0.1).length > 1;
  const fitLabel = !fits
    ? "DO NOT FIT"
    : useOffloadPalette || (isRealHostOffload && hostOffloadGb > 0.5)
      ? "FIT OFFLOAD"
      : autoSplit || multiGpuLoad || (!fullAuto && computed.splitActive)
        ? "FIT MULTI"
        : "FIT SINGLE";

  const hostOffloadLaunch = useOffloadPalette || (isRealHostOffload && hostOffloadGb > 0.5);
  const heroText = !fits
    ? "WON'T LAUNCH"
    : fullAuto
      ? hostOffloadLaunch
        ? "Model will launch - need some RAM, will be slower"
        : "Your model will launch ALRIGHT"
      : hostOffloadLaunch
        ? "WILL LAUNCH — HOST RAM"
        : "WILL LAUNCH";
  const heroSubtext = fullAuto
    ? (!fits ? recommendation : undefined)
    : !fits
      ? recommendation
      : hostOffloadLaunch
        ? "Engine will offload to host RAM — slower inference"
        : "Engine manages GPU + host memory at load";

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
      label: fitLabel,
      ramVisible: showHostRam,
      uiTemplate: {
        heroText,
        heroSubtext,
        showDetailedForecast: assisted,
        gpuLayerText: layerText,
        ramLayerText: showHostRam
          ? moeRamGb > 0.5 && isRealHostOffload && hostOffloadGb > 0.5
            ? `~${moeRamGb.toFixed(1)} GB MoE experts + ~${hostOffloadGb.toFixed(1)} GB host offload (MOE_OPTIMAL)`
            : moeRamGb > 0.5
              ? `~${moeRamGb.toFixed(1)} GB MoE expert weights in host RAM (MOE_OPTIMAL)`
              : isRealHostOffload
                ? learnedHostGb
                  ? `${hostOffloadGb.toFixed(1)} GB on host RAM (measured on prior launch)`
                  : `~${hostOffloadGb.toFixed(1)} GB will spill to RAM — engine decides on load`
                : learnedHostGb
                  ? `${hostOffloadGb.toFixed(1)} GB host buffer (measured on prior launch)`
                  : `~${hostOffloadGb.toFixed(1)} GB host buffer — engine overhead at load`
          : autoSplit
            ? "VRAM spread across GPUs — offload decided at load"
            : assisted
              ? "Host RAM available — engine decides at launch"
              : "Layer offload decided by engine at launch",
        showRamBar: assisted,
        moeRamBar: moeRamGb > 0.5,
        offloadWarningText: isRealHostOffload
          ? "Host RAM offload — slower inference"
          : undefined,
      },
    },
    gpuProjectionGb,
    computed.kvCacheGb * (gpuProjectionGb / Math.max(formulaGb, 0.01)),
    computed.overheadGb + computed.visionGb,
    moeRamGb,
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
    vramTotalGb: Math.round(gpuProjectionGb * 100) / 100,
    formulaVramTotalGb: Math.round(computed.vramTotalGb * 100) / 100,
    learnedFromPreviousRun: useLearnedProjection,
  };
}