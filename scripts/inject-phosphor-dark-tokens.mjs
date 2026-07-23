import fs from "fs";

const p = "src/themes/app-themes.ts";
let s = fs.readFileSync(p, "utf8");

function injectDark(themeId) {
  const marker = `id: "${themeId}"`;
  const i = s.indexOf(marker);
  if (i < 0) {
    console.error("missing", themeId);
    return;
  }
  const chunkStart = i;
  const chunkEnd = s.indexOf("\nconst ", chunkStart + 1);
  const chunk = s.slice(chunkStart, chunkEnd > 0 ? chunkEnd : s.length);
  if (chunk.includes("--phosphor-bg-dark")) {
    console.log(themeId, "already has phosphor-bg-dark");
    return;
  }
  const bgM = chunk.match(/"--phosphor-bg":\s*"([^"]+)"/);
  const glowM = chunk.match(/"--phosphor-glow":\s*"([^"]+)"/);
  if (!bgM) {
    console.error(themeId, "no phosphor-bg");
    return;
  }
  const bg = bgM[1];
  const glow = glowM ? glowM[1] : "rgba(0,0,0,0.05)";
  const needle = `"--phosphor-bg": "${bg}",`;
  const abs = s.indexOf(needle, chunkStart);
  if (abs < 0) {
    console.error(themeId, "needle fail");
    return;
  }
  const insert = `"--phosphor-bg": "${bg}",
    "--phosphor-bg-dark": "${bg}",`;
  s = s.slice(0, abs) + insert + s.slice(abs + needle.length);
  const glowNeedle = `"--phosphor-glow": "${glow}",`;
  const gAbs = s.indexOf(glowNeedle, abs);
  if (gAbs >= 0 && !s.slice(gAbs, gAbs + 120).includes("phosphor-glow-dark")) {
    s =
      s.slice(0, gAbs) +
      `"--phosphor-glow": "${glow}",
    "--phosphor-glow-dark": "${glow}",` +
      s.slice(gAbs + glowNeedle.length);
  }
  console.log(themeId, "ok", bg);
}

for (const id of ["amber", "cyan", "slate"]) injectDark(id);
fs.writeFileSync(p, s);
