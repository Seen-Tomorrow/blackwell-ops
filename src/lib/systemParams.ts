import { isNumericLiteral, sortParamValues } from "./paramValueSort";
import { normalizeUiGroup, paramUiGroup } from "./storage";

/** CONFIG catalog bucket for engine chrome params (placement fixed in engine panel). */
export const SYSTEM_UI_GROUP = "SYSTEM";

/** Topology-owned — engine injects from GPU scan; never shown in CONFIG catalog. */
export const ENGINE_ONLY_PARAM_KEYS = new Set(["device"]);

/** User-editable in catalog; values/defaults apply — group/reorder/hide do not. */
export const SYSTEM_CATALOG_PARAM_KEYS = new Set([
  "split",
  "offload_mode",
  "base_port",
  /** CTX lives in CockpitCtxStrip / docked cockpit — never chip rows. */
  "ctx",
]);

/**
 * Cockpit-owned knobs (shared across llama forks). Rendered only via the Launch cockpit —
 * never as free chip rows. Pinned to SYSTEM like chrome — not deletable / not re-groupable;
 * values + custom user values still editable in Config.
 * SPECULATIVE-DECODING stays its own group (toggle + draft + contextual knobs under Boost).
 */
export const COCKPIT_OWNED_PARAM_KEYS = new Set([
  "parallel",
  "kv_quant",
  "reasoning",
  "reasoning_preserve",
  "cont_batching",
  "ctx",
]);

export function isCockpitOwnedParam(key: string): boolean {
  return COCKPIT_OWNED_PARAM_KEYS.has(key);
}

export const SYSTEM_CATALOG_PARAM_TOOLTIP =
  "Fixed position in engine panel — edit values and defaults only; group and reorder have no effect.";

export function isCatalogVisibleParam(def: { key: string }): boolean {
  return !ENGINE_ONLY_PARAM_KEYS.has(def.key);
}

/**
 * SYSTEM chrome + cockpit-owned + docked params — locked placement in Config catalog.
 * Custom values (userAddedValues) remain allowed.
 */
export function isSystemCatalogParam(def: {
  key: string;
  dock?: string | null;
  ui_group?: string;
}): boolean {
  if (ENGINE_ONLY_PARAM_KEYS.has(def.key)) return false;
  if (SYSTEM_CATALOG_PARAM_KEYS.has(def.key)) return true;
  if (COCKPIT_OWNED_PARAM_KEYS.has(def.key)) return true;
  if (def.ui_group && normalizeUiGroup(def.ui_group) === SYSTEM_UI_GROUP) return true;
  return Boolean(def.dock);
}

export function isSystemUiGroup(groupName: string): boolean {
  return normalizeUiGroup(groupName) === SYSTEM_UI_GROUP;
}

type MigratableParam = {
  key: string;
  ui_group?: string;
  dock?: string | null;
  hidden?: boolean;
  userHidden?: boolean;
  values?: (string | number)[];
};

function sortedValuesIfNeeded(values: (string | number)[] | undefined): {
  values: (string | number)[] | undefined;
  changed: boolean;
} {
  if (!values || values.length < 2 || !values.every(isNumericLiteral)) {
    return { values, changed: false };
  }
  const sorted = sortParamValues(values);
  const changed = sorted.some((v, i) => String(v) !== String(values[i]));
  return { values: sorted, changed };
}

/** Normalize persisted rows: drop device, pin chrome + cockpit keys to SYSTEM, unhide system rows, sort values. */
export function migrateCatalogParams<T extends MigratableParam>(
  params: T[],
): { params: T[]; changed: boolean } {
  let changed = false;
  const next: T[] = [];
  for (const p of params) {
    if (ENGINE_ONLY_PARAM_KEYS.has(p.key)) {
      changed = true;
      continue;
    }

    let row: T = p;
    if (isSystemCatalogParam(p) || COCKPIT_OWNED_PARAM_KEYS.has(p.key)) {
      let rowChanged = false;
      if (paramUiGroup(p.ui_group) !== SYSTEM_UI_GROUP) {
        row = { ...row, ui_group: SYSTEM_UI_GROUP };
        rowChanged = true;
      }
      if (p.hidden || p.userHidden) {
        row = { ...row, hidden: false, userHidden: false };
        rowChanged = true;
      }
      if (rowChanged) {
        changed = true;
      }
    }

    const { values: sortedVals, changed: sortChanged } = sortedValuesIfNeeded(row.values);
    if (sortChanged && sortedVals) {
      row = { ...row, values: sortedVals };
      changed = true;
    }

    next.push(row);
  }
  return { params: next, changed };
}
