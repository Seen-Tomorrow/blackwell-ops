/**
 * Bottom-bezel density + fusion dual/monitor chips.
 * Same segment-switch language as cockpit / top-bezel Device·Split.
 */

import type { DisplayCardsPerRow, FusionDualOrient, HwMonitorDock } from "../lib/storage";
import { GpuSegmentSwitch } from "./GpuAssignPanel";

export interface DisplayBezelGridControlsProps {
  gpuPerRow: DisplayCardsPerRow;
  enginesPerRow: DisplayCardsPerRow;
  onGpuPerRow: (n: DisplayCardsPerRow) => void;
  onEnginesPerRow: (n: DisplayCardsPerRow) => void;
  /** Hide ENG density when no below-display engines strip. */
  showEnginesControl?: boolean;
  /** Running engines panel currently visible under display. */
  enginesPanelVisible?: boolean;
  onToggleEnginesPanel?: () => void;
  /** Live (RUNNING/LOADING) engine count — enables the monitor CYCLE chip. */
  liveEngineCount?: number;
  /** Cycle selected engine to the next live seat (monitor-mode switcher). */
  onCycleEngine?: () => void;
  /** Dual fusion armed (user intent). */
  dualArmed?: boolean;
  dualActive?: boolean;
  canDual?: boolean;
  onToggleDual?: () => void;
  dualOrient?: FusionDualOrient;
  onToggleOrient?: () => void;
  monitorFocus?: boolean;
  onToggleMonitor?: () => void;
  hwMonitorDock?: HwMonitorDock;
  onToggleHwDock?: () => void;
  /** HW monitor visible (toolbar on/off) — placement chip only shown when open. */
  hwMonitorOpen?: boolean;
}

export default function DisplayBezelGridControls({
  gpuPerRow,
  enginesPerRow,
  onGpuPerRow,
  onEnginesPerRow,
  showEnginesControl = true,
  enginesPanelVisible = true,
  onToggleEnginesPanel,
  liveEngineCount = 0,
  onCycleEngine,
  dualArmed = false,
  dualActive = false,
  canDual = false,
  onToggleDual,
  dualOrient = "side",
  onToggleOrient,
  monitorFocus = false,
  onToggleMonitor,
  hwMonitorDock = "rail",
  onToggleHwDock,
  hwMonitorOpen = false,
}: DisplayBezelGridControlsProps) {
  const showFusionControls = Boolean(onToggleDual || onToggleMonitor || onCycleEngine);

  return (
    <div
      className="industrial-display-frame__bottom-chrome"
      data-frame-bottom-chrome
    >
      <div className="display-bezel-grid-controls flex items-center gap-3 min-w-0">
        <div className="display-bezel-grid-controls__group flex items-center gap-1.5 min-w-0">
          <span className="display-bezel-grid-controls__label font-mono uppercase tracking-wider">
            SHOW GPU
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
              SHOW ENGINES
            </span>
            {onToggleEnginesPanel ? (
              <button
                type="button"
                onClick={onToggleEnginesPanel}
                title={
                  enginesPanelVisible
                    ? "Hide running engines panel"
                    : "Show running engines panel"
                }
                className={`display-bezel-fusion-chip font-mono uppercase tracking-wider${
                  enginesPanelVisible ? " display-bezel-fusion-chip--active" : ""
                }`}
              >
                {enginesPanelVisible ? "ON" : "OFF"}
              </button>
            ) : null}
            {enginesPanelVisible ? (
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
            ) : null}
          </div>
        ) : null}

        {showFusionControls ? (
          <div className="display-bezel-grid-controls__group display-bezel-grid-controls__group--fusion flex items-center gap-1.5 min-w-0 ml-auto">
            {onToggleDual ? (
              <button
                type="button"
                onClick={onToggleDual}
                disabled={!canDual && !dualArmed}
                title={
                  canDual
                    ? dualArmed
                      ? dualActive
                        ? "Dual fusion on — click for single pane"
                        : "Dual armed — waiting for 2 live engines"
                      : "Show two live engines side-by-side / stacked"
                    : dualArmed
                      ? "Dual armed — need 2 running engines"
                      : "Need 2 running engines for dual fusion"
                }
                className={`display-bezel-fusion-chip font-mono uppercase tracking-wider${
                  dualActive
                    ? " display-bezel-fusion-chip--active"
                    : dualArmed
                      ? " display-bezel-fusion-chip--armed"
                      : ""
                }`}
              >
                DUAL
              </button>
            ) : null}
            {onToggleOrient && (dualArmed || dualActive) ? (
              <button
                type="button"
                onClick={onToggleOrient}
                title={
                  dualOrient === "side"
                    ? "Dual layout: side-by-side — click for stack"
                    : "Dual layout: stacked — click for side-by-side"
                }
                className="display-bezel-fusion-chip font-mono uppercase tracking-wider display-bezel-fusion-chip--armed"
              >
                {dualOrient === "side" ? "SIDE" : "STACK"}
              </button>
            ) : null}
            {onToggleMonitor ? (
              <button
                type="button"
                onClick={onToggleMonitor}
                title={
                  monitorFocus
                    ? "Exit monitor focus (show app chrome)"
                    : "Monitor focus — fusion display + HW only"
                }
                className={`display-bezel-fusion-chip font-mono uppercase tracking-wider${
                  monitorFocus ? " display-bezel-fusion-chip--active" : ""
                }`}
              >
                MONITOR
              </button>
            ) : null}
            {onCycleEngine && monitorFocus && !dualActive && liveEngineCount >= 2 ? (
              <button
                type="button"
                onClick={onCycleEngine}
                title="Cycle to the next live engine (RUNNING/LOADING)"
                className="display-bezel-fusion-chip font-mono uppercase tracking-wider"
              >
                CYCLE
              </button>
            ) : null}
            {onToggleHwDock && hwMonitorOpen ? (
              <button
                type="button"
                onClick={onToggleHwDock}
                title={
                  hwMonitorDock === "below"
                    ? "Place HW monitor in right rail"
                    : "Place HW monitor under the fusion display"
                }
                className={`display-bezel-fusion-chip font-mono uppercase tracking-wider${
                  hwMonitorDock === "below" ? " display-bezel-fusion-chip--active" : ""
                }`}
              >
                {hwMonitorDock === "below" ? "BELOW" : "RAIL"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
