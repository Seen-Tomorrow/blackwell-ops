export default function FusionFuelTank({ used, total, pct }: { used: number; total: number; pct: number }) {
  const clampedPct = Math.min(100, Math.max(0, pct));

  let barColor: string;
  if (clampedPct > 90) barColor = "bg-red-500";
  else if (clampedPct > 70) barColor = "bg-orange-400";
  else barColor = "bg-nv-green";

  let textColor: string;
  if (clampedPct > 90) textColor = "text-red-500";
  else if (clampedPct > 70) textColor = "text-orange-400";
  else textColor = "text-nv-green";

  const usedStr = used >= 1000 ? `${(used / 1000).toFixed(1)}K` : used.toString();
  const totalStr = total >= 1000 ? `${(total / 1000).toFixed(0)}K` : total.toString();

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[7px] font-mono text-stealth-muted/60 tracking-wider">FUEL TANK</span>
        <span className={`text-[8px] font-mono ${textColor}`}>
          {usedStr}/{totalStr} ({clampedPct.toFixed(1)}%)
        </span>
      </div>
          <div className="w-full h-4 bg-stealth-dark border border-stealth-border rounded-sm overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all duration-300 rounded-sm`}
          style={{ width: `${clampedPct}%` }}
        />
      </div>
    </div>
  );
}
