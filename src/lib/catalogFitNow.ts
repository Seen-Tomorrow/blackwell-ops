/**
 * Catalog "fit now" — read-only verdict from library FIT scan cache + live free VRAM.
 *
 * Hard wall off forecast:
 * - no evaluate()
 * - no get_learned_vram / probe / fit_scan_model
 * - only FitScanFull points already in memory + GpuInfo.memory_free
 */
import type { FitDataPoint, FitScanFull, GpuInfo, ModelEntry } from "./types";
import { findFitScanEntry, findFitScanPoint } from "./fitScanTable";
import { isExternalDraftOnly } from "./specDraft";

export type FitNowVerdict = "fits" | "split" | "host" | "unknown" | "draft";

export type CatalogFitNowFilter = "all" | "fits" | "room";

/** Preferred FIT spine labels, first hit wins. */
const PREFERRED_CTX_LABELS = ["ctx_32k", "ctx_64k", "ctx_4k", "ctx_128k"] as const;

const FITS_HEADROOM = 0.92;
const TIGHT_HEADROOM = 1.05;

function isNoneSplit(pt: FitDataPoint): boolean {
  const sm = (pt.split_mode || "none").toLowerCase();
  return !sm || sm === "none";
}

function pickSpineNeedMib(full: FitScanFull | undefined): number | null {
  if (!full?.points?.length) return null;

  for (const label of PREFERRED_CTX_LABELS) {
    const pt = findFitScanPoint(full.points, label);
    if (pt && pt.vram_mib > 0 && isNoneSplit(pt)) return pt.vram_mib;
  }

  // Fallback: smallest positive none-split spine point (conservative for "fits?")
  const spine = full.points
    .filter(
      (p) =>
        p.vram_mib > 0 &&
        isNoneSplit(p) &&
        (p.label.startsWith("ctx_") || p.label === "base" || p.label === "base_no_batch"),
    )
    .sort((a, b) => a.vram_mib - b.vram_mib);
  return spine[0]?.vram_mib ?? null;
}

/** Sum free MiB across GPUs (or single-GPU free). */
export function totalFreeVramMib(gpus: GpuInfo[]): number {
  if (!gpus.length) return 0;
  return gpus.reduce((sum, g) => sum + Math.max(0, g.memory_free || 0), 0);
}

/** Free VRAM on the emptiest single card — the right denominator for a split=none probe. */
export function maxFreeSingleVramMib(gpus: GpuInfo[]): number {
  if (!gpus.length) return 0;
  return gpus.reduce((best, g) => Math.max(best, Math.max(0, g.memory_free || 0)), 0);
}

/**
 * Which class of launch a model needs, given the VRAM that is free right now.
 *
 * The spine point is a `split=none` probe, i.e. the model on ONE card, so it must be
 * compared against one card's free VRAM - not the sum. Comparing it against the sum is
 * what made every model read "fits" on a multi-GPU box.
 *
 * Classes are monotone in context length: a model that needs host spill at 32K needs it at
 * 128K too, and one that fits a single card at 32K can only move UP a class as ctx grows.
 * So the fixed probe ctx cannot produce a confidently wrong "fits" - it can only be
 * conservative, which is the property a numeric verdict would lack.
 */
export function fitNowVerdict(opts: {
  model: ModelEntry;
  fitResults: Record<string, FitScanFull>;
  freeSingleMib: number;
  freeTotalMib: number;
}): FitNowVerdict {
  if (isExternalDraftOnly(opts.model)) return "draft";
  if (!(opts.freeSingleMib > 0) || !(opts.freeTotalMib > 0)) return "unknown";

  const entry = findFitScanEntry(opts.fitResults, opts.model.path);
  const need = pickSpineNeedMib(entry);
  if (need == null || !(need > 0)) return "unknown";

  if (need <= opts.freeSingleMib * FITS_HEADROOM) return "fits";
  if (need <= opts.freeTotalMib * FITS_HEADROOM) return "split";
  return "host";
}

export function fitNowLabel(v: FitNowVerdict): string {
  switch (v) {
    case "fits":
      return "FITS";
    case "split":
      return "SPLIT";
    case "host":
      return "HOST";
    case "draft":
      return "DRAFT";
    default:
      return "—";
  }
}

export function fitNowTitle(
  v: FitNowVerdict,
  needMib?: number | null,
  freeSingleMib?: number,
  freeTotalMib?: number,
): string {
  const need =
    needMib != null && needMib > 0 ? ` · needs ~${(needMib / 1024).toFixed(1)}G on one card` : "";
  const single =
    freeSingleMib != null && freeSingleMib > 0
      ? ` · free per card ~${(freeSingleMib / 1024).toFixed(1)}G`
      : "";
  const total =
    freeTotalMib != null && freeTotalMib > 0
      ? ` · free in total ~${(freeTotalMib / 1024).toFixed(1)}G`
      : "";
  switch (v) {
    case "fits":
      return `Fits one card at the probed context — no split needed${need}${single}`;
    case "split":
      return `Needs both cards (layer/tensor split)${need}${total}`;
    case "host":
      return `Exceeds free VRAM even split across cards — will spill to RAM${need}${total}`;
    case "draft":
      return "Draft pack — no main VRAM fit";
    default:
      return "No library FIT spine point yet — run FIT SCAN or library FIT";
  }
}

export function matchesFitNowFilter(v: FitNowVerdict, filter: CatalogFitNowFilter): boolean {
  if (filter === "all") return true;
  if (filter === "fits") return v === "fits";
  // room = fits in VRAM at all (one card, or both cards via a split)
  return v === "fits" || v === "split";
}

export function fitNowNeedMib(
  model: ModelEntry,
  fitResults: Record<string, FitScanFull>,
): number | null {
  return pickSpineNeedMib(findFitScanEntry(fitResults, model.path));
}
