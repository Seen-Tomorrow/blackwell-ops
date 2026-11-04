import { describe, expect, it } from "vitest";
import type { GpuInfo } from "../../lib/types";
import { computeGpuAvailableList, type RunningSlotInfo } from "./shared";

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
