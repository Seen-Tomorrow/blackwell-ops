/**
 * Engine lifecycle primitives shared by the run owners (OVERDRIVE, forecast curve calibration).
 *
 * Polling is deliberate: the stack push event updates React, but a non-React state machine needs
 * a simple, ordered view of the slot. Every wait has a deadline; none of them `Instant - Duration`.
 */
import { invoke } from "@tauri-apps/api/core";
import type { StackEntry } from "./types";

export const ACTIVE_STATUSES = new Set(["LOADING", "RUNNING"]);

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readStack(): Promise<StackEntry[]> {
  return invoke<StackEntry[]>("get_stack_status");
}

export function activeEntries(entries: StackEntry[]): StackEntry[] {
  return entries.filter((entry) => ACTIVE_STATUSES.has(entry.status));
}

/** Poll until the slot is RUNNING. Throws on idle/error/timeout/abort. */
export async function waitForRunning(
  slotIdx: number,
  opts: { timeoutMs?: number; isAborted?: () => boolean } = {},
): Promise<StackEntry> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  for (;;) {
    if (opts.isAborted?.()) throw new Error("aborted");
    const entry = (await readStack()).find((item) => item.idx === slotIdx);
    if (!entry) throw new Error("the launched engine vanished before it finished loading");
    if (entry.status === "ERROR") {
      throw new Error("the engine reported ERROR while loading — see the engine log");
    }
    if (!ACTIVE_STATUSES.has(entry.status)) {
      throw new Error(`the engine stopped while loading (${entry.status})`);
    }
    if (entry.status === "RUNNING") return entry;
    if (Date.now() > deadline) {
      throw new Error("the engine did not reach RUNNING within the deadline");
    }
    await sleep(800);
  }
}

/** Poll until the slot is no longer LOADING/RUNNING. */
export async function waitIdle(slotIdx: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = (await readStack()).find((item) => item.idx === slotIdx);
    if (!entry || !ACTIVE_STATUSES.has(entry.status)) return;
    await sleep(300);
  }
}

/** Stop a slot and wait for it to settle. Idempotent for an already-idle slot. */
export async function stopSlot(slotIdx: number): Promise<void> {
  await invoke("stop_engine_slot", { slotIdx }).catch(() => {});
  await waitIdle(slotIdx);
}
