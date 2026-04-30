import { useState, useEffect, useRef } from "react";
import type { EnginePerfEvent } from "../lib/types";

interface EnginePerformanceTileProps {
  perf: EnginePerfEvent;
  n_ctx?: number;
  onNewSession?: () => void;
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

// ── Heartbeat SVG Component ────────────────────────────────────────
function HeartbeatLine({ active }: { active: boolean }) {
  const [path, setPath] = useState("");
  const frameRef = useRef(0);
  const animRef = useRef<number | null>(null);
  
  useEffect(() => {
    if (!active) {
      setPath("M0,12 L300,12");
      return;
    }
    
    const amplitude = 6;
    const animate = () => {
      frameRef.current += 1;
      const frame = frameRef.current;
      const points: string[] = [];
      
      for (let i = 0; i <= 300; i += 3) {
        const t = ((i + frame * 4) % 300) / 300;
        // Base sinusoidal wave
        let y = Math.sin(t * Math.PI * 8) * amplitude * 0.5;
        
        // Sharp R-wave spike (heartbeat PQRST complex simulation)
        const cyclePos = (t * 3) % 1;
        if (cyclePos > 0.4 && cyclePos < 0.46) {
          y -= Math.sin((cyclePos - 0.4) / 0.06 * Math.PI) * amplitude * 3;
        } else if (cyclePos > 0.46 && cyclePos < 0.52) {
          y += Math.sin((cyclePos - 0.46) / 0.06 * Math.PI) * amplitude * 1.5;
        }
        
        // Organic jitter
        y += (Math.random() - 0.5) * 1;
        points.push(`${i},${12 - y}`);
      }
      
      setPath(`M${points.join(" L")}`);
      animRef.current = requestAnimationFrame(animate);
    };
    
    frameRef.current = 0;
    animRef.current = requestAnimationFrame(animate);
    
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [active]);
  
  return (
    <svg width="100%" height="24" viewBox="0 0 300 24" preserveAspectRatio="none" className="opacity-70">
      <path
        d={path}
        fill="none"
        stroke={active ? "#76B900" : "#333"}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function EnginePerformanceTile({ perf, n_ctx = 32768, onNewSession }: EnginePerformanceTileProps) {
  const alphaPct = perf.fuel_alpha_pct ?? 0;
  const betaPct = perf.fuel_beta_pct ?? 0;
  
  // Compute fuel tank display values (cap at 100 for display)
  const alphaDisplay = Math.min(100, Math.max(0, alphaPct));
  const betaDisplay = Math.min(100, Math.max(0, betaPct));

  return (
    <div className="mt-2 border border-stealth-border rounded-sm bg-black/60 overflow-hidden">
      {/* Heartbeat animation bar */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-stealth-border bg-stealth-dark/30">
        <HeartbeatLine active={perf.tps > 0} />
        
        {/* NEW SESSION button for BETA checkpoint */}
        {onNewSession && (
          <button
            onClick={onNewSession}
            className="px-2 py-0.5 text-[8px] font-mono bg-telemetry-cyan/20 text-telemetry-cyan border border-telemetry-cyan/40 hover:bg-telemetry-cyan/30 transition-all duration-200 shrink-0"
          >
            NEW SESSION
          </button>
        )}
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

        {/* Divider */}
        <div className="w-px h-8 bg-stealth-border" />

        {/* Fuel Tank BETA */}
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-[7px] font-mono text-telemetry-amber tracking-wider">BETA</span>
          <div className="w-14 h-2.5 bg-stealth-dark border border-stealth-border rounded-sm overflow-hidden relative">
            <div
              className={`h-full ${getFuelBarColor(betaDisplay)} transition-all duration-300`}
              style={{ width: `${betaDisplay}%` }}
            />
          </div>
          <span className="text-[7px] font-mono text-stealth-muted/60">
            {betaPct > 0 ? `${betaDisplay.toFixed(0)}%` : "--"}
          </span>
        </div>
      </div>

      {/* Footer row — context info */}
      <div className="flex items-center justify-between px-2 py-0.5 border-t border-stealth-border bg-black/30">
        <span className="text-[7px] font-mono text-stealth-muted/40">
          CONTEXT: {n_ctx.toLocaleString()} tok
        </span>
        <span className="text-[7px] font-mono text-stealth-muted/40">
          DUAL-METHOD KV TRACKING
        </span>
      </div>
    </div>
  );
}
