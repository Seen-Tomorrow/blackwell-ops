import { normalizeUiGroup } from "./storage";
import type { GroupDisplayZone } from "./storage";

export type ConfigColumnCount = 1 | 2 | 3;

export const DEFAULT_COLUMN_WIDTHS: Record<ConfigColumnCount, number[]> = {
  1: [1],
  2: [0.5, 0.5],
  3: [0.4, 0.3, 0.3],
};

export const MIN_COLUMN_FRACTION = 0.15;

export function defaultColumnWidths(count: ConfigColumnCount): number[] {
  return [...DEFAULT_COLUMN_WIDTHS[count]];
}

export function normalizeColumnCount(raw: unknown): ConfigColumnCount {
  const n = Number(raw);
  if (n === 2 || n === 3) return n;
  return 1;
}

export function normalizeColumnWidths(count: ConfigColumnCount, widths?: number[] | null): number[] {
  const defaults = defaultColumnWidths(count);
  if (!widths || widths.length !== count) return defaults;
  const sum = widths.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(sum) || sum <= 0) return defaults;
  return widths.map((w) => w / sum);
}

export function resolveGroupColumn(groupId: string, groupColumn: Record<string, number>): number {
  return groupColumn[normalizeUiGroup(groupId)] ?? 0;
}

export function partitionBelowGroupsByColumn(
  belowKeys: string[],
  groupColumn: Record<string, number>,
  columnCount: ConfigColumnCount,
): string[][] {
  const cols: string[][] = Array.from({ length: columnCount }, () => []);
  for (const key of belowKeys) {
    const col = Math.min(Math.max(0, resolveGroupColumn(key, groupColumn)), columnCount - 1);
    cols[col].push(key);
  }
  return cols;
}

export interface GroupDropTarget {
  columnIdx: number;
  groupIdx: number;
}

function pointInRect(clientX: number, clientY: number, r: DOMRect): boolean {
  return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
}

export function findGroupDropTarget(
  clientX: number,
  clientY: number,
  zone: GroupDisplayZone,
  root: ParentNode = document,
): GroupDropTarget | null {
  const columns = Array.from(root.querySelectorAll<HTMLElement>("[data-config-column]"));

  if (columns.length > 0) {
    for (const col of columns) {
      const r = col.getBoundingClientRect();
      if (!pointInRect(clientX, clientY, r)) continue;

      const columnIdx = parseInt(col.getAttribute("data-config-column") || "0", 10);
      const tiles = Array.from(
        col.querySelectorAll<HTMLElement>(`[data-group-zone="${zone}"][data-group-idx]`),
      );

      for (const el of tiles) {
        const tr = el.getBoundingClientRect();
        if (pointInRect(clientX, clientY, tr)) {
          const groupIdx = parseInt(el.getAttribute("data-group-idx") || "-1", 10);
          if (groupIdx >= 0) return { columnIdx, groupIdx };
        }
      }

      return { columnIdx, groupIdx: tiles.length };
    }
  }

  const tiles = Array.from(
    root.querySelectorAll<HTMLElement>(`[data-group-zone="${zone}"][data-group-idx]`),
  );

  for (const el of tiles) {
    const r = el.getBoundingClientRect();
    if (pointInRect(clientX, clientY, r)) {
      const groupIdx = parseInt(el.getAttribute("data-group-idx") || "-1", 10);
      const columnIdx = parseInt(el.getAttribute("data-column-idx") || "0", 10);
      if (groupIdx >= 0) return { columnIdx, groupIdx };
    }
  }

  let best: GroupDropTarget | null = null;
  let bestDist = Infinity;
  for (const el of tiles) {
    const r = el.getBoundingClientRect();
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    const dist = (clientX - cx) ** 2 + (clientY - cy) ** 2;
    const groupIdx = parseInt(el.getAttribute("data-group-idx") || "-1", 10);
    const columnIdx = parseInt(el.getAttribute("data-column-idx") || "0", 10);
    if (groupIdx >= 0 && dist < bestDist) {
      bestDist = dist;
      best = { columnIdx, groupIdx };
    }
  }

  return best;
}

/** Move group to adjacent column (append at end of target column). */
export function moveGroupToColumn(
  fullOrder: string[],
  belowKeys: string[],
  groupColumn: Record<string, number>,
  columnCount: ConfigColumnCount,
  sourceGroup: string,
  targetColumn: number,
): { newOrder: string[]; newGroupColumn: Record<string, number> } {
  const cols = partitionBelowGroupsByColumn(belowKeys, groupColumn, columnCount);
  const insertAt = cols[Math.min(Math.max(0, targetColumn), columnCount - 1)]?.length ?? 0;
  return applyBelowGroupDrop(
    fullOrder,
    belowKeys,
    groupColumn,
    columnCount,
    sourceGroup,
    targetColumn,
    insertAt,
  );
}

/** Reorder / move a below-zone group — updates global order + column map. */
export function applyBelowGroupDrop(
  fullOrder: string[],
  belowKeys: string[],
  groupColumn: Record<string, number>,
  columnCount: ConfigColumnCount,
  sourceGroup: string,
  targetColumn: number,
  targetGroupIdx: number,
): { newOrder: string[]; newGroupColumn: Record<string, number> } {
  const norm = normalizeUiGroup(sourceGroup);
  const cols = partitionBelowGroupsByColumn(belowKeys, groupColumn, columnCount);
  const sourceColumn = Math.min(Math.max(0, resolveGroupColumn(sourceGroup, groupColumn)), columnCount - 1);
  const safeTargetColumn = Math.min(Math.max(0, targetColumn), columnCount - 1);
  const fromIdx = cols[sourceColumn].indexOf(sourceGroup);
  if (fromIdx < 0) {
    return { newOrder: fullOrder, newGroupColumn: groupColumn };
  }

  cols[sourceColumn].splice(fromIdx, 1);
  const insertAt = Math.min(Math.max(0, targetGroupIdx), cols[safeTargetColumn].length);
  cols[safeTargetColumn].splice(insertAt, 0, sourceGroup);

  const newGroupColumn = { ...groupColumn, [norm]: safeTargetColumn };
  const newBelowOrder = cols.flat();
  const belowSet = new Set(belowKeys);
  let bi = 0;
  const newOrder = fullOrder.map((g) => (belowSet.has(g) ? newBelowOrder[bi++]! : g));

  return { newOrder, newGroupColumn };
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