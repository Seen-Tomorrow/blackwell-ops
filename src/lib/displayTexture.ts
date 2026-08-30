/** Industrial display surface textures — VRAM bezel + Fusion overlay display screens. */

/** User-facing cycle order (DOTTED + CLEAN). */
export const DISPLAY_TEXTURE_ORDER = ["dotted", "clean"] as const;

export type DisplayTexture = (typeof DISPLAY_TEXTURE_ORDER)[number];

export const DISPLAY_TEXTURE_LABELS: Record<DisplayTexture, string> = {
  dotted: "DOTTED",
  clean: "CLEAN",
};

/** Compact header picker labels */
export const DISPLAY_TEXTURE_SHORT_LABELS: Record<DisplayTexture, string> = {
  dotted: "DOTTED",
  clean: "CLEAN",
};

const LEGACY_TEXTURE_MAP: Record<string, DisplayTexture> = {
  crt: "clean",
  scanline: "clean",
  glitch: "clean",
  dotmatrix: "dotted",
  grid: "dotted",
  phosphor: "dotted",
  "phosphor-dark": "dotted",
  "phosphor-light": "dotted",
};

export function isDisplayTexture(value: string | null | undefined): value is DisplayTexture {
  return DISPLAY_TEXTURE_ORDER.includes(value as DisplayTexture);
}

export function normalizeDisplayTexture(value: string | null | undefined): DisplayTexture {
  if (isDisplayTexture(value)) return value;
  if (value && value in LEGACY_TEXTURE_MAP) return LEGACY_TEXTURE_MAP[value];
  return "dotted";
}

export function nextDisplayTexture(current: DisplayTexture): DisplayTexture {
  const idx = DISPLAY_TEXTURE_ORDER.indexOf(current);
  return DISPLAY_TEXTURE_ORDER[(idx + 1) % DISPLAY_TEXTURE_ORDER.length];
}
