import { normalizeUiGroup } from "./storage";
import type { GroupDisplayZone } from "./storage";

export type ConfigColumnCount = 1 | 2 | 3;

export const DEFAULT_COLUMN_WIDTHS: Record<ConfigColumnCount, number[]> = {
  1: [1],
  2: [0.5, 0.5],
  3: [0.4, 0.3, 0.3],
};

export const MIN_COLUMN_FRACTION = 0.15;

/** Pinned-above VRAM zone — always two columns with draggable gutter. */
export const ABOVE_COLUMN_COUNT = 2 as const;
export const DEFAULT_ABOVE_COLUMN_WIDTHS: [number, number] = [0.65, 0.35];

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

/** Column a group actually renders in (partition-aware; respects groupColumn map). */
export function effectiveGroupColumn(
  groupId: string,
  zoneKeys: string[],
  groupColumn: Record<string, number>,
  columnCount: ConfigColumnCount | number,
  zone?: GroupDisplayZone,
): number {
  const count = columnCount as ConfigColumnCount;
  const cols =
    zone === "above"
      ? partitionAboveGroupsByColumn(zoneKeys, groupColumn)
      : partitionBelowGroupsByColumn(zoneKeys, groupColumn, count);
  const idx = cols.findIndex((col) => col.includes(groupId));
  if (idx >= 0) return idx;
  return Math.min(Math.max(0, resolveGroupColumn(groupId, groupColumn)), count - 1);
}

/** Explicit groupColumn wins; otherwise column 0 (no auto-interleave). */
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

export function partitionGroupsByColumn(
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

/** Above zone — always two columns; unassigned groups default to column 0. */
export function partitionAboveGroupsByColumn(
  aboveKeys: string[],
  groupColumn: Record<string, number>,
): string[][] {
  return partitionGroupsByColumn(aboveKeys, groupColumn, ABOVE_COLUMN_COUNT);
}

export function normalizeAboveColumnWidths(widths?: number[] | null): [number, number] {
  if (!widths || widths.length !== ABOVE_COLUMN_COUNT) return [...DEFAULT_ABOVE_COLUMN_WIDTHS];
  const sum = widths.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(sum) || sum <= 0) return [...DEFAULT_ABOVE_COLUMN_WIDTHS];
  return [widths[0]! / sum, widths[1]! / sum];
}

export interface GroupDropTarget {
  columnIdx: number;
  groupIdx: number;
}

function pointInRect(clientX: number, clientY: number, r: DOMRect): boolean {
  return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
}

export function zoneLayoutRoot(
  zone: GroupDisplayZone,
  root: ParentNode = document,
): ParentNode {
  const selector =
    zone === "above"
      ? ".config-params-above"
      : ".config-params-below--multi, .config-params-below--1c";
  return root.querySelector(selector) ?? root;
}

export function findGroupDropTarget(
  clientX: number,
  clientY: number,
  zone: GroupDisplayZone,
  root: ParentNode = document,
): GroupDropTarget | null {
  const zoneRoot = zoneLayoutRoot(zone, root);
  const columns = Array.from(zoneRoot.querySelectorAll<HTMLElement>("[data-config-column]"));

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
    zoneRoot.querySelectorAll<HTMLElement>(`[data-group-zone="${zone}"][data-group-idx]`),
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

/** Move group to adjacent column (append at end of target column; no paired swap). */
export function moveGroupToColumn(
  fullOrder: string[],
  zoneKeys: string[],
  groupColumn: Record<string, number>,
  columnCount: ConfigColumnCount | number,
  sourceGroup: string,
  targetColumn: number,
  zone: GroupDisplayZone = "below",
): { newOrder: string[]; newGroupColumn: Record<string, number> } {
  const count = columnCount as ConfigColumnCount;
  const cols = partitionZoneGroupsByColumn(zoneKeys, groupColumn, count, zone);

  const sourceColumn = cols.findIndex((col) => col.includes(sourceGroup));
  const safeTarget = Math.min(Math.max(0, targetColumn), count - 1);
  if (sourceColumn < 0 || safeTarget === sourceColumn) {
    return { newOrder: fullOrder, newGroupColumn: groupColumn };
  }

  const insertAt = cols[safeTarget]?.length ?? 0;
  return applyBelowGroupDrop(
    fullOrder,
    zoneKeys,
    groupColumn,
    count,
    sourceGroup,
    safeTarget,
    insertAt,
    zone,
  );
}

function partitionZoneGroupsByColumn(
  zoneKeys: string[],
  groupColumn: Record<string, number>,
  columnCount: ConfigColumnCount,
  zone?: GroupDisplayZone,
): string[][] {
  if (zone === "above") {
    return partitionAboveGroupsByColumn(zoneKeys, groupColumn);
  }
  return partitionBelowGroupsByColumn(zoneKeys, groupColumn, columnCount);
}

/** Reorder / move a zone group — updates global order + column map. */
export function applyBelowGroupDrop(
  fullOrder: string[],
  belowKeys: string[],
  groupColumn: Record<string, number>,
  columnCount: ConfigColumnCount,
  sourceGroup: string,
  targetColumn: number,
  targetGroupIdx: number,
  zone?: GroupDisplayZone,
): { newOrder: string[]; newGroupColumn: Record<string, number> } {
  const norm = normalizeUiGroup(sourceGroup);
  const cols = partitionZoneGroupsByColumn(belowKeys, groupColumn, columnCount, zone);
  const sourceColumn = cols.findIndex((col) => col.includes(sourceGroup));
  const safeTargetColumn = Math.min(Math.max(0, targetColumn), columnCount - 1);
  const fromIdx = sourceColumn >= 0 ? cols[sourceColumn]!.indexOf(sourceGroup) : -1;
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