import { normalizeUiGroup } from "./storage";

export type ConfigColumnCount = 1 | 2 | 3;

const DEFAULT_COLUMN_WIDTHS: Record<ConfigColumnCount, number[]> = {
  1: [1],
  2: [0.5, 0.5],
  3: [0.4, 0.3, 0.3],
};

const MIN_COLUMN_FRACTION = 0.15;

export function defaultColumnWidths(count: ConfigColumnCount): number[] {
  return [...DEFAULT_COLUMN_WIDTHS[count]];
}

export function normalizeColumnWidths(count: ConfigColumnCount, widths?: number[] | null): number[] {
  const defaults = defaultColumnWidths(count);
  if (!widths || widths.length !== count) return defaults;
  const sum = widths.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(sum) || sum <= 0) return defaults;
  return widths.map((w) => w / sum);
}

/** Explicit groupColumn wins; otherwise column 0. */
function resolvePartitionColumn(
  key: string,
  groupColumn: Record<string, number>,
  columnCount: number,
): number {
  const norm = normalizeUiGroup(key);
  const explicit = groupColumn[norm];
  if (explicit !== undefined) {
    return Math.min(Math.max(0, explicit), columnCount - 1);
  }
  return 0;
}

function partitionGroupsByColumn(
  keys: string[],
  groupColumn: Record<string, number>,
  columnCount: number,
): string[][] {
  const cols: string[][] = Array.from({ length: columnCount }, () => []);
  for (const key of keys) {
    const col = resolvePartitionColumn(key, groupColumn, columnCount);
    cols[col]!.push(key);
  }
  return cols;
}

export function partitionBelowGroupsByColumn(
  belowKeys: string[],
  groupColumn: Record<string, number>,
  columnCount: ConfigColumnCount,
): string[][] {
  return partitionGroupsByColumn(belowKeys, groupColumn, columnCount);
}

export function adjustColumnGutter(
  widths: number[],
  gutterIndex: number,
  pixelDelta: number,
  containerWidth: number,
): number[] {
  if (containerWidth <= 0 || gutterIndex < 0 || gutterIndex >= widths.length - 1) {
    return widths;
  }
  const delta = pixelDelta / containerWidth;
  const next = [...widths];
  let left = next[gutterIndex]! + delta;
  let right = next[gutterIndex + 1]! - delta;
  left = Math.max(MIN_COLUMN_FRACTION, left);
  right = Math.max(MIN_COLUMN_FRACTION, right);
  next[gutterIndex] = left;
  next[gutterIndex + 1] = right;
  const sum = next.reduce((a, b) => a + b, 0);
  return next.map((w) => w / sum);
}

export function columnWidthsToGridTemplate(widths: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < widths.length; i++) {
    parts.push(`${(widths[i]! * 100).toFixed(3)}%`);
    if (i < widths.length - 1) parts.push("var(--config-col-gutter-w, 7px)");
  }
  return parts.join(" ");
}
