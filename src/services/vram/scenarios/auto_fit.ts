import {
  ScenarioInput,
  ComputedValues,
  buildManifest,
  exceedsSystemMemory,
  systemMemoryAvailableGb,
  adjustMeasuredGbForCtx,
  interpolateLearnedCurveGb,
  parseCtx,
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
  const liveCtx = parseCtx(String(input.engineConfig.extra_params?.ctx ?? "32768"));
  const kvQuant = String(input.engineConfig.extra_params?.kv_quant ?? "f16");
  const probeGb = input.fitProbeVramMib ? input.fitProbeVramMib / 1024 : null;
  const probeHostGb = input.fitProbeHostMib ? input.fitProbeHostMib / 1024 : null;
  const weightGb = input.modelMeta.file_size_bytes / (1024 ** 3);

  const draftAddonGb = computed.draftWeightsGb + computed.draftOverheadGb;
  const learnedHasDraft = (input.learnedMtpContextMib ?? 0) > 64;
  const mergedCurve = (input.learnedCurve ?? []).map((p) => ({ ...p }));
  const probeAnchor = input.fitProbeAnchorCtx ?? 0;
  // Auto-FIT always probes split:none. Do not inject that point into a layer/tensor curve.
  const probeAppliesToCurve = probeGb != null && !computed.splitActive;
  if (probeAppliesToCurve && probeAnchor > 0 && !mergedCurve.some((p) => p.ctx === probeAnchor)) {
    mergedCurve.push({
      ctx: probeAnchor,
      vramMib: (probeGb + draftAddonGb) * 1024,
      hostMib: probeHostGb != null ? probeHostGb * 1024 : undefined,
    });
  }
  const curveHit = interpolateLearnedCurveGb(mergedCurve, liveCtx);
  const learnedExactGb = input.learnedCurve?.some((p) => p.ctx === liveCtx)
    ? (curveHit?.vramGb ?? null)
    : null;
  const curveGb = learnedExactGb == null && curveHit && mergedCurve.length >= 2
    ? curveHit.vramGb
    : null;
  const rawLearnedGb = input.learnedVramMib ? input.learnedVramMib / 1024 : null;
  const learnedBaseGb = rawLearnedGb != null
    ? rawLearnedGb + (draftAddonGb > 0 && !learnedHasDraft ? draftAddonGb : 0)
    : null;
  const learnedDeltaGb = learnedBaseGb != null && learnedExactGb == null && curveGb == null
    ? adjustMeasuredGbForCtx(
      learnedBaseGb,
      input.learnedAnchorCtx ?? liveCtx,
      liveCtx,
      input.fitPoints,
      input.modelMeta,
      kvQuant,
    )
    : null;
  const probeWithDraftGb = probeAppliesToCurve && curveGb == null && learnedExactGb == null
    ? adjustMeasuredGbForCtx(
      probeGb + draftAddonGb,
      probeAnchor || liveCtx,
      liveCtx,
      input.fitPoints,
      input.modelMeta,
      kvQuant,
    )
    : null;
  const learnedGb = learnedExactGb ?? curveGb ?? learnedDeltaGb;
  const learnedHostGb = curveHit?.hostGb
    ?? (rawLearnedGb != null && input.learnedHostMib ? input.learnedHostMib / 1024 : null);
  const estimateGb = learnedExactGb ?? curveGb ?? probeWithDraftGb ?? learnedDeltaGb ?? computed.vramTotalGb;
  const gpuNeedGb = estimateGb;
  const autoSplit = needsAutoLayerSplit(estimateGb, computed.gpuAvailable);
  const targetAvail = autoSplit
    ? computed.multiTotalAvailable
    : (computed.gpuAvailable[computed.targetGpuIdx] ?? computed.singleMaxAvailable);
  const headroomGb = Math.max(1.0, targetAvail * 0.03);
  const exceedsGpuPool = estimateGb > targetAvail - headroomGb;
  const systemAvailableGb = systemMemoryAvailableGb(computed, input);
  const modelFootprintGb =
    weightGb
    + computed.kvCacheGb
    + computed.overheadGb
    + computed.visionGb
    + computed.draftWeightsGb
    + computed.draftOverheadGb;
  const overSystemMemory = exceedsSystemMemory(modelFootprintGb, computed, input);

  const trustFitAtLoad = !overSystemMemory && (exceedsGpuPool || learnedHostGb != null);
  const fits = !overSystemMemory && (trustFitAtLoad || gpuNeedGb <= targetAvail - headroomGb);

  const measuredGb = learnedExactGb ?? probeWithDraftGb ?? learnedGb;
  const gpuProjectionGb = measuredGb != null
    ? estimateGb
    : Math.min(estimateGb, Math.max(targetAvail - headroomGb, 0));
  const hostOffloadGb = learnedHostGb
    ?? probeHostGb
    ?? (exceedsGpuPool ? Math.max(0, estimateGb - gpuProjectionGb) : 0);

  const userSplitMultiGpu = computed.splitActive && input.gpus.length > 1;
  const breakdownSpansMultipleGpus = (loadsGb: number[]) =>
    loadsGb.filter((gb) => gb > 0.1).length > 1;

  const currentPlacementKey = `${input.engineConfig.extra_params?.device || ""}|${input.engineConfig.extra_params?.split || ""}|${input.engineConfig.extra_params?.gpu_sync || ""}`;
  const probePlacementMatches =
    input.fitProbePlacementKey == null
    || input.fitProbePlacementKey === currentPlacementKey;

  const perGpuLoad = (() => {
    if (
      learnedGb != null
      && input.learnedGpuBreakdownMib
      && input.learnedGpuBreakdownMib.length === input.gpus.length
    ) {
      const loads = input.learnedGpuBreakdownMib.map((mib) => mib / 1024);
      if (!userSplitMultiGpu || breakdownSpansMultipleGpus(loads)) return loads;
    }
    const probeBreakdown = input.fitProbeGpuBreakdownMib;
    if (
      probePlacementMatches
      && probeBreakdown
      && probeBreakdown.length === input.gpus.length
    ) {
      const loads = probeBreakdown.map((mib) => mib / 1024);
      if (!userSplitMultiGpu || breakdownSpansMultipleGpus(loads)) return loads;
    }
    if (autoSplit || userSplitMultiGpu) {
      return autoSplitPerGpuLoad(gpuProjectionGb, input.gpus, computed.gpuAvailable);
    }
    const loads = Array(input.gpus.length).fill(0);
    loads[computed.targetGpuIdx] = gpuProjectionGb;
    return loads;
  })();

  const fitHint = "ENGINE pre-tunes on load";

  const splitHint = autoSplit
    ? `auto split across ${input.gpus.length} GPU(s) + ${fitHint}`
    : userSplitMultiGpu
      ? `split across ${input.gpus.length} GPU(s) + ${fitHint}`
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

  const showHostRam = hostOffloadGb > 0.5 || exceedsGpuPool;
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
          ? isRealHostOffload
            ? learnedHostGb
              ? `${hostOffloadGb.toFixed(1)} GB on host RAM (measured on prior launch)`
              : `~${hostOffloadGb.toFixed(1)} GB will spill to RAM — engine decides on load`
            : learnedHostGb
              ? `${hostOffloadGb.toFixed(1)} GB host buffer (measured on prior launch)`
              : `~${hostOffloadGb.toFixed(1)} GB host buffer — engine overhead at load`
          : autoSplit
            ? "VRAM spread across GPUs — offload decided at load"
            : assisted
              ? "engine might use some RAM at launch"
              : "Layer offload decided by engine at launch",
        showRamBar: assisted,
        moeRamBar: false,
        offloadWarningText: isRealHostOffload
          ? "Host RAM offload — slower inference"
          : undefined,
      },
    },
    gpuProjectionGb,
    computed.kvCacheGb,
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
    vramTotalGb: Math.round(gpuProjectionGb * 100) / 100,
    formulaVramTotalGb: Math.round(computed.vramTotalGb * 100) / 100,
    learnedFromPreviousRun: learnedExactGb != null,
    learnedInterpolated: curveGb != null,
    learnedCurveCtxs: (input.learnedCurve ?? []).map((p) => p.ctx),
  };
}