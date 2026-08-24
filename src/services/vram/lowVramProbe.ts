/**
 * Low-VRAM RE-PROBE — free-aware spill chrome + manual nudge.
 * Isolated from the main forecast graph. See docs/LOW-VRAM-REPROBE.md.
 */

import type { ForecastLaunchPaint, ForecastNeedTone } from "../../lib/types";
import {
  FREE_POOL_OOM_CAUTION,
  freePoolHeadroomGb,
  freePoolOomTier,
  freePoolUtil,
} from "./shared";

/** Full-need fit-print Host is usually ~1 GB buffer; above this ≈ weight/KV spill. */
export const HOST_BUFFER_CEILING_GB = 2.5;

export type FitProbeMode = "full" | "low_vram";
export function isWeightClassHostSpill(hostGb: number | null | undefined): boolean {
  return hostGb != null && Number.isFinite(hostGb) && hostGb > HOST_BUFFER_CEILING_GB;
}

/** Host is buffer-sized or missing — safe to put on the GPU-vs-CTX lerp. */
export function isFullGpuLearnedPoint(hostMib?: number | null): boolean {
  return !isWeightClassHostSpill((hostMib ?? 0) / 1024);
}
/** Split FIT Host row into buffer vs weight-layer offload (GB). */
export function splitHostRamGb(opts: {
  hostGb: number;
  hostModelGb?: number | null;
  /** Interpolated full-GPU LEARNED host at this CTX — fallback buffer. */
  bufferBaselineGb?: number | null;
  realSpill: boolean;
}): { bufferGb: number; weightGb: number } {
  const host = opts.hostGb > 0 && Number.isFinite(opts.hostGb) ? opts.hostGb : 0;
  if (host <= 0) return { bufferGb: 0, weightGb: 0 };
  const model = opts.hostModelGb;
  const modelIsWeight =
    model != null && Number.isFinite(model) && model > HOST_BUFFER_CEILING_GB;
  if (opts.realSpill && modelIsWeight) {
    return { bufferGb: Math.max(0, host - model), weightGb: model };
  }
  if (opts.realSpill) {
    const baseline =
      opts.bufferBaselineGb != null && opts.bufferBaselineGb > 0.05
        ? Math.min(host, opts.bufferBaselineGb)
        : Math.min(host, HOST_BUFFER_CEILING_GB);
    return { bufferGb: baseline, weightGb: Math.max(0, host - baseline) };
  }
  return { bufferGb: host, weightGb: 0 };
}
/** Partial fitted ngl from a free-aware low_vram probe (−1 / 999 = all GPU). */
export function isPartialFittedNgl(ngl: number | null | undefined): boolean {
  return ngl != null && ngl >= 0 && ngl < 900;
}

/**
 * SPILL / HOST OFFLOAD with a this-CTX measurement.
 * Partial ngl counts even when the reduced GPU estimate now fits free
 * (that's the whole point of low_vram). Do not use the 85/92% band alone.
 */
export function isLiveWeightSpill(args: {
  estimateGb: number;
  freeGb: number;
  hostGb?: number | null;
  probeMode?: FitProbeMode | null;
  fittedNgl?: number | null;
  measurementAtLiveCtx?: boolean;
}): boolean {
  // Session is dropped when CTX moves, so ngl here is already this-CTX.
  if (
    args.probeMode === "low_vram"
    && isPartialFittedNgl(args.fittedNgl)
  ) {
    return true;
  }
  if (args.measurementAtLiveCtx !== true) return false;
  const overFree =
    args.estimateGb > args.freeGb - freePoolHeadroomGb(args.freeGb);
  if (!overFree) return false;
  return isWeightClassHostSpill(args.hostGb);
}

/**
 * DEV: LEARNED row looks like a free-dependent spill (small GPU + fat host)
 * and the GPU slice already fits live free — do not paint it as full need.
 * Full-GPU + leftover host (host << GPU) stays usable.
 */
export function learnedLooksLikeFreeDependentSpill(
  gpuGb: number | null | undefined,
  hostGb: number | null | undefined,
  freeGb: number,
): boolean {
  if (gpuGb == null || !(gpuGb > 0) || !isWeightClassHostSpill(hostGb)) return false;
  const headroom = freePoolHeadroomGb(freeGb);
  if (gpuGb > freeGb - headroom) return false;
  return (hostGb as number) >= Math.max(HOST_BUFFER_CEILING_GB, gpuGb * 0.35);
}

/** low_vram session is CTX-specific — ngl/host from 800k must not paint 610k. */
export function shouldApplyLowVramSession(args: {
  mode?: FitProbeMode | null;
  probeFreeFingerprint?: string | null;
  liveFreeFingerprint: string;
  probeGpuGb: number;
  liveFreeGb: number;
  anchorCtx?: number | null;
  liveCtx?: number | null;
}): boolean {
  if (args.mode !== "low_vram") return true;
  if (
    args.anchorCtx != null
    && args.liveCtx != null
    && args.anchorCtx !== args.liveCtx
  ) {
    return false;
  }
  if (!isLowVramProbeFresh(args.mode, args.probeFreeFingerprint, args.liveFreeFingerprint)) {
    return false;
  }
  return true;
}

/** Round free GB to 0.5 so NVML noise doesn't thrash freshness. */
export function freeFingerprintFromGb(freeGb: number): string {
  if (!(freeGb > 0) || !Number.isFinite(freeGb)) return "0";
  return (Math.round(freeGb * 2) / 2).toFixed(1);
}

export function freeFingerprintFromList(availableGb: number[]): string {
  const sum = availableGb.reduce((a, b) => a + (Number.isFinite(b) ? Math.max(0, b) : 0), 0);
  return freeFingerprintFromGb(sum);
}

export function isLowVramProbeFresh(
  mode: FitProbeMode | null | undefined,
  probeFp: string | null | undefined,
  liveFp: string,
): boolean {
  return mode === "low_vram" && !!probeFp && probeFp === liveFp;
}

/**
 * Show RE-PROBE LOW VRAM nudge — never auto-runs FIT.
 * Yellow 85/92% is chrome only. Nudge only at the hard over-free gate.
 */
export function needsLowVramReprobe(args: {
  estimateGb: number;
  freeGb: number;
  probeMode?: FitProbeMode | null;
  probeFreeFingerprint?: string | null;
  liveFreeFingerprint: string;
}): boolean {
  const { estimateGb, freeGb } = args;
  if (!(estimateGb > 0) || !(freeGb >= 0)) return false;

  if (
    isLowVramProbeFresh(
      args.probeMode,
      args.probeFreeFingerprint,
      args.liveFreeFingerprint,
    )
  ) {
    return false;
  }

  const headroom = freePoolHeadroomGb(freeGb);
  return estimateGb > freeGb - headroom;
}

export type LowVramBarInsets = {
  vramInset: string | null;
  ramInset: string | null;
  /** Prefer weight-class spill chrome over soft OOM when true. */
  realSpill: boolean;
  needsReprobe: boolean;
};

/**
 * Honest bar insets. Full-need host buffer must not read as weight offload.
 */
export function lowVramBarInsets(args: {
  launchPaint: ForecastLaunchPaint;
  freeUtil: number;
  freeGb: number;
  estimateGb: number;
  hostOffloadGb: number;
  overSystemMemory: boolean;
  probeMode?: FitProbeMode | null;
  probeFreeFingerprint?: string | null;
  liveFreeFingerprint: string;
  fittedNgl?: number | null;
  measurementAtLiveCtx?: boolean;
}): LowVramBarInsets {
  const realSpill = isLiveWeightSpill({
    estimateGb: args.estimateGb,
    freeGb: args.freeGb,
    hostGb: args.hostOffloadGb,
    probeMode: args.probeMode,
    fittedNgl: args.fittedNgl,
    measurementAtLiveCtx: args.measurementAtLiveCtx,
  });

  const needsReprobe = needsLowVramReprobe({
    estimateGb: args.estimateGb,
    freeGb: args.freeGb,
    probeMode: args.probeMode,
    probeFreeFingerprint: args.probeFreeFingerprint,
    liveFreeFingerprint: args.liveFreeFingerprint,
  });

  const headroom = freePoolHeadroomGb(args.freeGb);
  const overFree = args.estimateGb > args.freeGb - headroom;
  const oomTier = freePoolOomTier(args.freeUtil);

  let vramInset: string | null = null;
  if (args.launchPaint === "nofit" && !realSpill) {
    vramInset = "NO FIT";
  } else if (realSpill) {
    vramInset = "OVER FREE · SPILL · SLOWER";
  } else if (overFree && needsReprobe) {
    vramInset = "OVER FREE · RE-PROBE";
  } else if (args.launchPaint === "offload" && needsReprobe) {
    // Soft offload palette without measured weight spill — don't claim SPILL.
    vramInset = "OVER FREE · RE-PROBE";
  } else if (!overFree && oomTier === "warn") {
    vramInset = "HIGH OOM RISK";
  } else if (!overFree && oomTier === "caution") {
    vramInset = "LOW OOM RISK";
  }

  let ramInset: string | null = null;
  if (args.overSystemMemory) {
    ramInset = "NO FIT · SYSTEM";
  } else if (realSpill) {
    ramInset = "OFFLOADING TO RAM";
  }
  // No RAM inset for ~1 GB host buffer.

  return { vramInset, ramInset, realSpill, needsReprobe };
}

/** RAM need tone: warn only on weight-class spill or system OOM. */
export function ramNeedToneForHost(args: {
  overSystemMemory: boolean;
  hostOffloadGb: number;
  realSpill: boolean;
}): ForecastNeedTone {
  if (args.overSystemMemory) return "hot";
  if (args.realSpill) return "warn";
  return "ok";
}

/** Whether the RAM bar should show host need (buffer alone is noise). */
export function showHostRamBar(args: {
  hostOffloadGb: number;
  realSpill: boolean;
  overSystemMemory: boolean;
}): boolean {
  if (args.overSystemMemory) return true;
  if (args.realSpill) return true;
  // Keep tiny host buffer visible only if clearly above noise floor.
  return args.hostOffloadGb > HOST_BUFFER_CEILING_GB;
}

export function isLowVramMode(mode: string | null | undefined): mode is "low_vram" {
  return mode === "low_vram";
}

// Re-export threshold for docs / UI tooltips
export { FREE_POOL_OOM_CAUTION };
