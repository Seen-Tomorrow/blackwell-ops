#!/usr/bin/env node
// Benchmark archive report generator — dependency-free.
//
// One row per **engine configuration**, not per run: a TG-only session and a later PP
// measurement on the same engine land on the same row, because that is how a bench is
// actually taken (ten TG runs, then one PP).
//
// Units are explicit everywhere, because different numbers coexist:
//   prefill tok/s  — pp_burst, prompt processing
//   gen tok/s      — tg_burst per stream (parallel=1: the engine value)
//   engine total   — tg_burst with N concurrent requests: system total, NOT per stream
//
// Usage:
//   node scripts/bench/report.mjs [--dir <archive>] [--out <dir>] [--min-tokens 128]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");
const archive =
  opt("--dir", process.env.BLACKWELL_BENCH_DIR || path.join(repoRoot, "src-tauri", "target", "debug", "config", "bench"));
const outDir = path.resolve(opt("--out", path.join(repoRoot, "bench-out")));
const minTokens = Number(opt("--min-tokens", "128"));

// ── Display filters ─────────────────────────────────────────────────
// The archive is lossless; these only narrow what the report prints, so a long archive stays
// readable without hiding data. Every applied filter is echoed in the header.
const modelFilter = opt("--model", "").toLowerCase();
const sinceFilter = opt("--since", ""); // YYYY-MM-DD or full ISO timestamp
const lastGroups = Math.max(1, Number(opt("--last", "60")) || 60);

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".json")) acc.push(p);
  }
  return acc;
}

const runs = [];
for (const file of walk(path.join(archive, "runs"))) {
  try {
    const run = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!run || run.schema !== 1) continue;
    run._file = file;
    runs.push(run);
  } catch (e) {
    console.warn(`skip ${file}: ${e.message}`);
  }
}
runs.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

// Narrow the display set; the archive itself is untouched.
const archivedCount = runs.length;
runs.splice(
  0,
  runs.length,
  ...runs.filter((r) => {
    if (modelFilter && !String(r.engine?.model_path || "").toLowerCase().includes(modelFilter)) return false;
    if (sinceFilter && String(r.ts) < sinceFilter) return false;
    return true;
  })
);
const filterNote = [
  modelFilter ? `model ~ "${modelFilter}"` : null,
  sinceFilter ? `since ${sinceFilter}` : null,
  `last ${lastGroups} config(s)`,
]
  .filter(Boolean)
  .join(" · ");

const usable = runs.filter((r) => r.quality === "ok");
const rejected = runs.filter((r) => r.quality === "rejected");

const shortModel = (r) => path.basename(r.engine?.model_path || "?").replace(/\.gguf$/i, "");
const isTg = (r) => r.source === "tg_burst";
const par = (r) => Number(r.metrics?.parallel_requests ?? 1) || 1;
const prefillTps = (r) => Number(r.metrics?.prompt_tps ?? 0);
const prefillTok = (r) => Number(r.metrics?.prompt_tokens ?? 0);
const genPerReq = (r) => {
  if (!isTg(r)) return 0;
  return par(r) > 1 ? Number(r.metrics?.per_request_gen_tps ?? 0) : Number(r.metrics?.gen_tps ?? 0);
};
const genAggregate = (r) => (isTg(r) ? Number(r.metrics?.gen_tps ?? 0) : 0);
const genTok = (r) => Number(r.metrics?.gen_tokens ?? 0);
const flagsOf = (r) => r.params?.flags || null;

const keep = (r) => (isTg(r) ? genPerReq(r) > 0 && genTok(r) >= minTokens : prefillTps(r) > 0 && prefillTok(r) >= minTokens);

/** Runs that exist in the archive but do not reach the minimum size (hidden from the group table). */
const belowMin = usable.filter((r) => !keep(r)).length;
const perRun = argv.includes("--per-run");

/**
 * Group key: everything that defines what was measured. Derived from fields rather than the
 * stored hash so runs captured before flags existed still group together.
 */
function groupKey(r) {
  const f = flagsOf(r);
  const flags = f ? JSON.stringify(Object.keys(f).sort().map((k) => [k, f[k]])) : "{}";
  return [
    r.engine?.model_path ?? "?",
    r.engine?.build_info ?? "?",
    r.engine?.n_ctx ?? "?",
    r.engine?.total_slots ?? "?",
    r.params?.prompt_mode ?? "-",
    flags,
  ].join("|");
}

/** Compact, complete flag line: FA=ON KV=Q8_0/Q8_0 B=8192/4096 SPEC=MTP NMAX=12 NMIN=3 PMIN=0.25 T=8 */
function flagsSummary(r) {
  const f = flagsOf(r);
  if (!f) return "-";
  const up = (x) => String(x).toUpperCase();
  const parts = [];
  if (f["flash-attn"] !== undefined) parts.push(`FA=${up(f["flash-attn"])}`);
  const ck = f["cache-type-k"];
  const cv = f["cache-type-v"];
  if (ck !== undefined || cv !== undefined) parts.push(`KV=${up(ck ?? "?")}/${up(cv ?? "?")}`);
  const b = f["batch-size"];
  const ub = f["ubatch-size"];
  if (b !== undefined || ub !== undefined) parts.push(`B=${b ?? "?"}/${ub ?? "?"}`);
  const st = f["spec-type"];
  if (st !== undefined) {
    let spec = `SPEC=${up(String(st).replace(/^draft-/, ""))}`;
    if (f["spec-draft-n-max"] !== undefined) spec += ` NMAX=${f["spec-draft-n-max"]}`;
    if (f["spec-draft-n-min"] !== undefined) spec += ` NMIN=${f["spec-draft-n-min"]}`;
    if (f["spec-draft-p-min"] !== undefined) spec += ` PMIN=${f["spec-draft-p-min"]}`;
    parts.push(spec);
  }
  if (f["threads"] !== undefined) parts.push(`T=${f["threads"]}`);
  if (f["split-mode"] !== undefined) parts.push(`SM=${f["split-mode"]}`);
  return parts.length ? parts.join(" ") : "-";
}

const groups = new Map();
for (const r of usable.filter(keep)) {
  const k = groupKey(r);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}

/**
 * Steady-state prefill for one configuration: fit elapsed ms against prompt tokens across the
 * distinct sizes this group measured, then report the slope.
 *
 * The server charges a fixed per-request setup cost (~54 ms: HTTP/slot floor + first-prefill
 * graph setup), which llama-bench pays once during warmup and never again. A raw per-request
 * tok/s therefore understates the engine, more so the shorter the prompt. The slope is the
 * throughput llama-bench reports; the intercept is the setup cost, shown for transparency.
 * Null when the group has fewer than two distinct prompt sizes (single size: nothing to fit).
 */
function steadyPp(ppRuns) {
  const bySize = new Map();
  for (const r of ppRuns) {
    const tok = prefillTok(r);
    const tps = prefillTps(r);
    if (!(tok > 0) || !(tps > 0)) continue;
    const ms = (tok / tps) * 1000;
    const prev = bySize.get(tok);
    if (!prev || ms < prev.ms) bySize.set(tok, { tok, ms }); // fastest sample per size
  }
  const pts = [...bySize.values()].sort((a, b) => a.tok - b.tok);
  if (pts.length < 2) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.tok, 0) / n;
  const my = pts.reduce((s, p) => s + p.ms, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of pts) {
    sxy += (p.tok - mx) * (p.ms - my);
    sxx += (p.tok - mx) ** 2;
  }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  if (!(slope > 0)) return null;
  return { tps: 1000 / slope, interceptMs: my - slope * mx, sizes: pts.length };
}

/** One grouped row per engine configuration. */
const rows = [...groups.entries()]
  .map(([, list]) => {
    const tg = list.filter(isTg);
    const pp = list.filter((r) => !isTg(r));
    const latest = list[list.length - 1];
    const best = (arr, f) => (arr.length ? Math.max(...arr.map(f)) : null);
    return {
      runs: list,
      key: groupKey(latest),
      bench: latest.session || "legacy",
      model: shortModel(latest),
      ctx: latest.engine?.n_ctx ?? null,
      slots: latest.engine?.total_slots ?? null,
      parallel: tg.length ? par(tg[tg.length - 1]) : null,
      conc: (tg.length ? par(tg[tg.length - 1]) : null) ?? latest.engine?.total_slots ?? null,
      prompt: latest.params?.prompt_mode ?? "-",
      acc: latest.params?.spec_accept_rate ? `${(latest.params.spec_accept_rate * 100).toFixed(0)}%` : "-",
      flags: flagsSummary(latest),
      tgPerStream: best(tg, genPerReq),
      tgEngineTotal: tg.length && par(tg[tg.length - 1]) > 1 ? best(tg, genAggregate) : null,
      tgSamples: tg.length,
      ppTps: best(pp, prefillTps),
      ppSteady: steadyPp(pp),
      ppSamples: pp.length,
      first: list[0].ts,
      last: latest.ts,
    };
  })
  .sort((a, b) => String(a.last).localeCompare(String(b.last)));

/**
 * One chart per engine configuration: generation on the left axis (blue) and prefill on the
 * right (orange). They differ by ~20x, so a shared axis would flatten generation into the
 * floor; two scales keep both readable on the same time line.
 */
function svgDual(title, gen, pp) {
  const W = 980;
  const H = 360;
  const pad = { l: 66, r: 66, t: 52, b: 44 };
  const all = [...gen, ...pp];
  if (!all.length) {
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}"><text x="${W / 2}" y="${H / 2}" fill="#8b949e" text-anchor="middle" font-family="monospace" font-size="13">no qualifying samples</text></svg>`;
  }
  const x0 = Math.min(...all.map((p) => p.ts));
  const x1 = Math.max(...all.map((p) => p.ts));
  const maxGen = gen.length ? Math.max(...gen.map((p) => p.v)) * 1.15 : 0;
  const maxPp = pp.length ? Math.max(...pp.map((p) => p.v)) * 1.15 : 0;
  const sx = (x) => pad.l + ((x - x0) / Math.max(1, x1 - x0)) * (W - pad.l - pad.r);
  const syGen = (y) => H - pad.b - (y / Math.max(1e-9, maxGen)) * (H - pad.t - pad.b);
  const syPp = (y) => H - pad.b - (y / Math.max(1e-9, maxPp)) * (H - pad.t - pad.b);

  let grid = "";
  for (let i = 0; i <= 5; i++) {
    const y = H - pad.b - ((H - pad.t - pad.b) * i) / 5;
    grid += `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="#21262d"/>`;
    if (maxGen) grid += `<text x="${pad.l - 8}" y="${y + 4}" fill="#58a6ff" text-anchor="end" font-family="monospace" font-size="11">${((maxGen * i) / 5).toFixed(0)}</text>`;
    if (maxPp) grid += `<text x="${W - pad.r + 8}" y="${y + 4}" fill="#f0883e" font-family="monospace" font-size="11">${((maxPp * i) / 5).toFixed(0)}</text>`;
  }

  const line = (pts, sy) => pts.map((p, i) => `${i ? "L" : "M"}${sx(p.ts).toFixed(1)},${sy(p.v).toFixed(1)}`).join(" ");
  const dots = (pts, sy, color, label) =>
    pts
      .map(
        (p) =>
          `<circle cx="${sx(p.ts).toFixed(1)}" cy="${sy(p.v).toFixed(1)}" r="3.2" fill="${color}"><title>${new Date(
            p.ts
          ).toISOString()} · ${label} ${p.v.toFixed(1)} tok/s</title></circle>`
      )
      .join("");

  const legend = [
    gen.length
      ? `<rect x="${pad.l}" y="30" width="9" height="9" fill="#58a6ff"/><text x="${pad.l + 14}" y="39" fill="#8b949e" font-family="monospace" font-size="11">gen tok/s (left)</text>`
      : "",
    pp.length
      ? `<rect x="${pad.l + 190}" y="30" width="9" height="9" fill="#f0883e"/><text x="${pad.l + 204}" y="39" fill="#8b949e" font-family="monospace" font-size="11">prefill tok/s (right)</text>`
      : "",
  ].join("");

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">
  <text x="${pad.l}" y="20" fill="#c9d1d9" font-family="monospace" font-size="13">${title}</text>
  ${legend}${grid}
  ${gen.length ? `<path d="${line(gen, syGen)}" fill="none" stroke="#58a6ff" stroke-width="1.6"/>${dots(gen, syGen, "#58a6ff", "gen")}` : ""}
  ${pp.length ? `<path d="${line(pp, syPp)}" fill="none" stroke="#f0883e" stroke-width="1.6"/>${dots(pp, syPp, "#f0883e", "prefill")}` : ""}
  <text x="${pad.l}" y="${H - 12}" fill="#8b949e" font-family="monospace" font-size="11">${new Date(x0).toISOString().slice(0, 10)}</text>
  <text x="${W - pad.r}" y="${H - 12}" fill="#8b949e" text-anchor="end" font-family="monospace" font-size="11">${new Date(x1).toISOString().slice(0, 10)}</text>
</svg>`;
}

/** Chart data: one dual-axis chart per engine configuration, TG and PP on the same time line. */
const charts = rows.map((r) => ({
  row: r,
  gen: r.runs.filter(isTg).map((x) => ({ ts: Date.parse(x.ts), v: genPerReq(x) })),
  pp: r.runs.filter((x) => !isTg(x)).map((x) => ({ ts: Date.parse(x.ts), v: prefillTps(x) })),
}));

const chartTitle = (r) =>
  `${r.model} · ctx ${r.ctx ?? "?"} · ${r.conc ?? "?"} conc · ${r.prompt}${r.flags !== "-" ? " · " + r.flags : ""}`;

function mdReport() {
  const lines = [];
  lines.push("# Benchmark archive\n");
  lines.push(`Generated ${new Date().toISOString()} · archive: \`${archive}\`\n`);
  lines.push(`Runs: **${runs.length}** (of ${archivedCount} archived) · usable: **${usable.length}** · rejected: **${rejected.length}** · below min tokens (<${minTokens}): **${belowMin}** · min tokens: ${minTokens}\n`);
  lines.push(`Filter: ${filterNote} — widen with \`--model\`, \`--since\`, \`--last N\`, or \`--min-tokens 0\`.\n`);

  if (!runs.length) {
    lines.push("No archived runs yet. Run a bench in the app; each run is captured automatically.\n");
    return lines.join("\n");
  }

  lines.push("## Benches (one row per engine configuration)\n");
  lines.push(
    "| bench | model | ctx | conc | prompt | ACC | flags | TG tok/s (per stream) | TG tok/s (engine total) | TG runs | PP tok/s | PP steady tok/s | PP runs | last |"
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows.slice(-lastGroups).reverse()) {
    lines.push(
      `| ${r.bench} | ${r.model} | ${r.ctx ?? "?"} | ${r.conc ?? "-"} | ${r.prompt} | ${r.acc} | ${r.flags} | ${
        r.tgPerStream === null ? "-" : r.tgPerStream.toFixed(1)
      } | ${r.tgEngineTotal === null ? "-" : r.tgEngineTotal.toFixed(1)} | ${r.tgSamples} | ${
        r.ppTps === null ? "-" : r.ppTps.toFixed(1)
      } | ${
        r.ppSteady === null ? "-" : `${r.ppSteady.tps.toFixed(1)} (${r.ppSteady.interceptMs.toFixed(0)}ms)`
      } | ${r.ppSamples} | ${r.last} |`
    );
  }

  if (perRun) {
    lines.push("\n## Every run (--per-run)\n");
    lines.push("| ts | source | model | tokens | tok/s | quality |");
    lines.push("|---|---|---|---|---|---|");
    for (const r of runs.slice(-500).reverse()) {
      const tg = isTg(r);
      const tok = tg ? genTok(r) : prefillTok(r);
      const tps = tg ? genPerReq(r) : prefillTps(r);
      lines.push(`| ${r.ts} | ${r.source} | ${shortModel(r)} | ${tok} | ${tps.toFixed(1)} | ${r.quality} |`);
    }
  }

  lines.push("\n## Series\n");
  lines.push("| measured | config | samples | best tok/s |");
  lines.push("|---|---|---|---|");
  for (const c of charts) {
    const base = `${c.row.model} | ctx ${c.row.ctx ?? "?"} | ${c.row.flags}`;
    if (c.gen.length) lines.push(`| gen p${c.row.parallel ?? "-"} | ${base} | ${c.gen.length} | ${Math.max(...c.gen.map((p) => p.v)).toFixed(1)} |`);
    if (c.pp.length) lines.push(`| prefill | ${base} | ${c.pp.length} | ${Math.max(...c.pp.map((p) => p.v)).toFixed(1)} |`);
  }

  if (rejected.length) {
    lines.push("\n## Rejected (kept for audit)\n");
    for (const r of rejected.slice(-10)) lines.push(`- ${r.ts} ${r.source} ${shortModel(r)}: ${(r.quality_reasons || []).join("; ")}`);
  }
  return lines.join("\n") + "\n";
}

function htmlReport() {
  const body = rows
    .slice(-lastGroups)
    .reverse()
    .map(
      (r) =>
        `<tr><td>${r.bench}</td><td>${r.model}</td><td>${r.ctx ?? "?"}</td><td>${r.conc ?? "-"}</td><td>${r.prompt}</td><td>${r.acc}</td><td class="muted">${
          r.flags
        }</td><td class="v">${r.tgPerStream === null ? "-" : r.tgPerStream.toFixed(1)}</td><td class="muted">${
          r.tgEngineTotal === null ? "-" : r.tgEngineTotal.toFixed(1)
        }</td><td>${r.tgSamples}</td><td class="v">${r.ppTps === null ? "-" : r.ppTps.toFixed(1)}</td><td class="v">${
          r.ppSteady === null ? "-" : `${r.ppSteady.tps.toFixed(1)} <span class="muted">(${r.ppSteady.interceptMs.toFixed(0)}ms)</span>`
        }</td><td>${r.ppSamples}</td><td>${r.last}</td></tr>`
    )
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>Benchmark archive</title>
<style>
 body{background:#0d1117;color:#c9d1d9;font:14px/1.5 ui-monospace,monospace;margin:0;padding:28px}
 h1{font-size:18px;margin:0 0 4px} .sub{color:#8b949e;margin-bottom:24px}
 .card{background:#11161d;border:1px solid #21262d;border-radius:6px;padding:12px;margin:0 0 18px}
 table{border-collapse:collapse;width:100%} th,td{border-bottom:1px solid #21262d;padding:5px 8px;text-align:left}
 th{color:#8b949e;font-weight:600} td.v{color:#58a6ff} td.muted{color:#8b949e}
</style>
<h1>Benchmark archive</h1>
<div class="sub">${runs.length} runs · ${rows.length} engine configurations · ${usable.length} usable · ${rejected.length} rejected · generated ${new Date().toISOString()}</div>
${charts.map((c) => `<div class="card">${svgDual(chartTitle(c.row), c.gen, c.pp)}</div>`).join("\n")}
<div class="card"><table>
<thead><tr><th>bench</th><th>model</th><th>ctx</th><th>conc</th><th>prompt</th><th>ACC</th><th>flags</th><th>TG per stream</th><th>TG engine total</th><th>TG runs</th><th>PP tok/s</th><th>PP steady tok/s</th><th>PP runs</th><th>last</th></tr></thead>
<tbody>${body}</tbody></table></div>`;
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "report.md"), mdReport());
fs.writeFileSync(path.join(outDir, "report.html"), htmlReport());

const latest = {};
for (const r of rows) {
  latest[r.key] = {
    bench: r.bench,
    model: r.model,
    ctx: r.ctx,
    slots: r.slots,
    parallel: r.parallel,
    flags: r.flags,
    tg_per_stream: r.tgPerStream,
    tg_engine_total: r.tgEngineTotal,
    tg_runs: r.tgSamples,
    pp_tps: r.ppTps,
    pp_steady_tps: r.ppSteady?.tps ?? null,
    pp_setup_ms: r.ppSteady?.interceptMs ?? null,
    pp_runs: r.ppSamples,
    first: r.first,
    last: r.last,
  };
}
fs.writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(latest, null, 2) + "\n");
console.log(
  `bench report: ${runs.length} runs → ${rows.length} engine configuration(s), ${usable.length} usable, ${rejected.length} rejected → ${path.join(outDir, "report.md")}, report.html, latest.json`
);
