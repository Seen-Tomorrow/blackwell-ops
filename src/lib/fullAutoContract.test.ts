import { describe, expect, it } from "vitest";
import {
  FULL_AUTO_SPEC_EXTRAS_DEFAULT,
  resolveFullAutoDecision,
} from "./fullAutoContract";

function input(overrides: Partial<Parameters<typeof resolveFullAutoDecision>[0]> = {}) {
  return {
    goal: "fastest" as const,
    workload: "coding" as const,
    capabilities: [] as ("mtp" | "dflash" | "eagle3")[],
    dflashLibraryReady: false,
    dflashGettable: false,
    kvQuantValues: ["q8_0", "q4_0"],
    hasBakedMtp: false,
    mtpDraftPath: "",
    ...overrides,
  };
}

describe("resolveFullAutoDecision", () => {
  it("uses baked-in MTP for FASTEST without a draft file", () => {
    const d = resolveFullAutoDecision(
      input({ capabilities: ["mtp"], hasBakedMtp: true }),
    );
    expect(d.spec.method).toBe("mtp");
    expect(d.spec.draftSource).toBe("built-in");
    expect(d.spec.needsDraft).toBe(false);
    expect(d.spec.specType).toBe("draft-mtp");
  });

  it("marks external MTP as needing a head until one is saved", () => {
    const d = resolveFullAutoDecision(input({ capabilities: ["mtp"] }));
    expect(d.spec.method).toBe("mtp");
    expect(d.spec.draftSource).toBe("none");
    expect(d.spec.needsDraft).toBe(true);
    expect(d.reasons.join(" ")).toMatch(/no head/i);
  });

  it("keeps a saved external MTP head", () => {
    const d = resolveFullAutoDecision(
      input({ capabilities: ["mtp"], mtpDraftPath: "C:/heads/mtp.gguf" }),
    );
    expect(d.spec.draftSource).toBe("saved");
    expect(d.spec.needsDraft).toBe(false);
  });

  it("falls back to DFlash when MTP is unavailable but a draft is ready", () => {
    const d = resolveFullAutoDecision(
      input({
        capabilities: ["dflash"],
        dflashLibraryReady: true,
        dflashGettable: true,
      }),
    );
    expect(d.spec.method).toBe("dflash");
    expect(d.spec.draftSource).toBe("external");
    expect(d.spec.needsDraft).toBe(false);
  });

  it("falls back to Off and hints when nothing is usable", () => {
    const d = resolveFullAutoDecision(input());
    expect(d.spec.method).toBe("off");
    expect(d.plan.speed).toBe("smart");
    expect(d.reasons.length).toBeGreaterThan(0);
  });

  it("uses the safe extras defaults and accepts overrides", () => {
    const d = resolveFullAutoDecision(
      input({ capabilities: ["mtp"], hasBakedMtp: true }),
    );
    expect(d.spec.extras).toEqual(FULL_AUTO_SPEC_EXTRAS_DEFAULT);

    const tuned = resolveFullAutoDecision(
      input({
        capabilities: ["mtp"],
        hasBakedMtp: true,
        specExtras: { nMax: 8, nMin: 2, pMin: 0.5 },
      }),
    );
    expect(tuned.spec.extras).toEqual({ nMax: 8, nMin: 2, pMin: 0.5 });
  });

  it("honors a FULL AUTO spec-lane override", () => {
    const off = resolveFullAutoDecision(
      input({ capabilities: ["mtp"], hasBakedMtp: true, speedOverride: "off" }),
    );
    expect(off.spec.method).toBe("off");

    const dflash = resolveFullAutoDecision(
      input({
        capabilities: ["dflash"],
        dflashLibraryReady: true,
        speedOverride: "dflash",
      }),
    );
    expect(dflash.spec.method).toBe("dflash");
  });
});
