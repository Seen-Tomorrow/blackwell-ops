import { describe, expect, it } from "vitest";
import {
  isCompileStep,
  isPreBuild,
  isTerminalStep,
  phaseBand,
  phaseKey,
  phaseSpec,
} from "./foundryPhases";

describe("foundry phase table", () => {
  it("collapses the backend CamelCase phases and UI step aliases onto one key", () => {
    const pairs: Array<[string, string]> = [
      ["Idle", "idle"],
      ["Initializing", "init"],
      ["GitClone", "clone"],
      ["GitPull", "pull"],
      ["PrCherryPick", "pr-merge"],
      ["Configuring", "configuring"],
      ["WaitingForConfirm", "waiting-confirm"],
      ["BackupLocked", "backup-locked"],
      ["Building", "building"],
      ["Validating", "validating"],
      ["Complete", "complete"],
      ["Failed", "error"],
    ];
    for (const [backend, ui] of pairs) {
      expect(phaseKey(backend)).toBe(phaseKey(ui));
    }
  });

  it("counts compile only for the stages that emit ninja edges", () => {
    expect(isCompileStep("Building")).toBe(true);
    expect(isCompileStep("Validating")).toBe(true);
    expect(isCompileStep("Configuring")).toBe(false);
    expect(isCompileStep("WaitingForConfirm")).toBe(false);
    expect(isCompileStep("complete")).toBe(false);
  });

  it("keeps stage bands ordered and inside the bar", () => {
    const order = ["init", "clone", "pull", "pr-merge", "configuring", "building", "validating"];
    let previous = -1;
    for (const step of order) {
      const [lo, hi] = phaseBand(step);
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThanOrEqual(100);
      expect(lo).toBeLessThanOrEqual(hi);
      expect(lo).toBeGreaterThanOrEqual(previous);
      previous = lo;
    }
    expect(phaseBand("complete")).toEqual([100, 100]);
    expect(phaseBand("error")).toEqual([100, 100]);
  });

  it("treats only idle as pre-build and only done/fail as terminal", () => {
    expect(isPreBuild("Idle")).toBe(true);
    expect(isPreBuild("Configuring")).toBe(false);
    expect(isTerminalStep("Complete")).toBe(true);
    expect(isTerminalStep("Failed")).toBe(true);
    expect(isTerminalStep("Building")).toBe(false);
  });

  it("returns a stable spec for an unknown phase instead of throwing", () => {
    expect(phaseSpec("something-new").step).toBe("idle");
    expect(phaseKey("")).toBe("idle");
  });
});
