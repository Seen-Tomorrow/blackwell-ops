/**
 * GGML-MASTER forecast adapter — measured only, one number, one source.
 *
 *   launch point EXACTLY at this CTX      → EXACT
 *   two or more launch points             → CURVE (line between them)
 *   probe point EXACTLY at this CTX       → MEASURED
 *   one launch point, any other CTX       → INCOMPLETE (scaled by its measured KV)
 *   two probe points (explicit pair)      → INCOMPLETE CURVE (predicted line)
 *   else                                  → null, skeleton / probe button
 *
 * No ctx scaling, no split tax: a point is only valid at the CTX it was measured at, a
 * launch measured the split it ran, and a probe runs with the split it is asked for.
 * Library FIT points are deliberately not consumed — they run fixed q4_0 knobs.
 * A launch that spilled weights to the host is an outcome, not a need.
 */
import type { VramManifest } from "../../../../lib/types";
import { pickFullAutoSingleGpuListPos } from "../../../../lib/fullAutoGpuPick";
import {
  autoSplitPerGpuLoad,
  needsAutoLayerSplit,
} from "../../../../lib/autoVramLaunch";
import {
  buildGpuAllocations,
  barStyleFromNeedTone,
  cfgStr,
  computeGpuAvailableList,
  freePoolHeadroomGb,
  freePoolUtil,
  interpolateLearnedCurveGb,
  kvBytesForQuant,
  launchPaintFromGate,
  needToneFromLaunchPaint,
  parseCtx,
  round2,
  sanitizeLearnedCurve,
} from "../../shared";
import {
  freeFingerprintFromGb,
  isLiveWeightSpill,
  isWeightClassHostSpill,
  lowVramBarInsets,
  ramNeedToneForHost,
  showHostRamBar,
  splitHostRamGb,
} from "../../lowVramProbe";
import { attachMemorySource } from "../memorySource";
import { specDraftPathConfigured } from "../draftPath";
import { resolveSpecAdapter } from "../../../../lib/spec/adapters";
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
  // The configured path, not the draft size, decides which adapter owns the memory
  // semantics — a size of 0 must not silently reclassify an external head as baked-in.
  const draftPathConfigured = specDraftPathConfigured(input);
  const adapter = resolveSpecAdapter(
    cfgStr(input.engineConfig, "spec_type", "") || null,
    draftPathConfigured,
  );
  const learnedHasDraft = adapter ? adapter.memory.learnedIncludesDraft(draftPathConfigured) : false;
  const needsDraftAdd = draftAddon > 0 && !learnedHasDraft;
  // A point is only valid at the context it was measured at — nothing is scaled to another
  // CTX, and nothing is added for split mode: a launch measured the split it ran, and a
  // probe is run with the split it is asked for.
  const probeAnchorCtx = input.fitProbeAnchorCtx ?? 0;
  const probeGbRaw =
    input.fitProbeVramMib != null && input.fitProbeVramMib > 0
      ? input.fitProbeVramMib / 1024
      : null;
  const probeHostGb =
    input.fitProbeHostMib != null && input.fitProbeHostMib > 0
      ? input.fitProbeHostMib / 1024
      : null;

  /** By-design host lookup tables (Engram / PLE) are not spill. */
  const engramGb = Math.max(
    0,
    input.fitProbeEngramMib ?? input.learnedEngramMib ?? input.modelEngramMib ?? 0,
  ) / 1024;

  /** A launch that put weight-class bytes on the host is an outcome, not a need. */
  const hostLooksSpilled = (
    modelMib: number | null | undefined,
    hostMib: number | null | undefined,
  ): boolean => {
    const baseGb =
      modelMib != null && modelMib > 0 ? modelMib / 1024 : (hostMib ?? 0) / 1024;
    return isWeightClassHostSpill(Math.max(0, baseGb - engramGb));
  };

  type ForecastPoint = {
    ctx: number;
    gb: number;
    hostGb: number | null;
    /** Measured KV (ctx) at this point, MiB — the only honest slope for a single point. */
    kvMib: number | null;
    kind: "launch" | "probe";
  };

  const componentsKvMib = (
    rows: Array<{ ctx_mib?: number }> | null | undefined,
  ): number | null => {
    if (!rows?.length) return null;
    const kv = rows.reduce((sum, row) => sum + (row.ctx_mib ?? 0), 0);
    return kv > 0 ? kv : null;
  };

  // A lone point is scaled by its own measured KV — the part of the footprint that really
  // moves with CTX. Weights and compute are held constant, so the figure is an incomplete
  // curve, not a measurement.
  const measuredKvRateGb = (p: ForecastPoint): number | null =>
    p.kvMib != null && p.kvMib > 0 && p.ctx > 0 ? p.kvMib / p.ctx / 1024 : null;

  /** Header geometry, used only when the point carries no measured KV. */
  const geometryKvRateGb = (): number | null => {
    const meta = input.modelMeta;
    const headDim = meta.n_head > 0 ? meta.n_embd / meta.n_head : 0;
    if (!(meta.n_layer > 0) || !(meta.n_head_kv > 0) || !(headDim > 0)) return null;
    const bytesPerToken =
      2 * meta.n_layer * meta.n_head_kv * headDim * kvBytesForQuant(kvQuant);
    return bytesPerToken / 1024 ** 3;
  };

  // A low-VRAM probe away from its CTX is a spill outcome, not a need — never a point.
  const probeAtLiveCtx = probeAnchorCtx <= 0 || probeAnchorCtx === liveCtx;
  const probePoint: ForecastPoint | null =
    probeGbRaw != null && (input.fitProbeMode !== "low_vram" || probeAtLiveCtx)
      ? {
          ctx: probeAnchorCtx > 0 ? probeAnchorCtx : liveCtx,
          gb: probeGbRaw,
          hostGb: probeHostGb,
          kvMib: componentsKvMib(input.fitProbeComponentsMib),
          kind: "probe",
        }
      : null;

  // An on-demand probe pair (or the probe that just ran) — two points make the footprint
  // affine in CTX, so the predicted line captures compute growth, not only KV.
  const probePoints: ForecastPoint[] =
    input.fitProbeMode !== "low_vram"
      ? (input.fitProbeCurve ?? []).map((p) => ({
          ctx: p.ctx,
          gb: p.vramMib / 1024,
          hostGb: p.hostMib != null ? p.hostMib / 1024 : null,
          kvMib: p.kvMib ?? null,
          kind: "probe" as const,
        }))
      : [];
  if (probePoint && !probePoints.some((p) => p.ctx === probePoint.ctx)) {
    probePoints.push(probePoint);
  }
  const probeAsCurve = probePoints.map((p) => ({
    ctx: p.ctx,
    vramMib: p.gb * 1024,
    hostMib: p.hostGb != null ? p.hostGb * 1024 : undefined,
  }));
  const probeLineHit =
    probePoints.length >= 2 ? interpolateLearnedCurveGb(probeAsCurve, liveCtx) : null;
  const probeLineAt = (ctx: number) =>
    probePoints.length >= 2 ? interpolateLearnedCurveGb(probeAsCurve, ctx) : null;
  const probeAtLive = probePoints.find((p) => p.ctx === liveCtx) ?? null;

  // Launch points: measured launches only, and never one that pushed weights to the host.
  const launchPoints: ForecastPoint[] = sanitizeLearnedCurve(input.learnedCurve)
    .filter((p) => !hostLooksSpilled(undefined, p.hostMib))
    .map((p) => ({
      ctx: p.ctx,
      gb: p.vramMib / 1024,
      hostGb: p.hostMib != null ? p.hostMib / 1024 : null,
      kvMib: p.kvMib ?? null,
      kind: "launch" as const,
    }));
  // The exact-key row is the authority at its own CTX; the curve is the broad read.
  const entryCtx = input.learnedAnchorCtx ?? liveCtx;
  const entryGb =
    input.learnedVramMib != null && input.learnedVramMib > 0
      ? input.learnedVramMib / 1024
      : null;
  const entrySpilled = hostLooksSpilled(input.learnedHostModelMib, input.learnedHostMib);
  if (entryGb != null && !entrySpilled) {
    const at = launchPoints.findIndex((p) => p.ctx === entryCtx);
    const entryPoint: ForecastPoint = {
      ctx: entryCtx,
      gb: entryGb,
      hostGb: input.learnedHostMib != null ? input.learnedHostMib / 1024 : null,
      kvMib: componentsKvMib(input.learnedGpuComponentsMib),
      kind: "launch",
    };
    if (at >= 0) launchPoints[at] = entryPoint;
    else launchPoints.push(entryPoint);
    launchPoints.sort((a, b) => a.ctx - b.ctx);
  }

  const curveHit =
    launchPoints.length >= 2
      ? interpolateLearnedCurveGb(
          launchPoints.map((p) => ({
            ctx: p.ctx,
            vramMib: p.gb * 1024,
            hostMib: p.hostGb != null ? p.hostGb * 1024 : undefined,
          })),
          liveCtx,
        )
      : null;

  // One number, one source. An exact launch beats the line; the line beats a single point.
  // A probe is only used where it was taken — it is never dragged to another CTX.
  const exactLaunch = launchPoints.find((p) => p.ctx === liveCtx) ?? null;
  const nearestPoint =
    launchPoints
      .slice()
      .sort((a, b) => {
        const byCtx = Math.abs(a.ctx - liveCtx) - Math.abs(b.ctx - liveCtx);
        if (byCtx !== 0) return byCtx;
        return (a.kind === "launch" ? 0 : 1) - (b.kind === "launch" ? 0 : 1);
      })[0] ?? null;

  type SourceState =
    | "launch_exact"
    | "launch_curve"
    | "probe_exact"
    | "launch_other"
    | "probe_curve"
    | "probe_anchored";
  let source: SourceState;
  let baseGb: number | null = null;
  let chosenHostGb: number | null = null;
  let chosenCtx = liveCtx;
  if (probePoint && probePoint.ctx === liveCtx && input.fitProbeMode === "low_vram") {
    source = "probe_exact";
    baseGb = probePoint.gb;
    chosenHostGb = probePoint.hostGb;
  } else if (exactLaunch) {
    source = "launch_exact";
    baseGb = exactLaunch.gb;
    chosenHostGb = exactLaunch.hostGb;
  } else if (curveHit) {
    source = "launch_curve";
    baseGb = curveHit.vramGb;
    chosenHostGb = curveHit.hostGb;
  } else if (probeAtLive) {
    source = "probe_exact";
    baseGb = probeAtLive.gb;
    chosenHostGb = probeAtLive.hostGb;
  } else if (probeLineHit) {
    // A launch level with a probe slope is the best of both: the measurement fixes the
    // offset, the line fixes the CTX delta.
    const launchAnchor = launchPoints[0] ?? null;
    const atAnchor = launchAnchor ? probeLineAt(launchAnchor.ctx) : null;
    if (launchAnchor && atAnchor) {
      source = "probe_anchored";
      baseGb = Math.max(0, launchAnchor.gb + (probeLineHit.vramGb - atAnchor.vramGb));
    } else {
      source = "probe_curve";
      baseGb = probeLineHit.vramGb;
    }
    chosenHostGb = probeLineHit.hostGb;
  } else if (nearestPoint) {
    source = "launch_other";
    // A single point is not a constant: scale it by its own measured KV. No measured KV
    // (a curve row from an older build) → header geometry; neither → show it unscaled.
    const kvRate = measuredKvRateGb(nearestPoint) ?? geometryKvRateGb();
    baseGb =
      kvRate != null
        ? Math.max(0, nearestPoint.gb + (liveCtx - nearestPoint.ctx) * kvRate)
        : nearestPoint.gb;
    chosenHostGb = nearestPoint.hostGb;
    chosenCtx = nearestPoint.ctx;
  } else {
    return null;
  }

  const isProbeSource =
    source === "probe_exact"
    || source === "probe_curve"
    || source === "probe_anchored";
  const isSingleProbe = source === "probe_exact";
  // A probe never loads the draft head; a launch add-on is only needed when its snapshot
  // did not already include it.
  const withDraft = (gb: number | null): number | null =>
    gb == null ? null : isProbeSource || needsDraftAdd ? gb + draftAddon : gb;
  const estimateGb = withDraft(baseGb);
  if (estimateGb == null || !Number.isFinite(estimateGb) || estimateGb <= 0) return null;

  const learnedGb = source.startsWith("launch") ? estimateGb : null;
  const hostMeasuredGb = chosenHostGb;
  const measurementAtLiveCtx =
    source === "launch_exact" || (isProbeSource && probePoint?.ctx === liveCtx);


  // ASSISTED: NONE means this GPU + offload, never auto-promote to layer.
  // FULL AUTO may still shift when need exceeds the best single card.
  const autoSplit =
    input.fullAutoMode === true && needsAutoLayerSplit(estimateGb, gpuAvailable);
  const targetAvail = autoSplit || userSplitMultiGpu
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

  // learnedHostGb is often a leftover from a stuffed-GPU spill launch — do not
  // treat "we have a host number" as proof this launch will offload.
  const trustFitAtLoad = !overSystemMemory && exceedsGpuPool;
  const fits =
    !overSystemMemory && (trustFitAtLoad || estimateGb <= targetAvail - headroomGb);

  const gpuProjectionGb = estimateGb;
  // Lookup table (Engram / PLE): host by design, and usually the bulk of the measured
  // host figure (125.9 GB on DeepSeek-V4.1). Counting it as spill made every such model
  // paint OVER FREE · SPILL even when the launch offloads nothing.
  const engramNeedGb = engramGb;
  // Only host bytes ABOVE the by-design table can be a weight spill.
  const hostSpillLikeGb = Math.max(0, (hostMeasuredGb ?? 0) - engramNeedGb);
  const hostOffloadGb = isWeightClassHostSpill(hostSpillLikeGb) ? hostSpillLikeGb : 0;
  const currentPlacementKey = `${input.engineConfig.extra_params?.device || ""}|${input.engineConfig.extra_params?.split || ""}|${input.engineConfig.extra_params?.gpu_sync || ""}`;
  const probePlacementMatches =
    input.fitProbePlacementKey == null || input.fitProbePlacementKey === currentPlacementKey;

  const breakdownSpansMultipleGpus = (loadsGb: number[]) =>
    loadsGb.filter((gb) => gb > 0.1).length > 1;

  const scaleLoads = (loadsGb: number[]): number[] => {
    const sum = loadsGb.reduce((a, b) => a + b, 0);
    if (!(sum > 0.05) || !(gpuProjectionGb > 0)) return loadsGb;
    return loadsGb.map((x) => (gpuProjectionGb * x) / sum);
  };

  let perGpuLoad: number[];
  if (
    learnedGb != null &&
    input.learnedGpuBreakdownMib &&
    input.learnedGpuBreakdownMib.length === input.gpus.length
  ) {
    const loads = input.learnedGpuBreakdownMib.map((mib) => Math.max(0, mib / 1024));
    perGpuLoad = !userSplitMultiGpu || breakdownSpansMultipleGpus(loads)
      ? scaleLoads(loads)
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
    const loads = input.fitProbeGpuBreakdownMib.map((mib) => Math.max(0, mib / 1024));
    perGpuLoad = !userSplitMultiGpu || breakdownSpansMultipleGpus(loads)
      ? scaleLoads(loads)
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

  // An applied `-ts` is a fraction of LAYERS, and layer bytes are not that fraction: on
  // DeepSeek-V4.1 the blocks grow 2.9 -> 4.5 GiB, so `-ts 0.550` put 81,241 MiB on CUDA0
  // (51.8% of weights) where a proportional split claimed 99.6 GB on a 95.6 GiB card.
  // The layer plan converts the split into per-card MiB; the bars paint that placement.
  if (input.layerSplitMib?.length === input.gpus.length && gpuProjectionGb > 0) {
    const splitSum = input.layerSplitMib.reduce((sum, mib) => sum + Math.max(0, mib), 0);
    if (splitSum > 0) {
      perGpuLoad = input.layerSplitMib.map(
        (mib) => (gpuProjectionGb * Math.max(0, mib)) / splitSum,
      );
    }
  }

  const liveFreeFp = freeFingerprintFromGb(targetAvail);
  const fittedNgl = input.fitProbeFittedNgl;
  const realSpill = isLiveWeightSpill({
    estimateGb,
    freeGb: targetAvail,
    hostGb: hostSpillLikeGb,
    probeMode: input.fitProbeMode,
    fittedNgl,
    measurementAtLiveCtx,
  });
  const displayHostGb = realSpill
    ? Math.max(hostOffloadGb, hostSpillLikeGb)
    : 0;
  const showHostRam = showHostRamBar({
    hostOffloadGb: displayHostGb,
    realSpill,
    overSystemMemory,
  });
  const useOffloadPalette = (trustFitAtLoad && exceedsGpuPool) || realSpill;
  const multiGpuLoad = perGpuLoad.filter((gb) => gb > 0.1).length > 1;

  const fitHint = "ENGINE pre-tunes on load";
  const splitHint = autoSplit
    ? `auto split across ${input.gpus.length} GPU(s) + ${fitHint}`
    : userSplitMultiGpu
      ? `split across ${input.gpus.length} GPU(s) + ${fitHint}`
      : fitHint;

  const hostOffloadLaunch = useOffloadPalette || realSpill;
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

  /** Compact header — offload/slower live on bars, not here. */
  const launchSummary = !fits
    ? recommendation
      ? `Won't launch — ${recommendation}`
      : "Won't launch — over available memory"
    : multiNote
      ? `Will launch — ${gpuWord}`
      : "Will launch alright";

  const heroText = launchSummary;

  const layerText =
    learnedGb != null
      ? `${gpuProjectionGb.toFixed(1)} GB GPU measured — ${splitHint}`
      : `${gpuProjectionGb.toFixed(1)} GB GPU measured — ${splitHint}`;

  const validatedVramMib = isProbeSource ? Math.round(gpuProjectionGb * 1024) : undefined;
  const validatedHostMib = !isProbeSource
    ? undefined
    : isSingleProbe
      ? input.fitProbeHostMib
      : chosenHostGb != null
        ? Math.round(chosenHostGb * 1024)
        : undefined;
  // History, never gated: what the LAST launch of this config put on the host.
  const lastLaunchSpillGb = entrySpilled
    ? Math.max(
        0,
        (input.learnedHostModelMib != null && input.learnedHostModelMib > 0
          ? input.learnedHostModelMib / 1024
          : (input.learnedHostMib ?? 0) / 1024) - engramNeedGb,
      )
    : 0;

  const launchPaint = launchPaintFromGate(fits, useOffloadPalette);
  const vramFreeUtil = freePoolUtil(estimateGb, targetAvail);
  // Soft OOM only when still full-GPU fit; spill path skips OOM risk copy.
  const vramNeedTone = needToneFromLaunchPaint(
    launchPaint,
    realSpill ? undefined : vramFreeUtil,
  );
  const paintClasses = barStyleFromNeedTone(vramNeedTone);
  const insets = lowVramBarInsets({
    launchPaint,
    freeUtil: vramFreeUtil,
    freeGb: targetAvail,
    estimateGb,
    hostOffloadGb: hostSpillLikeGb,
    overSystemMemory,
    probeMode: input.fitProbeMode,
    probeFreeFingerprint: input.fitProbeFreeFingerprint,
    liveFreeFingerprint: liveFreeFp,
    fittedNgl,
    measurementAtLiveCtx,
  });
  // A ctx outside the measured range is a clamp; ask for a real point instead of
  // pretending the curve knows.
  if (curveHit?.beyondMeasured) {
    insets.needsReprobe = true;
  }
  const spill = realSpill || insets.realSpill;
  const ramNeedTone = ramNeedToneForHost({
    overSystemMemory,
    hostOffloadGb: hostMeasuredGb ?? 0,
    realSpill: spill,
  });

  const hostTotalGb = hostMeasuredGb ?? 0;
  const hostSplit = splitHostRamGb({
    hostGb: hostTotalGb,
    hostModelGb:
      input.fitProbeHostModelMib != null
        ? input.fitProbeHostModelMib / 1024
        : input.learnedHostModelMib != null
          ? input.learnedHostModelMib / 1024
          : null,
    engramGb: engramNeedGb,
    bufferBaselineGb: curveHit?.hostGb,
    realSpill: spill,
  });
  if (spill && !overSystemMemory) {
    insets.ramInset =
      hostSplit.weightGb > 0.05
        ? `OFFLOADING ${hostSplit.weightGb.toFixed(1)}GB TO RAM`
        : "OFFLOADING TO RAM";
  }
  // Total host need is unchanged: buffer + weights + the lookup table.
  const ramNeedGb = hostSplit.bufferGb + hostSplit.weightGb + hostSplit.engramGb;
  const hostEngramGb = hostSplit.engramGb;
  const spillWeightGb = hostSplit.weightGb;

  const base: VramManifest = {
    scenario: "AUTO_FIT",
    style: {
      ...paintClasses,
      icon: vramNeedTone === "ok" ? "*" : "o",
      label: fitLabel,
      launchPaint,
      vramNeedTone,
      ramNeedTone: hostSplit.weightGb > 0.05 ? ramNeedTone : "ok",
      needsLowVramReprobe: insets.needsReprobe,
      uiTemplate: {
        heroText,
        launchSummary,
        gpuLayerText: layerText,
        ramLayerText:
          hostSplit.weightGb > 0.05
            ? `${ramNeedGb.toFixed(1)} GB host (${hostSplit.bufferGb.toFixed(1)} buffer + ${hostSplit.weightGb.toFixed(1)} weight)`
            : ramNeedGb > 0.05
              ? `${ramNeedGb.toFixed(1)} GB host buffer (not layer offload)`
              : autoSplit
                ? "VRAM spread across GPUs — offload decided at load"
                : "engine might use some RAM at launch",
        showRamBar: ramNeedGb > 0.05,
        moeRamBar: false,
        kvSpillRiskText: insets.vramInset,
        offloadWarningText: insets.ramInset,
      },
    },
    vramWeightsGb: round2(weightGb),
    vramTotalGb: round2(gpuProjectionGb),
    ramSpillGb: round2(hostSplit.weightGb),
    ramTotalGb: round2(ramNeedGb),
    ramBufferGb: round2(hostSplit.bufferGb),
    ramWeightGb: round2(spillWeightGb),
    ramEngramGb: round2(hostEngramGb),
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
    autoLayerSplit: autoSplit,
    learnedFromPreviousRun: source === "launch_exact",
    learnedInterpolated: source === "launch_curve",
    learnedCurveCtxs: launchPoints.map((p) => p.ctx),
    forecastCurve: (() => {
      const pts = launchPoints.map((p) => ({ ctx: p.ctx, gb: round2(p.gb) }));
      if (!pts.some((p) => p.ctx === liveCtx)) {
        pts.push({ ctx: liveCtx, gb: round2(estimateGb) });
      }
      return pts;
    })(),
    forecastFreeGb: round2(targetAvail),
    validatedVramMib,
    validatedHostMib,
    validatedGpuBreakdownMib:
      isSingleProbe && probePlacementMatches ? input.fitProbeGpuBreakdownMib : undefined,
    validatedComponentsMib:
      isSingleProbe && probePlacementMatches ? input.fitProbeComponentsMib ?? null : null,
    memorySourceState: source,
    memorySourceAnchorCtx: source === "launch_other" ? chosenCtx : undefined,
    lastLaunchSpillGb: lastLaunchSpillGb > 0.05 ? round2(lastLaunchSpillGb) : undefined,
    lastLaunchSpillAt: lastLaunchSpillGb > 0.05 ? input.learnedMeasuredAt : undefined,
    fitProbeMeasuredAt: isProbeSource ? input.fitProbeMeasuredAt : undefined,
  };

  return attachMemorySource(base, input);
}

export const ggmlMasterAdapter: ForecastAdapter = {
  ids: ["ggml-master", "ggml_master", ""],
  evaluate: evaluateGgmlMaster,
};
