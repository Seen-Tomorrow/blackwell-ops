import type { StackEntry } from "./types";

/** Stack slots that represent a live or recently failed engine — not empty IDLE placeholders. */
export function isActiveEngineSlot(entry: StackEntry): boolean {
  return entry.status === "RUNNING" || entry.status === "LOADING" || entry.status === "ERROR";
}

export function getActiveStackSlots(stack: StackEntry[]): StackEntry[] {
  return stack.filter(isActiveEngineSlot);
}