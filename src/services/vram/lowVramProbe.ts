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

/** Partial fitted ngl from a free-aware low_vram probe (−1 / 999 = all GPU). */
export function isPartialFittedNgl(ngl: number | null | undefined): boolean {
  return ngl != null && ngl >= 0 && ngl < 900;
}

/**
 * Spill chrome is live-free only. A leftover LEARNED/session host from an
 * aggressive stuffed-GPU run must not paint HOST OFFLOAD at 20% usage.
 */
export function isLiveWeightSpill(args: {
  estimateGb: number;
  freeGb: number;
  hostGb?: number | null;
  probeMode?: FitProbeMode | null;
  fittedNgl?: number | null;
}): boolean {
  const headroom = freePoolHeadroomGb(args.freeGb);
  const overFree = args.estimateGb > args.freeGb - headroom;
  if (!overFree) return false;
  return (
    isWeightClassHostSpill(args.hostGb) ||
    (args.probeMode === "low_vram" && isPartialFittedNgl(args.fittedNgl))
  );
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

/** DEV: apply a low_vram session only when fingerprint matches and still over free. */
export function shouldApplyLowVramSession(args: {
  mode?: FitProbeMode | null;
  probeFreeFingerprint?: string | null;
  liveFreeFingerprint: string;
  probeGpuGb: number;
  liveFreeGb: number;
}): boolean {
  if (args.mode !== "low_vram") return true;
  if (!isLowVramProbeFresh(args.mode, args.probeFreeFingerprint, args.liveFreeFingerprint)) {
    return false;
  }
  const headroom = freePoolHeadroomGb(args.liveFreeGb);
  return args.probeGpuGb > args.liveFreeGb - headroom;
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
 * True when free is soft-tight or over free-headroom, and no fresh low_vram probe.
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
  const overFree = estimateGb > freeGb - headroom;
  const util = freePoolUtil(estimateGb, freeGb);
  const softTight = freePoolOomTier(util) !== "none";
  return overFree || softTight;
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
  /** Fitted ngl from low_vram probe when known (−1 / 999 = all on GPU). */
  fittedNgl?: number | null;
}): LowVramBarInsets {
  const realSpill = isLiveWeightSpill({
    estimateGb: args.estimateGb,
    freeGb: args.freeGb,
    hostGb: args.hostOffloadGb,
    probeMode: args.probeMode,
    fittedNgl: args.fittedNgl,
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
    ramInset = "HOST OFFLOAD · SLOWER";
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
