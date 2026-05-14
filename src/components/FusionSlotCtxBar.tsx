interface FusionSlotCtxBarProps {
  slotId: number;
  totalTokens: number;
  ctxTotal: number;
  isProcessing: boolean;
}

export default function FusionSlotCtxBar({ slotId, totalTokens, ctxTotal, isProcessing }: FusionSlotCtxBarProps) {
  const pct = ctxTotal > 0 ? Math.min((totalTokens / ctxTotal) * 100, 100) : 0;
  const clampedPct = Math.max(0, pct);

  let barColor: string;
  if (clampedPct > 90) barColor = "bg-red-500";
  else if (clampedPct > 70) barColor = "bg-orange-400";
  else barColor = "bg-nv-green";

  const fmtN = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : n.toString();
  const totalStr = ctxTotal >= 1000 ? `${(ctxTotal / 1000).toFixed(0)}K` : ctxTotal.toString();

  return (
    <div className="flex items-center gap-1 w-full">
      <span className={`text-[7px] font-mono tracking-wider flex-shrink-0 w-4 ${isProcessing ? "text-nv-green" : "text-stealth-muted/50"}`}>
        S{slotId}
      </span>
      <div className="w-[70%] h-3 bg-black/20 border border-black/10 rounded-sm overflow-hidden relative">
        <div
          className={`h-full ${barColor} transition-all duration-300 rounded-sm`}
          style={{ width: `${clampedPct}%` }}
        />
      </div>
      <span className="text-[7px] font-mono ctx-bar-text flex-shrink-0">
        {fmtN(totalTokens)}/{totalStr} ({clampedPct.toFixed(0)}%)
      </span>
    </div>
  );
}
