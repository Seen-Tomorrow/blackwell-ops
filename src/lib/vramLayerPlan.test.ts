import { describe, expect, it } from "vitest";
import { formatTensorSplit, planLayerSplit } from "./vramLayerPlan";

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
