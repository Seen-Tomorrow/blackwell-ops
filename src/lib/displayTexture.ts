/** Industrial display surface textures — VRAM bezel + Fusion overlay display screens. */

/** User-facing cycle order (DOTTED + CLEAN). */
export const DISPLAY_TEXTURE_ORDER = ["dotted", "clean"] as const;

export type DisplayTexture = (typeof DISPLAY_TEXTURE_ORDER)[number];

/**
 * Display face = the pattern only. `data-display-face` is the single key CSS uses,
 * and it is derived from the texture alone — never from the colour theme.
 *
 * - `dotted` — fake dot-matrix painted on top of the display surfaces.
 * - `clean`  — no rule at all; surfaces show the theme's own colour.
 *
 * Colour, ink, borders and shadows belong to the colour themes (tokens). Texture
 * adds a pattern and nothing else, so dark themes look identical on CLEAN and
 * DOTTED apart from the dots. ARCTIC gets a readable pattern by supplying dark
 * grain tokens, not by having its own face.
 */
export type DisplayFace = "dotted" | "clean";

export function displayFaceFor(texture: string): DisplayFace {
  return texture === "dotted" ? "dotted" : "clean";
}

export const DISPLAY_TEXTURE_LABELS: Record<DisplayTexture, string> = {
  dotted: "DOTTED",
  clean: "CLEAN",
};

/** Compact header picker labels */
export const DISPLAY_TEXTURE_SHORT_LABELS: Record<DisplayTexture, string> = {
  dotted: "DOTTED",
  clean: "CLEAN",
};

export function isDisplayTexture(value: string | null | undefined): value is DisplayTexture {
  return DISPLAY_TEXTURE_ORDER.includes(value as DisplayTexture);
}

export function nextDisplayTexture(current: DisplayTexture): DisplayTexture {
  const idx = DISPLAY_TEXTURE_ORDER.indexOf(current);
  return DISPLAY_TEXTURE_ORDER[(idx + 1) % DISPLAY_TEXTURE_ORDER.length];
}
