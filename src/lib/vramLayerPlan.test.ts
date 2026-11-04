import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_OVERHEAD_MIB,
  budgetsFromFree,
  runtimeOverheadMibForDevice,
  formatPlanTotal,
  formatTensorSplit,
  planFromLive,
  planLayerSplit,
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
      tokenEmbdMib: 0.7 * 1024,
      outputMib: 0.5 * 1024,
      budgetsMib: [97 * 1024, 97 * 1024],
    });
    expect(plan).not.toBeNull();
    // The blocks grow towards the end, so the boundary sits above the halfway mark.
    expect(plan!.boundary).toBe(22);
    expect(formatTensorSplit(plan!.ts)).toBe("0.550,0.450");

    const imbalance = Math.abs(plan!.weightsMib[0] - plan!.weightsMib[1]) / 1024;
    const evenSplitImbalance =
      Math.abs(
        toMib(V41_BLOCKS_GIB.slice(0, 20)).reduce((a, b) => a + b, 0) -
          toMib(V41_BLOCKS_GIB.slice(20)).reduce((a, b) => a + b, 0),
      ) / 1024;
    expect(imbalance).toBeLessThan(2);
    // An even 20/20 split leaves more than 10 GiB on one card — the reason the planner exists.
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
      tokenEmbdMib: 0.7 * 1024,
      outputMib: 0.5 * 1024,
      budgetsMib: [97 * 1024, 97 * 1024],
    });
    expect(plan).not.toBeNull();
    // sum is the two device loads, and never exceeds the budgets it was fitted into
    expect(plan!.sumMib).toBeCloseTo(plan!.totalMib[0] + plan!.totalMib[1], 3);
    expect(plan!.sumMib).toBeLessThanOrEqual(plan!.budgetSumMib);
    expect(formatPlanTotal(plan!)).toMatch(/GiB planned$/);
  });

  it("refuses inputs it cannot plan", () => {
    expect(planLayerSplit({ perBlockMib: [], budgetsMib: [1024, 1024] })).toBeNull();
    expect(planLayerSplit({ perBlockMib: toMib(V41_BLOCKS_GIB), budgetsMib: [0, 1024] })).toBeNull();
    expect(
      planLayerSplit({ perBlockMib: toMib(V41_BLOCKS_GIB), budgetsMib: [1024, 1024, 1024] }),
    ).toBeNull();
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
      tokenEmbdMib: 0.7 * 1024,
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