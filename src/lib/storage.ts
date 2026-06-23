import { normalizeAboveColumnWidths } from "./configColumnLayout";
import { normalizeDisplayTexture, type DisplayTexture } from "./displayTexture";
import { normalizeIndustrialBezelTexture, type IndustrialBezelTexture } from "./industrialBezelTexture";
import type { ConfigViewMode } from "./types";

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
 * | BlackOps-ui-zoom | number string | Main content text scale (0.7–1.5) |
 * | BlackOps-ui-density | comfortable \| compact | Engine config chip/row density |
 * | BlackOps-catalog-visible-count | 4 \| 6 \| 8 \| all | Models visible per page |
 * | BlackOps-param-creator-mode | simple \| advanced | Param creator UI mode |
 * | BlackOps-selected-slot-idx | number string | Last selected engine slot (-1 = none) |
 * | BlackOps-app-theme | string | Active app theme id (matrix, amber, …) |
 * | BlackOps-log-search-by-slot | JSON Record<slot, query> | Per-slot ENGINE LOGS search |
 * | BlackOps-logs-ansi-enabled | "0" \| "1" | ENGINE LOGS ANSI color rendering |
 * | BlackOps-startup-updates | JSON | Cached startup update check results |
 * | BlackOps-fusion-hero-tps | live \| avg | Fusion hero TPS display mode |
 * | BlackOps-fusion-bench-tray | open \| stowed | Fusion overlay benchmark tray visibility |
 * | BlackOps-config-param-legend | open \| stowed | CONFIG PARAMETERS editor legend panel |
 * | BlackOps-display-texture | clean \| phosphor-dark \| phosphor-light | Display texture cycle (glitch legacy → clean) |
 * | BlackOps-industrial-bezel-texture | sandblast \| diamond \| brush | Dark-theme gunmetal bezel pattern |
 * | BlackOps-catalog-split-width | number string (px) | Model catalog / engine config split |
 * | BlackOps-model-hub-split-width | number string (0–1) | Model Hub results / quants split ratio |
 * | BlackOps-telemetry-view | standard \| lab | TELEMETRY tab: panel vs lab catalogue |
 * | BlackOps-setup-guide-dismissed | "1" | Setup guide dismissed (cache; authority is app_config.setup_completed) |
 * | BlackOps-setup-welcome-seen | "1" | Welcome animation seen (cache; replayed when config/ is reset) |
 * | BlackOps-setup-guide-preview | "1" | Dev: force welcome + guide in VRAM display |
 * | BlackOps-bench-controls | JSON | Global TG/PP bench control chips (n_predict, concurrency, warmup, prompt mode) |

 * | BlackOps-catalog-override:{providerId} | JSON Record<paramKey, value> | Launch-time param chip overrides |
 * | BlackOps-group-order:{providerId} | JSON string[] | CONFIG param group order |
 * | BlackOps-group-display-zone:{providerId} | JSON Record<group, above\|below> | Pin groups above VRAM display |
 * | BlackOps-engine-alias:{modelPath} | string | Per-model launch alias |
 * | BlackOps-binary-profile:{providerId} | fresh \| vanguard \| frontier \| stable | Selected binary env profile |
 * | BlackOps-foundry-last-refresh:{signature} | timestamp string | Foundry git refresh throttle |
 * | BlackOps-auto-vram:{providerId} | "0" \| "1" | Auto VRAM simplified mode per provider |

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

/** CONFIG / catalog editor unlocked — any user can toggle; not admin. */
export function isEditorUnlocked(state: PowerUserState): boolean {
  return isPowerUserActive(state);
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
  uiDensity: `${STORAGE_PREFIX}ui-density`,
  catalogVisibleCount: `${STORAGE_PREFIX}catalog-visible-count`,
  paramCreatorMode: `${STORAGE_PREFIX}param-creator-mode`,
  selectedSlotIdx: `${STORAGE_PREFIX}selected-slot-idx`,
  appTheme: `${STORAGE_PREFIX}app-theme`,
  logSearchBySlot: `${STORAGE_PREFIX}log-search-by-slot`,
  logsAnsiEnabled: `${STORAGE_PREFIX}logs-ansi-enabled`,
  startupUpdates: `${STORAGE_PREFIX}startup-updates`,
  fusionHeroTpsMode: `${STORAGE_PREFIX}fusion-hero-tps`,
  fusionBenchTray: `${STORAGE_PREFIX}fusion-bench-tray`,
  configParamLegend: `${STORAGE_PREFIX}config-param-legend`,
  displayTexture: `${STORAGE_PREFIX}display-texture`,
  industrialBezelTexture: `${STORAGE_PREFIX}industrial-bezel-texture`,
  configLayoutMode: `${STORAGE_PREFIX}config-layout-mode`,
  catalogSplitWidth: `${STORAGE_PREFIX}catalog-split-width`,
  modelHubSplitWidth: `${STORAGE_PREFIX}model-hub-split-width`,
  telemetryView: `${STORAGE_PREFIX}telemetry-view`,
  setupGuideDismissed: `${STORAGE_PREFIX}setup-guide-dismissed`,
  setupWelcomeSeen: `${STORAGE_PREFIX}setup-welcome-seen`,
  setupGuidePreview: `${STORAGE_PREFIX}setup-guide-preview`,
  benchControls: `${STORAGE_PREFIX}bench-controls`,
  /** Daily fusion share PNG sequence (1–999), keyed by YYYY-MM-DD. */
  fusionShareSeq: `${STORAGE_PREFIX}fusion-share-seq`,
  /** CONFIG providers FIT library scan UI — survives sub-tab navigation (session). */
  fitScanSessions: `${STORAGE_PREFIX}fit-scan-sessions`,
} as const;

export function isSetupGuideDismissed(): boolean {
  return readStorage(KEYS.setupGuideDismissed) === "1";
}

export function saveSetupGuideDismissed(): void {
  writeStorage(KEYS.setupGuideDismissed, "1");
}

export function isSetupWelcomeSeen(): boolean {
  return readStorage(KEYS.setupWelcomeSeen) === "1";
}

export function saveSetupWelcomeSeen(): void {
  writeStorage(KEYS.setupWelcomeSeen, "1");
}

/** True when dev preview flag is set — forces setup UI even if catalog is ready. */
export function isSetupGuidePreview(): boolean {
  return readStorage(KEYS.setupGuidePreview) === "1";
}

export function enableSetupGuidePreview(): void {
  writeStorage(KEYS.setupGuidePreview, "1");
}

export function disableSetupGuidePreview(): void {
  removeStorage(KEYS.setupGuidePreview);
}

/** Clear setup onboarding persistence (safe when keys were never written). */
export function resetSetupGuideState(): void {
  removeStorage(KEYS.setupGuideDismissed);
  removeStorage(KEYS.setupWelcomeSeen);
  removeStorage(KEYS.setupGuidePreview);
}

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
export const CATALOG_SPLIT_WIDTH_MAX = 880;

/** Left panel share of Model Hub split (results list). Default 60% results / 40% quants. */
export const MODEL_HUB_SPLIT_RATIO_DEFAULT = 0.6;
export const MODEL_HUB_SPLIT_RATIO_MIN = 0.5;
export const MODEL_HUB_SPLIT_RATIO_MAX = 0.78;

export type UiDensity = "comfortable" | "compact";

export function loadUiDensity(): UiDensity {
  return readStorage(KEYS.uiDensity) === "compact" ? "compact" : "comfortable";
}

export function saveUiDensity(density: UiDensity): void {
  writeStorage(KEYS.uiDensity, density);
}

// ── Dynamic key builders (BlackOps-{namespace}:{id}) ─────────────────────────

export function catalogOverrideKey(providerId: string): string {
  return `${STORAGE_PREFIX}catalog-override:${providerId}`;
}

/** @deprecated Use `catalogOverrideKey` */
export const overridesKey = catalogOverrideKey;

export function groupOrderKey(providerId: string): string {
  return `${STORAGE_PREFIX}group-order:${providerId}`;
}

export type GroupDisplayZone = "above" | "below";

export function groupDisplayZoneKey(providerId: string): string {
  return `${STORAGE_PREFIX}group-display-zone:${providerId}`;
}

export function loadGroupDisplayZone(
  providerId: string,
  fromProvider?: Record<string, GroupDisplayZone>,
): Record<string, GroupDisplayZone> {
  const stored = readJsonStorage<Record<string, GroupDisplayZone>>(groupDisplayZoneKey(providerId));
  if (stored && typeof stored === "object") return stored;
  return fromProvider ?? {};
}

export function saveGroupDisplayZone(
  providerId: string,
  zones: Record<string, GroupDisplayZone>,
): void {
  writeJsonStorage(groupDisplayZoneKey(providerId), zones);
}

export type ConfigColumnCount = 1 | 2 | 3;

export function configColumnCountKey(providerId: string): string {
  return `${STORAGE_PREFIX}config-column-count:${providerId}`;
}

export function configColumnWidthsKey(providerId: string): string {
  return `${STORAGE_PREFIX}config-column-widths:${providerId}`;
}

export function groupColumnKey(providerId: string): string {
  return `${STORAGE_PREFIX}group-column:${providerId}`;
}

export function aboveColumnWidthsKey(providerId: string): string {
  return `${STORAGE_PREFIX}above-column-widths:${providerId}`;
}

export function loadConfigColumnCount(
  providerId: string,
  fromProvider?: ConfigColumnCount,
): ConfigColumnCount {
  const stored = readJsonStorage<ConfigColumnCount>(configColumnCountKey(providerId));
  if (stored === 2 || stored === 3) return stored;
  if (fromProvider === 2 || fromProvider === 3) return fromProvider;
  return 1;
}

export function saveConfigColumnCount(providerId: string, count: ConfigColumnCount): void {
  writeJsonStorage(configColumnCountKey(providerId), count);
}

function normalizeStoredColumnWidths(count: ConfigColumnCount, widths?: number[] | null): number[] {
  const defaults: Record<ConfigColumnCount, number[]> = {
    1: [1],
    2: [0.5, 0.5],
    3: [0.4, 0.3, 0.3],
  };
  const fallback = defaults[count];
  if (!widths || widths.length !== count) return [...fallback];
  const sum = widths.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(sum) || sum <= 0) return [...fallback];
  return widths.map((w) => w / sum);
}

export function loadConfigColumnWidths(
  providerId: string,
  count: ConfigColumnCount,
  fromProvider?: number[],
): number[] {
  const stored = readJsonStorage<number[]>(configColumnWidthsKey(providerId));
  if (stored) return normalizeStoredColumnWidths(count, stored);
  if (fromProvider) return normalizeStoredColumnWidths(count, fromProvider);
  return normalizeStoredColumnWidths(count, null);
}

export function saveConfigColumnWidths(providerId: string, widths: number[]): void {
  writeJsonStorage(configColumnWidthsKey(providerId), widths);
}

export function loadGroupColumn(
  providerId: string,
  fromProvider?: Record<string, number>,
): Record<string, number> {
  const stored = readJsonStorage<Record<string, number>>(groupColumnKey(providerId));
  if (stored && typeof stored === "object") {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(stored)) {
      out[normalizeUiGroup(k)] = v;
    }
    return out;
  }
  if (fromProvider) {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(fromProvider)) {
      out[normalizeUiGroup(k)] = v;
    }
    return out;
  }
  return {};
}

export function saveGroupColumn(providerId: string, columns: Record<string, number>): void {
  writeJsonStorage(groupColumnKey(providerId), columns);
}

export function loadAboveColumnWidths(
  providerId: string,
  fromProvider?: number[],
): [number, number] {
  const stored = readJsonStorage<number[]>(aboveColumnWidthsKey(providerId));
  if (stored) return normalizeAboveColumnWidths(stored);
  if (fromProvider) return normalizeAboveColumnWidths(fromProvider);
  return normalizeAboveColumnWidths(null);
}

export function saveAboveColumnWidths(providerId: string, widths: [number, number]): void {
  writeJsonStorage(aboveColumnWidthsKey(providerId), widths);
}

export function autoVramKey(providerId: string): string {
  return `${STORAGE_PREFIX}auto-vram:${providerId}`;
}

export function loadAutoVramEnabled(providerId: string, factoryDefault: boolean): boolean {
  const stored = readStorage(autoVramKey(providerId));
  if (stored === "1") return true;
  if (stored === "0") return false;
  return factoryDefault;
}

export function saveAutoVramEnabled(providerId: string, enabled: boolean): void {
  writeStorage(autoVramKey(providerId), enabled ? "1" : "0");
}

export function configViewKey(providerId: string): string {
  return `${STORAGE_PREFIX}config-view:${providerId}`;
}

export function loadConfigView(
  providerId: string,
  factoryDefault: ConfigViewMode = "essentials",
): ConfigViewMode {
  const stored = readStorage(configViewKey(providerId));
  if (stored === "full" || stored === "essentials") return stored;
  return factoryDefault;
}

export function saveConfigView(providerId: string, mode: ConfigViewMode): void {
  writeStorage(configViewKey(providerId), mode);
}

export function engineAliasKey(modelPath: string): string {
  return `${STORAGE_PREFIX}engine-alias:${modelPath}`;
}

export function binaryProfileKey(providerId: string): string {
  return `${STORAGE_PREFIX}binary-profile:${providerId}`;
}

/** Next fusion share filename index for `dateKey` (local calendar day), 1–999 then wraps. */
export function nextFusionShareDailySeq(dateKey: string): number {
  const prev = readJsonStorage<{ date: string; n: number }>(KEYS.fusionShareSeq);
  const n =
    prev?.date === dateKey && typeof prev.n === "number"
      ? prev.n >= 999
        ? 1
        : prev.n + 1
      : 1;
  writeJsonStorage(KEYS.fusionShareSeq, { date: dateKey, n });
  return n;
}

export function foundryLastRefreshKey(providerSignature: string): string {
  return `${STORAGE_PREFIX}foundry-last-refresh:${providerSignature}`;
}

/** Keys removed on boot — superseded or abandoned. */
const STALE_STORAGE_KEYS = [
  "blackops-phosphor-theme",
  `${STORAGE_PREFIX}ctx-slider-variant`,
  `${STORAGE_PREFIX}brand-logo`,
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

/** All registry keys currently in localStorage (static + dynamic `BlackOps-*` namespaces). */
export function listBlackOpsStorageKeys(): string[] {
  try {
    return Object.keys(localStorage).filter((key) => key.startsWith(STORAGE_PREFIX));
  } catch {
    return [];
  }
}

/** Remove every `BlackOps-*` key — UI prefs, overrides, bench chips, per-provider dynamic keys. */
export function clearAllBlackOpsStorage(): number {
  let cleared = 0;
  for (const key of listBlackOpsStorageKeys()) {
    removeStorage(key);
    cleared += 1;
  }
  return cleared;
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

export const FUSION_HERO_TPS_DEFAULT: FusionHeroTpsMode = "avg";

export function loadFusionHeroTpsMode(): FusionHeroTpsMode {
  const v = readStorage(KEYS.fusionHeroTpsMode);
  if (v === "avg" || v === "live") return v;
  return FUSION_HERO_TPS_DEFAULT;
}

export function saveFusionHeroTpsMode(mode: FusionHeroTpsMode): void {
  writeStorage(KEYS.fusionHeroTpsMode, mode);
}

export type FusionBenchTrayState = "open" | "stowed";

export function loadFusionBenchTray(): FusionBenchTrayState {
  const v = readStorage(KEYS.fusionBenchTray);
  return v === "stowed" ? "stowed" : "open";
}

export function saveFusionBenchTray(state: FusionBenchTrayState): void {
  writeStorage(KEYS.fusionBenchTray, state);
}

export type ConfigParamLegendState = "open" | "stowed";

export function loadConfigParamLegend(): ConfigParamLegendState {
  const v = readStorage(KEYS.configParamLegend);
  return v === "open" ? "open" : "stowed";
}

export function saveConfigParamLegend(state: ConfigParamLegendState): void {
  writeStorage(KEYS.configParamLegend, state);
}

export function loadDisplayTexture(): DisplayTexture {
  return normalizeDisplayTexture(readStorage(KEYS.displayTexture));
}

export function saveDisplayTexture(texture: DisplayTexture): void {
  writeStorage(KEYS.displayTexture, texture);
}

export function loadIndustrialBezelTexture(): IndustrialBezelTexture {
  return normalizeIndustrialBezelTexture(readStorage(KEYS.industrialBezelTexture));
}

export function saveIndustrialBezelTexture(texture: IndustrialBezelTexture): void {
  writeStorage(KEYS.industrialBezelTexture, texture);
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

export function loadModelHubSplitRatio(): number {
  const raw = readStorage(KEYS.modelHubSplitWidth);
  if (!raw) return MODEL_HUB_SPLIT_RATIO_DEFAULT;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n > 1) {
    // Legacy pixel values from older builds — reset to ratio default.
    return MODEL_HUB_SPLIT_RATIO_DEFAULT;
  }
  return Math.min(
    MODEL_HUB_SPLIT_RATIO_MAX,
    Math.max(MODEL_HUB_SPLIT_RATIO_MIN, n),
  );
}

export function saveModelHubSplitRatio(ratio: number): void {
  const clamped = Math.min(
    MODEL_HUB_SPLIT_RATIO_MAX,
    Math.max(MODEL_HUB_SPLIT_RATIO_MIN, ratio),
  );
  writeStorage(KEYS.modelHubSplitWidth, String(Number(clamped.toFixed(4))));
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

export function loadLogsAnsiEnabled(defaultEnabled = true): boolean {
  const value = readStorage(KEYS.logsAnsiEnabled);
  if (value === "0") return false;
  if (value === "1") return true;
  return defaultEnabled;
}

export function saveLogsAnsiEnabled(enabled: boolean): void {
  writeStorage(KEYS.logsAnsiEnabled, enabled ? "1" : "0");
}

// ── Bench control chips (global — not per-port results/runtime) ─────────────

export const BENCH_TG_PREDICT_OPTIONS = [512, 1024, 2048, 4096, 6144, 8192, 10000] as const;
export const BENCH_TG_PARALLEL_OPTIONS = [1, 4, 8, 16, 32, 64, 128] as const;
export const BENCH_PP_TOKEN_OPTIONS = [8192, 16384, 32768, 65536, 100000] as const;

export type BenchPromptMode = "unique" | "repetitive";

export interface BenchControlPrefs {
  nPredict: number;
  tgParallel: number;
  tgWarmupEnabled: boolean;
  promptMode: BenchPromptMode;
  ppTargetTokens: number;
}

export const BENCH_CONTROL_DEFAULTS: BenchControlPrefs = {
  nPredict: 1024,
  tgParallel: 1,
  tgWarmupEnabled: false,
  promptMode: "repetitive",
  ppTargetTokens: 16384,
};

const BENCH_N_PREDICT_ALLOWED = new Set<number>(BENCH_TG_PREDICT_OPTIONS);
const BENCH_TG_PARALLEL_ALLOWED = new Set<number>(BENCH_TG_PARALLEL_OPTIONS);
const BENCH_PP_TOKEN_ALLOWED = new Set<number>(BENCH_PP_TOKEN_OPTIONS);

function normalizeBenchControlPrefs(raw: unknown): BenchControlPrefs | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const nPredict = typeof o.nPredict === "number" ? o.nPredict : NaN;
  const tgParallel = typeof o.tgParallel === "number" ? o.tgParallel : NaN;
  const ppTargetTokens = typeof o.ppTargetTokens === "number" ? o.ppTargetTokens : NaN;
  const tgWarmupEnabled = o.tgWarmupEnabled;
  const promptMode = o.promptMode;
  if (
    !BENCH_N_PREDICT_ALLOWED.has(nPredict)
    || !BENCH_TG_PARALLEL_ALLOWED.has(tgParallel)
    || !BENCH_PP_TOKEN_ALLOWED.has(ppTargetTokens)
    || typeof tgWarmupEnabled !== "boolean"
    || (promptMode !== "unique" && promptMode !== "repetitive")
  ) {
    return null;
  }
  return {
    nPredict,
    tgParallel,
    tgWarmupEnabled,
    promptMode,
    ppTargetTokens,
  };
}

export function loadBenchControlPrefs(): BenchControlPrefs {
  return normalizeBenchControlPrefs(readJsonStorage(KEYS.benchControls)) ?? BENCH_CONTROL_DEFAULTS;
}

export function saveBenchControlPrefs(prefs: BenchControlPrefs): void {
  const normalized = normalizeBenchControlPrefs(prefs);
  if (!normalized) return;
  writeJsonStorage(KEYS.benchControls, normalized);
}

/** Normalize a UI group name to uppercase-hyphen format (e.g. "Speculative Decoding" → "SPECULATIVE-DECODING") */
export function normalizeUiGroup(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9\-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/** Canonical UI group key for a param row (always normalized). */
export function paramUiGroup(uiGroup?: string): string {
  return normalizeUiGroup(uiGroup || "Feature Flags");
}

/** Treat JSON `null` defaults from disk as unset — avoids rendering a bogus "null" override bubble. */
export function effectiveParamDefault(
  defaultValue: string | number | null | undefined,
): string | number | undefined {
  if (defaultValue === null || defaultValue === undefined) return undefined;
  return defaultValue;
}

/** Merge custom group order (localStorage / provider) with template insertion order. */
export function resolveGroupOrder(
  params: Array<{ ui_group?: string }>,
  customGroupOrder: string[] | null,
): string[] {
  const seen = new Set<string>();
  const derivedOrder: string[] = [];
  for (const def of params) {
    const g = paramUiGroup(def.ui_group);
    if (!seen.has(g)) {
      seen.add(g);
      derivedOrder.push(g);
    }
  }
  if (!customGroupOrder || customGroupOrder.length === 0) return derivedOrder;
  const normalizedCustom = customGroupOrder.map(normalizeUiGroup);
  return [
    ...normalizedCustom.filter((g) => seen.has(g)),
    ...derivedOrder.filter((g) => !normalizedCustom.includes(g)),
  ];
}