import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_OVERHEAD_MIB,
  budgetsFromFree,
  runtimeOverheadMibForDevice,
  formatTensorSplit,
  planFromLive,
  planLayerSplit,
  tensorSplitBoundaries,
  tensorSplitBoundary,
  tensorSplitForBoundaries,
  tensorSplitForBoundary,
} from "./vramLayerPlan";

/** Real DeepSeek-V4.1 block sizes (GiB), as read from the tensor table. */
const V41_BLOCKS_GIB = [
  3.2, 3.16, 2.93, 2.91, 2.91, 3.04, 3.04, 3.04, 3.06, 3.04, 3.7, 3.7, 3.7, 3.7, 3.84,
  3.7, 3.7, 3.7, 3.7, 3.7, 3.98, 3.96, 3.96, 3.96, 3.97, 4.49, 4.49, 4.45, 4.46, 4.45,
  4.45, 4.45, 4.46, 4.45, 4.45, 4.18, 4.19, 4.18, 4.18, 4.18,
];
const toMib = (gib: number[]) => gib.map((g) => g * 1024);
const GIB = 1024 * 1024;

describe("layer split planning", () => {
  it("balances by bytes, not by layer count", () => {
    const plan = planLayerSplit({
      perBlockMib: toMib(V41_BLOCKS_GIB),
      outputMib: 0.5 * 1024,
      budgetsMib: [97 * 1024, 97 * 1024],
    });
    expect(plan).not.toBeNull();
    // The blocks grow towards the end, so the boundary sits above the halfway mark.
    expect(plan!.boundary).toBe(22);
    // The written -ts must read back as the boundary it means (0.55f * 40 = 22.0000005,
    // which the engine ceils to 23 layers), so the writer steps down.
    expect(tensorSplitBoundary(plan!.ts, 40)).toBe(plan!.boundary);
    expect(formatTensorSplit(plan!.applyTs)).toBe(formatTensorSplit(plan!.ts));

    const imbalance = Math.abs(plan!.weightsMib[0] - plan!.weightsMib[1]) / 1024;
    const evenSplitImbalance =
      Math.abs(
        toMib(V41_BLOCKS_GIB.slice(0, 20)).reduce((a, b) => a + b, 0) -
          toMib(V41_BLOCKS_GIB.slice(20)).reduce((a, b) => a + b, 0),
      ) / 1024;
    // Measured model buffers on this split: 77,184 / 79,785 MiB (2.54 GiB apart); token_embd
    // is CUDA_Host and is not charged to GPU0 any more.
    expect(imbalance).toBeLessThan(3);
    // An even 20/20 split leaves more than 10 GiB on one card - the reason the planner exists.
    expect(evenSplitImbalance).toBeGreaterThan(10);
  });

  it("gives more layers to the GPU with more budget", () => {
    const plan = planLayerSplit({
      perBlockMib: toMib(V41_BLOCKS_GIB),
      budgetsMib: [60 * 1024, 110 * 1024],
    });
    expect(plan).not.toBeNull();
    expect(plan!.boundary).toBeLessThan(22);
    // Neither card is asked to exceed its budget.
    expect(plan!.util[0]).toBeLessThanOrEqual(1);
    expect(plan!.util[1]).toBeLessThanOrEqual(1);
  });

  it("spreads N cards by utilisation so mixed capacities finish together", () => {
    const blocks = new Array(24).fill(1024);
    const plan = planLayerSplit({
      perBlockMib: blocks,
      budgetsMib: [24 * 1024, 48 * 1024, 72 * 1024],
    });
    expect(plan).not.toBeNull();
    // 1:2:3 budgets on identical blocks -> 1:2:3 layers, every card at the same fill.
    expect(plan!.deviceLayers).toEqual([4, 8, 12]);
    expect(plan!.boundaries).toEqual([4, 12]);
    expect(plan!.maxUtil - Math.min(...plan!.util)).toBeLessThan(1e-9);
    // The engine reads the written -ts back as exactly those boundaries.
    expect(tensorSplitBoundaries(plan!.ts, 24)).toEqual(plan!.boundaries);
    expect(tensorSplitBoundaries(plan!.applyTs, 24)).toEqual(plan!.boundaries);
  });

  it("leaves room on the card that also carries unplanned buffers", () => {
    const plan = planLayerSplit({
      perBlockMib: new Array(12).fill(1024),
      budgetsMib: [24 * 1024, 24 * 1024],
      // Compute/CUDA-graph buffers the FIT probe never prints, all on device 0.
      overheadMib: [4 * 1024, 0],
    });
    expect(plan).not.toBeNull();
    // Equal budgets but 4 GiB of device-0 extras: the boundary moves four blocks earlier.
    expect(plan!.boundary).toBe(4);
    expect(Math.abs(plan!.totalMib[0]! - plan!.totalMib[1]!)).toBeLessThan(1);
    expect(plan!.util[0]).toBeCloseTo(plan!.util[1]!, 6);
  });

  it("reads a -ts back the way llama.cpp does, and writes one that lands where it says", () => {
    // Measured on DeepSeek-V4.1 (40 blocks, --fit off), CUDA0 model buffer = prefix[boundary]:
    // 0.550 -> 23 blocks (81,240.99 MiB), 0.575 -> 24 (85,297.72), 0.563 -> 24 (85,297.72).
    // That is ceil(ts * (n_layer + 1)); the 0.563 point rules out rounding.
    expect(tensorSplitBoundary([0.55, 0.45], 40)).toBe(23);
    expect(tensorSplitBoundary([0.575, 0.425], 40)).toBe(24);
    expect(tensorSplitBoundary([0.563, 0.437], 40)).toBe(24);
    expect(tensorSplitBoundary([0.5, 0.5], 40)).toBe(21);
    expect(tensorSplitBoundary([0, 1], 40)).toBeNull();
    expect(tensorSplitBoundary([1], 40)).toBeNull();
    // Round trip: whatever boundary we mean, the value we write reads back as that boundary.
    for (const boundary of [1, 7, 20, 22, 23, 39]) {
      const ts = tensorSplitForBoundary(boundary, 40);
      expect(tensorSplitBoundary(ts, 40), JSON.stringify(ts)).toBe(boundary);
      expect(ts[0] + ts[1]).toBeCloseTo(1, 6);
      expect(formatTensorSplit(ts).split(",")).toHaveLength(2);
    }
    // Every multi-device boundary tuple round-trips too.
    for (const boundaries of [[1, 2], [8, 16], [13, 23], [4, 8, 12], [5, 10, 15, 20]]) {
      const ts = tensorSplitForBoundaries(boundaries, 24);
      expect(tensorSplitBoundaries(ts, 24), JSON.stringify(ts)).toEqual(boundaries);
      expect(ts.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 2);
      expect(formatTensorSplit(ts).split(",")).toHaveLength(boundaries.length + 1);
    }
  });

  it("keeps KV with the layers that carry it", () => {
    const withoutKv = planLayerSplit({
      perBlockMib: toMib(V41_BLOCKS_GIB),
      budgetsMib: [97 * 1024, 97 * 1024],
    });
    const withKv = planLayerSplit({
      perBlockMib: toMib(V41_BLOCKS_GIB),
      budgetsMib: [97 * 1024, 97 * 1024],
      kvMibPerLayer: 260,
    });
    expect(withKv!.totalMib[0] - withoutKv!.totalMib[0]).toBeCloseTo(260 * 22, 3);
    expect(withKv!.ts).toEqual(withoutKv!.ts);
  });

  it("reports the planned footprint and what it was fitted into", () => {
    const plan = planLayerSplit({
      perBlockMib: toMib(V41_BLOCKS_GIB),
      outputMib: 0.5 * 1024,
      budgetsMib: [97 * 1024, 97 * 1024],
    });
    expect(plan).not.toBeNull();
    // sum is the per-device loads, and never exceeds the budgets it was fitted into
    expect(plan!.sumMib).toBeCloseTo(plan!.totalMib[0]! + plan!.totalMib[1]!, 3);
    expect(plan!.sumMib).toBeLessThanOrEqual(plan!.budgetSumMib);
  });

  it("refuses inputs it cannot plan", () => {
    expect(planLayerSplit({ perBlockMib: [], budgetsMib: [1024, 1024] })).toBeNull();
    expect(planLayerSplit({ perBlockMib: toMib(V41_BLOCKS_GIB), budgetsMib: [0, 1024] })).toBeNull();
    expect(planLayerSplit({ perBlockMib: toMib(V41_BLOCKS_GIB), budgetsMib: [1024] })).toBeNull();
    // Fewer blocks than cards cannot give each card a whole layer.
    expect(planLayerSplit({ perBlockMib: [1024], budgetsMib: [1024, 1024, 1024] })).toBeNull();
  });

  it("reports per-device load against budget", () => {
    const plan = planLayerSplit({
      perBlockMib: toMib(V41_BLOCKS_GIB),
      budgetsMib: [97 * GIB / 1024, 97 * GIB / 1024],
    });
    expect(plan).not.toBeNull();
  });
});
describe("calibrated budgets", () => {
  it("uses the measured median per device, and a conservative default without one", () => {
    const calibration = [
      { index: 0, median_residual_mib: 628.1, samples: 2 },
      { index: 1, median_residual_mib: 632.6, samples: 2 },
    ];
    expect(runtimeOverheadMibForDevice(0, calibration)).toBeCloseTo(628.1, 1);
    expect(runtimeOverheadMibForDevice(1, calibration)).toBeCloseTo(632.6, 1);
    // A card that never launched here: default, not zero.
    expect(runtimeOverheadMibForDevice(2, calibration)).toBe(DEFAULT_RUNTIME_OVERHEAD_MIB);
    expect(runtimeOverheadMibForDevice(0, null)).toBe(DEFAULT_RUNTIME_OVERHEAD_MIB);
    // A row with no samples is not evidence of a zero-cost context.
    expect(runtimeOverheadMibForDevice(0, [{ index: 0, median_residual_mib: 0, samples: 0 }])).toBe(
      DEFAULT_RUNTIME_OVERHEAD_MIB,
    );
  });

  it("subtracts context and draft, and never goes negative", () => {
    expect(budgetsFromFree([67_802, 68_622], [628.1, 632.6])).toEqual([
      67_173.9, 67_989.4,
    ]);
    expect(budgetsFromFree([1000], [800], [400])).toEqual([0]);
  });

  it("plans from live free VRAM with calibration applied", () => {
    const calibration = [
      { index: 0, median_residual_mib: 628.1, samples: 2 },
      { index: 1, median_residual_mib: 632.6, samples: 2 },
    ];
    const plan = planFromLive({
      perBlockMib: toMib(V41_BLOCKS_GIB),
      outputMib: 0.5 * 1024,
      // Idle cards under TCC (no engine loaded): 97,475 MiB free each.
      freeMib: [97_475, 97_475],
      calibration,
    });
    expect(plan).not.toBeNull();
    // Budgets are free minus context, so the plan must fit inside those.
    expect(plan!.totalMib[0]).toBeLessThanOrEqual(97_475 - 628.1);
    expect(plan!.totalMib[1]).toBeLessThanOrEqual(97_475 - 632.6);
    expect(plan!.sumMib).toBeLessThanOrEqual(plan!.budgetSumMib);
  });
});
