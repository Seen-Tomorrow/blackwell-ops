/**
 * Ensure every theme defines DARK CRT grain + ink tokens so CSS never hits
 * guaranteed-invalid custom properties (missing token → no dots rendered).
 */
import fs from "fs";

const p = "src/themes/app-themes.ts";
let s = fs.readFileSync(p, "utf8");

const grains = {
  matrix: {
    text: "#4ade80",
    muted: "#3a6a4a",
    dot: "rgba(74, 222, 128, 0.14)",
    band: "rgba(74, 222, 128, 0.05)",
    glow: "rgba(74, 222, 128, 0.035)",
    bar: "rgba(74, 222, 128, 0.08)",
    border: "rgba(74, 222, 128, 0.12)",
    insetTop: "rgba(0, 0, 0, 0.35)",
    insetBottom: "rgba(0, 0, 0, 0.12)",
  },
  amber: {
    text: "#f5b942",
    muted: "#7a6030",
    dot: "rgba(245, 185, 66, 0.14)",
    band: "rgba(245, 185, 66, 0.05)",
    glow: "rgba(245, 150, 0, 0.06)",
    bar: "rgba(245, 150, 0, 0.1)",
    border: "rgba(245, 150, 0, 0.15)",
    insetTop: "rgba(0, 0, 0, 0.38)",
    insetBottom: "rgba(0, 0, 0, 0.13)",
  },
  cyan: {
    text: "#22d3ee",
    muted: "#2a5a6a",
    dot: "rgba(34, 211, 238, 0.14)",
    band: "rgba(34, 211, 238, 0.05)",
    glow: "rgba(0, 229, 255, 0.05)",
    bar: "rgba(0, 229, 255, 0.08)",
    border: "rgba(0, 229, 255, 0.12)",
    insetTop: "rgba(0, 0, 0, 0.35)",
    insetBottom: "rgba(0, 0, 0, 0.12)",
  },
  slate: {
    text: "#c8c8d0",
    muted: "#6a6a7a",
    dot: "rgba(200, 200, 210, 0.12)",
    band: "rgba(200, 200, 210, 0.04)",
    glow: "rgba(200, 200, 200, 0.05)",
    bar: "rgba(200, 200, 210, 0.08)",
    border: "rgba(200, 200, 210, 0.12)",
    insetTop: "rgba(0, 0, 0, 0.35)",
    insetBottom: "rgba(0, 0, 0, 0.12)",
  },
  arctic: {
    text: "#c8c8d0",
    muted: "#7a7a88",
    // subtle — was heavy grey fog
    dot: "rgba(148, 163, 184, 0.08)",
    band: "rgba(148, 163, 184, 0.03)",
    glow: "rgba(148, 163, 184, 0.04)",
    bar: "rgba(200, 200, 210, 0.08)",
    border: "rgba(200, 200, 210, 0.12)",
    insetTop: "rgba(0, 0, 0, 0.35)",
    insetBottom: "rgba(0, 0, 0, 0.12)",
  },
};

function block(g) {
  return `    "--phosphor-dark-text": "${g.text}",
    "--phosphor-dark-text-muted": "${g.muted}",
    "--phosphor-dark-dot": "${g.dot}",
    "--phosphor-dark-band": "${g.band}",
    "--phosphor-dark-bar-bg": "${g.bar}",
    "--phosphor-dark-border": "${g.border}",
    "--phosphor-dark-inset-top": "${g.insetTop}",
    "--phosphor-dark-inset-bottom": "${g.insetBottom}",
`;
}

for (const [id, g] of Object.entries(grains)) {
  // Remove any existing dark-grain keys in this theme chunk, then re-insert after phosphor-glow-dark
  const idMark = `id: "${id}"`;
  const start = s.indexOf(idMark);
  if (start < 0) {
    console.error("missing", id);
    process.exit(1);
  }
  const nextConst = s.indexOf("\nconst ", start + 1);
  const nextExport = s.indexOf("\nexport ", start + 1);
  const end =
    nextConst > 0
      ? nextConst
      : nextExport > 0
        ? nextExport
        : s.length;
  let chunk = s.slice(start, end);

  const keys = [
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
    chunk = chunk.replace(
      new RegExp(`\\s*"--${k}":\\s*"[^"]*",\\n`, "g"),
      "\n",
    );
  }

  // Prefer after phosphor-glow-dark; else after phosphor-bg-dark
  let needle = chunk.match(/"--phosphor-glow-dark":\s*"[^"]*",\n/);
  if (!needle) needle = chunk.match(/"--phosphor-bg-dark":\s*"[^"]*",\n/);
  if (!needle) {
    console.error("no insert point", id);
    process.exit(1);
  }
  chunk = chunk.replace(needle[0], needle[0] + block(g));

  // Ensure glow-dark exists
  if (!chunk.includes("--phosphor-glow-dark")) {
    chunk = chunk.replace(
      /("--phosphor-glow":\s*"[^"]*",\n)/,
      `$1    "--phosphor-glow-dark": "${g.glow}",\n`,
    );
  }

  s = s.slice(0, start) + chunk + s.slice(end);
  console.log("ok", id);
}

fs.writeFileSync(p, s);
console.log("written");
