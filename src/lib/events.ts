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
 */

import { STORAGE_PREFIX } from "./storage";

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