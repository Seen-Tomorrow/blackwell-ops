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
  listeners.add(listener);
  return () => listeners.delete(listener);
}