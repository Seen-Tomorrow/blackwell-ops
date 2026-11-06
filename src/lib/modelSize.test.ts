import { describe, expect, it } from "vitest";

import { modelSizeBytes, sizeLabelBytes } from "./modelSize";

describe("sizeLabelBytes", () => {
  it("ranks by unit, not by the number in the label", () => {
    // The regression this pins: the catalog renders "754MB" under a gigabyte and
    // "46.2GB" above it, so a digits-only comparison put 754 above 46.
    expect(sizeLabelBytes("754MB")!).toBeLessThan(sizeLabelBytes("46.2GB")!);
    expect(sizeLabelBytes("999MB")!).toBeLessThan(sizeLabelBytes("1.0GB")!);
  });

  it("reads the same size in spaced and glued forms", () => {
    expect(sizeLabelBytes("46.20 GiB")).toBe(sizeLabelBytes("46.2GB"));
    expect(sizeLabelBytes("1.5TB")!).toBeGreaterThan(sizeLabelBytes("1.0GB")!);
  });

  it("returns null for labels that carry no size", () => {
    expect(sizeLabelBytes("")).toBeNull();
    expect(sizeLabelBytes(undefined)).toBeNull();
    expect(sizeLabelBytes("GGUF")).toBeNull();
    expect(sizeLabelBytes("46.2 parsecs")).toBeNull();
  });
});

describe("modelSizeBytes", () => {
  it("prefers the label and falls back to the probed file size", () => {
    expect(modelSizeBytes({ size_str: "2.0GB" })).toBe(sizeLabelBytes("2.0GB"));
    expect(modelSizeBytes({ size_str: "", metadata: { file_size_bytes: 4096 } })).toBe(4096);
  });

  it("never invents a size for an entry with neither source", () => {
    expect(modelSizeBytes({ size_str: "", metadata: null })).toBeNull();
    expect(modelSizeBytes({ size_str: "GGUF", metadata: { file_size_bytes: 0 } })).toBeNull();
  });
});
