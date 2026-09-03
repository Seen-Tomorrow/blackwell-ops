// Build gate: run the SAME minifier Vite uses (lightningcss) over index.css + every partial.
// postcss is lenient about a comment terminated early by `*/` inside comment text
// (e.g. "(was text-*/60)"); lightningcss is not -> "Invalid empty selector" at build.
// Also does a structural scan: flags any comment terminator whose rest-of-line still
// contains `*/`, which is the fingerprint of that bug.
import { transform } from "lightningcss";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const files = ["src/index.css", ...readdirSync("src/styles").filter((f) => f.endsWith(".css")).map((f) => join("src/styles", f))];

function scanEarlyTerminators(text, file) {
  const out = [];
  let inComment = false;
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") line++;
    if (!inComment) {
      if (c === "/" && text[i + 1] === "*") { inComment = true; i++; }
      continue;
    }
    if (c === "*" && text[i + 1] === "/") {
      inComment = false;
      i++;
      // rest of the line after the terminator
      let eol = text.indexOf("\n", i);
      if (eol === -1) eol = text.length;
      const rest = text.slice(i, eol);
      if (rest.includes("*/")) out.push({ line, rest: rest.trim() });
    }
  }
  return out;
}

let bad = 0;
for (const file of files) {
  const code = readFileSync(file);
  const text = code.toString("utf8");
  for (const hit of scanEarlyTerminators(text, file)) {
    bad++;
    console.log(`EARLY */  ${file}:${hit.line}  ->  ${hit.rest}`);
  }
  try {
    transform({ filename: file, code, minify: true, errorRecovery: false });
  } catch (err) {
    bad++;
    const list = Array.isArray(err.errors) ? err.errors : [err];
    for (const e of list) {
      const loc = e?.loc ?? {};
      console.log(`MINIFY    ${file}:${loc.line ?? "?"}  ${e?.message ?? String(e)}`);
    }
  }
}

// Bundle pass: inline @import in index.css order and minify the concatenation once —
// this is what vite:css-post actually feeds lightningcss.
function bundle(file, seen = new Set()) {
  if (seen.has(file)) return "";
  seen.add(file);
  const dir = file.slice(0, file.lastIndexOf("/"));
  return readFileSync(file, "utf8").replace(
    /^[ \t]*@import\s+(?:url\()?\s*["']([^"']+)["']\s*[^;]*;/gm,
    (_m, spec) => {
      if (/^https?:|^~/.test(spec)) return "";
      const target = (dir ? dir + "/" : "") + spec.replace(/^\.\//, "");
      try {
        return bundle(target, seen);
      } catch {
        console.log(`IMPORT?   ${file} -> ${spec} (not resolved)`);
        return "";
      }
    },
  );
}

try {
  const css = bundle("src/index.css");
  transform({ filename: "src/index.css", code: Buffer.from(css), minify: true, errorRecovery: false });
  console.log(`OK: bundled index.css minifies clean (${css.length} bytes in)`);
} catch (err) {
  const list = Array.isArray(err.errors) ? err.errors : [err];
  for (const e of list) console.log(`BUNDLE    ${e?.loc?.line ?? "?"}  ${e?.message ?? String(e)}`);
  bad++;
  console.log(`FAILED: ${bad} problem(s)`);
  process.exit(1);
}

console.log(bad === 0 ? "OK: minify clean on " + files.length + " files" : `FAILED: ${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
