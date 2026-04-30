import type { R11RodHandle, R11PredictiveFit } from "../lib/reactor11";

interface Props {
  rods: R11RodHandle[];
  onRemoveRod: (id: string) => void;
  draggedModelPath: string | null;
  predictiveFit: R11PredictiveFit | null;
  isCritical: boolean;
}

// 8 containment wells — evenly spaced circle (r=300) around center (400,400) in square viewport
const WELL_POSITIONS = [
  { x: 400, y: 100, label: "A1" },
  { x: 612, y: 188, label: "A2" },
  { x: 700, y: 400, label: "A3" },
  { x: 612, y: 612, label: "A4" },
  { x: 400, y: 700, label: "A5" },
  { x: 188, y: 612, label: "A6" },
  { x: 100, y: 400, label: "A7" },
  { x: 188, y: 188, label: "A8" },
];

export default function R11_Wells({ rods, onRemoveRod, draggedModelPath, predictiveFit, isCritical }: Props) {
  return (
    <svg viewBox="0 0 800 800" preserveAspectRatio="xMidYMid slice" className="w-full h-full pointer-events-none absolute inset-0">
      {/* SVG connection lines from center to each well */}
      {WELL_POSITIONS.map((pos, i) => (
        <line
          key={`conn-${i}`}
          x1="400" y1="400"
          x2={pos.x} y2={pos.y}
          stroke="#1a2a4a"
          strokeWidth="0.5"
          opacity="0.15"
        />
      ))}

      {/* Well containers — pure SVG, same coordinate space as core */}
      {WELL_POSITIONS.map((pos, i) => {
        const rod = rods.find(r => r.id === `ROD_${pos.label}`);
        const dragOver = draggedModelPath !== null && !rod;

        return (
          <g key={pos.label}>
            {/* Outer ring */}
            <circle
              cx={pos.x} cy={pos.y} r="46"
              fill={rod ? "rgba(118,185,0,0.05)" : dragOver ? "rgba(118,185,0,0.05)" : "rgba(20,30,50,0.4)"}
              stroke={rod && rod.status === "running" ? "rgba(118,185,0,0.5)" : dragOver ? "rgba(118,185,0,0.4)" : "rgba(26,42,74,0.3)"}
              strokeWidth={rod && rod.status === "running" ? 2 : 1}
            />
            {/* Inner ring */}
            <circle
              cx={pos.x} cy={pos.y} r="39"
              fill="none"
              stroke={rod && rod.status === "running" ? "rgba(118,185,0,0.2)" : "rgba(26,42,74,0.2)"}
              strokeWidth="1"
            />
            {/* Label or content */}
            <text x={pos.x} y={pos.y + (rod ? -4 : 3)} textAnchor="middle" dominantBaseline="middle"
              className={`pointer-events-none select-none ${rod ? "text-[8px] font-mono fill-nv-green/80" : "text-[8px] font-mono fill-stealth-muted/40"}`}>
              {rod ? (rod.alias?.length > 12 ? rod.alias.slice(0, 10) + "…" : rod.alias || pos.label) : pos.label}
            </text>
            {/* Remove button */}
            {rod && (
              <g className="cursor-pointer" onClick={(e) => { e.stopPropagation(); onRemoveRod(`ROD_${pos.label}`); }}>
                <circle cx={pos.x + 30} cy={pos.y - 30} r="8" fill="rgba(255,51,51,0.8)" />
                <text x={pos.x + 30} y={pos.y - 30} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="7" fontWeight="bold">✕</text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}
