/** Industrial display surface textures — VRAM bezel + Fusion overlay phosphor screens. */

/** User-facing cycle order (GLITCH CSS remains; not offered in the toggle). */
export const DISPLAY_TEXTURE_ORDER = ["phosphor-dark", "phosphor-light", "clean"] as const;

export type DisplayTexture = (typeof DISPLAY_TEXTURE_ORDER)[number];

export type PhosphorProfile = "dark" | "light";

export const DISPLAY_TEXTURE_LABELS: Record<DisplayTexture, string> = {
  clean: "CLEAN",
  "phosphor-dark": "PHOSPHOR DARK",
  "phosphor-light": "PHOSPHOR LIGHT",
};

/** Compact header picker labels */
export const DISPLAY_TEXTURE_SHORT_LABELS: Record<DisplayTexture, string> = {
  "phosphor-dark": "DARK",
  "phosphor-light": "LIGHT",
  clean: "CLEAN",
};

const LEGACY_TEXTURE_MAP: Record<string, DisplayTexture> = {
  crt: "clean",
  scanline: "clean",
  glitch: "clean",
  dotmatrix: "phosphor-dark",
  grid: "phosphor-dark",
  phosphor: "phosphor-light",
};

export function isPhosphorTexture(texture: DisplayTexture): texture is "phosphor-dark" | "phosphor-light" {
  return texture === "phosphor-dark" || texture === "phosphor-light";
}

export function isDisplayTexture(value: string | null | undefined): value is DisplayTexture {
  return DISPLAY_TEXTURE_ORDER.includes(value as DisplayTexture);
}

export function normalizeDisplayTexture(value: string | null | undefined): DisplayTexture {
  if (isDisplayTexture(value)) return value;
  if (value && value in LEGACY_TEXTURE_MAP) return LEGACY_TEXTURE_MAP[value];
  return "phosphor-dark";
}

export function nextDisplayTexture(current: DisplayTexture): DisplayTexture {
  const idx = DISPLAY_TEXTURE_ORDER.indexOf(current);
  return DISPLAY_TEXTURE_ORDER[(idx + 1) % DISPLAY_TEXTURE_ORDER.length];
}