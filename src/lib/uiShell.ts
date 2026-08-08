/** Floor for layout shell / window — panels can collapse, but stay usable. */
export const APP_SHELL_MIN_PX = 960;

/**
 * Comfortable max for normal 16:9 / 16:10 desktops.
 * - Fills 1080p / 1440p / common 2560-class windows edge-to-edge.
 * - Caps native 4K (3840) so the cockpit does not stretch into a billboard
 *   (old 1680 was too narrow / fat gutters; full 3840 felt ridiculous).
 */
export const APP_SHELL_STANDARD_MAX_PX = 2560;

/**
 * Ultrawide (21:9+) soft max — slightly tighter than standard so a center
 * column stays readable on super-wide glass.
 */
export const APP_SHELL_ULTRAWIDE_MAX_PX = 2400;
export const APP_SHELL_VW_RATIO = 0.9;

/**
 * Aspect ≥ this ⇒ ultrawide column layout.
 * 16:9 ≈ 1.78, 16:10 ≈ 1.6, 21:9 ≈ 2.33, 32:9 ≈ 3.5.
 */
export const APP_SHELL_ULTRAWIDE_ASPECT = 2.05;

/** @deprecated Prefer APP_SHELL_STANDARD_MAX_PX / APP_SHELL_ULTRAWIDE_MAX_PX. */
export const APP_SHELL_MAX_PX = APP_SHELL_STANDARD_MAX_PX;
/** @deprecated Fill is min(viewport, standard/ultrawide max). */
export const APP_SHELL_FILL_MAX_PX = APP_SHELL_STANDARD_MAX_PX;

/**
 * Fluid shell width in CSS pixels.
 *
 * - Below the aspect max: fill the window (1080p / 1440p / ≤2560).
 * - Above: center a capped column (4K 16:9 → 2560; ultrawide → 2400).
 */
export function resolveAppShellWidthPx(
  viewportWidth: number,
  viewportHeight = 1080,
): number {
  const aspect = viewportWidth / Math.max(1, viewportHeight);
  const isUltrawide = aspect >= APP_SHELL_ULTRAWIDE_ASPECT;
  const maxPx = isUltrawide ? APP_SHELL_ULTRAWIDE_MAX_PX : APP_SHELL_STANDARD_MAX_PX;

  if (viewportWidth <= maxPx) {
    return Math.max(APP_SHELL_MIN_PX, Math.round(viewportWidth));
  }

  // Soft ease toward the cap so mid-size windows are not a hard cliff.
  const eased = Math.min(viewportWidth * APP_SHELL_VW_RATIO, maxPx);
  return Math.max(APP_SHELL_MIN_PX, Math.round(eased));
}

/**
 * Chrome density for header/footer elements that live *outside* app zoom.
 * App zoom (--ui-text-scale) only scales `.app-main-frame`. Chrome must stay
 * readable at 100% zoom on large DPR-1.0 panels (4K workstation).
 *
 * 1080p ≈ 1.12, 1440p ≈ 1.18, 4K ≈ 1.28 (clamped).
 */
export function resolveChromeScale(viewportWidth: number, viewportHeight = 1080): number {
  const ref = Math.sqrt(
    (Math.max(viewportWidth, 1) / 1920) * (Math.max(viewportHeight, 1) / 1080),
  );
  const scale = 1.1 + (ref - 1) * 0.35;
  return Math.round(Math.min(1.35, Math.max(1.12, scale)) * 100) / 100;
}
