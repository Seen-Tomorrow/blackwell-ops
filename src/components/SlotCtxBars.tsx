import type { SlotCtxInfo } from "../lib/types";

interface SlotCtxBarsProps {
  slotCtx: SlotCtxInfo[];
  ctxTotal: number;
  parallel: number;
  unifiedKv: boolean;
}

function formatTokenCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.floor(n / 1000)}K`;
  return n.toString();
}

const outlineChip =
  "ctx-bar-capacity-chip text-[6px] font-mono tracking-wider px-1 py-0.5 rounded-sm border bg-transparent";

const sharedPoolChip =
  "ctx-shared-pool-chip text-[6px] font-mono tracking-wider px-1 py-0.5 rounded-sm border bg-transparent w-full text-center block";

const BASELINE_SLOTS = 4;
const inactiveBarStyle = { flex: "1 1 0%" } as const;

export default function SlotCtxBars({ slotCtx, ctxTotal, parallel, unifiedKv }: SlotCtxBarsProps) {
  const numBars = Math.max(1, parallel || 1);
  const isSingleSlot = numBars === 1;
  // Partitioned: each slot owns ctx/parallel. Unified: all slots share one ctx-sized pool.
  const barCapacity = unifiedKv ? ctxTotal : Math.floor(ctxTotal / numBars);
  /** Flex units per bar — 4-slot baseline: 1→4 wide, 2→2 wide each, 4→1 wide each */
  const barFlexUnits = BASELINE_SLOTS / numBars;
  const showSharedSpan = unifiedKv && numBars > 1;

  const slots: Array<{
    index: number;
    sessionNDecoded: number;
    isProcessing: boolean;
    pct: number;
    isActive: boolean;
  }> = Array.from({ length: BASELINE_SLOTS }, (_, i) => {
    const slot = slotCtx.find((s) => s.id === i);
    const isActive = i < numBars;

    if (slot) {
      const live = (slot.promptTokensCache || 0) + (slot.promptTokensProcessed || 0) + (slot.n_decoded || 0);
      // Short agent turns reset live fields before session KV — never flash 0% when session still full.
      const base = Math.max(live, slot.sessionNDecoded ?? 0);
      const pct = barCapacity > 0 ? Math.min((base / barCapacity) * 100, 100) : 0;
      return { index: i, sessionNDecoded: base, isProcessing: slot.is_processing, pct, isActive };
    }
    return { index: i, sessionNDecoded: 0, isProcessing: false, pct: 0, isActive };
  });

  const activeSlots = slots.filter((s) => s.isActive);
  const inactiveSlots = slots.filter((s) => !s.isActive);

  const activeBarColumnStyle = { flex: `${barFlexUnits} ${barFlexUnits} 0%` } as const;

  const pctTitle = (slot: (typeof slots)[0]) =>
    slot.isActive && slot.pct > 0
      ? unifiedKv
        ? `${Math.round(slot.pct)}% of shared ${formatTokenCount(ctxTotal)} pool (this slot)`
        : `${Math.round(slot.pct)}% of ${formatTokenCount(barCapacity)} slot budget`
      : undefined;

  const renderBarTrack = (slot: (typeof slots)[0]) => (
    <div
      className={`flex-1 min-h-0 w-full rounded-sm overflow-hidden relative ${
        slot.isActive ? "bg-white/5" : "border border-white/5 bg-transparent"
      }`}
    >
      {slot.isActive && !unifiedKv && slot.pct <= 0 && (
        <span className="absolute top-0.5 left-0 right-0 text-center z-10 pointer-events-none px-0.5">
          <span className={`inline-block ${outlineChip}`}>{formatTokenCount(barCapacity)}</span>
        </span>
      )}
      {slot.isActive && unifiedKv && isSingleSlot && slot.pct <= 0 && (
        <span className="absolute top-0.5 left-0 right-0 text-center z-10 pointer-events-none px-0.5">
          <span className={`inline-block ${sharedPoolChip}`}>
            {formatTokenCount(barCapacity)} · shared pool
          </span>
        </span>
      )}
      {slot.isActive && (
        <span
          className="absolute top-0.5 left-0 right-0 text-center z-10 pointer-events-none px-0.5"
          title={pctTitle(slot)}
        >
          <span
            className={`inline-block text-[6px] font-mono font-bold leading-none ctx-bar-fill-pct ${
              slot.pct > 0 ? "ctx-bar-fill-pct--active" : "ctx-bar-fill-pct--idle"
            }`}
          >
            {slot.pct > 0 ? `${Math.round(slot.pct)}%` : ""}
          </span>
        </span>
      )}
      {slot.isActive && slot.pct > 0 && (
        <div
          className="absolute bottom-0 left-0 right-0 rounded-sm z-[1]"
          style={{
            height: `${slot.pct}%`,
            backgroundColor: slot.isProcessing ? "#22c55e" : "rgba(99,102,241,0.5)",
            transition: "height 0.3s ease",
          }}
        />
      )}
    </div>
  );

  const renderBarColumn = (slot: (typeof slots)[0], style: typeof activeBarColumnStyle | typeof inactiveBarStyle) => (
    <div
      key={slot.index}
      className="flex flex-col min-w-0 h-full"
      style={{
        ...style,
        display: !slot.isActive && isSingleSlot ? "none" : undefined,
      }}
    >
      {renderBarTrack(slot)}
    </div>
  );

  const renderLabelColumn = (slot: (typeof slots)[0], style: typeof activeBarColumnStyle | typeof inactiveBarStyle) => (
    <div
      key={slot.index}
      className="flex flex-col items-center min-w-0"
      style={{
        ...style,
        display: !slot.isActive && isSingleSlot ? "none" : undefined,
      }}
    >
      {slot.isActive ? (
        <span className="text-[7px] font-mono bg-black/50 text-white/80 px-1 py-0.5 rounded-sm leading-none">
          S{slot.index + 1}
        </span>
      ) : (
        <span className="text-[6px] font-mono text-stealth-muted/15 leading-none">S{slot.index + 1}</span>
      )}
    </div>
  );

  return (
    <div className="flex w-full h-full min-h-0">
      <div className="flex flex-col flex-1 min-w-0 h-full min-h-0">
        <div
          className="relative flex gap-0.5 flex-1 min-h-[28px] h-full items-stretch min-w-0"
          style={{ paddingTop: showSharedSpan ? 11 : 0 }}
        >
          {showSharedSpan && (
            <div className="absolute top-0 left-0 right-0 z-10 pointer-events-none px-0.5">
              <span className={sharedPoolChip}>
                {formatTokenCount(barCapacity)} · shared pool
              </span>
            </div>
          )}
          {activeSlots.map((slot) => renderBarColumn(slot, activeBarColumnStyle))}
          {inactiveSlots.map((slot) => renderBarColumn(slot, inactiveBarStyle))}
        </div>

        <div className="flex gap-0.5 mt-0.5 flex-shrink-0 min-w-0">
          {activeSlots.map((slot) => renderLabelColumn(slot, activeBarColumnStyle))}
          {inactiveSlots.map((slot) => renderLabelColumn(slot, inactiveBarStyle))}
        </div>
      </div>
    </div>
  );
}