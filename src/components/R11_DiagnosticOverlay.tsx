import type { R11RodHandle } from "../lib/reactor11";

interface Props {
  rods: R11RodHandle[];
}

export default function R11_DiagnosticOverlay({ rods }: Props) {
  const runningRods = rods.filter(r => r.status === "running");

  if (runningRods.length === 0) return null;

  return (
    <div className="absolute inset-0 pointer-events-none z-30">
      {/* HUD overlay container */}
      <svg viewBox="0 0 800 700" className="w-full h-full">
        {/* Grid lines for diagnostic feel */}
        {Array.from({ length: 9 }).map((_, i) => (
          <line key={`grid-h-${i}`} x1={i * 100} y1={0} x2={i * 100} y2={700} stroke="#1a2a4a" strokeWidth="0.3" opacity="0.3" />
        ))}
        {Array.from({ length: 8 }).map((_, i) => (
          <line key={`grid-v-${i}`} x1={0} y1={i * 100} x2={800} y2={i * 100} stroke="#1a2a4a" strokeWidth="0.3" opacity="0.3" />
        ))}

        {/* Rod data labels */}
        {runningRods.map((rod, i) => (
          <RodDiagnosticLabel key={rod.id} rod={rod} offset={i} />
        ))}

        {/* Connection lines between rods and center */}
        {runningRods.map((rod, i) => {
          const angle = (i / Math.max(runningRods.length, 1)) * Math.PI * 2 - Math.PI / 2;
          const x = 400 + Math.cos(angle) * 180;
          const y = 350 + Math.sin(angle) * 180;

          return (
            <g key={`diag-line-${rod.id}`}>
              {/* Plasma connection line */}
              <line
                x1="400" y1="350"
                x2={x} y2={y}
                stroke="#00ff88"
                strokeWidth={rod.allocation.type === "Split" ? 2 : 1}
                strokeDasharray="4,2"
                opacity="0.4"
              >
                <animate attributeName="stroke-dashoffset" values="0;-12" dur="2s" repeatCount="indefinite" />
              </line>

              {/* Split ratio indicator for split allocations */}
              {rod.allocation.type === "Split" && (
                <>
                  <text x={(400 + x) / 2 + 10} y={(350 + y) / 2 - 5} fill="#00e5ff" fontSize="7" fontFamily="'JetBrains Mono', monospace" opacity="0.6">
                    SPLIT
                  </text>
                  <line
                    x1={400} y1="350"
                    x2={x} y2={y}
                    stroke="#ffaa00"
                    strokeWidth="0.5"
                    opacity="0.3"
                    strokeDasharray="2,4"
                  />
                </>
              )}
            </g>
          );
        })}

        {/* System status panel */}
        <rect x="10" y="620" width="280" height="70" rx="2" fill="#0a1628" stroke="#1a2a4a" strokeWidth="0.5" opacity="0.9" />

        <text x="20" y="638" fill="#76B900" fontSize="8" fontFamily="'JetBrains Mono', monospace">
          SYSTEM STATUS
        </text>

        <text x="20" y="654" fill="#4a4a5a" fontSize="7" fontFamily="'JetBrains Mono', monospace">
          RODS: {runningRods.length}/{rods.length} ACTIVE
        </text>

        <text x="140" y="654" fill="#4a4a5a" fontSize="7" fontFamily="'JetBrains Mono', monospace">
          SPLIT: {runningRods.filter(r => r.allocation.type === "Split").length}
        </text>

        <text x="20" y="668" fill="#4a4a5a" fontSize="7" fontFamily="'JetBrains Mono', monospace">
          VRAM: {(rods.reduce((s, r) => s + r.vram_mib, 0) / 1024).toFixed(1)}GB TOTAL
        </text>

        <text x="150" y="668" fill="#4a4a5a" fontSize="7" fontFamily="'JetBrains Mono', monospace">
          CTX: {Math.max(...rods.map(r => r.ctx_size), 0) / 1024}K MAX
        </text>

        {/* Tier indicator */}
        <rect x="690" y="620" width="100" height="70" rx="2" fill="#0a1628" stroke={rods.some(r => r.status === "running") ? "#ff4400" : "#1a2a4a"} strokeWidth="0.5" opacity="0.9" />

        <text x="700" y="638" fill="#ff4400" fontSize="8" fontFamily="'JetBrains Mono', monospace">
          TIER-1 {rods.some(r => r.status === "running") ? "ACTIVE" : "STANDBY"}
        </text>

        <text x="700" y="654" fill="#4a4a5a" fontSize="7" fontFamily="'JetBrains Mono', monospace">
          --perf --poll 100
        </text>

        <text x="700" y="668" fill="#4a4a5a" fontSize="7" fontFamily="'JetBrains Mono', monospace">
          --backend-sampling
        </text>
      </svg>
    </div>
  );
}

function RodDiagnosticLabel({ rod, offset }: { rod: R11RodHandle; offset: number }) {
  // Position labels around the wells in a ring
  const angle = (offset / 8) * Math.PI * 2 - Math.PI / 2;
  const labelRadius = 70;
  const x = 400 + Math.cos(angle) * labelRadius;
  const y = 350 + Math.sin(angle) * labelRadius;

  // Determine text anchor based on position
  const isRight = Math.cos(angle) > 0.1;
  const isLeft = Math.cos(angle) < -0.1;
  const textAnchor: "start" | "middle" | "end" = isRight ? "start" : isLeft ? "end" : "middle";
  const xOffset = isRight ? 8 : isLeft ? -8 : 0;

  return (
    <g>
      {/* Rod ID badge */}
      <rect
        x={x + xOffset - 25}
        y={y - 6}
        width="50"
        height="14"
        rx="2"
        fill="#0a1628"
        stroke={rod.allocation.type === "Split" ? "#ffaa00" : "#1a3a5c"}
        strokeWidth="0.5"
        opacity="0.9"
      />

      <text
        x={x + xOffset}
        y={y + 4}
        textAnchor="middle"
        fill={rod.allocation.type === "Split" ? "#ffaa00" : "#76B900"}
        fontSize="7"
        fontFamily="'JetBrains Mono', monospace"
      >
        {rod.id}
      </text>

      {/* Data readout below badge */}
      <text
        x={x + xOffset}
        y={y + 18}
        textAnchor={textAnchor}
        fill="#4a4a5a"
        fontSize="6"
        fontFamily="'JetBrains Mono', monospace"
        opacity="0.7"
      >
        {rod.gpu_mask} | {rod.quant} | ctx:{rod.ctx_size / 1024}K
      </text>

      {/* Port number */}
      {rod.port > 0 && (
        <text
          x={x + xOffset}
          y={y + 27}
          textAnchor="middle"
          fill="#4a4a5a"
          fontSize="6"
          fontFamily="'JetBrains Mono', monospace"
          opacity="0.5"
        >
          :{rod.port}
        </text>
      )}

      {/* VRAM bar */}
      <rect x={x + xOffset - 20} y={y + 32} width="40" height="2" fill="#1a2a4a" opacity="0.5" />
      <rect
        x={x + xOffset - 20}
        y={y + 32}
        width={Math.min(40, (rod.vram_mib / 98304) * 40)}
        height="2"
        fill="#76B900"
        opacity="0.6"
      />
    </g>
  );
}
