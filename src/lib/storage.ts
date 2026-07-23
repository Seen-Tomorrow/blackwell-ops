import { normalizeAboveColumnWidths } from "./configColumnLayout";
import { normalizeDisplayTexture, type DisplayTexture } from "./displayTexture";
import { normalizeIndustrialBezelTexture, type IndustrialBezelTexture } from "./industrialBezelTexture";
import type { LaunchDockPosition } from "./launchDockLayout";
import {
  clampLaunchDockRailWidth,
  clampLaunchRailTelemetryRatio,
  LAUNCH_DOCK_POSITION_DEFAULT,
  LAUNCH_DOCK_RAIL_WIDTH_DEFAULT,
  LAUNCH_RAIL_TELEMETRY_RATIO_DEFAULT,
} from "./launchDockLayout";
import { capCodeSize, PLAYGROUND_MAX_CODE_CHARS } from "./playgroundCodegen";
import type {
  ConfigViewMode,
  GpuControlOcMode,
  GpuControlPreset,
  GpuControlSavedState,
  GpuControlSharedPreset,
} from "./types";

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
 * | BlackOps-sort-field | string | Catalog sort column (default: date) |
 * | BlackOps-sort-dir | asc \| desc | Catalog sort direction (default: desc) |
 * | BlackOps-ui-zoom | number string | Main content text scale (0.7–1.5) |
 * | BlackOps-ui-density | comfortable \| compact | Engine config chip/row density |
 * | BlackOps-catalog-visible-count | 4 \| 6 \| 8 \| all | Models visible per page (default: all) |
 * | BlackOps-catalog-draft-filter | regular \| draft \| all | Catalog main/draft filter |
 * | BlackOps-model-spec:{modelPath} | JSON | Per-main-model spec decode overrides |
 * | BlackOps-draft-pairings | JSON Record<targetPath, {specType, draftPath}> | Per-target spec draft pairings |
 * | BlackOps-dflash-hf-candidates | JSON | TTL cache of HF Get-draft scored candidates per main identity |
 * | BlackOps-param-creator-mode | simple \| advanced | Param creator UI mode |
 * | BlackOps-selected-slot-idx | number string | Last selected engine slot (-1 = none) |
 * | BlackOps-app-theme | string | Active app theme id (matrix, amber, …) |
 * | BlackOps-log-search-by-slot | JSON Record<slot, query> | Per-slot ENGINE LOGS search |
 * | BlackOps-logs-ansi-enabled | "0" \| "1" | ENGINE LOGS ANSI color rendering |
 * | BlackOps-startup-updates | JSON | Cached startup update check results |
 * | BlackOps-fusion-hero-tps | live \| avg | Fusion hero TPS display mode |
 * | BlackOps-fusion-bench-tray | open \| stowed | Fusion overlay benchmark tray (default: stowed) |
 * | BlackOps-config-param-legend | open \| stowed | CONFIG PARAMETERS editor legend panel |
 * | BlackOps-display-texture | clean \| phosphor-dark \| phosphor-light | Display texture cycle (glitch legacy → clean) |
 * | BlackOps-industrial-bezel-texture | sandblast \| diamond \| brush | Dark-theme gunmetal bezel pattern |
 * | BlackOps-catalog-split-width | number string (px) | Model catalog / engine config split |
 * | BlackOps-catalog-list-collapsed | "0" \| "1" | Model catalog list fully collapsed |
 * | BlackOps-model-hub-split-width | number string (0–1) | Model Hub results / quants split ratio |

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
 * | BlackOps-auto-vram:{providerId} | "0" \| "1" | Auto VRAM (default ON when factory autoVram / missing key) |

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
  /** sessionStorage — user acknowledged REPLACE launch confirm this session */
  customFlagsReplaceAck: `${STORAGE_PREFIX}custom-flags-replace-ack`,
  collapsedGroups: `${STORAGE_PREFIX}collapsed-groups`,
  lastModel: `${STORAGE_PREFIX}last-model`,
  sortField: `${STORAGE_PREFIX}sort-field`,
  sortDir: `${STORAGE_PREFIX}sort-dir`,
  uiZoom: `${STORAGE_PREFIX}ui-zoom`,
  uiDensity: `${STORAGE_PREFIX}ui-density`,
  catalogVisibleCount: `${STORAGE_PREFIX}catalog-visible-count`,
  catalogDraftFilter: `${STORAGE_PREFIX}catalog-draft-filter`,
  draftPairings: `${STORAGE_PREFIX}draft-pairings`,
  /** HF Get-draft scored candidate list cache (TTL ~4h, stale OK on 429). */
  dflashHfCandidates: `${STORAGE_PREFIX}dflash-hf-candidates`,
  paramCreatorMode: `${STORAGE_PREFIX}param-creator-mode`,
  selectedSlotIdx: `${STORAGE_PREFIX}selected-slot-idx`,
  appTheme: `${STORAGE_PREFIX}app-theme`,
  logSearchBySlot: `${STORAGE_PREFIX}log-search-by-slot`,
  logsAnsiEnabled: `${STORAGE_PREFIX}logs-ansi-enabled`,
  /** Legacy DEV session log pref (UI removed — session log stays ON in debug; env BLACKWELL_SESSION_LOG still works). */
  sessionLogEnabled: `${STORAGE_PREFIX}session-log-enabled`,
  startupUpdates: `${STORAGE_PREFIX}startup-updates`,
  /** Dev: fake installed version for in-app updater testing (e.g. "1.0.9"). */
  devUpdateVersionFake: `${STORAGE_PREFIX}dev-update-version-fake`,
  fusionHeroTpsMode: `${STORAGE_PREFIX}fusion-hero-tps`,
  fusionBenchTray: `${STORAGE_PREFIX}fusion-bench-tray`,
  configParamLegend: `${STORAGE_PREFIX}config-param-legend`,
  displayTexture: `${STORAGE_PREFIX}display-texture`,
  industrialBezelTexture: `${STORAGE_PREFIX}industrial-bezel-texture`,
  configLayoutMode: `${STORAGE_PREFIX}config-layout-mode`,
  /** Engine config launch dock — bottom bar or right rail (`bottom` | `right`). */
  launchDockPosition: `${STORAGE_PREFIX}launch-dock-position`,
  /** Set when user picks dock position manually — disables viewport auto-suggest. */
  launchDockPositionExplicit: `${STORAGE_PREFIX}launch-dock-position-explicit`,
  launchDockCollapsed: `${STORAGE_PREFIX}launch-dock-collapsed`,
  launchDockRailWidth: `${STORAGE_PREFIX}launch-dock-rail-width`,
  /** Right rail — telemetry vs launch vertical split (0–1 ratio). */
  launchRailTelemetryRatio: `${STORAGE_PREFIX}launch-rail-telemetry-ratio`,
  /** Config panel — live HW monitor column (any dock layout). */
  hwMonitorOpen: `${STORAGE_PREFIX}hw-monitor-open`,
  /** HW monitor — per-core CPU grid expanded under CPU header. */
  hwMonitorCpuCoresOpen: `${STORAGE_PREFIX}hw-monitor-cpu-cores-open`,
  /** Running engine / fusion switcher in launch rail instead of below VRAM display. */
  enginesInRail: `${STORAGE_PREFIX}engines-in-rail`,
  /** CTX strip: docked inside cockpit vs standalone above cockpit. */
  ctxCockpitDock: `${STORAGE_PREFIX}ctx-cockpit-dock`,
  catalogSplitWidth: `${STORAGE_PREFIX}catalog-split-width`,
  catalogListCollapsed: `${STORAGE_PREFIX}catalog-list-collapsed`,
  /** OPERATIONS model list: auto | open | closed */
  catalogPresentation: `${STORAGE_PREFIX}catalog-presentation`,
  modelHubSplitWidth: `${STORAGE_PREFIX}model-hub-split-width`,
  setupGuideDismissed: `${STORAGE_PREFIX}setup-guide-dismissed`,
  setupWelcomeSeen: `${STORAGE_PREFIX}setup-welcome-seen`,
  setupGuidePreview: `${STORAGE_PREFIX}setup-guide-preview`,
  /** Onboarding: user skipped 1-click Foundry toolchain (offer again in CONFIG → providers). */
  toolchainOnboardingSkipped: `${STORAGE_PREFIX}toolchain-onboarding-skipped`,
  /** Last completed GGUF batch scan during setup (scanned/failed/total). */
  setupMetaScanSummary: `${STORAGE_PREFIX}setup-meta-scan-summary`,
  /** Onboarding: user chose to download models later (skip library link + metadata scan). */
  setupModelsDeferred: `${STORAGE_PREFIX}setup-models-deferred`,
  benchControls: `${STORAGE_PREFIX}bench-controls`,
  /** Daily fusion share PNG sequence (1–999), keyed by YYYY-MM-DD. */
  fusionShareSeq: `${STORAGE_PREFIX}fusion-share-seq`,
  /** CONFIG providers FIT library scan UI — survives sub-tab navigation (session). */
  fitScanSessions: `${STORAGE_PREFIX}fit-scan-sessions`,
  /** Agent Playground isolated state (history, current code, last engine choice). Never touches app source. */
  playgroundState: `${STORAGE_PREFIX}playground-state`,
  /** EXTRAS tab sub-navigation (playground, …). */
  extrasSubTab: `${STORAGE_PREFIX}extras-sub-tab`,
  /** GPU overclock presets + re-apply on launch (Telemetry). */
  gpuControlState: `${STORAGE_PREFIX}gpu-control-state`,
} as const;

export type ExtrasSubTab = "intel" | "playground";

const EXTRAS_SUB_TAB_DEFAULT: ExtrasSubTab = "intel";

export function loadExtrasSubTab(): ExtrasSubTab {
  const v = readStorage(KEYS.extrasSubTab);
  if (v === "intel" || v === "playground") return v;
  return EXTRAS_SUB_TAB_DEFAULT;
}

// ── GPU control (Extras) ────────────────────────────────────────────────────

export type { GpuControlSavedState };

const GPU_CONTROL_SHARED_DEFAULT: GpuControlSharedPreset = {
  powerLimitW: 0,
  coreOffsetMhz: 0,
  memOffsetMhz: 0,
};

const GPU_CONTROL_DEFAULT: GpuControlSavedState = {
  reapplyOnLaunch: false,
  ocMode: "sync",
  selectedGpuIndex: 0,
  sharedPreset: { ...GPU_CONTROL_SHARED_DEFAULT },
  presets: [],
};

function parseSharedPreset(raw: unknown): GpuControlSharedPreset {
  if (!raw || typeof raw !== "object") return { ...GPU_CONTROL_SHARED_DEFAULT };
  const p = raw as Partial<GpuControlSharedPreset>;
  return {
    powerLimitW: typeof p.powerLimitW === "number" ? p.powerLimitW : 0,
    coreOffsetMhz: typeof p.coreOffsetMhz === "number" ? p.coreOffsetMhz : 0,
    memOffsetMhz: typeof p.memOffsetMhz === "number" ? p.memOffsetMhz : 0,
  };
}

function parseOcMode(raw: unknown): GpuControlOcMode {
  return raw === "individual" ? "individual" : "sync";
}

export function loadGpuControlState(): GpuControlSavedState {
  const raw = readStorage(KEYS.gpuControlState);
  if (!raw) return { ...GPU_CONTROL_DEFAULT, presets: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<GpuControlSavedState>;
    if (!parsed || typeof parsed !== "object") return { ...GPU_CONTROL_DEFAULT, presets: [] };
    return {
      reapplyOnLaunch: false,
      ocMode: parseOcMode(parsed.ocMode),
      selectedGpuIndex:
        typeof parsed.selectedGpuIndex === "number" ? parsed.selectedGpuIndex : 0,
      sharedPreset: parseSharedPreset(parsed.sharedPreset),
      presets: Array.isArray(parsed.presets)
        ? parsed.presets.filter(
            (p): p is GpuControlPreset =>
              p != null &&
              typeof p.gpuIndex === "number" &&
              typeof p.powerLimitW === "number" &&
              typeof p.coreOffsetMhz === "number" &&
              typeof p.memOffsetMhz === "number",
          )
        : [],
    };
  } catch {
    return { ...GPU_CONTROL_DEFAULT, presets: [] };
  }
}

export function saveGpuControlState(state: GpuControlSavedState): void {
  writeStorage(KEYS.gpuControlState, JSON.stringify(state));
}

export function saveExtrasSubTab(tab: ExtrasSubTab): void {
  writeStorage(KEYS.extrasSubTab, tab);
}

export function isSetupGuideDismissed(): boolean {
  return readStorage(KEYS.setupGuideDismissed) === "1";
}

export function saveSetupGuideDismissed(): void {
  writeStorage(KEYS.setupGuideDismissed, "1");
}

export function isToolchainOnboardingSkipped(): boolean {
  return readStorage(KEYS.toolchainOnboardingSkipped) === "1";
}

export function saveToolchainOnboardingSkipped(): void {
  writeStorage(KEYS.toolchainOnboardingSkipped, "1");
}

export function clearToolchainOnboardingSkipped(): void {
  removeStorage(KEYS.toolchainOnboardingSkipped);
}

export function isSetupModelsDeferred(): boolean {
  return readStorage(KEYS.setupModelsDeferred) === "1";
}

export function saveSetupModelsDeferred(): void {
  writeStorage(KEYS.setupModelsDeferred, "1");
}

export function clearSetupModelsDeferred(): void {
  removeStorage(KEYS.setupModelsDeferred);
}

export interface SetupMetaScanSummary {
  scanned: number;
  failed: number;
  total: number;
}

export function loadSetupMetaScanSummary(): SetupMetaScanSummary | null {
  const raw = readStorage(KEYS.setupMetaScanSummary);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SetupMetaScanSummary>;
    if (
      parsed &&
      typeof parsed.scanned === "number" &&
      typeof parsed.failed === "number" &&
      typeof parsed.total === "number"
    ) {
      return {
        scanned: parsed.scanned,
        failed: parsed.failed,
        total: parsed.total,
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function saveSetupMetaScanSummary(summary: SetupMetaScanSummary | null): void {
  if (!summary) {
    removeStorage(KEYS.setupMetaScanSummary);
    return;
  }
  writeStorage(KEYS.setupMetaScanSummary, JSON.stringify(summary));
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

export function loadDevUpdateVersionFake(): string | null {
  const raw = readStorage(KEYS.devUpdateVersionFake);
  return raw?.trim() || null;
}

export function saveDevUpdateVersionFake(version: string | null): void {
  if (!version?.trim()) {
    removeStorage(KEYS.devUpdateVersionFake);
    return;
  }
  writeStorage(KEYS.devUpdateVersionFake, version.trim());
}

export function disableSetupGuidePreview(): void {
  removeStorage(KEYS.setupGuidePreview);
}

/** Clear setup onboarding persistence (safe when keys were never written). */
export function resetSetupGuideState(): void {
  removeStorage(KEYS.setupGuideDismissed);
  removeStorage(KEYS.setupWelcomeSeen);
  removeStorage(KEYS.setupGuidePreview);
  removeStorage(KEYS.setupMetaScanSummary);
  removeStorage(KEYS.setupModelsDeferred);
  clearToolchainOnboardingSkipped();
}

export const CATALOG_SPLIT_WIDTH_DEFAULT = 320;
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

// ── Engine config launch dock layout ───────────────────────────────────────

export type { LaunchDockPosition };

export function loadLaunchDockPositionExplicit(): boolean {
  return readStorage(KEYS.launchDockPositionExplicit) === "1";
}

export function loadLaunchDockPosition(): LaunchDockPosition {
  const raw = readStorage(KEYS.launchDockPosition);
  if (raw === "bottom" || raw === "right") return raw;
  // Fresh install / no key: bottom dock, right rail closed.
  return LAUNCH_DOCK_POSITION_DEFAULT;
}

export function saveLaunchDockPosition(position: LaunchDockPosition, explicit: boolean): void {
  writeStorage(KEYS.launchDockPosition, position);
  writeStorage(KEYS.launchDockPositionExplicit, explicit ? "1" : "0");
}

export function loadLaunchDockCollapsed(): boolean {
  return readStorage(KEYS.launchDockCollapsed) === "1";
}

export function saveLaunchDockCollapsed(collapsed: boolean): void {
  writeStorage(KEYS.launchDockCollapsed, collapsed ? "1" : "0");
}

export function loadLaunchDockRailWidth(): number {
  const raw = readStorage(KEYS.launchDockRailWidth);
  if (!raw) return LAUNCH_DOCK_RAIL_WIDTH_DEFAULT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return LAUNCH_DOCK_RAIL_WIDTH_DEFAULT;
  return clampLaunchDockRailWidth(n);
}

export function saveLaunchDockRailWidth(width: number): void {
  writeStorage(KEYS.launchDockRailWidth, String(clampLaunchDockRailWidth(width)));
}

export function loadLaunchRailTelemetryRatio(): number {
  const raw = readStorage(KEYS.launchRailTelemetryRatio);
  if (!raw) return LAUNCH_RAIL_TELEMETRY_RATIO_DEFAULT;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return LAUNCH_RAIL_TELEMETRY_RATIO_DEFAULT;
  return clampLaunchRailTelemetryRatio(n);
}

export function saveLaunchRailTelemetryRatio(ratio: number): void {
  writeStorage(KEYS.launchRailTelemetryRatio, String(clampLaunchRailTelemetryRatio(ratio)));
}

export function loadHwMonitorOpen(): boolean {
  return readStorage(KEYS.hwMonitorOpen) === "1";
}

export function saveHwMonitorOpen(open: boolean): void {
  writeStorage(KEYS.hwMonitorOpen, open ? "1" : "0");
}

export function loadHwMonitorCpuCoresOpen(): boolean {
  return readStorage(KEYS.hwMonitorCpuCoresOpen) === "1";
}

export function saveHwMonitorCpuCoresOpen(open: boolean): void {
  writeStorage(KEYS.hwMonitorCpuCoresOpen, open ? "1" : "0");
}

export function loadEnginesInRail(): boolean {
  return readStorage(KEYS.enginesInRail) === "1";
}

export function saveEnginesInRail(inRail: boolean): void {
  writeStorage(KEYS.enginesInRail, inRail ? "1" : "0");
}

/** CTX strip placement: inside Launch cockpit or standalone above it. */
export type CtxCockpitDock = "cockpit" | "above";

export function loadCtxCockpitDock(): CtxCockpitDock {
  return readStorage(KEYS.ctxCockpitDock) === "above" ? "above" : "cockpit";
}

export function saveCtxCockpitDock(dock: CtxCockpitDock): void {
  writeStorage(KEYS.ctxCockpitDock, dock);
}

// ── Dynamic key builders (BlackOps-{namespace}:{id}) ─────────────────────────

export function catalogOverrideKey(providerId: string): string {
  return `${STORAGE_PREFIX}catalog-override:${providerId}`;
}

export type ModelSpecOverride = {
  spec_type?: string;
  spec_draft_model?: string;
  spec_draft_n_max?: number | string;
  spec_draft_n_min?: number | string;
};

export function modelSpecOverrideKey(modelPath: string): string {
  return `${STORAGE_PREFIX}model-spec:${normalizeModelPathKey(modelPath)}`;
}

/** Strip spec keys mistakenly stored in global catalog overrides (pre per-model fix). */
export function migrateGlobalSpecOutOfCatalogOverrides(providerId: string): void {
  const key = catalogOverrideKey(providerId);
  const stored = readJsonStorage<Record<string, unknown>>(key);
  if (!stored) return;
  const specKeys = ["spec_type", "spec_draft_model", "spec_draft_n_max", "spec_draft_n_min"];
  let changed = false;
  for (const k of specKeys) {
    if (k in stored) {
      delete stored[k];
      changed = true;
    }
  }
  if (changed) writeJsonStorage(key, stored);
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
  // Explicit 1C is a valid stored choice (user picked 1C in toolbar).
  if (stored === 1) return 1;
  if (fromProvider === 2 || fromProvider === 3) return fromProvider;
  if (fromProvider === 1) return 1;
  // Product default: two columns (1C wastes horizontal space on typical windows).
  return 2;
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

/** Case-insensitive path key — mirrors backend `model_path_key` / ConfigPage dedup. */
export function normalizeModelPathKey(path: string): string {
  let p = path.trim();
  if (p.startsWith("\\\\?\\UNC\\")) {
    p = `\\\\${p.slice("\\\\?\\UNC\\".length)}`;
  } else if (p.startsWith("\\\\?\\")) {
    p = p.slice("\\\\?\\".length);
  }
  return p.replace(/[/\\]+$/, "").toLowerCase();
}

export function loadLastModel(): string | null {
  const path = readStorage(KEYS.lastModel);
  return path && path.trim().length > 0 ? path : null;
}

export function saveLastModel(modelPath: string): void {
  const trimmed = modelPath.trim();
  if (!trimmed) return;
  writeStorage(KEYS.lastModel, trimmed);
}

export function clearLastModel(): void {
  removeStorage(KEYS.lastModel);
}

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
  // Fresh install / missing key → stowed (user prefs always win once set)
  return v === "open" ? "open" : "stowed";
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

export function loadCatalogListCollapsed(): boolean {
  return readStorage(KEYS.catalogListCollapsed) === "1";
}

export function saveCatalogListCollapsed(collapsed: boolean): void {
  writeStorage(KEYS.catalogListCollapsed, collapsed ? "1" : "0");
}

/**
 * OPERATIONS model list: permanent open/closed (localStorage).
 * `/` floating search is independent and always available.
 * Legacy `"auto"` migrates to `"open"`.
 */
export type CatalogPresentation = "open" | "closed";

export function loadCatalogPresentation(): CatalogPresentation {
  const v = readStorage(KEYS.catalogPresentation);
  if (v === "closed") return "closed";
  if (v === "open" || v === "auto") return "open"; // auto = legacy
  // No presentation key yet — migrate from older collapsed-only flag
  if (loadCatalogListCollapsed()) return "closed";
  return "open";
}

export function saveCatalogPresentation(mode: CatalogPresentation): void {
  writeStorage(KEYS.catalogPresentation, mode);
  saveCatalogListCollapsed(mode === "closed");
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

export function loadSessionLogEnabled(defaultEnabled = true): boolean {
  const value = readStorage(KEYS.sessionLogEnabled);
  if (value === "0") return false;
  if (value === "1") return true;
  return defaultEnabled;
}

export function saveSessionLogEnabled(enabled: boolean): void {
  writeStorage(KEYS.sessionLogEnabled, enabled ? "1" : "0");
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

// ── Playground (isolated agent test area) ────────────────────────────────────
// State lives ONLY under BlackOps-playground-state. Generated code, prompts,
// and previews are never persisted into app source, engines, or shared stores.

export interface PlaygroundChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface PlaygroundSession {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  history: PlaygroundChatTurn[];
  currentCode: string;
  lastPrompt: string;
}

export interface PlaygroundState {
  activeSessionId: string;
  sessions: PlaygroundSession[];
  selectedSlotIdx: number | null;
  temp: number;
  maxTokens: number;
  autoPreview: boolean;
  wrapOutput: boolean;
  useChatApi: boolean;
  splitRatio: number;
  hasSeenGuide: boolean;
}

export const PLAYGROUND_SPLIT_RATIO_DEFAULT = 0.45;
export const PLAYGROUND_SPLIT_RATIO_MIN = 0.22;
export const PLAYGROUND_SPLIT_RATIO_MAX = 0.78;
export const PLAYGROUND_MAX_SESSIONS = 12;
export const PLAYGROUND_MAX_HISTORY_TURNS = 20;

function newSessionId(): string {
  return `pg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createPlaygroundSession(name = "Session 1"): PlaygroundSession {
  const now = Date.now();
  return {
    id: newSessionId(),
    name,
    createdAt: now,
    updatedAt: now,
    history: [],
    currentCode: "",
    lastPrompt: "",
  };
}

function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return PLAYGROUND_SPLIT_RATIO_DEFAULT;
  return Math.min(PLAYGROUND_SPLIT_RATIO_MAX, Math.max(PLAYGROUND_SPLIT_RATIO_MIN, ratio));
}

function normalizeSession(raw: unknown, fallbackName: string): PlaygroundSession | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const id = typeof s.id === "string" ? s.id : newSessionId();
  const now = Date.now();
  return {
    id,
    name: typeof s.name === "string" && s.name.trim() ? s.name.trim() : fallbackName,
    createdAt: typeof s.createdAt === "number" ? s.createdAt : now,
    updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : now,
    history: Array.isArray(s.history) ? (s.history as PlaygroundChatTurn[]) : [],
    currentCode: typeof s.currentCode === "string" ? capCodeSize(s.currentCode) : "",
    lastPrompt: typeof s.lastPrompt === "string" ? s.lastPrompt : "",
  };
}

function migrateLegacyPlayground(stored: Record<string, unknown>): PlaygroundState {
  const session = createPlaygroundSession("Migrated session");
  session.history = Array.isArray(stored.history) ? (stored.history as PlaygroundChatTurn[]) : [];
  session.currentCode =
    typeof stored.currentCode === "string" ? capCodeSize(stored.currentCode) : "";
  session.lastPrompt = typeof stored.lastPrompt === "string" ? stored.lastPrompt : "";
  return {
    activeSessionId: session.id,
    sessions: [session],
    selectedSlotIdx: typeof stored.selectedSlotIdx === "number" ? stored.selectedSlotIdx : null,
    temp: 0.65,
    maxTokens: 4096,
    autoPreview: true,
    wrapOutput: true,
    useChatApi: true,
    splitRatio: PLAYGROUND_SPLIT_RATIO_DEFAULT,
    hasSeenGuide: false,
  };
}

const PLAYGROUND_DEFAULT: PlaygroundState = (() => {
  const session = createPlaygroundSession("Session 1");
  return {
    activeSessionId: session.id,
    sessions: [session],
    selectedSlotIdx: null,
    temp: 0.65,
    maxTokens: 4096,
    autoPreview: true,
    wrapOutput: true,
    useChatApi: true,
    splitRatio: PLAYGROUND_SPLIT_RATIO_DEFAULT,
    hasSeenGuide: false,
  };
})();

export function loadPlaygroundState(): PlaygroundState {
  const stored = readJsonStorage<Record<string, unknown>>(KEYS.playgroundState);
  if (!stored || typeof stored !== "object") return { ...PLAYGROUND_DEFAULT };

  if (!Array.isArray(stored.sessions)) {
    return migrateLegacyPlayground(stored);
  }

  const sessions = stored.sessions
    .map((s, i) => normalizeSession(s, `Session ${i + 1}`))
    .filter((s): s is PlaygroundSession => s != null)
    .slice(0, PLAYGROUND_MAX_SESSIONS);

  if (sessions.length === 0) return { ...PLAYGROUND_DEFAULT };

  const activeSessionId =
    typeof stored.activeSessionId === "string" &&
    sessions.some((s) => s.id === stored.activeSessionId)
      ? stored.activeSessionId
      : sessions[0].id;

  return {
    activeSessionId,
    sessions,
    selectedSlotIdx: typeof stored.selectedSlotIdx === "number" ? stored.selectedSlotIdx : null,
    temp: typeof stored.temp === "number" ? stored.temp : 0.65,
    maxTokens: typeof stored.maxTokens === "number" ? stored.maxTokens : 4096,
    autoPreview: stored.autoPreview !== false,
    wrapOutput: stored.wrapOutput !== false,
    useChatApi: stored.useChatApi !== false,
    splitRatio: clampSplitRatio(
      typeof stored.splitRatio === "number" ? stored.splitRatio : PLAYGROUND_SPLIT_RATIO_DEFAULT,
    ),
    hasSeenGuide: stored.hasSeenGuide === true,
  };
}

export function getActivePlaygroundSession(state: PlaygroundState): PlaygroundSession {
  return state.sessions.find((s) => s.id === state.activeSessionId) ?? state.sessions[0];
}

export function updateActiveSession(
  state: PlaygroundState,
  patch: Partial<Pick<PlaygroundSession, "history" | "currentCode" | "lastPrompt" | "name">>,
): PlaygroundState {
  const now = Date.now();
  const sessions = state.sessions.map((s) =>
    s.id === state.activeSessionId
      ? {
          ...s,
          ...patch,
          currentCode:
            patch.currentCode !== undefined ? capCodeSize(patch.currentCode) : s.currentCode,
          history:
            patch.history !== undefined
              ? patch.history.slice(-PLAYGROUND_MAX_HISTORY_TURNS)
              : s.history,
          updatedAt: now,
        }
      : s,
  );
  return { ...state, sessions };
}

export function savePlaygroundState(state: PlaygroundState): void {
  const sessions = state.sessions
    .slice(0, PLAYGROUND_MAX_SESSIONS)
    .map((s) => ({
      ...s,
      history: s.history.slice(-PLAYGROUND_MAX_HISTORY_TURNS),
      currentCode: capCodeSize(s.currentCode),
    }));

  const capped: PlaygroundState = {
    ...state,
    sessions,
    splitRatio: clampSplitRatio(state.splitRatio),
    maxTokens: Math.max(256, Math.min(65536, Math.round(state.maxTokens))),
    temp: Math.max(0, Math.min(2, state.temp)),
  };
  writeJsonStorage(KEYS.playgroundState, capped);
}

export function clearPlaygroundState(): void {
  removeStorage(KEYS.playgroundState);
}

export function exportPlaygroundBundle(state: PlaygroundState): string {
  return JSON.stringify(
    {
      version: 1,
      exportedAt: new Date().toISOString(),
      state: state,
      maxCodeChars: PLAYGROUND_MAX_CODE_CHARS,
    },
    null,
    2,
  );
}

export function importPlaygroundBundle(raw: string): PlaygroundState | null {
  try {
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
    if (!parsed?.state || !Array.isArray(parsed.state.sessions) || parsed.state.sessions.length === 0) {
      return null;
    }
    writeJsonStorage(KEYS.playgroundState, parsed.state);
    return loadPlaygroundState();
  } catch {
    return null;
  }
}