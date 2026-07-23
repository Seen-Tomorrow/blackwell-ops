import fs from "fs";

const p = "src/themes/app-themes.ts";
let s = fs.readFileSync(p, "utf8");

const darkWell = `    "--theme-cockpit-well-shadow": "inset 0 3px 8px color-mix(in srgb, #000000 55%, transparent), inset 0 1px 0 color-mix(in srgb, #000000 40%, transparent), inset 0 -1px 0 color-mix(in srgb, var(--theme-bezel-edge-hi) 35%, transparent), 0 1px 0 color-mix(in srgb, var(--theme-bezel-edge-hi) 25%, transparent)",
    "--theme-cockpit-header-shadow": "inset 0 1px 0 color-mix(in srgb, #ffffff 6%, transparent), inset 0 -1px 0 color-mix(in srgb, #000000 28%, transparent)",
`;

const arcticWell = `    "--theme-cockpit-well-shadow": "inset 0 2px 5px color-mix(in srgb, #2a3848 10%, transparent), inset 0 1px 0 color-mix(in srgb, #2a3848 6%, transparent), inset 0 -1px 0 color-mix(in srgb, #ffffff 50%, transparent), 0 1px 0 color-mix(in srgb, #ffffff 35%, transparent)",
    "--theme-cockpit-header-shadow": "inset 0 1px 0 color-mix(in srgb, #ffffff 55%, transparent), inset 0 -1px 0 color-mix(in srgb, #2a3848 8%, transparent)",
`;

if (s.includes("--theme-cockpit-well-shadow")) {
  console.log("already present");
  process.exit(0);
}

for (const id of ["matrix", "amber", "cyan", "slate"]) {
  const re = new RegExp(
    `(id: "${id}"[\\s\\S]*?"--theme-industrial-face-gradient": "[^"]*",\\n)`,
  );
  if (!re.test(s)) {
    console.error("no match", id);
    process.exit(1);
  }
  s = s.replace(re, (m) => m + darkWell);
  console.log("dark", id);
}

const arcticRe = new RegExp(
  `(id: "arctic"[\\s\\S]*?"--theme-industrial-face-gradient": "[^"]*",\\n)`,
);
if (!arcticRe.test(s)) {
  console.error("no arctic face gradient");
  process.exit(1);
}
s = s.replace(arcticRe, (m) => m + arcticWell);
console.log("arctic well");

// Lighten Arctic phosphor face (CLEAN / display well)
s = s.replace(
  /("--phosphor-bg": ")#8fa0ac(")/,
  "$1#eef2f6$2",
);
s = s.replace(
  /("--phosphor-glow": ")rgba\(91, 158, 196, 0\.14\)(")/,
  "$1rgba(255, 255, 255, 0.55)$2",
);
// only arctic block has these mid values — also bump phosphor text contrast on white
s = s.replace(
  /id: "arctic"[\s\S]*?"--theme-phosphor-text": "#1a3d5c"/,
  (block) =>
    block
      .replace(
        '"--theme-phosphor-text": "#1a3d5c"',
        '"--theme-phosphor-text": "#243044"',
      )
      .replace(
        '"--theme-phosphor-text-muted": "#4a6278"',
        '"--theme-phosphor-text-muted": "#5a6a7c"',
      )
      .replace(
        '"--theme-phosphor-bar-bg": "rgba(91, 158, 196, 0.12)"',
        '"--theme-phosphor-bar-bg": "rgba(36, 48, 68, 0.08)"',
      )
      .replace(
        '"--theme-phosphor-border": "rgba(91, 158, 196, 0.2)"',
        '"--theme-phosphor-border": "rgba(100, 120, 140, 0.22)"',
      )
      .replace(
        '"--theme-phosphor-inset-top": "rgba(80, 100, 120, 0.14)"',
        '"--theme-phosphor-inset-top": "rgba(80, 100, 120, 0.06)"',
      )
      .replace(
        '"--theme-phosphor-inset-bottom": "rgba(80, 100, 120, 0.06)"',
        '"--theme-phosphor-inset-bottom": "rgba(80, 100, 120, 0.03)"',
      ),
);

fs.writeFileSync(p, s);
console.log("ok");
