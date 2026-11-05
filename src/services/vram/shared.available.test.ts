import { describe, expect, it } from "vitest";
import type { GpuInfo } from "../../lib/types";
import { computeGpuAvailableList, interpolateLearnedCurveGb, type RunningSlotInfo } from "./shared";

/** Minimal GPU stub: NVML fields are what the function reads. */
function gpu(overrides: Partial<GpuInfo>): GpuInfo {
  return {
    index: 0,
    name: "RTX PRO 6000",
    memory_total: 97887,
    memory_used: 31031,
    memory_free: 66855,
    memory_total_manufactured: 98304,
    driver_model: "WDDM",
    ...overrides,
  } as GpuInfo;
}

const noSlots: RunningSlotInfo[] = [];

describe("free VRAM for planning", () => {
  it("trusts NVML free instead of re-subtracting a hardware reserve", () => {
    // 66,855 MiB free. The old maths used manufactured(98,304) - 1,792 - used(31,031)
    // = 65,481, i.e. 1.3 GiB less than the driver actually offers.
    const [free] = computeGpuAvailableList([gpu({})], noSlots);
    expect(free).toBeCloseTo(66855 / 1024, 3);
    expect(free).toBeGreaterThan((98304 - 1792 - 31031) / 1024);
  });

  it("partitions a total across the cards rather than summing them", () => {
    const [a, b] = computeGpuAvailableList(
      [
        gpu({ index: 0, memory_used: 31031, memory_free: 66855 }),
        gpu({ index: 1, memory_used: 30270, memory_free: 67616 }),
      ],
      noSlots,
    );
    expect(a).toBeCloseTo(66855 / 1024, 3);
    expect(b).toBeCloseTo(67616 / 1024, 3);
  });

  it("corrects for an engine whose allocation NVML has not reported yet", () => {
    // Stack knows 40 GiB, NVML still shows 10 GiB used -> 30 GiB unaccounted for.
    const slot = {
      alias: "ENGINE_1",
      modelShort: "m",
      gpuMask: "0",
      vramMib: 40 * 1024,
      gpuBreakdownMib: undefined,
    } as unknown as RunningSlotInfo;
    const [free] = computeGpuAvailableList(
      [gpu({ memory_used: 10 * 1024, memory_free: 86 * 1024 })],
      [slot],
    );
    expect(free).toBeCloseTo(56, 3);
  });

  it("falls back to the conservative estimate when NVML reports no free figure", () => {
    const [free] = computeGpuAvailableList(
      [gpu({ memory_free: 0, memory_used: 0, memory_total: 0 })],
      noSlots,
    );
    expect(free).toBeCloseTo((98304 - 1792) / 1024, 3);
  });
});
describe("learned curve beyond its measured range", () => {
  const curve = [
    { ctx: 131_072, vramMib: 38_883 },
    { ctx: 262_144, vramMib: 44_375 },
    { ctx: 524_288, vramMib: 47_649 },
  ];

  it("interpolates between measured points", () => {
    const hit = interpolateLearnedCurveGb(curve, 393_216);
    expect(hit).not.toBeNull();
    expect(hit!.beyondMeasured).toBeFalsy();
    // Halfway between 262K and 512K.
    expect(hit!.vramGb).toBeCloseTo((44_375 + 47_649) / 2 / 1024, 2);
  });

  it("extrapolates past the top point and says so", () => {
    const hit = interpolateLearnedCurveGb(curve, 1_048_576);
    expect(hit).not.toBeNull();
    expect(hit!.beyondMeasured).toBe(true);
    // slope of the last two points, extended to 1M
    const slope = (47_649 - 44_375) / (524_288 - 262_144);
    expect(hit!.vramGb).toBeCloseTo((47_649 + slope * (1_048_576 - 524_288)) / 1024, 2);
  });

  it("extrapolates below the first point too", () => {
    const hit = interpolateLearnedCurveGb(curve, 4_096);
    expect(hit!.beyondMeasured).toBe(true);
    expect(hit!.vramGb).toBeLessThan(38_883 / 1024);
  });
});