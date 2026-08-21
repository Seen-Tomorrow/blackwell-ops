/**
 * VRAM forecast / onboarding phosphor screen — art reference sizes.
 *
 * Design for the recessed inner screen (`.phosphor-screen-inner`), not the gunmetal bezel.
 * Width is fluid (catalog split is user-resizable); height is content-driven with a 240px frame floor.
 */

/** Default catalog split at first launch (px). */
export const CATALOG_SPLIT_DEFAULT_PX = 420;

/** Gunmetal frame padding each side (px) — see `.industrial-display-frame`. */
export const DISPLAY_BEZEL_PADDING_PX = 18;

/** Minimum outer frame height in setup/forecast mode (px) — `.industrial-display-frame--setup`. */
export const DISPLAY_FRAME_MIN_HEIGHT_PX = 240;

/**
 * ASSISTED forecast phosphor heights — sized for GPU topo rows, not fusion.
 * 1-row (1–3 GPUs depending on per-row density) is the common case; 2-row only
 * when the bank needs a second line. >2 rows scroll inside the 2-row bank.
 */
export const FORECAST_PHOSPHOR_HEIGHT_1ROW_PX = 228;
export const FORECAST_PHOSPHOR_HEIGHT_2ROW_PX = 280;
/** @deprecated Prefer computeForecastPhosphorHeightPx — kept as 2-row max alias. */
export const FORECAST_PHOSPHOR_HEIGHT_PX = FORECAST_PHOSPHOR_HEIGHT_2ROW_PX;

/** Visible GPU rows for forecast glass (caps at 2; extras scroll). */
export function forecastGpuVisibleRows(gpuCount: number, perRow: 2 | 3 = 2): 1 | 2 {
  const n = Math.max(0, gpuCount | 0);
  if (n <= 1) return 1;
  const cols = perRow === 3 ? 3 : 2;
  const rows = Math.ceil(n / cols);
  return rows <= 1 ? 1 : 2;
}

/** Phosphor inner height for ASSISTED forecast from GPU bank shape. */
export function computeForecastPhosphorHeightPx(gpuCount: number, perRow: 2 | 3 = 2): number {
  return forecastGpuVisibleRows(gpuCount, perRow) === 1
    ? FORECAST_PHOSPHOR_HEIGHT_1ROW_PX
    : FORECAST_PHOSPHOR_HEIGHT_2ROW_PX;
}

/** VramBadge / setup content horizontal padding (px) — `px-3`. */
export const PHOSPHOR_CONTENT_PAD_X_PX = 12;

/** Welcome splash art + frame design size (px); matches `onboarding-intro.webp`. */
export const WELCOME_ART_WIDTH_PX = 1680;
export const WELCOME_ART_HEIGHT_PX = 960;

/** Max rendered frame cap (px) — CSS shrinks below this on smaller viewports/panels. */
export const WELCOME_FRAME_MAX_WIDTH_PX = WELCOME_ART_WIDTH_PX;
export const WELCOME_FRAME_MAX_HEIGHT_PX = WELCOME_ART_HEIGHT_PX;

/** Welcome splash aspect ratio (width ÷ height). */
export const WELCOME_ASPECT_RATIO = WELCOME_ART_WIDTH_PX / WELCOME_ART_HEIGHT_PX;

/** Reference shell width for static art exports (px). */
export const REFERENCE_SHELL_WIDTH_PX = 1280;

/** Phosphor inner width at reference shell + default split (px). */
export const REFERENCE_PHOSPHOR_WIDTH_PX =
  REFERENCE_SHELL_WIDTH_PX - CATALOG_SPLIT_DEFAULT_PX - DISPLAY_BEZEL_PADDING_PX * 2;
// = 824

/** Welcome inner width at reference shell (px) — panel width caps the 1680 design width. */
export const REFERENCE_WELCOME_INNER_PX = Math.min(REFERENCE_PHOSPHOR_WIDTH_PX, WELCOME_FRAME_MAX_WIDTH_PX);

/**
 * Phosphor inner height at reference (px).
 * Setup/welcome floor ≈ 240 − 36 bezel − 20 content pad ≈ 184 content;
 * full forecast with 1 GPU ≈ 260–300px inner.
 */
export const REFERENCE_PHOSPHOR_HEIGHT_SETUP_PX = 184;
export const REFERENCE_PHOSPHOR_HEIGHT_FORECAST_PX = 258;

/** Aspect ratio (width ÷ height) for intro art at reference shell. */
export const REFERENCE_ASPECT_SETUP = REFERENCE_PHOSPHOR_WIDTH_PX / REFERENCE_PHOSPHOR_HEIGHT_SETUP_PX;
// ≈ 4.48:1 (wide strip)

export const REFERENCE_ASPECT_FORECAST = REFERENCE_PHOSPHOR_WIDTH_PX / REFERENCE_PHOSPHOR_HEIGHT_FORECAST_PX;
// ≈ 2.94:1