import type { GroupDisplayZone } from "./storage";
import { normalizeUiGroup, paramUiGroup } from "./storage";

import { SYSTEM_UI_GROUP } from "./systemParams";

/** Groups that must not be removed even when they have no params. */
export const PROTECTED_EMPTY_GROUPS = new Set([
  SYSTEM_UI_GROUP,
  "USER-ADDED-FROM-CATALOG",
  "SPECULATIVE-DECODING",
  "FEATURE-FLAGS",
]);

/** Retired layout buckets — docked params no longer roll up here (see `dock` on each param). */
export const LEGACY_UI_GROUPS = new Set(["RUNTIME-CONFIG"]);

/** Pre-SYSTEM catalog bucket — migrated to SYSTEM on load. */
export const LEGACY_CATALOG_GROUPS = new Set(["MULTI-GPU"]);

/** Groups that cannot be renamed in CONFIG editor. */
export const PROTECTED_GROUP_NAMES = new Set([
  ...PROTECTED_EMPTY_GROUPS,
  ...LEGACY_UI_GROUPS,
]);

export function isGroupRenamable(groupName: string): boolean {
  return !PROTECTED_GROUP_NAMES.has(normalizeUiGroup(groupName));
}

export function isLegacyLayoutGroup(groupName: string): boolean {
  return LEGACY_UI_GROUPS.has(normalizeUiGroup(groupName));
}

/** Drop orphan legacy groups; keep empty user-created groups for manual DEL. */
export function pruneStaleGroupOrder(
  order: string[],
  params: Array<{ ui_group?: string }>,
): string[] {
  const paramGroups = new Set(params.map((d) => paramUiGroup(d.ui_group)));
  return order.filter((g) => {
    const norm = normalizeUiGroup(g);
    if (paramGroups.has(norm)) return true;
    if (isLegacyLayoutGroup(norm)) return false;
    return true;
  });
}

/** CONFIG editor order — keeps user-created empty groups visible for cleanup. */
export function resolveGroupOrderForAdmin(
  params: Array<{ ui_group?: string }>,
  customGroupOrder: string[] | null,
): string[] {
  const derivedOrder: string[] = [];
  const seen = new Set<string>();
  for (const def of params) {
    const g = paramUiGroup(def.ui_group);
    if (!seen.has(g)) {
      seen.add(g);
      derivedOrder.push(g);
    }
  }
  if (!customGroupOrder || customGroupOrder.length === 0) return derivedOrder;
  const normalizedCustom = customGroupOrder.map(normalizeUiGroup);
  const merged = [...normalizedCustom];
  for (const g of derivedOrder) {
    if (!merged.includes(g)) merged.push(g);
  }
  return merged.filter((g) => {
    if (derivedOrder.includes(g)) return true;
    if (isLegacyLayoutGroup(g)) return false;
    return true;
  });
}

export function isEmptyGroupDeletable(
  groupName: string,
  paramsByGroup: Record<string, unknown[] | undefined>,
): boolean {
  const norm = normalizeUiGroup(groupName);
  if (PROTECTED_EMPTY_GROUPS.has(norm)) return false;
  return (paramsByGroup[norm]?.length ?? 0) === 0;
}

export function stripGroupFromLayout(
  groupName: string,
  groupOrder: string[],
  groupDisplayZone: Record<string, GroupDisplayZone>,
  groupColumn: Record<string, number>,
): {
  groupOrder: string[];
  groupDisplayZone: Record<string, GroupDisplayZone>;
  groupColumn: Record<string, number>;
} {
  const norm = normalizeUiGroup(groupName);
  const nextOrder = groupOrder.filter((g) => normalizeUiGroup(g) !== norm);
  const nextZone = Object.fromEntries(
    Object.entries(groupDisplayZone).filter(([k]) => normalizeUiGroup(k) !== norm),
  ) as Record<string, GroupDisplayZone>;
  const nextColumn = Object.fromEntries(
    Object.entries(groupColumn).filter(([k]) => normalizeUiGroup(k) !== norm),
  ) as Record<string, number>;
  return {
    groupOrder: nextOrder,
    groupDisplayZone: nextZone,
    groupColumn: nextColumn,
  };
}

function renameRecordKey<T>(
  map: Record<string, T>,
  oldKey: string,
  newKey: string,
): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [k, v] of Object.entries(map)) {
    const norm = normalizeUiGroup(k);
    if (norm === oldKey) next[newKey] = v;
    else next[norm] = v;
  }
  return next;
}

/** Rename a user group in saved layout maps (order, zone, column). */
export function renameGroupInLayout(
  oldName: string,
  newName: string,
  groupOrder: string[],
  groupDisplayZone: Record<string, GroupDisplayZone>,
  groupColumn: Record<string, number>,
): {
  groupOrder: string[];
  groupDisplayZone: Record<string, GroupDisplayZone>;
  groupColumn: Record<string, number>;
} | null {
  const oldNorm = normalizeUiGroup(oldName);
  const newNorm = normalizeUiGroup(newName.trim());
  if (!newNorm || oldNorm === newNorm || !isGroupRenamable(oldNorm)) return null;
  if (groupOrder.some((g) => normalizeUiGroup(g) === newNorm && normalizeUiGroup(g) !== oldNorm)) {
    return null;
  }

  const nextOrder = groupOrder.map((g) =>
    normalizeUiGroup(g) === oldNorm ? newNorm : normalizeUiGroup(g),
  );

  return {
    groupOrder: nextOrder,
    groupDisplayZone: renameRecordKey(groupDisplayZone, oldNorm, newNorm),
    groupColumn: renameRecordKey(groupColumn, oldNorm, newNorm),
  };
}

/** Pin SYSTEM to the end of a group order list (factory export / release JSON). */
export function pinSystemGroupLast(order: string[]): string[] {
  const without = order.filter((g) => normalizeUiGroup(g) !== SYSTEM_UI_GROUP);
  if (order.some((g) => normalizeUiGroup(g) === SYSTEM_UI_GROUP)) {
    return [...without, SYSTEM_UI_GROUP];
  }
  return without;
}

/**
 * Factory export group order — preserves the full saved layout order (including empty
 * placeholder groups), appends any param groups missing from the saved order, pins SYSTEM last.
 */
export function resolveGroupOrderForExport(
  params: Array<{ ui_group?: string }>,
  customGroupOrder: string[] | null,
): string[] {
  const paramGroups: string[] = [];
  const paramGroupSet = new Set<string>();
  for (const def of params) {
    const g = paramUiGroup(def.ui_group);
    if (!paramGroupSet.has(g)) {
      paramGroupSet.add(g);
      paramGroups.push(g);
    }
  }

  let order: string[];
  if (customGroupOrder && customGroupOrder.length > 0) {
    const seen = new Set<string>();
    order = [];
    for (const raw of customGroupOrder) {
      const g = normalizeUiGroup(raw);
      if (seen.has(g)) continue;
      seen.add(g);
      order.push(g);
    }
    for (const g of paramGroups) {
      if (!seen.has(g)) order.push(g);
    }
  } else {
    order = [...paramGroups];
  }

  return pinSystemGroupLast(order);
}

/** Replace retired MULTI-GPU bucket with SYSTEM in saved group order. */
export function migrateCatalogGroupOrder(order: string[]): { order: string[]; changed: boolean } {
  let changed = false;
  const mapped = order.map((g) => {
    const norm = normalizeUiGroup(g);
    if (LEGACY_CATALOG_GROUPS.has(norm)) {
      changed = true;
      return SYSTEM_UI_GROUP;
    }
    return norm;
  });
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const g of mapped) {
    if (seen.has(g)) {
      changed = true;
      continue;
    }
    seen.add(g);
    deduped.push(g);
  }
  return { order: deduped, changed };
}