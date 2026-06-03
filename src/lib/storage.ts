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
  lowPower: `${STORAGE_PREFIX}low-power`,
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

/** Normalize a UI group name to uppercase-hyphen format (e.g. "Speculative Decoding" → "SPECULATIVE-DECODING") */
export function normalizeUiGroup(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9\-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
