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
  /** Per-device overhead the launch will also allocate (compute graph buffers), MiB. */
  overheadMib?: number[];
  /** The same overhead as one total, split by layer count. A cold forecast knows the shape
   *  total but not where the boundary will land, and compute buffers follow layers. */
  overheadTotalMib?: number;
  /** `-ts` already in the launch config. It pins the placement, so the plan reports the
   *  layers that split really gets instead of proposing its own. */
  appliedTs?: number[];
};

export type LayerPlan = {
  /** Blocks on the first GPU; the rest follow in order. */
  boundary: number;
  /** The `-ts` this geometry corresponds to: the split found in the config when one is
   *  applied, otherwise the value that realises `boundary`. Always 3 decimals, because
   *  that is what the CLI receives. */
  ts: number[];
  /** The `-ts` to WRITE for the byte-balanced plan. Differs from `ts` when the config
   *  already holds a split that lands somewhere else. */
  applyTs: number[];
  /** Boundary the applied `-ts` really gets (llama.cpp ceiling), when one is set. */
  appliedBoundary?: number;
  /** Boundary the byte-balanced scan would pick. */
  optimalBoundary: number;
  /** Weights per GPU in MiB, excluding KV. */
  weightsMib: number[];
  /** KV per GPU in MiB. */
  kvMib: number[];
  /** weights + KV per GPU in MiB. */
  totalMib: number[];
  /** The budgets this plan was fitted into, per device, MiB. */
  budgetsMib: number[];
  /** Total block count, so the boundary reads "22 / 40". */
  layerCount: number;
  /** total / budget per GPU; the plan minimises the worst of these. */
  util: number[];
  maxUtil: number;
  /** Sum of totalMib across all devices — the whole planned footprint. */
  sumMib: number;
  /** Sum of the budgets the plan was fitted into. */
  budgetSumMib: number;
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

  const evaluate = (
    boundary: number,
  ): Omit<LayerPlan, "applyTs" | "optimalBoundary" | "appliedBoundary"> => {
    const firstLayers = boundary;
    const lastLayers = blocks.length - boundary;
    const weights0 = prefix[boundary] + tokenEmbd + other / 2;
    const weights1 = total - prefix[boundary] + output + other / 2;
    const kv0 = kvPerLayer * firstLayers;
    const kv1 = kvPerLayer * lastLayers;
    const shapeOverhead = Math.max(0, input.overheadTotalMib ?? 0);
    const extra0 = Math.max(
      0,
      input.overheadMib?.[0] ?? (shapeOverhead * firstLayers) / Math.max(blocks.length, 1),
    );
    const extra1 = Math.max(
      0,
      input.overheadMib?.[1] ?? (shapeOverhead * lastLayers) / Math.max(blocks.length, 1),
    );
    const totalMib = [weights0 + kv0 + extra0, weights1 + kv1 + extra1];
    const util = [totalMib[0] / input.budgetsMib[0], totalMib[1] / input.budgetsMib[1]];
    return {
      boundary,
      ts: [firstLayers / blocks.length, lastLayers / blocks.length],
      weightsMib: [weights0, weights1],
      kvMib: [kv0, kv1],
      budgetsMib: [input.budgetsMib[0], input.budgetsMib[1]],
      layerCount: blocks.length,
      totalMib,
      util,
      maxUtil: Math.max(util[0], util[1]),
      sumMib: totalMib[0] + totalMib[1],
      budgetSumMib: input.budgetsMib[0] + input.budgetsMib[1],
    };
  };

  let best: Omit<LayerPlan, "applyTs" | "optimalBoundary" | "appliedBoundary"> | null = null;
  // Every boundary is tried: the block sizes are not monotone (dense layers are much
  // smaller than the MoE ones), so a greedy walk can stop at a local dip that leaves
  // several GiB on one card.
  for (let boundary = 1; boundary < blocks.length; boundary += 1) {
    const plan = evaluate(boundary);
    if (best == null || plan.maxUtil < best.maxUtil) best = plan;
  }
  if (best == null) return null;

  // An applied `-ts` pins the placement: report the layers it really gets, so the bars and
  // the plan describe the launch that will happen, not the one we would have chosen.
  const appliedBoundary = input.appliedTs
    ? tensorSplitBoundary(input.appliedTs, blocks.length)
    : null;
  const display = appliedBoundary != null ? evaluate(appliedBoundary) : best;
  const displayTs =
    appliedBoundary != null && input.appliedTs
      ? [input.appliedTs[0], input.appliedTs[1]]
      : tensorSplitForBoundary(display.boundary, blocks.length);

  return {
    ...display,
    ts: displayTs,
    applyTs: tensorSplitForBoundary(best.boundary, blocks.length),
    optimalBoundary: best.boundary,
    appliedBoundary: appliedBoundary ?? undefined,
  };
}

/**
 * Boundary a `-ts` really gets.
 *
 * Measured on DeepSeek-V4.1 (40 blocks, `--fit off`), CUDA0 model buffer = prefix[boundary]:
 * `0.550 → 23 blocks` (81,240.99 MiB), `0.575 → 24` (85,297.72), `0.563 → 24` (85,297.72).
 * That is `ceil(ts * (n_layer + 1))` — the engine counts the output layer as one more slot,
 * and ceils: 0.55*41 = 22.55 → 23, 0.575*41 = 23.575 → 24, 0.563*41 = 23.083 → 24. Neither
 * `ts * n_layer` nor rounding fits the 0.563 point, which is what pinned the rule.
 */
export function tensorSplitBoundary(ts: number[], layerCount: number): number | null {
  if (layerCount < 2 || ts.length !== 2) return null;
  if (!ts.every((v) => Number.isFinite(v) && v > 0)) return null;
  const sum = ts[0] + ts[1];
  if (!(sum > 0)) return null;
  const boundary = Math.ceil(Math.fround(ts[0] / sum) * (layerCount + 1));
  return Math.min(Math.max(boundary, 1), layerCount);
}

/**
 * The `-ts` that makes the engine put exactly `boundary` blocks on the first device.
 *
 * The value sits in the MIDDLE of the band that maps to this boundary,
 * `(boundary - 0.5) / (n_layer + 1)`, because the engine ceils `ts * (n_layer + 1)`:
 * the band for `boundary` is `((b-1)/(n+1), b/(n+1)]`, and writing 22/40 = 0.55 lands on 23.
 * Mid-band also survives float dust. 3 decimals, because that is what `-ts` carries.
 */
export function tensorSplitForBoundary(boundary: number, layerCount: number): number[] {
  const target = Math.min(Math.max(boundary, 1), layerCount - 1);
  const first = Math.round(((target - 0.5) / (layerCount + 1)) * 1000) / 1000;
  return [first, Math.round((1 - first) * 1000) / 1000];
}

/** `-ts` value llama.cpp expects, e.g. "0.550,0.450". */
export function formatTensorSplit(ts: number[]): string {
  return ts.map((f) => f.toFixed(3)).join(",");
}

/** Conservative fallback when no calibration exists (a card that never launched here). */
export const DEFAULT_RUNTIME_OVERHEAD_MIB = 768;

/** One row from get_gpu_calibration — the measured runtime cost per device. */
export type GpuCalibrationRow = {
  index: number;
  median_residual_mib: number;
  samples: number;
};

/**
 * CUDA context + allocator slack for a device.
 *
 * Measured under TCC on this box at 64K and 512K: 627 and 629 MiB — flat, because a context
 * does not grow with context length. Under WDDM the same figure cannot be attributed, so the
 * conservative default is used until a launch has been sampled there.
 */
export function runtimeOverheadMibForDevice(
  index: number,
  calibration?: GpuCalibrationRow[] | null,
): number {
  const row = calibration?.find((c) => c.index === index);
  if (row && row.samples > 0 && Number.isFinite(row.median_residual_mib) && row.median_residual_mib > 0) {
    return row.median_residual_mib;
  }
  return DEFAULT_RUNTIME_OVERHEAD_MIB;
}

/** Planner budgets: NVML free, minus the measured runtime overhead and any draft model. */
export function budgetsFromFree(
  freeMib: number[],
  overheadMibList: number[],
  draftMib: number[] = [],
): number[] {
  return freeMib.map((free, i) => {
    const overhead = overheadMibList[i] ?? DEFAULT_RUNTIME_OVERHEAD_MIB;
    const draft = draftMib[i] ?? 0;
    return Math.max(0, free - overhead - draft);
  });
}

/** End-to-end plan from live numbers: layer sizes + free VRAM + calibration. */
export function planFromLive(args: {
  perBlockMib: number[];
  tokenEmbdMib?: number;
  outputMib?: number;
  otherMib?: number;
  kvMibPerLayer?: number;
  /** Per-device overhead the launch also allocates (compute graph buffers), MiB. */
  overheadMib?: number[];
  /** Same overhead as one total, split by layer count - for a cold forecast, which knows
   *  the shape total but not how the boundary will land. */
  overheadTotalMib?: number;
  freeMib: number[];
  calibration?: GpuCalibrationRow[] | null;
  draftMib?: number[];
  /** `-ts` from the launch config — the placement the engine will really get. */
  appliedTs?: number[];
}): LayerPlan | null {
  const overheads = args.freeMib.map((_, i) => runtimeOverheadMibForDevice(i, args.calibration));
  const budgetsMib = budgetsFromFree(args.freeMib, overheads, args.draftMib);
  return planLayerSplit({
    perBlockMib: args.perBlockMib,
    tokenEmbdMib: args.tokenEmbdMib,
    outputMib: args.outputMib,
    otherMib: args.otherMib,
    kvMibPerLayer: args.kvMibPerLayer,
    overheadMib: args.overheadMib,
    overheadTotalMib: args.overheadTotalMib,
    budgetsMib,
    appliedTs: args.appliedTs,
  });
}