import { useEffect, useState } from "react";
import type { FusionUpdate } from "./types";

/** Shallow compare hero + progress fields — skip churn when IPC payload unchanged. */
export function fusionPayloadEqual(a: FusionUpdate, b: FusionUpdate): boolean {
  return (
    a.phase === b.phase
    && a.engine_state === b.engine_state
    && a.prefillProgress === b.prefillProgress
    && a.prefillTokens === b.prefillTokens
    && a.prefillTokensTotal === b.prefillTokensTotal
    && a.prefillTpsSession === b.prefillTpsSession
    && (a.prefillTpsInstant ?? 0) === (b.prefillTpsInstant ?? 0)
    && a.prefillTpsMetrics === b.prefillTpsMetrics
    && a.genTps === b.genTps
    && (a.genTpsSession ?? 0) === (b.genTpsSession ?? 0)
    && (a.genTpsInstant ?? 0) === (b.genTpsInstant ?? 0)
    && a.genTokensPerRequestSlots === b.genTokensPerRequestSlots
    && a.genTokensPerSession === b.genTokensPerSession
    && a.ctxUsedSession === b.ctxUsedSession
    && a.ctxFillPct === b.ctxFillPct
    && (a.ctxPerSlot ?? 0) === (b.ctxPerSlot ?? 0)
    && a.requestElapsedMs === b.requestElapsedMs
    && (a.requestClosed ?? false) === (b.requestClosed ?? false)
    && (a.ttftMs ?? null) === (b.ttftMs ?? null)
    && (a.prefillMs ?? null) === (b.prefillMs ?? null)
    && (a.decodeTtftMs ?? null) === (b.decodeTtftMs ?? null)
    && (a.logPrefillProgress ?? 0) === (b.logPrefillProgress ?? 0)
    && (a.logPrefillTps ?? 0) === (b.logPrefillTps ?? 0)
    && (a.logPromptTokens ?? 0) === (b.logPromptTokens ?? 0)
    && (a.logGenTps ?? 0) === (b.logGenTps ?? 0)
    && a.logPhase === b.logPhase
    && (a.specDraftAcceptRate ?? 0) === (b.specDraftAcceptRate ?? 0)
    && (a.specDraftAccepted ?? 0) === (b.specDraftAccepted ?? 0)
    && (a.specDraftGenerated ?? 0) === (b.specDraftGenerated ?? 0)
    && a.slotCtx.length === b.slotCtx.length
    && a.slotCtx.every((s, i) => {
      const t = b.slotCtx[i];
      return (
        t != null
        && s.id === t.id
        && s.sessionNDecoded === t.sessionNDecoded
        && s.n_decoded === t.n_decoded
        && s.is_processing === t.is_processing
        && s.promptTokensProcessed === t.promptTokensProcessed
        && s.promptTokensCache === t.promptTokensCache
        && (s.nCtxSlot ?? 0) === (t.nCtxSlot ?? 0)
      );
    })
  );
}

const slots = new Map<number, FusionUpdate>();
const slotSubs = new Map<number, Set<() => void>>();
const globalSubs = new Set<() => void>();
let liveSlots = new Set<number>();
let globalNotifyTimer: ReturnType<typeof setTimeout> | null = null;

const GLOBAL_NOTIFY_MS = 250;

function notifySlot(slotIdx: number): void {
  slotSubs.get(slotIdx)?.forEach((cb) => cb());
}

function notifyGlobalSoon(): void {
  if (globalNotifyTimer) return;
  globalNotifyTimer = setTimeout(() => {
    globalNotifyTimer = null;
    globalSubs.forEach((cb) => cb());
  }, GLOBAL_NOTIFY_MS);
}

/** Sync committed RUNNING/LOADING slots — drops stale entries when engines stop. */
export function setFusionLiveSlots(indices: Iterable<number>): void {
  liveSlots = new Set(indices);
  let pruned = false;
  for (const key of slots.keys()) {
    if (!liveSlots.has(key)) {
      slots.delete(key);
      notifySlot(key);
      pruned = true;
    }
  }
  if (pruned) notifyGlobalSoon();
}

export function applyFusionUpdate(update: FusionUpdate): boolean {
  if (!liveSlots.has(update.slotIdx)) return false;
  const prev = slots.get(update.slotIdx);
  if (prev && fusionPayloadEqual(prev, update)) return false;
  slots.set(update.slotIdx, update);
  notifySlot(update.slotIdx);
  notifyGlobalSoon();
  return true;
}

export function clearFusionSlot(slotIdx: number): void {
  if (!slots.delete(slotIdx)) return;
  notifySlot(slotIdx);
  notifyGlobalSoon();
}

export function clearAllFusionSlots(): void {
  if (slots.size === 0) return;
  const keys = [...slots.keys()];
  slots.clear();
  keys.forEach((idx) => notifySlot(idx));
  globalSubs.forEach((cb) => cb());
}

export function getFusionSlot(slotIdx: number): FusionUpdate | null {
  return slots.get(slotIdx) ?? null;
}

export function getAllFusionSlots(): FusionUpdate[] {
  return Array.from(slots.values());
}

export function subscribeFusionSlot(slotIdx: number, cb: () => void): () => void {
  let set = slotSubs.get(slotIdx);
  if (!set) {
    set = new Set();
    slotSubs.set(slotIdx, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
    if (set && set.size === 0) slotSubs.delete(slotIdx);
  };
}

export function subscribeFusionGlobal(cb: () => void): () => void {
  globalSubs.add(cb);
  return () => globalSubs.delete(cb);
}

/** Only FusionOverlay / per-slot panels — re-renders on that slot's fusion ticks. */
export function useFusionSlot(slotIdx: number | null | undefined): FusionUpdate | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (slotIdx == null || slotIdx < 0) return;
    return subscribeFusionSlot(slotIdx, () => setTick((t) => t + 1));
  }, [slotIdx]);
  if (slotIdx == null || slotIdx < 0) return null;
  return getFusionSlot(slotIdx);
}

/** Throttled — telemetry lab / legacy getEngine consumers. */
export function useFusionStoreRevision(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => subscribeFusionGlobal(() => setRevision((r) => r + 1)), []);
  return revision;
}