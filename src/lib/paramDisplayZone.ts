export type GroupDisplayZone = "above" | "below";

/** Params rendered outside the scroll groups (GpuAssignPanel, launch dock, MOE badge). */
export const PANEL_CHROME_PARAM_KEYS = new Set([
  "device",
  "split",
  "base_port",
  "offload_mode",
]);

export function resolveGroupDisplayZone(
  groupId: string,
  zones: Record<string, GroupDisplayZone> | undefined,
): GroupDisplayZone {
  return zones?.[groupId] === "above" ? "above" : "below";
}

export function partitionGroupsByDisplayZone(
  orderedGroupKeys: string[],
  zones: Record<string, GroupDisplayZone> | undefined,
  hasVisibleParams: (groupId: string) => boolean,
): { aboveKeys: string[]; belowKeys: string[] } {
  const aboveKeys: string[] = [];
  const belowKeys: string[] = [];
  for (const key of orderedGroupKeys) {
    if (!hasVisibleParams(key)) continue;
    if (resolveGroupDisplayZone(key, zones) === "above") aboveKeys.push(key);
    else belowKeys.push(key);
  }
  return { aboveKeys, belowKeys };
}

export function isGroupFullyHidden(
  groupId: string,
  paramsByGroup: Record<string, Array<{ hidden?: boolean }>>,
): boolean {
  const params = paramsByGroup[groupId];
  if (!params || params.length === 0) return false;
  return params.every((p) => p.hidden);
}

/** Hit-test flex/grid group tiles — works for horizontal and vertical drops. */
export function findGroupDropIndex(
  clientX: number,
  clientY: number,
  zone: GroupDisplayZone,
  root: ParentNode = document,
): number {
  const tiles = Array.from(
    root.querySelectorAll<HTMLElement>(`[data-group-zone="${zone}"][data-group-idx]`),
  );
  if (tiles.length === 0) return -1;

  for (const el of tiles) {
    const r = el.getBoundingClientRect();
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
      const idx = parseInt(el.getAttribute("data-group-idx") || "-1", 10);
      if (idx >= 0) return idx;
    }
  }

  let bestIdx = -1;
  let bestDist = Infinity;
  for (const el of tiles) {
    const r = el.getBoundingClientRect();
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    const dist = (clientX - cx) ** 2 + (clientY - cy) ** 2;
    const idx = parseInt(el.getAttribute("data-group-idx") || "-1", 10);
    if (dist < bestDist && idx >= 0) {
      bestDist = dist;
      bestIdx = idx;
    }
  }
  return bestIdx;
}

/** Reorder within one display zone while preserving cross-zone positions in full order. */
export function reorderGroupsWithinZone(
  fullOrder: string[],
  zoneKeys: string[],
  fromIdx: number,
  toIdx: number,
): string[] {
  if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return fullOrder;
  const zoneSet = new Set(zoneKeys);
  const nextZone = [...zoneKeys];
  const [moved] = nextZone.splice(fromIdx, 1);
  if (!moved) return fullOrder;
  nextZone.splice(toIdx, 0, moved);
  let zi = 0;
  return fullOrder.map((g) => (zoneSet.has(g) ? nextZone[zi++]! : g));
}