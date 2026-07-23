/**
 * Remove per-theme DARK CRT grain tokens — style is shared in CSS (ARCTIC reference).
 * Keep --phosphor-bg / --phosphor-glow for CLEAN face only.
 */
import fs from "fs";

const p = "src/themes/app-themes.ts";
let s = fs.readFileSync(p, "utf8");

const keys = [
  "phosphor-bg-dark",
  "phosphor-glow-dark",
  "phosphor-dark-text",
  "phosphor-dark-text-muted",
  "phosphor-dark-dot",
  "phosphor-dark-band",
  "phosphor-dark-bar-bg",
  "phosphor-dark-border",
  "phosphor-dark-inset-top",
  "phosphor-dark-inset-bottom",
];

for (const k of keys) {
  const re = new RegExp(`\\s*"--${k}":\\s*"[^"]*",\\n`, "g");
  const n = (s.match(re) || []).length;
  s = s.replace(re, "\n");
  console.log("stripped", k, n);
}

// Collapse excess blank lines inside objects a bit
s = s.replace(/\n{3,}/g, "\n\n");
fs.writeFileSync(p, s);
console.log("done");
