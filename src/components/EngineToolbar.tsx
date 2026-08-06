import type { ReactNode } from "react";
import type { ConfigViewMode } from "../lib/types";
import type { ConfigColumnCount } from "../lib/configColumnLayout";
import type { CtxCockpitDock, LaunchDockPosition } from "../lib/storage";
import ConfigViewToggle from "./ConfigViewToggle";

/**
 * Config toolbar: CONFIG view toggle / FULL AUTO badge, CTX dock placement,
 * launch-dock position + collapse, HW monitor, engines-in-rail, column count,
 * and layout mode. Pure presentational — the orchestrator owns all state and
 * passes slices + setters down.
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
    onSetLaunchDockPosition,
    launchDockCollapsed,
    onToggleLaunchDockCollapsed,
    hwMonitorOpen,
    onToggleHwMonitor,
    showLaunchRail,
    enginesInRail,
    onToggleEnginesInRail,
    hasParams,
    columnCount,
    onSetColumnCount,
    layoutModeActive,
    onToggleLayoutMode,
    presetsSlot,
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
        <div className="config-launch-dock-controls flex items-center gap-1.5 min-w-0">
          <span className="config-panel-toolbar__label">LAUNCH DOCK</span>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => onSetLaunchDockPosition("bottom")}
              className={`config-panel-toolbar-chip px-1.5 py-0.5 text-[8px] font-mono rounded-sm ${
                launchDockPosition === "bottom" ? "config-panel-toolbar-chip--active" : ""
              }`}
              title="Launch dock along the bottom"
            >
              BOTOM
            </button>
            {launchDockPosition === "bottom" && (
              <button
                type="button"
                onClick={onToggleLaunchDockCollapsed}
                className="config-panel-toolbar-chip px-1 py-0.5 text-[8px] font-mono rounded-sm"
                title={
                  launchDockCollapsed
                    ? "Expand launch dock (show custom flags)"
                    : "Collapse launch dock — alias, port, launch only"
                }
              >
                {launchDockCollapsed ? "▼" : "▲"}
              </button>
            )}
            <button
              type="button"
              onClick={() => onSetLaunchDockPosition("right")}
              className={`config-panel-toolbar-chip px-1.5 py-0.5 text-[8px] font-mono rounded-sm ${
                launchDockPosition === "right" ? "config-panel-toolbar-chip--active" : ""
              }`}
              title="Launch rail — full-height column on the right (auto on short viewports until you pick)"
            >
              RIGHT RAIL
            </button>
          </div>
          {!launchDockPositionExplicit && (
            <span className="text-[7px] font-mono text-stealth-muted/40 hidden md:inline shrink-0">
              auto
            </span>
          )}
          <button
            type="button"
            onClick={onToggleHwMonitor}
            className={`config-panel-toolbar-chip px-1.5 py-0.5 text-[8px] font-mono rounded-sm ${
              hwMonitorOpen ? "config-panel-toolbar-chip--active" : ""
            }`}
            title={
              hwMonitorOpen
                ? "HW monitor on — live CPU/GPU stats (CPU polling active)"
                : "HW monitor off — open for live CPU/GPU column (works with BOT or RAIL dock)"
            }
          >
            HW MONITOR
          </button>
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
  onSetLaunchDockPosition: (p: LaunchDockPosition) => void;
  launchDockCollapsed: boolean;
  onToggleLaunchDockCollapsed: () => void;
  hwMonitorOpen: boolean;
  onToggleHwMonitor: () => void;
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
}
