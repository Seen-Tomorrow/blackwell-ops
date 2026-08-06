/**
 * Compact Launch toolbar control: PRESETS dropdown + Save + Manage.
 */

import { useEffect, useRef, useState } from "react";
import type { ComboPreset } from "../lib/launchPresets";

export type LaunchPresetsMenuProps = {
  combos: ComboPreset[];
  disabled?: boolean;
  onApply: (combo: ComboPreset, opts: { loadIntoPanel: boolean }) => void;
  onSaveSolo: () => void;
  onSaveTwin: () => void;
  onManage: () => void;
  canSaveSolo?: boolean;
  canSaveTwin?: boolean;
};

export default function LaunchPresetsMenu({
  combos,
  disabled,
  onApply,
  onSaveSolo,
  onSaveTwin,
  onManage,
  canSaveSolo = true,
  canSaveTwin = false,
}: LaunchPresetsMenuProps) {
  const [open, setOpen] = useState(false);
  const [loadIntoPanel, setLoadIntoPanel] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={rootRef} className="launch-presets-menu relative flex items-center gap-1 flex-shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`config-panel-toolbar-chip px-1.5 py-0.5 text-[8px] font-mono rounded-sm ${
          open ? "config-panel-toolbar-chip--active" : ""
        }`}
        title="Launch combos — solo / twin recipes"
      >
        PRESETS {open ? "▲" : "▼"}
      </button>

      {open && (
        <div
          className="launch-presets-menu__panel absolute top-full left-0 z-50 mt-0.5 min-w-[220px] max-w-[300px] border border-stealth-border/50 bg-stealth-panel shadow-lg font-mono text-[9px]"
          role="menu"
        >
          <div className="px-2 py-1.5 border-b border-stealth-border/40 flex items-center gap-2">
            <label className="flex items-center gap-1 text-stealth-muted cursor-pointer select-none">
              <input
                type="checkbox"
                checked={loadIntoPanel}
                onChange={(e) => setLoadIntoPanel(e.target.checked)}
                className="accent-nv-green"
              />
              Also load into panel
            </label>
          </div>

          <div className="max-h-[200px] overflow-y-auto">
            {combos.length === 0 && (
              <p className="px-2 py-2 text-stealth-muted/60 m-0">No presets yet — save solo or twin.</p>
            )}
            {combos.map((c) => (
              <button
                key={c.id}
                type="button"
                role="menuitem"
                className="w-full text-left px-2 py-1.5 hover:bg-nv-green/10 flex items-center gap-2 border-b border-stealth-border/20"
                onClick={() => {
                  setOpen(false);
                  onApply(c, { loadIntoPanel });
                }}
              >
                <span className="text-nv-green/80 uppercase shrink-0 w-8">
                  {c.kind === "twin" ? "Twin" : c.kind === "multi" ? "Multi" : "Solo"}
                </span>
                <span className="truncate text-stealth-text">{c.name}</span>
              </button>
            ))}
          </div>

          <div className="border-t border-stealth-border/40 p-1 flex flex-col gap-0.5">
            <button
              type="button"
              disabled={!canSaveSolo}
              className="text-left px-2 py-1 hover:bg-nv-green/10 disabled:opacity-40"
              onClick={() => {
                setOpen(false);
                onSaveSolo();
              }}
            >
              + Save current seat (solo)
            </button>
            <button
              type="button"
              disabled={!canSaveTwin}
              className="text-left px-2 py-1 hover:bg-nv-green/10 disabled:opacity-40"
              title={canSaveTwin ? "Save from two Running engines" : "Need ≥2 Running engines"}
              onClick={() => {
                setOpen(false);
                onSaveTwin();
              }}
            >
              + Save twin from running…
            </button>
            <button
              type="button"
              className="text-left px-2 py-1 hover:bg-nv-green/10 text-nv-green/90"
              onClick={() => {
                setOpen(false);
                onManage();
              }}
            >
              Manage presets…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
