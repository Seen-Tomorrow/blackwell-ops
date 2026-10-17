/**
 * IPC wire-contract guard: every field a TS interface declares for an IPC payload
 * must be a key serde actually emits, and every interface reachable from an
 * `invoke<T>` / `listen<T>` must be under the guard.
 *
 * Why this exists: the TS mirror of a Rust payload is hand-written, and a field
 * spelled differently from the Rust wire key is permanently `undefined` at
 * runtime while `tsc`, `vitest` and `cargo test` all stay green. Three such
 * fields were live in this repo when this guard was added — `ModelMetadata`
 * reads `generalName` where Rust emits `general_name`, and `DownloadTask` reads
 * `fileName` / `hfAuthor` where Rust emits `file_name` / `hf_author`. The
 * download row's filename branch never rendered, and provider-task matching
 * never matched.
 *
 * Both halves are asked of a compiler, never of a regex. The Rust side is probed
 * by serde itself (`src-tauri/src/ipc_contract.rs`); the TS side is read through
 * the TypeScript compiler API here. `src/lib/types.ts` is also full of
 * frontend-only shapes and mirrors of internal Rust types — `HfSearchFilters`
 * mirrors a struct that never crosses IPC at all — so the guard keys off real
 * call sites rather than off name similarity.
 *
 * Maintenance note — invariant, not snapshot: adding a registered IPC type the
 * normal way (Rust registry entry + regenerate) keeps this green with no edit
 * here. It goes red only when the two sides have genuinely diverged.
 *
 * It checks ONE direction on purpose. A Rust field the frontend does not read is
 * normal — `ModelMetadata` emits 35 keys and the TS interface declares 28 — so
 * requiring equality would force edits here for unrelated work. What must never
 * happen is the reverse: a declared field that never arrives.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, dirname } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const TYPES_TS = join(here, "types.ts");
const KEYS_JSON = join(here, "generated", "ipc-wire-keys.json");
const FRONTEND_SRC = join(repoRoot, "src");
const SKIP_DIRS: Record<string, true> = {
  node_modules: true,
  dist: true,
  target: true,
  ".git": true,
  coverage: true,
};

/** RustTypeName -> wire keys, as probed from serde. */
function rustWireKeys(): Record<string, string[]> {
  return JSON.parse(readFileSync(KEYS_JSON, "utf8"));
}

/** Parse src/lib/types.ts once; expose declarations and the call sites. */
function parseFrontend() {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS[entry]) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts")) files.push(full);
    }
  };
  visit(FRONTEND_SRC);

  const typesSource = ts.createSourceFile(
    TYPES_TS,
    readFileSync(TYPES_TS, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  /** interface name -> declared property names (PropertySignature only). */
  const members = new Map<string, string[]>();
  typesSource.forEachChild((node) => {
    if (!ts.isInterfaceDeclaration(node)) return;
    const names: string[] = [];
    for (const m of node.members) {
      if (ts.isPropertySignature(m) && m.name && ts.isIdentifier(m.name)) {
        names.push(m.name.text);
      }
    }
    members.set(node.name.text, names);
  });

  /** Type names named inside a type node, at any depth (refs, arrays, generics). */
  const referencedTypes = (node: ts.Node): string[] => {
    const out: string[] = [];
    const walk = (n: ts.Node) => {
      if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName)) {
        out.push(n.typeName.text);
      }
      n.forEachChild(walk);
    };
    walk(node);
    return out;
  };

  /** interface name -> names of interfaces its members reference. */
  const edges = new Map<string, string[]>();
  typesSource.forEachChild((node) => {
    if (!ts.isInterfaceDeclaration(node)) return;
    const refs: string[] = [];
    for (const m of node.members) {
      if (ts.isPropertySignature(m) && m.type) refs.push(...referencedTypes(m.type));
    }
    edges.set(node.name.text, refs);
  });

  /** Type arguments of invoke<T>(..) / listen<T>(..), with the file they occur in. */
  const roots = new Map<string, string>();
  for (const file of files) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const walk = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const callee = n.expression.text;
        if ((callee === "invoke" || callee === "listen") && n.typeArguments?.length) {
          for (const ta of n.typeArguments) {
            for (const name of referencedTypes(ta)) {
              if (!roots.has(name)) roots.set(name, relative(repoRoot, file));
            }
          }
        }
      }
      n.forEachChild(walk);
    };
    walk(sf);
  }

  return { members, edges, roots };
}

/** Interfaces reachable from an IPC call site, following member type references. */
function reachableIpcTypes(
  members: Map<string, string[]>,
  edges: Map<string, string[]>,
  roots: Map<string, string>,
): string[] {
  const seen = new Set<string>();
  const queue = [...roots.keys()];
  while (queue.length) {
    const name = queue.pop()!;
    if (seen.has(name) || !members.has(name)) continue;
    seen.add(name);
    for (const ref of edges.get(name) ?? []) {
      if (members.has(ref) && !seen.has(ref)) queue.push(ref);
    }
  }
  return [...seen].sort();
}

describe("Rust <-> TS IPC wire contract", () => {
  const keys = rustWireKeys();
  const { members, edges, roots } = parseFrontend();

  it("finds a real key list and a real frontend", () => {
    // Guards against this check going vacuous if the generator, the tsconfig
    // include, or the invoke() call shape changes.
    expect(Object.keys(keys).length).toBeGreaterThan(5);
    expect(members.size).toBeGreaterThan(50);
    expect(roots.size).toBeGreaterThan(20);
  });

  it("declares no field that serde does not emit", () => {
    const bad: string[] = [];
    for (const [rustType, wire] of Object.entries(keys)) {
      const declared = members.get(rustType);
      if (!declared) continue; // no TS mirror — nothing to check
      for (const field of declared) {
        if (!wire.includes(field)) {
          const hint = wire.find(
            (w) => w.replace(/_/g, "").toLowerCase() === field.replace(/_/g, "").toLowerCase(),
          );
          bad.push(
            `${rustType}.${field}${hint ? `  -> serde emits "${hint}"` : "  -> serde emits no such key"}`,
          );
        }
      }
    }
    expect(
      bad,
      `TS interfaces declare fields Rust never sends (they are always undefined):\n${bad.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps every IPC payload type under the guard", () => {
    const unguarded = reachableIpcTypes(members, edges, roots)
      .filter((name) => !(name in keys))
      .map((name) => `${name}  (used at ${roots.get(name) ?? "nested"})`);
    expect(
      unguarded,
      `IPC payload types with no entry in the Rust registry ` +
        `(src-tauri/src/ipc_contract.rs), so nothing checks their fields:\n${unguarded.join("\n")}`,
    ).toEqual([]);
  });

  it("registers no type the frontend does not have", () => {
    const orphaned = Object.keys(keys).filter((name) => !members.has(name));
    expect(
      orphaned,
      `Rust registry entries with no matching TS interface:\n${orphaned.join("\n")}`,
    ).toEqual([]);
  });
});
