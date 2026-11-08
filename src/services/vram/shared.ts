import type {
  GpuInfo,
  RunningEngine,
  GpuAllocation,
  EngineConfig,
  ForecastLaunchPaint,
  ForecastNeedTone,
} from "../../lib/types";

export type { ForecastLaunchPaint, ForecastNeedTone };

export interface RunningSlotInfo {
  alias: string;
  modelShort: string;
  vramMib: number;
  gpuMask: string;
  /** Per-GPU SELF MiB from memory breakdown — maps to gpuMask order when present. */
  gpuBreakdownMib?: number[];
}

const CUDA_RUNTIME_OVERHEAD_CAP_MIB = 4096;
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

/** KV bytes per element for the quantisations the launcher supports. */
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

export interface LearnedCurvePoint {
  ctx: number;
  vramMib: number;
  hostMib?: number;
  /** Measured KV (ctx) at this point — the slope a lone point can be scaled by. */
  kvMib?: number;
  /** Host-resident lookup table measured at this launch — never spill by design. */
  engramMib?: number;
  /** Host model weights actually left in RAM — the only host figure that means spill. */
  hostModelMib?: number;
}

/**
 * Learned VRAM points are measurements, not truth: old engine builds can leave
 * non-positive or clearly non-monotonic rows behind. Drop those before they
 * become a negative NEED / inverted CTX ghost.
 */
export function sanitizeLearnedCurve(
  curve: LearnedCurvePoint[] | undefined,
): LearnedCurvePoint[] {
  const pts = (curve ?? [])
    .filter(
      (p) =>
        Number.isFinite(p.ctx)
        && p.ctx > 0
        && Number.isFinite(p.vramMib)
        && p.vramMib > 0,
    )
    .map((p) => ({
      ctx: p.ctx,
      vramMib: p.vramMib,
      hostMib:
        p.hostMib != null && Number.isFinite(p.hostMib) && p.hostMib > 0
          ? p.hostMib
          : undefined,
      kvMib:
        p.kvMib != null && Number.isFinite(p.kvMib) && p.kvMib > 0
          ? p.kvMib
          : undefined,
      engramMib:
        p.engramMib != null && Number.isFinite(p.engramMib) && p.engramMib > 0
          ? p.engramMib
          : undefined,
      hostModelMib:
        p.hostModelMib != null && Number.isFinite(p.hostModelMib)
          ? Math.max(0, p.hostModelMib)
          : undefined,
    }))
    .sort((a, b) => a.ctx - b.ctx);

  const out: LearnedCurvePoint[] = [];
  for (const point of pts) {
    const prev = out[out.length - 1];
    if (prev && point.ctx === prev.ctx) {
      if (point.vramMib > prev.vramMib) out[out.length - 1] = point;
      continue;
    }
    // A gross downward step is a stale reading (engine allocation changed).
    // Small noise is allowed; only drop clear cliffs.
    if (prev && point.vramMib < prev.vramMib * 0.9) continue;
    out.push(point);
  }
  return out;
}

export function interpolateLearnedCurveGb(
  curve: Array<{ ctx: number; vramMib: number; hostMib?: number }> | undefined,
  liveCtx: number,
): {
  vramGb: number;
  hostGb: number | null;
  exact: boolean;
  /** The requested ctx is outside every measurement; the value is a clamp, not a curve.
   *  Extrapolating the total linearly under-reads above the top point (compute buffers grow
   *  faster than that), which is the dangerous direction: it would claim a fit that is not.
   */
  beyondMeasured?: boolean;
} | null {
  const pts = sanitizeLearnedCurve(curve);
  if (pts.length === 0) return null;
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
  // Outside the measured range: keep forecasting instead of freezing. Clamping made the
  // number stop changing for any ctx past the last launch, which users read as broken; the
  // totals are near-linear in ctx (kv exactly, compute affine), so extrapolate and let the UI
  // label it as beyond the measured range.
  const beyondMeasured = liveCtx < pts[0].ctx || liveCtx > pts[pts.length - 1].ctx;
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
  return { vramGb: vramMib / 1024, hostGb, exact: false, beyondMeasured };
}

function gpuManufacturedMib(g: GpuInfo): number {
  return g.memory_total_manufactured > 0 ? g.memory_total_manufactured : g.memory_total;
}

function getRunningEnginesOnGpu(gpuIdx: number, slots: RunningSlotInfo[]): RunningEngine[] {
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

/**
 * TCC: measured OOM ~1 GB leftover. WDDM: ~1.75 GB (pack ceiling ~94.3 / 96).
 *
 * Kept for the hardware-monitor readout only. It must NOT be subtracted from the forecast's
 * free pool any more: NVML's `memory_total` already comes back below the card's marketing
 * capacity (97,887 of 98,304 MiB on a 96 GB card — the driver's own reservation), and
 * `memory_free` is `total - used`, so it is already net of everything the driver keeps.
 * Subtracting this again made every forecast under-read free VRAM by ~1.3 GiB per card.
 */
const HW_RESERVED_TCC_MIB = 1024;
const HW_RESERVED_WDDM_MIB = 1792;

/**
 * The driver pool that `memory_used` already includes, in MiB.
 *
 * NVML v2 reports it per card (1,314 MiB on the RTX PRO 6000 pair here); the constants are only
 * a fallback for the `nvidia-smi` CLI path and for drivers that do not answer v2. Never add this
 * to `memory_used` — it is already inside it.
 */
export function hwReservedMib(driverModel?: string, measuredMib?: number): number {
  if (measuredMib != null && measuredMib > 0) return measuredMib;
  const m = (driverModel ?? "").toUpperCase();
  if (m.includes("TCC")) return HW_RESERVED_TCC_MIB;
  return HW_RESERVED_WDDM_MIB;
}

/**
 * Free VRAM per GPU for planning, in MiB.
 *
 * NVML is the authority: `memory_free` is what a process can still allocate, and its
 * `memory_total` is already reduced by the hardware reservation, so nothing is subtracted
 * twice. The stack's own reservation is only used to correct a launch whose allocation NVML
 * has not reported yet (a brief window right after spawn).
 */
export function computeGpuAvailableList(gpus: GpuInfo[], runningSlots: RunningSlotInfo[]): number[] {
  return gpus.map((g) => {
    const stackUsed = getRunningEnginesOnGpu(g.index, runningSlots).reduce(
      (sum, e) => sum + e.vramUsedMib / 1024,
      0,
    );

    if (g.memory_free > 0) {
      const nvmlFree = g.memory_free / 1024;
      const nvmlUsed = g.memory_used / 1024;
      // Only correct upward: an engine we just spawned may not be attributed yet.
      const lagGb = Math.max(0, stackUsed - nvmlUsed);
      return Math.max(0, nvmlFree - lagGb);
    }

    // No NVML reading (CLI fallback or a driver that refused the query): fall back to the
    // conservative estimate so the UI still has a number.
    const manufactured = gpuManufacturedMib(g) / 1024;
    const reserved = hwReservedMib(g.driver_model, g.memory_reserved) / 1024;
    return Math.max(0, manufactured - reserved - stackUsed);
  });
}

export function cfgStr(cfg: EngineConfig, key: string, fallback: string): string {
  // The config carries launch params both as flat keys (`updateParam` writes there) and under
  // `extra_params` (the launcher shape). Reading only one is how an applied `-ts` reached the
  // CLI but never the bars.
  const v = cfg.extra_params?.[key] ?? (cfg as unknown as Record<string, unknown>)?.[key];
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
    nvmlUsedGb: round2(g.memory_used / 1024),
    hwReservedGb: round2(hwReservedMib(g.driver_model, g.memory_reserved) / 1024),
    driverModel: g.driver_model,
    projectedLoadGb: round2(Math.max(0, perGpuLoad[i] ?? 0)),
    runningEngines: getRunningEnginesOnGpu(g.index, runningSlots),
  }));
}


// ── Forecast paint (bar fill + NEED tone share free-pool launch gate) ─────────

/**
 * Free-pool OOM risk bands (estimate / free). Tune from live launches later.
 * Soft bands fire while still launch-fit — unknown load buffers can OOM near full free.
 */
export const FREE_POOL_OOM_CAUTION = 0.85; // low / small OOM risk
export const FREE_POOL_OOM_WARN = 0.92; // higher OOM risk (still may fit)

/** Same headroom as fits gate / CTX ghost: max(1 GB, 3% of free). */
export function freePoolHeadroomGb(freeGb: number): number {
  return Math.max(1.0, freeGb * 0.03);
}

/** estimate / free — Infinity when free is 0 and estimate > 0. */
export function freePoolUtil(estimateGb: number, freeGb: number): number {
  if (!(freeGb > 0)) return estimateGb > 0 ? Number.POSITIVE_INFINITY : 0;
  return estimateGb / freeGb;
}

export function launchPaintFromGate(fits: boolean, useOffloadPalette: boolean): ForecastLaunchPaint {
  if (useOffloadPalette) return "offload";
  if (fits) return "fit";
  return "nofit";
}

/** Soft free-util tier only (ignores hard launch gate). */
export function freePoolOomTier(
  freeUtil?: number,
): "none" | "caution" | "warn" {
  if (freeUtil == null || !Number.isFinite(freeUtil)) return "none";
  if (freeUtil > FREE_POOL_OOM_WARN) return "warn";
  if (freeUtil > FREE_POOL_OOM_CAUTION) return "caution";
  return "none";
}

/**
 * Bar + NEED tone from hard launch paint + free-util OOM tiers.
 * nofit→hot, offload→warn, free>0.92→warn, free>0.85→caution, else ok.
 */
export function needToneFromLaunchPaint(
  paint: ForecastLaunchPaint,
  freeUtil?: number,
): ForecastNeedTone {
  if (paint === "nofit") return "hot";
  if (paint === "offload") return "warn";
  const tier = freePoolOomTier(freeUtil);
  if (tier === "warn") return "warn";
  if (tier === "caution") return "caution";
  return "ok";
}

/** Surface classes for bar fill / borders from NEED tone (bar locked to NEED).
 *  Paint lives in src/styles/badges.css — state decision stays here. */
export function barStyleFromNeedTone(tone: ForecastNeedTone): {
  titleColor: string;
  gpuBarColor: string;
  borderColor: string;
  bgTint: string;
  badgeBg: string;
} {
  const m = `bar-need--${tone}`;
  return {
    titleColor: `bar-need-title ${m}`,
    gpuBarColor: `bar-need-fill ${m}`,
    borderColor: `bar-need-border ${m}`,
    bgTint: `bar-need-tint ${m}`,
    badgeBg: `bar-need-badge ${m}`,
  };
}

