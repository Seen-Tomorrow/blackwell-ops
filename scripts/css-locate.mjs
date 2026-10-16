#!/usr/bin/env node
/*
 * css-locate.mjs — one-shot CSS discovery for agents and humans.
 *
 *   node scripts/css-locate.mjs .value-chip          # class
 *   node scripts/css-locate.mjs --theme-chip-bg      # token chain per theme
 *   node scripts/css-locate.mjs config.css           # file ownership
 *   node scripts/css-locate.mjs ConfigPage.tsx       # component -> CSS + classes
 *   node scripts/css-locate.mjs map [--write]        # ownership map/report
 *
 * Read-only except `map --write` (writes docs/css-map.md + tmp/css-map.json).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const STYLES = path.join(SRC, "styles");
const args = process.argv.slice(2);
const CMD = args[0] || "help";
const JSON_OUT = args.includes("--json");
const WRITE = args.includes("--write");

const read = (p) => fs.readFileSync(p, "utf8");
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};
const cssFiles = () => [
  path.join(SRC, "index.css"),
  ...fs.readdirSync(STYLES).filter((f) => f.endsWith(".css")).map((f) => path.join(STYLES, f)),
].filter((p) => fs.existsSync(p));
const tsxFiles = () => walk(SRC).filter((p) => p.endsWith(".tsx"));

// ---- CSS rules with line numbers (comment-preserving offsets) -------------
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}
function parseRules(file) {
  const text = read(file);
  const clean = stripComments(text);
  const rules = [];
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const rough = m[1].replace(/\s+/g, " ").trim();
    const selector = rough;
    const body = m[2].replace(/\s+/g, " ").trim();
    if (!selector || selector.startsWith("@") && !selector.includes("-")) continue;
    if (/^[\d,\s%]+$/.test(selector)) continue;
    const lead = m[1].length - m[1].trimStart().length;
    const line = clean.slice(0, m.index + lead).split("\n").length;
    rules.push({ file: rel(file), selector, body, line, important: (body.match(/!important/g) || []).length });
  }
  return rules;
}
function allRules() { return cssFiles().flatMap(parseRules); }
function specificity(sel) {
  const part = (s) => (s.match(/#[\w-]+/g) || []).length * 100 +
    (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length * 10 +
    (s.match(/(?<![\w.#\[:-])([a-zA-Z][\w-]*)/g) || []).length;
  return Math.max(...sel.split(",").map((x) => part(x)), 0);
}
function classesIn(selector) {
  return [...new Set([...selector.matchAll(/\.((?:\\.|[\w-])+)/g)].map((m) => m[1].replace(/\\(.)/g, "$1")))];
}

// ---- routes: startup import order + lazy component owners -----------------
function indexImportOrder() {
  return [...read(path.join(SRC, "index.css")).matchAll(/@import\s+"\.\/styles\/([^"]+)"/g)].map((m) => m[1]);
}
function lazyOwners() {
  const owners = new Map(); // css basename -> component file
  const candidates = [
    ["ModelHub.tsx", "ModelHub"], ["ConfigPage.tsx", "ConfigPage"], ["ExtrasPage.tsx", "ExtrasPage"],
    ["LogsPanel.tsx", "LogsPanel"], ["StackView.tsx", "StackView"], ["IntelPage.tsx", "ExtrasPage"],
    ["Playground.tsx", "ExtrasPage"], ["UpdatesConfig.tsx", "ConfigPage"], ["FoundryComponents.tsx", "ConfigPage"],
  ];
  for (const p of walk(SRC).filter((x) => x.endsWith(".tsx"))) {
    const text = read(p);
    for (const m of text.matchAll(/import\s+"([^"]+\.css)"/g)) {
      const target = path.normalize(path.join(path.dirname(p), m[1]));
      if (target.startsWith(STYLES) && fs.existsSync(target)) owners.set(path.basename(target), rel(p));
    }
  }
  return owners;
}
function routeOf(cssRel) {
  const base = path.basename(cssRel);
  const order = indexImportOrder();
  const i = order.indexOf(base);
  if (i >= 0) return { kind: "startup", order: i + 1, label: `startup#${i + 1}` };
  const owner = lazyOwners().get(base);
  return owner ? { kind: "lazy", label: `lazy(${owner})`, owner } : { kind: "unwired", label: "UNWIRED" };
}

// ---- tokens ---------------------------------------------------------------
function parseTokensBase() {
  const map = new Map();
  for (const m of read(path.join(STYLES, "tokens-base.css")).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map.set(m[1], m[2].replace(/\s+/g, " ").trim());
  return map;
}
function parseThemeDeltas() {
  const out = {};
  const text = read(path.join(SRC, "themes", "app-themes.ts"));
  for (const m of text.matchAll(/const\s+(MATRIX|SLATE|ARCTIC):\s*AppTheme\s*=\s*\{([\s\S]*?)\n\};/g)) {
    out[m[1]] = new Map([...m[2].matchAll(/"(--[\w-]+)":\s*"([^"]*)"/g)].map((x) => [x[1], x[2].replace(/\s+/g, " ").trim()]));
  }
  return out;
}
function resolveToken(name, deltas) {
  const base = parseTokensBase();
  const subst = (value, eff, chain, seen) => value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (m, ref, fb) => {
    if (seen.has(ref)) return m;
    if (eff.has(ref)) { chain.push(ref); return subst(eff.get(ref), eff, chain, new Set([...seen, ref])); }
    return fb ? fb.trim() : m;
  });
  const result = {};
  for (const theme of Object.keys(deltas)) {
    const eff = new Map([...base, ...deltas[theme]]);
    const chain = [name];
    const value = subst(eff.get(name) ?? "(no default)", eff, chain, new Set([name]));
    result[theme] = { value, chain: [...new Set(chain)] };
  }
  return result;
}
// ---- TSX usage ------------------------------------------------------------
function tsxUsages(target) {
  const out = [];
  for (const p of tsxFiles()) {
    const lines = read(p).split("\n");
    lines.forEach((line, i) => {
      if (new RegExp(`(?<![\\w-])${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(line)) {
        out.push({ file: rel(p), line: i + 1, text: line.trim().slice(0, 160) });
      }
    });
  }
  return out;
}

// ---- reports --------------------------------------------------------------
function locateClass(target) {
  const cls = target.replace(/^\./, "");
  const family = (c) => c === cls || c.startsWith(cls + '--') || c.startsWith(cls + '__');
  const rules = allRules().filter((r) => classesIn(r.selector).some(family));
  const usage = tsxUsages(cls);
  const related = new Map();
  for (const r of rules) for (const c of classesIn(r.selector)) related.set(c, (related.get(c) || 0) + 1);
  const tokens = [...new Set(rules.flatMap((r) => [...r.body.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1])))];
  if (JSON_OUT) { console.log(JSON.stringify({ target: cls, rules, usage, related: [...related], tokens })); return; }
  console.log(`\n=== .${cls} — ${rules.length} rules, ${usage.length} TSX hits ===`);
  console.log("CSS rules (load order):");
  for (const r of rules.sort((a, b) => (routeOf(a.file).order || 99) - (routeOf(b.file).order || 99))) {
    const route = routeOf(r.file);
    const imp = r.important ? ` !important x${r.important}` : "";
    console.log(`  ${route.label.padEnd(22)} ${r.file}:${r.line}  spec=${specificity(r.selector)}${imp}`);
    console.log(`      ${r.selector.slice(0, 140)}`);
    console.log(`      ${r.body.slice(0, 150)}`);
  }
  console.log("\nTSX usages:");
  for (const u of usage.slice(0, 40)) console.log(`  ${u.file}:${u.line}  ${u.text}`);
  if (usage.length > 40) console.log(`  ... +${usage.length - 40} more`);
  console.log(`\nCo-occurring classes: ${[...related.entries()].filter(([c]) => c !== cls).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([c, n]) => `.${c}(${n})`).join(", ") || "(none)"}`);
  if (tokens.length) {
    console.log("\nTokens used:");
    for (const t of tokens.slice(0, 10)) {
      const res = resolveToken(t, parseThemeDeltas());
      console.log(`  ${t}  MATRIX=${res.MATRIX.value}  SLATE=${res.SLATE.value}  ARCTIC=${res.ARCTIC.value}`);
    }
  }
}
function locateToken(target) {
  const name = target.startsWith("--") ? target : `--${target}`;
  const res = resolveToken(name, parseThemeDeltas());
  const rules = allRules().filter((r) => r.body.includes(name));
  if (JSON_OUT) { console.log(JSON.stringify({ token: name, resolved: res, rules })); return; }
  console.log(`\n=== ${name} — used in ${rules.length} rules ===`);
  for (const theme of Object.keys(res)) {
    console.log(`  ${theme.padEnd(7)} ${res[theme].value}`);
    console.log(`          chain: ${res[theme].chain.join(" -> ")}`);
  }
  console.log("\nDefining/using rules:");
  for (const r of rules.slice(0, 40)) console.log(`  ${routeOf(r.file).label.padEnd(22)} ${r.file}:${r.line}  ${r.selector.slice(0, 100)}`);
  if (rules.length > 40) console.log(`  ... +${rules.length - 40} more`);
}
function locateFile(target) {
  const base = path.basename(target.endsWith(".css") ? target : target + ".css");
  const full = path.join(STYLES, base);
  if (!fs.existsSync(full)) return console.log(`no such CSS file: ${base}`);
  const rules = parseRules(full);
  const classes = [...new Set(rules.flatMap((r) => classesIn(r.selector)))];
  const usageFiles = new Map();
  for (const c of classes) for (const u of tsxUsages(c)) usageFiles.set(u.file, (usageFiles.get(u.file) || 0) + 1);
  const route = routeOf(rel(full));
  if (JSON_OUT) { console.log(JSON.stringify({ file: rel(full), route, rules: rules.length, classes, usageFiles: [...usageFiles] })); return; }
  console.log(`\n=== ${base} ===`);
  console.log(`route=${route.label}  rules=${rules.length}  !important=${rules.reduce((n, r) => n + r.important, 0)}  classes=${classes.length}`);
  console.log("Top TSX users: " + [...usageFiles.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f, n]) => `${f}(${n})`).join(", "));
  console.log("Shared classes (also styled elsewhere): " + classes.filter((c) => allRules().some((r) => r.file !== rel(full) && classesIn(r.selector).includes(c))).slice(0, 20).join(", "));
}
function locateComponent(target) {
  const base = path.basename(target);
  const p = walk(SRC).find((x) => path.basename(x) === base) || walk(SRC).find((x) => x.endsWith(base));
  if (!p) return console.log(`no such component: ${target}`);
  const text = read(p);
  const imports = [...text.matchAll(/import\s+"([^"]+\.css)"/g)].map((m) => rel(path.normalize(path.join(path.dirname(p), m[1]))));
  const classes = new Set();
  for (const m of text.matchAll(/className\s*=\s*["'`]([^"'`]*)/g)) for (const c of m[1].split(/\s+/)) if (/^[A-Za-z_-][\w-]*$/.test(c)) classes.add(c);
  const rules = allRules().filter((r) => classesIn(r.selector).some((c) => classes.has(c)));
  const byFile = new Map();
  for (const r of rules) byFile.set(r.file, (byFile.get(r.file) || 0) + 1);
  if (JSON_OUT) { console.log(JSON.stringify({ component: rel(p), cssImports: imports, classes: [...classes], rulesByFile: [...byFile] })); return; }
  console.log(`\n=== ${rel(p)} ===`);
  console.log(`CSS imports: ${imports.join(", ") || "(none - uses global index.css)"}`);
  console.log(`classes used: ${classes.size}; matching rules: ${rules.length}`);
  console.log("Rules live in: " + [...byFile.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f}(${n})`).join(", "));
}
function buildMap() {
  const files = cssFiles().map((p) => {
    const r = parseRules(p); const route = routeOf(rel(p));
    return { file: rel(p), bytes: fs.statSync(p).size, route: route.label, rules: r.length, important: r.reduce((n, x) => n + x.important, 0), classes: [...new Set(r.flatMap((x) => classesIn(x.selector)))].length };
  }).sort((a, b) => b.bytes - a.bytes);
  const shared = new Map();
  for (const r of allRules()) for (const c of classesIn(r.selector)) {
    if (!shared.has(c)) shared.set(c, new Set());
    shared.get(c).add(r.file);
  }
  const sharedList = [...shared.entries()].filter(([, s]) => s.size > 1).map(([c, s]) => ({ class: c, files: [...s].sort() })).sort((a, b) => b.files.length - a.files.length || a.class.localeCompare(b.class));
  return { generatedAt: new Date().toISOString(), files, shared: sharedList, importantTotal: files.reduce((n, f) => n + f.important, 0), ruleTotal: files.reduce((n, f) => n + f.rules, 0) };
}
if (CMD === "map") {
  const map = buildMap();
  if (WRITE) {
    fs.writeFileSync(path.join(ROOT, "tmp", "css-map.json"), JSON.stringify(map, null, 2));
    const lines = ["# CSS ownership map", "", `Generated ${map.generatedAt} by \`npm run css:map\`.`, "", "## Files", "", "| file | route | rules | !important | classes | bytes |", "|---|---|---:|---:|---:|---:|",
      ...map.files.map((f) => `| ${f.file} | ${f.route} | ${f.rules} | ${f.important} | ${f.classes} | ${f.bytes} |`), "", "## Shared classes (styled in >1 file)", "", "| class | files |", "|---|---|",
      ...map.shared.slice(0, 60).map((s) => `| .${s.class} | ${s.files.join(", ")} |`), "", `> ${map.shared.length} shared classes, ${map.importantTotal} \`!important\`, ${map.ruleTotal} rules.`, ""];
    fs.writeFileSync(path.join(ROOT, "docs", "css-map.md"), lines.join("\n"));
    console.log("wrote docs/css-map.md and tmp/css-map.json");
  } else {
    console.log(JSON.stringify(map, null, 2));
  }
} else if (CMD === "help" || CMD === "--help") {
  console.log(`usage: node scripts/css-locate.mjs <class|--token|file.css|Component.tsx|map [--write] [--json]>`);
} else if (CMD.endsWith(".css") || fs.existsSync(path.join(STYLES, CMD + ".css"))) locateFile(CMD);
else if (CMD.endsWith(".tsx") || fs.existsSync(path.join(SRC, "components", CMD))) locateComponent(CMD);
else if (CMD.startsWith("--")) locateToken(CMD);
else locateClass(CMD);
