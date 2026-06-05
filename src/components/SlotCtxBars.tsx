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

export default function SlotCtxBars({ slotCtx, ctxTotal, parallel, unifiedKv }: SlotCtxBarsProps) {
  const maxSlots = 4;
  const numBars = Math.max(1, parallel || 1);
  // For non-unified (partitioned KV): each bar has its own slice capacity.
  // For unified (shared KV): each bar shows its seq's usage against the *full* shared ctx (individual seqs share the pool).
  const barCapacity = unifiedKv ? ctxTotal : Math.floor(ctxTotal / numBars);
  const isSingleSlot = numBars === 1;

  // Build all 4 slot entries — always render all for visual outline.
  // When parallel > 1 we now show the actual number of bars even in unified-KV mode (previously collapsed to 1).
  // "Move together" in shared mode: multiple bars can be visible; their heights reflect per-sequence usage of the shared pool.
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
      // Prefer live current ctx used (cache + processed during PP, or prompt+decoded) when available.
      const live = (slot.promptTokensCache || 0) + (slot.promptTokensProcessed || 0) + (slot.n_decoded || 0);
      const base = live > 0 ? live : slot.sessionNDecoded;
      const pct = barCapacity > 0 ? Math.min((base / barCapacity) * 100, 100) : 0;
      return { index: i, sessionNDecoded: base, isProcessing: slot.is_processing, pct, isActive };
    }
    return { index: i, sessionNDecoded: 0, isProcessing: false, pct: 0, isActive };
  });

  return (
    <div className="flex w-full h-full">
      {/* Vertical UNIFIED indicator — only when unified KV mode */}
      {unifiedKv && (
        <div className="flex flex-col items-center justify-center bg-black rounded-sm mr-0.5 flex-shrink-0" style={{ width: 16 }}>
          {['U','N','I','F','I','E','D'].map((c, i) => <span key={`a${i}`} className="text-[7px] font-mono text-white/70 leading-tight">{c}</span>)}
          <span className="h-1" />
          {['K','V'].map((c, i) => <span key={`b${i}`} className="text-[7px] font-mono text-white/70 leading-tight">{c}</span>)}
        </div>
      )}

      {/* Bars container */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Bars row — full available height */}
        <div className="flex gap-0.5" style={{ flex: '1 1 auto', minHeight: 24 }}>
          {slots.map((slot) => (
            <div key={slot.index} className="relative" style={{ display: !slot.isActive && isSingleSlot ? 'none' : '', flex: slot.isActive && isSingleSlot ? '4 4 0' : '1 1 0' }}>
              {/* Bar track */}
              <div className={`w-full h-full rounded-sm overflow-hidden relative ${slot.isActive ? 'bg-white/5' : 'border border-white/5 bg-transparent'}`}>
                {/* Capacity badge — absolute inside bar top */}
                {slot.isActive && (
                  <span className="absolute top-0.5 left-0 right-0 text-center z-10">
                    <span className="text-[6px] font-mono bg-black text-white/70 px-1 py-0.5 rounded-sm">
                      {formatTokenCount(barCapacity)}{unifiedKv ? " shared" : ""}
                    </span>
                  </span>
                )}
                {/* Fill — grows from bottom */}
                {slot.isActive && slot.pct > 0 && (
                  <div
                    className="absolute bottom-0 left-0 right-0 rounded-sm"
                    style={{
                      height: `${slot.pct}%`,
                      backgroundColor: slot.isProcessing ? '#22c55e' : 'rgba(99,102,241,0.5)',
                      transition: 'height 0.3s ease',
                    }}
                  />
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Labels row — below bars */}
        <div className="flex gap-0.5 mt-1">
          {slots.map((slot) => (
            <div key={slot.index} className="w-full flex flex-col items-center" style={{ display: !slot.isActive && isSingleSlot ? 'none' : '' }}>
              {/* Slot label */}
              {slot.isActive ? (
                <span className="text-[7px] font-mono bg-black/50 text-white/80 px-1 py-0.5 rounded-sm">
                  S{slot.index + 1}
                </span>
              ) : (
                <span className="text-[6px] font-mono text-stealth-muted/15">
                  S{slot.index + 1}
                </span>
              )}
              {/* Percentage — active shows value, inactive shows 0% */}
              <span className={`text-[9px] font-mono font-bold ${slot.isActive && slot.pct > 0 ? 'text-black' : 'text-stealth-muted/15'}`}>
                {slot.isActive ? (slot.pct > 0 ? `${Math.round(slot.pct)}%` : '') : '0%'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
