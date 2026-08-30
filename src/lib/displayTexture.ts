/** Industrial display surface textures — VRAM bezel + Fusion overlay display screens. */

/** User-facing cycle order (DOTTED + CLEAN). */
export const DISPLAY_TEXTURE_ORDER = ["dotted", "clean"] as const;

export type DisplayTexture = (typeof DISPLAY_TEXTURE_ORDER)[number];

/**
 * Physical face plate mounted for a (theme, texture) pair — the single key CSS
 * uses for display-surface styling (`data-display-face`). CSS must not fork on
 * [data-theme] + [data-display-texture] directly.
 * - crt:    dark theme + DOTTED (dark CRT dot matrix)
 * - eink:   ARCTIC + DOTTED (light e-ink LCD)
 * - paper:  any theme + CLEAN (theme-colored paper face)
 */
export type DisplayFace = "crt" | "eink" | "paper";

export function displayFaceFor(themeId: string, texture: string): DisplayFace {
  if (texture === "clean") return "paper";
  return themeId === "arctic" ? "eink" : "crt";
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
