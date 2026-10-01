/**
 * IPC contract guard: every command the frontend calls must be registered in the
 * single `tauri::generate_handler!` list in `src-tauri/src/main.rs`.
 *
 * Why this exists: a `#[tauri::command]` that is implemented but not registered
 * compiles, type-checks and ships — it only fails at runtime, as a rejected
 * promise in the browser console. `move_download_up` / `move_download_down` were
 * exactly that: fully implemented in `downloads.rs`, wired to real buttons, and
 * absent from the handler list, so the queue controls could never work.
 *
 * Maintenance note — this is deliberately an invariant check, not a snapshot:
 * it hard-codes no command names and no ordering. Adding a command the normal
 * way (implement + register + invoke) keeps it green with no edit here. It goes
 * red only when a call site and the registry have genuinely diverged.
 *
 * It checks ONE direction on purpose. Registered-but-never-invoked is not a
 * defect (commands are reserved, or driven from Rust), and asserting the reverse
 * would force edits to this file for unrelated work.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, dirname } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN_RS = join(repoRoot, "src-tauri", "src", "main.rs");
const FRONTEND_SRC = join(repoRoot, "src");
const SKIP_DIRS: Record<string, true> = {
  node_modules: true,
  dist: true,
  target: true,
  ".git": true,
  coverage: true,
};

/** Last path segment of every entry in the generate_handler! list. */
function registeredCommands(): Set<string> {
  const main = readFileSync(MAIN_RS, "utf8");
  const open = main.indexOf("generate_handler![");
  if (open === -1) {
    throw new Error("generate_handler! not found in src-tauri/src/main.rs — update this guard");
  }
  const body = main.slice(open + "generate_handler![".length, main.indexOf("]", open));
  return new Set(
    body
      .replace(/\/\/[^\n]*/g, "") // drop trailing comments
      .split(",")
      .map((entry) => entry.trim().split("::").pop()!.trim()) // module::sub::cmd -> cmd
      .filter((name) => /^[a-z0-9_]+$/.test(name)),
  );
}

/** Every invoke call naming a command as a string literal, under src/. */
function invokedCommands(): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS[entry]) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (/\.tsx?$/.test(entry)) {
        const source = readFileSync(full, "utf8");
        for (const line of source.split(/\r?\n/)) {
          // Comment-only lines are documentation, not call sites — without this,
          // prose that spells an example call matches and reports a phantom gap.
          const t = line.trimStart();
          if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) continue;
          for (const m of line.matchAll(/invoke\s*(?:<[^>]*>)?\s*\(\s*"([a-z0-9_]+)"/g)) {
            if (!found.has(m[1])) found.set(m[1], relative(repoRoot, full));
          }
        }
      }
    }
  };
  visit(FRONTEND_SRC);
  return found;
}

describe("Tauri IPC command registry", () => {
  const registered = registeredCommands();
  const invoked = invokedCommands();

  it("finds a real handler list and real call sites", () => {
    // Guards against the check silently becoming vacuous if main.rs is refactored
    // or the invoke() pattern changes shape.
    expect(registered.size).toBeGreaterThan(100);
    expect(invoked.size).toBeGreaterThan(100);
  });

  it("registers every command the frontend invokes", () => {
    const unregistered = [...invoked.entries()]
      .filter(([name]) => !registered.has(name))
      .map(([name, file]) => `${name}  (called in ${file})`);

    expect(unregistered, `invoke() targets missing from generate_handler!:\n${unregistered.join("\n")}`).toEqual([]);
  });
});
