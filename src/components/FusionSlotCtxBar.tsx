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
  if (clampedPct > 90) barColor = "fusion-fuel-bar fusion-fuel-bar--danger";
  else if (clampedPct > 70) barColor = "fusion-fuel-bar fusion-fuel-bar--warn";
  else barColor = "fusion-fuel-bar fusion-fuel-bar--accent";

  const fmtN = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : n.toString();
  const totalStr = ctxTotal >= 1000 ? `${(ctxTotal / 1000).toFixed(0)}K` : ctxTotal.toString();

  return (
    <div className="flex items-center gap-1 w-full">
      <span className={`type-micro font-mono tracking-wider flex-shrink-0 w-4 ${isProcessing ? "fusion-slotctx-id--active" : "fusion-slotctx-id"}`}>
        S{slotId}
      </span>
      <div className="w-[70%] h-3 fusion-slotctx-track border rounded-sm overflow-hidden relative">
        <div
          className={`h-full ${barColor} transition-all duration-300 rounded-sm`}
          style={{ width: `${clampedPct}%` }}
        />
      </div>
      <span className="type-micro font-mono ctx-bar-text flex-shrink-0">
        {fmtN(totalTokens)}/{totalStr} ({clampedPct.toFixed(0)}%)
      </span>
    </div>
  );
}
