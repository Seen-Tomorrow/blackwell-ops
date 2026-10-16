// ARCHIVED EXPERIMENT — not imported by postcss.config.js.
// Finding (2026-10-16): wrapping partials in native layers changes precedence
// non-visually: unlayered normal rules beat layered normal rules regardless of
// specificity, so Tailwind utilities would defeat high-specificity component
// overrides. Do not enable without a per-rule visual QA pass.import path from "node:path";
import postcss from "postcss";

/**
 * Wrap source partials into native cascade layers without changing their rules.
 *
 * Runs after import inlining and before Tailwind, so Tailwind sees ordinary
 * unlayered @tailwind directives plus our non-Tailwind @layer blocks.
 *
 * Layer order is declared in src/index.css:
 *   @layer bw-tokens, bw-components, bw-utilities;
 *
 * Tailwind's own output stays unlayered on purpose. Unlayered normal rules beat
 * layered normal rules, which preserves the previous precedence of Tailwind
 * base/utilities over the domain partials while making the partials' internal
 * order explicit and independent of @import order.
 */
export default function blackwellTailwindLayers(options = {}) {
  const stylesDir = path.resolve(options.stylesDir ?? path.join(process.cwd(), "src", "styles"));
  const fileLayers = options.layers ?? {
    "tokens-base.css": "bw-tokens",
    "utilities.css": "bw-utilities",
    "type-scale.css": "bw-utilities",
  };
  const defaultLayer = options.defaultLayer ?? "bw-components";

  return {
    postcssPlugin: "blackwell-tailwind-layers",
    Once(root) {
      const layerFor = (node) => {
        const file = node.source?.input?.file;
        if (!file) return null;
        const abs = path.resolve(file);
        if (!abs.startsWith(stylesDir + path.sep)) return null;
        return fileLayers[path.basename(abs)] ?? defaultLayer;
      };

      const original = root.nodes.slice();
      const out = [];
      let group = null;
      let groupLayer = null;
      const flush = () => {
        if (group && group.nodes.length) out.push(group);
        group = null;
        groupLayer = null;
      };

      for (const node of original) {
        if (node.type === "atrule" && ["import", "tailwind", "layer"].includes(node.name)) {
          flush();
          out.push(node);
          continue;
        }
        const layer = layerFor(node);
        if (!layer) {
          flush();
          out.push(node);
          continue;
        }
        if (!group || groupLayer !== layer) {
          flush();
          group = postcss.atRule({ name: "layer", params: layer });
          groupLayer = layer;
        }
        node.remove();
        group.append(node);
      }
      flush();

      root.removeAll();
      for (const node of out) root.append(node);
    },
  };
}
blackwellTailwindLayers.postcss = true;

