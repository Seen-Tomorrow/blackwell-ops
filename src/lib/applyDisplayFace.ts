import { displayFaceFor } from "./displayTexture";

/**
 * The single source of the display face.
 *
 * Face-keyed CSS is written `[data-display-face="…"] <target>`, so it resolves up the
 * ANCESTOR chain. When the attribute existed only on the three display components,
 * every surface without an attributed ancestor — the HW monitor rail, bench widget,
 * fusion booter — matched no face rule at all and rendered unfaced on every theme
 * (measured on the live dev DOM: 242 face rules served, none reachable from the rail).
 * Setting it once on <html> makes all of them resolve.
 *
 * Frame texture already works this way (`IndustrialBezelTextureContext` sets
 * `data-industrial-bezel` on <html>); the display face was the odd one out.
 */
export function applyDisplayFace(themeId: string, texture: string): void {
  document.documentElement.setAttribute(
    "data-display-face",
    displayFaceFor(themeId, texture),
  );
}
