import { useMemo, useState } from "react";
import type { LogEntry, StackEntry } from "../lib/types";
import { getActiveStackSlots, isActiveEngineSlot } from "../lib/engineStack";
import TabPageHeader from "./TabPageHeader";

export type ActiveLogSlot = number | "all";

interface EngineLogsSwitcherProps {
  activeLogSlot: ActiveLogSlot;
  onActiveLogSlotChange: (slot: ActiveLogSlot) => void;
  logs: Map<number, LogEntry[]>;
  stack: StackEntry[];
  logSearchBySlot: Record<number, string>;
  onSlotLogSearchChange: (slot: number, query: string) => void;
  onClearSlotLogSearch: (slot: number) => void;
  onClearSlotLogs: (slot: number) => void;
  onClearAllLogs: () => void;
  ansiEnabled: boolean;
  onAnsiEnabledChange: (enabled: boolean) => void;
}

interface SlotMeta {
  slot: number;
  label: string;
  lineCount: number;
  status?: string;
  isRunning: boolean;
  hasSearch: boolean;
}

export default function EngineLogsSwitcher({
  activeLogSlot,
  onActiveLogSlotChange,
  logs,
  stack,
  logSearchBySlot,
  onSlotLogSearchChange,
  onClearSlotLogSearch,
  onClearSlotLogs,
  onClearAllLogs,
  ansiEnabled,
  onAnsiEnabledChange,
}: EngineLogsSwitcherProps) {
  const [slotFilter, setSlotFilter] = useState("");

  const slots = useMemo<SlotMeta[]>(() => {
    const slotIds = new Set<number>();
    for (const slot of logs.keys()) slotIds.add(slot);
    for (const entry of stack) {
      if (isActiveEngineSlot(entry)) slotIds.add(entry.idx);
    }

    return Array.from(slotIds)
      .sort((a, b) => a - b)
      .map((slot) => {
        const entries = logs.get(slot) ?? [];
        const stackEntry = stack.find((s) => s.idx === slot);
        const status = stackEntry?.status;
        return {
          slot,
          label: stackEntry?.alias || entries[0]?.alias || `SLOT ${slot + 1}`,
          lineCount: entries.length,
          status,
          isRunning: status === "RUNNING" || status === "LOADING",
          hasSearch: Boolean(logSearchBySlot[slot]?.trim()),
        };
      });
  }, [logs, stack, logSearchBySlot]);

  const filterNorm = slotFilter.trim().toLowerCase();

  const filteredSlots = useMemo(() => {
    if (!filterNorm) return slots;
    return slots.filter((s) => {
      const hay = `${s.slot + 1} ${s.label} ${s.status ?? ""}`.toLowerCase();
      return hay.includes(filterNorm);
    });
  }, [slots, filterNorm]);

  const activeEngineCount = getActiveStackSlots(stack).length;
  const activeSlotMeta = typeof activeLogSlot === "number"
    ? slots.find((s) => s.slot === activeLogSlot)
    : null;

  return (
    <div className="engine-logs-switcher flex-shrink-0">
      <TabPageHeader
        title="ENGINE LOGS"
        meta={(
          <span className="engine-logs-switcher__count">
            {slots.length} log slot{slots.length === 1 ? "" : "s"}
            {activeEngineCount > 0 ? ` · ${activeEngineCount} active` : ""}
          </span>
        )}
      />

      <div className="engine-logs-switcher__controls-row">
        <button
          type="button"
          onClick={() => onAnsiEnabledChange(!ansiEnabled)}
          className={`engine-logs-switcher__ansi-toggle${ansiEnabled ? " engine-logs-switcher__ansi-toggle--on" : ""}`}
          title={ansiEnabled ? "ANSI colors on — click for plain text" : "Plain text — click for ANSI colors"}
        >
          ANSI {ansiEnabled ? "ON" : "OFF"}
        </button>
        <input
          type="text"
          value={slotFilter}
          onChange={(e) => setSlotFilter(e.target.value)}
          placeholder="Filter slots…"
          className="engine-logs-switcher__filter theme-input"
        />
        <button
          type="button"
          onClick={onClearAllLogs}
          disabled={logs.size === 0 && activeEngineCount === 0}
          className="engine-logs-switcher__clear-all"
        >
          CLEAR ALL
        </button>
      </div>

      <div className="engine-logs-switcher__slots eink-scrollbar">
        <button
          type="button"
          onClick={() => onActiveLogSlotChange("all")}
          className={`engine-logs-slot-chip${activeLogSlot === "all" ? " engine-logs-slot-chip--active" : ""}`}
        >
          <span className="engine-logs-slot-chip__label">ALL</span>
          <span className="engine-logs-slot-chip__meta">{slots.length}</span>
        </button>

        {filteredSlots.map((meta) => (
          <div
            key={meta.slot}
            className={`engine-logs-slot-chip-group${activeLogSlot === meta.slot ? " engine-logs-slot-chip-group--active" : ""}${meta.isRunning ? " engine-logs-slot-chip-group--live" : ""}`}
          >
            <button
              type="button"
              className="engine-logs-slot-chip__clear"
              title={`Clear log buffer for ${meta.label}`}
              onClick={() => onClearSlotLogs(meta.slot)}
            >
              CLR
            </button>
            <button
              type="button"
              title={`${meta.label} — ${meta.lineCount} lines`}
              onClick={() => onActiveLogSlotChange(meta.slot)}
              className="engine-logs-slot-chip"
            >
              <span className="engine-logs-slot-chip__label">{meta.label}</span>
              <span className="engine-logs-slot-chip__meta">{meta.lineCount}</span>
              {meta.hasSearch ? (
                <span className="engine-logs-slot-chip__search" title="Search filter active" aria-hidden="true">
                  ⌕
                </span>
              ) : null}
            </button>
          </div>
        ))}

        {filterNorm && filteredSlots.length === 0 ? (
          <span className="engine-logs-switcher__empty-filter">No slots match filter</span>
        ) : null}
      </div>

      {typeof activeLogSlot === "number" && activeSlotMeta ? (
        <div className="engine-logs-switcher__toolbar">
          <span className="engine-logs-switcher__search-label">SEARCH IN LOG</span>
          <input
            type="text"
            value={logSearchBySlot[activeLogSlot] ?? ""}
            onChange={(e) => onSlotLogSearchChange(activeLogSlot, e.target.value)}
            placeholder="error, timeout | cuda"
            className="engine-logs-switcher__search theme-input"
          />
          <button
            type="button"
            title="Reset search highlight"
            onClick={() => onClearSlotLogSearch(activeLogSlot)}
            disabled={!logSearchBySlot[activeLogSlot]?.trim()}
            className="engine-logs-switcher__reset-search"
          >
            RESET SEARCH
          </button>
        </div>
      ) : null}
    </div>
  );
}