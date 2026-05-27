import React, { createContext, useContext, useState, useCallback, useMemo } from "react";

// ── Constants (single source of truth) ───────────────────────────────
export const NUM_SLOTS = 8;
export const DOCK_SLOT_BUILD = 0;

// ── Widget types ─────────────────────────────────────────────────────
export type DockWidgetType = 'build' | 'telemetry' | 'engine-status' | 'generic';

export interface DockWidgetConfig {
  title: string;
  icon?: string;
  inlineContent: React.ReactNode;
  expandedContent?: React.ReactNode;
  widgetId?: string;
  type?: DockWidgetType;
}

interface DockSlotState {
  occupied: boolean;
  config?: DockWidgetConfig;
  expanded: boolean;
  priority?: number; // lower = higher priority (for ordering)
}

export interface DockCtx {
  slots: DockSlotState[];
  registerWidget: (slotId: number, config: DockWidgetConfig) => void;
  expandSlot: (slotId: number) => void;
  collapseSlot: (slotId: number) => void;
  toggleSlot: (slotId: number) => void;
  clearSlot: (slotId: number) => void;
}

const DockContext = createContext<DockCtx>({
  slots: [],
  registerWidget: () => {},
  expandSlot: () => {},
  collapseSlot: () => {},
  toggleSlot: () => {},
  clearSlot: () => {},
});

// ── State update helper (eliminates copy-paste immutable patterns) ───
function updateSlot(
  slots: DockSlotState[],
  slotId: number,
  updater: (slot: DockSlotState) => DockSlotState
): DockSlotState[] {
  if (slotId < 0 || slotId >= NUM_SLOTS) return slots;
  const next = [...slots];
  next[slotId] = updater(next[slotId]);
  return next;
}

function emptySlots(): DockSlotState[] {
  return Array.from({ length: NUM_SLOTS }, () => ({ occupied: false, expanded: false }));
}

export const DockProvider: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const [slots, setSlots] = useState<DockSlotState[]>(emptySlots);

  const registerWidget = useCallback((slotId: number, config: DockWidgetConfig) => {
    if (slotId < 0 || slotId >= NUM_SLOTS) return;
    setSlots(prev =>
      updateSlot(prev, slotId, s => {
        // Allow re-registration for the same widgetId (progress updates)
        if (s.occupied && s.config?.widgetId !== config.widgetId) return s;
        return { occupied: true, config, expanded: false };
      })
    );
  }, []);

  const expandSlot = useCallback((slotId: number) => {
    if (slotId < 0 || slotId >= NUM_SLOTS) return;
    setSlots(prev =>
      prev.map((s, i) => ({ ...s, expanded: i === slotId }))
    );
  }, []);

  const collapseSlot = useCallback((slotId: number) => {
    if (slotId < 0 || slotId >= NUM_SLOTS) return;
    setSlots(prev =>
      updateSlot(prev, slotId, s => ({ ...s, expanded: false }))
    );
  }, []);

  const toggleSlot = useCallback((slotId: number) => {
    if (slotId < 0 || slotId >= NUM_SLOTS) return;
    setSlots(prev => {
      if (!prev[slotId].occupied) return prev;
      return prev.map((s, i) =>
        i === slotId
          ? { ...s, expanded: !s.expanded }
          : { ...s, expanded: false }
      );
    });
  }, []);

  const clearSlot = useCallback((slotId: number) => {
    if (slotId < 0 || slotId >= NUM_SLOTS) return;
    setSlots(prev =>
      updateSlot(prev, slotId, () => ({ occupied: false, expanded: false }))
    );
  }, []);

  const ctxValue = useMemo(() => ({
    slots,
    registerWidget,
    expandSlot,
    collapseSlot,
    toggleSlot,
    clearSlot,
  }), [slots, registerWidget, expandSlot, collapseSlot, toggleSlot, clearSlot]);

  return (
    <DockContext.Provider value={ctxValue}>
      {children}
      <DockExpandedPanel />
    </DockContext.Provider>
  );
};

function DockExpandedPanel() {
  const { slots, collapseSlot } = useContext(DockContext);
  const expandedIdx = slots.findIndex(s => s.expanded && s.occupied);

  if (expandedIdx === -1) return null;

  const widget = slots[expandedIdx].config!;

  return (
    <div
      className="fixed left-0 right-0 z-[90] flex justify-center px-6 pointer-events-none"
      style={{
        bottom: 'var(--dock-panel-bottom, 32px)',
      }}
    >
      <div
        className="w-full max-w-[1100px] bg-stealth-panel border border-stealth-border rounded-sm shadow-2xl flex flex-col overflow-hidden pointer-events-auto animate-slide-up"
        style={{
          height: 'var(--dock-panel-height, 75vh)',
        }}
      >
        {/* Header bar */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-stealth-border flex-shrink-0">
          <div className="flex items-center gap-2">
            {widget.icon && <span>{widget.icon}</span>}
            <span className="text-[10px] font-mono text-white/80 tracking-wider">{widget.title}</span>
          </div>
          <button
            onClick={() => collapseSlot(expandedIdx)}
            className="text-stealth-muted hover:text-white transition-colors text-sm leading-none"
          >
            &times;
          </button>
        </div>

        {/* Content area */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {widget.expandedContent || widget.inlineContent}
        </div>
      </div>
    </div>
  );
}

export function useDock() {
  return useContext(DockContext);
}