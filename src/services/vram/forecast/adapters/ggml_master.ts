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
  forecastBarInsets,
  freePoolHeadroomGb,
  freePoolUtil,
  interpolateLearnedCurveGb,
  isWeightClassHostSpill,
  kvBytesForQuant,
  launchPaintFromGate,
  needToneFromLaunchPaint,
  parseCtx,
  ramNeedToneForHost,
  round2,
  sanitizeLearnedCurve,
  splitHostRamGb,
} from "../../shared";
import { attachMemorySource } from "../memorySource";
import { runtimeOverheadMibForDevice } from "../../../../lib/vramLayerPlan";
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

/**
 * Multi-GPU AUTO expert cache sizing:
 * Upstream llama.cpp splits `--moe-cache-mib` across active GPUs using `--tensor-split` weights.
 * Each active GPU `i` caps total cache at `(free_i - base_i - reserve_i) / w_i`; the tightest
 * card wins, capped by `hostExpertsGb`, snapped down to 256 MiB.
 */
export function computeAutoMoeCacheGb(opts: {
  perGpuBaseGb: number[];
  gpuAvailableGb: number[];
  hostExpertsGb: number;
  targetIdx: number;
  splitWeights?: number[];
}): { totalCacheGb: number; perGpuCacheGb: number[] } {
  const n = opts.perGpuBaseGb.length;
  const zero = { totalCacheGb: 0, perGpuCacheGb: Array(n).fill(0) };
  if (n === 0) return zero;

  const activeIndices: number[] = [];
  for (let i = 0; i < n; i++) {
    if (opts.perGpuBaseGb[i] > 0.1) activeIndices.push(i);
  }
  if (activeIndices.length === 0) {
    const idx = Math.max(0, Math.min(n - 1, opts.targetIdx));
    activeIndices.push(idx);
  }

  const rawWeights = activeIndices.map((i) => {
    const sw = opts.splitWeights?.[i];
    if (sw != null && sw > 0) return sw;
    return opts.perGpuBaseGb[i] > 0.1 ? opts.perGpuBaseGb[i] : 1;
  });
  const weightSum = rawWeights.reduce((a, b) => a + b, 0);
  const weights = new Map<number, number>();
  activeIndices.forEach((gpuIdx, pos) => {
    weights.set(gpuIdx, weightSum > 0 ? rawWeights[pos] / weightSum : 1 / activeIndices.length);
  });

  let maxFitTotalGb = Number.POSITIVE_INFINITY;
  for (const i of activeIndices) {
    const free = Math.max(0, opts.gpuAvailableGb[i] ?? 0);
    const reserve = Math.max(1.25, freePoolHeadroomGb(free) + 0.25);
    const avail = Math.max(0, free - opts.perGpuBaseGb[i] - reserve);
    const w = weights.get(i) ?? 0;
    if (w > 0) {
      maxFitTotalGb = Math.min(maxFitTotalGb, avail / w);
    }
  }
  if (!Number.isFinite(maxFitTotalGb)) maxFitTotalGb = 0;

  const cappedGb =
    opts.hostExpertsGb > 0 ? Math.min(maxFitTotalGb, opts.hostExpertsGb) : maxFitTotalGb;
  const totalCacheMib = Math.floor((Math.max(0, cappedGb) * 1024) / 256) * 256;
  if (totalCacheMib < 512) return zero;

  const totalCacheGb = totalCacheMib / 1024;
  const perGpuCacheGb = Array(n).fill(0);
  for (const i of activeIndices) {
    perGpuCacheGb[i] = totalCacheGb * (weights.get(i) ?? 0);
  }
  return { totalCacheGb, perGpuCacheGb };
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
  const draftPathConfigured = specDraftPathConfigured(input);
  // A draft SIZE without a draft IDENTITY (spec off, stale path from another model, or a
  // file-picker sentinel) is not a launch component.
  const draftAddon = draftPathConfigured ? draftAddonGb(input) : 0;
  const adapter = resolveSpecAdapter(
    cfgStr(input.engineConfig, "spec_type", "") || null,
    draftPathConfigured,
  );
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
    _hostMib: number | null | undefined,
    engramMib?: number | null,
    allowHostFallback = false,
  ): boolean => {
    // Only a host MODEL row is evidence of weight spill. Falling back to the whole host
    // figure classified a normal spec launch (which adds draft host buffers and has no
    // component breakdown) as spilled, so the exact learned row was dropped for a probe.
    if (modelMib != null && modelMib > 0) {
      const baseGb = modelMib / 1024;
      // Prefer the launch's own measured lookup table; the GGUF header can be missing.
      const engram =
        engramMib != null && engramMib > 0 ? engramMib / 1024 : engramGb;
      return isWeightClassHostSpill(Math.max(0, baseGb - engram));
    }
    // Legacy curve rows have no component breakdown; a huge host figure is still a spill.
    // Do not apply this to an exact spec row: draft host buffers are a few GB.
    if (!allowHostFallback) return false;
    const hostGb = (_hostMib ?? 0) / 1024;
    const engram = engramMib != null && engramMib > 0 ? engramMib / 1024 : engramGb;
    return isWeightClassHostSpill(Math.max(0, hostGb - engram));
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

  const probePoint: ForecastPoint | null =
    probeGbRaw != null
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
  const probePoints: ForecastPoint[] = (input.fitProbeCurve ?? []).map((p) => ({
    ctx: p.ctx,
    gb: p.vramMib / 1024,
    hostGb: p.hostMib != null ? p.hostMib / 1024 : null,
    kvMib: p.kvMib ?? null,
    kind: "probe" as const,
  }));
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
  // `-cmoe` is the exception: host model weights are the chosen expert placement, so a row
  // measured under it is the authority for the CPU-expert regime, not a spill to discard.
  const expertsOnHost = input.moeCpuExperts === true;
  const launchPoints: ForecastPoint[] = sanitizeLearnedCurve(input.learnedCurve)
    .filter(
      (p) =>
        expertsOnHost || !hostLooksSpilled(p.hostModelMib, p.hostMib, p.engramMib, true),
    )
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
  const entrySpilled =
    !expertsOnHost && hostLooksSpilled(input.learnedHostModelMib, input.learnedHostMib);
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
  if (exactLaunch) {
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

  // The backend's `spec_included` answers only for the exact-key row. Curve points are not
  // tagged, so fall back to the adapter's shape rule for them and for probes.
  const learnedHasDraft =
    (source === "launch_exact" ? input.learnedSpecIncluded : undefined)
    ?? (adapter ? adapter.memory.learnedIncludesDraft(draftPathConfigured) : false);
  const needsDraftAdd = draftAddon > 0 && !learnedHasDraft;

  // FIT never loads the draft head or the vision projector, so a pure probe needs them on
  // top. An anchored curve already carries the launch's level (which included both) and its
  // delta comes from two probes that excluded both — adding either would double-count.
  const addDraft =
    needsDraftAdd || source === "probe_exact" || source === "probe_curve";
  const withDraft = (gb: number | null): number | null =>
    gb == null ? null : addDraft ? gb + draftAddon : gb;
  // The vision projector is a separate model load that the engine's buffer inventory does not
  // report (it loads after the main model, through mtmd). Measured on the 27B: +888 MiB, exactly
  // `mmproj_size_mib`, on CUDA0. Add the file size to that card; do not split it across cards.
  const visionAddonGb =
    input.visionOn && (input.mmprojSizeMib ?? 0) > 0
      ? (input.mmprojSizeMib as number) / 1024
      : 0;
  const baseWithDraft = withDraft(baseGb);
  if (baseWithDraft == null || !Number.isFinite(baseWithDraft) || baseWithDraft <= 0) {
    return null;
  }
  const estimateGb = baseWithDraft;

  const learnedGb = source.startsWith("launch") ? estimateGb : null;
  const hostMeasuredGb = chosenHostGb;


  // ASSISTED: NONE means this GPU + offload, never auto-promote to layer.
  // FULL AUTO may still shift when need exceeds the best single card.
  const autoSplit =
    input.fullAutoMode === true && needsAutoLayerSplit(estimateGb + visionAddonGb, gpuAvailable);
  const targetAvail = autoSplit || userSplitMultiGpu
    ? multiTotalAvailable
    : (gpuAvailable[tgt] ?? Math.max(...gpuAvailable, 0));

  // System pool numbers — the verdict is decided once the per-card loads are true loads.
  const weightGb = input.modelMeta.file_size_bytes / 1024 ** 3;
  const systemAvailableGb = multiTotalAvailable + input.ramAvailableGb;
  const systemHeadroom = Math.max(2.0, systemAvailableGb * 0.02);
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
    if (!(sum > 0.05) || !(estimateGb > 0)) return loadsGb;
    return loadsGb.map((x) => (estimateGb * x) / sum);
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
        ? autoSplitPerGpuLoad(estimateGb, input.gpus, gpuAvailable)
        : (() => {
            const loads0 = Array(input.gpus.length).fill(0);
            loads0[tgt] = estimateGb;
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
        ? autoSplitPerGpuLoad(estimateGb, input.gpus, gpuAvailable)
        : (() => {
            const loads0 = Array(input.gpus.length).fill(0);
            loads0[tgt] = estimateGb;
            return loads0;
          })();
  } else if (autoSplit || userSplitMultiGpu) {
    perGpuLoad = autoSplitPerGpuLoad(estimateGb, input.gpus, gpuAvailable);
  } else {
    perGpuLoad = Array(input.gpus.length).fill(0);
    perGpuLoad[tgt] = estimateGb;
  }

  // An applied `-ts` is a fraction of LAYERS, and layer bytes are not that fraction: on
  // DeepSeek-V4.1 the blocks grow 2.9 -> 4.5 GiB, so `-ts 0.550` put 81,241 MiB on CUDA0
  // (51.8% of weights) where a proportional split claimed 99.6 GB on a 95.6 GiB card.
  // The layer plan converts the split into per-card MiB; the bars paint that placement.
  if (input.layerSplitMib?.length === input.gpus.length && estimateGb > 0) {
    const splitSum = input.layerSplitMib.reduce((sum, mib) => sum + Math.max(0, mib), 0);
    if (splitSum > 0) {
      perGpuLoad = input.layerSplitMib.map(
        (mib) => (estimateGb * Math.max(0, mib)) / splitSum,
      );
    }
  }

  if (visionAddonGb > 0) {
    const mmprojGpu = autoSplit || userSplitMultiGpu ? 0 : tgt;
    if (perGpuLoad[mmprojGpu] != null) {
      perGpuLoad[mmprojGpu] += visionAddonGb;
    }
  }

  // What the card actually loses, not what the engine prints: every touched device also
  // carries the CUDA context, graph pools and allocator slack.
  const perGpuBaseGb = perGpuLoad.map((gb, i) =>
    gb > 0.1
      ? gb + runtimeOverheadMibForDevice(input.gpus[i].index, input.gpuCalibration) / 1024
      : gb,
  );
  const baseVramGb = perGpuBaseGb.reduce((sum, gb) => sum + gb, 0);

  // `-cmoe` reserves an expert cache in VRAM. In AUTO mode it fills remaining headroom up to
  // `free - reserve` across active GPUs; in MANUAL mode it adds `moeCacheMib` proportionally.
  const cpuExperts = input.moeCpuExperts === true;
  const autoCache = cpuExperts && input.moeCacheAuto === true;
  // Conservation check: non-Engram model weights on host cannot exceed (file_size - engram).
  // On models like DeepSeek-V4.1, `llama-fit-params` includes the 125.9 GB Engram table in
  // its Host column (272.8 GB > 279.8 - 125.9 = 153.9 GB), whereas Qwen3.8-Flash lazy-read
  // PLE is excluded from Host (32.3 GB <= 61.9 - 26.8 = 35.1 GB).
  const LAZY_ENGRAM_THRESHOLD_GB = 4.0;
  const engramIsLazy = engramNeedGb > LAZY_ENGRAM_THRESHOLD_GB;
  const nonEngramModelGb = Math.max(0, weightGb - engramNeedGb);
  const hostAlreadyIncludesEngram =
    engramNeedGb > 0
    && hostMeasuredGb != null
    && hostMeasuredGb >= engramNeedGb
    && (!cpuExperts || hostMeasuredGb > nonEngramModelGb + 2.0);
  const hostExpertsGb = cpuExperts
    ? Math.max(0, (hostMeasuredGb ?? 0) - (hostAlreadyIncludesEngram ? engramNeedGb : 0))
    : 0;
  const residentHostGb = engramIsLazy
    ? Math.max(0, (hostMeasuredGb ?? 0) - (hostAlreadyIncludesEngram ? engramNeedGb : 0))
    : (hostMeasuredGb ?? 0) + (engramNeedGb > 0 && !hostAlreadyIncludesEngram ? engramNeedGb : 0);
  let effectiveCacheGb = 0;
  if (cpuExperts) {
    if (autoCache) {
      const auto = computeAutoMoeCacheGb({
        perGpuBaseGb,
        gpuAvailableGb: gpuAvailable,
        hostExpertsGb,
        targetIdx: tgt,
        splitWeights: input.layerSplitMib,
      });
      effectiveCacheGb = auto.totalCacheGb;
      perGpuLoad = perGpuBaseGb.map((gb, i) => gb + auto.perGpuCacheGb[i]);
    } else {
      effectiveCacheGb = Math.max(0, input.moeCacheMib ?? 0) / 1024;
      const activeSum = perGpuBaseGb.reduce((sum, gb) => sum + Math.max(0, gb), 0);
      perGpuLoad =
        effectiveCacheGb > 0
          ? activeSum > 0.05
            ? perGpuBaseGb.map((gb) => (gb > 0.1 ? gb + (effectiveCacheGb * gb) / activeSum : gb))
            : perGpuBaseGb.map((gb, i) => (i === tgt ? gb + effectiveCacheGb : gb))
          : perGpuBaseGb;
    }
  } else {
    effectiveCacheGb = Math.max(0, input.moeCacheMib ?? 0) / 1024;
    if (effectiveCacheGb > 0) {
      const activeSum = perGpuBaseGb.reduce((sum, gb) => sum + Math.max(0, gb), 0);
      perGpuLoad =
        activeSum > 0.05
          ? perGpuBaseGb.map((gb) => (gb > 0.1 ? gb + (effectiveCacheGb * gb) / activeSum : gb))
          : perGpuBaseGb.map((gb, i) => (i === tgt ? gb + effectiveCacheGb : gb));
    } else {
      perGpuLoad = perGpuBaseGb;
    }
  }
  const gpuProjectionGb = perGpuLoad.reduce((sum, gb) => sum + gb, 0);

  // Per-CARD gate. In AUTO cache mode, base must fit (cache fills remaining headroom intentionally).
  const cardFits = perGpuLoad.map((gb, i) => {
    const checkGb = autoCache ? perGpuBaseGb[i] : gb;
    if (!(checkGb > 0.1)) return true;
    const free = gpuAvailable[i] ?? 0;
    return checkGb <= free - freePoolHeadroomGb(free);
  });
  const fitsAllCards = cardFits.every(Boolean);
  const exceedsGpuPool = !fitsAllCards;

  const hostRamHeadroom = Math.max(2.0, input.ramAvailableGb * 0.02);
  const overHostRam =
    input.ramAvailableGb > 0 && residentHostGb > input.ramAvailableGb - hostRamHeadroom;
  const pinnedRamCapGb =
    input.ramManufacturedGb > 0
      ? Math.min(input.ramAvailableGb - hostRamHeadroom, input.ramManufacturedGb * 0.5)
      : input.ramAvailableGb - hostRamHeadroom;
  const ssdPaged =
    cpuExperts && input.ramAvailableGb > 0 && hostExpertsGb > Math.max(0, pinnedRamCapGb);
  const residentWeightGb = engramIsLazy ? nonEngramModelGb : weightGb;
  const modelFootprintGb = Math.max(gpuProjectionGb, residentWeightGb);
  const overSystemMemory = ssdPaged
    ? false
    : modelFootprintGb > systemAvailableGb - systemHeadroom || overHostRam;

  const trustFitAtLoad = !overSystemMemory && exceedsGpuPool;
  const fits = !overSystemMemory;
  const verdict: "fits" | "spill" | "none" = !fits
    ? "none"
    : fitsAllCards && !autoSplit && !userSplitMultiGpu
      ? "fits"
      : "spill";
  // Soft tone bands follow the worst CARD, not the pool.
  const vramFreeUtil = perGpuLoad.reduce((worst, gb, i) => {
    const checkGb = autoCache ? perGpuBaseGb[i] : gb;
    if (!(checkGb > 0.1)) return worst;
    const free = gpuAvailable[i] ?? 0;
    return Math.max(worst, freePoolUtil(checkGb, free));
  }, 0);

  const realSpill =
    !cpuExperts &&
    (hostOffloadGb > 2.5 || (targetAvail > 0 && gpuProjectionGb > targetAvail - freePoolHeadroomGb(targetAvail)));
  const useOffloadPalette = !cpuExperts && ((trustFitAtLoad && exceedsGpuPool) || realSpill);
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

  const recommendation = ssdPaged
    ? ""
    : overHostRam
      ? `needs ~${residentHostGb.toFixed(0)}G RAM but only ~${input.ramAvailableGb.toFixed(0)}G free`
      : overSystemMemory
        ? `needs ~${modelFootprintGb.toFixed(0)}G but only ~${systemAvailableGb.toFixed(0)}G free (VRAM+RAM)`
        : "";

  // Compact chip label (scenario style). Glass always uses launchSummary.
  const fitLabel =
    verdict === "none" ? "NO FIT" : verdict === "spill" ? (hostOffloadLaunch ? "OFFLOAD" : "MULTI") : "SINGLE";

  /**
   * Three verdicts, and they mean what they say: FITS is fully on the GPU, the spill tier
   * names the outcome, and WON'T RUN is the only hard no.
   */
  const launchSummary =
    verdict === "none"
      ? recommendation
        ? `Won't run — ${recommendation}`
        : "Won't run — over available memory"
      : !fitsAllCards
        ? hostOffloadGb > 0.05
          ? `Fits with spill — +${hostOffloadGb.toFixed(1)} GB to RAM`
          : "Fits with spill — RAM offload expected"
        : `Fits — ${gpuWord}`;

  const cacheMib = Math.round(effectiveCacheGb * 1024);
  const cpuExpertsSummary = cpuExperts
    ? !fits
      ? `Overdrive — won't run (${recommendation || "over system RAM"})`
      : `Overdrive${ssdPaged ? " · SSD-PAGED" : ""}${cacheMib > 0 ? ` · ${autoCache ? "AUTO" : "MANUAL"} ${(cacheMib / 1024).toFixed(1)} GB cache` : ""} — ${
          fitsAllCards ? (ssdPaged ? "fits (--no-host)" : "fits") : "over device free"
        }`
    : launchSummary;

  const heroText = cpuExpertsSummary;

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
  const lastLaunchSpillGb =
    input.learnedSpilledHostMib != null && input.learnedSpilledHostMib > 0
      ? input.learnedSpilledHostMib / 1024
      : entrySpilled
        ? Math.max(
            0,
            (input.learnedHostModelMib != null && input.learnedHostModelMib > 0
              ? input.learnedHostModelMib / 1024
              : (input.learnedHostMib ?? 0) / 1024) - engramNeedGb,
          )
        : 0;

  const launchPaint = cpuExperts
    ? fits && fitsAllCards
      ? "fit"
      : fits
        ? "offload"
        : "nofit"
    : launchPaintFromGate(fits, useOffloadPalette);
  const vramNeedTone =
    cpuExperts && autoCache && fitsAllCards
      ? "ok"
      : needToneFromLaunchPaint(launchPaint, realSpill ? undefined : vramFreeUtil);
  const paintClasses = barStyleFromNeedTone(vramNeedTone);
  const insets = forecastBarInsets({
    launchPaint,
    freeUtil: vramFreeUtil,
    freeGb: targetAvail,
    estimateGb: autoCache ? baseVramGb : gpuProjectionGb,
    hostOffloadGb: cpuExperts ? 0 : hostSpillLikeGb,
    overSystemMemory,
  });
  const spill = !cpuExperts && (realSpill || insets.realSpill);
  const ramNeedTone = cpuExperts
    ? overSystemMemory
      ? "hot"
      : ssdPaged
        ? "warn"
        : "ok"
    : ramNeedToneForHost({
        overSystemMemory,
        hostOffloadGb: hostSpillLikeGb,
        realSpill: spill,
      });

  // The lookup table is host by design and is deliberately absent from the engine's host
  // buffer ledger. Put it back into the RAM total; it is not VRAM and not a weight spill.
  const rawHostModelGb =
    input.fitProbeHostModelMib != null
      ? input.fitProbeHostModelMib / 1024
      : input.learnedHostModelMib != null
        ? input.learnedHostModelMib / 1024
        : null;
  const residentHostModelGb =
    rawHostModelGb != null && hostAlreadyIncludesEngram && engramIsLazy
      ? Math.max(0, rawHostModelGb - engramNeedGb)
      : rawHostModelGb;
  const hostSplit = splitHostRamGb({
    hostGb: residentHostGb,
    hostModelGb: residentHostModelGb,
    engramGb: engramIsLazy ? 0 : engramNeedGb,
    bufferBaselineGb: curveHit?.hostGb,
    realSpill: spill,
  });
  // No host figure and the paint expects offload: the host side is unknown, not zero.
  const ramHostUnknown =
    !overSystemMemory
    && hostMeasuredGb == null
    && engramNeedGb <= 0
    && (launchPaint === "offload" || spill);
  if (!overSystemMemory) {
    if (ramHostUnknown) {
      insets.ramInset = "UNKNOWN SO FAR - RE-PROBE FIRST";
    } else if (spill) {
      insets.ramInset =
        hostSplit.weightGb > 0.05
          ? `OFFLOADING ${hostSplit.weightGb.toFixed(1)}GB TO RAM`
          : "OFFLOADING TO RAM";
    }
  }
  // Total committed host need: buffer + weights + small (<4 GB) resident lookup table.
  const ramNeedGb = hostSplit.bufferGb + hostSplit.weightGb + hostSplit.engramGb;
  const hostEngramGb = engramNeedGb;
  const spillWeightGb = hostSplit.weightGb;

  const base: VramManifest = {
    scenario: "AUTO_FIT",
    style: {
      ...paintClasses,
      icon: (cpuExperts ? fits && fitsAllCards : vramNeedTone === "ok") ? "*" : "o",
      label: cpuExperts ? "OVERDRIVE" : fitLabel,
      launchPaint,
      vramNeedTone,
      ramNeedTone,
      uiTemplate: {
        heroText,
        launchSummary: cpuExpertsSummary,
        gpuLayerText: layerText,
        ramLayerText: cpuExperts
          ? ssdPaged
            ? `${hostExpertsGb.toFixed(1)} GB experts (SSD-paged via --no-host)`
            : `${hostExpertsGb.toFixed(1)} GB experts (host by design)`
          : hostSplit.weightGb > 0.05
            ? `${ramNeedGb.toFixed(1)} GB host (${hostSplit.bufferGb.toFixed(1)} buffer + ${hostSplit.weightGb.toFixed(1)} weight)`
            : ramNeedGb > 0.05
              ? `${ramNeedGb.toFixed(1)} GB host buffer (not layer offload)`
              : autoSplit
                ? "VRAM spread across GPUs — offload decided at load"
                : "engine might use some RAM at launch",
        showRamBar: cpuExperts ? hostExpertsGb > 0.05 : ramNeedGb > 0.05 || hostEngramGb > 0.05,
        moeRamBar: false,
        kvSpillRiskText: cpuExperts && autoCache && fits && fitsAllCards ? undefined : insets.vramInset,
        offloadWarningText: cpuExperts && !overSystemMemory ? undefined : insets.ramInset,
      },
    },
    vramWeightsGb: round2(weightGb),
    vramTotalGb: round2(gpuProjectionGb),
    ramSpillGb: cpuExperts ? 0 : round2(hostSplit.weightGb),
    ramTotalGb: round2(ramNeedGb),
    ramBufferGb: cpuExperts ? 0 : round2(hostSplit.bufferGb),
    ramWeightGb: cpuExperts ? 0 : round2(spillWeightGb),
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
      const runtimeOverheadGb = perGpuBaseGb.reduce(
        (sum, gb, i) =>
          gb > 0.1
            ? sum + runtimeOverheadMibForDevice(input.gpus[i].index, input.gpuCalibration) / 1024
            : sum,
        0,
      );
      const curveCacheGb = autoCache ? 0 : effectiveCacheGb;
      const activeOverheadGb =
        runtimeOverheadGb + visionAddonGb + curveCacheGb + (addDraft ? draftAddon : 0);
      let pts: Array<{ ctx: number; gb: number }> = [];
      if (launchPoints.length >= 2) {
        pts = launchPoints.map((p) => ({ ctx: p.ctx, gb: round2(p.gb + activeOverheadGb) }));
      } else if (source === "probe_anchored" && probePoints.length >= 2 && launchPoints[0]) {
        const launchAnchor = launchPoints[0];
        const atAnchor = probeLineAt(launchAnchor.ctx);
        if (atAnchor) {
          pts = probePoints.map((p) => ({
            ctx: p.ctx,
            gb: round2(Math.max(0, launchAnchor.gb + (p.gb - atAnchor.vramGb)) + activeOverheadGb),
          }));
        }
      } else if (source === "probe_curve" && probePoints.length >= 2) {
        pts = probePoints.map((p) => ({ ctx: p.ctx, gb: round2(p.gb + activeOverheadGb) }));
      } else if (source === "launch_other" && nearestPoint) {
        pts = [{ ctx: nearestPoint.ctx, gb: round2(nearestPoint.gb + activeOverheadGb) }];
      }
      const liveIdx = pts.findIndex((p) => p.ctx === liveCtx);
      const livePt = { ctx: liveCtx, gb: round2(autoCache ? baseVramGb : gpuProjectionGb) };
      if (liveIdx >= 0) pts[liveIdx] = livePt;
      else pts.push(livePt);
      return pts.sort((a, b) => a.ctx - b.ctx);
    })(),
    moeOverdrive: cpuExperts
      ? {
          active: true,
          autoCache,
          cacheMib,
          baseVramGb: round2(baseVramGb),
          hostExpertsGb: round2(hostExpertsGb),
          coveragePct:
            hostExpertsGb > 0.05
              ? Math.min(100, Math.round((effectiveCacheGb / hostExpertsGb) * 100))
              : 0,
          ssdPaged,
        }
      : undefined,
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
    lastLaunchSpillAt:
      lastLaunchSpillGb > 0.05 ? (input.learnedSpilledAt ?? input.learnedMeasuredAt) : undefined,
    fitProbeMeasuredAt: isProbeSource ? input.fitProbeMeasuredAt : undefined,
  };

  return attachMemorySource(base, input);
}

export const ggmlMasterAdapter: ForecastAdapter = {
  ids: ["ggml-master", "ggml_master", ""],
  evaluate: evaluateGgmlMaster,
};
