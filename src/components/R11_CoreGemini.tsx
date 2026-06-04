import { useMemo, useEffect, useState, useRef } from "react";
import type { GpuInfo } from "../lib/types";

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

// Hexagon path generator
const drawHexagon = (cx: number, cy: number, r: number): string => {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    pts.push(`${x},${y}`);
  }
  return pts.join(" ");
};

// Wave animation via requestAnimationFrame
const useWaveAnimation = (liquidLevel: number, amplitude: number) => {
  const [offset, setOffset] = useState(0);
  const frameRef = useRef<number>(0);

  useEffect(() => {
    const animate = () => {
      setOffset(prev => prev + 0.025);
      frameRef.current = requestAnimationFrame(animate);
    };
    frameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameRef.current);
  }, []);

  const generateWavePath = (off: number, width: number, height: number) => {
    const frequency = 0.008;
    const points = 120;
    let d = `M 0 ${liquidLevel}`;
    for (let i = 0; i <= points; i++) {
      const x = (i / points) * width;
      const y = liquidLevel + Math.sin(x * frequency + off) * amplitude;
      d += ` L ${x} ${y}`;
    }
    d += ` L ${width} ${height} L 0 ${height} Z`;
    return d;
  };

  const generateWavePathTopOnly = (off: number, width: number) => {
    const frequency = 0.008;
    const points = 120;
    let d = `M 0 ${liquidLevel}`;
    for (let i = 0; i <= points; i++) {
      const x = (i / points) * width;
      const y = liquidLevel + Math.sin(x * frequency + off) * amplitude;
      d += ` L ${x} ${y}`;
    }
    return d;
  };

  return { offset, generateWavePath, generateWavePathTopOnly };
};

// Thermal color computation (Gemini style — cyan primary)
const computeThermalGemini = (temp: number) => {
  if (temp <= 0) {
    return {
      surface: "#00FFFF",
      deep: "#001933",
      glow: "#00FFFF",
      state: "cold" as const,
      temp: 30,
    };
  }

  if (temp >= 80) {
    return {
      surface: "#FF3300",
      deep: "#330000",
      glow: "#FF3300",
      state: "critical" as const,
      temp,
    };
  }
  if (temp >= 60) {
    return {
      surface: "#00e5ff",
      deep: "#003366",
      glow: "#00e5ff",
      state: "elevated" as const,
      temp,
    };
  }
  return {
    surface: "#00FFFF",
    deep: "#001933",
    glow: "#00FFFF",
    state: "cold" as const,
    temp,
  };
};

export default function R11_CoreGemini({ gpus, totalVramUsedMib, maxTotalVramMib, diagnosticMode, draggedModel, predictiveVramMib, mockTempEnabled, mockTemp, mockLevelEnabled, mockLevel }: Props) {
  const effectiveTemp = mockTempEnabled ? mockTemp : (gpus.length > 0 ? Math.max(...gpus.map(g => g.temperature_gpu || 30), ...gpus.map(g => (g.temperature_hot_spot ?? g.temperature_gpu) || 30)) : 30);
  const thermal = computeThermalGemini(effectiveTemp);
  const vramRatio = mockLevelEnabled ? mockLevel / 100 : Math.min(1, totalVramUsedMib / (maxTotalVramMib || 1));
  const predictiveRatio = draggedModel ? Math.min(1, (totalVramUsedMib + predictiveVramMib) / (maxTotalVramMib || 1)) : vramRatio;

  // SVG dimensions — square viewport matching LATTICE
  const vbW = 800, vbH = 800;
  const liquidLevel = vbH * 0.7 - (vramRatio * vbH * 0.6);
  const ghostLevel = vbH * 0.7 - (predictiveRatio * vbH * 0.6);

  const amplitude = thermal.state === "critical" ? 18 : thermal.state === "elevated" ? 12 : 8;
  const { offset, generateWavePath, generateWavePathTopOnly } = useWaveAnimation(liquidLevel, amplitude);
  const ghostAmplitude = 6;
  const { generateWavePathTopOnly: ghostWave } = { generateWavePathTopOnly: (off: number, w: number) => {
    const freq = 0.01;
    const pts = 120;
    let d = `M 0 ${ghostLevel}`;
    for (let i = 0; i <= pts; i++) {
      const x = (i / pts) * w;
      const y = ghostLevel + Math.sin(x * freq + off + 1) * ghostAmplitude;
      d += ` L ${x} ${y}`;
    }
    return d;
  }};

  const hexSize = 35;

  // Rod positions — 8 wells arranged around center (scaled for 800x700)
  const rodPositions = useMemo(() => {
    const cx = vbW / 2, cy = vbH / 2;
    const radius = 240;
    return Array.from({ length: 8 }, (_, i) => {
      const angle = (i / 8) * Math.PI * 2 - Math.PI / 2;
      return {
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      };
    });
  }, []);

  return (
    <div className="relative w-full h-full flex items-center justify-center overflow-hidden">
      {/* SVG filter defs */}
      <svg className="absolute w-0 h-0">
        <defs>
          {/* Hexagonal floor pattern */}
          <pattern
            id="hexPatternGemini"
            patternUnits="userSpaceOnUse"
            width={hexSize * 1.732}
            height={hexSize * 3}
          >
            <polygon
              points={drawHexagon(0, 0, hexSize)}
              fill="none"
              stroke="#1a1a1a"
              strokeWidth="0.8"
            />
            <polygon
              points={drawHexagon(hexSize * 0.866, hexSize * 1.5, hexSize)}
              fill="none"
              stroke="#1a1a1a"
              strokeWidth="0.8"
            />
          </pattern>

          {/* Liquid gradient */}
          <linearGradient id="coolantGradGemini" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={thermal.surface} stopOpacity="0.8" />
            <stop offset="100%" stopColor={thermal.deep} stopOpacity="1" />
          </linearGradient>

          {/* Rod glow filter */}
          <filter id="rodGlowGemini" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="12" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Reflection blur */}
          <filter id="reflectionBlurGemini" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="15" />
          </filter>

          {/* Heat haze */}
          <filter id="heatHazeGemini" x="-20%" y="-20%" width="140%" height="140%">
            <feTurbulence type="fractalNoise" baseFrequency="0.015" numOctaves="3" result="noise">
              {thermal.state === "critical" && (
                <animate attributeName="baseFrequency" values="0.015;0.04;0.015" dur="1.2s" repeatCount="indefinite" />
              )}
            </feTurbulence>
            <feDisplacementMap in="SourceGraphic" in2="noise" scale={thermal.state === "critical" ? 10 : 0} xChannelSelector="R" yChannelSelector="G" />
          </filter>

          {/* Gauge glow */}
          <filter id="gaugeGlowGemini" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="6" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
      </svg>

      {/* Main SVG */}
      <svg
        viewBox={`0 0 ${vbW} ${vbH}`}
        preserveAspectRatio="xMidYMid slice"
        className="w-full h-full"
        style={{
          filter: thermal.state === "critical" ? "url(#heatHazeGemini)" : undefined,
          transition: "filter 0.8s ease",
        }}
      >
        {/* ── Hexagonal lattice background ── */}
        <rect width="100%" height="100%" fill="url(#hexPatternGemini)" />

        {/* ── Core VRAM Pool (Coolant) ── */}
        <path
          d={generateWavePath(offset, vbW, vbH)}
          fill="url(#coolantGradGemini)"
          opacity={0.35 + vramRatio * 0.45}
          style={{ transition: "opacity 0.5s ease" }}
        />

        {/* ── Ghost rod preview (predicted) ── */}
        {draggedModel && predictiveVramMib > 0 && (
          <path
            d={generateWavePath(offset + 2, vbW, vbH)}
            fill="none"
            stroke={thermal.surface}
            strokeWidth="1.5"
            strokeDasharray="8,5"
            opacity="0.4"
          />
        )}

        {/* ── Criticality Gauge (top-left corner) ── */}
        <g transform="translate(80, 80)">
          {/* Gauge background */}
          <circle cx="0" cy="0" r={80} fill="none" stroke="#1a1a1a" strokeWidth="8" />
          <circle cx="0" cy="0" r={74} fill="none" stroke="#111" strokeWidth="1" />

          {/* Progress arc — VRAM usage */}
          <circle
            cx="0"
            cy="0"
            r={80}
            fill="none"
            stroke={thermal.surface}
            strokeWidth="9"
            strokeDasharray={`${2 * Math.PI * 80 * vramRatio} ${2 * Math.PI * 80}`}
            transform="rotate(-90)"
            filter="url(#gaugeGlowGemini)"
            opacity="0.85"
          >
            {thermal.state === "critical" && (
              <animate attributeName="stroke-opacity" values="0.6;1;0.6" dur="1s" repeatCount="indefinite" />
            )}
          </circle>

          {/* Center text — VRAM % */}
          <text
            x="0"
            y="-5"
            textAnchor="middle"
            dominantBaseline="middle"
            fill={thermal.surface}
            fontSize="32"
            fontFamily="'JetBrains Mono', monospace"
            fontWeight="bold"
            opacity="0.9"
          >
            {Math.round(vramRatio * 100)}%
          </text>
          <text
            x="0"
            y="45"
            textAnchor="middle"
            dominantBaseline="middle"
            fill="#888"
            fontSize="12"
            fontFamily="'JetBrains Mono', monospace"
            letterSpacing="3"
          >
            CRITICALITY
          </text>
        </g>

        {/* ── Rod silhouettes ── */}
        {rodPositions.map((pos, i) => {
          const rodHeight = 165;
          const rodW = 13;
          const topY = pos.y - rodHeight;
          const inLiquid = pos.y > liquidLevel;

          return (
            <g key={`rod-${i}`}>
              {/* Rod body */}
              <ellipse
                cx={pos.x}
                cy={topY}
                rx={rodW + 4}
                ry="8"
                fill={thermal.surface}
                fillOpacity="0.2"
                stroke={thermal.surface}
                strokeWidth="1.5"
                filter="url(#rodGlowGemini)"
              />
              <rect
                x={pos.x - rodW}
                y={topY}
                width={rodW * 2}
                height={rodHeight}
                fill={thermal.surface}
                fillOpacity="0.06"
                stroke={thermal.surface}
                strokeWidth="1.2"
                filter="url(#rodGlowGemini)"
                rx="3"
              />

              {/* Liquid reflection */}
              {inLiquid && (
                <ellipse
                  cx={pos.x}
                  cy={pos.y + 10}
                  rx={rodW * 2.2}
                  ry="14"
                  fill={thermal.surface}
                  fillOpacity="0.35"
                  filter="url(#reflectionBlurGemini)"
                />
              )}
            </g>
          );
        })}

        {/* ── Center info readout ── */}
        <g>
          <text
            x={vbW / 2}
            y={vbH * 0.35}
            textAnchor="middle"
            fill={thermal.surface}
            fontSize="16"
            fontFamily="'JetBrains Mono', monospace"
            fontWeight="bold"
            opacity="0.85"
          >
            {(totalVramUsedMib / 1024).toFixed(1)}GB
          </text>
          <text
            x={vbW / 2}
            y={vbH * 0.35 + 14}
            textAnchor="middle"
            fill="#666"
            fontSize="7"
            fontFamily="'JetBrains Mono', monospace"
            letterSpacing="2"
          >
            VRAM ALLOCATED
          </text>

          {gpus.length > 0 && (
            <>
              <text
                x={vbW / 2}
                y={vbH * 0.35 + 28}
                textAnchor="middle"
                fill={thermal.state === "critical" ? "#FF3300" : thermal.surface}
                fontSize="9"
                fontFamily="'JetBrains Mono', monospace"
                fontWeight="bold"
              >
                {Math.round(thermal.temp)}°C
              </text>
              <text
                x={vbW / 2}
                y={vbH * 0.35 + 40}
                textAnchor="middle"
                fill="#555"
                fontSize="6"
                fontFamily="'JetBrains Mono', monospace"
                letterSpacing="1"
              >
                CORE TEMPERATURE
              </text>
            </>
          )}
        </g>

        {/* ── Bubble particles at critical ── */}
        {thermal.state === "critical" && (
          <BubbleSystemGemini liquidLevel={liquidLevel} vbW={vbW} vbH={vbH} />
        )}

        {/* ── Diagnostic plasma lines ── */}
        {diagnosticMode && gpus.length > 0 && (
          <PlasmaLinesGemini vbW={vbW} vbH={vbH} gpus={gpus} thermal={thermal} />
        )}
      </svg>

      {/* Thermal state badge */}
      <div
        className={`absolute top-4 right-4 px-3 py-1.5 text-[9px] font-mono tracking-widest border transition-all duration-500 ${
          thermal.state === "critical"
            ? "border-red-500/60 text-red-400 bg-red-500/10 animate-pulse shadow-[0_0_15px_rgba(255,34,0,0.3)]"
            : thermal.state === "elevated"
              ? "border-telemetry-cyan/50 text-telemetry-cyan bg-telemetry-cyan/10 shadow-[0_0_10px_rgba(0,229,255,0.2)]"
              : "border-cyan-500/30 text-cyan-400 bg-cyan-500/5"
        }`}
      >
        {thermal.state.toUpperCase()}
      </div>
    </div>
  );
}

/* ── Bubble System (Gemini) ── */
function BubbleSystemGemini({ liquidLevel, vbW, vbH }: { liquidLevel: number; vbW: number; vbH: number }) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 2500);
    return () => clearInterval(id);
  }, []);

  const bubbles = useMemo(() => {
    const result = [];
    for (let i = 0; i < 20; i++) {
      const seed = (i * 137 + tick * 7) % 1000;
      const x = (seed % vbW);
      const yBase = liquidLevel + 20 + (seed % 100);
      const size = 1.5 + (seed % 40) / 10;
      const duration = 1.5 + (seed % 30) / 10;
      const delay = (seed % 20) / 10;
      result.push({ x, y: yBase, size, duration, delay, id: `bub-${i}-${tick}` });
    }
    return result;
  }, [vbW, vbH, liquidLevel, tick]);

  return (
    <g>
      {bubbles.map(b => (
        <circle
          key={b.id}
          cx={b.x}
          cy={b.y}
          r={b.size}
          fill="white"
          opacity="0.6"
          className="animate-bubble-rise"
          style={{ animationDelay: `${b.delay}s`, animationDuration: `${b.duration}s` }}
        />
      ))}
    </g>
  );
}

/* ── Plasma Lines (Gemini) ── */
function PlasmaLinesGemini({ vbW, vbH, gpus, thermal }: { vbW: number; vbH: number; gpus: GpuInfo[]; thermal: any }) {
  const cx = vbW / 2, cy = vbH / 2;
  const lines = [];
  for (let i = 0; i < Math.min(gpus.length, 8); i++) {
    const angle = (i / Math.max(gpus.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const dist = 125;
    const tx = cx + Math.cos(angle) * dist;
    const ty = cy + Math.sin(angle) * dist;
    const memUsed = gpus[i]?.memory_used ?? 0;
    const memTotal = gpus[i]?.memory_total ?? 1;
    const ratio = memUsed / memTotal;

    lines.push(
      <g key={`plasma-${i}`}>
        <line
          x1={cx} y1={cy}
          x2={tx} y2={ty}
          stroke={thermal.glow}
          strokeWidth={1 + ratio * 3}
          strokeDasharray="8,4"
          opacity="0.4"
          className="animate-plasma-flow"
        />
        <line
          x1={cx} y1={cy}
          x2={tx} y2={ty}
          stroke={thermal.glow}
          strokeWidth={3 + ratio * 4}
          opacity="0.08"
          filter="url(#reflectionBlurGemini)"
        />
        <text x={tx + 10} y={ty - 5} fill={thermal.glow} fontSize="6" fontFamily="'JetBrains Mono', monospace" opacity="0.6">
          GPU-{gpus[i]?.index ?? i} | {(gpus[i]?.memory_total / 1024).toFixed(0)}GB | {(gpus[i]?.temperature_gpu ?? "--")}°C
        </text>
        <rect x={tx + 10} y={ty + 5} width="20" height="2" fill="#1a1a1a" opacity="0.5" />
        <rect x={tx + 10} y={ty + 5} width={20 * ratio} height="2" fill={thermal.glow} opacity="0.5" />
      </g>
    );
  }
  return <>{lines}</>;
}
