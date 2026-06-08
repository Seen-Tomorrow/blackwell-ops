/**
 * App-wide custom event registry — all names use the `BlackOps-` prefix.
 *
 * | Event | Purpose |
 * |-------|---------|
 * | BlackOps-power-user-changed | POWER USER toggle synced across Layout / Config / App |
 * | BlackOps-reload-providers | Refetch provider list from Rust after config save |
 * | BlackOps-param-config-changed | Param catalog/count changed; reload overrides |
 * | BlackOps-navigate-stack | Switch to ENGINES tab (GPU topo click-through) |
 * | BlackOps-launch-engine | Request launch from catalog keyboard shortcut |
 * | BlackOps-launch-success | Engine started — status bar + toast |
 * | BlackOps-launch-error | Launch failed — status bar + toast |
 * | BlackOps-engine-launched | Backend returned slot — auto-select in catalog |
 * | BlackOps-stop-all | All engines stopped — clear slot selection |
 * | BlackOps-slot-cleared | Single slot cleared — update selection |
 * | BlackOps-download-completed | Model Hub download finished — refresh catalog |
 * | BlackOps-telemetry-view-changed | TELEMETRY tab switched standard ↔ lab |
 * | BlackOps-model-paths-changed | Model path added/removed/default changed — refresh catalog |
 * | BlackOps-navigate-config | Switch to CONFIG tab; detail.subTab selects sub-tab |
 * | BlackOps-setup-guide-changed | Setup guide phase/dismiss state changed |
 * | BlackOps-reset-setup-guide | Clear onboarding keys and replay welcome/guide in-app |
 */

export type NavigateConfigDetail = {
  subTab?: "providers" | "params" | "paths";
};

import { invoke } from "@tauri-apps/api/core";
import {
  disableSetupGuidePreview,
  enableSetupGuidePreview,
  resetSetupGuideState,
  STORAGE_PREFIX,
} from "./storage";

export const EVENTS = {
  powerUserChanged: `${STORAGE_PREFIX}power-user-changed`,
  reloadProviders: `${STORAGE_PREFIX}reload-providers`,
  paramConfigChanged: `${STORAGE_PREFIX}param-config-changed`,
  navigateStack: `${STORAGE_PREFIX}navigate-stack`,
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
} as const;

export type AppEventName = (typeof EVENTS)[keyof typeof EVENTS];

export function dispatchAppEvent(event: AppEventName, detail?: unknown): void {
  if (detail !== undefined) {
    window.dispatchEvent(new CustomEvent(event, { detail }));
  } else {
    window.dispatchEvent(new Event(event));
  }
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