/**
 * App-wide custom event registry — all names use the `BlackOps-` prefix.
 *
 * | Event | Purpose |
 * |-------|---------|
 * | BlackOps-power-user-changed | POWER USER toggle synced across Layout / Config / App |
 * | BlackOps-reload-providers | Refetch provider list from Rust after config save |
 * | BlackOps-param-config-changed | Param catalog/count changed; reload overrides |
 * | BlackOps-navigate-stack | Switch to ENGINES tab (GPU topo click-through) |
 * | BlackOps-navigate-catalog | Switch to OPERATIONS tab (catalog — model pick, FIT, bench) |
 * | BlackOps-navigate-extras | Switch to EXTRAS tab; detail.subTab selects sub-tab |
 * | BlackOps-launch-engine | Request launch from catalog keyboard shortcut |
 * | BlackOps-launch-success | Engine started — status bar + toast |
 * | BlackOps-launch-error | Launch failed — status bar + toast |
 * | BlackOps-engine-launched | Backend returned slot — auto-select in catalog |
 * | BlackOps-stop-all | All engines stopped — clear slot selection |
 * | BlackOps-slot-cleared | Single slot cleared — update selection |
 * | BlackOps-download-completed | Model Hub download finished — refresh catalog |
 * | BlackOps-telemetry-view-changed | TELEMETRY tab switched standard ↔ lab |
 * | BlackOps-model-paths-changed | Model path added/removed/default changed — refresh catalog |
 * | BlackOps-navigate-config | Switch to CONFIG tab; detail.subTab selects sub-tab (incl. recovery) |
 * | BlackOps-setup-guide-changed | Setup guide phase/dismiss state changed |
 * | BlackOps-reset-setup-guide | Clear onboarding keys and replay welcome/guide in-app |
 * | BlackOps-show-all-hidden-params | CONFIG footer — unhide all hidden param rows (current provider) |
 * | BlackOps-local-storage-cleared | All `BlackOps-*` keys removed (before optional reload) |
 * | BlackOps-provider-changed | Engine panel provider pill changed — catalog FIT cache refresh |
 * | BlackOps-fit-scan-cache-changed | FIT library partition updated — refresh forecast points |
 */

export type NavigateConfigDetail = {
  subTab?: "providers" | "params" | "paths" | "secrets" | "recovery";
};

import { invoke } from "@tauri-apps/api/core";
import {
  clearAllBlackOpsStorage,
  disableSetupGuidePreview,
  enableSetupGuidePreview,
  resetSetupGuideState,
  STORAGE_PREFIX,
  type ExtrasSubTab,
} from "./storage";

export const EVENTS = {
  powerUserChanged: `${STORAGE_PREFIX}power-user-changed`,
  reloadProviders: `${STORAGE_PREFIX}reload-providers`,
  paramConfigChanged: `${STORAGE_PREFIX}param-config-changed`,
  navigateStack: `${STORAGE_PREFIX}navigate-stack`,
  navigateCatalog: `${STORAGE_PREFIX}navigate-catalog`,
  navigateExtras: `${STORAGE_PREFIX}navigate-extras`,
  launchEngine: `${STORAGE_PREFIX}launch-engine`,
  launchSuccess: `${STORAGE_PREFIX}launch-success`,
  launchError: `${STORAGE_PREFIX}launch-error`,
  engineLaunched: `${STORAGE_PREFIX}engine-launched`,
  stopAll: `${STORAGE_PREFIX}stop-all`,
  slotCleared: `${STORAGE_PREFIX}slot-cleared`,
  downloadCompleted: `${STORAGE_PREFIX}download-completed`,
  telemetryViewChanged: `${STORAGE_PREFIX}telemetry-view-changed`,
  modelPathsChanged: `${STORAGE_PREFIX}model-paths-changed`,
  navigateConfig: `${STORAGE_PREFIX}navigate-config`,
  setupGuideChanged: `${STORAGE_PREFIX}setup-guide-changed`,
  resetSetupGuide: `${STORAGE_PREFIX}reset-setup-guide`,
  showAllHiddenParams: `${STORAGE_PREFIX}show-all-hidden-params`,
  localStorageCleared: `${STORAGE_PREFIX}local-storage-cleared`,
  providerChanged: `${STORAGE_PREFIX}provider-changed`,
  fitScanCacheChanged: `${STORAGE_PREFIX}fit-scan-cache-changed`,
} as const;

export type AppEventName = (typeof EVENTS)[keyof typeof EVENTS];

export function dispatchAppEvent(event: AppEventName, detail?: unknown): void {
  window.dispatchEvent(
    detail !== undefined ? new CustomEvent(event, { detail }) : new CustomEvent(event),
  );
}

let pendingConfigSubTab: NavigateConfigDetail["subTab"] | null = null;

/** Consumed once when ConfigPage mounts (sub-tab intent survives tab switch). */
export function consumePendingConfigSubTab(): NavigateConfigDetail["subTab"] | null {
  const tab = pendingConfigSubTab;
  pendingConfigSubTab = null;
  return tab;
}

export function dispatchNavigateConfig(detail?: NavigateConfigDetail): void {
  if (detail?.subTab) pendingConfigSubTab = detail.subTab;
  dispatchAppEvent(EVENTS.navigateConfig, detail);
}

export function dispatchNavigateCatalog(): void {
  dispatchAppEvent(EVENTS.navigateCatalog);
}

export type NavigateExtrasDetail = {
  subTab?: ExtrasSubTab;
};

let pendingExtrasSubTab: ExtrasSubTab | null = null;

export function consumePendingExtrasSubTab(): ExtrasSubTab | null {
  const tab = pendingExtrasSubTab;
  pendingExtrasSubTab = null;
  return tab;
}

export function dispatchNavigateExtras(detail?: NavigateExtrasDetail): void {
  if (detail?.subTab) pendingExtrasSubTab = detail.subTab;
  dispatchAppEvent(EVENTS.navigateExtras, detail);
}

export function dispatchNavigateModelHub(): void {
  dispatchNavigateExtras({ subTab: "modelhub" });
}

export function dispatchPowerUserChanged(): void {
  dispatchAppEvent(EVENTS.powerUserChanged);
}

/**
 * Dev — full first-run: onboarding keys + model paths (models/ only) + model cache, then reload.
 * Bundled providers are re-discovered in memory (no app restart). LM Studio paths are removed;
 * GGUF files on disk are untouched.
 */
export async function dispatchReplaySetupGuide(): Promise<void> {
  resetSetupGuideState();
  disableSetupGuidePreview();
  try {
    await invoke("dev_reset_first_run");
  } catch (err) {
    console.error("[dev_reset_first_run]", err);
  }
  window.location.reload();
}

/** Dev — replay welcome/guide only; keeps model paths and metadata cache. */
export function dispatchReplaySetupGuideOnboardingOnly(): void {
  resetSetupGuideState();
  enableSetupGuidePreview();
  window.location.reload();
}

/** Remove all `BlackOps-*` localStorage keys (prefs, overrides, bench chips, dynamic provider keys). */
export function dispatchClearLocalStorage(reload = true): number {
  const cleared = clearAllBlackOpsStorage();
  dispatchAppEvent(EVENTS.localStorageCleared, { cleared });
  if (reload) {
    window.location.reload();
  }
  return cleared;
}

/** Navigate to CONFIG → RECOVERY (header shortcut — always reachable). */
export function dispatchNavigateRecovery(): void {
  dispatchNavigateConfig({ subTab: "recovery" });
}

/**
 * Reset portable `config/` to factory defaults, clear onboarding keys, reload.
 * Same outcome as manually deleting the config folder while the app is closed.
 */
export async function dispatchResetAppConfig(): Promise<void> {
  resetSetupGuideState();
  await invoke("reset_app_config");
  window.location.reload();
}

export function dispatchShowAllHiddenParams(): void {
  dispatchAppEvent(EVENTS.showAllHiddenParams);
}