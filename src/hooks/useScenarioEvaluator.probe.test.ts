import { describe, expect, it } from "vitest";
import { probeAppliesToCtx } from "../services/vram/shared";

/**
 * A FIT probe measures one configuration. Applying it at another ctx is what let a 64K launch
 * carry a 102,829 MiB estimate whose real launch was 18,039 MiB (forecast-log.jsonl).
 */
describe("FIT probe scoping", () => {
  it("applies when the live ctx matches the probe's anchor ctx", () => {
    expect(probeAppliesToCtx(524_288, 524_288)).toBe(true);
    expect(probeAppliesToCtx(131_072, 131_072)).toBe(true);
  });

  it("does not apply at a different ctx, in either direction", () => {
    expect(probeAppliesToCtx(524_288, 65_536)).toBe(false);
    expect(probeAppliesToCtx(65_536, 524_288)).toBe(false);
    expect(probeAppliesToCtx(524_288, 1_048_576)).toBe(false);
  });

  it("applies while the ctx is unknown, so the probe is not dropped spuriously", () => {
    expect(probeAppliesToCtx(262_144, undefined)).toBe(true);
  });
});
