import { describe, expect, it } from "vitest";
import type { GpuInfo } from "./types";
import { gpuScanSnapshotEqual } from "./telemetryGpu";

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
    pcie_gen: 5,
    pcie_gen_max: 5,
    pcie_width: 8,
    pcie_width_max: 16,
    pcie_rx_mib_per_s: 1,
    pcie_tx_mib_per_s: 0.5,
    ...overrides,
  };
}

describe("gpuScanSnapshotEqual", () => {
  it("treats a PCIe-only change as a new snapshot", () => {
    const a = [gpu({ pcie_rx_mib_per_s: 14 })];
    const b = [gpu({ pcie_rx_mib_per_s: 56 })];
    expect(gpuScanSnapshotEqual(a, b, 64)).toBe(false);
  });

  it("does not churn on sub-MiB PCIe noise", () => {
    const a = [gpu({ pcie_rx_mib_per_s: 14.2 })];
    const b = [gpu({ pcie_rx_mib_per_s: 14.4 })];
    expect(gpuScanSnapshotEqual(a, b, 64)).toBe(true);
  });

  it("treats a link-width change as a new snapshot", () => {
    const a = [gpu({ pcie_width: 8 })];
    const b = [gpu({ pcie_width: 16 })];
    expect(gpuScanSnapshotEqual(a, b, 64)).toBe(false);
  });
});
