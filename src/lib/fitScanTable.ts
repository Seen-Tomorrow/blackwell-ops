import type { FitDataPoint, FitScanFull } from "./types";

/** Keep in sync with `SCAN_PLAN.len()` in fit_scanner.rs */
export const FIT_SCAN_POINTS_TOTAL = 10;

/** CTX spine columns. */
export const FIT_SCAN_CTX_COLUMNS = [
  { label: "ctx_4k", header: "4K" },
  { label: "ctx_32k", header: "32K" },
  { label: "ctx_64k", header: "64K" },
  { label: "ctx_128k", header: "128K" },
  { label: "ctx_256k", header: "256K" },
  { label: "ctx_512k", header: "512K" },
] as const;

/** Split-tax library columns — layer/tensor at 64K + 256K. */
export const FIT_SCAN_SPLIT_COLUMNS = [
  { label: "split_layer_64k", header: "L64K", title: "Layer split @ 64K (library tax = L − none)" },
  { label: "split_tensor_64k", header: "T64K", title: "Tensor split @ 64K — fit-print Meta ≈ none (no multi-GPU tax); forecast uses LEARNED or +2G fallback" },
  { label: "split_layer_256k", header: "L256", title: "Layer split @ 256K (library tax = L − none)" },
  { label: "split_tensor_256k", header: "T256", title: "Tensor split @ 256K — fit-print Meta ≈ none (no multi-GPU tax); forecast uses LEARNED or +2G fallback" },
] as const;

/** Full library scan table (CTX spine + split tax). */
export const FIT_SCAN_TABLE_COLUMNS = [
  ...FIT_SCAN_CTX_COLUMNS,
  ...FIT_SCAN_SPLIT_COLUMNS,
] as const;

export function fitScanModelDisplayName(path: string): string {
  let modelName = path.split("\\").pop()?.replace(".gguf", "") || path;
  return modelName.replace(/-\d{3,}-of-\d{3,}$/i, "");
}

export function findFitScanPoint(points: FitDataPoint[] | undefined, label: string): FitDataPoint | undefined {
  return points?.find((p) => p?.label === label);
}

export function fitScanDonePointCount(full: FitScanFull): number {
  const measured = full.points?.length ?? 0;
  const skipped = full.skipped_points ? Object.keys(full.skipped_points).length : 0;
  return measured + skipped;
}

export function findFitScanEntry(
  results: Record<string, FitScanFull>,
  modelPath: string,
): FitScanFull | undefined {
  if (results[modelPath]) return results[modelPath];
  const filename = modelPath.split(/[/\\]/).pop();
  if (!filename) return undefined;
  return Object.values(results).find(
    (entry) => entry.model_path.split(/[/\\]/).pop() === filename,
  );
}

export function modelHasCompleteFitScan(
  full: FitScanFull | undefined,
  pointsTotal: number = FIT_SCAN_POINTS_TOTAL,
): boolean {
  if (!full) return false;
  if (full.skip_reason) return true;
  return fitScanDonePointCount(full) >= pointsTotal;
}

export function mergeFitScanProgressPoint(
  entry: FitScanFull | undefined,
  modelPath: string,
  label: string,
  vramMib: number,
): FitScanFull {
  const prev = entry ?? { model_path: modelPath, points: [] };
  const points = [...(prev.points ?? [])];
  const pt: FitDataPoint = {
    label,
    ctx: 0,
    kv_quant: "",
    batch: 0,
    parallel: 0,
    split_mode: "",
    vram_mib: vramMib,
  };
  const idx = points.findIndex((p) => p.label === label);
  if (idx >= 0) points[idx] = pt;
  else points.push(pt);
  return { ...prev, model_path: modelPath, points, error: prev.error };
}

export function fitScanBadgeLabel(
  full: FitScanFull | undefined,
  pointsTotal: number = FIT_SCAN_POINTS_TOTAL,
): string | null {
  if (!full) return null;
  if (full.skip_reason) return "FIT:skip";
  const done = fitScanDonePointCount(full);
  if (done >= pointsTotal) return `FIT:${pointsTotal}pts`;
  if (done > 0) return `FIT:${done}/${pointsTotal}`;
  return null;
}

/** MiB noise floor: fit-print tensor Meta often lands slightly under none. */
const TENSOR_TAX_NOISE_MIB = 128;

function noneSpineAtCtx(points: FitDataPoint[] | undefined, ctx: number): FitDataPoint | undefined {
  if (!points?.length || !(ctx > 0)) return undefined;
  return points.find((p) => {
    const sm = (p.split_mode || "none").toLowerCase();
    const isNone = !sm || sm === "none";
    const isSpine =
      p.label.startsWith("ctx_") || p.label === "base" || p.label === "base_no_batch";
    return isNone && isSpine && p.ctx === ctx && p.vram_mib > 0;
  });
}

/**
 * Tensor `--fit-print` emits a single Meta() row ≈ split=none total (not multi-GPU).
 * When T − none is within noise, surface `noΔ` so the table does not look like a real tax.
 */
export function isTensorFitTaxUnmeasurable(
  pt: FitDataPoint | undefined,
  allPoints?: FitDataPoint[],
): boolean {
  if (!pt || pt.vram_mib <= 0) return false;
  const sm = (pt.split_mode || "").toLowerCase();
  const isTensor =
    sm === "tensor" || sm === "row" || pt.label.toLowerCase().includes("split_tensor");
  if (!isTensor) return false;
  const none = noneSpineAtCtx(allPoints, pt.ctx);
  if (!none) return false;
  return Math.abs(pt.vram_mib - none.vram_mib) <= TENSOR_TAX_NOISE_MIB;
}

export function formatFitScanVramCell(
  pt: FitDataPoint | undefined,
  modelError?: string,
  label?: string,
  modelSkipReason?: string,
  pointSkipReason?: string,
  allPoints?: FitDataPoint[],
): string {
  if (modelSkipReason) {
    return "MTP";
  }
  if (pointSkipReason) {
    // Tom (and similar) skip tensor plan points — surface as noT, not empty dash.
    if (
      /tensor/i.test(pointSkipReason)
      || (label != null && label.toLowerCase().includes("tensor"))
    ) {
      return "noT";
    }
    return "n/a";
  }
  if (pt && pt.vram_mib > 0) {
    if (isTensorFitTaxUnmeasurable(pt, allPoints)) {
      return "noΔ";
    }
    return `${(pt.vram_mib / 1024).toFixed(1)}G`;
  }
  if (label && modelError?.includes(label)) {
    return "✖";
  }
  // Probe failure often lands only on full.error without the label substring.
  if (
    modelError
    && label
    && (label.includes("split_tensor") || label.includes("split_layer"))
    && /split|tensor|layer|fit/i.test(modelError)
  ) {
    return "✖";
  }
  return "—";
}

export function fitScanPointsLabel(full: FitScanFull, pointsTotal: number): string {
  if (full.skip_reason) {
    return "skip";
  }
  const done = fitScanDonePointCount(full);
  return `${done}/${pointsTotal}`;
}

export function fitScanProgressMetrics(
  results: Record<string, FitScanFull>,
  scanPointsTotal: number,
): { models: number; pointsDone: number; pointsTotal: number } {
  const entries = Object.values(results);
  const pointsDone = entries.reduce((n, e) => n + fitScanDonePointCount(e), 0);
  const models = entries.length;
  return {
    models,
    pointsDone,
    pointsTotal: Math.max(models, 1) * scanPointsTotal,
  };
}

export function sortedFitScanResultEntries(results: Record<string, FitScanFull>): [string, FitScanFull][] {
  return Object.entries(results).sort((a, b) =>
    fitScanModelDisplayName(a[0]).localeCompare(fitScanModelDisplayName(b[0])),
  );
}