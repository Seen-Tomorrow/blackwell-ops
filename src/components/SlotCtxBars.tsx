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
  const slotCapacity = unifiedKv ? ctxTotal : Math.floor(ctxTotal / (parallel > 0 ? parallel : 1));

  // Build unified total when KV-unified mode is active
  const unifiedSessionTotal = unifiedKv
    ? slotCtx.reduce((sum, s) => sum + s.sessionNDecoded, 0)
    : 0;
  const unifiedLifetimeTotal = unifiedKv
    ? slotCtx.reduce((sum, s) => sum + s.totalTokensLifetime, 0)
    : 0;

  // Build slot entries — always render maxSlots positions
  const slots: Array<{
    index: number;
    sessionNDecoded: number;
    totalTokensLifetime: number;
    isProcessing: boolean;
    pct: number;
  }> = Array.from({ length: maxSlots }, (_, i) => {
    const slot = slotCtx.find(s => s.id === i);
    if (unifiedKv && i === 0) {
      const pct = slotCapacity > 0 ? Math.min((unifiedSessionTotal / slotCapacity) * 100, 100) : 0;
      return {
        index: i,
        sessionNDecoded: unifiedSessionTotal,
        totalTokensLifetime: unifiedLifetimeTotal,
        isProcessing: slot?.is_processing ?? false,
        pct,
      };
    }
    if (slot) {
      const pct = slotCapacity > 0 ? Math.min((slot.sessionNDecoded / slotCapacity) * 100, 100) : 0;
      return {
        index: i,
        sessionNDecoded: slot.sessionNDecoded,
        totalTokensLifetime: slot.totalTokensLifetime,
        isProcessing: slot.is_processing,
        pct,
      };
    }
    return {
      index: i,
      sessionNDecoded: 0,
      totalTokensLifetime: 0,
      isProcessing: false,
      pct: 0,
    };
  });

  // In unified mode, only show S1 with wider bar
  const visibleSlots = unifiedKv ? slots.slice(0, 1) : slots;

  return (
    <div className="flex flex-col w-full h-full">
      {/* Bars row — full available height */}
      <div className="flex gap-0.5" style={{ flex: '1 1 auto', minHeight: 24 }}>
        {visibleSlots.map((slot) => (
          <div key={slot.index} className="relative" style={{ flex: '1 1 0' }}>
            {/* Bar track */}
            <div className="w-full h-full rounded-sm bg-white/5 overflow-hidden relative">
              {/* Fill — grows from bottom */}
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
            {/* Slot label */}
            <span className={`text-[6px] font-mono ${slot.sessionNDecoded > 0 ? 'text-stealth-muted/40' : 'text-stealth-muted/15'}`}>
              S{slot.index + 1}
            </span>
            {/* Percentage */}
            <span className={`text-[6px] font-mono ${slot.pct > 0 ? 'text-white/50' : 'text-stealth-muted/15'}`}>
              {slot.pct > 0 ? `${Math.round(slot.pct)}%` : ''}
            </span>
            {/* Lifetime total — red for comparison */}
            <span className="text-[6px] font-mono text-red-400/50">
              {slot.totalTokensLifetime > 0 ? formatTokenCount(slot.totalTokensLifetime) : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
