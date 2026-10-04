import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { draftRoleFromModel, draftRoleFromPathHints, hasBakedMtp } from "./specDraft";
import type { DraftRole } from "./specDraft";
import type { GgufShape, ModelEntry } from "./types";
import fixtures from "../../src-tauri/src/spec_draft/fixtures.json";

/**
 * Shared rule table with `src-tauri/src/spec_draft/fixtures.json` — the same JSON the Rust
 * classifier runs against. Invariants, not snapshots: each case pins a relationship
 * ("naming must not contradict the authoritative verdict"), never a rendered string.
 *
 * TS holds the **naming tier only**. Rust additionally reads the GGUF tensor-info header
 * (`GgufShape`), so header-only evidence is invisible here. Those cases are declared in
 * `RUST_ONLY_FIXTURES` and asserted as far as the fallback tier honestly can — never as a
 * faked pass.
 */
interface Fixture {
  id: string;
  path: string;
  shape: GgufShape | null;
  expected_role: DraftRole;
  expected_baked_mtp: boolean;
  note: string;
}

/**
 * Rust-only: header evidence, invisible to the TS fallback tier.
 *
 * `nameOnly` narrows the case to path tokens that carry **no** draft token — which is the
 * whole point of the fixture. Without it a folder token would fire the naming tier and the
 * test would prove nothing about the header dependency.
 */
const RUST_ONLY_FIXTURES: Record<string, { nameOnly?: boolean; agreesWithRust?: boolean }> = {
  // `sidecar-00001.gguf` — no mtp token anywhere; block_count 1 + nextn is the whole case.
  "external-mtp-head-header-only-no-naming": {},
  // `draft-00001-of-00002.gguf` — the nextn tensor lived in the other split; only the merged
  // header shape says so.
  "external-mtp-sharded-nextn-in-later-split": {},
  // `aux-q8_0.gguf` — arch `dflash` in the header is the only signal.
  "dflash-draft-header-only": {},
  // `draft-q8_0.gguf` — arch `dflash-draft` alias; no dflash token in the path.
  "dflash-draft-arch-alias": {},
  // Full-stack Q4 with nextn — the header is what makes it a baked-MTP target.
  "baked-mtp-header-nextn-full-stack": {},
  // The path-segment trap: a folder named DFlash marks every gguf beneath it. Header evidence
  // outranks a folder name, so the honest TS check runs on the file name alone.
  "dflash-folder-cannot-condemn-a-main": { nameOnly: true },
  // nextn present in the header; the path is an ordinary quant name.
  "target-with-vocab-zero-scrape": {},
  // `dspark-draft-q8.gguf` — Rust gets there from arch `dflash` + `markov_w1.weight`: DSpark is
  // a CLI type, not a role, and the Markov tensor is what separates it from plain DFlash.
  //
  // NOT a header-only case, contrary to how this fixture was first written. The name carries a
  // loud draft token — `DSPARK_SIGNAL_RE` is `/d[-_.\s]?spark/i` with an optional separator, so
  // `dspark` matches and the naming tier reaches `external_dflash` on its own. `agreesWithRust`
  // pins that the fallback tier agrees here; the header is still what distinguishes DSpark from
  // DFlash, but both answers are the same role, so the tier is not wrong — only less specific.
  "dspark-draft": { nameOnly: true, agreesWithRust: true },
};

type NamingInput = Pick<ModelEntry, "path" | "name" | "hfModelId" | "sourcePathLabel">;

function fixtureCase(f: Fixture, opts?: { nameOnly?: boolean }): NamingInput {
  const normalized = f.path.replace(/\\/g, "/");
  const fileName = normalized.split("/").pop() ?? "";
  if (opts?.nameOnly) {
    // Drop the folder tree: only the file's own name is visible to the naming tier.
    return { path: fileName, name: fileName, hfModelId: undefined, sourcePathLabel: undefined };
  }
  return {
    path: f.path,
    name: fileName,
    hfModelId: undefined,
    sourcePathLabel: undefined,
  };
}

const cases = fixtures as Fixture[];

describe("spec_draft fixture table (shared with cargo)", () => {
  it("covers every fixture in the JSON exactly once", () => {
    const onDisk = JSON.parse(
      readFileSync("src-tauri/src/spec_draft/fixtures.json", "utf8"),
    ) as Fixture[];
    expect(cases.length).toBe(onDisk.length);

    const ids = cases.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids, "fixture ids drifted from the JSON").toEqual(onDisk.map((f) => f.id));

    // Every fixture lands in exactly one of the two groups — no silent gaps, no invented ids.
    const rustOnlyIds = Object.keys(RUST_ONLY_FIXTURES);
    for (const id of rustOnlyIds) {
      expect(ids, `Rust-only list names a fixture that is gone: ${id}`).toContain(id);
    }
    const namingTier = ids.filter((id) => !rustOnlyIds.includes(id));
    expect(namingTier.length + rustOnlyIds.length).toBe(ids.length);
  });

  for (const f of cases) {
    const rustOnly = RUST_ONLY_FIXTURES[f.id];
    if (rustOnly) {
      it(`${f.id}: Rust-only — naming tier cannot reach the verdict`, () => {
        const model = fixtureCase(f, rustOnly);
        if (rustOnly.agreesWithRust) {
          // The naming tier does reach this one, and must reach the same verdict Rust does.
          expect(draftRoleFromPathHints(model)).toBe(f.expected_role);
          expect(hasBakedMtp(model)).toBe(f.expected_baked_mtp);
        } else {
          // No invented role and no invented baked-MTP from naming alone.
          expect(draftRoleFromPathHints(model)).toBeNull();
          expect(hasBakedMtp(model)).toBe(false);
        }
        // The authoritative Rust verdict is consumed untouched.
        expect(draftRoleFromModel({ ...model, draftRoleHint: f.expected_role })).toBe(f.expected_role);
        // And on the full path the tier may at most agree with Rust — never contradict it.
        // Skipped when `nameOnly` narrowed the case: the folder token is exactly the signal
        // Rust's header evidence outranks, so the full path is the known-bad input.
        if (!rustOnly.nameOnly) {
          const full = fixtureCase(f);
          const fullFallback = draftRoleFromPathHints(full);
          expect(fullFallback === null || fullFallback === f.expected_role).toBe(true);
        }
      });
      continue;
    }

    it(`${f.id}: naming tier reproduces the verdict`, () => {
      const model = fixtureCase(f);
      const hinted = draftRoleFromModel({ ...model, draftRoleHint: f.expected_role });
      const fallback = draftRoleFromPathHints(model) ?? "none";
      // Either tier may carry the case, but neither may contradict the rule table.
      expect(hinted).toBe(f.expected_role);
      expect(fallback).toBe(f.expected_role);
      expect(hasBakedMtp(model)).toBe(f.expected_baked_mtp);
    });
  }
});
