import { useMemo, useEffect, useState } from "react";
import type { GpuInfo } from "../lib/types";
import type { ThermalReading } from "../lib/reactor11";

interface Props {
  gpus: GpuInfo[];
  totalVramUsedMib: number;
  maxTotalVramMib: number;
  diagnosticMode: boolean;
  draggedModel: string | null;
  predictiveVramMib: number;
  mockTempEnabled: boolean;
  mockTemp: number;
  mockLevelEnabled: boolean;
  mockLevel: number;
}

export default function R11_Core({ gpus, totalVramUsedMib, maxTotalVramMib, diagnosticMode, draggedModel, predictiveVramMib, mockTempEnabled, mockTemp, mockLevelEnabled, mockLevel }: Props) {
  const effectiveTemp = mockTempEnabled ? mockTemp : (gpus.length > 0 ? Math.max(...gpus.map(g => g.temperature_gpu || 30), ...gpus.map(g => (g.temperature_hot_spot ?? g.temperature_gpu) || 30)) : 30);
  const thermal = useMemo(() => computeThermal(effectiveTemp), [effectiveTemp]);
  const vramRatio = mockLevelEnabled ? mockLevel / 100 : Math.min(1, totalVramUsedMib / (maxTotalVramMib || 1));
  const predictiveRatio = draggedModel ? Math.min(1, (totalVramUsedMib + predictiveVramMib) / (maxTotalVramMib || 1)) : vramRatio;

  // Core dimensions — centered in square viewport
  const cx = 400, cy = 400, coreR = 320;
  const liquidTop = cy + coreR - (vramRatio * coreR * 2);
  const ghostTop = cy + coreR - (predictiveRatio * coreR * 2);

  // Wave animation tick
  const tick = useWaveTick(50);

  // Wave points — generate undulating surface
  const wavePoints = useMemo(() => {
    const pts = [];
    const segments = 40;
    const width = coreR * 2;
    for (let i = 0; i <= segments; i++) {
      const x = (cx - coreR) + (i / segments) * width;
      const wave = Math.sin((i / segments) * Math.PI * 4 + tick * 0.05) * (thermal.hasRipple ? 6 : 3);
      pts.push(`${x},${liquidTop + wave}`);
    }
    return pts;
  }, [liquidTop, thermal.hasRipple, coreR, tick, cx]);

  const ghostWavePoints = useMemo(() => {
    if (!draggedModel) return null;
    const pts = [];
    const segments = 40;
    const width = coreR * 2;
    for (let i = 0; i <= segments; i++) {
      const x = (cx - coreR) + (i / segments) * width;
      const wave = Math.sin((i / segments) * Math.PI * 4 + tick * 0.07) * 4;
      pts.push(`${x},${ghostTop + wave}`);
    }
    return pts;
  }, [ghostTop, draggedModel, coreR, tick]);

  return (
    <div className="relative w-full h-full flex items-center justify-center overflow-hidden">
      {/* SVG filter definitions — invisible but referenced */}
      <svg className="absolute w-0 h-0">
        <defs>
          {/* Heat haze — scales with criticality */}
          <filter id="r11-heat-haze" x="-20%" y="-20%" width="140%" height="140%">
            <feTurbulence type="fractalNoise" baseFrequency="0.015" numOctaves="4" result="noise">
              {thermal.state === "critical" && (
                <animate attributeName="baseFrequency" values="0.015;0.04;0.015" dur="1.5s" repeatCount="indefinite" />
              )}
            </feTurbulence>
            <feDisplacementMap in="SourceGraphic" in2="noise" scale={thermal.hasHaze ? 8 : thermal.hasRipple ? 2 : 0} xChannelSelector="R" yChannelSelector="G" />
          </filter>

          {/* Coolant glow — pulsing */}
          <filter id="r11-coolant-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation={thermal.hasRipple ? "8" : "4"} result="blur">
              {thermal.hasRipple && (
                <animate attributeName="stdDeviation" values="5;10;5" dur="1.2s" repeatCount="indefinite" />
              )}
            </feGaussianBlur>
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Core inner glow */}
          <filter id="r11-core-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="15" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Coolant thermal gradient — bottom deep, top luminous */}
          <linearGradient id="r11-coolant-grad" x1="0%" y1="100%" x2="0%" y2="0%">
            <stop offset="0%" stopColor={thermal.deepColor} />
            <stop offset="50%" stopColor={thermal.midColor} />
            <stop offset="100%" stopColor={thermal.surfaceColor} />
          </linearGradient>

          {/* Ghost preview gradient */}
          <linearGradient id="r11-ghost-grad" x1="0%" y1="100%" x2="0%" y2="0%">
            <stop offset="0%" stopColor={thermal.surfaceColor} stopOpacity="0.15" />
            <stop offset="100%" stopColor={thermal.surfaceColor} stopOpacity="0.05" />
          </linearGradient>

          {/* Core background radial */}
          <radialGradient id="r11-core-bg" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#0a1628" />
            <stop offset="70%" stopColor="#060e1a" />
            <stop offset="100%" stopColor="#030810" />
          </radialGradient>

          {/* Plasma line gradient */}
          <linearGradient id="r11-plasma-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={thermal.plasmaColor} stopOpacity="0.9" />
            <stop offset="50%" stopColor="#00e5ff" stopOpacity="0.7" />
            <stop offset="100%" stopColor={thermal.plasmaColor} stopOpacity="0.9" />
          </linearGradient>

          {/* Clip path for coolant containment */}
          <clipPath id="r11-core-clip">
            <circle cx={cx} cy={cy} r={coreR - 4} />
          </clipPath>

          {/* Lattice clip — inner region */}
          <clipPath id="r11-lattice-clip">
            <circle cx={cx} cy={cy} r={coreR - 20} />
          </clipPath>
        </defs>
      </svg>

      {/* Main reactor core SVG */}
      <svg
        viewBox="0 0 800 800"
        preserveAspectRatio="xMidYMid slice"
        className="w-full h-full"
        style={{
          filter: thermal.hasHaze ? "url(#r11-heat-haze)" : undefined,
          transition: "filter 1s ease",
        }}
      >
        {/* ── Outer containment ring ── */}
        <circle cx={cx} cy={cy} r={coreR + 8} fill="none" stroke={thermal.state === "critical" ? "#ff220040" : "#1a2a4a"} strokeWidth="3" opacity="0.6">
          {thermal.state === "critical" && (
            <animate attributeName="stroke-opacity" values="0.3;0.7;0.3" dur="1s" repeatCount="indefinite" />
          )}
        </circle>

        {/* Secondary ring */}
        <circle cx={cx} cy={cy} r={coreR + 2} fill="none" stroke="#1a2a4a" strokeWidth="1" opacity="0.4" />

        {/* ── Core background ── */}
        <circle cx={cx} cy={cy} r={coreR - 4} fill="url(#r11-core-bg)" />

        {/* ── Lattice grid — hexagonal pattern inside core ── */}
        <g clipPath="url(#r11-lattice-clip)" opacity="0.06">
          {Array.from({ length: 15 }).map((_, i) => (
            <line key={`lat-h-${i}`} x1={cx - coreR} y1={cy - coreR + i * 40} x2={cx + coreR} y2={cy - coreR + i * 40} stroke={thermal.surfaceColor} strokeWidth="0.5" />
          ))}
          {Array.from({ length: 15 }).map((_, i) => (
            <line key={`lat-v-${i}`} x1={cx - coreR + i * 40} y1={cy - coreR} x2={cx - coreR + i * 40} y2={cy + coreR} stroke={thermal.surfaceColor} strokeWidth="0.5" />
          ))}
        </g>

        {/* ── Concentric measurement rings ── */}
        {[260, 220, 180, 140, 100].map((r, i) => (
          <circle key={`ring-${i}`} cx={cx} cy={cy} r={r} fill="none" stroke="#1a2a4a" strokeWidth="0.3" opacity={0.15 - i * 0.02} />
        ))}

        {/* ── Coolant liquid ── */}
        <g clipPath="url(#r11-core-clip)">
          {/* Liquid body — fills from bottom up based on VRAM */}
          <polygon
            points={`${cx - coreR},${cy + coreR} ${wavePoints.join(" ")} ${cx + coreR},${cy + coreR}`}
            fill="url(#r11-coolant-grad)"
            opacity={0.3 + vramRatio * 0.55}
            filter="url(#r11-coolant-glow)"
            style={{ transition: "opacity 0.8s ease" }}
          />

          {/* Liquid surface line — luminous */}
          <polyline
            points={wavePoints.join(" ")}
            fill="none"
            stroke={thermal.surfaceColor}
            strokeWidth="2"
            opacity={0.5 + vramRatio * 0.4}
            style={{ transition: "stroke 0.8s ease" }}
          />

          {/* Ghost preview — shows projected VRAM level on drag */}
          {draggedModel && predictiveVramMib > 0 && (
            <g opacity="0.6">
              <polygon
                points={`${cx - coreR},${cy + coreR} ${ghostWavePoints?.join(" ") ?? wavePoints.join(" ")} ${cx + coreR},${cy + coreR}`}
                fill="url(#r11-ghost-grad)"
                stroke={thermal.surfaceColor}
                strokeWidth="1"
                strokeDasharray="6,4"
              />
              <polyline
                points={ghostWavePoints?.join(" ") ?? wavePoints.join(" ")}
                fill="none"
                stroke={thermal.surfaceColor}
                strokeWidth="1"
                strokeDasharray="6,4"
              />
            </g>
          )}
        </g>

        {/* ── Thermal indicator arcs ── */}
        {vramRatio > 0 && (
          <circle
            cx={cx} cy={cy} r={coreR - 4}
            fill="none"
            stroke={thermal.state === "critical" ? "#ff2200" : thermal.state === "elevated" ? "#00e5ff" : "#0066ff"}
            strokeWidth="2"
            opacity={0.3 + vramRatio * 0.3}
            strokeDasharray={`${vramRatio * 2 * Math.PI * (coreR - 4)} 1000`}
            transform={`rotate(-90 ${cx} ${cy})`}
            style={{ transition: "stroke 0.8s ease, stroke-dasharray 0.5s ease" }}
          >
            {thermal.state === "critical" && (
              <animate attributeName="stroke-opacity" values="0.3;0.7;0.3" dur="0.8s" repeatCount="indefinite" />
            )}
          </circle>
        )}

        {/* ── Center readout ── */}
        <g style={{ pointerEvents: "none" }}>
          {/* VRAM allocated */}
          <text x={cx} y={cy - 20} textAnchor="middle" fill={thermal.surfaceColor} fontSize="36" fontFamily="'JetBrains Mono', monospace" fontWeight="bold" opacity="0.9">
            {(totalVramUsedMib / 1024).toFixed(1)}GB
          </text>
          <text x={cx} y={cy + 2} textAnchor="middle" fill="#4a4a5a" fontSize="10" fontFamily="'JetBrains Mono', monospace" letterSpacing="2">
            VRAM ALLOCATED
          </text>

          {/* Temperature */}
          {gpus.length > 0 && (
            <>
              <text x={cx} y={cy + 30} textAnchor="middle" fill={thermal.state === "critical" ? "#ff2200" : thermal.state === "elevated" ? "#FFB800" : thermal.surfaceColor} fontSize="16" fontFamily="'JetBrains Mono', monospace" fontWeight="bold">
                {Math.round(thermal.temperature)}°C
              </text>
              <text x={cx} y={cy + 48} textAnchor="middle" fill="#4a4a5a" fontSize="8" fontFamily="'JetBrains Mono', monospace" letterSpacing="1">
                CORE TEMPERATURE
              </text>
            </>
          )}
        </g>

        {/* ── Bubble particles at critical ── */}
        {thermal.hasBubbles && <BubbleSystem cx={cx} cy={cy} coreR={coreR} liquidTop={liquidTop} />}

        {/* ── Diagnostic plasma lines ── */}
        {diagnosticMode && gpus.length > 0 && (
          <PlasmaLines cx={cx} cy={cy} gpus={gpus} thermal={thermal} />
        )}
      </svg>

      {/* ── Thermal state badge ── */}
      <div
        className={`absolute top-4 right-4 px-3 py-1.5 text-[9px] font-mono tracking-widest border transition-all duration-500 ${
          thermal.state === "critical"
            ? "border-red-500/60 text-red-400 bg-red-500/10 animate-pulse shadow-[0_0_15px_rgba(255,34,0,0.3)]"
            : thermal.state === "elevated"
              ? "border-telemetry-cyan/50 text-telemetry-cyan bg-telemetry-cyan/10 shadow-[0_0_10px_rgba(0,229,255,0.2)]"
              : thermal.state === "normal"
                ? "border-blue-500/30 text-blue-400 bg-blue-500/5"
                : "border-stealth-border text-stealth-muted bg-stealth-panel/20"
        }`}
      >
        {thermal.state.toUpperCase()}
      </div>
    </div>
  );
}

/* ── Bubble System ── */
function BubbleSystem({ cx, cy, coreR, liquidTop }: { cx: number; cy: number; coreR: number; liquidTop: number }) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 2000);
    return () => clearInterval(id);
  }, []);

  const bubbles = useMemo(() => {
    const result = [];
    for (let i = 0; i < 16; i++) {
      const seed = (i * 137 + tick * 7) % 1000;
      const x = cx - coreR * 0.6 + (seed % (coreR * 1.2));
      const yBase = liquidTop + 20 + (seed % 80);
      const size = 1.5 + (seed % 40) / 10;
      const duration = 1.5 + (seed % 30) / 10;
      const delay = (seed % 20) / 10;
      result.push({ x, y: yBase, size, duration, delay, id: `bub-${i}-${tick}` });
    }
    return result;
  }, [cx, cy, coreR, liquidTop, tick]);

  return (
    <g>
      {bubbles.map(b => (
        <circle
          key={b.id}
          cx={b.x}
          cy={b.y}
          r={b.size}
          fill="white"
          opacity="0.7"
          className="animate-bubble-rise"
          style={{ animationDelay: `${b.delay}s`, animationDuration: `${b.duration}s` }}
        />
      ))}
    </g>
  );
}

/* ── Plasma Lines (Diagnostic) ── */
function PlasmaLines({ cx, cy, gpus, thermal }: { cx: number; cy: number; gpus: GpuInfo[]; thermal: ThermalReading }) {
  const lines = [];
  for (let i = 0; i < Math.min(gpus.length, 8); i++) {
    const angle = (i / Math.max(gpus.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const dist = 200;
    const tx = cx + Math.cos(angle) * dist;
    const ty = cy + Math.sin(angle) * dist;
    const memUsed = gpus[i]?.memory_used ?? 0;
    const memTotal = gpus[i]?.memory_total ?? 1;
    const ratio = memUsed / memTotal;

    lines.push(
      <g key={`plasma-${i}`}>
        {/* Main plasma line */}
        <line
          x1={cx} y1={cy}
          x2={tx} y2={ty}
          stroke={thermal.plasmaColor}
          strokeWidth={1 + ratio * 3}
          strokeDasharray="8,4"
          opacity="0.5"
          className="animate-plasma-flow"
        />

        {/* Glow overlay */}
        <line
          x1={cx} y1={cy}
          x2={tx} y2={ty}
          stroke={thermal.plasmaColor}
          strokeWidth={3 + ratio * 4}
          opacity="0.1"
          filter="url(#r11-coolant-glow)"
        />

        {/* GPU label */}
        <text x={tx + 10} y={ty - 5} fill={thermal.plasmaColor} fontSize="8" fontFamily="'JetBrains Mono', monospace" opacity="0.7">
          GPU-{gpus[i]?.index ?? i} | {(gpus[i]?.memory_total / 1024).toFixed(0)}GB | {(gpus[i]?.temperature_gpu ?? "--")}°C
        </text>

        {/* Ratio bar */}
        <rect x={tx + 10} y={ty + 5} width="40" height="2" fill="#1a2a4a" opacity="0.5" />
        <rect x={tx + 10} y={ty + 5} width={40 * ratio} height="2" fill={thermal.plasmaColor} opacity="0.6" />
      </g>
    );
  }
  return <>{lines}</>;
}

/* ── Thermal Computation ── */
function computeThermal(temp: number): ThermalReading {
  if (temp <= 0) {
    return {
      state: "cold",
      temperature: 30,
      coolantColor: "#0044cc",
      turbulenceScale: 0,
      hasRipple: false,
      hasHaze: false,
      hasBubbles: false,
      deepColor: "#001a33",
      midColor: "#003366",
      surfaceColor: "#0044cc",
      plasmaColor: "#00ff88",
    };
  }

  if (temp >= 80) {
    return {
      state: "critical",
      temperature: temp,
      coolantColor: "#ff2200",
      turbulenceScale: 8,
      hasRipple: true,
      hasHaze: true,
      hasBubbles: true,
      deepColor: "#661100",
      midColor: "#cc2200",
      surfaceColor: "#ff4400",
      plasmaColor: "#ff6600",
    };
  }

  if (temp >= 65) {
    return {
      state: "elevated",
      temperature: temp,
      coolantColor: "#00e5ff",
      turbulenceScale: 3,
      hasRipple: true,
      hasHaze: false,
      hasBubbles: false,
      deepColor: "#003344",
      midColor: "#006688",
      surfaceColor: "#00e5ff",
      plasmaColor: "#00ff88",
    };
  }

  if (temp >= 50) {
    return {
      state: "normal",
      temperature: temp,
      coolantColor: "#0088ff",
      turbulenceScale: 1,
      hasRipple: false,
      hasHaze: false,
      hasBubbles: false,
      deepColor: "#001a33",
      midColor: "#003366",
      surfaceColor: "#0066ff",
      plasmaColor: "#00ff88",
    };
  }

  return {
    state: "cold",
    temperature: temp,
    coolantColor: "#0044cc",
    turbulenceScale: 0,
    hasRipple: false,
    hasHaze: false,
    hasBubbles: false,
    deepColor: "#000d1a",
    midColor: "#001a33",
    surfaceColor: "#003366",
    plasmaColor: "#00ff88",
  };
}

// Extend ThermalReading with additional color fields
// (These are computed but not in the Rust type — frontend-only)

// ── Wave animation hook ──
// The wave points update via a tick to create smooth undulation
function useWaveTick(interval: number = 50) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), interval);
    return () => clearInterval(id);
  }, [interval]);
  return tick;
}
