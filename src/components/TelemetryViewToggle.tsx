import type { TelemetryViewMode } from "../lib/storage";

interface TelemetryViewToggleProps {
  mode: TelemetryViewMode;
  onChange: (mode: TelemetryViewMode) => void;
  compact?: boolean;
}

export default function TelemetryViewToggle({ mode, onChange, compact = false }: TelemetryViewToggleProps) {
  const buttons = (
    <div className="flex items-center gap-1 flex-shrink-0">
      <button
        type="button"
        onClick={() => onChange("standard")}
        className={`px-2 py-0.5 text-[8px] font-mono tracking-wider rounded-sm border transition-colors focus:outline-none ${
          mode === "standard"
            ? "border-nv-green/50 text-nv-green bg-nv-green/10"
            : "border-stealth-border/50 text-stealth-muted/70 hover:border-stealth-muted hover:text-stealth-muted"
        }`}
      >
        STANDARD
      </button>
      <button
        type="button"
        onClick={() => onChange("lab")}
        className={`px-2 py-0.5 text-[8px] font-mono tracking-wider rounded-sm border transition-colors focus:outline-none ${
          mode === "lab"
            ? "border-telemetry-amber/50 text-telemetry-amber bg-telemetry-amber/10"
            : "border-stealth-border/50 text-stealth-muted/70 hover:border-telemetry-amber/40 hover:text-telemetry-amber/80"
        }`}
      >
        LAB
      </button>
    </div>
  );

  if (compact) return buttons;

  return (
    <div className="flex-shrink-0 flex items-center justify-between gap-3 theme-surface rounded-sm px-3 py-2">
      <div>
        <p className="text-[9px] font-mono text-stealth-muted tracking-wider">TELEMETRY VIEW</p>
        <p className="text-[8px] font-mono text-stealth-muted/60 mt-0.5">
          {mode === "lab"
            ? "Lab catalogue — experimental widgets, independent of POWER USER"
            : "Standard GPU / CPU / system summary"}
        </p>
      </div>
      {buttons}
    </div>
  );
}