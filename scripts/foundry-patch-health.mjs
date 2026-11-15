#!/usr/bin/env node
/**
 * Foundry vendor-patch health.
 *
 * The two SSE patches are product-critical (fusion runs stream-only when they are present and
 * silently falls back to polling when they are not). Upstream moves; this script makes that
 * visible before a build instead of after a ghost hunt.
 *
 * Each patch is checked in a throwaway git worktree at origin/master, applied in filename order,
 * so the result is "does it apply to the upstream we would build", never "does it apply to the
 * already-patched local clone" (the local tree is expected to be dirty after a Foundry run).
 *
 * The loop mirrors Foundry's configure loop exactly - plain `git apply` first, `--3way` only as a
 * fallback - because the difference decides the build. A plain apply leaves the index stale, so
 * every later patch that touches the same file needs a 3-way merge, and `git apply --3way`
 * refuses when the worktree file differs from the index ("does not match index"). Checking the
 * whole chain with `--3way` alone (it stages what it applies, hiding the dirty index) reports
 * PASS for chains the build then fails on.
 *
 *   PASS      patch applies cleanly on origin/master (plain apply, like the build)
 *   PASS 3WAY patch only lands via the 3-way fallback — rebase it, later patches on the same
 *             file will fail the way the build does
 *   FAIL      patch no longer applies — rebase foundry/patches/<provider>-*.patch
 *   UPSTREAM  the feature marker is already in origin/master — maybe the patch is obsolete
 *
 * Usage: node scripts/foundry-patch-health.mjs [--fetch]
 * Exit: 1 when any patch fails, 0 otherwise. No engine clone (CI) = skip, exit 0.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const patchDir = path.join(repo, "foundry", "patches");
const engines = [
  path.join(repo, "src-tauri", "target", "debug", "foundry", "engines"),
  path.join(repo, "src-tauri", "target", "release", "foundry", "engines"),
].filter((p) => existsSync(p));

const markers = new Map([
  ["telemetry-sse", "/events/sse"],
  ["single-model-load-sse", "handle_single_model_load_sse"],
]);

function gitOk(cwd, args) {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitErr(cwd, args) {
  try {
    execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    return "";
  } catch (e) {
    return `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
  }
}

function markerFor(name) {
  for (const [suffix, marker] of markers) {
    if (name.includes(suffix)) return marker;
  }
  return null;
}

if (!existsSync(patchDir)) {
  console.log("[patches] no foundry/patches directory — skipped");
  process.exit(0);
}
const patches = readdirSync(patchDir).filter((f) => f.endsWith(".patch")).sort();
if (patches.length === 0) {
  console.log("[patches] no vendor patches — nothing to check");
  process.exit(0);
}
if (engines.length === 0) {
  console.log("[patches] no engine clone under src-tauri/target/*/foundry/engines — skipped");
  process.exit(0);
}

if (process.argv.includes("--fetch")) {
  for (const enginesDir of engines) {
    for (const provider of readdirSync(enginesDir)) {
      const clone = path.join(enginesDir, provider, "llama.cpp");
      if (!existsSync(path.join(clone, ".git"))) continue;
      try {
        execFileSync("git", ["fetch", "origin"], { cwd: clone, stdio: "ignore" });
      } catch {
        console.log(`[patches] ${provider}: fetch skipped (offline?)`);
      }
    }
  }
}

let failures = 0;
let checked = 0;
for (const enginesDir of engines) {
  for (const provider of readdirSync(enginesDir)) {
    const clone = path.join(enginesDir, provider, "llama.cpp");
    if (!existsSync(path.join(clone, ".git"))) continue;
    const mine = patches.filter((p) => p.startsWith(`${provider}-`));
    if (mine.length === 0) continue;
    if (!gitOk(clone, ["rev-parse", "--verify", "origin/master"])) {
      console.log(`\n[patches] ${provider}: no origin/master ref — run a Foundry sync first`);
      continue;
    }

    console.log(`\n[patches] ${provider}  (${clone})`);
    const worktree = mkdtempSync(path.join(os.tmpdir(), "dsh-patch-check-"));
    try {
      if (!gitOk(clone, ["worktree", "add", "--detach", "--force", worktree, "origin/master"])) {
        console.log("  SKIP   could not create a throwaway worktree at origin/master");
        continue;
      }
      for (const name of mine) {
        if (failures > 0) {
          // The build aborts on the first failure; later patches only look independent.
          console.log(`  SKIP     ${name} — needs the patch marked FAIL above`);
          continue;
        }
        checked += 1;
        const patch = path.join(patchDir, name);
        let state = "PASS";
        let detail = "applies cleanly on origin/master";

        // Same decision tree as foundry_vendor_patches(): plain apply first, 3-way only when the
        // worktree context drifted. Plain apply deliberately does not touch the index, so the
        // worktree state a later patch sees is the state the build sees.
        const alreadyApplied = !gitErr(worktree, ["apply", "--reverse", "--check", patch]);
        const plainErr = alreadyApplied ? "" : gitErr(worktree, [
          "apply",
          "--check",
          "--whitespace=nowarn",
          patch,
        ]);
        const threeErr =
          alreadyApplied || !plainErr
            ? ""
            : gitErr(worktree, ["apply", "--3way", "--check", "--whitespace=nowarn", patch]);

        if (alreadyApplied) {
          state = "PASS";
          detail = "already applied on origin/master";
        } else if (!plainErr) {
          gitErr(worktree, ["apply", "--whitespace=nowarn", patch]);
        } else if (!threeErr) {
          // It would land on this clean tree, but the build's tree is dirty by then.
          gitErr(worktree, ["apply", "--3way", "--whitespace=nowarn", patch]);
          state = "PASS 3WAY";
          detail = "only applies with the 3-way fallback — plain apply fails, rebase it onto origin/master";
        } else {
          state = "FAIL";
          failures += 1;
          const err = threeErr || plainErr;
          detail = `does not apply — rebase it onto origin/master\n${err
            .split("\n")
            .slice(0, 6)
            .join("\n")}`;
          if (threeErr.includes("does not match index")) {
            detail +=
              "\n  (an earlier patch left the worktree dirty and --3way needs a clean index: plain apply must succeed)";
          }
          // Leave the next patch an independent check.
          gitOk(worktree, ["reset", "--hard", "origin/master"]);
        }
        const marker = markerFor(name);
        if (marker) {
          const upstream = gitOk(clone, [
            "grep",
            "-q",
            marker,
            "origin/master",
            "--",
            "tools/server",
          ]);
          if (upstream) {
            state = state === "FAIL" ? "FAIL" : "UPSTREAM";
            detail += `\n  origin/master already contains '${marker}' — verify whether this patch is still needed`;
          }
        }
        console.log(`  ${state.padEnd(10)} ${name} — ${detail}`);
      }
    } finally {
      try {
        execFileSync("git", ["worktree", "remove", "--force", worktree], {
          cwd: clone,
          stdio: "ignore",
        });
      } catch {
        /* best effort */
      }
      rmSync(worktree, { recursive: true, force: true });
    }
  }
}

console.log(
  `\n[patches] ${checked} patch(es) checked, ${failures} failure(s)` +
    (failures ? " — rebase before building" : ""),
);
process.exit(failures === 0 ? 0 : 1);
