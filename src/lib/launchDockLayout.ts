/** Launch dock placement — bottom bar or full-height right rail. */
export type LaunchDockPosition = "bottom" | "right";

export const LAUNCH_DOCK_POSITION_DEFAULT: LaunchDockPosition = "bottom";
export const LAUNCH_DOCK_RAIL_WIDTH_DEFAULT = 240;
export const LAUNCH_DOCK_RAIL_WIDTH_MIN = 180;
export const LAUNCH_DOCK_RAIL_WIDTH_MAX = 360;
/** Viewports shorter than this auto-pick right rail when the user has not chosen explicitly. */
export const LAUNCH_DOCK_AUTO_SUGGEST_HEIGHT = 900;

export function suggestLaunchDockPosition(viewportHeight: number): LaunchDockPosition {
  return viewportHeight < LAUNCH_DOCK_AUTO_SUGGEST_HEIGHT ? "right" : "bottom";
}

export function clampLaunchDockRailWidth(width: number): number {
  return Math.min(
    LAUNCH_DOCK_RAIL_WIDTH_MAX,
    Math.max(LAUNCH_DOCK_RAIL_WIDTH_MIN, Math.round(width)),
  );
}