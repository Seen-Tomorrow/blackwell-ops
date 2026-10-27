import {
  LAUNCH_DOCK_RAIL_WIDTH_MAX,
  LAUNCH_DOCK_RAIL_WIDTH_MIN,
} from "./launchDockLayout";

export const CPU_GRID_COLS_MIN = 4;
const CPU_GRID_COLS_MAX = 16;
/** Prefer at most this many core rows so multi-GPU rails stay usable. */
const CPU_GRID_TARGET_ROWS = 4;

/** Map right-rail width (px) → core grid columns (4 at min width, 16 at max). */
function widthColumns(
  widthPx: number,
  minCols: number,
  maxCols: number,
  minWidth: number,
  maxWidth: number,
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
  return Math.min(maxCols, Math.max(minCols, byWidth));
}

/**
 * Core grid columns for one CPU widget.
 *
 * Hard rule: the column count must divide the logical processor count, or the
 * last row is left with empty cells (32 threads at 12 columns = 12/12/8).
 * Real-world thread counts (4/8/12/16/20/24/32/64…) all have a divisor inside
 * the clamp, so we snap the width-derived target to the nearest usable divisor,
 * preferring the one closest to the four-row target, then even counts.
 */
export function resolveCpuGridColumns(
  widthPx: number,
  minCols = CPU_GRID_COLS_MIN,
  maxCols = CPU_GRID_COLS_MAX,
  minWidth = LAUNCH_DOCK_RAIL_WIDTH_MIN,
  maxWidth = LAUNCH_DOCK_RAIL_WIDTH_MAX,
  /** Logical processors — the grid must divide this exactly. */
  threadCount?: number,
): number {
  const byWidth = widthColumns(widthPx, minCols, maxCols, minWidth, maxWidth);
  if (threadCount == null || threadCount <= 0) return byWidth;

  // Never go below the count that keeps the matrix at ~TARGET_ROWS rows.
  const minNeeded = Math.max(minCols, Math.ceil(threadCount / CPU_GRID_TARGET_ROWS));
  const target = Math.min(maxCols, Math.max(byWidth, minNeeded));
  // A single stretched row looks wrong once there are enough cores for two.
  const minRows = threadCount >= 8 ? 2 : 1;

  let best = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let cols = 2; cols <= maxCols; cols += 1) {
    if (threadCount % cols !== 0 || cols < minNeeded) continue;
    const rows = threadCount / cols;
    if (rows < minRows) continue;
    const score =
      Math.abs(cols - target) * 100
      + Math.abs(rows - CPU_GRID_TARGET_ROWS) * 10
      + (cols % 2);
    if (score < bestScore) {
      bestScore = score;
      best = cols;
    }
  }
  // Exotic thread count with no divisor inside the clamp — keep the width target.
  return best > 0 ? best : target;
}

/** Core-bar tone — consumed as `data-fill` on the core fill. */
export function cpuCoreFill(usage: number): "core-low" | "core-mid" | "core-hot" {
  if (usage > 80) return "core-hot";
  if (usage > 40) return "core-mid";
  return "core-low";
}
