import { describe, expect, it } from "vitest";
import type { GpuInfo } from "./types";
import {
  eligibleAutoSplitIndices,
  formatDeviceSelection,
  parseDeviceSelection,
  reconcileDeviceOnSplitChange,
  toggleDeviceSelection,
} from "./gpuSelection";

function makeGpu(index: number): GpuInfo {
  return {
    index,
    name: `GPU ${index}`,
    memory_total: 24576,
    memory_total_manufactured: 24576,
    memory_used: 0,
    memory_free: 24576,
    memory_reserved: 0,
    utilization_gpu: 0,
    utilization_memory: 0,
    temperature_gpu: 40,
    temperature_hot_spot: 45,
    temperature_memory: 42,
    power_draw: 20,
    power_limit: 350,
  };
}

describe("gpuSelection", () => {
  const gpus = [makeGpu(0), makeGpu(1), makeGpu(2)];

  it("parses single, multi, and bare numeric device strings", () => {
    expect(parseDeviceSelection("GPU-1", gpus)).toEqual([1]);
    expect(parseDeviceSelection("GPU-2,GPU-0", gpus)).toEqual([0, 2]);
    expect(parseDeviceSelection("1, 2", gpus)).toEqual([1, 2]);
    expect(parseDeviceSelection("GPU-99", gpus)).toEqual([0]);
    expect(parseDeviceSelection("", gpus)).toEqual([0]);
  });

  it("formats sorted deduplicated device selection", () => {
    expect(formatDeviceSelection([2, 0, 2])).toBe("GPU-0,GPU-2");
    expect(formatDeviceSelection([1])).toBe("GPU-1");
  });

  it("filters excluded GPUs for auto-split", () => {
    expect(eligibleAutoSplitIndices(gpus, [2])).toEqual([0, 1]);
    expect(eligibleAutoSplitIndices(gpus, [0, 2])).toEqual([1]);
  });

  it("unified toggle promotes 1->2 to layer, keeps tensor on 3->2, collapses 2->1 to none, and keeps last GPU", () => {
    const r1 = toggleDeviceSelection([0], 1, "none", [0, 1, 2]);
    expect(r1).toEqual({ device: "GPU-0,GPU-1", split: "layer", indices: [0, 1] });

    const r2 = toggleDeviceSelection([0, 1, 2], 2, "tensor", [0, 1, 2]);
    expect(r2).toEqual({ device: "GPU-0,GPU-1", split: "tensor", indices: [0, 1] });

    const r3 = toggleDeviceSelection([0, 1], 1, "layer", [0, 1, 2]);
    expect(r3).toEqual({ device: "GPU-0", split: "none", indices: [0] });

    const r4 = toggleDeviceSelection([1], 1, "none", [0, 1, 2]);
    expect(r4).toEqual({ device: "GPU-1", split: "none", indices: [1] });
  });

  it("reconciles device selection when split mode changes", () => {
    expect(reconcileDeviceOnSplitChange("none", [1, 2], gpus, [])).toEqual({
      device: "GPU-1",
      split: "none",
    });
    expect(reconcileDeviceOnSplitChange("layer", [0], gpus, [2])).toEqual({
      device: "GPU-0,GPU-1",
      split: "layer",
    });
    // When <2 eligible GPUs remain, falls back to all GPUs
    expect(reconcileDeviceOnSplitChange("layer", [0], gpus, [1, 2])).toEqual({
      device: "GPU-0,GPU-1,GPU-2",
      split: "layer",
    });
    // Preserves existing multi-GPU selection
    expect(reconcileDeviceOnSplitChange("tensor", [0, 2], gpus, [2])).toEqual({
      device: "GPU-0,GPU-2",
      split: "tensor",
    });
  });
});
