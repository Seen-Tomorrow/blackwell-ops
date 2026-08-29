import type { ReactNode } from "react";
import type { ConfigViewMode } from "../lib/types";
import type { ConfigColumnCount } from "../lib/configColumnLayout";
import type { CtxCockpitDock, HwMonitorDock, LaunchDockPosition } from "../lib/storage";
import ConfigViewToggle from "./ConfigViewToggle";

/**
 * Config toolbar: CONFIG view toggle / FULL AUTO badge, CTX dock placement,
 * launch-dock position (single toggle like CTX), HW monitor, engines-in-rail,
 * column count, and layout mode. Pure presentational — orchestrator owns state.
 */
export default function EngineToolbar(props: EngineToolbarProps) {
  const {
    fullAutoFixed,
    configView,
    onConfigViewChange,
    ctxCockpitDock,
    onToggleCtxDock,
    launchDockPosition,
    launchDockPositionExplicit,
    onToggleLaunchDockPosition,
    hwMonitorOpen,
    hwMonitorDock,
    onCycleHwMonitor,
    showLaunchRail,
    enginesInRail,
    onToggleEnginesInRail,
    hasParams,
    columnCount,
    onSetColumnCount,
    layoutModeActive,
    onToggleLayoutMode,
    presetsSlot,
    seatSaveSlot,
  } = props;

  return (
    <div className="config-panel-toolbar px-4 py-0.5 flex items-center gap-3 flex-shrink-0 border-b section-divider">
      {/* Full Auto = one layout (no Essentials/Full). Assisted keeps the switch. */}
      {!fullAutoFixed && (
        <div className="config-panel-toolbar__config flex items-center gap-1.5 flex-shrink-0">
          <span className="config-panel-toolbar__label">CONFIG</span>
          <ConfigViewToggle view={configView} onChange={onConfigViewChange} />
        </div>
      )}
      {fullAutoFixed && (
        <div className="config-panel-toolbar__config flex items-center gap-1.5 flex-shrink-0">
          <span className="config-panel-toolbar__label text-nv-green/70">FULL AUTO</span>
        </div>
      )}
      {seatSaveSlot}
      {presetsSlot}
      <div className="config-panel-toolbar__chrome flex items-center gap-1.5 min-w-0 ml-auto flex-shrink-0">
        <button
          type="button"
          onClick={onToggleCtxDock}
          className={`config-panel-toolbar-chip px-1.5 py-0.5 text-[8px] font-mono rounded-sm ${
            ctxCockpitDock === "above" ? "config-panel-toolbar-chip--active" : ""
          }`}
          title={
            ctxCockpitDock === "cockpit"
              ? "CTX docked in cockpit — click to place in above-config zone (near VRAM)"
              : "CTX in above-config zone — click to dock inside cockpit"
          }
        >
          CTX {ctxCockpitDock === "cockpit" ? "COCKPIT" : "ABOVE"}
        </button>
        <button
          type="button"
          onClick={onToggleLaunchDockPosition}
          className={`config-panel-toolbar-chip px-1.5 py-0.5 text-[8px] font-mono rounded-sm ${
            launchDockPosition === "right" ? "config-panel-toolbar-chip--active" : ""
          }`}
          title={
            launchDockPosition === "bottom"
              ? "Launch dock along the bottom — click for right rail"
              : "Launch dock as full-height right rail — click for bottom bar"
          }
        >
          LAUNCH {launchDockPosition === "right" ? "RAIL" : "BOTTOM"}
          {!launchDockPositionExplicit ? (
            <span className="opacity-40 ml-0.5 hidden md:inline">·auto</span>
          ) : null}
        </button>
        <div className="config-launch-dock-controls flex items-center gap-1.5 min-w-0">
          {showLaunchRail && (
            <button
              type="button"
              onClick={onToggleEnginesInRail}
              className={`config-panel-toolbar-chip px-1.5 py-0.5 text-[8px] font-mono rounded-sm ${
                enginesInRail ? "config-panel-toolbar-chip--active" : ""
              }`}
              title={
                enginesInRail
                  ? "Engine switcher in launch rail — click to restore below VRAM display"
                  : "Engine switcher below VRAM display — click to move into launch rail"
              }
            >
              ENGINES{enginesInRail ? "↑RAIL" : "↓DSP"}
            </button>
          )}
          <button
            type="button"
            onClick={onCycleHwMonitor}
            className={`config-panel-toolbar-chip px-1.5 py-0.5 text-[8px] font-mono rounded-sm ${
              hwMonitorOpen ? "config-panel-toolbar-chip--active" : ""
            }`}
            title={
              !hwMonitorOpen
                ? "HW monitor off — click for BELOW display"
                : hwMonitorDock === "below"
                  ? "HW monitor below display — click for right RAIL"
                  : "HW monitor in right rail — click to turn off"
            }
          >
            HW {!hwMonitorOpen ? "OFF" : hwMonitorDock === "below" ? "BELOW" : "RAIL"}
          </button>
        </div>
        {hasParams && (
          <>
            <span className="config-panel-toolbar__sep" aria-hidden />
            <div className="config-column-count flex items-center gap-0.5 flex-shrink-0">
              {([1, 2, 3] as ConfigColumnCount[]).map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => onSetColumnCount(n)}
                  className={`config-panel-toolbar-chip config-column-count__btn px-1.5 py-0.5 text-[8px] font-mono rounded-sm ${
                    columnCount === n ? "config-panel-toolbar-chip--active" : ""
                  }`}
                  title={`${n} column${n > 1 ? "s" : ""} below display`}
                >
                  {n}C
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={onToggleLayoutMode}
              className={`config-panel-toolbar-chip config-layout-mode-btn px-2 py-0.5 text-[8px] font-mono rounded-sm ${
                layoutModeActive ? "config-panel-toolbar-chip--active config-layout-mode-btn--on" : ""
              }`}
              title={
                layoutModeActive
                  ? "Layout mode on — drag, pin, and hide groups"
                  : "Edit group layout — reorder, pin above/below, hide"
              }
            >
              LAYOUT{layoutModeActive ? " ON" : ""}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export interface EngineToolbarProps {
  fullAutoFixed: boolean;
  configView: ConfigViewMode;
  onConfigViewChange: (view: ConfigViewMode) => void;
  ctxCockpitDock: CtxCockpitDock;
  onToggleCtxDock: () => void;
  launchDockPosition: LaunchDockPosition;
  launchDockPositionExplicit: boolean;
  /** Cycle bottom ↔ right (same single-toggle pattern as CTX). */
  onToggleLaunchDockPosition: () => void;
  hwMonitorOpen: boolean;
  hwMonitorDock: HwMonitorDock;
  /** Cycle HW monitor OFF → BELOW → RAIL → OFF. Last chrome control before columns. */
  onCycleHwMonitor: () => void;
  showLaunchRail: boolean;
  enginesInRail: boolean;
  onToggleEnginesInRail: () => void;
  /** `allParamsForDisplay.length > 0` — gates column-count + layout mode controls. */
  hasParams: boolean;
  columnCount: ConfigColumnCount;
  onSetColumnCount: (n: ConfigColumnCount) => void;
  layoutModeActive: boolean;
  onToggleLayoutMode: () => void;
  /** Compact PRESETS control (LaunchPresetsMenu). */
  presetsSlot?: ReactNode;
  /** Save current panel config → BRAIN / WORKER seat (left of presets). */
  seatSaveSlot?: ReactNode;
}
