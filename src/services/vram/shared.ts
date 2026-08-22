import type {
  GpuInfo,
  ModelMetadata,
  RunningEngine,
  GpuAllocation,
  EngineConfig,
  ForecastLaunchPaint,
  ForecastNeedTone,
} from "../../lib/types";

export type { ForecastLaunchPaint, ForecastNeedTone };

/** Library FIT scan point (ctx curve / batch deltas). */
export interface FitPoint {
  label: string;
  ctx: number;
  kv_quant: string;
  batch: number;
  parallel: number;
  split_mode: string;
  vram_mib: number;
}

export interface RunningSlotInfo {
  alias: string;
  modelShort: string;
  vramMib: number;
  gpuMask: string;
  /** Per-GPU SELF MiB from memory breakdown — maps to gpuMask order when present. */
  gpuBreakdownMib?: number[];
}

export const CUDA_RUNTIME_OVERHEAD_CAP_MIB = 4096;
const FOREIGN_BASELINE_THRESHOLD_MIB = 1024;
const CUDA0_SYSTEM_RESERVE_FLOOR_MIB = 640;

export function isVramCommittedSlot(status: string): boolean {
  return status === "RUNNING" || status === "LOADING";
}

function modelShortFromStackEntry(s: { model_name: string; model_path?: string }): string {
  return s.model_name && s.model_name !== s.model_path
    ? s.model_name.slice(0, 30)
    : s.model_path?.split(/[/\\]/).pop()?.slice(0, 30) || s.model_name.slice(0, 30);
}

export function committedSlotsFromStack(
  stack: Array<{
    status: string;
    alias: string;
    model_name: string;
    model_path?: string;
    vram_mib?: number;
    gpu: string;
    gpu_breakdown_mib?: number[];
  }>,
): RunningSlotInfo[] {
  return stack
    .filter((s) => isVramCommittedSlot(s.status))
    .map((s) => ({
      alias: s.alias,
      modelShort: modelShortFromStackEntry(s),
      vramMib: s.vram_mib || 0,
      gpuMask: s.gpu,
      gpuBreakdownMib: s.gpu_breakdown_mib,
    }));
}

export function committedStackKey(
  stack: Array<{ status: string; alias: string; vram_mib?: number; gpu_breakdown_mib?: number[] }>,
): string {
  return stack
    .filter((s) => isVramCommittedSlot(s.status))
    .map((s) => `${s.alias}-${s.vram_mib || 0}-${(s.gpu_breakdown_mib ?? []).join("+")}`)
    .join("|");
}

export function parseCtx(ctxSize: string | number): number {
  if (typeof ctxSize === "number") return ctxSize;
  const str = String(ctxSize).trim().toLowerCase();
  if (str.endsWith("k")) {
    const num = parseInt(str.slice(0, -1), 10);
    return num > 0 ? num * 1024 : 32768;
  }
  if (str.endsWith("m")) {
    const num = parseInt(str.slice(0, -1), 10);
    return num > 0 ? num * 1024 * 1024 : 32768;
  }
  const parsed = parseInt(str, 10);
  return parsed > 0 ? parsed : 32768;
}

/**
 * Split tax is a **measured delta**, independent of live hard knobs (KV quant, batch, …):
 *
 *   live_estimate(split) = live_none_probe(user knobs, live ctx) + tax(mode, live ctx)
 *
 * Library FIT measures both legs at fixed scan knobs (q4_0 / batch 512):
 *   tax_anchor(ctx) = max(0, VRAM(split,ctx) − VRAM(none,ctx))
 * then piecewise-linear interpolate tax vs CTX (tax grows with CTX).
 *
 * Tensor FIT often reports Δ≈0 (Meta path) — then we fall back to launch-calibrated
 * constants. Prefer LEARNED for the active split when a row exists (adapter priority).
 */
export type SplitTaxSource = "library" | "fallback" | "none";

export interface SplitTaxResult {
  taxGb: number;
  source: SplitTaxSource;
  /** Number of positive library anchors used (0 if fallback). */
  anchors: number;
}

/** Launch-calibrated midpoints when library split Δ is missing / non-positive. */
export function measuredSplitTaxGbFallback(splitMode: string): number {
  const s = String(splitMode || "none").trim().toLowerCase();
  if (!s || s === "none") return 0;
  if (s === "layer") return 6.0;
  if (s === "tensor" || s === "row") return 2.0;
  return 0;
}

function normalizeSplitMode(splitMode: string): "none" | "layer" | "tensor" | string {
  const s = String(splitMode || "none").trim().toLowerCase();
  if (!s || s === "none") return "none";
  if (s === "row") return "tensor";
  return s;
}

function librarySplitTaxAnchors(
  mode: "layer" | "tensor",
  points: FitPoint[],
): Array<{ ctx: number; taxMib: number }> {
  const splitPts = points
    .filter((p) => {
      const sm = (p.split_mode || "").toLowerCase();
      const byMode = sm === mode || (mode === "tensor" && sm === "row");
      const byLabel = p.label.toLowerCase().startsWith(`split_${mode}_`);
      return (byMode || byLabel) && p.vram_mib > 0;
    })
    .slice()
    .sort((a, b) => a.ctx - b.ctx);

  const anchors: Array<{ ctx: number; taxMib: number }> = [];
  for (const sp of splitPts) {
    const noneAt = points.find((p) => {
      const sm = (p.split_mode || "none").toLowerCase();
      const isNone = !sm || sm === "none";
      const isSpine =
        p.label.startsWith("ctx_") || p.label === "base" || p.label === "base_no_batch";
      return isNone && isSpine && p.ctx === sp.ctx && p.vram_mib > 0;
    });
    let noneMib = noneAt?.vram_mib;
    if (noneMib == null) {
      const ext = extrapolateVramFromPoints(points, sp.ctx, "", sp.batch || 512, "", 0);
      if (ext != null) noneMib = ext;
    }
    if (noneMib == null) continue;
    const taxMib = sp.vram_mib - noneMib;
    // Ignore noise / Meta() tensor under-read (Δ≤0). Need a real positive tax anchor.
    if (taxMib > 64) anchors.push({ ctx: sp.ctx, taxMib });
  }
  return anchors;
}

function interpolateTaxGb(
  anchors: Array<{ ctx: number; taxMib: number }>,
  liveCtx: number,
): number {
  if (anchors.length === 0) return 0;
  if (anchors.length === 1) return Math.max(0, anchors[0].taxMib / 1024);
  let lo = anchors[0];
  let hi = anchors[anchors.length - 1];
  for (let i = 0; i < anchors.length - 1; i++) {
    if (liveCtx >= anchors[i].ctx && liveCtx <= anchors[i + 1].ctx) {
      lo = anchors[i];
      hi = anchors[i + 1];
      break;
    }
  }
  if (liveCtx <= anchors[0].ctx) {
    lo = anchors[0];
    hi = anchors[1];
  } else if (liveCtx >= anchors[anchors.length - 1].ctx) {
    lo = anchors[anchors.length - 2];
    hi = anchors[anchors.length - 1];
  }
  if (hi.ctx === lo.ctx) return Math.max(0, lo.taxMib / 1024);
  const t = (liveCtx - lo.ctx) / (hi.ctx - lo.ctx);
  return Math.max(0, (lo.taxMib + t * (hi.taxMib - lo.taxMib)) / 1024);
}

/** Resolve split tax at live CTX from library FIT points, else calibrated fallback. */
export function resolveSplitTax(
  splitMode: string,
  liveCtx: number,
  points?: FitPoint[] | null,
): SplitTaxResult {
  const mode = normalizeSplitMode(splitMode);
  if (mode === "none") return { taxGb: 0, source: "none", anchors: 0 };
  if (mode !== "layer" && mode !== "tensor") {
    return { taxGb: 0, source: "none", anchors: 0 };
  }
  if (points && points.length > 0 && liveCtx > 0) {
    const anchors = librarySplitTaxAnchors(mode, points);
    if (anchors.length > 0) {
      return {
        taxGb: interpolateTaxGb(anchors, liveCtx),
        source: "library",
        anchors: anchors.length,
      };
    }
  }
  const fb = measuredSplitTaxGbFallback(mode);
  return { taxGb: fb, source: fb > 0 ? "fallback" : "none", anchors: 0 };
}

/** @deprecated Prefer {@link resolveSplitTax} — kept for call-site simplicity. */
export function measuredSplitTaxGb(
  splitMode: string,
  liveCtx?: number,
  points?: FitPoint[],
): number {
  return resolveSplitTax(splitMode, liveCtx ?? 0, points).taxGb;
}


export function kvBytesForQuant(kvQuant: string): number {
  const key = kvQuant.toLowerCase();
  const kvMap: [string, number][] = [
    ["q4_0", 0.5],
    ["q4_k", 0.8],
    ["q8_0", 1.0],
    ["f16", 2.0],
    ["bf16", 2.0],
    ["f32", 4.0],
  ];
  for (const [k, v] of kvMap) {
    if (key.includes(k) || key.includes(k.replace("_", ""))) return v;
  }
  return 2.0;
}

export function findFitPoint(points: FitPoint[], label: string): FitPoint | undefined {
  return points.find((p) => p.label === label);
}

function estimateActivationPerBatchToken(points: FitPoint[]): number | null {
  const base = findFitPoint(points, "base");
  const noBatch = findFitPoint(points, "base_no_batch");
  if (!base || !noBatch) return null;
  return (base.vram_mib - noBatch.vram_mib) / 512;
}

/** Piecewise-linear VRAM vs ctx from library CTX points. */
export function extrapolateVramFromPoints(
  points: FitPoint[],
  userCtx: number,
  _userKvQuant: string,
  userBatch: number,
  _splitMode: string,
  _weightsGb: number,
): number | null {
  const ctxPoints = points
    .filter((p) => p.label.startsWith("ctx_") || p.label === "base" || p.label === "base_no_batch")
    .slice()
    .sort((a, b) => a.ctx - b.ctx);
  if (ctxPoints.length === 0) return null;

  let totalMib: number;
  if (ctxPoints.length === 1) {
    totalMib = ctxPoints[0].vram_mib;
  } else {
    let lo = ctxPoints[0];
    let hi = ctxPoints[ctxPoints.length - 1];
    for (let i = 0; i < ctxPoints.length - 1; i++) {
      if (userCtx >= ctxPoints[i].ctx && userCtx <= ctxPoints[i + 1].ctx) {
        lo = ctxPoints[i];
        hi = ctxPoints[i + 1];
        break;
      }
    }
    if (userCtx <= ctxPoints[0].ctx) {
      lo = ctxPoints[0];
      hi = ctxPoints[1];
    } else if (userCtx >= ctxPoints[ctxPoints.length - 1].ctx) {
      lo = ctxPoints[ctxPoints.length - 2];
      hi = ctxPoints[ctxPoints.length - 1];
    }
    if (hi.ctx === lo.ctx) {
      totalMib = lo.vram_mib;
    } else {
      const t = (userCtx - lo.ctx) / (hi.ctx - lo.ctx);
      totalMib = lo.vram_mib + t * (hi.vram_mib - lo.vram_mib);
    }
  }

  const actPerToken = estimateActivationPerBatchToken(points);
  const baseForBatch = findFitPoint(points, "base") || ctxPoints[0];
  if (actPerToken !== null && userBatch !== baseForBatch.batch) {
    totalMib += actPerToken * (userBatch - baseForBatch.batch);
  }

  return Math.max(0, totalMib);
}

/** Shift a measured GPU total from anchor ctx to the live slider ctx. */
export function adjustMeasuredGbForCtx(
  measuredGb: number,
  anchorCtx: number,
  liveCtx: number,
  points: FitPoint[] | undefined,
  meta: ModelMetadata,
  kvQuant: string,
): number {
  if (anchorCtx <= 0 || liveCtx === anchorCtx) return measuredGb;
  if (points && points.length >= 2) {
    const a = extrapolateVramFromPoints(points, anchorCtx, kvQuant, 512, "", 0);
    const b = extrapolateVramFromPoints(points, liveCtx, kvQuant, 512, "", 0);
    if (a != null && b != null) return Math.max(0, measuredGb + (b - a) / 1024);
  }
  const headDim = meta.n_head > 0 ? meta.n_embd / meta.n_head : 128;
  const bytes = kvBytesForQuant(kvQuant);
  if (meta.n_layer <= 0 || meta.n_head_kv <= 0) return measuredGb;
  const delta =
    (2 * meta.n_layer * meta.n_head_kv * headDim * (liveCtx - anchorCtx) * bytes) / 1024 ** 3;
  return Math.max(0, measuredGb + delta);
}

export function interpolateLearnedCurveGb(
  curve: Array<{ ctx: number; vramMib: number; hostMib?: number }> | undefined,
  liveCtx: number,
): { vramGb: number; hostGb: number | null; exact: boolean } | null {
  if (!curve || curve.length === 0) return null;
  const pts = curve.slice().sort((a, b) => a.ctx - b.ctx);
  const exact = pts.find((p) => p.ctx === liveCtx);
  if (exact) {
    return {
      vramGb: exact.vramMib / 1024,
      hostGb: exact.hostMib != null ? exact.hostMib / 1024 : null,
      exact: true,
    };
  }
  if (pts.length === 1) return null;
  let lo = pts[0];
  let hi = pts[pts.length - 1];
  for (let i = 0; i < pts.length - 1; i++) {
    if (liveCtx >= pts[i].ctx && liveCtx <= pts[i + 1].ctx) {
      lo = pts[i];
      hi = pts[i + 1];
      break;
    }
  }
  if (liveCtx <= pts[0].ctx) {
    lo = pts[0];
    hi = pts[1];
  } else if (liveCtx >= pts[pts.length - 1].ctx) {
    lo = pts[pts.length - 2];
    hi = pts[pts.length - 1];
  }
  if (hi.ctx === lo.ctx) {
    return {
      vramGb: lo.vramMib / 1024,
      hostGb: lo.hostMib != null ? lo.hostMib / 1024 : null,
      exact: false,
    };
  }
  const t = (liveCtx - lo.ctx) / (hi.ctx - lo.ctx);
  const vramMib = lo.vramMib + t * (hi.vramMib - lo.vramMib);
  let hostGb: number | null = null;
  if (lo.hostMib != null && hi.hostMib != null) {
    hostGb = (lo.hostMib + t * (hi.hostMib - lo.hostMib)) / 1024;
  }
  return { vramGb: vramMib / 1024, hostGb, exact: false };
}

export function gpuManufacturedMib(g: GpuInfo): number {
  return g.memory_total_manufactured > 0 ? g.memory_total_manufactured : g.memory_total;
}

export function getRunningEnginesOnGpu(gpuIdx: number, slots: RunningSlotInfo[]): RunningEngine[] {
  return slots
    .filter((s) => s.gpuMask.split(",").some((p) => p.trim() === String(gpuIdx)))
    .map((s) => {
      const maskParts = s.gpuMask.split(",").map((p) => p.trim());
      const gpuCount = maskParts.length;
      const idxInMask = maskParts.findIndex((p) => p === String(gpuIdx));
      const perGpuShare = s.vramMib / gpuCount;
      const perGpuBreakdown =
        s.gpuBreakdownMib && idxInMask >= 0 && idxInMask < s.gpuBreakdownMib.length
          ? s.gpuBreakdownMib[idxInMask]
          : 0;
      const vramUsedMib = Math.max(perGpuShare, perGpuBreakdown);
      return { slotAlias: s.alias, modelShort: s.modelShort, vramUsedMib };
    });
}

function effectiveSessionBaselineMib(idleBaselineMib: number, gpuIndex?: number): number {
  if (idleBaselineMib >= 512) return idleBaselineMib;
  if (gpuIndex === 0 && idleBaselineMib < 512) {
    return Math.max(idleBaselineMib, CUDA0_SYSTEM_RESERVE_FLOOR_MIB);
  }
  return idleBaselineMib;
}

function splitExternalMib(
  osOtherMib: number,
  sessionBaselineMib: number,
): { systemReservedMib: number; foreignAppsMib: number } {
  if (sessionBaselineMib >= FOREIGN_BASELINE_THRESHOLD_MIB) {
    return {
      systemReservedMib: 0,
      foreignAppsMib: Math.max(0, osOtherMib),
    };
  }
  const systemReservedMib = Math.min(sessionBaselineMib, osOtherMib);
  return {
    systemReservedMib,
    foreignAppsMib: Math.max(0, osOtherMib - systemReservedMib),
  };
}

export function splitGpuTopoBarUsage(
  usedMib: number,
  breakdownMib: number,
  hasOurEngines: boolean,
  idleBaselineMib = 0,
  gpuIndex?: number,
): {
  engineBarMib: number;
  osOtherMib: number;
  attributedOverheadMib: number;
  breakdownUnderReports: boolean;
  systemReservedMib: number;
  foreignAppsMib: number;
} {
  const sessionBaselineMib = Math.max(
    0,
    Math.min(effectiveSessionBaselineMib(idleBaselineMib, gpuIndex), usedMib),
  );

  if (!hasOurEngines) {
    const osOtherMib = Math.max(0, usedMib - breakdownMib);
    const { systemReservedMib, foreignAppsMib } = splitExternalMib(osOtherMib, sessionBaselineMib);
    return {
      engineBarMib: breakdownMib,
      osOtherMib,
      attributedOverheadMib: 0,
      breakdownUnderReports: false,
      systemReservedMib,
      foreignAppsMib,
    };
  }

  const aboveSessionMib = Math.max(0, usedMib - sessionBaselineMib);
  const deltaMib = Math.max(0, aboveSessionMib - breakdownMib);
  const driverSlackMaxMib = CUDA_RUNTIME_OVERHEAD_CAP_MIB * 2;
  const foreignPreloaded = sessionBaselineMib >= FOREIGN_BASELINE_THRESHOLD_MIB;

  const breakdownUnderReports =
    !foreignPreloaded && deltaMib > CUDA_RUNTIME_OVERHEAD_CAP_MIB && breakdownMib < aboveSessionMib * 0.5;

  if (breakdownUnderReports) {
    const foreignAboveEngineMib = Math.min(deltaMib, CUDA_RUNTIME_OVERHEAD_CAP_MIB);
    const osOtherMib = sessionBaselineMib + foreignAboveEngineMib;
    const engineBarMib = usedMib - osOtherMib;
    const attributedOverheadMib = Math.max(0, engineBarMib - breakdownMib);
    const { systemReservedMib, foreignAppsMib } = splitExternalMib(osOtherMib, sessionBaselineMib);
    return {
      engineBarMib,
      osOtherMib,
      attributedOverheadMib,
      breakdownUnderReports: true,
      systemReservedMib,
      foreignAppsMib: foreignPreloaded ? osOtherMib : foreignAppsMib,
    };
  }

  if (foreignPreloaded) {
    const slackMib = Math.min(deltaMib, driverSlackMaxMib);
    const engineBarMib = Math.min(aboveSessionMib, breakdownMib + slackMib);
    const osOtherMib = Math.max(sessionBaselineMib, usedMib - engineBarMib);
    const attributedOverheadMib = Math.max(0, engineBarMib - breakdownMib);
    return {
      engineBarMib,
      osOtherMib,
      attributedOverheadMib,
      breakdownUnderReports: false,
      systemReservedMib: 0,
      foreignAppsMib: osOtherMib,
    };
  }

  const breakdownLooksComplete = breakdownMib >= aboveSessionMib * 0.65;
  if (breakdownLooksComplete && deltaMib > 0 && deltaMib <= driverSlackMaxMib) {
    const osOtherMib = sessionBaselineMib;
    const engineBarMib = usedMib - osOtherMib;
    const attributedOverheadMib = Math.max(0, engineBarMib - breakdownMib);
    return {
      engineBarMib,
      osOtherMib,
      attributedOverheadMib,
      breakdownUnderReports: false,
      systemReservedMib: sessionBaselineMib,
      foreignAppsMib: 0,
    };
  }

  const attributedOverheadMib = Math.min(deltaMib, CUDA_RUNTIME_OVERHEAD_CAP_MIB);
  const engineBarMib = breakdownMib + attributedOverheadMib;
  const osOtherMib = Math.max(sessionBaselineMib, usedMib - engineBarMib);
  const { systemReservedMib, foreignAppsMib } = splitExternalMib(osOtherMib, sessionBaselineMib);
  return {
    engineBarMib,
    osOtherMib,
    attributedOverheadMib,
    breakdownUnderReports: false,
    systemReservedMib,
    foreignAppsMib,
  };
}

export function computeGpuAvailableList(gpus: GpuInfo[], runningSlots: RunningSlotInfo[]): number[] {
  return gpus.map((g) => {
    const manufactured = gpuManufacturedMib(g) / 1024;
    const nvmlUsed = g.memory_used / 1024;
    const stackUsed = getRunningEnginesOnGpu(g.index, runningSlots).reduce(
      (sum, e) => sum + e.vramUsedMib / 1024,
      0,
    );
    const committed = Math.max(nvmlUsed, stackUsed);
    return Math.max(0, manufactured - committed);
  });
}

export function cfgStr(cfg: EngineConfig, key: string, fallback: string): string {
  const v = cfg.extra_params?.[key];
  if (v == null || v === "") return fallback;
  return String(v);
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function buildGpuAllocations(
  gpus: GpuInfo[],
  runningSlots: RunningSlotInfo[],
  perGpuLoad: number[],
  gpuAvailable: number[],
): GpuAllocation[] {
  return gpus.map((g, i) => ({
    gpuIndex: g.index,
    name: g.name,
    vramManufacturedGb: round2(gpuManufacturedMib(g) / 1024),
    vramAvailableGb: round2(gpuAvailable[i] ?? 0),
    projectedLoadGb: round2(perGpuLoad[i] ?? 0),
    runningEngines: getRunningEnginesOnGpu(g.index, runningSlots),
  }));
}

// ── Forecast paint (bar fill + NEED tone share free-pool launch gate) ─────────

/** Same headroom as fits gate / CTX ghost: max(1 GB, 3% of free). */
export function freePoolHeadroomGb(freeGb: number): number {
  return Math.max(1.0, freeGb * 0.03);
}

export function launchPaintFromGate(fits: boolean, useOffloadPalette: boolean): ForecastLaunchPaint {
  if (useOffloadPalette) return "offload";
  if (fits) return "fit";
  return "nofit";
}

/**
 * NEED tone = launch paint 1:1 (no early soft band — bar and NEED flip together):
 * - fit → ok (green)
 * - offload → warn (amber) — same moment bar goes orange (~free − 3%/1G)
 * - nofit → hot (red)
 */
export function needToneFromLaunchPaint(paint: ForecastLaunchPaint): ForecastNeedTone {
  if (paint === "nofit") return "hot";
  if (paint === "offload") return "warn";
  return "ok";
}


/** Tailwind classes for launch-paint chrome (bar fill, borders, tints). */
export function launchPaintStyleClasses(paint: ForecastLaunchPaint): {
  titleColor: string;
  gpuBarColor: string;
  borderColor: string;
  bgTint: string;
  badgeBg: string;
} {
  switch (paint) {
    case "offload":
      return {
        titleColor: "text-orange-400",
        gpuBarColor: "bg-orange-400/70",
        borderColor: "border-orange-400/30",
        bgTint: "bg-orange-400/5",
        badgeBg: "bg-orange-400/20",
      };
    case "nofit":
      return {
        titleColor: "text-red-400",
        gpuBarColor: "bg-red-500",
        borderColor: "border-red-400/30",
        bgTint: "bg-red-400/5",
        badgeBg: "bg-red-400/20",
      };
    default:
      return {
        titleColor: "text-nv-green",
        gpuBarColor: "bg-nv-green",
        borderColor: "border-nv-green/30",
        bgTint: "bg-nv-green/5",
        badgeBg: "bg-nv-green/20",
      };
  }
}

