import { useState, useEffect, useRef } from "react";
import type { EnginePerfEvent } from "../lib/types";

interface EnginePerformanceTileProps {
  perf: EnginePerfEvent;
  n_ctx?: number;
}

// FuelTank color coding: green (<70%), orange (70-90%), red (>90%)
function getFuelColor(pct: number): string {
  if (pct > 98) return "text-red-500 animate-pulse"; // flashing RED at >98%
  if (pct > 90) return "text-red-500";
  if (pct > 70) return "text-orange-400";
  return "text-nv-green";
}

// FuelTank bar background color
function getFuelBarColor(pct: number): string {
  if (pct > 98) return "bg-red-500 animate-pulse"; // flashing RED at >98%
  if (pct > 90) return "bg-red-500";
  if (pct > 70) return "bg-orange-400";
  return "bg-nv-green";
}

// TPS tier coloring
function getTpsColor(tps: number): string {
  if (tps >= 80) return "text-telemetry-cyan";
  if (tps >= 50) return "text-telemetry-amber";
  if (tps > 0) return "text-orange-400";
  return "text-stealth-muted";
}

// TTFT color coding
function getTtftColor(ttft: number): string {
  if (ttft < 50) return "text-nv-green";
  if (ttft < 150) return "text-telemetry-amber";
  return "text-orange-400";
}

// ── TPS Pulse SVG Component — flat when idle, spikes on token activity ──
function TpsPulseLine({ history }: { history: number[] }) {
  const WIDTH = 300;
  const HEIGHT = 24;
  const BASELINE = HEIGHT - 2;
  const MAX_TPS = 500;

  const points = history.map((tps, i) => {
    const x = (i / (history.length - 1)) * WIDTH;
    const clampedTps = Math.min(tps, MAX_TPS);
    const y = BASELINE - (clampedTps / MAX_TPS) * (HEIGHT - 4);
    return `${x},${y}`;
  });

  if (points.length === 0) {
    points.push(`0,${BASELINE}`, `${WIDTH},${BASELINE}`);
  }

  const pathD = `M${points.join(" L")}`;
  const hasActivity = history.some((t) => t > 0);

  return (
    <svg width="100%" height="24" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" className="opacity-70">
      <path
        d={pathD}
        fill="none"
        stroke={hasActivity ? "#76B900" : "#333"}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const MAX_PULSE_HISTORY = 100;

export default function EnginePerformanceTile({ perf, n_ctx = 32768 }: EnginePerformanceTileProps) {
  const alphaPct = perf.fuel_alpha_pct ?? 0;

  // Rolling TPS history for pulse line visualization
  const tpsHistoryRef = useRef<number[]>([]);
  const [, setTick] = useState(0);
  useEffect(() => {
    tpsHistoryRef.current.push(perf.tps);
    if (tpsHistoryRef.current.length > MAX_PULSE_HISTORY) {
      tpsHistoryRef.current.shift();
    }
    setTick((t) => t + 1);
  }, [perf.tps]);

  // Compute fuel tank display values (cap at 100 for display)
  const alphaDisplay = Math.min(100, Math.max(0, alphaPct));

  return (
    <div className="mt-2 border border-stealth-border rounded-sm bg-black/60 overflow-hidden">
      {/* TPS pulse line */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-stealth-border bg-stealth-dark/30">
        <TpsPulseLine history={tpsHistoryRef.current} />
      </div>

      {/* TPS + TTFT row */}
      <div className="flex items-end justify-center py-2 gap-4">
        {/* TPS gauge */}
        <div className="text-center">
          <span className="text-[8px] font-mono text-stealth-muted tracking-wider block">TPS</span>
          <span className={`text-2xl font-mono font-bold ${getTpsColor(perf.tps)}`}>
            {perf.tps > 0 ? perf.tps.toFixed(1) : "--"}
          </span>
        </div>

        {/* Divider */}
        <div className="w-px h-8 bg-stealth-border" />

        {/* TTFT display */}
        {perf.ttft_ms !== undefined && perf.ttft_ms !== null && perf.ttft_ms > 0 && (
          <>
            <span className="text-[10px] font-mono text-stealth-muted self-center">|</span>
            <div className="text-center">
              <span className="text-[8px] font-mono text-stealth-muted tracking-wider block">TTFT</span>
              <span className={`text-lg font-mono font-bold ${getTtftColor(perf.ttft_ms)}`}>
                {perf.ttft_ms.toFixed(0)}ms
              </span>
            </div>
          </>
        )}

        {/* Divider */}
        <div className="w-px h-8 bg-stealth-border" />

        {/* Fuel Tank ALPHA */}
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-[7px] font-mono text-telemetry-cyan tracking-wider">ALPHA</span>
          <div className="w-14 h-2.5 bg-stealth-dark border border-stealth-border rounded-sm overflow-hidden relative">
            <div
              className={`h-full ${getFuelBarColor(alphaDisplay)} transition-all duration-300`}
              style={{ width: `${alphaDisplay}%` }}
            />
          </div>
          <span className="text-[7px] font-mono text-stealth-muted/60">
            {alphaPct > 0 ? `${alphaDisplay.toFixed(0)}%` : "--"}
          </span>
        </div>
      </div>

      {/* Footer row — context info */}
      <div className="flex items-center justify-between px-2 py-0.5 border-t border-stealth-border bg-black/30">
        <span className="text-[7px] font-mono text-stealth-muted/40">
          CONTEXT: {n_ctx.toLocaleString()} tok
        </span>
        <span className="text-[7px] font-mono text-stealth-muted/40">
          KV CACHE TRACKING
        </span>
      </div>
    </div>
  );
}
