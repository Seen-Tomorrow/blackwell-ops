/**
 * First-run phase machine — invariants only.
 *
 * The wizard's completion flags gate real UI (the OPS pane is replaced by the
 * guide, and dismissing it persists `setup_completed`). The relationships below
 * are the ones that broke user-visible behaviour when violated, not a snapshot
 * of the current copy.
 */
import { describe, expect, it } from "vitest";
import {
  computePathsDone,
  computeSetupPhase,
  computeRuntimeBusy,
  computeRuntimeDone,
} from "./setupGuide";

describe("computePathsDone", () => {
  it("never completes on a linked-but-empty library", () => {
    // A folder can hold .gguf files the catalog rejects; only the catalog count
    // proves there is something to select afterwards.
    expect(computePathsDone({ modelsDeferred: false, modelsCount: 0 })).toBe(false);
  });

  it("completes as soon as the catalog has a model", () => {
    expect(computePathsDone({ modelsDeferred: false, modelsCount: 1 })).toBe(true);
  });

  it("completes when the user explicitly downloads later", () => {
    expect(computePathsDone({ modelsDeferred: true, modelsCount: 0 })).toBe(true);
  });
});

describe("computeSetupPhase", () => {
  it("starts on paths and cannot skip ahead", () => {
    expect(computeSetupPhase({ pathsDone: false, runtimeDone: false })).toBe("paths");
    // Runtime already installed must still not advance past an unlinked library.
    expect(computeSetupPhase({ pathsDone: false, runtimeDone: true })).toBe("paths");
  });

  it("moves to the runtime step once a library is linked", () => {
    expect(computeSetupPhase({ pathsDone: true, runtimeDone: false })).toBe("runtime");
  });

  it("ends at finish — no scan steps gate first contact", () => {
    expect(computeSetupPhase({ pathsDone: true, runtimeDone: true })).toBe("finish");
  });
});

describe("runtime step", () => {
  it("is never skippable", () => {
    expect(computeRuntimeDone(false)).toBe(false);
    expect(computeRuntimeDone(true)).toBe(true);
  });

  it("reports busy while a task is in flight or an extract awaits verification", () => {
    expect(computeRuntimeBusy([{ status: "downloading" }], false)).toBe(true);
    expect(computeRuntimeBusy([{ status: "completed" }], false)).toBe(true);
    expect(computeRuntimeBusy([{ status: "completed" }], true)).toBe(false);
  });
});
