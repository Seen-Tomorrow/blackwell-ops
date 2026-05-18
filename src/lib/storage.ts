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
  vramDiagCollapsed: `${STORAGE_PREFIX}vram-diag-collapsed`,
  paramCreatorMode: `${STORAGE_PREFIX}param-creator-mode`,
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
