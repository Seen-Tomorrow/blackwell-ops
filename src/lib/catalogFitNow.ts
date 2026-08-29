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

export type FitNowVerdict = "fits" | "tight" | "no" | "unknown" | "draft";

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

export function fitNowVerdict(opts: {
  model: ModelEntry;
  fitResults: Record<string, FitScanFull>;
  freeVramMib: number;
}): FitNowVerdict {
  if (isExternalDraftOnly(opts.model)) return "draft";
  if (!(opts.freeVramMib > 0)) return "unknown";

  const entry = findFitScanEntry(opts.fitResults, opts.model.path);
  const need = pickSpineNeedMib(entry);
  if (need == null || !(need > 0)) return "unknown";

  if (need <= opts.freeVramMib * FITS_HEADROOM) return "fits";
  if (need <= opts.freeVramMib * TIGHT_HEADROOM) return "tight";
  return "no";
}

export function fitNowLabel(v: FitNowVerdict): string {
  switch (v) {
    case "fits":
      return "FITS";
    case "tight":
      return "TIGHT";
    case "no":
      return "NO";
    case "draft":
      return "DRAFT";
    default:
      return "—";
  }
}

export function fitNowTitle(v: FitNowVerdict, needMib?: number | null, freeMib?: number): string {
  const need =
    needMib != null && needMib > 0 ? ` · need ~${(needMib / 1024).toFixed(1)}G` : "";
  const free =
    freeMib != null && freeMib > 0 ? ` · free ~${(freeMib / 1024).toFixed(1)}G` : "";
  switch (v) {
    case "fits":
      return `Fits free VRAM now (FIT spine @ 32K/64K, none-split)${need}${free}`;
    case "tight":
      return `Tight on free VRAM (within ~5%)${need}${free}`;
    case "no":
      return `Does not fit free VRAM now${need}${free}`;
    case "draft":
      return "Draft pack — no main VRAM fit";
    default:
      return "No library FIT spine point yet — run FIT SCAN or library FIT";
  }
}

export function matchesFitNowFilter(v: FitNowVerdict, filter: CatalogFitNowFilter): boolean {
  if (filter === "all") return true;
  if (filter === "fits") return v === "fits";
  // room = fits + tight
  return v === "fits" || v === "tight";
}

export function fitNowNeedMib(
  model: ModelEntry,
  fitResults: Record<string, FitScanFull>,
): number | null {
  return pickSpineNeedMib(findFitScanEntry(fitResults, model.path));
}
