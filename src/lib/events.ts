/**
 * App-wide custom event registry — every name in `EVENTS` uses the `BlackOps-` prefix.
 */

import type { ConfigSubTab } from "./appNav";
import { invoke } from "@tauri-apps/api/core";
import {
  clearAllBlackOpsStorage,
  disableSetupGuidePreview,
  enableSetupGuidePreview,
  resetSetupGuideState,
  STORAGE_PREFIX,
} from "./storage";

export type NavigateConfigDetail = {
  subTab?: ConfigSubTab;
  /** DOWNLOADS intent: open the software or models view. */
  downloadsView?: "models" | "software";
};

export type NavigateFoundryDetail = {
  providerId: string;
  environment: "edge" | "stable";
};

export const EVENTS = {
  reloadProviders: `${STORAGE_PREFIX}reload-providers`,
  paramConfigChanged: `${STORAGE_PREFIX}param-config-changed`,
  navigateStack: `${STORAGE_PREFIX}navigate-stack`,
  navigateCatalog: `${STORAGE_PREFIX}navigate-catalog`,
  navigateModelHub: `${STORAGE_PREFIX}navigate-model-hub`,
  /** ENGINE build shortcut → FOUNDRY/BUILD with this provider+profile preselected. */
  navigateFoundry: `${STORAGE_PREFIX}navigate-foundry`,
  launchEngine: `${STORAGE_PREFIX}launch-engine`,
  launchSuccess: `${STORAGE_PREFIX}launch-success`,
  launchError: `${STORAGE_PREFIX}launch-error`,
  engineLaunched: `${STORAGE_PREFIX}engine-launched`,
  stopAll: `${STORAGE_PREFIX}stop-all`,
  slotCleared: `${STORAGE_PREFIX}slot-cleared`,
  downloadCompleted: `${STORAGE_PREFIX}download-completed`,
  modelPathsChanged: `${STORAGE_PREFIX}model-paths-changed`,
  navigateConfig: `${STORAGE_PREFIX}navigate-config`,
  setupGuideChanged: `${STORAGE_PREFIX}setup-guide-changed`,
  resetSetupGuide: `${STORAGE_PREFIX}reset-setup-guide`,
  showAllHiddenParams: `${STORAGE_PREFIX}show-all-hidden-params`,
  localStorageCleared: `${STORAGE_PREFIX}local-storage-cleared`,
  /** Monitor focus mode — fusion + HW only chrome hide. */
  monitorFocusChanged: `${STORAGE_PREFIX}monitor-focus-changed`,

  /** CTX slider pointer drag — SOURCE live meter gates on this. */
  ctxSliderDragging: `${STORAGE_PREFIX}ctx-slider-dragging`,

  /** Dev: fake update version toggled — refresh GitHub offerings. */
  updateOfferingsRefresh: `${STORAGE_PREFIX}update-offerings-refresh`,
  /** Agentic harness open — highlight running engines (brain/worker/solo roles). */
  harnessHighlight: `${STORAGE_PREFIX}harness-highlight`,
  /** Open harness connect glass veil (bezel / catalog CONNECT). */
  harnessConnectOpen: `${STORAGE_PREFIX}harness-connect-open`,
  /** Dismiss harness connect glass veil. */
  harnessConnectDismiss: `${STORAGE_PREFIX}harness-connect-dismiss`,

  /** Catalog ENDPOINTS → launch every endpoint in the active set. */
  catalogLaunchEndpoints: `${STORAGE_PREFIX}catalog-launch-endpoints`,
  /** Endpoint set changed — catalog strip and harness binding should reload. */
  catalogEndpointsChanged: `${STORAGE_PREFIX}catalog-endpoints-changed`,
  /** Strip → panel: load this endpoint's bag into the cockpit for editing. */
  catalogEndpointEdit: `${STORAGE_PREFIX}catalog-endpoint-edit`,
  /** Persist the cockpit's current knobs into the endpoint being edited. */
  catalogEndpointSave: `${STORAGE_PREFIX}catalog-endpoint-save`,
  /** Leave endpoint editing without writing. */
  catalogEndpointCancel: `${STORAGE_PREFIX}catalog-endpoint-cancel`,
  /** Panel → strip: endpoint edit session ended (clear the row chrome). */
  catalogEndpointEditEnded: `${STORAGE_PREFIX}catalog-endpoint-edit-ended`,
} as const;

/** Detail for `EVENTS.harnessHighlight`. */
export type HarnessHighlightDetail = {
  open: boolean;
  soloPort?: number | null;
  brainPort?: number | null;
  workerPort?: number | null;
  selectedSlotIdx?: number | null;
};

/**
 * Detail for `EVENTS.catalogLaunchEndpoints`.
 * Ids, not paths: the panel resolves them against the set it can currently see,
 * so a stale click cannot launch a pairing the store no longer holds.
 */
export type CatalogLaunchEndpointsDetail = {
  setIndex: number;
  endpointIds: string[];
};

/** Detail for `EVENTS.catalogEndpointEdit`. */
export type CatalogEndpointEditDetail = {
  endpointId: string;
  role: "brain" | "worker";
  setIndex: number;
  /** Model path already selected in the catalog. */
  modelPath: string;
};

/** Detail for `EVENTS.catalogEndpointEditEnded`. */
export type CatalogEndpointEditEndedDetail = {
  saved: boolean;
  endpointId: string;
  role: "brain" | "worker";
  setIndex: number;
};


/** Detail for `EVENTS.ctxSliderDragging`. */
export type CtxSliderDraggingDetail = {
  dragging: boolean;
};

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

export function dispatchNavigateModelHub(): void {
  dispatchAppEvent(EVENTS.navigateModelHub);
}


/**
 * Full first-run replay — same as CONFIG → RECOVERY → RESET CONFIG.
 * Wipes portable config/ (paths → factory models/, caches, setup_completed), clears onboarding
 * keys, reloads. GGUF files, foundry artifacts, and runtime binaries on disk are untouched.
 */
/**
 * First-run replay: reset portable config/ (user provider overrides, caches) +
 * setup_completed=false, then reload. Does NOT clear BlackOps localStorage —
 * use CLR LS for that. Optional plugins without binaries stay hidden after rediscovery.
 */
async function dispatchReplayFirstRun(): Promise<void> {
  resetSetupGuideState();
  disableSetupGuidePreview();
  await invoke("reset_app_config");
  window.location.reload();
}

/** Dev header ↺ SETUP — identical to recovery full reset (fresh-install test path). */
export async function dispatchReplaySetupGuide(): Promise<void> {
  await dispatchReplayFirstRun();
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
 * CONFIG → RECOVERY → RESET CONFIG — same code path as dev ↺ SETUP.
 */
export async function dispatchResetAppConfig(): Promise<void> {
  await dispatchReplayFirstRun();
}

function dispatchShowAllHiddenParams(): void {
  dispatchAppEvent(EVENTS.showAllHiddenParams);
}