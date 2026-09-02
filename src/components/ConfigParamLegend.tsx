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
      className={`inline-flex items-center justify-center min-w-[2rem] px-1.5 py-0.5 type-body font-mono rounded-sm ${className}`}
    >
      {children}
    </span>
  );
}

function LegendRow({ chip, label }: { chip: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="flex-shrink-0 w-14 flex justify-center">{chip}</div>
      <span className="type-tiny font-mono config-muted leading-snug">{label}</span>
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
      <div className="type-micro font-mono config-muted uppercase tracking-widest mb-1.5">
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
        <p className="type-tiny font-mono config-muted leading-relaxed">
          Values shown are your catalog defaults.
          <span className="block mt-1 cfg-acc--a75">
            Unlock <span className="cfg-acc">EDITOR</span> to add, hide, or remove options.
          </span>
          <span className="block mt-1 opacity-70">
            Mistake? <span className="cfg-mut">RESET TO DEFAULTS</span> restores the shipped preset.
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
        className="config-param-legend config-param-legend--collapsed value-chip type-tiny font-mono px-2 py-1 rounded-sm uppercase tracking-widest transition-colors hover:cfg-bord--acc--a40"
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
        className="flex items-center justify-between gap-2 w-full type-micro font-mono config-muted uppercase tracking-widest mb-2 hover:cfg-acc--a80 transition-colors"
        title="Collapse legend"
      >
        <span>Legend</span>
        <span className="type-tiny leading-none opacity-60">▼</span>
      </button>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
        <LegendSection title="Value chips">
          <LegendRow
            chip={
              <LegendChip className="value-chip value-chip--factory-default">
                32K
              </LegendChip>
            }
            label="Default for new launches"
          />
          <LegendRow
            chip={
              <LegendChip className="value-chip value-chip--user-default">
                64K
              </LegendChip>
            }
            label="Default you set (*)"
          />
          <LegendRow
            chip={
              <LegendChip className="value-chip value-chip--user-added">
                custom
              </LegendChip>
            }
            label="Value you added (+ add)"
          />
          <LegendRow
            chip={
              <LegendChip className="value-chip">
                opt
              </LegendChip>
            }
            label="Other available choice"
          />
          <LegendRow
            chip={
              <LegendChip className="value-chip value-chip--hidden line-through opacity-40">
                old
              </LegendChip>
            }
            label="Hidden — click eye to show again"
          />
        </LegendSection>

        <LegendSection title="Controls">
          <LegendRow chip={<span className="type-sm font-mono cfg-acc--a70">*</span>} label="Set as default" />
          <LegendRow chip={<span className="type-sm font-mono cfg-dng">×</span>} label="Remove from your catalog" />
          <LegendRow
            chip={
              <svg width="12" height="12" viewBox="0 0 24 24" className="cfg-acc--a50">
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
          <LegendRow chip={<span className="type-body font-mono cfg-mut">◯</span>} label="Hide whole parameter row" />
          <LegendRow chip={<span className="type-body font-mono cfg-mut">☰</span>} label="Drag to reorder" />
          <LegendRow
            chip={<span className="type-tiny font-mono cfg-acc--a70">ESS</span>}
            label="Include param in engine Essentials (green = on, struck = excluded)"
          />
          <LegendRow
            chip={<span className="type-tiny font-mono cfg-acc--a70">ESS</span>}
            label="On a value bubble: same ESS toggle — hide that value from Essentials only (Full still shows it)"
          />
          <LegendRow chip={<span className="type-md font-mono cfg-acc--a50">E</span>} label="Edit label, group, flags" />
          <LegendRow chip={<span className="type-md font-mono cfg-dng">D</span>} label="Remove parameter" />
          <LegendRow chip={<span className="type-md font-mono cfg-inf">R</span>} label="Restore shipped preset for row" />
          <LegendRow chip={<span className="type-micro font-mono cfg-mut px-1 border cfg-bord rounded-sm">REN</span>} label="Rename group" />
        </LegendSection>
      </div>
      <p className="mt-2 pt-2 border-t cfg-bord--a25 type-micro font-mono config-muted leading-relaxed">
        <span className="cfg-acc">SYSTEM PARAMS</span> section = protected factory groups (flag, not name).
        Expand values, set defaults, hide options; factory chips cannot be deleted (hide only). Engine chrome
        placement is still fixed for Launch panel keys.
      </p>
      <p className="mt-1 type-micro font-mono config-muted leading-relaxed">
        Yellow row border = param you added from catalog. DEV builds can toggle{" "}
        <span className="cfg-mut">DEV EDIT / USER VIEW</span> to preview restrictions.{" "}
        <span className="cfg-mut">RESET TO DEFAULTS</span> undoes everything.
      </p>
    </div>
  );
}