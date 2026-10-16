#!/usr/bin/env node
/*
 * css-tools.mjs — dependency-free CSS inventory and conservative pruner.
 *
 *   node scripts/css-tools.mjs audit [--json] [--check]
 *   node scripts/css-tools.mjs prune [--write] [--json]
 *
 * Class usage is inferred from the working tree:
 *   - string/template literals in src, src-tauri, scripts, terminals, index.html
 *   - dynamic constructions: `foo-${x}`, 'foo-' + x, x + '-bar'
 * A class is USED if it appears as a literal token, or matches a dynamic
 * prefix/suffix. Conservative by design: guessing "dead" costs UI, guessing
 * "used" costs only bytes. Prune removes a rule only when EVERY class selector
 * in it is unused (or dynamic-free unused).
 *
 * Hard guards on the usage index (see buildUsage) — the scan walks the whole
 * working tree, which includes vendored/generated trees (src-tauri/target,
 * pi-ext, node_modules inside vendored sources). Without bounds those produce
 * millions of junk tokens and Node dies with `RangeError: Set maximum size
 * exceeded`:
 *   - files over MAX_FILE_BYTES are skipped (never token-split);
 *   - *.min.* / *.map are skipped;
 *   - literals over MAX_LITERAL_CHARS are NOT token-split — only their dynamic
 *     `prefix${` / `}suffix` fragments are harvested, with a bounded regex;
 *   - only tokens matching /^[A-Za-z_][\w-]{0,80}$/ survive, after stripping
 *     leading . or #;
 *   - the token set is capped at MAX_TOKENS; when capped the audit prints a
 *     warning and names the offending files.
 */
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const CMD = args[0] || "audit";
const has = (f) => args.includes(f);
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(name + "="));
  return hit ? hit.slice(name.length + 1) : dflt;
};

const SCAN_DIRS = ["src", "src-tauri", "scripts", "terminals"];
const SCAN_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".html", ".rs", ".json"]);
const IGNORE = [
  /(^|[\\/])node_modules([\\/]|$)/, /(^|[\\/])dist([\\/]|$)/, /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])tmp([\\/]|$)/, /(^|[\\/])work([\\/]|$)/, /majestic/i, /(^|[\\/])--archive/,
  /(^|[\\/])foundry([\\/]|$)/, /(^|[\\/])toolchain([\\/]|$)/,
];

// ── hard guards ────────────────────────────────────────────────────────────
const MAX_FILE_BYTES = 2_000_000;   // larger files are skipped outright
const MAX_LITERAL_CHARS = 20_000;   // larger literals are never token-split
const MAX_TOKENS = 500_000;         // hard ceiling on the usage token set
const MAX_SCAN_FILES = 20_000;      // ceiling on walked files (walk stays bounded)
const TOKEN_RE = /^[A-Za-z_][\w\-./[\]%:()!,]{0,120}$/;
const MIN_FILE_RE = /\.min\.[a-z0-9]+$/i;   // foo.min.js / foo.min.css
const MAP_FILE_RE = /\.map$/i;
// Vendored/generated trees that can never contain app class names. They are
// gitignored (see .gitignore) and hold hundreds of thousands of third-party
// source files; walking them is pure cost and their tokens only pollute the
// usage index. Guarded by MAX_SCAN_FILES as well, so this list is belt, the
// file ceiling is braces.
const PRUNE_DIRS = [
  /(^|[\\/])target([\\/]|$)/, /(^|[\\/])pi-ext([\\/]|$)/, /(^|[\\/])runtime-bundle([\\/]|$)/,
  /(^|[\\/])runtime-catalog([\\/]|$)/, /(^|[\\/])runtime([\\/]|$)/, /(^|[\\/])gen([\\/]|$)/,
  /(^|[\\/])bin([\\/]|$)/, /(^|[\\/])cache([\\/]|$)/, /(^|[\\/])config([\\/]|$)/,
];

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= MAX_SCAN_FILES) return out;
    const p = path.join(dir, e.name);
    if (IGNORE.some((re) => re.test(p))) continue;
    if (PRUNE_DIRS.some((re) => re.test(p))) continue;
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function scanFiles() {
  const out = [];
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d), out);
  const idx = path.join(ROOT, "index.html");
  if (fs.existsSync(idx)) out.push(idx);
  const kept = out.filter((f) => SCAN_EXT.has(path.extname(f)));
  return { files: kept, walked: out.length };
}

function cssFiles() {
  const out = [];
  const styles = path.join(ROOT, "src", "styles");
  if (fs.existsSync(styles)) {
    for (const f of fs.readdirSync(styles)) if (f.endsWith(".css")) out.push(path.join(styles, f));
  }
  for (const p of ["src/index.css", "src/controls.css"]) {
    const full = path.join(ROOT, p);
    if (fs.existsSync(full)) out.push(full);
  }
  return out.sort();
}

function rel(p) { return path.relative(ROOT, p).replace(/\\/g, "/"); }

// ── usage index ────────────────────────────────────────────────────────────
// Bounded by design. Every collector goes through addToken/addFragment so the
// guards below are the single place size limits live; hitting a ceiling never
// throws, it records a warning and keeps the tokens collected so far.
function buildUsage() {
  const used = new Set(), prefixes = new Set(), suffixes = new Set();
  const warnings = [];
  const skipped = { tooLarge: 0, minified: 0, cappedFiles: [] };
  let capped = false, bigLiterals = 0, rejectedTokens = 0;

  const addToken = (raw) => {
    // A backtick literal interpolates `${…}`, so its split fragments can carry
    // escaped inner quotes (`" launch-rail-tel--below"`). Strip them or the token
    // fails the shape filter and a live class is reported dead.
    const t = raw.replace(/^[\\;"'`.#\s]+/, "").replace(/[\\;"'`]+$/, "");
    if (!t) return;
    if (!TOKEN_RE.test(t)) { rejectedTokens++; return; }
    if (used.size >= MAX_TOKENS) { capped = true; return; }
    used.add(t);
    // A bare fragment token like "vram-fc-need-" or "-active" is evidence of
    // runtime class construction; register it as a dynamic prefix/suffix too.
    if (/[_-]$/.test(t) && t.length >= 4) addFragment(prefixes, t);
    if (/^[_-]/.test(t) && t.length >= 3) addFragment(suffixes, t);
  };
  const addFragment = (set, frag) => {
    if (!/^[A-Za-z_][\w-]{0,80}$/.test(frag)) { rejectedTokens++; return; }
    if (set.size >= MAX_TOKENS) { capped = true; return; }
    set.add(frag);
  };
  // Dynamic fragments only — bounded regex, no token split of the literal body.
  const harvestDynamic = (inner) => {
    bigLiterals++;
    for (const p of inner.matchAll(/([\w-]{2,64})\$\{/g)) addFragment(prefixes, p[1]);
    for (const s of inner.matchAll(/\}([\w-]{2,64})/g)) addFragment(suffixes, s[1]);
  };

  const { files, walked } = scanFiles();
  for (const f of files) {
    if (MIN_FILE_RE.test(f) || MAP_FILE_RE.test(f)) { skipped.minified++; continue; }
    let size = 0;
    try { size = fs.statSync(f).size; } catch { continue; }
    if (size > MAX_FILE_BYTES) { skipped.tooLarge++; continue; }
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    const SPLIT_RE = /[\s,;{}()[\]<>+=&|!?~^%$#@:]+/;
    const emitLiteral = (inner, kind) => {
      if (inner.length > MAX_LITERAL_CHARS) { harvestDynamic(inner); return; }
      for (const raw of inner.split(SPLIT_RE)) addToken(raw);
      if (kind === "template") harvestDynamic(inner);
    };
    // Sequential JS/TSX literal scanner: nested template expressions, strings
    // inside `${}`, comments, JSX text apostrophes. This replaced a regex that
    // desynced on apostrophes/comments and missed nested template strings.
    const scanLiterals = (t) => {
      const n = t.length; let i = 0;
      const lineEnd = (from) => { const e = t.indexOf("\n", from); return e < 0 ? n : e; };
      const scanString = (q) => {
        i++; const start = i;
        while (i < n) {
          const c = t[i];
          if (c === "\\") { i += 2; continue; }
          if (c === q) { emitLiteral(t.slice(start, i), "string"); i++; return true; }
          if (c === "\n" || c === "\r") return false;
          i++;
        }
        return false;
      };
      const scanExpression = () => {
        let depth = 0;
        while (i < n) {
          const c = t[i];
          if (c === "{") { depth++; i++; continue; }
          if (c === "}") { if (depth === 0) { i++; return; } depth--; i++; continue; }
          if (c === '"' || c === "'") { if (!scanString(c)) i++; continue; }
          if (c === "`") { scanTemplate(); continue; }
          if (c === "/" && t[i + 1] === "/") { i = lineEnd(i + 2); continue; }
          if (c === "/" && t[i + 1] === "*") { const e = t.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
          i++;
        }
      };
      const scanTemplate = () => {
        i++; let start = i;
        while (i < n) {
          const c = t[i];
          if (c === "\\") { i += 2; continue; }
          if (c === "`") { emitLiteral(t.slice(start, i), "template"); i++; return; }
          if (c === "$" && t[i + 1] === "{") {
            emitLiteral(t.slice(start, i), "template");
            i += 2; scanExpression(); start = i; continue;
          }
          i++;
        }
      };
      while (i < n) {
        const c = t[i];
        if (c === "/" && t[i + 1] === "/") { i = lineEnd(i + 2); continue; }
        if (c === "/" && t[i + 1] === "*") { const e = t.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
        if (c === '"' || c === "'") { if (!scanString(c)) i++; continue; }
        if (c === "`") { scanTemplate(); continue; }
        i++;
      }
    };
    scanLiterals(text);
    for (const mm of text.matchAll(/(['"`])([\w-]{2,64})\1\s*\+/g)) addFragment(prefixes, mm[2]);
    for (const mm of text.matchAll(/\+\s*(['"`])([\w-]{2,64})\1/g)) addFragment(suffixes, mm[2]);
    for (const mm of text.matchAll(/(['"`])([\w-]{2,64})\1\s*\.\s*(?:concat|replace)/g)) addFragment(prefixes, mm[2]);
    if (capped && !skipped.cappedFiles.includes(rel(f))) skipped.cappedFiles.push(rel(f));
  }

  // Keep only separators that actually look like class fragments.
  for (const s of [...prefixes]) if (!/[_-]/.test(s) || s.length < 3) prefixes.delete(s);
  for (const s of [...suffixes]) if (!/[_-]/.test(s) || s.length < 3) suffixes.delete(s);

  if (skipped.tooLarge) warnings.push(`skipped ${skipped.tooLarge} file(s) over ${(MAX_FILE_BYTES / 1e6).toFixed(1)} MB`);
  if (skipped.minified) warnings.push(`skipped ${skipped.minified} minified/map file(s)`);
  if (walked > files.length) warnings.push(`${walked - files.length} file(s) skipped by extension filter`);
  if (walked >= MAX_SCAN_FILES) warnings.push(`walk capped at ${MAX_SCAN_FILES} files — later directories were not indexed`);
  if (bigLiterals) warnings.push(`${bigLiterals} literal(s) over ${MAX_LITERAL_CHARS} chars: dynamic fragments only, not token-split`);
  if (rejectedTokens) warnings.push(`${rejectedTokens} token candidate(s) rejected by token shape filter`);
  if (capped) {
    warnings.push(`TOKEN CAP HIT (${MAX_TOKENS}) — usage index is truncated, dead-class results are LESS conservative`);
    if (skipped.cappedFiles.length) warnings.push(`  cap reached while scanning: ${skipped.cappedFiles.slice(0, 5).join(", ")}`);
  }
  return { used, prefixes, suffixes, scannedFiles: files.length, walkedFiles: walked, capped, warnings };
}

function classStatus(cls, usage) {
  if (usage.used.has(cls)) return "used";
  for (const p of usage.prefixes) if (cls.startsWith(p)) return "dynamic";
  for (const s of usage.suffixes) if (cls.endsWith(s)) return "dynamic";
  return "unused";
}

// ── CSS parser (offsets preserved) ─────────────────────────────────────────
const NESTED_AT = new Set(["@media", "@supports", "@container", "@layer", "@scope"]);

function skipString(text, i, end) {
  const q = text[i];
  i++;
  while (i < end) {
    if (text[i] === "\\") { i += 2; continue; }
    if (text[i] === q) return i + 1;
    i++;
  }
  return end;
}

function parseRegion(text, start, end) {
  const blocks = [];
  let i = start, depth = 0, current = null, segmentStart = start;
  while (i < end) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? end : close + 2;
      continue;
    }
    if (c === '"' || c === "'") { i = skipString(text, i, end); continue; }
    if (c === "{" && depth === 0) { current = { preludeStart: segmentStart, brace: i }; depth = 1; i++; continue; }
    if (c === "{") { depth++; i++; continue; }
    if (c === "}") {
      depth--;
      if (depth === 0 && current) {
        current.bodyStart = current.brace + 1;
        current.end = i + 1;
        blocks.push(current);
        current = null;
        segmentStart = i + 1;
      }
      i++;
      continue;
    }
    if (c === ";" && depth === 0) { segmentStart = i + 1; i++; continue; }
    i++;
  }
  const out = { text, start, end, blocks };
  for (const b of blocks) {
    const raw = text.slice(b.preludeStart, b.brace);
    b.rawPrelude = raw;
    const trimmed = raw.trim();
    b.kind = trimmed.startsWith("@") ? "at" : "rule";
    b.atName = b.kind === "at" ? (trimmed.match(/^@[\w-]+/) || [""])[0].toLowerCase() : "";
    b.meaningfulStart = findMeaningfulStart(text, b.preludeStart, b.brace);
    b.cleanPrelude = text.slice(b.meaningfulStart, b.brace);
    b.classes = b.kind === "rule" ? extractClasses(trimmed) : [];
    b.children = b.kind === "at" && NESTED_AT.has(b.atName)
      ? parseRegion(text, b.bodyStart, b.end - 1)
      : { text, start: b.bodyStart, end: b.end - 1, blocks: [] };
  }
  return out;
}

function findMeaningfulStart(text, start, end) {
  let i = start;
  for (;;) {
    while (i < end && /\s/.test(text[i])) i++;
    if (text[i] === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? end : close + 2;
      continue;
    }
    return i;
  }
}

function stripComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, " "); }

function extractClasses(selector) {
  const clean = stripComments(selector);
  const out = [];
  const re = /\.((?:\\.|[A-Za-z0-9_-])+)/g;
  let m;
  while ((m = re.exec(clean))) out.push(m[1].replace(/\\(.)/g, "$1"));
  return [...new Set(out)];
}

function allBlocks(region, out = []) {
  for (const b of region.blocks) { out.push(b); if (b.children) allBlocks(b.children, out); }
  return out;
}

function ruleIsDead(b, usage) {
  if (b.kind !== "rule" || b.classes.length === 0) return false;
  return b.classes.every((c) => classStatus(c, usage) === "unused");
}

function atRuleIsDead(b, usage) {
  if (b.kind !== "at" || !NESTED_AT.has(b.atName)) return false;
  const kids = b.children.blocks;
  if (!kids.length) return false;
  return kids.every((k) => (k.kind === "rule" ? ruleIsDead(k, usage) : atRuleIsDead(k, usage)));
}

function deadStats(region, usage, stats) {
  for (const b of region.blocks) {
    if (b.kind === "rule") {
      if (ruleIsDead(b, usage)) {
        stats.deadRules++; stats.deadBytes += b.end - b.meaningfulStart;
        stats.deadSelectors.push(b.cleanPrelude.replace(/\s+/g, " ").trim());
      }
    } else if (b.kind === "at" && NESTED_AT.has(b.atName)) {
      const before = stats.deadRules;
      deadStats(b.children, usage, stats);
      if (atRuleIsDead(b, usage)) {
        // children already counted; count the wrapper bytes as well
        stats.deadBytes += b.end - b.meaningfulStart;
        stats.deadSelectors.push("@" + b.atName + " (all children dead)");
      } else if (before === stats.deadRules && b.children.blocks.length) {
        /* nothing */
      }
    }
  }
}

// ── analysis ───────────────────────────────────────────────────────────────
function analyze() {
  const usage = buildUsage();
  // Warnings go to stderr so `audit --json > file.json` stays parseable.
  for (const w of usage.warnings) console.error("WARN: " + w);
  const css = cssFiles();
  const perFile = [];
  let totalImportant = 0, totalHex = 0, totalRgba = 0, pxFont = 0, varFont = 0, fontFamily = 0;
  let colorMix = 0, colorMixLiteral = 0;
  const deadClasses = new Map();
  const deadStatsAll = { deadRules: 0, deadBytes: 0, deadSelectors: [] };
  const keyframes = [];
  const sourceBytes = css.reduce((n, f) => n + fs.statSync(f).size, 0);
  const sourceBytesLf = css.reduce((n, f) => {
    const b = fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
    return n + Buffer.byteLength(b, "utf8");
  }, 0);
  const indexImports = [...fs.readFileSync(path.join(ROOT, "src", "index.css"), "utf8")
    .matchAll(/@import\s+"\.\/styles\/([^"]+)"/g)].map((m) => m[1]);

  for (const f of css) {
    const text = fs.readFileSync(f, "utf8");
    const noComments = stripComments(text);
    const important = (text.match(/!important/g) || []).length;
    totalImportant += important;
    if (!f.endsWith("tokens-base.css")) {
      totalHex += (noComments.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length;
      totalRgba += (noComments.match(/\brgba?\(/g) || []).length;
    }
    pxFont += (noComments.match(/font-size\s*:\s*[0-9.]+px/g) || []).length;
    varFont += (noComments.match(/font-size\s*:\s*var\(/g) || []).length;
    fontFamily += (noComments.match(/font-family\s*:/g) || []).length;
    for (const cm of noComments.matchAll(/color-mix\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
      colorMix++;
      const argsPart = cm[1].split(/in\s+srgb/i).slice(1).join("in srgb");
      if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(argsPart)) colorMixLiteral++;
    }
    const region = parseRegion(text, 0, text.length);
    const stats = { deadRules: 0, deadBytes: 0, deadSelectors: [] };
    deadStats(region, usage, stats);
    deadStatsAll.deadRules += stats.deadRules;
    deadStatsAll.deadBytes += stats.deadBytes;
    for (const sel of stats.deadSelectors) deadStatsAll.deadSelectors.push(rel(f) + " :: " + sel);
    for (const b of allBlocks(region)) {
      if (b.kind === "at" && b.atName === "@keyframes") {
        const name = (b.cleanPrelude.match(/@keyframes\s+([\w-]+)/) || [])[1];
        if (name) keyframes.push({ name, file: rel(f), bytes: b.end - b.meaningfulStart });
      }
      if (b.kind === "rule") {
        for (const c of b.classes) {
          const st = classStatus(c, usage);
          if (st === "unused") {
            if (!deadClasses.has(c)) deadClasses.set(c, { count: 0, files: new Set() });
            const d = deadClasses.get(c); d.count++; d.files.add(rel(f));
          }
        }
      }
    }
    perFile.push({ file: rel(f), bytes: text.length, important, deadRules: stats.deadRules, deadBytes: stats.deadBytes });
  }

  // keyframes with no reference outside their own definition
  const allText = css.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  const orphanKeyframes = [];
  for (const k of keyframes) {
    const defRe = new RegExp("@keyframes\\s+" + k.name + "\\b", "g");
    const refRe = new RegExp("(?<![\\w-])" + k.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w-])", "g");
    const defCount = (allText.match(defRe) || []).length;
    const refCount = (allText.match(refRe) || []).length;
    if (refCount <= defCount) orphanKeyframes.push(k);
  }

  const distCss = (() => {
    const dir = path.join(ROOT, "dist", "assets");
    if (!fs.existsSync(dir)) return null;
    const cssAssets = fs.readdirSync(dir).filter((f) => f.endsWith(".css"));
    const hit = cssAssets.find((f) => /^index-.*\.css$/.test(f)) || cssAssets[0];
    if (!hit) return null;
    const full = path.join(dir, hit);
    const buf = fs.readFileSync(full);
    const text = buf.toString("utf8");
    return { file: rel(full), assets: cssAssets.length, bytes: buf.length, gzip: zlibGzipSize(buf), rules: (text.match(/\{/g) || []).length, important: (text.match(/!important/g) || []).length };
  })();

  return {
    generatedAt: new Date().toISOString(),
    usage: {
      scannedFiles: usage.scannedFiles, used: usage.used.size, prefixes: usage.prefixes.size,
      suffixes: usage.suffixes.size, tokenCap: MAX_TOKENS, tokenCapHit: usage.capped,
      warnings: usage.warnings,
    },
    source: { files: css.length, bytes: sourceBytes, bytesLf: sourceBytesLf, imports: indexImports, lines: css.reduce((n, f) => n + fs.readFileSync(f, "utf8").split("\n").length, 0) },
    dist: distCss,
    important: totalImportant,
    literalColors: { hexOutsideTokens: totalHex, rgbaOutsideTokens: totalRgba },
    type: { pxFontSizes: pxFont, varFontSizes: varFont, fontFamilyDecls: fontFamily },
    colorMix: { total: colorMix, withLiteralColor: colorMixLiteral },
    dead: {
      classes: deadClasses.size,
      rules: deadStatsAll.deadRules,
      bytes: deadStatsAll.deadBytes,
      selectors: deadStatsAll.deadSelectors.slice(0, 400),
      classesByFile: [...deadClasses.entries()].map(([cls, d]) => ({ cls, files: [...d.files], rules: d.count })).sort((a, b) => b.rules - a.rules),
    },
    orphanKeyframes,
    perFile,
  };
}

function zlibGzipSize(buf) {
  // node:zlib is a built-in ESM import — the previous lazy `require("node:zlib")`
  // threw in ESM (no `require`), so dist.gzip was always null.
  try {
    return gzipSync(buf).length;
  } catch { return null; }
}

// ── pruning ────────────────────────────────────────────────────────────────
function pruneRegion(region, usage, removed) {
  let out = region.text.slice(region.start, region.blocks.length ? region.blocks[0].meaningfulStart : region.end);
  let cursor = region.blocks.length ? region.blocks[0].meaningfulStart : region.end;
  for (const b of region.blocks) {
    // Keep text between cursor and this block's meaningful start (comments etc.)
    const gap = region.text.slice(cursor, b.meaningfulStart);
    if (b.kind === "rule") {
      if (ruleIsDead(b, usage)) {
        removed.push({ selector: b.cleanPrelude.replace(/\s+/g, " ").trim(), bytes: b.end - b.meaningfulStart, kind: "rule" });
        cursor = b.end;
        continue;
      }
      out += gap + region.text.slice(b.meaningfulStart, b.end);
      cursor = b.end;
      continue;
    }
    if (b.kind === "at" && NESTED_AT.has(b.atName)) {
      if (atRuleIsDead(b, usage)) {
        removed.push({ selector: "@" + b.atName + " (all children dead)", bytes: b.end - b.meaningfulStart, kind: "at" });
        cursor = b.end;
        continue;
      }
      const inner = pruneRegion(b.children, usage, removed);
      const prunedBody = inner.trim();
      if (!prunedBody) {
        removed.push({ selector: "@" + b.atName + " (empty after prune)", bytes: b.end - b.meaningfulStart, kind: "at" });
        cursor = b.end;
        continue;
      }
      out += gap + b.cleanPrelude + "{" + inner + "}";
      cursor = b.end;
      continue;
    }
    out += gap + region.text.slice(b.meaningfulStart, b.end);
    cursor = b.end;
  }
  out += region.text.slice(cursor, region.end);
  return out;
}

function pruneFile(text, usage) {
  const region = parseRegion(text, 0, text.length);
  const removed = [];
  let out = pruneRegion(region, usage, removed);
  // second pass: drop keyframes that nothing references anymore
  const region2 = parseRegion(out, 0, out.length);
  const removedKf = [];
  for (const b of region2.blocks) {
    if (b.kind === "at" && b.atName === "@keyframes") {
      const name = (b.cleanPrelude.match(/@keyframes\s+([\w-]+)/) || [])[1];
      if (!name) continue;
      const without = out.slice(0, b.meaningfulStart) + out.slice(b.end);
      const ref = new RegExp("(?<![\\w-])" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w-])", "g");
      if (!(without.match(ref) || []).length) {
        removedKf.push({ name, bytes: b.end - b.meaningfulStart });
      }
    }
  }
  for (const k of removedKf) {
    const idx = out.indexOf("@keyframes");
    // rebuild precisely via parser
    const r = parseRegion(out, 0, out.length);
    const b = r.blocks.find((x) => x.kind === "at" && x.atName === "@keyframes" && (x.cleanPrelude.match(/@keyframes\s+([\w-]+)/) || [])[1] === k.name);
    if (b) out = out.slice(0, b.meaningfulStart) + out.slice(b.end);
  }
  return { text: out, removed, removedKf };
}

// ── reporting ──────────────────────────────────────────────────────────────
function printReport(a) {
  console.log("=== CSS AUDIT ===");
  console.log(`source: ${a.source.files} files, ${a.source.bytes} bytes (LF-normalized ${a.source.bytesLf}), ${a.source.lines} lines`);
  console.log(`usage index: ${a.usage.scannedFiles} files scanned, ${a.usage.used} literal tokens, ${a.usage.prefixes} prefixes, ${a.usage.suffixes} suffixes`);
  if (a.dist) console.log(`dist:   ${a.dist.bytes} bytes (gzip ${a.dist.gzip}), ${a.dist.rules} rules, ${a.dist.important} !important`);
  console.log(`!important: ${a.important}`);
  console.log(`literal colors outside tokens: ${a.literalColors.hexOutsideTokens} hex + ${a.literalColors.rgbaOutsideTokens} rgba`);
  console.log(`type: ${a.type.pxFontSizes} px font-size / ${a.type.varFontSizes} var(), ${a.type.fontFamilyDecls} font-family decls`);
  console.log(`color-mix: ${a.colorMix.total} total, ${a.colorMix.withLiteralColor} with literal color`);
  console.log(`dead classes: ${a.dead.classes}; strictly dead rules: ${a.dead.rules}; ~${a.dead.bytes} bytes`);
  console.log(`orphan keyframes: ${a.orphanKeyframes.length} (${a.orphanKeyframes.reduce((n, k) => n + k.bytes, 0)} bytes)`);
  console.log("\ntop files by dead bytes:");
  for (const f of a.perFile.filter((x) => x.deadBytes).sort((x, y) => y.deadBytes - x.deadBytes).slice(0, 12)) {
    console.log(`  ${f.file.padEnd(42)} dead ${String(f.deadBytes).padStart(6)} B in ${String(f.deadRules).padStart(3)} rules; !important ${f.important}`);
  }
  console.log("\ndead classes by rule count:");
  for (const c of a.dead.classesByFile.slice(0, 25)) console.log(`  ${String(c.rules).padStart(3)}x  ${c.cls}`);
}

function checkBudgets(a) {
  const budgetPath = path.join(ROOT, "scripts", "css-budgets.json");
  if (!fs.existsSync(budgetPath)) { console.log("\nno scripts/css-budgets.json — report only"); return 0; }
  const budgets = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
  const fail = [];
  const cmp = (label, value, max) => { if (max != null && value > max) fail.push(`${label}: ${value} > ${max}`); };
  cmp("source bytes (LF-normalized)", a.source.bytesLf, budgets.sourceBytesLf);
  if (budgets.importOrder && JSON.stringify(a.source.imports) !== JSON.stringify(budgets.importOrder)) {
    fail.push("index.css import order changed (canonical order is enforced; update budgets deliberately)");
  }
  cmp("dead rules", a.dead.rules, budgets.deadRules);
  cmp("dead bytes", a.dead.bytes, budgets.deadBytes);
  cmp("!important", a.important, budgets.important);
  cmp("literal hex (outside tokens)", a.literalColors.hexOutsideTokens, budgets.literalHex);
  cmp("literal rgba (outside tokens)", a.literalColors.rgbaOutsideTokens, budgets.literalRgba);
  cmp("color-mix with literal color", a.colorMix.withLiteralColor, budgets.colorMixLiteral);
  cmp("px font sizes", a.type.pxFontSizes, budgets.pxFontSizes);
  if (a.dist) {
    cmp("dist bytes", a.dist.bytes, budgets.distBytes);
    cmp("dist !important", a.dist.important, budgets.distImportant);
  }
  if (fail.length) { console.log("\nBUDGET FAIL:\n  " + fail.join("\n  ")); return 1; }
  console.log("\nbudgets OK");
  return 0;
}

// ── main ───────────────────────────────────────────────────────────────────
function main() {
  if (CMD === "audit") {
    const a = analyze();
    if (has("--json")) console.log(JSON.stringify(a, null, 2));
    else printReport(a);
    if (has("--write-report")) fs.writeFileSync(path.join(ROOT, "tmp", "css-audit.json"), JSON.stringify(a, null, 2));
    process.exit(has("--check") ? checkBudgets(a) : 0);
  }
  if (CMD === "prune") {
    const usage = buildUsage();
    for (const w of usage.warnings) console.error("WARN: " + w);
    const write = has("--write");
    const manifest = [];
    let before = 0, after = 0, removedTotal = 0, removedKf = 0;
    for (const f of cssFiles()) {
      const text = fs.readFileSync(f, "utf8");
      const { text: out, removed, removedKf: kfs } = pruneFile(text, usage);
      const delta = text.length - out.length;
      before += text.length; after += out.length; removedTotal += removed.length; removedKf += kfs.length;
      if (delta > 0) manifest.push({ file: rel(f), before: text.length, after: out.length, removedRules: removed.length, removedKeyframes: kfs.map((k) => k.name), selectors: removed.slice(0, 200) });
      if (write && out !== text) fs.writeFileSync(f, out);
      const kfBytes = kfs.reduce((n, k) => n + k.bytes, 0);
      if (delta > 0) console.log(`${write ? "pruned" : "would prune"} ${rel(f).padEnd(42)} -${String(delta).padStart(6)} B, ${removed.length} rules, ${kfs.length} keyframes${kfBytes ? ` (${kfBytes} B)` : ""}`);
    }
    console.log(`\n${write ? "PRUNED" : "DRY RUN"}: source ${before} -> ${after} bytes (-${before - after}, ${((before - after) / before * 100).toFixed(1)}%); ${removedTotal} rules, ${removedKf} keyframes`);
    fs.writeFileSync(path.join(ROOT, "tmp", "css-prune-manifest.json"), JSON.stringify({ generatedAt: new Date().toISOString(), write, before, after, removedTotal, removedKf, files: manifest }, null, 2));
    console.log("manifest: tmp/css-prune-manifest.json");
    process.exit(0);
  }
  console.error("usage: node scripts/css-tools.mjs audit|prune [--json] [--check] [--write]");
  process.exit(2);
}

main();
