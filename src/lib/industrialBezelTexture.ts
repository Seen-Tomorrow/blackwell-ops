/** Dark-theme gunmetal bezel surface patterns (VRAM frame, launch dock, eject panel). */

export const INDUSTRIAL_BEZEL_TEXTURE_ORDER = ["sandblast", "diamond", "brush"] as const;

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

const LEGACY_INDUSTRIAL_BEZEL_TEXTURE: Record<string, IndustrialBezelTexture> = {
  knurl: "diamond",
  vent: "brush",
};

export function isIndustrialBezelTexture(value: string | null | undefined): value is IndustrialBezelTexture {
  return INDUSTRIAL_BEZEL_TEXTURE_ORDER.includes(value as IndustrialBezelTexture);
}

export function normalizeIndustrialBezelTexture(value: string | null | undefined): IndustrialBezelTexture {
  if (isIndustrialBezelTexture(value)) return value;
  if (value && LEGACY_INDUSTRIAL_BEZEL_TEXTURE[value]) return LEGACY_INDUSTRIAL_BEZEL_TEXTURE[value];
  return "diamond";
}

export function nextIndustrialBezelTexture(current: IndustrialBezelTexture): IndustrialBezelTexture {
  const idx = INDUSTRIAL_BEZEL_TEXTURE_ORDER.indexOf(current);
  return INDUSTRIAL_BEZEL_TEXTURE_ORDER[(idx + 1) % INDUSTRIAL_BEZEL_TEXTURE_ORDER.length];
}