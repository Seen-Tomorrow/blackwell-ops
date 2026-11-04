/**
 * Layer-split planning from exact per-block byte sizes.
 *
 * llama.cpp's `--split-mode layer` moves whole blocks and names each device's share as a
 * FRACTION OF LAYERS (`-ts`), not of bytes. On DeepSeek-V4.1 the 40 blocks grow from
 * 2.91 GiB to 4.42 GiB, so an even 20/20 layer split puts ~17 GiB more on one card while
 * the byte-balanced boundary (22 layers) is within ~1.2 GiB.
 *
 * This module answers one question: given the measured block sizes and a per-GPU budget,
 * which whole-layer boundary balances the load best, and what `-ts` expresses it.
 */

export type LayerPlanInput = {
  /** One entry per block, MiB, index order. */
  perBlockMib: number[];
  /** Token embedding — llama.cpp keeps it on the first device. */
  tokenEmbdMib?: number;
  /** Output tensor — rides with the last device. */
  outputMib?: number;
  /** Everything else (norms, biases) — spread evenly. */
  otherMib?: number;
  /** Per-GPU budget in MiB AFTER reserve, runtime overhead and any draft model. */
  budgetsMib: number[];
  /** KV cache per layer in MiB (scales with layers, so it follows the boundary). */
  kvMibPerLayer?: number;
};

export type LayerPlan = {
  /** Blocks on the first GPU; the rest follow in order. */
  boundary: number;
  /** `-ts` fractions, layer-proportional (0.55, 0.45 for 22/18 of 40). */
  ts: number[];
  /** Weights per GPU in MiB, excluding KV. */
  weightsMib: number[];
  /** KV per GPU in MiB. */
  kvMib: number[];
  /** weights + KV per GPU in MiB. */
  totalMib: number[];
  /** total / budget per GPU; the plan minimises the worst of these. */
  util: number[];
  maxUtil: number;
};

const requirePositive = (values: number[]): boolean =>
  values.length > 0 && values.every((v) => Number.isFinite(v) && v > 0);

/**
 * Best whole-layer boundary for a TWO-device layer split.
 *
 * Returns null when the inputs cannot describe a split (no blocks, non-positive budgets,
 * or more than two devices — a multi-way partition needs its own planner).
 */
export function planLayerSplit(input: LayerPlanInput): LayerPlan | null {
  const blocks = input.perBlockMib.filter((m) => Number.isFinite(m) && m > 0);
  if (blocks.length < 2) return null;
  if (input.budgetsMib.length !== 2) return null;
  if (!requirePositive(input.budgetsMib)) return null;

  const tokenEmbd = Math.max(0, input.tokenEmbdMib ?? 0);
  const output = Math.max(0, input.outputMib ?? 0);
  const other = Math.max(0, input.otherMib ?? 0);
  const kvPerLayer = Math.max(0, input.kvMibPerLayer ?? 0);

  // Prefix sums keep the scan linear in the block count.
  const prefix = new Array<number>(blocks.length + 1).fill(0);
  for (let i = 0; i < blocks.length; i += 1) prefix[i + 1] = prefix[i] + blocks[i];
  const total = prefix[blocks.length];

  const evaluate = (boundary: number): LayerPlan => {
    const firstLayers = boundary;
    const lastLayers = blocks.length - boundary;
    const weights0 = prefix[boundary] + tokenEmbd + other / 2;
    const weights1 = total - prefix[boundary] + output + other / 2;
    const kv0 = kvPerLayer * firstLayers;
    const kv1 = kvPerLayer * lastLayers;
    const totalMib = [weights0 + kv0, weights1 + kv1];
    const util = [totalMib[0] / input.budgetsMib[0], totalMib[1] / input.budgetsMib[1]];
    return {
      boundary,
      ts: [firstLayers / blocks.length, lastLayers / blocks.length],
      weightsMib: [weights0, weights1],
      kvMib: [kv0, kv1],
      totalMib,
      util,
      maxUtil: Math.max(util[0], util[1]),
    };
  };

  let best: LayerPlan | null = null;
  // Every boundary is tried: the block sizes are not monotone (dense layers are much
  // smaller than the MoE ones), so a greedy walk can stop at a local dip that leaves
  // several GiB on one card.
  for (let boundary = 1; boundary < blocks.length; boundary += 1) {
    const plan = evaluate(boundary);
    if (best == null || plan.maxUtil < best.maxUtil) best = plan;
  }
  return best;
}

/** `-ts` value llama.cpp expects, e.g. "0.550,0.450". */
export function formatTensorSplit(ts: number[]): string {
  return ts.map((f) => f.toFixed(3)).join(",");
}

/** Per-device utilisation text for the plan row, e.g. "75.0/97.0 GiB 77%". */
export function formatPlanLoads(plan: LayerPlan, budgetsMib: number[]): string[] {
  return plan.totalMib.map((mib, i) => {
    const budget = budgetsMib[i] > 0 ? budgetsMib[i] : 0;
    const pct = budget > 0 ? Math.round((mib / budget) * 100) : 0;
    return `${(mib / 1024).toFixed(1)}/${(budget / 1024).toFixed(1)} GiB ${pct}%`;
  });
}
