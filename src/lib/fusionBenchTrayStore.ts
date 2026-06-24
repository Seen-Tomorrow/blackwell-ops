import {
  loadFusionBenchTray,
  saveFusionBenchTray,
  type FusionBenchTrayState,
} from "./storage";

let trayState: FusionBenchTrayState = loadFusionBenchTray();
const listeners = new Set<() => void>();

function notifyFusionBenchTrayStore(): void {
  for (const fn of listeners) fn();
}

/** Re-read persisted tray state (HMR / remount — module singleton can desync from localStorage). */
export function refreshFusionBenchTrayFromStorage(): void {
  const next = loadFusionBenchTray();
  if (next === trayState) return;
  trayState = next;
  notifyFusionBenchTrayStore();
}

export function getFusionBenchTrayOpen(): boolean {
  return trayState === "open";
}

export function setFusionBenchTray(next: FusionBenchTrayState): void {
  if (next === trayState) return;
  trayState = next;
  saveFusionBenchTray(next);
  notifyFusionBenchTrayStore();
}

export function toggleFusionBenchTray(): void {
  setFusionBenchTray(trayState === "open" ? "stowed" : "open");
}

export function subscribeFusionBenchTray(listener: () => void): () => void {
  refreshFusionBenchTrayFromStorage();
  listeners.add(listener);
  return () => listeners.delete(listener);
}