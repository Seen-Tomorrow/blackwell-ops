/**
 * Bottom-bezel density: GPU bars + running engines cards per row (2 | 3).
 * Same segment-switch language as cockpit / top-bezel Device·Split.
 */

import type { DisplayCardsPerRow } from "../lib/storage";
import { GpuSegmentSwitch } from "./GpuAssignPanel";

export interface DisplayBezelGridControlsProps {
  gpuPerRow: DisplayCardsPerRow;
  enginesPerRow: DisplayCardsPerRow;
  onGpuPerRow: (n: DisplayCardsPerRow) => void;
  onEnginesPerRow: (n: DisplayCardsPerRow) => void;
  /** Hide ENG control when no below-display engines strip. */
  showEnginesControl?: boolean;
}

export default function DisplayBezelGridControls({
  gpuPerRow,
  enginesPerRow,
  onGpuPerRow,
  onEnginesPerRow,
  showEnginesControl = true,
}: DisplayBezelGridControlsProps) {
  return (
    <div
      className="industrial-display-frame__bottom-chrome"
      data-frame-bottom-chrome
    >
      <div className="display-bezel-grid-controls flex items-center gap-3 min-w-0">
        <div className="display-bezel-grid-controls__group flex items-center gap-1.5 min-w-0">
          <span className="display-bezel-grid-controls__label font-mono uppercase tracking-wider">
            GPU
          </span>
          <GpuSegmentSwitch
            ariaLabel="VRAM GPU cards per row"
            title="GPU forecast cards per row — 2 or 3 (manual density)"
            options={[
              { id: "2", label: "2", title: "2 per row" },
              { id: "3", label: "3", title: "3 per row" },
            ]}
            selectedId={String(gpuPerRow)}
            onSelect={(id) => onGpuPerRow(id === "3" ? 3 : 2)}
          />
        </div>
        {showEnginesControl ? (
          <div className="display-bezel-grid-controls__group flex items-center gap-1.5 min-w-0">
            <span className="display-bezel-grid-controls__label font-mono uppercase tracking-wider">
              ENG
            </span>
            <GpuSegmentSwitch
              ariaLabel="Running engines cards per row"
              title="Running engines cards per row — 2 or 3 (manual density)"
              options={[
                { id: "2", label: "2", title: "2 per row" },
                { id: "3", label: "3", title: "3 per row" },
              ]}
              selectedId={String(enginesPerRow)}
              onSelect={(id) => onEnginesPerRow(id === "3" ? 3 : 2)}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
