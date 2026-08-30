/** Dark-theme gunmetal bezel surface patterns (VRAM frame, launch dock, eject panel). */

export const INDUSTRIAL_BEZEL_TEXTURE_ORDER = ["sandblast", "brush", "diamond"] as const;

export type IndustrialBezelTexture = (typeof INDUSTRIAL_BEZEL_TEXTURE_ORDER)[number];

export const INDUSTRIAL_BEZEL_TEXTURE_LABELS: Record<IndustrialBezelTexture, string> = {
  sandblast: "Sandblast",
  diamond: "Diamond mesh",
  brush: "Brushed metal",
};

export const INDUSTRIAL_BEZEL_TEXTURE_SHORT_LABELS: Record<IndustrialBezelTexture, string> = {
  sandblast: "GRIT",
  diamond: "DIAMOND",
  brush: "BRUSH",
};

export function isIndustrialBezelTexture(value: string | null | undefined): value is IndustrialBezelTexture {
  return INDUSTRIAL_BEZEL_TEXTURE_ORDER.includes(value as IndustrialBezelTexture);
}


export function nextIndustrialBezelTexture(current: IndustrialBezelTexture): IndustrialBezelTexture {
  const idx = INDUSTRIAL_BEZEL_TEXTURE_ORDER.indexOf(current);
  return INDUSTRIAL_BEZEL_TEXTURE_ORDER[(idx + 1) % INDUSTRIAL_BEZEL_TEXTURE_ORDER.length];
}