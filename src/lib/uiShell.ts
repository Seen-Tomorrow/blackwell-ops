/** Floor for layout shell / window — panels can collapse, but stay usable. */
export const APP_SHELL_MIN_PX = 960;

/**
 * Ultrawide soft max — only applied when aspect is truly ultrawide (21:9+).
 * 16:9 4K (3840) must fill edge-to-edge; the old 1680 cap left huge side gutters.
 */
export const APP_SHELL_ULTRAWIDE_MAX_PX = 2400;
export const APP_SHELL_VW_RATIO = 0.9;

/**
 * Aspect ≥ this ⇒ ultrawide column layout (cap width, center).
 * 16:9 ≈ 1.78, 16:10 ≈ 1.6, 21:9 ≈ 2.33, 32:9 ≈ 3.5.
 */
export const APP_SHELL_ULTRAWIDE_ASPECT = 2.05;

/** @deprecated Use APP_SHELL_ULTRAWIDE_MAX_PX — kept for any external readers. */
export const APP_SHELL_MAX_PX = APP_SHELL_ULTRAWIDE_MAX_PX;
/** @deprecated Fill is now aspect-based through 4K; no hard width fill cut-off. */
export const APP_SHELL_FILL_MAX_PX = 3840;

/**
 * Fluid shell width in CSS pixels.
 *
 * - Standard 16:9 / 16:10 (incl. 1080p, 1440p, 4K): fill the window edge-to-edge.
 * - Ultrawide (21:9+): cap a readable center column so content does not stretch absurdly.
 */
export function resolveAppShellWidthPx(
  viewportWidth: number,
  viewportHeight = 1080,
): number {
  const aspect = viewportWidth / Math.max(1, viewportHeight);
  const isUltrawide = aspect >= APP_SHELL_ULTRAWIDE_ASPECT;

  if (!isUltrawide) {
    return Math.max(APP_SHELL_MIN_PX, Math.round(viewportWidth));
  }

  const capped = Math.max(
    APP_SHELL_MIN_PX,
    Math.min(viewportWidth * APP_SHELL_VW_RATIO, APP_SHELL_ULTRAWIDE_MAX_PX),
  );
  return Math.min(viewportWidth, Math.round(capped));
}

/**
 * Chrome density for header/footer elements that live *outside* app zoom.
 * App zoom (--ui-text-scale) only scales `.app-main-frame`. Chrome must stay
 * readable at 100% zoom on large DPR-1.0 panels (4K workstation).
 *
 * 1080p ≈ 1.12, 1440p ≈ 1.18, 4K ≈ 1.28 (clamped).
 */
export function resolveChromeScale(viewportWidth: number, viewportHeight = 1080): number {
  // Geometric mean vs 1080p reference — grows gently on large glass.
  const ref = Math.sqrt(
    (Math.max(viewportWidth, 1) / 1920) * (Math.max(viewportHeight, 1) / 1080),
  );
  const scale = 1.1 + (ref - 1) * 0.35;
  return Math.round(Math.min(1.35, Math.max(1.12, scale)) * 100) / 100;
}
