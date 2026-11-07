import { useMemo, useState } from "react";

export type ActiveLogSlot = number | "all";

export interface LogSlotMeta {
  slot: number;
  label: string;
  lineCount: number;
  status?: string;
  isRunning: boolean;
  hasSearch: boolean;
}

interface EngineLogsSwitcherProps {
  /** Slot metadata, ordered by slot index. */
  slots: LogSlotMeta[];
  activeLogSlot: ActiveLogSlot;
  onActiveLogSlotChange: (slot: ActiveLogSlot) => void;
  onClearSlotLogs: (slot: number) => void;
  onClearAllLogs: () => void;
  ansiEnabled: boolean;
  onAnsiEnabledChange: (enabled: boolean) => void;
}

/**
 * LOGS rail — one row per engine log slot.
 *
 * A wrapping chip grid stops working past a handful of slots (64 engines filled
 * several rows and buried the log itself). A vertical, filterable list scales:
 * fixed-width names, line counts, live dots, and CLR on the hovered row.
 */
export default function EngineLogsSwitcher({
  slots,
  activeLogSlot,
  onActiveLogSlotChange,
  onClearSlotLogs,
  onClearAllLogs,
  ansiEnabled,
  onAnsiEnabledChange,
}: EngineLogsSwitcherProps) {
  const [slotFilter, setSlotFilter] = useState("");
  const filterNorm = slotFilter.trim().toLowerCase();

  const filteredSlots = useMemo(() => {
    if (!filterNorm) return slots;
    return slots.filter((s) => {
      const hay = `${s.slot + 1} ${s.label} ${s.status ?? ""}`.toLowerCase();
      return hay.includes(filterNorm);
    });
  }, [slots, filterNorm]);

  return (
    <aside className="engine-logs-rail" aria-label="Engine log slots">
      <div className="engine-logs-rail__head">
        <span className="engine-logs-rail__title">LOG SLOTS</span>
        <span className="engine-logs-rail__count">{slots.length}</span>
      </div>

      <div className="engine-logs-rail__filter-wrap">
        <input
          type="text"
          value={slotFilter}
          onChange={(e) => setSlotFilter(e.target.value)}
          placeholder="Filter slots…"
          className="engine-logs-rail__filter theme-input"
          aria-label="Filter log slots"
        />
      </div>

      {/* ALL stays pinned above the scroll; it is the "everything" escape hatch. */}
      <button
        type="button"
        onClick={() => onActiveLogSlotChange("all")}
        className={`engine-logs-rail__row engine-logs-rail__row--all${
          activeLogSlot === "all" ? " is-active" : ""
        }`}
        title="All slots interleaved"
      >
        <span className="engine-logs-rail__dot" aria-hidden />
        <span className="engine-logs-rail__pick">
          <span className="engine-logs-rail__name">ALL LOGS</span>
          <span className="engine-logs-rail__lines">{slots.length}</span>
        </span>
      </button>

      <div className="engine-logs-rail__list eink-scrollbar">
        {filteredSlots.map((meta) => (
          <div
            key={meta.slot}
            className={`engine-logs-rail__row${activeLogSlot === meta.slot ? " is-active" : ""}`}
          >
            <button
              type="button"
              className="engine-logs-rail__pick"
              onClick={() => onActiveLogSlotChange(meta.slot)}
              title={`${meta.label} — ${meta.lineCount} lines${meta.status ? ` · ${meta.status}` : ""}`}
            >
              <span
                className={`engine-logs-rail__dot${meta.isRunning ? " is-live" : ""}`}
                aria-hidden
              />
              <span className="engine-logs-rail__name">{meta.label}</span>
              {meta.hasSearch ? (
                <span className="engine-logs-rail__search" title="Search filter active" aria-hidden>
                  ⌕
                </span>
              ) : null}
              <span className="engine-logs-rail__lines">{meta.lineCount}</span>
            </button>
            <button
              type="button"
              className="engine-logs-rail__clear"
              title={`Clear log buffer for ${meta.label}`}
              onClick={() => onClearSlotLogs(meta.slot)}
            >
              CLR
            </button>
          </div>
        ))}

        {filterNorm && filteredSlots.length === 0 ? (
          <span className="engine-logs-rail__empty">No slots match filter</span>
        ) : null}
      </div>

      <div className="engine-logs-rail__foot">
        <button
          type="button"
          onClick={() => onAnsiEnabledChange(!ansiEnabled)}
          className={`engine-logs-switcher__ansi-toggle${ansiEnabled ? " engine-logs-switcher__ansi-toggle--on" : ""}`}
          title={ansiEnabled ? "ANSI colors on — click for plain text" : "Plain text — click for ANSI colors"}
        >
          ANSI {ansiEnabled ? "ON" : "OFF"}
        </button>
        <button
          type="button"
          onClick={onClearAllLogs}
          disabled={slots.length === 0}
          className="engine-logs-switcher__clear-all"
        >
          CLEAR ALL
        </button>
      </div>
    </aside>
  );
}
