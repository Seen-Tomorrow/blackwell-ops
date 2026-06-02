import { motion } from "framer-motion";

interface SlotCtxBarsProps {
  slotCtx: Array<{ id: number; n_decoded: number; sessionNDecoded: number; totalTokensLifetime: number; is_processing: boolean }>;
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
  const effectiveParallel = unifiedKv ? 1 : (parallel > 0 ? parallel : 1);
  const slotCapacity = Math.floor(ctxTotal / effectiveParallel);
  const isSingleSlot = effectiveParallel === 1;

  // Build unified total when KV-unified mode is active
  const unifiedSessionTotal = unifiedKv
    ? slotCtx.reduce((sum, s) => sum + s.sessionNDecoded, 0)
    : 0;

  // Build slot entries — always render maxSlots positions
  const slots: Array<{
    index: number;
    sessionNDecoded: number;
    isProcessing: boolean;
    pct: number;
  }> = Array.from({ length: maxSlots }, (_, i) => {
    const slot = slotCtx.find(s => s.id === i);
    if (unifiedKv && i === 0) {
      const pct = slotCapacity > 0 ? Math.min((unifiedSessionTotal / slotCapacity) * 100, 100) : 0;
      return {
        index: i,
        sessionNDecoded: unifiedSessionTotal,
        isProcessing: slot?.is_processing ?? false,
        pct,
      };
    }
    if (slot) {
      const pct = slotCapacity > 0 ? Math.min((slot.sessionNDecoded / slotCapacity) * 100, 100) : 0;
      return {
        index: i,
        sessionNDecoded: slot.sessionNDecoded,
        isProcessing: slot.is_processing,
        pct,
      };
    }
    return {
      index: i,
      sessionNDecoded: 0,
      isProcessing: false,
      pct: 0,
    };
  });

  // Single slot mode (unified KV or parallel=1) — show only S1 with wide bar
  const visibleSlots = isSingleSlot ? slots.slice(0, 1) : slots;

  return (
    <div className="flex flex-col w-full h-full">
      {/* Capacity badges row — above bars */}
      <div className="flex gap-0.5 flex-shrink-0 mb-0.5">
        {visibleSlots.map((slot) => (
          <div key={slot.index} className="w-full text-center">
            <span className="text-[6px] font-mono bg-black text-white/60 px-1 py-0.5 rounded-sm">
              {formatTokenCount(slotCapacity)}
            </span>
          </div>
        ))}
      </div>

      {/* Bars row — full available height */}
      <div className="flex gap-0.5" style={{ flex: '1 1 auto', minHeight: 24 }}>
        {visibleSlots.map((slot) => (
          <div key={slot.index} className="relative" style={{ flex: isSingleSlot ? '3 3 0' : '1 1 0' }}>
            {/* Bar track */}
            <div className="w-full h-full rounded-sm bg-white/5 overflow-hidden relative">
              {slot.pct > 0 && (
                <motion.div
                  className="absolute bottom-0 left-0 right-0 rounded-sm"
                  style={{
                    height: `${slot.pct}%`,
                    backgroundColor: slot.isProcessing ? '#22c55e' : 'rgba(99,102,241,0.5)',
                  }}
                  animate={{ height: `${slot.pct}%` }}
                  transition={{ duration: 0.3 }}
                />
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Labels row — below bars */}
      <div className="flex gap-0.5 mt-1">
        {visibleSlots.map((slot) => (
          <div key={slot.index} className="w-full flex flex-col items-center">
            {/* Slot label — black bg badge */}
            <span className="text-[7px] font-mono bg-black text-white/60 px-1 py-0.5 rounded-sm">
              S{slot.index + 1}
            </span>
            {/* Percentage — bigger, black text */}
            <span className={`text-[9px] font-mono font-bold ${slot.pct > 0 ? 'text-black' : 'text-stealth-muted/15'}`}>
              {slot.pct > 0 ? `${Math.round(slot.pct)}%` : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
