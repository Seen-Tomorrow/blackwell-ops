import {
  loadFusionBenchTray,
  type FusionBenchTrayState,
} from "./storage";

// Purge legacy LS key once; tray is session memory only.
loadFusionBenchTray();

let trayState: FusionBenchTrayState = "stowed";
const listeners = new Set<() => void>();

function notifyFusionBenchTrayStore(): void {
  for (const fn of listeners) fn();
}

/** No-op kept for callers — tray is session memory, not LS-backed. */
export function refreshFusionBenchTrayFromStorage(): void {
  loadFusionBenchTray();
}

export function getFusionBenchTrayOpen(): boolean {
  return trayState === "open";
}

export function setFusionBenchTray(next: FusionBenchTrayState): void {
  if (next === trayState) return;
  trayState = next;
  notifyFusionBenchTrayStore();
}

export function toggleFusionBenchTray(): void {
  setFusionBenchTray(trayState === "open" ? "stowed" : "open");
}

export function subscribeFusionBenchTray(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
