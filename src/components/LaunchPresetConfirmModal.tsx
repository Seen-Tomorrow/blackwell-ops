/**
 * Compact YES/NO summary before applying a launch combo.
 * Avoids accidental multi-engine Full Auto stampede.
 */

import type { ComboPreset } from "../lib/launchPresets";
import {
  estimateComboMemory,
  formatGb,
} from "../lib/launchPresets";

export type LaunchPresetConfirmModalProps = {
  open: boolean;
  combo: ComboPreset | null;
  loadIntoPanel: boolean;
  models: Array<{ path: string; metadata?: { file_size_bytes?: number }; name?: string }>;
  onLoadIntoPanelChange: (v: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function LaunchPresetConfirmModal({
  open,
  combo,
  loadIntoPanel,
  models,
  onLoadIntoPanelChange,
  onConfirm,
  onCancel,
}: LaunchPresetConfirmModalProps) {
  if (!open || !combo) return null;

  const mem = estimateComboMemory(combo, models);
  const agents =
    combo.harness?.agentsOverride
    ?? combo.seats.find((s) => s.role === "worker")?.paramOverrides?.parallel
    ?? combo.seats[0]?.paramOverrides?.parallel
    ?? "—";

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/70"
      role="presentation"
      onClick={onCancel}
    >
      <div
        className="w-[min(420px,94vw)] border border-stealth-border/60 rounded-sm font-mono text-[10px] shadow-xl text-stealth-text"
        style={{ backgroundColor: "var(--color-stealth-panel, #111810)" }}
        role="dialog"
        aria-labelledby="preset-confirm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-3 py-2 border-b border-stealth-border/50 flex items-center gap-2">
          <h2
            id="preset-confirm-title"
            className="m-0 text-[11px] tracking-widest uppercase text-nv-green/90"
          >
            Apply preset
          </h2>
          <span className="text-[8px] uppercase text-stealth-muted/60">{combo.kind}</span>
        </header>

        <div className="px-3 py-3 space-y-2">
          <p className="m-0 text-[12px] text-stealth-text font-medium truncate" title={combo.name}>
            {combo.name}
          </p>

          <ul className="m-0 pl-0 list-none space-y-1">
            {mem.seats.map((s) => (
              <li
                key={s.seatId}
                className="flex items-center gap-2 border border-stealth-border/30 rounded-sm px-2 py-1"
                style={{ backgroundColor: "color-mix(in srgb, #000 20%, var(--color-stealth-panel, #111810))" }}
              >
                <span className="text-nv-green/80 uppercase w-14 shrink-0">{s.role}</span>
                <span className="truncate flex-1 min-w-0">{s.label}</span>
                <span className="tabular-nums text-stealth-muted shrink-0">
                  ~{formatGb(s.vramGb)}
                </span>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-stealth-muted pt-1">
            <span>
              Est. VRAM{" "}
              <strong className="text-stealth-text tabular-nums">~{formatGb(mem.totalVramGb)}</strong>
              <span className="opacity-50"> (weights×1.12)</span>
            </span>
            <span>
              Agents <strong className="text-stealth-text">×{agents}</strong>
            </span>
            {combo.sequenceBrainFirst && (
              <span className="text-yellow-400/80">BRAIN first</span>
            )}
          </div>

          <label className="flex items-center gap-2 cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={loadIntoPanel}
              onChange={(e) => onLoadIntoPanelChange(e.target.checked)}
              className="accent-nv-green"
            />
            <span className="text-stealth-muted">Also load into Launch panel</span>
          </label>
        </div>

        <footer className="px-3 py-2 border-t border-stealth-border/50 flex justify-end gap-2">
          <button
            type="button"
            className="config-panel-toolbar-chip px-3 py-1"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="config-panel-toolbar-chip config-panel-toolbar-chip--active px-3 py-1"
            onClick={onConfirm}
          >
            Launch
          </button>
        </footer>
      </div>
    </div>
  );
}
