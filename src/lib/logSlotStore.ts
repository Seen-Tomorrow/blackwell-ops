/**
 * Engine log buffers, held outside React.
 *
 * These lived in `App` as `useState<Map<number, LogEntry[]>>`. `engine-log-batch`
 * arrives on the same 25 ms tick as telemetry and always carries new lines, so every
 * batch produced a new Map identity, re-rendered `App`, and reconciled the entire
 * mounted tree — Layout, ModelCatalog, EngineGpuForecast, VramBadge, and
 * EngineConfigPanel's 3,620 lines even while `hidden`/`inert` — at up to 40 Hz, with
 * the LOGS tab closed and nothing to show.
 *
 * Mirrors `fusionSlotStore`: per-slot subscription sets so a subscriber only wakes for
 * the slot it renders, plus one global set for the LOGS tab, which is the only
 * consumer that genuinely wants every slot and is unmounted unless that tab is open.
 */
import { useEffect, useState } from "react";
import type { LogEntry, SystemEvent } from "./types";

/** A stored line carries a monotonic sequence so React keys survive window slides. */
export interface StoredLogEntry extends LogEntry {
  seq: number;
}

export interface StoredSystemEvent extends SystemEvent {
  seq: number;
}

/** Matches the window the App implementation used. */
const MAX_LINES = 5000;
const MAX_EVENTS = 50;

const logEntries = new Map<number, StoredLogEntry[]>();
const eventEntries = new Map<number, StoredSystemEvent[]>();
const logSubs = new Map<number, Set<() => void>>();
const eventSubs = new Map<number, Set<() => void>>();
const allSubs = new Set<() => void>();

let seqCounter = 0;

function notifySlot(slot: number): void {
  logSubs.get(slot)?.forEach((cb) => cb());
  eventSubs.get(slot)?.forEach((cb) => cb());
}

function notifyAll(slot: number): void {
  notifySlot(slot);
  allSubs.forEach((cb) => cb());
}

/** Append a batch for one slot. Called from the Tauri listener — never sets React state. */
export function appendLogBatch(slot: number, entries: readonly LogEntry[]): void {
  if (!entries.length) return;
  const existing = logEntries.get(slot) ?? [];
  const stamped = entries.map((e) => ({ ...e, seq: ++seqCounter }));
  const merged = existing.concat(stamped);
  logEntries.set(slot, merged.length > MAX_LINES ? merged.slice(merged.length - MAX_LINES) : merged);
  notifyAll(slot);
}

export function appendSystemEvent(slot: number, event: SystemEvent): void {
  const existing = eventEntries.get(slot) ?? [];
  const merged = existing.concat({ ...event, seq: ++seqCounter });
  eventEntries.set(slot, merged.length > MAX_EVENTS ? merged.slice(merged.length - MAX_EVENTS) : merged);
  notifyAll(slot);
}

const NO_LOGS: readonly StoredLogEntry[] = [];
const NO_EVENTS: readonly StoredSystemEvent[] = [];

/** Stable empty array when the slot is unknown, so memo() on consumers holds. */
export function getSlotLogs(slot: number): readonly StoredLogEntry[] {
  return logEntries.get(slot) ?? NO_LOGS;
}

export function getSlotEvents(slot: number): readonly StoredSystemEvent[] {
  return eventEntries.get(slot) ?? NO_EVENTS;
}

export function getLogSlotKeys(): number[] {
  return Array.from(logEntries.keys()).sort((a, b) => a - b);
}

/** True when the slot has a buffer at all — including an emptied "cleared" one. */
export function hasLogSlot(slot: number): boolean {
  return logEntries.has(slot);
}

export interface SlotLogSummary {
  lineCount: number;
  firstAlias: string;
}

/**
 * Per-slot counts for the slot switcher.
 *
 * The switcher used to receive the whole `Map<number, LogEntry[]>` and read only
 * `keys()`, `size`, `[0].alias` and `length` — so every 25 ms batch copied up to
 * 5,000 line objects per slot just to render a number.
 */
export function getSlotLogSummaries(): Map<number, SlotLogSummary> {
  const out = new Map<number, SlotLogSummary>();
  for (const [slot, entries] of logEntries) {
    out.set(slot, { lineCount: entries.length, firstAlias: entries[0]?.alias ?? "" });
  }
  return out;
}

export function getTotalLogLines(): number {
  let total = 0;
  for (const entries of logEntries.values()) total += entries.length;
  return total;
}

/** Clear a slot's lines but keep the slot present (the "cleared" empty state). */
export function clearSlotLogs(slot: number): void {
  if (!logEntries.has(slot)) return;
  logEntries.set(slot, []);
  notifyAll(slot);
}

/**
 * Clear every buffer, re-seeding the slots that still have a live engine so the UI
 * keeps showing them as cleared rather than dropping them.
 */
export function clearAllLogs(activeSlots: Iterable<number>): void {
  for (const slot of logEntries.keys()) logEntries.set(slot, []);
  for (const slot of eventEntries.keys()) eventEntries.set(slot, []);
  for (const slot of activeSlots) {
    if (!logEntries.has(slot)) logEntries.set(slot, []);
    if (!eventEntries.has(slot)) eventEntries.set(slot, []);
  }
  allSubs.forEach((cb) => cb());
  logSubs.forEach((set) => set.forEach((cb) => cb()));
  eventSubs.forEach((set) => set.forEach((cb) => cb()));
}

/** Drop a slot entirely — its engine is gone, so its buffer is no longer reachable UI. */
export function releaseSlotLogs(slot: number): void {
  let changed = false;
  if (logEntries.delete(slot)) changed = true;
  if (eventEntries.delete(slot)) changed = true;
  if (changed) notifyAll(slot);
}

/** Full reset (stop-all). */
export function releaseAllLogs(): void {
  if (logEntries.size === 0 && eventEntries.size === 0) return;
  logEntries.clear();
  eventEntries.clear();
  allSubs.forEach((cb) => cb());
  logSubs.forEach((set) => set.forEach((cb) => cb()));
  eventSubs.forEach((set) => set.forEach((cb) => cb()));
}

function addTo<K>(map: Map<K, Set<() => void>>, key: K, cb: () => void): () => void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  const bucket = set;
  bucket.add(cb);
  return () => {
    bucket.delete(cb);
    if (bucket.size === 0) map.delete(key);
  };
}

/** One slot — the STACK tab's per-engine panel. */
export function subscribeSlotLogs(slot: number, cb: () => void): () => void {
  return addTo(logSubs, slot, cb);
}

export function subscribeSlotEvents(slot: number, cb: () => void): () => void {
  return addTo(eventSubs, slot, cb);
}

/** Every slot — the LOGS tab only. Unmounted unless that tab is open. */
export function subscribeAllLogs(cb: () => void): () => void {
  allSubs.add(cb);
  return () => allSubs.delete(cb);
}

/** Per-slot hook: wakes only when this slot's lines or events change. */
export function useSlotLogStore(slot: number): {
  logs: readonly StoredLogEntry[];
  events: readonly StoredSystemEvent[];
} {
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    const unLogs = subscribeSlotLogs(slot, bump);
    const unEvents = subscribeSlotEvents(slot, bump);
    return () => {
      unLogs();
      unEvents();
    };
  }, [slot]);
  return { logs: getSlotLogs(slot), events: getSlotEvents(slot) };
}

/** Global revision for the LOGS tab, which renders every slot. */
export function useLogStoreRevision(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => subscribeAllLogs(() => setRevision((r) => r + 1)), []);
  return revision;
}
