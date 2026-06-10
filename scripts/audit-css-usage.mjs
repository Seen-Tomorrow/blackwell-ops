import fs from "fs";
import path from "path";

const root = process.cwd();
const css = fs.readFileSync(path.join(root, "src/index.css"), "utf8");

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "target") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(tsx?|html|css)$/.test(ent.name)) out.push(fs.readFileSync(p, "utf8"));
  }
  return out;
}

const bundle = walk(path.join(root, "src")).join("\n") + fs.readFileSync(path.join(root, "index.html"), "utf8");

const skip = new Set([
  "before", "after", "hover", "focus", "active", "disabled", "first", "last", "odd", "even",
  "root", "from", "to", "not", "is", "where", "layer", "supports",
]);

const classes = [...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)]
  .map((m) => m[1])
  .filter((c) => !skip.has(c));
const uniq = [...new Set(classes)];

const unused = [];
const used = [];
for (const c of uniq) {
  if (bundle.includes(c)) used.push(c);
  else unused.push(c);
}

const keyframes = [...css.matchAll(/@keyframes\s+([a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
const unusedKeyframes = keyframes.filter((k) => !bundle.includes(k) && !css.includes(`animation: ${k}`) && !css.includes(`animation-name: ${k}`));

console.log(`index.css lines: ${css.split("\n").length}`);
console.log(`custom class tokens: ${uniq.length}`);
console.log(`literal hits in src: ${used.length}`);
console.log(`no literal hit: ${unused.length}`);
console.log(`keyframes defined: ${keyframes.length}`);
console.log(`keyframes maybe orphan: ${unusedKeyframes.length}`);
console.log("\nUnused sample (first 50):");
console.log(unused.slice(0, 50).join(", "));
console.log("\nOrphan keyframes sample:");
console.log(unusedKeyframes.slice(0, 20).join(", "));