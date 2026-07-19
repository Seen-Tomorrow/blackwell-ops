/** Floor for layout shell / window — panels can collapse, but stay usable. */
export const APP_SHELL_MIN_PX = 960;
export const APP_SHELL_MAX_PX = 1680;
export const APP_SHELL_VW_RATIO = 0.92;
/** Viewports wider than this use the capped ultrawide layout (4K workstation). */
export const APP_SHELL_FILL_MAX_PX = 2560;

/**
 * Fluid shell width in CSS pixels.
 * Laptop / 2560-class: fill viewport edge-to-edge.
 * Ultrawide / super-4K: cap at 1680 so the 4K-composed layout stays centered.
 */
export function resolveAppShellWidthPx(viewportWidth: number): number {
  if (viewportWidth <= APP_SHELL_FILL_MAX_PX) {
    return Math.max(APP_SHELL_MIN_PX, Math.round(viewportWidth));
  }
  const capped = Math.max(
    APP_SHELL_MIN_PX,
    Math.min(viewportWidth * APP_SHELL_VW_RATIO, APP_SHELL_MAX_PX),
  );
  return Math.min(viewportWidth, Math.round(capped));
}