/**
 * Layer-split planning from exact per-block byte sizes.
 *
 * llama.cpp's `--split-mode layer` moves whole blocks and names each device's share as a
 * FRACTION OF LAYERS (`-ts`), not of bytes. On DeepSeek-V4.1 the 40 blocks grow from
 * 2.91 GiB to 4.42 GiB, so an even 20/20 layer split puts ~17 GiB more on one card while
 * the byte-balanced boundary (22 layers) is within ~1.2 GiB.
 *
 * This module answers one question: given the measured block sizes and a per-GPU budget,
 * which whole-layer boundaries balance the load best for N cards, and what `-ts` expresses
 * them. Mixed-capacity topologies balance by UTILISATION (bytes / budget), not by bytes, so
 * a 24 GiB card and a 48 GiB card both end up equally close to their own ceiling.
 */

export type LayerPlanInput = {
  /** One entry per block, MiB, index order. */
  perBlockMib: number[];
  /** Output tensor, which rides with the last device. */
  outputMib?: number;
  /** Everything else (norms, biases), spread evenly across the devices. */
  otherMib?: number;
  /** Per-GPU budget in MiB AFTER reserve, runtime overhead and any draft model. */
  budgetsMib: number[];
  /** KV cache per layer in MiB (scales with layers, so it follows the boundary). */
  kvMibPerLayer?: number;
  /** Per-device overhead the launch will also allocate (compute graph buffers), MiB. */
  overheadMib?: number[];
  /** The same overhead as one total, split by layer count. A cold forecast knows the shape
   *  total but not where the boundaries will land, and compute buffers follow layers. */
  overheadTotalMib?: number;
};

export type LayerPlan = {
  /** First boundary: blocks on device 0. Kept for callers that read one number. */
  boundary: number;
  /** Every cumulative boundary B1..B(n-1), ascending. Device i owns [B(i-1), B(i)). */
  boundaries: number[];
  /** Whole blocks per device, length = number of budgets. */
  deviceLayers: number[];
  /** The `-ts` that realises these boundaries. Always 3 decimals, because that is what
   *  the CLI receives. */
  ts: number[];
  /** The `-ts` to WRITE for this plan. Same as `ts` while the app owns placement. */
  applyTs: number[];
  /** First boundary of the byte-balanced plan. */
  optimalBoundary: number;
  /** Weights per GPU in MiB, excluding KV. */
  weightsMib: number[];
  /** KV per GPU in MiB. */
  kvMib: number[];
  /** weights + KV + per-device overhead, per GPU in MiB. */
  totalMib: number[];
  /** The budgets this plan was fitted into, per device, MiB. */
  budgetsMib: number[];
  /** Total block count, so a boundary reads "22 / 40". */
  layerCount: number;
  /** total / budget per GPU; the plan minimises the worst of these. */
  util: number[];
  maxUtil: number;
  /** Sum of totalMib across all devices - the whole planned footprint. */
  sumMib: number;
  /** Sum of the budgets the plan was fitted into. */
  budgetSumMib: number;
};

const round3 = (value: number): number => {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
};

const finiteNonNegative = (values: number[]): boolean =>
  values.length > 0 && values.every((v) => Number.isFinite(v) && v >= 0);

/**
 * Cumulative boundaries a `-ts` really gets.
 *
 * Measured on DeepSeek-V4.1 (40 blocks, `--fit off`), CUDA0 model buffer = prefix[boundary]:
 * `0.550 -> 23 blocks` (81,240.99 MiB), `0.575 -> 24` (85,297.72), `0.563 -> 24`
 * (85,297.72). The engine normalises the fractions to cumulative split points and assigns
 * layer `il` with `upper_bound(split, il / (n_layer + 1))`, which is `ceil(f * (n_layer + 1))`
 * for every non-integral point. For N devices the same rule applies to every cumulative
 * prefix, so one function covers 2 and N.
 */
export function tensorSplitBoundaries(ts: number[], layerCount: number): number[] | null {
  const devices = ts.length;
  if (layerCount < 2 || devices < 2) return null;
  if (!ts.every((v) => Number.isFinite(v) && v > 0)) return null;
  const sum = ts.reduce((total, value) => total + value, 0);
  if (!(sum > 0)) return null;

  const slots = layerCount + 1;
  const boundaries: number[] = [];
  let cumulative = 0;
  for (let i = 0; i < devices - 1; i += 1) {
    cumulative = Math.fround(cumulative + Math.fround(ts[i] / sum));
    const raw = Math.ceil(Math.fround(cumulative) * slots);
    // Keep room for one block on every device that still has to be placed.
    const lower = (boundaries.length ? boundaries[boundaries.length - 1] : 0) + 1;
    const upper = layerCount - (devices - 1 - i);
    boundaries.push(Math.min(Math.max(raw, lower), upper));
  }
  return boundaries;
}

/** First boundary a `-ts` really gets; the two-device form of `tensorSplitBoundaries`. */
export function tensorSplitBoundary(ts: number[], layerCount: number): number | null {
  return tensorSplitBoundaries(ts, layerCount)?.[0] ?? null;
}

/**
 * The `-ts` that makes the engine put exactly `boundaries` blocks on the devices.
 *
 * Each cumulative fraction sits in the MIDDLE of the band that maps to its boundary,
 * `(boundary - 0.5) / (n_layer + 1)`, because the engine ceils `fraction * (n_layer + 1)`:
 * the band for `boundary` is `((b-1)/(n+1), b/(n+1)]`, and writing 22/40 = 0.55 lands on 23.
 * Mid-band survives float dust. 3 decimals, because that is what `-ts` carries.
 */
export function tensorSplitForBoundaries(boundaries: number[], layerCount: number): number[] {
  const devices = boundaries.length + 1;
  if (boundaries.length === 0 || layerCount < devices) {
    // No usable boundaries: an even fraction keeps the CLI valid instead of emitting NaN.
    const even = 1 / devices;
    return Array.from({ length: devices }, () => round3(even));
  }

  const slots = layerCount + 1;
  const safe: number[] = [];
  let previous = 0;
  for (let i = 0; i < boundaries.length; i += 1) {
    const lower = previous + 1;
    const upper = layerCount - (boundaries.length - i);
    const boundary = Math.min(Math.max(Math.round(boundaries[i]), lower), upper);
    safe.push(boundary);
    previous = boundary;
  }

  const cumulative = safe.map((boundary) => round3((boundary - 0.5) / slots));
  const ts: number[] = [];
  let previousCumulative = 0;
  for (const value of cumulative) {
    ts.push(round3(value - previousCumulative));
    previousCumulative = value;
  }
  ts.push(round3(1 - previousCumulative));
  return ts;
}

/** The `-ts` that makes the engine put exactly `boundary` blocks on the first device. */
export function tensorSplitForBoundary(boundary: number, layerCount: number): number[] {
  return tensorSplitForBoundaries([boundary], layerCount);
}

/** `-ts` value llama.cpp expects, e.g. "0.550,0.450". */
export function formatTensorSplit(ts: number[]): string {
  return ts.map((f) => f.toFixed(3)).join(",");
}

/** Conservative fallback when no calibration exists (a card that never launched here). */
export const DEFAULT_RUNTIME_OVERHEAD_MIB = 768;

/** One row from get_gpu_calibration - the measured runtime cost per device. */
export type GpuCalibrationRow = {
  index: number;
  median_residual_mib: number;
  samples: number;
};

/**
 * CUDA context + allocator slack for a device.
 *
 * Measured under TCC on this box at 64K and 512K: 627 and 629 MiB - flat, because a context
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

type Segment = {
  layers: number;
  weightsMib: number;
  kvMib: number;
  totalMib: number;
};

/**
 * Best whole-layer boundaries for an N-device layer split.
 *
 * The engine can only place contiguous blocks in order, so the search space is every
 * ascending boundary tuple. A min-max dynamic program over (device, blocks consumed) finds
 * the tuple whose worst per-card utilisation is smallest; a second key (sum of squared
 * utilisations) spreads the remaining slack instead of piling it on one card. That is what
 * makes mixed budgets work: a 24 GiB and a 48 GiB card get layer shares proportional to
 * their own budgets, so both sit at the same fill fraction and neither hits its ceiling.
 *
 * Returns null when the inputs cannot describe a split (no blocks, fewer devices than
 * blocks, or a non-positive budget).
 */
export function planLayerSplit(input: LayerPlanInput): LayerPlan | null {
  const blocks = input.perBlockMib;
  const devices = input.budgetsMib.length;
  if (blocks.length < 2) return null;
  if (devices < 2 || blocks.length < devices) return null;
  if (!finiteNonNegative(blocks)) return null;
  if (!input.budgetsMib.every((mib) => Number.isFinite(mib) && mib > 0)) return null;

  const layerCount = blocks.length;
  const output = Math.max(0, input.outputMib ?? 0);
  const other = Math.max(0, input.otherMib ?? 0);
  const kvPerLayer = Math.max(0, input.kvMibPerLayer ?? 0);
  const shapeOverhead = Math.max(0, input.overheadTotalMib ?? 0);
  const otherPerDevice = other / devices;

  // Prefix sums keep every segment cost O(1).
  const prefix = new Array<number>(layerCount + 1).fill(0);
  for (let i = 0; i < layerCount; i += 1) prefix[i + 1] = prefix[i] + blocks[i];

  const segmentFor = (device: number, from: number, to: number): Segment => {
    const layers = to - from;
    const weightsMib =
      prefix[to] -
      prefix[from] +
      (device === devices - 1 ? output : 0) +
      otherPerDevice;
    const kvMib = kvPerLayer * layers;
    const measuredOverhead = input.overheadMib?.[device];
    const overheadMib =
      measuredOverhead != null && Number.isFinite(measuredOverhead) && measuredOverhead >= 0
        ? measuredOverhead
        : (shapeOverhead * layers) / layerCount;
    return { layers, weightsMib, kvMib, totalMib: weightsMib + kvMib + overheadMib };
  };

  type Node = {
    /** Worst utilisation on the prefix path. */
    maxUtil: number;
    /** Sum of squared utilisations; breaks ties toward an even spread. */
    sumSq: number;
    /** First block of this device (the previous device's exclusive end). */
    previous: number;
  };

  const dp: Array<Array<Node | null>> = Array.from({ length: devices + 1 }, () =>
    new Array<Node | null>(layerCount + 1).fill(null),
  );
  dp[0]![0] = { maxUtil: 0, sumSq: 0, previous: -1 };

  for (let device = 1; device <= devices; device += 1) {
    const minEnd = device;
    const maxEnd = layerCount - (devices - device);
    for (let end = minEnd; end <= maxEnd; end += 1) {
      const budget = input.budgetsMib[device - 1]!;
      for (let start = device - 1; start < end; start += 1) {
        const previous = dp[device - 1]![start];
        if (!previous) continue;
        const segment = segmentFor(device - 1, start, end);
        const util = segment.totalMib / budget;
        const maxUtil = Math.max(previous.maxUtil, util);
        const sumSq = previous.sumSq + util * util;
        const current = dp[device]![end];
        const better =
          !current ||
          maxUtil < current.maxUtil - 1e-9 ||
          (Math.abs(maxUtil - current.maxUtil) <= 1e-9 && sumSq < current.sumSq);
        if (better) {
          dp[device]![end] = { maxUtil, sumSq, previous: start };
        }
      }
    }
  }

  if (!dp[devices]![layerCount]) return null;

  // Walk the chosen path backwards, keeping every boundary except the final layer count.
  const boundaries = new Array<number>(devices - 1).fill(0);
  let end = layerCount;
  for (let device = devices; device >= 2; device -= 1) {
    const node = dp[device]![end]!;
    boundaries[device - 2] = node.previous;
    end = node.previous;
  }

  const deviceLayers: number[] = [];
  const weightsMib: number[] = [];
  const kvMib: number[] = [];
  const totalMib: number[] = [];
  const util: number[] = [];
  let start = 0;
  for (let device = 0; device < devices; device += 1) {
    const stop = device === devices - 1 ? layerCount : boundaries[device]!;
    const segment = segmentFor(device, start, stop);
    deviceLayers.push(segment.layers);
    weightsMib.push(segment.weightsMib);
    kvMib.push(segment.kvMib);
    totalMib.push(segment.totalMib);
    util.push(segment.totalMib / input.budgetsMib[device]!);
    start = stop;
  }

  const ts = tensorSplitForBoundaries(boundaries, layerCount);
  return {
    boundary: boundaries[0]!,
    boundaries,
    deviceLayers,
    ts,
    applyTs: ts.slice(),
    optimalBoundary: boundaries[0]!,
    weightsMib,
    kvMib,
    totalMib,
    budgetsMib: [...input.budgetsMib],
    layerCount,
    util,
    maxUtil: Math.max(...util),
    sumMib: totalMib.reduce((sum, mib) => sum + mib, 0),
    budgetSumMib: input.budgetsMib.reduce((sum, mib) => sum + mib, 0),
  };
}

/** End-to-end plan from live numbers: layer sizes + free VRAM + calibration. */
export function planFromLive(args: {
  perBlockMib: number[];
  outputMib?: number;
  otherMib?: number;
  kvMibPerLayer?: number;
  /** Per-device overhead the launch also allocates (compute graph buffers), MiB. */
  overheadMib?: number[];
  /** Same overhead as one total, split by layer count - for a cold forecast, which knows
   *  the shape total but not how the boundaries will land. */
  overheadTotalMib?: number;
  freeMib: number[];
  calibration?: GpuCalibrationRow[] | null;
  draftMib?: number[];
}): LayerPlan | null {
  const overheads = args.freeMib.map((_, i) => runtimeOverheadMibForDevice(i, args.calibration));
  const budgetsMib = budgetsFromFree(args.freeMib, overheads, args.draftMib);
  return planLayerSplit({
    perBlockMib: args.perBlockMib,
    outputMib: args.outputMib,
    otherMib: args.otherMib,
    kvMibPerLayer: args.kvMibPerLayer,
    overheadMib: args.overheadMib,
    overheadTotalMib: args.overheadTotalMib,
    budgetsMib,
  });
}
