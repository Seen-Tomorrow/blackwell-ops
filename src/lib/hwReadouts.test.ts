import { describe, expect, it } from "vitest";
import type { GpuInfo, SystemInfo } from "./types";
import {
  barStep,
  cpuAvgFill,
  cpuClockTitle,
  fillLevel,
  formatCpuClock,
  formatPcieRate,
  hwTotals,
  pcieReadout,
  powerFill,
  shouldAnimate,
  tempTone,
  throttleHot,
  throttleText,
  utilFill,
} from "./hwReadouts";

function gpu(overrides: Partial<GpuInfo> = {}): GpuInfo {
  return {
    index: 0,
    name: "Test GPU",
    memory_total: 98_304,
    memory_total_manufactured: 98_304,
    memory_used: 1_024,
    memory_free: 97_280,
    temperature_gpu: 40,
    temperature_hot_spot: null,
    temperature_memory: null,
    power_draw: 100,
    power_limit: 600,
    utilization_gpu: 10,
    utilization_memory: 5,
    ...overrides,
  };
}

const sys = (overrides: Partial<SystemInfo> = {}): SystemInfo => ({
  total_memory_mib: 262_144,
  available_memory_mib: 131_072,
  total_memory_manufactured_mib: 262_144,
  ...overrides,
});

/**
 * The meter tween restarts whenever its target changes, and every restart costs compositor
 * frames. These assertions lock the "invisible motion must not cost anything" contract: the
 * target is quantized to the bar's visual step, so sub-step jitter collapses to one value.
 */
describe("barStep", () => {
  it("collapses sub-step jitter onto the same target", () => {
    expect(barStep(2.83)).toBe(barStep(2.92));
    expect(barStep(2.83)).toBe(3);
    expect(barStep(17.004)).toBe(barStep(17.012));
  });

  it("keeps real moves", () => {
    expect(barStep(2)).toBe(2);
    expect(barStep(10)).toBe(10);
    expect(barStep(10.4)).toBe(10.5);
  });

  it("honours a coarser step for small bars", () => {
    expect(barStep(2.4, 5)).toBe(0);
    expect(barStep(2.6, 5)).toBe(5);
    expect(barStep(7, 5)).toBe(5);
  });

  it("clamps to 0..100 and survives junk input", () => {
    expect(barStep(-3)).toBe(0);
    expect(barStep(0)).toBe(0);
    expect(barStep(140)).toBe(100);
    expect(barStep(Number.NaN)).toBe(0);
    expect(barStep(10, 0)).toBe(10);
  });
});

/**
 * The gate that decides whether a quantized move starts a tween. If this ever returns true
 * for a sub-step move, idle jitter wakes the compositor every tick again (the 1->6->10 % iGPU
 * spikes); if it returns false for a real step, the meters snap and the panel looks choppy.
 */
describe("shouldAnimate", () => {
  it("stays quiet on unchanged or sub-step targets", () => {
    expect(shouldAnimate(3, 3)).toBe(false);
    expect(shouldAnimate(3, 3.4)).toBe(false);
    expect(shouldAnimate(12.5, 12.9)).toBe(false);
  });

  it("animates exactly one visual step in either direction", () => {
    expect(shouldAnimate(3, 3.5)).toBe(true);
    expect(shouldAnimate(3.5, 3)).toBe(true);
  });

  it("animates large moves and honours a coarser gate", () => {
    expect(shouldAnimate(0, 100)).toBe(true);
    expect(shouldAnimate(100, 0)).toBe(true);
    expect(shouldAnimate(10, 14, 5)).toBe(false);
    expect(shouldAnimate(10, 15, 5)).toBe(true);
  });
});

describe("hwTotals", () => {
  it("sums power and VRAM across cards", () => {
    const totals = hwTotals(
      [gpu({ power_draw: 100, power_limit: 600, memory_used: 1_024 }), gpu({ index: 1, power_draw: 50, power_limit: 600, memory_used: 512 })],
      null,
    );
    expect(totals.powerW).toBe(150);
    expect(totals.powerLimitW).toBe(1_200);
    expect(totals.powerPct).toBeCloseTo(12.5, 5);
    expect(totals.vramUsedGb).toBeCloseTo(1.5, 5);
    expect(totals.vramTotalGb).toBeCloseTo(192, 5);
    expect(totals.vramPct).toBeCloseTo((1_536 / (98_304 * 2)) * 100, 5);
  });

  it("falls back to memory_total when manufactured is missing", () => {
    const totals = hwTotals([gpu({ memory_total: 24_576, memory_total_manufactured: 0 })], null);
    expect(totals.vramTotalGb).toBeCloseTo(24, 5);
  });

  it("derives host RAM from system info", () => {
    const totals = hwTotals([gpu()], sys());
    expect(totals.ramTotalGb).toBeCloseTo(256, 5);
    expect(totals.ramUsedGb).toBeCloseTo(128, 5);
    expect(totals.ramPct).toBeCloseTo(50, 5);
  });

  it("returns zeros instead of dividing by zero", () => {
    const totals = hwTotals([], null);
    expect(totals.powerPct).toBe(0);
    expect(totals.vramPct).toBe(0);
    expect(totals.ramPct).toBe(0);
    expect(totals.vramTotalGb).toBe(0);
  });

  it("ignores a zero power limit", () => {
    const totals = hwTotals([gpu({ power_draw: 90, power_limit: 0 })], null);
    expect(totals.powerPct).toBe(0);
    expect(totals.powerW).toBe(90);
  });
});

describe("fill tones", () => {
  it("classifies at the documented thresholds", () => {
    expect(fillLevel(50)).toBe("normal");
    expect(fillLevel(70)).toBe("normal");
    expect(fillLevel(71)).toBe("high");
    expect(fillLevel(90)).toBe("high");
    expect(fillLevel(91)).toBe("critical");
  });

  it("keeps the meter kind in the normal tone", () => {
    expect(utilFill("gpu", 40)).toBe("gpu");
    expect(utilFill("mem", 40)).toBe("mem");
    expect(utilFill("gpu", 80)).toBe("gpu-high");
    expect(utilFill("mem", 99)).toBe("mem-critical");
    expect(powerFill(40)).toBe("power");
    expect(powerFill(80)).toBe("power-high");
    expect(powerFill(99)).toBe("power-critical");
  });

  it("uses the CPU's own thresholds", () => {
    expect(cpuAvgFill(40)).toBe("cpu");
    expect(cpuAvgFill(70)).toBe("cpu-high");
    expect(cpuAvgFill(90)).toBe("cpu-critical");
  });

  it("treats 85 °C as warm, not hot", () => {
    expect(tempTone(50)).toBe("cool");
    expect(tempTone(70)).toBe("cool");
    expect(tempTone(71)).toBe("warm");
    expect(tempTone(85)).toBe("warm");
    expect(tempTone(86)).toBe("hot");
  });
});

describe("throttle reasons", () => {
  it("decodes the bits worth showing", () => {
    expect(throttleText(0x40)).toBe("HW THERMAL");
    expect(throttleText(0x04)).toBe("PWR CAP");
    expect(throttleText(0x40 | 0x04)).toBe("HW THERMAL · PWR CAP");
    expect(throttleText(0x200)).toBe("BOARD LIMIT");
  });

  it("treats idle and reliability bits as noise", () => {
    expect(throttleText(0x1)).toBeNull();
    expect(throttleText(0x400)).toBeNull();
    expect(throttleText(undefined)).toBeNull();
  });

  it("flags only thermal or slowdown reasons as hot", () => {
    expect(throttleHot(0x40)).toBe(true);
    expect(throttleHot(0x08)).toBe(true);
    expect(throttleHot(0x04)).toBe(false);
    expect(throttleHot(undefined)).toBe(false);
  });
});

describe("PCIe readout", () => {
  it("formats rates with the narrowest unit", () => {
    expect(formatPcieRate(undefined)).toBe("—");
    expect(formatPcieRate(Number.NaN)).toBe("—");
    expect(formatPcieRate(0.5)).toBe("0.5 MB/s");
    expect(formatPcieRate(14.2)).toBe("14 MB/s");
    expect(formatPcieRate(1_024)).toBe("1.00 GB/s");
    expect(formatPcieRate(2_048)).toBe("2.00 GB/s");
  });

  it("shows the negotiated link and the card's capability separately", () => {
    const readout = pcieReadout(
      gpu({ pcie_gen: 1, pcie_gen_max: 5, pcie_width: 8, pcie_width_max: 16, pcie_rx_mib_per_s: 14, pcie_tx_mib_per_s: 2 }),
      { rx: 56, tx: 8 },
    );
    expect(readout.gen).toBe(5);
    expect(readout.width).toBe(8);
    expect(readout.title).toBe("link now Gen1 x8 · card max Gen5 x16");
    expect(readout.rx).toBe("14 MB/s");
    expect(readout.tx).toBe("2.0 MB/s");
    expect(readout.peakRx).toBe("56 MB/s");
    expect(readout.peakTx).toBe("8.0 MB/s");
  });

  it("survives a card without PCIe data", () => {
    const readout = pcieReadout(gpu(), undefined);
    expect(readout.gen).toBeUndefined();
    expect(readout.title).toBeUndefined();
    expect(readout.rx).toBe("—");
    expect(readout.peakRx).toBe("—");
  });
});

describe("CPU clock", () => {
  it("prefers the live PDH clock over base", () => {
    expect(formatCpuClock({ name: "CPU", cores: 8, threads: 16, max_clock_mhz: 4_300, current_clock_mhz: 5_100, avg_usage_percent: 10, core_usages: [] })).toBe("5100 MHz");
  });

  it("falls back to base when PDH is unavailable", () => {
    expect(formatCpuClock({ name: "CPU", cores: 8, threads: 16, max_clock_mhz: 4_300, avg_usage_percent: 10, core_usages: [] })).toBe("4300 MHz");
    expect(formatCpuClock({ name: "CPU", cores: 8, threads: 16, max_clock_mhz: 0, avg_usage_percent: 5, core_usages: [] })).toBe("— MHz");
  });

  it("explains where the number came from", () => {
    const live = cpuClockTitle({ name: "CPU", cores: 8, threads: 16, max_clock_mhz: 4_300, current_clock_mhz: 5_100, avg_usage_percent: 10, core_usages: [] });
    expect(live).toContain("5100");
    expect(live).toContain("4300");
    const baseOnly = cpuClockTitle({ name: "CPU", cores: 8, threads: 16, max_clock_mhz: 4_300, avg_usage_percent: 10, core_usages: [] });
    expect(baseOnly).toContain("Base 4300");
    expect(cpuClockTitle({ name: "CPU", cores: 8, threads: 16, max_clock_mhz: 0, avg_usage_percent: 1, core_usages: [] })).toBe("CPU clock unavailable");
  });
});
