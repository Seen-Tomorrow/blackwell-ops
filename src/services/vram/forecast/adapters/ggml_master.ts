/**
 * GGML-MASTER forecast adapter — measured only.
 *
 * Priority:
 *   1. LEARNED exact @ live ctx (per-split identity)
 *   2. LEARNED≈ curve (probe may seed curve when split=none only)
 *   3. live FIT PROBE at split=none (carries user hard knobs)
 *        + independent split tax @ live CTX from library FIT Δ
 *        (fallback constants only when library Δ missing / non-positive)
 *   4. LEARNED row ctx-delta'd
 *   else null → skeleton / auto-probe
 *
 * No GGUF formula path. Split tax does not depend on live KV/batch/quant.
 */
import type { VramManifest } from "../../../../lib/types";
import { pickFullAutoSingleGpuListPos } from "../../../../lib/fullAutoGpuPick";
import {
  autoSplitPerGpuLoad,
  needsAutoLayerSplit,
} from "../../../../lib/autoVramLaunch";
import {
  adjustMeasuredGbForCtx,
  buildGpuAllocations,
  cfgStr,
  computeGpuAvailableList,
  freePoolHeadroomGb,
  interpolateLearnedCurveGb,
  launchPaintFromGate,
  launchPaintStyleClasses,
  needToneFromLaunchPaint,
  parseCtx,
  resolveSplitTax,
  round2,
} from "../../shared";
import { attachMemorySource } from "../memorySource";
import type { ForecastAdapter, ForecastInput } from "../types";

function draftAddonGb(input: ForecastInput): number {
  const draftWeightsGb =
    (input.draftSizeMib ?? 0) > 0 ? (input.draftSizeMib as number) / 1024 : 0;
  // Measured DS4+DSpark ~0.55× weights + 0.4 base floor.
  const draftOverheadGb = draftWeightsGb > 0 ? Math.max(0.4, draftWeightsGb * 0.55) : 0;
  return draftWeightsGb + draftOverheadGb;
}

function splitActive(input: ForecastInput): boolean {
  const split = cfgStr(input.engineConfig, "split", "none");
  return split.length > 0 && split.toUpperCase() !== "NONE";
}

function targetGpuIdx(input: ForecastInput, gpuAvailable: number[]): number {
  const deviceStr = cfgStr(input.engineConfig, "device", "GPU-0");
  let idx = parseInt(deviceStr.replace("GPU-", "").split("/")[0], 10) || 0;
  if (input.fullAutoMode === true && !splitActive(input) && input.gpus.length > 0) {
    idx = pickFullAutoSingleGpuListPos(input.gpus, gpuAvailable);
  }
  return idx;
}

function evaluateGgmlMaster(input: ForecastInput): VramManifest | null {
  if (input.gpus.length === 0) return null;

  const liveCtx = parseCtx(String(input.engineConfig.extra_params?.ctx ?? "32768"));
  const kvQuant = String(input.engineConfig.extra_params?.kv_quant ?? "f16");
  const fullAuto = input.fullAutoMode === true;
  const gpuAvailable = computeGpuAvailableList(input.gpus, input.runningSlots);
  const multiTotalAvailable = gpuAvailable.reduce((a, b) => a + b, 0);
  const tgt = targetGpuIdx(input, gpuAvailable);
  const userSplitMultiGpu = splitActive(input) && input.gpus.length > 1;
  const draftAddon = draftAddonGb(input);
  // Launch snapshot mtp_context > 64 MiB ⇒ measurement already includes draft/spec buffers.
  const learnedHasDraft = (input.learnedMtpContextMib ?? 0) > 64;
  const needsDraftAdd = draftAddon > 0 && !learnedHasDraft;
  const withDraft = (gb: number | null): number | null =>
    gb == null ? null : needsDraftAdd ? gb + draftAddon : gb;
  const splitMode = cfgStr(input.engineConfig, "split", "none");
  // Independent of live KV/batch/quant — library Δ(split−none) @ CTX, else fallback constants.
  const splitTax = resolveSplitTax(splitMode, liveCtx, input.fitPoints);
  const splitTaxGb = splitTax.taxGb;

  const probeGb = input.fitProbeVramMib != null ? input.fitProbeVramMib / 1024 : null;
  const probeHostGb = input.fitProbeHostMib != null ? input.fitProbeHostMib / 1024 : null;
  const probeAnchor = input.fitProbeAnchorCtx ?? 0;
  // Never seed a layer/tensor learned curve with a split=none probe point.
  const probeAppliesToCurve = probeGb != null && splitTaxGb <= 0;

  const mergedCurve = (input.learnedCurve ?? []).map((p) => ({ ...p }));
  if (probeAppliesToCurve && probeAnchor > 0 && !mergedCurve.some((p) => p.ctx === probeAnchor)) {
    mergedCurve.push({
      ctx: probeAnchor,
      vramMib: (probeGb + draftAddon) * 1024,
      hostMib: probeHostGb != null ? probeHostGb * 1024 : undefined,
    });
  }

  const curveHit = interpolateLearnedCurveGb(mergedCurve, liveCtx);
  const learnedExactGb = input.learnedCurve?.some((p) => p.ctx === liveCtx)
    ? (curveHit?.vramGb ?? null)
    : null;
  const curveGb =
    learnedExactGb == null && curveHit && mergedCurve.length >= 2 ? curveHit.vramGb : null;

  const rawLearnedGb = input.learnedVramMib != null ? input.learnedVramMib / 1024 : null;
  const learnedBaseGb =
    rawLearnedGb != null
      ? rawLearnedGb + (needsDraftAdd ? draftAddon : 0)
      : null;
  const learnedDeltaGb =
    learnedBaseGb != null && learnedExactGb == null && curveGb == null
      ? adjustMeasuredGbForCtx(
          learnedBaseGb,
          input.learnedAnchorCtx ?? liveCtx,
          liveCtx,
          input.fitPoints,
          input.modelMeta,
          kvQuant,
        )
      : null;

  // 1) Bring none-probe to live CTX (hard knobs live inside the probe).
  // 2) Add split tax at live CTX — separate measured delta, not baked into CTX adjust.
  // FIT probe never loads external draft GGUF — always add draft addon when active.
  const probeNoneAtLiveGb =
    curveGb == null && learnedExactGb == null && probeGb != null
      ? adjustMeasuredGbForCtx(
          probeGb + draftAddon,
          probeAnchor || liveCtx,
          liveCtx,
          input.fitPoints,
          input.modelMeta,
          kvQuant,
        )
      : null;
  const probeWithDraftGb =
    probeNoneAtLiveGb != null ? probeNoneAtLiveGb + splitTaxGb : null;

  // Prefer learned exact/curve for this split (+ draft if measurement lacked it);
  // else probe(none)+tax+draft; else learned delta (already bumped).
  const estimateGb =
    withDraft(learnedExactGb) ?? withDraft(curveGb) ?? probeWithDraftGb ?? learnedDeltaGb;
  if (estimateGb == null) return null;

  const learnedGb = withDraft(learnedExactGb) ?? withDraft(curveGb) ?? learnedDeltaGb;
  const learnedHostGb =
    curveHit?.hostGb ??
    (rawLearnedGb != null && input.learnedHostMib != null ? input.learnedHostMib / 1024 : null);

  const autoSplit = needsAutoLayerSplit(estimateGb, gpuAvailable);
  const targetAvail = autoSplit
    ? multiTotalAvailable
    : (gpuAvailable[tgt] ?? Math.max(...gpuAvailable, 0));
  const headroomGb = freePoolHeadroomGb(targetAvail);
  const exceedsGpuPool = estimateGb > targetAvail - headroomGb;

  // System pool gate — weight file + measured host if known.
  const weightGb = input.modelMeta.file_size_bytes / 1024 ** 3;
  const systemAvailableGb = multiTotalAvailable + input.ramAvailableGb;
  const systemHeadroom = Math.max(2.0, systemAvailableGb * 0.02);
  const modelFootprintGb = Math.max(estimateGb, weightGb);
  const overSystemMemory = modelFootprintGb > systemAvailableGb - systemHeadroom;

  const trustFitAtLoad = !overSystemMemory && (exceedsGpuPool || learnedHostGb != null);
  const fits =
    !overSystemMemory && (trustFitAtLoad || estimateGb <= targetAvail - headroomGb);

  const gpuProjectionGb = estimateGb;
  const hostOffloadGb =
    learnedHostGb ??
    probeHostGb ??
    (exceedsGpuPool ? Math.max(0, estimateGb - Math.max(targetAvail - headroomGb, 0)) : 0);

  const currentPlacementKey = `${input.engineConfig.extra_params?.device || ""}|${input.engineConfig.extra_params?.split || ""}|${input.engineConfig.extra_params?.gpu_sync || ""}`;
  const probePlacementMatches =
    input.fitProbePlacementKey == null || input.fitProbePlacementKey === currentPlacementKey;

  const breakdownSpansMultipleGpus = (loadsGb: number[]) =>
    loadsGb.filter((gb) => gb > 0.1).length > 1;

  let perGpuLoad: number[];
  if (
    learnedGb != null &&
    input.learnedGpuBreakdownMib &&
    input.learnedGpuBreakdownMib.length === input.gpus.length
  ) {
    const loads = input.learnedGpuBreakdownMib.map((mib) => mib / 1024);
    perGpuLoad = !userSplitMultiGpu || breakdownSpansMultipleGpus(loads)
      ? loads
      : autoSplit || userSplitMultiGpu
        ? autoSplitPerGpuLoad(gpuProjectionGb, input.gpus, gpuAvailable)
        : (() => {
            const loads0 = Array(input.gpus.length).fill(0);
            loads0[tgt] = gpuProjectionGb;
            return loads0;
          })();
  } else if (
    probePlacementMatches &&
    input.fitProbeGpuBreakdownMib &&
    input.fitProbeGpuBreakdownMib.length === input.gpus.length
  ) {
    const loads = input.fitProbeGpuBreakdownMib.map((mib) => mib / 1024);
    perGpuLoad = !userSplitMultiGpu || breakdownSpansMultipleGpus(loads)
      ? loads
      : autoSplit || userSplitMultiGpu
        ? autoSplitPerGpuLoad(gpuProjectionGb, input.gpus, gpuAvailable)
        : (() => {
            const loads0 = Array(input.gpus.length).fill(0);
            loads0[tgt] = gpuProjectionGb;
            return loads0;
          })();
  } else if (autoSplit || userSplitMultiGpu) {
    perGpuLoad = autoSplitPerGpuLoad(gpuProjectionGb, input.gpus, gpuAvailable);
  } else {
    perGpuLoad = Array(input.gpus.length).fill(0);
    perGpuLoad[tgt] = gpuProjectionGb;
  }

  const headroomThreshold = targetAvail - headroomGb;
  const totalProjectedGb = gpuProjectionGb + hostOffloadGb;
  const isRealHostOffload = totalProjectedGb > headroomThreshold + 0.1;
  const showHostRam = hostOffloadGb > 0.5 || exceedsGpuPool;
  const useOffloadPalette = trustFitAtLoad && exceedsGpuPool;
  const multiGpuLoad = perGpuLoad.filter((gb) => gb > 0.1).length > 1;

  const fitHint = "ENGINE pre-tunes on load";
  const splitHint = autoSplit
    ? `auto split across ${input.gpus.length} GPU(s) + ${fitHint}`
    : userSplitMultiGpu
      ? `split across ${input.gpus.length} GPU(s) + ${fitHint}`
      : fitHint;

  const hostOffloadLaunch = useOffloadPalette || (isRealHostOffload && hostOffloadGb > 0.5);
  const multiNote =
    autoSplit || multiGpuLoad || (!fullAuto && splitActive(input) && input.gpus.length > 1);
  const gpuWord =
    multiNote
      ? autoSplit
        ? `auto layer-split across ${input.gpus.length} GPUs`
        : `split across ${input.gpus.length} GPUs`
      : input.gpus.length > 1
        ? `full on GPU-${tgt}`
        : "full on GPU";

  const recommendation = overSystemMemory
    ? `needs ~${modelFootprintGb.toFixed(0)}G but only ~${systemAvailableGb.toFixed(0)}G free (VRAM+RAM)`
    : !fits && !trustFitAtLoad
      ? "needs more free VRAM — lower CTX or free a GPU"
      : "";

  // Compact chip label (scenario style). Glass always uses launchSummary.
  const fitLabel = !fits
    ? "NO FIT"
    : hostOffloadLaunch
      ? "OFFLOAD"
      : multiNote
        ? "MULTI"
        : "SINGLE";

  /** Personal one-liner — forecast header (not hard knobs; those live on the cockpit). */
  const launchSummary = !fits
    ? recommendation
      ? `Model won't launch — ${recommendation}`
      : "Model won't launch — projected over available memory"
    : hostOffloadLaunch
      ? multiNote
        ? `Model will launch with some RAM offload (${gpuWord}) — slower`
        : "Model will launch with some RAM offload — slower"
      : multiNote
        ? `Model will launch alright — ${gpuWord}`
        : "Model will launch alright";

  const heroText = launchSummary;

  const layerText =
    learnedGb != null
      ? `${gpuProjectionGb.toFixed(1)} GB GPU measured — ${splitHint}`
      : `${gpuProjectionGb.toFixed(1)} GB GPU measured — ${splitHint}`;

  const isProbePrimary =
    learnedExactGb == null && curveGb == null && probeWithDraftGb != null;
  const validatedVramMib = isProbePrimary
    ? Math.round(gpuProjectionGb * 1024)
    : input.fitProbeVramMib;
  const validatedHostMib = isProbePrimary
    ? input.fitProbeHostMib
    : input.fitProbeHostMib ?? (learnedHostGb != null ? Math.round(learnedHostGb * 1024) : undefined);

  const launchPaint = launchPaintFromGate(fits, useOffloadPalette);
  const paintClasses = launchPaintStyleClasses(launchPaint);
  const vramNeedTone = needToneFromLaunchPaint(launchPaint);
  // RAM NEED tracks host spill / system OOM — same paint steps as bar (no soft band).
  const ramLaunchPaint = overSystemMemory
    ? ("nofit" as const)
    : hostOffloadLaunch && hostOffloadGb > 0.5
      ? ("offload" as const)
      : ("fit" as const);
  const ramNeedTone = needToneFromLaunchPaint(ramLaunchPaint);


  const base: VramManifest = {
    scenario: "AUTO_FIT",
    style: {
      ...paintClasses,
      icon: useOffloadPalette ? "o" : "*",
      label: fitLabel,
      ramVisible: showHostRam,
      launchPaint,
      vramNeedTone,
      ramNeedTone,
      uiTemplate: {
        heroText,
        launchSummary,
        gpuLayerText: layerText,
        ramLayerText: showHostRam
          ? isRealHostOffload
            ? learnedHostGb != null
              ? `${hostOffloadGb.toFixed(1)} GB on host RAM (measured on prior launch)`
              : `~${hostOffloadGb.toFixed(1)} GB will spill to RAM — engine decides on load`
            : learnedHostGb != null
              ? `${hostOffloadGb.toFixed(1)} GB host buffer (measured on prior launch)`
              : `~${hostOffloadGb.toFixed(1)} GB host buffer — engine overhead at load`
          : autoSplit
            ? "VRAM spread across GPUs — offload decided at load"
            : "engine might use some RAM at launch",
        showRamBar: true,
        moeRamBar: false,
        offloadWarningText: isRealHostOffload ? "Host RAM offload — slower inference" : undefined,
      },
    },
    vramWeightsGb: round2(weightGb),
    vramKvGb: 0,
    vramOverheadGb: 0,
    vramTotalGb: round2(gpuProjectionGb),
    ramWeightsGb: 0,
    ramKvGb: 0,
    ramSpillGb: round2(hostOffloadGb),
    ramTotalGb: round2(hostOffloadGb),
    ramManufacturedGb: input.ramManufacturedGb,
    ramAvailableGb: input.ramAvailableGb,
    gpuAllocations: buildGpuAllocations(
      input.gpus,
      input.runningSlots,
      perGpuLoad,
      gpuAvailable,
    ),
    fits,
    recommendation,
    gpuLayers: 0,
    ramLayers: 0,
    autoLayerSplit: autoSplit,
    learnedFromPreviousRun: learnedExactGb != null,
    learnedInterpolated: curveGb != null,
    learnedCurveCtxs: (input.learnedCurve ?? []).map((p) => p.ctx),
    forecastCurve: (() => {
      const pts = mergedCurve.map((p) => ({
        ctx: p.ctx,
        gb: round2(p.vramMib / 1024),
      }));
      if (!pts.some((p) => p.ctx === liveCtx)) {
        pts.push({ ctx: liveCtx, gb: round2(estimateGb) });
      }
      return pts;
    })(),
    forecastFreeGb: round2(targetAvail),
    validatedVramMib,
    validatedHostMib,
    validatedGpuBreakdownMib: probePlacementMatches
      ? input.fitProbeGpuBreakdownMib
      : undefined,
    fitProbeMeasuredAt: input.fitProbeMeasuredAt,
  };

  return attachMemorySource(base, input);
}

export const ggmlMasterAdapter: ForecastAdapter = {
  ids: ["ggml-master", "ggml_master", ""],
  evaluate: evaluateGgmlMaster,
};
