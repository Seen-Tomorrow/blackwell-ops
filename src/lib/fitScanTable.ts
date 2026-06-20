import type { FitDataPoint, FitScanFull } from "./types";

/** Highlight columns — keep in sync with SCAN_PLAN split labels in fit_scanner.rs */
export const FIT_SCAN_TABLE_COLUMNS = [
  { label: "base", header: "Base" },
  { label: "split_layer_64k", header: "Lyr" },
  { label: "split_row_64k", header: "Row" },
  { label: "split_tensor_64k", header: "Tns" },
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

export function formatFitScanVramCell(
  pt: FitDataPoint | undefined,
  modelError?: string,
  label?: string,
  modelSkipReason?: string,
  pointSkipReason?: string,
): string {
  if (modelSkipReason) {
    return "MTP";
  }
  if (pointSkipReason) {
    return "n/a";
  }
  if (pt && pt.vram_mib > 0) {
    return `${(pt.vram_mib / 1024).toFixed(1)}G`;
  }
  if (label && modelError?.includes(label)) {
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