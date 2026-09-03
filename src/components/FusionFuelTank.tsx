export default function FusionFuelTank({ used, total, pct }: { used: number; total: number; pct: number }) {
  const clampedPct = Math.min(100, Math.max(0, pct));

  let barColor: string;
  if (clampedPct > 90) barColor = "fusion-fuel-bar fusion-fuel-bar--danger";
  else if (clampedPct > 70) barColor = "fusion-fuel-bar fusion-fuel-bar--warn";
  else barColor = "fusion-fuel-bar fusion-fuel-bar--accent";

  let textColor: string;
  if (clampedPct > 90) textColor = "fusion-fuel-readout--danger";
  else if (clampedPct > 70) textColor = "fusion-fuel-readout--warn";
  else textColor = "fusion-fuel-readout--accent";

  const usedStr = used >= 1000 ? `${(used / 1000).toFixed(1)}K` : used.toString();
  const totalStr = total >= 1000 ? `${(total / 1000).toFixed(0)}K` : total.toString();

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-0.5">
        <span className="type-micro font-mono fusion-fuel-label tracking-wider">FUEL TANK</span>
        <span className={`type-tiny font-mono ${textColor}`}>
          {usedStr}/{totalStr} ({clampedPct.toFixed(1)}%)
        </span>
      </div>
          <div className="w-full h-4 fusion-fuel-track border rounded-sm overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all duration-300 rounded-sm`}
          style={{ width: `${clampedPct}%` }}
        />
      </div>
    </div>
  );
}
