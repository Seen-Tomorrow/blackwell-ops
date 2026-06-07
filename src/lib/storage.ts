import { normalizeDisplayTexture, type DisplayTexture } from "./displayTexture";

/**
 * Centralized localStorage registry — single source of truth for all app keys.
 *
 * Convention: `BlackOps-{kebab-case}` static keys; `BlackOps-{namespace}:{id}` dynamic keys.
 *
 * | Key | Type | Purpose |
 * |-----|------|---------|
 * | BlackOps-power-user | string | POWER USER tri-state: locked / unlocked / permanently |
 * | BlackOps-last-provider | string | Last selected provider in engine panel |
 * | BlackOps-test-flags | string | Custom CLI flags for test launches |
 * | BlackOps-test-flags-on | "0" \| "1" | Test flags enabled toggle |
 * | BlackOps-test-flags-mode | add \| replace | Test flags merge mode |
 * | BlackOps-collapsed-groups | JSON string[] | Collapsed param groups in engine panel |
 * | BlackOps-last-model | string | Last selected model path in catalog |
 * | BlackOps-sort-field | string | Catalog sort column |
 * | BlackOps-sort-dir | asc \| desc | Catalog sort direction |
 * | BlackOps-ui-zoom | number string | App chrome zoom (0.7–1.5) |
 * | BlackOps-catalog-visible-count | 4 \| 6 \| 8 \| all | Models visible per page |
 * | BlackOps-param-creator-mode | simple \| advanced | Param creator UI mode |
 * | BlackOps-selected-slot-idx | number string | Last selected engine slot (-1 = none) |
 * | BlackOps-app-theme | string | Active app theme id (matrix, amber, …) |
 * | BlackOps-log-search-by-slot | JSON Record<slot, query> | Per-slot ENGINE LOGS search |
 * | BlackOps-startup-updates | JSON | Cached startup update check results |
 * | BlackOps-fusion-hero-tps | live \| avg | Fusion hero TPS display mode |
 * | BlackOps-display-texture | clean \| crt \| phosphor-dark \| phosphor-light | Display texture cycle |
 * | BlackOps-catalog-split-width | number string (px) | Model catalog / engine config split |
 * | BlackOps-telemetry-view | standard \| lab | TELEMETRY tab: panel vs lab catalogue |
 * | BlackOps-catalog-override:{providerId} | JSON Record<paramKey, value> | Launch-time param chip overrides |
 * | BlackOps-group-order:{providerId} | JSON string[] | CONFIG param group order |
 * | BlackOps-engine-alias:{modelPath} | string | Per-model launch alias |
 * | BlackOps-binary-profile:{providerId} | vanguard \| frontier \| fresh \| stable | Selected binary env profile |
 * | BlackOps-foundry-last-refresh:{signature} | timestamp string | Foundry git refresh throttle |
 *
 * Purged on boot (stale — no longer read by app):
 * | Key | Notes |
 * |-----|-------|
 * | blackops-phosphor-theme | Superseded by BlackOps-app-theme |
 */

export const STORAGE_PREFIX = "BlackOps-" as const;

// ── Power user ─────────────────────────────────────────────────────────────

export type PowerUserState = "locked" | "unlocked" | "permanently";

function isPowerUserState(value: string | null): value is PowerUserState {
  return value === "locked" || value === "unlocked" || value === "permanently";
}

export function loadPowerUserState(): PowerUserState {
  const current = readStorage(KEYS.powerUser);
  if (isPowerUserState(current)) return current;

  const legacy = readStorage(`${STORAGE_PREFIX}admin-lock`);
  if (isPowerUserState(legacy)) {
    savePowerUserState(legacy);
    return legacy;
  }
  return "locked";
}

export function savePowerUserState(state: PowerUserState): void {
  writeStorage(KEYS.powerUser, state);
}

export function isPowerUserActive(state: PowerUserState): boolean {
  return state !== "locked";
}

export function cyclePowerUserState(current: PowerUserState): PowerUserState {
  if (current === "locked") return "unlocked";
  if (current === "unlocked") return "permanently";
  return "locked";
}

// ── Static keys (BlackOps-* kebab-case) ─────────────────────────────────────

export const KEYS = {
  powerUser: `${STORAGE_PREFIX}power-user`,
  lastProvider: `${STORAGE_PREFIX}last-provider`,
  testFlags: `${STORAGE_PREFIX}test-flags`,
  testFlagsOn: `${STORAGE_PREFIX}test-flags-on`,
  testFlagsMode: `${STORAGE_PREFIX}test-flags-mode`,
  collapsedGroups: `${STORAGE_PREFIX}collapsed-groups`,
  lastModel: `${STORAGE_PREFIX}last-model`,
  sortField: `${STORAGE_PREFIX}sort-field`,
  sortDir: `${STORAGE_PREFIX}sort-dir`,
  uiZoom: `${STORAGE_PREFIX}ui-zoom`,
  catalogVisibleCount: `${STORAGE_PREFIX}catalog-visible-count`,
  paramCreatorMode: `${STORAGE_PREFIX}param-creator-mode`,
  selectedSlotIdx: `${STORAGE_PREFIX}selected-slot-idx`,
  appTheme: `${STORAGE_PREFIX}app-theme`,
  logSearchBySlot: `${STORAGE_PREFIX}log-search-by-slot`,
  startupUpdates: `${STORAGE_PREFIX}startup-updates`,
  fusionHeroTpsMode: `${STORAGE_PREFIX}fusion-hero-tps`,
  displayTexture: `${STORAGE_PREFIX}display-texture`,
  catalogSplitWidth: `${STORAGE_PREFIX}catalog-split-width`,
  telemetryView: `${STORAGE_PREFIX}telemetry-view`,
} as const;

// ── Telemetry view (standard panel vs lab catalogue) ───────────────────────

export type TelemetryViewMode = "standard" | "lab";

export function loadTelemetryViewMode(): TelemetryViewMode {
  return readStorage(KEYS.telemetryView) === "lab" ? "lab" : "standard";
}

export function saveTelemetryViewMode(mode: TelemetryViewMode): void {
  writeStorage(KEYS.telemetryView, mode);
}

export const CATALOG_SPLIT_WIDTH_DEFAULT = 420;
export const CATALOG_SPLIT_WIDTH_MIN = 280;
export const CATALOG_SPLIT_WIDTH_MAX = 720;

// ── Dynamic key builders (BlackOps-{namespace}:{id}) ─────────────────────────

export function catalogOverrideKey(providerId: string): string {
  return `${STORAGE_PREFIX}catalog-override:${providerId}`;
}

/** @deprecated Use `catalogOverrideKey` */
export const overridesKey = catalogOverrideKey;

export function groupOrderKey(providerId: string): string {
  return `${STORAGE_PREFIX}group-order:${providerId}`;
}

export function engineAliasKey(modelPath: string): string {
  return `${STORAGE_PREFIX}engine-alias:${modelPath}`;
}

export function binaryProfileKey(providerId: string): string {
  return `${STORAGE_PREFIX}binary-profile:${providerId}`;
}

export function foundryLastRefreshKey(providerSignature: string): string {
  return `${STORAGE_PREFIX}foundry-last-refresh:${providerSignature}`;
}

/** Keys removed on boot — superseded or abandoned. */
const STALE_STORAGE_KEYS = [
  "blackops-phosphor-theme",
] as const;

// ── Low-level IO ───────────────────────────────────────────────────────────

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore quota errors
  }
}

export function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function readJsonStorage<T>(key: string): T | null {
  const raw = readStorage(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJsonStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota errors
  }
}

function migrateValue(fromKey: string, toKey: string): void {
  if (fromKey === toKey) return;
  const existing = readStorage(toKey);
  if (existing !== null) {
    removeStorage(fromKey);
    return;
  }
  const legacy = readStorage(fromKey);
  if (legacy === null) return;
  writeStorage(toKey, legacy);
  removeStorage(fromKey);
}

function purgeStaleStorageKeys(): void {
  for (const key of STALE_STORAGE_KEYS) {
    removeStorage(key);
  }
}

/** One-time migration of legacy / inline localStorage keys into the registry. */
export function migrateLegacyStorageKeys(): void {
  purgeStaleStorageKeys();

  const staticMigrations: Array<{ from: string; to: string }> = [
    { from: `${STORAGE_PREFIX}admin-lock`, to: KEYS.powerUser },
    { from: `${STORAGE_PREFIX}testFlags`, to: KEYS.testFlags },
    { from: `${STORAGE_PREFIX}testFlagsOn`, to: KEYS.testFlagsOn },
    { from: `${STORAGE_PREFIX}testFlagsMode`, to: KEYS.testFlagsMode },
    { from: "blackwell_startup_updates", to: KEYS.startupUpdates },
    { from: "blackops-fusion-hero-tps", to: KEYS.fusionHeroTpsMode },
  ];

  for (const { from, to } of staticMigrations) {
    migrateValue(from, to);
  }

  try {
    for (const key of Object.keys(localStorage)) {
      const adminOverridePrefix = `${STORAGE_PREFIX}admin-catalog-override:`;
      if (key.startsWith(adminOverridePrefix)) {
        const providerId = key.slice(adminOverridePrefix.length);
        migrateValue(key, catalogOverrideKey(providerId));
        continue;
      }

      const legacyGroupPrefix = `${STORAGE_PREFIX}group-order-`;
      if (key.startsWith(legacyGroupPrefix) && !key.includes(":")) {
        const providerId = key.slice(legacyGroupPrefix.length);
        migrateValue(key, groupOrderKey(providerId));
        continue;
      }

      if (key.startsWith("foundry_last_refresh_")) {
        const signature = key.slice("foundry_last_refresh_".length);
        migrateValue(key, foundryLastRefreshKey(signature));
      }
    }
  } catch {
    // ignore iteration errors (e.g. privacy mode)
  }
}

// ── Typed accessors ──────────────────────────────────────────────────────────

export type FusionHeroTpsMode = "live" | "avg";

export function loadFusionHeroTpsMode(): FusionHeroTpsMode {
  const v = readStorage(KEYS.fusionHeroTpsMode);
  return v === "avg" ? "avg" : "live";
}

export function saveFusionHeroTpsMode(mode: FusionHeroTpsMode): void {
  writeStorage(KEYS.fusionHeroTpsMode, mode);
}

export function loadDisplayTexture(): DisplayTexture {
  return normalizeDisplayTexture(readStorage(KEYS.displayTexture));
}

export function saveDisplayTexture(texture: DisplayTexture): void {
  writeStorage(KEYS.displayTexture, texture);
}

export function loadCatalogSplitWidth(): number {
  const raw = readStorage(KEYS.catalogSplitWidth);
  if (!raw) return CATALOG_SPLIT_WIDTH_DEFAULT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return CATALOG_SPLIT_WIDTH_DEFAULT;
  return Math.min(CATALOG_SPLIT_WIDTH_MAX, Math.max(CATALOG_SPLIT_WIDTH_MIN, n));
}

export function saveCatalogSplitWidth(width: number): void {
  const clamped = Math.min(
    CATALOG_SPLIT_WIDTH_MAX,
    Math.max(CATALOG_SPLIT_WIDTH_MIN, Math.round(width)),
  );
  writeStorage(KEYS.catalogSplitWidth, String(clamped));
}

export interface StartupUpdatesCache {
  timestamp: number;
  binaryUpdates: unknown[];
}

export function loadStartupUpdatesCache(): StartupUpdatesCache | null {
  return readJsonStorage<StartupUpdatesCache>(KEYS.startupUpdates);
}

export function saveStartupUpdatesCache(cache: StartupUpdatesCache): void {
  writeJsonStorage(KEYS.startupUpdates, cache);
}

export function loadFoundryLastRefresh(providerSignature: string): number {
  const raw = readStorage(foundryLastRefreshKey(providerSignature));
  if (!raw) return 0;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function saveFoundryLastRefresh(providerSignature: string, timestamp: number): void {
  writeStorage(foundryLastRefreshKey(providerSignature), String(timestamp));
}

export type ParamCreatorMode = "simple" | "advanced";

export function loadParamCreatorMode(): ParamCreatorMode {
  const v = readStorage(KEYS.paramCreatorMode);
  return v === "advanced" ? "advanced" : "simple";
}

export function saveParamCreatorMode(mode: ParamCreatorMode): void {
  writeStorage(KEYS.paramCreatorMode, mode);
}

export function loadUiZoom(defaultZoom = 1.0, min = 0.7, max = 1.5): number {
  const stored = readStorage(KEYS.uiZoom);
  if (!stored) return defaultZoom;
  const val = parseFloat(stored);
  if (Number.isNaN(val) || val < min || val > max) return defaultZoom;
  return val;
}

export function saveUiZoom(zoom: number): void {
  writeStorage(KEYS.uiZoom, String(zoom));
}

/** Per-slot ENGINE LOGS search queries — survives tab navigation until cleared. */
export function loadLogSearchBySlot(): Record<number, string> {
  const parsed = readJsonStorage<Record<string, string>>(KEYS.logSearchBySlot);
  if (!parsed) return {};
  const out: Record<number, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    const slot = Number(k);
    if (!Number.isNaN(slot) && v.trim()) out[slot] = v;
  }
  return out;
}

export function saveLogSearchBySlot(map: Record<number, string>): void {
  const serializable: Record<string, string> = {};
  for (const [slot, query] of Object.entries(map)) {
    if (query.trim()) serializable[String(slot)] = query;
  }
  if (Object.keys(serializable).length === 0) {
    removeStorage(KEYS.logSearchBySlot);
  } else {
    writeJsonStorage(KEYS.logSearchBySlot, serializable);
  }
}

/** Normalize a UI group name to uppercase-hyphen format (e.g. "Speculative Decoding" → "SPECULATIVE-DECODING") */
export function normalizeUiGroup(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9\-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}