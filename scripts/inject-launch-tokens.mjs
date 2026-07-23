import fs from "fs";

const p = "src/themes/app-themes.ts";
let s = fs.readFileSync(p, "utf8");

const chipLaunch = `    "--theme-launch-bg": "color-mix(in srgb, var(--theme-chip-solid-bg) 58%, var(--theme-industrial-bg) 42%)",
    "--theme-launch-border": "color-mix(in srgb, var(--theme-chip-active-border) 82%, transparent)",
    "--theme-launch-text": "var(--theme-chip-active-text)",
    "--theme-launch-shadow": "none",
    "--theme-launch-hover-bg": "color-mix(in srgb, var(--theme-chip-solid-bg) 68%, var(--theme-industrial-bg) 32%)",
    "--theme-launch-hover-border": "var(--theme-chip-active-border)",
    "--theme-launch-hover-text": "var(--theme-chip-hover-text)",
    "--theme-launch-active-bg": "color-mix(in srgb, var(--theme-chip-solid-bg) 72%, var(--theme-industrial-bg) 28%)",
    "--theme-launch-active-border": "var(--theme-chip-solid-bg)",
    "--theme-launch-active-text": "var(--theme-chip-solid-text)",
    "--theme-industrial-face-gradient": "none",
`;

const accentLaunch = `    "--theme-launch-bg": "color-mix(in srgb, var(--theme-accent) 58%, var(--theme-industrial-bg) 42%)",
    "--theme-launch-border": "color-mix(in srgb, var(--theme-accent-bright) 78%, transparent)",
    "--theme-launch-text": "var(--theme-accent-bright)",
    "--theme-launch-shadow": "none",
    "--theme-launch-hover-bg": "color-mix(in srgb, var(--theme-accent) 68%, var(--theme-industrial-bg) 32%)",
    "--theme-launch-hover-border": "var(--theme-accent-bright)",
    "--theme-launch-hover-text": "var(--theme-accent-bright)",
    "--theme-launch-active-bg": "color-mix(in srgb, var(--theme-accent) 74%, var(--theme-industrial-bg) 26%)",
    "--theme-launch-active-border": "var(--theme-accent)",
    "--theme-launch-active-text": "var(--theme-selection-text)",
    "--theme-industrial-face-gradient": "none",
`;

const slateLaunch = `    "--theme-launch-bg": "var(--theme-provider-pill-active-bg)",
    "--theme-launch-border": "var(--theme-provider-pill-active-border)",
    "--theme-launch-text": "var(--theme-provider-pill-active-text)",
    "--theme-launch-shadow": "0 0 6px color-mix(in srgb, var(--theme-provider-pill-active-bg) 40%, transparent)",
    "--theme-launch-hover-bg": "color-mix(in srgb, var(--theme-provider-pill-active-bg) 82%, #ffffff 18%)",
    "--theme-launch-hover-border": "var(--theme-provider-pill-hover-border)",
    "--theme-launch-hover-text": "var(--theme-provider-pill-active-text)",
    "--theme-launch-hover-shadow": "0 0 8px color-mix(in srgb, var(--theme-provider-pill-active-bg) 48%, transparent)",
    "--theme-launch-active-bg": "color-mix(in srgb, var(--theme-provider-pill-active-bg) 78%, var(--theme-provider-pill-active-text) 22%)",
    "--theme-launch-active-border": "color-mix(in srgb, var(--theme-provider-pill-active-border) 70%, var(--theme-provider-pill-active-text) 30%)",
    "--theme-launch-active-text": "var(--theme-provider-pill-active-text)",
    "--theme-launch-active-shadow": "0 0 4px color-mix(in srgb, var(--theme-provider-pill-active-bg) 28%, transparent)",
    "--theme-industrial-face-gradient": "none",
`;

const arcticLaunch = `    "--theme-launch-bg": "color-mix(in srgb, var(--theme-chip-solid-bg) 55%, var(--theme-industrial-bg) 45%)",
    "--theme-launch-border": "color-mix(in srgb, var(--theme-accent) 88%, transparent)",
    "--theme-launch-text": "var(--theme-chip-active-text)",
    "--theme-launch-shadow": "none",
    "--theme-launch-hover-bg": "color-mix(in srgb, var(--theme-chip-solid-bg) 65%, var(--theme-industrial-bg) 35%)",
    "--theme-launch-hover-border": "var(--theme-accent)",
    "--theme-launch-hover-text": "var(--theme-chip-hover-text)",
    "--theme-launch-active-bg": "color-mix(in srgb, var(--theme-accent) 58%, var(--theme-industrial-bg) 42%)",
    "--theme-launch-active-border": "var(--theme-chip-active-border)",
    "--theme-launch-active-text": "var(--theme-chip-solid-text)",
    "--theme-industrial-face-gradient": "linear-gradient(175deg, #d6dee6 0%, #b6c2ce 28%, #9aacb8 52%, #b2beca 78%, #c6ced6 100%)",
`;

const blocks = {
  matrix: chipLaunch,
  amber: accentLaunch,
  cyan: accentLaunch,
  slate: slateLaunch,
  arctic: arcticLaunch,
};

if (s.includes("--theme-launch-bg")) {
  console.log("launch tokens already present — skip");
  process.exit(0);
}

for (const [id, block] of Object.entries(blocks)) {
  const re = new RegExp(
    `(id: "${id}"[\\s\\S]*?"--theme-status-nominal": "[^"]+",\\n)`,
  );
  if (!re.test(s)) {
    console.error("no match for", id);
    process.exit(1);
  }
  s = s.replace(re, (m) => m + block);
  console.log("injected", id);
}

fs.writeFileSync(p, s);
console.log("ok");
