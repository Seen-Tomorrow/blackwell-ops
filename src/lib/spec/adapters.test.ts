import { describe, expect, it } from "vitest";
import {
  SPEC_ADAPTERS,
  adapterForCliType,
  adapterForMethod,
  cliTypeForMethod,
  normalizeDraftPath,
  resolveSpecAdapter,
} from "./adapters";

/**
 * Invariants for the spec adapter registry. These assert relationships the rest of the
 * app now depends on — one CLI string per method, one adapter per CLI string, and the
 * `draft-mtp` ambiguity resolved by the draft path rather than by a size threshold.
 */
describe("spec adapter registry", () => {
  it("every adapter has a unique cliType and no variant collides", () => {
    const seen = new Map<string, string>();
    for (const adapter of Object.values(SPEC_ADAPTERS)) {
      for (const cli of [adapter.cliType, ...Object.values(adapter.variants ?? {})]) {
        const owner = seen.get(cli);
        expect(owner, `cliType ${cli} claimed by both ${owner} and ${adapter.id}`).toBeUndefined();
        seen.set(cli, adapter.id);
      }
    }
  });

  it("resolves each Boost method to the CLI string the engine expects", () => {
    expect(cliTypeForMethod("mtp")).toBe("draft-mtp");
    expect(cliTypeForMethod("dflash")).toBe("draft-dflash");
    expect(cliTypeForMethod("dspark")).toBe("draft-dspark");
    expect(cliTypeForMethod("off")).toBeNull();
  });

  it("round-trips every CLI string back to its adapter", () => {
    for (const method of ["mtp", "dflash", "dspark"] as const) {
      const cli = cliTypeForMethod(method);
      expect(cli).toBeTruthy();
      expect(adapterForCliType(cli as string)).toBe(adapterForMethod(method));
    }
  });

  it("dspark shares the DFlash adapter and its knobs", () => {
    const df = SPEC_ADAPTERS.dflash;
    expect(adapterForMethod("dspark")).toBe(df);
    expect(adapterForCliType("draft-dspark")).toBe(df);
    expect(df.variants?.dspark).toBe("draft-dspark");
  });

  it("only MTP has a constant learnedIncludesDraft", () => {
    for (const adapter of Object.values(SPEC_ADAPTERS)) {
      const constant = adapter.memory.learnedIncludesDraft(true)
        === adapter.memory.learnedIncludesDraft(false);
      expect(constant, `${adapter.id} learnedIncludesDraft should be path-dependent`).toBe(
        adapter.id === "mtp",
      );
    }
    expect(SPEC_ADAPTERS.mtp.memory.learnedIncludesDraft(false)).toBe(true);
    expect(SPEC_ADAPTERS.dflash.memory.learnedIncludesDraft(false)).toBe(false);
  });
});

/**
 * `draft-mtp` is one string with two VRAM footprints. Before the adapter owned this,
 * the forecast inferred which one from `mtp_context_mib > 64`.
 */
describe("resolveSpecAdapter disambiguates draft-mtp", () => {
  it("baked-in MTP without a path resolves to the MTP adapter", () => {
    expect(resolveSpecAdapter("draft-mtp", false)).toBe(SPEC_ADAPTERS.mtp);
  });

  it("an external MTP head resolves to external-draft memory semantics", () => {
    expect(resolveSpecAdapter("draft-mtp", true)).toBe(SPEC_ADAPTERS.dflash);
  });

  it("the resolved adapter never double-counts the draft term", () => {
    // needsDraftAdd in ggml_master is `draftAddon > 0 && !learnedIncludesDraft(...)`.
    // A learned snapshot taken WITH a head loaded already contains the head's buffers,
    // so the addon must not go on top. Baked-in MTP always includes its nextn buffers,
    // so it is constant-true and the addon is never applied.
    const cases: Array<[string, boolean, boolean]> = [
      // [cliType, draftPathConfigured, mustAddDraftTerm]
      ["draft-mtp", false, false],
      ["draft-mtp", true, false],
      ["draft-dflash", true, false],
      ["draft-eagle3", true, false],
      // A head configured but never launched: the snapshot predates it, so add.
      ["draft-dflash", false, false],
    ];
    for (const [cli, hasPath, mustAdd] of cases) {
      const adapter = resolveSpecAdapter(cli, hasPath);
      expect(adapter, cli).not.toBeNull();
      const needsDraftAdd = hasPath && !adapter!.memory.learnedIncludesDraft(hasPath);
      expect(needsDraftAdd, `${cli} path=${hasPath}`).toBe(mustAdd);
    }
  });

  it("an external draft with no path still reports it does not include a draft", () => {
    // The case that matters: head configured but the learned row predates it.
    expect(SPEC_ADAPTERS.dflash.memory.learnedIncludesDraft(false)).toBe(false);
    expect(SPEC_ADAPTERS.eagle3.memory.learnedIncludesDraft(false)).toBe(false);
  });

  it("unknown and empty CLI types resolve to nothing", () => {
    expect(resolveSpecAdapter(null, true)).toBeNull();
    expect(resolveSpecAdapter("", true)).toBeNull();
    expect(resolveSpecAdapter("ngram2", true)).toBeNull();
  });
});

describe("normalizeDraftPath", () => {
  it("treats the template defaults as no draft", () => {
    for (const raw of ["off", "OFF", " off ", "none", "", "   ", null, undefined]) {
      expect(normalizeDraftPath(raw), `${String(raw)} should not count as a path`).toBeNull();
    }
  });

  it("keeps a real path", () => {
    expect(normalizeDraftPath("C:\\models\\head.mtp.gguf")).toBe("C:\\models\\head.mtp.gguf");
    expect(normalizeDraftPath("auto")).toBe("auto");
  });
});
