import { useState, type ReactNode } from "react";
import {
  loadConfigParamLegend,
  saveConfigParamLegend,
  type ConfigParamLegendState,
} from "../lib/storage";

interface ConfigParamLegendProps {
  editorUnlocked: boolean;
}

function LegendChip({
  children,
  className,
}: {
  children: ReactNode;
  className: string;
}) {
  return (
    <span
      className={`inline-flex items-center justify-center min-w-[2rem] px-1.5 py-0.5 text-[10px] font-mono rounded-sm ${className}`}
    >
      {children}
    </span>
  );
}

function LegendRow({ chip, label }: { chip: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="flex-shrink-0 w-14 flex justify-center">{chip}</div>
      <span className="text-[8px] font-mono config-muted leading-snug">{label}</span>
    </div>
  );
}

function LegendSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[7px] font-mono config-muted uppercase tracking-widest mb-1.5">
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

/** CONFIG / PARAMETERS — bubble colors and editor controls. */
export default function ConfigParamLegend({ editorUnlocked }: ConfigParamLegendProps) {
  const [expanded, setExpanded] = useState(
    () => loadConfigParamLegend() === "open",
  );

  const setLegendState = (open: boolean) => {
    setExpanded(open);
    const state: ConfigParamLegendState = open ? "open" : "stowed";
    saveConfigParamLegend(state);
  };

  if (!editorUnlocked) {
    return (
      <div className="config-param-legend config-param-legend--locked text-right max-w-[240px]">
        <p className="text-[8px] font-mono config-muted leading-relaxed">
          Values shown are your catalog defaults.
          <span className="block mt-1 text-nv-green/75">
            Unlock <span className="text-nv-green">EDITOR</span> to add, hide, or remove options.
          </span>
          <span className="block mt-1 opacity-70">
            Mistake? <span className="text-stealth-muted">RESET TO DEFAULTS</span> restores the shipped preset.
          </span>
        </p>
      </div>
    );
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setLegendState(true)}
        className="config-param-legend config-param-legend--collapsed value-chip text-[8px] font-mono px-2 py-1 rounded-sm uppercase tracking-widest transition-colors hover:border-nv-green/40"
        title="Show value chip and control legend"
      >
        Legend <span className="ml-1 opacity-60">▶</span>
      </button>
    );
  }

  return (
    <div className="config-param-legend config-form-panel rounded-sm p-2.5 max-w-[420px]">
      <button
        type="button"
        onClick={() => setLegendState(false)}
        className="flex items-center justify-between gap-2 w-full text-[7px] font-mono config-muted uppercase tracking-widest mb-2 hover:text-nv-green/80 transition-colors"
        title="Collapse legend"
      >
        <span>Legend</span>
        <span className="text-[8px] leading-none opacity-60">▼</span>
      </button>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
        <LegendSection title="Value chips">
          <LegendRow
            chip={
              <LegendChip className="bg-nv-green/30 border-double border-2 border-nv-green/70 text-nv-green">
                32K
              </LegendChip>
            }
            label="Default for new launches"
          />
          <LegendRow
            chip={
              <LegendChip className="bg-nv-green/30 border-double border-2 border-yellow-400/80 text-yellow-300">
                64K
              </LegendChip>
            }
            label="Default you set (*)"
          />
          <LegendRow
            chip={
              <LegendChip className="bg-nv-green/10 border border-nv-green/30 text-yellow-300">
                custom
              </LegendChip>
            }
            label="Value you added (+ add)"
          />
          <LegendRow
            chip={
              <LegendChip className="bg-nv-green/10 border border-nv-green/30 text-nv-green/70">
                opt
              </LegendChip>
            }
            label="Other available choice"
          />
          <LegendRow
            chip={
              <LegendChip className="bg-nv-green/8 border border-nv-green/30 text-nv-green line-through opacity-40">
                old
              </LegendChip>
            }
            label="Hidden — click eye to show again"
          />
        </LegendSection>

        <LegendSection title="Controls">
          <LegendRow chip={<span className="text-[11px] font-mono text-nv-green/70">*</span>} label="Set as default" />
          <LegendRow chip={<span className="text-[11px] font-mono text-red-400/70">×</span>} label="Remove from your catalog" />
          <LegendRow
            chip={
              <svg width="12" height="12" viewBox="0 0 24 24" className="text-nv-green/50">
                <path
                  d="M3 12s4-7 9-7 9 7 9 7-4 7-9 7-9-7-9-7z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                />
                <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
            }
            label="Hide or show this value"
          />
          <LegendRow chip={<span className="text-[10px] font-mono text-stealth-muted">◯</span>} label="Hide whole parameter row" />
          <LegendRow chip={<span className="text-[10px] font-mono text-stealth-muted">☰</span>} label="Drag to reorder" />
          <LegendRow
            chip={<span className="text-[8px] font-mono text-nv-green/70">ESS</span>}
            label="Include in MODELS Essentials view (green = on, struck = excluded)"
          />
          <LegendRow chip={<span className="text-[12px] font-mono text-nv-green/50">E</span>} label="Edit label, group, flags" />
          <LegendRow chip={<span className="text-[12px] font-mono text-red-500/50">D</span>} label="Remove parameter" />
          <LegendRow chip={<span className="text-[12px] font-mono text-blue-500/50">R</span>} label="Restore shipped preset for row" />
          <LegendRow chip={<span className="text-[7px] font-mono text-stealth-muted/55 px-1 border border-stealth-border/40 rounded-sm">REN</span>} label="Rename group" />
        </LegendSection>
      </div>
      <p className="mt-2 pt-2 border-t border-stealth-border/25 text-[7px] font-mono config-muted leading-relaxed">
        Blue row = <span className="text-electric-blue/80">SYSTEM</span> engine chrome — edit values and defaults only; group and reorder have no effect on engine placement.
      </p>
      <p className="mt-1 text-[7px] font-mono config-muted leading-relaxed">
        Yellow row border = param you added from catalog. Changes save to your config only —{" "}
        <span className="text-stealth-muted">RESET TO DEFAULTS</span> undoes everything.
      </p>
    </div>
  );
}