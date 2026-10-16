import { describe, expect, it } from "vitest";
import {
  draftRoleBadge,
  draftRoleFromModel,
  draftRoleFromPathHints,
  hasBakedMtp,
  isExternalDraftOnly,
  isLaunchableMain,
  resolveExternalDraftPath,
  signalContainsEmbeddedMtp,
  specCapabilitiesForMain,
} from "./specDraft";
import type { ModelEntry } from "./types";

const istaMtp = {
  path: String.raw`C:\models\ISTA-DASLab\Qwen3.8-27B-GSQ-RCO-GGUF\Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp.gguf`,
  name: "Qwen3.8-27B-GSQ-RCO",
  hfModelId: "ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF",
} as ModelEntry;

describe("ISTA -mtp.gguf catalog classification", () => {
  it("treats the suffix as a baked-in MTP target, not a draft role", () => {
    expect(signalContainsEmbeddedMtp(istaMtp.path)).toBe(true);
    expect(hasBakedMtp(istaMtp)).toBe(true);
    // Baked MTP is a capability: the fallback tier invents no role for it.
    expect(draftRoleFromPathHints(istaMtp)).toBeNull();
    expect(draftRoleFromModel(istaMtp)).toBe("none");
    expect(isExternalDraftOnly(istaMtp)).toBe(false);
    expect(isLaunchableMain(istaMtp)).toBe(true);
    // No role ⇒ no role badge; the MTP chip comes from the capability.
    expect(draftRoleBadge(draftRoleFromModel(istaMtp), istaMtp)).toBeNull();
    expect(specCapabilitiesForMain(istaMtp, [], "ggml-master")).toContain("mtp");
  });

  it("does not mark the non-mtp sibling in the same folder", () => {
    const plain = {
      ...istaMtp,
      path: istaMtp.path.replace("-mtp.gguf", ".gguf"),
    };
    expect(signalContainsEmbeddedMtp(plain.path)).toBe(false);
    expect(hasBakedMtp(plain)).toBe(false);
    expect(draftRoleFromModel(plain)).toBe("none");
    expect(specCapabilitiesForMain(plain, [], "ggml-master")).not.toContain("mtp");
  });

  it("keeps dot-mtp head exports external", () => {
    const head = {
      path: String.raw`C:\models\heads\qwen.mtp.gguf`,
      name: "qwen.mtp",
    } as ModelEntry;
    expect(draftRoleFromModel(head)).toBe("external_mtp");
    expect(isExternalDraftOnly(head)).toBe(true);
    expect(hasBakedMtp(head)).toBe(false);
  });

  it("does not treat a mid-name MTP head filename as baked-in", () => {
    const head = {
      path: String.raw`C:\models\ddh0\DeepSeek-V4-Flash-GGUF\DeepSeek-V4-Flash-MTP-Q8_0.gguf`,
      name: "DeepSeek-V4-Flash-MTP-Q8_0",
    } as ModelEntry;
    expect(signalContainsEmbeddedMtp(head.path)).toBe(false);
    expect(hasBakedMtp(head)).toBe(false);
    // Naming alone cannot call this a head — only Rust's header evidence can, via the hint.
    expect(draftRoleFromPathHints(head)).toBeNull();
    expect(draftRoleFromModel({ ...head, draftRoleHint: "external_mtp" })).toBe("external_mtp");
  });

  it("header shape outranks naming for the baked-MTP capability", () => {
    const namedButNoNextn = { ...istaMtp, ggufShape: { nextnLayers: 0 } } as ModelEntry;
    expect(hasBakedMtp(namedButNoNextn)).toBe(false);
    const unnamedWithNextn = {
      path: String.raw`C:\models\vendor\Qwen3.8-27B\Qwen3.8-27B-Q4_K_M.gguf`,
      name: "Qwen3.8-27B",
      ggufShape: { nextnLayers: 1 },
    } as ModelEntry;
    expect(hasBakedMtp(unnamedWithNextn)).toBe(true);
  });
});

const main = {
  path: String.raw`C:\models\heads\Qwen3.8-Flash-Next.gguf`,
  name: "Qwen3.8-Flash-Next",
} as ModelEntry;

/** Exact stem match (70) + same parent (12) = 82, above HIGH_DRAFT_PAIR_SCORE. */
const head = {
  path: String.raw`C:\models\heads\Qwen3.8-Flash-Next-Q8_0.gguf`,
  name: "Qwen3.8-Flash-Next",
  draftRoleHint: "external_mtp",
} as ModelEntry;

/**
 * The MTP lane never silently chooses a head. `allowAutoPair: false` must resolve
 * only from an explicit pick or a saved pairing — a HIGH-scoring candidate sitting
 * in the catalog is not consent. DFlash keeps the auto-pair, so the flag's default
 * has to stay permissive.
 */
describe("MTP draft resolution is manual-only", () => {
  it("returns null when nothing was picked or saved", () => {
    expect(
      resolveExternalDraftPath(main, [head], "external_mtp", { allowAutoPair: false }),
    ).toBeNull();
  });

  it("still honours an explicit user pick", () => {
    expect(
      resolveExternalDraftPath(main, [head], "external_mtp", {
        preferredPath: head.path,
        allowAutoPair: false,
      }),
    ).toBe(head.path);
  });

  it("still honours the current config value", () => {
    expect(
      resolveExternalDraftPath(main, [head], "external_mtp", {
        currentPath: head.path,
        allowAutoPair: false,
      }),
    ).toBe(head.path);
  });

  it("auto-pairs when the flag is left at its default (DFlash behaviour)", () => {
    expect(
      resolveExternalDraftPath(main, [head], "external_mtp"),
    ).toBe(head.path);
  });
});
