import {
  LAUNCH_DOCK_RAIL_WIDTH_MAX,
  LAUNCH_DOCK_RAIL_WIDTH_MIN,
} from "./launchDockLayout";

export const CPU_GRID_COLS_MIN = 4;
export const CPU_GRID_COLS_MAX = 16;

/** Map right-rail width (px) → core grid columns (4 at min width, 16 at max). */
export function resolveCpuGridColumns(
  widthPx: number,
  minCols = CPU_GRID_COLS_MIN,
  maxCols = CPU_GRID_COLS_MAX,
  minWidth = LAUNCH_DOCK_RAIL_WIDTH_MIN,
  maxWidth = LAUNCH_DOCK_RAIL_WIDTH_MAX,
): number {
  if (!Number.isFinite(widthPx) || widthPx <= 0) return minCols;
  if (widthPx <= minWidth) return minCols;
  if (widthPx >= maxWidth) return maxCols;
  const t = (widthPx - minWidth) / (maxWidth - minWidth);
  const raw = Math.round(minCols + t * (maxCols - minCols));
  const even = Math.round(raw / 2) * 2;
  return Math.min(maxCols, Math.max(minCols, even));
}

export function coreUsageFillClass(usage: number): string {
  if (usage > 80) return "launch-rail-tel__cpu-core-fill--hot";
  if (usage > 40) return "launch-rail-tel__cpu-core-fill--mid";
  return "launch-rail-tel__cpu-core-fill--low";
}