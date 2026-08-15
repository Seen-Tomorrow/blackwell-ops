/**
 * Fusion dual-display + monitor-focus prefs.
 * Primary remains `selectedSlotIdx` (catalog owner). Secondary is pinned or auto.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { StackEntry } from "../lib/types";
import {
  loadFusionDisplayMode,
  loadFusionDualOrient,
  loadFusionSecondarySlotIdx,
  saveFusionDisplayMode,
  saveFusionDualOrient,
  saveFusionSecondarySlotIdx,
  saveMonitorFocusMode,
  type FusionDisplayMode,
  type FusionDualOrient,
} from "../lib/storage";
import { dispatchAppEvent, EVENTS } from "../lib/events";

function isLive(s: StackEntry): boolean {
  return s.status === "RUNNING" || s.status === "LOADING";
}

/** Other live slot for secondary pane — prefer next higher idx, else any other. */
export function autoPickSecondarySlot(
  primary: number | null | undefined,
  stack: StackEntry[],
  pinned: number | null,
): number | null {
  const live = stack.filter(isLive).map((s) => s.idx);
  if (live.length < 2) return null;

  if (pinned != null && pinned >= 0 && pinned !== primary && live.includes(pinned)) {
    return pinned;
  }

  if (primary == null || primary < 0) {
    return live[1] ?? live[0] ?? null;
  }

  const others = live.filter((idx) => idx !== primary).sort((a, b) => a - b);
  return others[0] ?? null;
}

export function useFusionDisplayMode(
  selectedSlotIdx: number | null | undefined,
  stack: StackEntry[],
) {
  const [mode, setModeState] = useState<FusionDisplayMode>(loadFusionDisplayMode);
  const [orient, setOrientState] = useState<FusionDualOrient>(loadFusionDualOrient);
  const [pinnedSecondary, setPinnedSecondaryState] = useState<number | null>(
    loadFusionSecondarySlotIdx,
  );
  const [monitorFocus, setMonitorFocusState] = useState(false);

  const liveCount = useMemo(
    () => stack.filter(isLive).length,
    [stack],
  );

  const secondarySlotIdx = useMemo(
    () => autoPickSecondarySlot(selectedSlotIdx, stack, pinnedSecondary),
    [selectedSlotIdx, stack, pinnedSecondary],
  );

  const dualActive =
    mode === "dual"
    && selectedSlotIdx != null
    && selectedSlotIdx >= 0
    && secondarySlotIdx != null
    && secondarySlotIdx !== selectedSlotIdx
    && liveCount >= 2;

  const setMode = useCallback((next: FusionDisplayMode) => {
    setModeState(next);
    saveFusionDisplayMode(next);
  }, []);

  const toggleDual = useCallback(() => {
    setModeState((prev) => {
      const next: FusionDisplayMode = prev === "dual" ? "single" : "dual";
      saveFusionDisplayMode(next);
      return next;
    });
  }, []);

  const setOrient = useCallback((next: FusionDualOrient) => {
    setOrientState(next);
    saveFusionDualOrient(next);
  }, []);

  const toggleOrient = useCallback(() => {
    setOrientState((prev) => {
      const next: FusionDualOrient = prev === "side" ? "stack" : "side";
      saveFusionDualOrient(next);
      return next;
    });
  }, []);

  const setSecondarySlotIdx = useCallback((slotIdx: number | null) => {
    setPinnedSecondaryState(slotIdx);
    saveFusionSecondarySlotIdx(slotIdx);
  }, []);

  /** Pin secondary; if same as primary, clear pin (auto will pick other). */
  const pinSecondaryOrCycle = useCallback(
    (slotIdx: number) => {
      if (slotIdx === selectedSlotIdx) return;
      setSecondarySlotIdx(pinnedSecondary === slotIdx ? null : slotIdx);
    },
    [selectedSlotIdx, pinnedSecondary, setSecondarySlotIdx],
  );

  const setMonitorFocus = useCallback((on: boolean) => {
    setMonitorFocusState(on);
    saveMonitorFocusMode(on);
    dispatchAppEvent(EVENTS.monitorFocusChanged, { open: on });
  }, []);

  const toggleMonitorFocus = useCallback(() => {
    setMonitorFocusState((prev) => {
      const next = !prev;
      saveMonitorFocusMode(next);
      dispatchAppEvent(EVENTS.monitorFocusChanged, { open: next });
      return next;
    });
  }, []);

  // Drop stale pin when slot dies
  useEffect(() => {
    if (pinnedSecondary == null) return;
    const still = stack.some((s) => s.idx === pinnedSecondary && isLive(s));
    if (!still) {
      setPinnedSecondaryState(null);
      saveFusionSecondarySlotIdx(null);
    }
  }, [stack, pinnedSecondary]);

  // Cross-tree sync (Layout shell attr listens to event; this recovers storage edits)
  useEffect(() => {
    const onFocus = (e: Event) => {
      const open = (e as CustomEvent<{ open?: boolean }>).detail?.open;
      if (typeof open === "boolean") setMonitorFocusState(open);
    };
    window.addEventListener(EVENTS.monitorFocusChanged, onFocus);
    return () => window.removeEventListener(EVENTS.monitorFocusChanged, onFocus);
  }, []);

  return {
    mode,
    setMode,
    toggleDual,
    orient,
    setOrient,
    toggleOrient,
    pinnedSecondary,
    secondarySlotIdx,
    setSecondarySlotIdx,
    pinSecondaryOrCycle,
    dualActive,
    dualArmed: mode === "dual",
    liveCount,
    canDual: liveCount >= 2,
    monitorFocus,
    setMonitorFocus,
    toggleMonitorFocus,
  };
}
