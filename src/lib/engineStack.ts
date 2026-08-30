import type { StackEntry } from "./types";
import { invoke } from "@tauri-apps/api/core";
import { dispatchAppEvent, EVENTS } from "./events";


/** Stack slots that represent a live or recently failed engine — not empty IDLE placeholders. */
export function isActiveEngineSlot(entry: StackEntry): boolean {
  return entry.status === "RUNNING" || entry.status === "LOADING" || entry.status === "ERROR";
}

export function getActiveStackSlots(stack: StackEntry[]): StackEntry[] {
  return stack.filter(isActiveEngineSlot);
}

/** Stop every engine slot — same path as ENGINE STACK "STOP ALL". */
export async function stopAllEngines(): Promise<void> {
  await invoke("stop_all_engines");
  dispatchAppEvent(EVENTS.stopAll);
}