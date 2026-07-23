/**
 * One-shot CSS theme refactor:
 * 1. Strip [data-theme=…] / html:not([data-theme…]) component forks
 * 2. Drop dead R11 animation block
 * 3. Unify ignite/launch + display-texture toggles on tokens
 * 4. Split into src/styles/*.css domain partials
 * 5. Leave src/index.css as @import entry + tailwind
 *
 * Run: node scripts/css-theme-refactor.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CSS_PATH = path.join(ROOT, "src", "index.css");
const STYLES_DIR = path.join(ROOT, "src", "styles");

const css = fs.readFileSync(CSS_PATH, "utf8");
const lines = css.split(/\r?\n/);

function skipBlock(start) {
  let depth = 0;
  let j = start;
  let seen = false;
  for (; j < lines.length; j++) {
    for (const ch of lines[j]) {
      if (ch === "{") {
        depth++;
        seen = true;
      }
      if (ch === "}") depth--;
    }
    if (seen && depth === 0) return j;
  }
  return lines.length - 1;
}

function selectorSpan(i) {
  let j = i;
  let sel = lines[j];
  if (sel.includes("{")) return { brace: i, selector: sel };
  while (j + 1 < lines.length && !lines[j].includes("{")) {
    j++;
    sel += "\n" + lines[j];
  }
  return { brace: j, selector: sel };
}

const isThemeSel = (s) =>
  /\[data-theme\s*=/.test(s) || /html:not\(\s*\[data-theme/.test(s);

const kept = [];
let i = 0;
let removedTheme = 0;

while (i < lines.length) {
  const line = lines[i];
  const maybe =
    /\[data-theme/.test(line) || /html:not\(\s*\[data-theme/.test(line);
  if (!maybe) {
    kept.push(line);
    i++;
    continue;
  }
  const { brace, selector } = selectorSpan(i);
  if (!isThemeSel(selector)) {
    kept.push(line);
    i++;
    continue;
  }
  const end = skipBlock(brace);
  removedTheme += end - i + 1;
  i = end + 1;
}

let out = kept.join("\n");

// Drop R11 sidebar animation block (dead module)
out = out.replace(
  /\/\*\s*── R11_Sidebar animations[\s\S]*?(?=\/\*\s*── ModelHubSearch animations)/,
  "",
);

// Drop leftover keyframes only used by theme forks
out = out.replace(
  /@keyframes launchAckPulse(?:Chip|Accent|Slate|Arctic)\s*\{[\s\S]*?\n\}\n*/g,
  "",
);

// Remove old thin .ignite-btn base (replaced below)
out = out.replace(
  /\/\*\s*Ignite[^*]*\*\/\s*\.ignite-btn\s*\{[\s\S]*?\n\}\n*/,
  "",
);

const unifiedIgnite = `
/* Ignite / launch — all themes via --theme-launch-* tokens (see app-themes.ts) */
.ignite-btn,
[data-config-panel] .config-launch-btn {
  background: var(--theme-launch-bg);
  border: 1px solid var(--theme-launch-border);
  color: var(--theme-launch-text);
  box-shadow: var(--theme-launch-shadow, none);
  text-transform: uppercase;
  font-weight: 600;
  position: relative;
  transition: border-color 0.12s ease, background-color 0.12s ease, color 0.12s ease, box-shadow 0.12s ease;
}

.ignite-btn:hover:not(:disabled),
[data-config-panel] .config-launch-btn:hover:not(:disabled) {
  background: var(--theme-launch-hover-bg);
  border-color: var(--theme-launch-hover-border);
  color: var(--theme-launch-hover-text);
  box-shadow: var(--theme-launch-hover-shadow, var(--theme-launch-shadow, none));
}

.ignite-btn:active:not(:disabled),
[data-config-panel] .config-launch-btn:active:not(:disabled) {
  background: var(--theme-launch-active-bg);
  border-color: var(--theme-launch-active-border);
  color: var(--theme-launch-active-text);
  box-shadow: var(--theme-launch-active-shadow, none);
}

@keyframes launchAckPulse {
  0%, 100% {
    border-color: var(--theme-launch-border);
    background-color: var(--theme-launch-bg);
    color: var(--theme-launch-text);
  }
  40% {
    border-color: var(--theme-launch-hover-border);
    background-color: var(--theme-launch-hover-bg);
    color: var(--theme-launch-hover-text);
  }
}

.ignite-btn.launch-ack {
  animation: launchAckPulse 0.14s ease-out;
}
`;

if (out.includes("/* Provider pill button")) {
  out = out.replace(
    "/* Provider pill button",
    unifiedIgnite + "\n/* Provider pill button",
  );
} else {
  out += "\n" + unifiedIgnite;
}

// Theme-aware display / bezel texture toggles
out = out.replace(
  /\.display-texture-toggle,\s*\.industrial-bezel-texture-toggle\s*\{[\s\S]*?\n\}\n+\.display-texture-toggle:hover,[\s\S]*?outline-offset:\s*2px;\n\}/,
  `.display-texture-toggle,
.industrial-bezel-texture-toggle {
  font-family: ui-monospace, monospace;
  font-size: 6px;
  font-weight: 500;
  letter-spacing: 0.1em;
  line-height: 1.2;
  padding: 2px 8px;
  border: 1px solid var(--theme-chrome-control-border);
  border-radius: 4px;
  background: transparent;
  color: var(--theme-chrome-control-text);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.display-texture-toggle:hover,
.industrial-bezel-texture-toggle:hover {
  background: var(--theme-nav-hover-bg);
  color: var(--theme-chrome-control-hover);
}

.display-texture-toggle:focus-visible,
.industrial-bezel-texture-toggle:focus-visible {
  outline: 1px solid var(--theme-chrome-control-hover);
  outline-offset: 2px;
}`,
);

// Industrial face gradient layer (arctic aluminium, dark optional face)
out = out.replace(
  /\.industrial-display-frame::before \{[\s\S]*?background-image: var\(--theme-industrial-texture-active\);\n\}/,
  `.industrial-display-frame::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  border-radius: inherit;
  background-color: var(--theme-industrial-bg);
  background-image:
    var(--theme-industrial-texture-active),
    var(--theme-industrial-face-gradient, none);
}`,
);

out = out.replace(
  /\.industrial-eject-panel::before \{[\s\S]*?background-image: var\(--theme-industrial-texture-active\);\n\}/,
  `.industrial-eject-panel::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  border-radius: inherit;
  background-color: var(--theme-industrial-bg);
  background-image:
    var(--theme-industrial-texture-active),
    var(--theme-industrial-face-gradient, none);
}`,
);

// Config provider bar: use industrial face tokens when set
out = out.replace(
  /(\.config-provider-profile-bar\s*\{[^}]*background[^;]*;)/,
  (m) => m, // leave structure; optional later
);

// Collapse excessive blank lines
out = out.replace(/\n{4,}/g, "\n\n\n");

// --- Split into domain partials by section comments ---
const sectionMarkers = [
  { re: /^\/\*\s*── Stealth/, file: "tokens-base.css" },
  { re: /^\/\*\s*── Utility/, file: "utilities.css" },
  { re: /^\/\*\s*── App chrome/, file: "chrome.css" },
  { re: /^\/\*\s*── E-ink Panel Wrapper/, file: "catalog.css" },
  { re: /^\/\*\s*── Full Auto cockpit/, file: "cockpit.css" },
  { re: /^\/\*\s*── DFlash draft/, file: "cockpit.css" },
  { re: /^\/\*\s*── CockpitSlider/, file: "cockpit.css" },
  { re: /^\/\*\s*── Launch button ack/, file: "launch.css" },
  { re: /^\/\*\s*── Toast/, file: "chrome.css" },
  { re: /^\/\*\s*── Status bar/, file: "chrome.css" },
  { re: /^\/\*\s*── E-ink Scrollbar/, file: "catalog.css" },
  { re: /^\/\*\s*── Runtime docked/, file: "config.css" },
  { re: /^\/\*\s*── Mono panel/, file: "config.css" },
  { re: /^\/\*\s*── VRAM forecast/, file: "fusion-display.css" },
  { re: /^\/\*\s*── Industrial display unit/, file: "fusion-display.css" },
  { re: /^\/\*\s*── Industrial Display Frame/, file: "fusion-display.css" },
  { re: /^\/\*\s*── Blackwell Output Console/, file: "console.css" },
  { re: /^\/\*\s*── Share capture only/, file: "fusion-display.css" },
  { re: /^\/\*\s*── Display texture toggle/, file: "fusion-display.css" },
  { re: /^\/\*\s*── Phosphor screen/, file: "fusion-display.css" },
  { re: /^\/\*\s*── Fusion share card/, file: "fusion-display.css" },
  { re: /^\/\*\s*── Provider \+ runtime profile/, file: "config.css" },
  { re: /^\/\*\s*── GPU assign/, file: "config.css" },
  { re: /^\/\*\s*── Pinned param/, file: "config.css" },
  { re: /^\/\*\s*── Power-user group/, file: "config.css" },
  { re: /^\/\*\s*── Launch dock layout/, file: "launch.css" },
  { re: /^\/\*\s*── Launch rail/, file: "launch.css" },
  { re: /^\/\*\s*── Launch dock - left/, file: "launch.css" },
  { re: /^\/\*\s*── Eject panel/, file: "config.css" },
  { re: /^\/\*\s*── Running engines panel/, file: "config.css" },
  { re: /^\/\*\s*── Running engines - black/, file: "config.css" },
  { re: /^\/\*\s*── Gunmetal Card/, file: "config.css" },
  { re: /^\/\*\s*── E-ink Panel - parameters/, file: "config.css" },
  { re: /^\/\*\s*── Engine Stack page/, file: "catalog.css" },
  { re: /^\/\*\s*── Shared theme surfaces/, file: "surfaces.css" },
  { re: /^\/\*\s*── Intel feed/, file: "intel.css" },
  { re: /^\/\*\s*── Amber label/, file: "config.css" },
  { re: /^\/\*\s*── Custom Flags/, file: "config.css" },
  { re: /^\/\*\s*── CONFIG page/, file: "config.css" },
  { re: /^\/\*\s*── Config panel root/, file: "config.css" },
  { re: /^\/\*\s*── Selected model card/, file: "config.css" },
  { re: /^\/\*\s*── Select option/, file: "config.css" },
  { re: /^\/\*\s*── MOE Suggestion/, file: "config.css" },
  { re: /^\/\*\s*── Fusion overlay/, file: "fusion-display.css" },
  { re: /^\/\*\s*── Dock expanded/, file: "console.css" },
  { re: /^\/\*\s*── Speculative Decoding/, file: "config.css" },
  { re: /^\/\*\s*── CTX slider/, file: "config.css" },
  { re: /^\/\*\s*── Slider Param/, file: "config.css" },
  { re: /^\/\*\s*── FusionOverlay animations/, file: "animations.css" },
  { re: /^\/\*\s*── EngineBanner animations/, file: "animations.css" },
  { re: /^\/\*\s*── GpuTopology animations/, file: "animations.css" },
  { re: /^\/\*\s*── Layout animations/, file: "animations.css" },
  { re: /^\/\*\s*── EngineConfigPanel animations/, file: "animations.css" },
  { re: /^\/\*\s*── MiniModelCard animations/, file: "animations.css" },
  { re: /^\/\*\s*── RunningEnginesPanel animations/, file: "animations.css" },
  { re: /^\/\*\s*── ModelHubSearch animations/, file: "animations.css" },
  { re: /^\/\*\s*── PLAYGROUND/, file: "playground.css" },
];

const outLines = out.split(/\r?\n/);
const buckets = new Map();
const order = [
  "tokens-base.css",
  "utilities.css",
  "chrome.css",
  "catalog.css",
  "cockpit.css",
  "launch.css",
  "fusion-display.css",
  "console.css",
  "config.css",
  "surfaces.css",
  "intel.css",
  "animations.css",
  "playground.css",
  "misc.css",
];
for (const f of order) buckets.set(f, []);

// Extract tailwind directives from top
let bodyStart = 0;
const head = [];
for (let li = 0; li < outLines.length; li++) {
  if (
    outLines[li].startsWith("@tailwind") ||
    outLines[li].trim() === "" && head.length < 5
  ) {
    if (outLines[li].startsWith("@tailwind")) head.push(outLines[li]);
    bodyStart = li + 1;
    if (outLines[li].startsWith("@tailwind utilities")) {
      bodyStart = li + 1;
      break;
    }
  } else if (!outLines[li].startsWith("@tailwind") && head.length > 0) {
    bodyStart = li;
    break;
  }
}

let current = "tokens-base.css";
for (let li = bodyStart; li < outLines.length; li++) {
  const line = outLines[li];
  for (const m of sectionMarkers) {
    if (m.re.test(line)) {
      current = m.file;
      break;
    }
  }
  // Ignite block without section header
  if (line.includes("Ignite / launch")) current = "launch.css";
  if (!buckets.has(current)) buckets.set(current, []);
  buckets.get(current).push(line);
}

fs.mkdirSync(STYLES_DIR, { recursive: true });

const imports = [];
for (const f of order) {
  const content = (buckets.get(f) || []).join("\n").trim();
  if (!content) continue;
  fs.writeFileSync(path.join(STYLES_DIR, f), content + "\n", "utf8");
  imports.push(`@import "./styles/${f}";`);
  console.log(
    `  ${f}: ${(content.split("\n").length)} lines`,
  );
}

const entry = `${head.join("\n")}

/* Domain styles — edit partials under src/styles/; do not grow theme forks here */
${imports.join("\n")}
`;

fs.writeFileSync(CSS_PATH, entry, "utf8");

// Clean preview artifact if present
const preview = path.join(ROOT, "src", "index.css.stripped-preview");
if (fs.existsSync(preview)) fs.unlinkSync(preview);

console.log(
  JSON.stringify(
    {
      removedThemeRulesLines: removedTheme,
      entryLines: entry.split("\n").length,
      partials: imports.length,
    },
    null,
    2,
  ),
);
