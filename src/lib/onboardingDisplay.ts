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

/** VramBadge / setup content horizontal padding (px) — `px-3`. */
export const PHOSPHOR_CONTENT_PAD_X_PX = 12;

/** VramBadge / setup content vertical padding (px) — `py-2.5`. */
export const PHOSPHOR_CONTENT_PAD_Y_PX = 10;

/** Welcome splash — square phosphor cap (px); matches `.industrial-display-frame--welcome`. */
export const WELCOME_FRAME_MAX_PX = 560;

/** Reference shell width for static art exports (px). */
export const REFERENCE_SHELL_WIDTH_PX = 1280;

/** Phosphor inner width at reference shell + default split (px). */
export const REFERENCE_PHOSPHOR_WIDTH_PX =
  REFERENCE_SHELL_WIDTH_PX - CATALOG_SPLIT_DEFAULT_PX - DISPLAY_BEZEL_PADDING_PX * 2;
// = 824

/** Square welcome asset — design at this size (scales down on narrow panels). */
export const WELCOME_ART_DESIGN_PX = WELCOME_FRAME_MAX_PX;

/** Phosphor inner square at reference shell (px) — min(panel width, cap). */
export const REFERENCE_WELCOME_INNER_PX = Math.min(REFERENCE_PHOSPHOR_WIDTH_PX, WELCOME_FRAME_MAX_PX);

/** Welcome splash aspect ratio (always 1:1). */
export const WELCOME_ASPECT_RATIO = 1;

/**
 * Phosphor inner height at reference (px).
 * Setup/welcome floor ≈ 240 − 36 bezel − 20 content pad ≈ 184 content;
 * full forecast with 1 GPU ≈ 260–300px inner.
 */
export const REFERENCE_PHOSPHOR_HEIGHT_SETUP_PX = 184;
export const REFERENCE_PHOSPHOR_HEIGHT_FORECAST_PX = 280;

/** Aspect ratio (width ÷ height) for intro art at reference shell. */
export const REFERENCE_ASPECT_SETUP = REFERENCE_PHOSPHOR_WIDTH_PX / REFERENCE_PHOSPHOR_HEIGHT_SETUP_PX;
// ≈ 4.48:1 (wide strip)

export const REFERENCE_ASPECT_FORECAST = REFERENCE_PHOSPHOR_WIDTH_PX / REFERENCE_PHOSPHOR_HEIGHT_FORECAST_PX;
// ≈ 2.94:1