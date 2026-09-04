export type FusionBenchTrayState = "open" | "stowed";

let trayState: FusionBenchTrayState = "stowed";
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
  notifyFusionBenchTrayStore();
}

export function toggleFusionBenchTray(): void {
  setFusionBenchTray(trayState === "open" ? "stowed" : "open");
}

export function subscribeFusionBenchTray(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
