/** Industrial display surface textures — VRAM bezel + Fusion overlay phosphor screens. */

export const DISPLAY_TEXTURE_ORDER = ["clean", "crt", "phosphor-dark", "phosphor-light"] as const;

export type DisplayTexture = (typeof DISPLAY_TEXTURE_ORDER)[number];

export type PhosphorProfile = "dark" | "light";

export const DISPLAY_TEXTURE_LABELS: Record<DisplayTexture, string> = {
  clean: "CLEAN",
  crt: "CRT",
  "phosphor-dark": "PHOSPHOR DARK",
  "phosphor-light": "PHOSPHOR LIGHT",
};

const LEGACY_TEXTURE_MAP: Record<string, DisplayTexture> = {
  scanline: "crt",
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
  return "clean";
}

export function nextDisplayTexture(current: DisplayTexture): DisplayTexture {
  const idx = DISPLAY_TEXTURE_ORDER.indexOf(current);
  return DISPLAY_TEXTURE_ORDER[(idx + 1) % DISPLAY_TEXTURE_ORDER.length];
}