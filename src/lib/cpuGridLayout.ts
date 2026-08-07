import {
  LAUNCH_DOCK_RAIL_WIDTH_MAX,
  LAUNCH_DOCK_RAIL_WIDTH_MIN,
} from "./launchDockLayout";

export const CPU_GRID_COLS_MIN = 4;
export const CPU_GRID_COLS_MAX = 16;
/** Prefer at most this many core rows so multi-GPU rails stay usable. */
export const CPU_GRID_TARGET_ROWS = 4;

/** Map right-rail width (px) → core grid columns (4 at min width, 16 at max). */
export function resolveCpuGridColumns(
  widthPx: number,
  minCols = CPU_GRID_COLS_MIN,
  maxCols = CPU_GRID_COLS_MAX,
  minWidth = LAUNCH_DOCK_RAIL_WIDTH_MIN,
  maxWidth = LAUNCH_DOCK_RAIL_WIDTH_MAX,
  /** Logical processors — widen grid so cores stay short with many threads. */
  threadCount?: number,
): number {
  let byWidth = minCols;
  if (Number.isFinite(widthPx) && widthPx > 0) {
    if (widthPx <= minWidth) byWidth = minCols;
    else if (widthPx >= maxWidth) byWidth = maxCols;
    else {
      const t = (widthPx - minWidth) / (maxWidth - minWidth);
      const raw = Math.round(minCols + t * (maxCols - minCols));
      byWidth = Math.round(raw / 2) * 2;
    }
  }
  byWidth = Math.min(maxCols, Math.max(minCols, byWidth));

  if (threadCount != null && threadCount > 0) {
    const need = Math.ceil(threadCount / CPU_GRID_TARGET_ROWS);
    const evenNeed = Math.ceil(need / 2) * 2;
    byWidth = Math.min(maxCols, Math.max(byWidth, evenNeed, minCols));
  }
  return byWidth;
}

export function coreUsageFillClass(usage: number): string {
  if (usage > 80) return "launch-rail-tel__cpu-core-fill--hot";
  if (usage > 40) return "launch-rail-tel__cpu-core-fill--mid";
  return "launch-rail-tel__cpu-core-fill--low";
}