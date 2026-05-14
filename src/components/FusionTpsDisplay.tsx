import { useRef, useEffect, useState } from "react";

const MAX_HISTORY = 50;
const WIDTH = 280;
const HEIGHT = 32;
const BASELINE = HEIGHT - 3;
const MAX_TPS = 600;

export default function FusionTpsDisplay({ tps, history }: { tps: number; history: number[] }) {
  const histRef = useRef<number[]>([]);
  const [, setTick] = useState(0);

  useEffect(() => {
    histRef.current.push(tps);
    if (histRef.current.length > MAX_HISTORY) histRef.current.shift();
    setTick((t) => t + 1);
  }, [tps]);

  const displayHistory = history.length > 1 ? history : histRef.current;
  const hasActivity = displayHistory.some((v) => v > 0);

  // Sparkline points
  const points = displayHistory.map((v, i) => {
    const x = (i / Math.max(displayHistory.length - 1, 1)) * WIDTH;
    const clamped = Math.min(v, MAX_TPS);
    const y = BASELINE - (clamped / MAX_TPS) * (HEIGHT - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  if (points.length === 0) points.push(`0,${BASELINE}`, `${WIDTH},${BASELINE}`);
  const pathD = `M${points.join(" L")}`;

  // Color tiers
  let colorClass: string;
  if (tps >= 80) colorClass = "text-telemetry-cyan";
  else if (tps >= 50) colorClass = "text-nv-green";
  else if (tps > 0) colorClass = "text-orange-400";
  else colorClass = "text-stealth-muted/60";

  return (
    <div className="flex flex-col items-center gap-1">
      {/* Big TPS number */}
      <span className={`font-mono font-bold tracking-tight ${colorClass}`} style={{ fontSize: 'clamp(1.2rem, 5vh, 2.5rem)' }}>
        {tps > 0 ? tps.toFixed(0) : "--"}
      </span>
      <span className="text-[8px] font-mono text-stealth-muted/60 tracking-widest">TOKENS / SEC</span>

      {/* Sparkline */}
      <svg width="100%" height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" className="opacity-80 mt-0.5">
        <path
          d={pathD}
          fill="none"
          stroke={hasActivity ? "#4d7a00" : "#aaa"}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
