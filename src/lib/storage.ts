/** Centralized localStorage key strings — single source of truth */

export const STORAGE_PREFIX = "BlackOps-" as const;

// Static keys
export const KEYS = {
  adminLock: `${STORAGE_PREFIX}admin-lock`,
  lastProvider: `${STORAGE_PREFIX}last-provider`,
  testFlags: `${STORAGE_PREFIX}testFlags`,
  testFlagsOn: `${STORAGE_PREFIX}testFlagsOn`,
  testFlagsMode: `${STORAGE_PREFIX}testFlagsMode`,
  binaryProfile: `${STORAGE_PREFIX}binary-profile`,
  collapsedGroups: `${STORAGE_PREFIX}collapsed-groups`,
  lastModel: `${STORAGE_PREFIX}last-model`,
  sortField: `${STORAGE_PREFIX}sort-field`,
  sortDir: `${STORAGE_PREFIX}sort-dir`,
  uiZoom: `${STORAGE_PREFIX}ui-zoom`,
  catalogVisibleCount: `${STORAGE_PREFIX}catalog-visible-count`,
   paramCreatorMode: `${STORAGE_PREFIX}param-creator-mode`,
  selectedSlotIdx: `${STORAGE_PREFIX}selected-slot-idx`,
} as const;

// Dynamic key builders — return the full localStorage key string
export function engineAliasKey(modelPath: string): string {
  return `${STORAGE_PREFIX}engine-alias:${modelPath}`;
}

export function overridesKey(providerId: string): string {
  return `${STORAGE_PREFIX}admin-catalog-override:${providerId}`;
}

export function groupOrderKey(providerId: string): string {
  return `${STORAGE_PREFIX}group-order-${providerId}`;
}

export function binaryProfileKey(providerId: string): string {
  return `${STORAGE_PREFIX}binary-profile:${providerId}`;
}

const LOG_SEARCH_KEY = `${STORAGE_PREFIX}log-search-by-slot`;

/** Per-slot ENGINE LOGS search queries — survives tab navigation until cleared. */
export function loadLogSearchBySlot(): Record<number, string> {
  try {
    const raw = localStorage.getItem(LOG_SEARCH_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    const out: Record<number, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const slot = Number(k);
      if (!Number.isNaN(slot) && v.trim()) out[slot] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveLogSearchBySlot(map: Record<number, string>): void {
  try {
    const serializable: Record<string, string> = {};
    for (const [slot, query] of Object.entries(map)) {
      if (query.trim()) serializable[String(slot)] = query;
    }
    if (Object.keys(serializable).length === 0) {
      localStorage.removeItem(LOG_SEARCH_KEY);
    } else {
      localStorage.setItem(LOG_SEARCH_KEY, JSON.stringify(serializable));
    }
  } catch {
    // ignore quota errors
  }
}

/** Normalize a UI group name to uppercase-hyphen format (e.g. "Speculative Decoding" → "SPECULATIVE-DECODING") */
export function normalizeUiGroup(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9\-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
