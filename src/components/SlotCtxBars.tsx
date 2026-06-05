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
  "text-[6px] font-mono tracking-wider px-1 py-0.5 rounded-sm border border-stealth-border/50 text-stealth-muted/70 bg-transparent";

const sharedCapacityChip =
  "text-[6px] font-mono bg-black text-white/70 px-1 py-0.5 rounded-sm w-full text-center block";

export default function SlotCtxBars({ slotCtx, ctxTotal, parallel, unifiedKv }: SlotCtxBarsProps) {
  const maxSlots = 4;
  const numBars = Math.max(1, parallel || 1);
  const barCapacity = unifiedKv ? ctxTotal : Math.floor(ctxTotal / numBars);
  const isSingleSlot = numBars === 1;
  const showSharedSpan = unifiedKv && numBars > 1;

  const slots: Array<{
    index: number;
    sessionNDecoded: number;
    isProcessing: boolean;
    pct: number;
    isActive: boolean;
  }> = Array.from({ length: maxSlots }, (_, i) => {
    const slot = slotCtx.find(s => s.id === i);
    const isActive = i < numBars;

    if (slot) {
      const live = (slot.promptTokensCache || 0) + (slot.promptTokensProcessed || 0) + (slot.n_decoded || 0);
      const base = live > 0 ? live : slot.sessionNDecoded;
      const pct = barCapacity > 0 ? Math.min((base / barCapacity) * 100, 100) : 0;
      return { index: i, sessionNDecoded: base, isProcessing: slot.is_processing, pct, isActive };
    }
    return { index: i, sessionNDecoded: 0, isProcessing: false, pct: 0, isActive };
  });

  const activeSlots = slots.filter((s) => s.isActive);
  const inactiveSlots = slots.filter((s) => !s.isActive);

  const renderBarTrack = (slot: (typeof slots)[0]) => (
    <div
      className={`flex-1 min-h-0 w-full rounded-sm overflow-hidden relative ${
        slot.isActive ? "bg-white/5" : "border border-white/5 bg-transparent"
      }`}
    >
      {slot.isActive && !unifiedKv && (
        <span className="absolute top-0.5 left-0 right-0 text-center z-10 pointer-events-none px-0.5">
          <span className={`inline-block ${outlineChip}`}>{formatTokenCount(barCapacity)}</span>
        </span>
      )}
      {slot.isActive && unifiedKv && isSingleSlot && (
        <span className="absolute top-0.5 left-0 right-0 text-center z-10 pointer-events-none px-0.5">
          <span className={sharedCapacityChip}>
            {formatTokenCount(barCapacity)} · shared across
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

  const renderBarColumn = (slot: (typeof slots)[0]) => (
    <div
      key={slot.index}
      className="flex flex-col min-w-0 h-full flex-1"
      style={{
        display: !slot.isActive && isSingleSlot ? "none" : "",
        flex: slot.isActive && isSingleSlot ? "4 4 0%" : "1 1 0%",
      }}
    >
      {renderBarTrack(slot)}
    </div>
  );

  return (
    <div className="flex w-full h-full min-h-0">
      <div className="flex flex-col flex-1 min-w-0 h-full min-h-0">
        <div className="flex gap-0.5 flex-1 min-h-[28px] h-full items-stretch">
          <div
            className="relative flex gap-0.5 flex-1 min-w-0 h-full items-stretch"
            style={{ paddingTop: showSharedSpan ? 13 : 0 }}
          >
            {showSharedSpan && (
              <div className="absolute top-0 left-0 right-0 z-10 pointer-events-none px-0.5">
                <span className={sharedCapacityChip}>
                  {formatTokenCount(barCapacity)} · shared across
                </span>
              </div>
            )}
            {activeSlots.map(renderBarColumn)}
          </div>
          {inactiveSlots.map(renderBarColumn)}
        </div>

        <div className="flex gap-0.5 mt-1 flex-shrink-0">
          <div className="flex gap-0.5 flex-1 min-w-0">
            {activeSlots.map((slot) => (
              <div key={slot.index} className="flex flex-col items-center min-w-0 flex-1">
                <span className="text-[7px] font-mono bg-black/50 text-white/80 px-1 py-0.5 rounded-sm">
                  S{slot.index + 1}
                </span>
                <span
                  className={`text-[9px] font-mono font-bold ${
                    slot.pct > 0 ? "text-black" : "text-stealth-muted/15"
                  }`}
                >
                  {slot.pct > 0 ? `${Math.round(slot.pct)}%` : ""}
                </span>
              </div>
            ))}
          </div>
          {inactiveSlots.map((slot) => (
            <div key={slot.index} className="flex flex-col items-center flex-1 min-w-0">
              <span className="text-[6px] font-mono text-stealth-muted/15">S{slot.index + 1}</span>
              <span className="text-[9px] font-mono font-bold text-stealth-muted/15">0%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}