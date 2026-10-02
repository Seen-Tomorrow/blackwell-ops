/**
 * The LOGS tab.
 *
 * Extracted from `App` so that engine log batches — which arrive on the same 25 ms
 * tick as telemetry and always carry new lines — re-render this panel instead of the
 * whole shell. It subscribes to `logSlotStore` directly; `App` holds no log state.
 *
 * Mounted only while the LOGS tab is open, so a 40 Hz subscription here costs one
 * panel rather than Layout, ModelCatalog, EngineGpuForecast, VramBadge and
 * EngineConfigPanel.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { StackEntry } from "../lib/types";
import { getActiveStackSlots, isActiveEngineSlot } from "../lib/engineStack";
import {
  loadLogSearchBySlot,
  saveLogSearchBySlot,
  loadLogsAnsiEnabled,
  saveLogsAnsiEnabled,
} from "../lib/storage";
import {
  clearAllLogs,
  clearSlotLogs,
  getLogSlotKeys,
  getSlotLogSummaries,
  getSlotLogs,
  getTotalLogLines,
  hasLogSlot,
  useLogStoreRevision,
} from "../lib/logSlotStore";

const LogLineText = lazy(() => import("./LogLineText"));
const EngineLogsSwitcher = lazy(() => import("./EngineLogsSwitcher"));

function TabFallback() {
  return <div className="flex-1 min-h-0" aria-hidden />;
}

/** Render window per slot — the store keeps a longer buffer for scroll-back. */
const RENDER_WINDOW = 500;

/**
 * Selected slot, kept at module scope so it survives switching tabs and coming back.
 * Mirrors the App state it replaces: session-only, not persisted across restarts.
 * LogsPanel unmounts when the LOGS tab closes, so no hook could hold this.
 */
let lastActiveLogSlot: number | "all" = "all";

export default function LogsPanel({ stack }: { stack: StackEntry[] }) {
  const revision = useLogStoreRevision();

  const [activeLogSlot, setActiveLogSlot] = useState<number | "all">(lastActiveLogSlot);
  const [logSearchBySlot, setLogSearchBySlot] = useState<Record<number, string>>(() => loadLogSearchBySlot());
  const [logsAnsiEnabled, setLogsAnsiEnabled] = useState(() => loadLogsAnsiEnabled());

  const logsScrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const logSearchHitIndexRef = useRef(0);

  useEffect(() => {
    lastActiveLogSlot = activeLogSlot;
  }, [activeLogSlot]);

  const clearSlotLogSearch = useCallback((slot: number) => {
    logSearchHitIndexRef.current = 0;
    const persisted = loadLogSearchBySlot();
    if (!(slot in persisted)) return;
    delete persisted[slot];
    saveLogSearchBySlot(persisted);
    setLogSearchBySlot({ ...persisted });
  }, []);

  const setSlotLogSearch = useCallback((slot: number, query: string) => {
    logSearchHitIndexRef.current = 0;
    const persisted = loadLogSearchBySlot();
    if (!query.trim()) {
      delete persisted[slot];
    } else {
      persisted[slot] = query;
    }
    saveLogSearchBySlot(persisted);
    setLogSearchBySlot({ ...persisted });
  }, []);

  const scrollToLogSearchHit = useCallback((hitIndex: number, behavior: ScrollBehavior = "smooth") => {
    const root = logsScrollRef.current;
    if (!root) return 0;
    const hits = root.querySelectorAll<HTMLElement>(".log-search-hit");
    if (hits.length === 0) return 0;
    const idx = ((hitIndex % hits.length) + hits.length) % hits.length;
    hits.forEach((el, i) => {
      el.classList.toggle("log-search-hit--current", i === idx);
    });
    hits[idx]?.scrollIntoView({ block: "center", behavior });
    return hits.length;
  }, []);

  const stepLogSearchHit = useCallback(() => {
    const count = scrollToLogSearchHit(logSearchHitIndexRef.current + 1);
    if (count > 0) {
      logSearchHitIndexRef.current = (logSearchHitIndexRef.current + 1) % count;
    }
  }, [scrollToLogSearchHit]);

  const handleClearSlotLogs = useCallback((slot: number) => {
    clearSlotLogs(slot);
    clearSlotLogSearch(slot);
  }, [clearSlotLogSearch]);

  const handleClearAllLogs = useCallback(() => {
    clearAllLogs(stack.filter(isActiveEngineSlot).map((s) => s.idx));
    setLogSearchBySlot({});
    saveLogSearchBySlot({});
  }, [stack]);

  const handleLogsScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    autoScrollRef.current = distFromBottom < 80;
  }, []);

  const slotSummaries = useMemo(() => getSlotLogSummaries(), [revision]);

  const dropSlotSearchEntries = useCallback((slots: number[]) => {
    const persisted = loadLogSearchBySlot();
    let touched = false;
    for (const s of slots) {
      if (s in persisted) {
        delete persisted[s];
        touched = true;
      }
    }
    if (!touched) return;
    saveLogSearchBySlot(persisted);
    setLogSearchBySlot((prev) => {
      const next = { ...prev };
      for (const s of slots) delete next[s];
      return next;
    });
  }, []);

  // The old App reducer auto-focused a slot the first time it produced output. App no
  // longer owns that state, so the behaviour is reproduced from the slot keys seen so
  // far — seeded on mount so opening the tab does not jump away from ALL.
  const seenSlotsRef = useRef<Set<number> | null>(null);
  useEffect(() => {
    const keys = getLogSlotKeys();
    if (seenSlotsRef.current === null) {
      seenSlotsRef.current = new Set(keys);
      return;
    }
    const seen = seenSlotsRef.current;
    const live = new Set(keys);
    const fresh = keys.find((k) => !seen.has(k));
    const gone = [...seen].filter((k) => !live.has(k));
    seenSlotsRef.current = live;
    if (gone.length > 0) {
      // A released slot must not keep its filter: restarting an engine on the same
      // index would otherwise reopen this panel with a search still applied to it.
      dropSlotSearchEntries(gone);
      setActiveLogSlot((prev) =>
        typeof prev === "number" && gone.includes(prev) ? "all" : prev,
      );
    }
    if (fresh !== undefined) setActiveLogSlot(fresh);
  }, [revision, dropSlotSearchEntries]);

  const slotKeys =
    activeLogSlot === "all"
      ? getLogSlotKeys()
      : hasLogSlot(activeLogSlot)
        ? [activeLogSlot]
        : [];

  /** Windowed lines per rendered slot, recomputed only when the store changes. */
  const flatLogs = useMemo(() => {
    const result = new Map<number, Array<{ text: string; alias: string; seq: number }>>();
    for (const slot of slotKeys) {
      result.set(
        slot,
        getSlotLogs(slot)
          .slice(-RENDER_WINDOW)
          .map((e) => ({ text: e.text, alias: e.alias, seq: e.seq })),
      );
    }
    return result;
  }, [revision, activeLogSlot]);

  const totalLogLines = getTotalLogLines();
  const hasAnySlot = slotSummaries.size > 0;

  const activeLogSearchQuery = useMemo(() => {
    if (typeof activeLogSlot !== "number") return "";
    return logSearchBySlot[activeLogSlot]?.trim() ?? "";
  }, [activeLogSlot, logSearchBySlot]);

  // Auto-scroll to the bottom on new lines, unless the user scrolled up.
  const prevLineCountRef = useRef(0);
  useEffect(() => {
    const root = logsScrollRef.current;
    if (!root) return;
    if (totalLogLines > prevLineCountRef.current && autoScrollRef.current) {
      root.scrollTo({ top: root.scrollHeight });
    }
    prevLineCountRef.current = totalLogLines;
  }, [totalLogLines]);

  // Re-anchor search highlights when the query changes.
  useEffect(() => {
    logSearchHitIndexRef.current = 0;
    if (!activeLogSearchQuery) {
      logsScrollRef.current
        ?.querySelectorAll(".log-search-hit--current")
        .forEach((el) => el.classList.remove("log-search-hit--current"));
      return;
    }
    autoScrollRef.current = false;
    const frame = requestAnimationFrame(() => scrollToLogSearchHit(0, "auto"));
    return () => cancelAnimationFrame(frame);
  }, [activeLogSearchQuery, activeLogSlot, scrollToLogSearchHit]);

  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden" data-engine-logs>
      <Suspense fallback={<TabFallback />}>
        <EngineLogsSwitcher
          activeLogSlot={activeLogSlot}
          onActiveLogSlotChange={setActiveLogSlot}
          slotSummaries={slotSummaries}
          stack={stack}
          logSearchBySlot={logSearchBySlot}
          onSlotLogSearchChange={setSlotLogSearch}
          onClearSlotLogSearch={clearSlotLogSearch}
          onLogSearchStep={stepLogSearchHit}
          onClearSlotLogs={handleClearSlotLogs}
          onClearAllLogs={handleClearAllLogs}
          ansiEnabled={logsAnsiEnabled}
          onAnsiEnabledChange={(enabled) => {
            setLogsAnsiEnabled(enabled);
            saveLogsAnsiEnabled(enabled);
          }}
        />
      </Suspense>
      <div
        ref={logsScrollRef}
        className="engine-logs-scroll theme-surface-inset flex-1 overflow-x-hidden overflow-y-auto rounded-sm p-3 min-h-0 mx-4 mb-4"
        onScroll={handleLogsScroll}
      >
        {!hasAnySlot && getActiveStackSlots(stack).length === 0 ? (
          <p className="shell-log-empty type-body font-mono italic">NO LOGS YET — LAUNCH AN ENGINE TO SEE OUTPUT</p>
        ) : totalLogLines === 0 ? (
          <p className="shell-log-empty type-body font-mono italic">LOG BUFFER CLEARED — WAITING FOR OUTPUT</p>
        ) : slotKeys.length === 0 ? (
          <p className="shell-log-empty type-body font-mono italic">NO LOGS FOR SELECTED SLOT</p>
        ) : (
          slotKeys.map((slot) => {
            const entries = flatLogs.get(slot) ?? [];
            const stackEntry = stack.find((s) => s.idx === slot);
            const alias = stackEntry?.alias || entries[0]?.alias || `SLOT ${slot}`;
            const slotQuery = logSearchBySlot[slot] ?? "";
            const lineQuery =
              activeLogSlot === "all" ? slotQuery : logSearchBySlot[activeLogSlot as number] ?? "";
            return (
              <div key={`slot-${slot}`} className="space-y-0.5">
                {activeLogSlot === "all" && (
                  <div className="mb-2 mt-2 first:mt-0">
                    <div className="shell-log-header type-body font-mono border-b pb-1">
                      {alias} <span className="shell-log-count">({entries.length} lines)</span>
                    </div>
                  </div>
                )}
                {entries.map((entry) => (
                  <p
                    // Keyed on the store's monotonic seq, not the index: once a slot
                    // passes the render window the slice slides from the front, so
                    // index keys stop identifying lines and every line in the window
                    // re-ran ANSI conversion on every batch.
                    key={`${slot}:${entry.seq}`}
                    className="shell-log-line type-body font-mono leading-relaxed break-all"
                  >
                    {activeLogSlot === "all" && <span className="shell-log-alias">[{entry.alias}] </span>}
                    <Suspense fallback={<span>{entry.text}</span>}>
                      <LogLineText
                        text={entry.text}
                        highlightQuery={lineQuery}
                        ansiEnabled={logsAnsiEnabled}
                      />
                    </Suspense>
                  </p>
                ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
