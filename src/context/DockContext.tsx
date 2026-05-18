import React, { createContext, useContext, useState, useCallback, useMemo } from "react";

export interface DockWidgetConfig {
  title: string;
  icon?: string;
  inlineContent: React.ReactNode;
  expandedContent?: React.ReactNode;
}

interface DockSlotState {
  occupied: boolean;
  config?: DockWidgetConfig;
  expanded: boolean;
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

const NUM_SLOTS = 8;

function emptySlots(): DockSlotState[] {
  return Array.from({ length: NUM_SLOTS }, () => ({ occupied: false, expanded: false }));
}

export const DockProvider: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const [slots, setSlots] = useState<DockSlotState[]>(emptySlots);

  const registerWidget = useCallback((slotId: number, config: DockWidgetConfig) => {
    if (slotId < 0 || slotId >= NUM_SLOTS) return;
    setSlots(prev => {
      const next = [...prev];
      next[slotId] = { occupied: true, config, expanded: false };
      return next;
    });
  }, []);

  const expandSlot = useCallback((slotId: number) => {
    if (slotId < 0 || slotId >= NUM_SLOTS) return;
    setSlots(prev => {
      const next = [...prev];
      // Auto-collapse all other slots
      for (let i = 0; i < NUM_SLOTS; i++) {
        if (i === slotId) {
          next[i] = { ...next[i], expanded: true };
        } else {
          next[i] = { ...next[i], expanded: false };
        }
      }
      return next;
    });
  }, []);

  const collapseSlot = useCallback((slotId: number) => {
    if (slotId < 0 || slotId >= NUM_SLOTS) return;
    setSlots(prev => {
      const next = [...prev];
      next[slotId] = { ...next[slotId], expanded: false };
      return next;
    });
  }, []);

  const toggleSlot = useCallback((slotId: number) => {
    if (slotId < 0 || slotId >= NUM_SLOTS) return;
    setSlots(prev => {
      const target = prev[slotId];
      if (!target.occupied) return prev;
      const next = [...prev];
      for (let i = 0; i < NUM_SLOTS; i++) {
        if (i === slotId) {
          next[i] = { ...next[i], expanded: !next[i].expanded };
        } else {
          next[i] = { ...next[i], expanded: false };
        }
      }
      return next;
    });
  }, []);

  const clearSlot = useCallback((slotId: number) => {
    if (slotId < 0 || slotId >= NUM_SLOTS) return;
    setSlots(prev => {
      const next = [...prev];
      next[slotId] = { occupied: false, expanded: false };
      return next;
    });
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
    <div className="fixed bottom-[32px] left-0 right-0 z-[90] flex justify-center px-6 pointer-events-none">
      <div className="w-full max-w-[1100px] h-[75vh] bg-stealth-panel border border-stealth-border rounded-sm shadow-2xl flex flex-col overflow-hidden pointer-events-auto animate-slide-up">
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
