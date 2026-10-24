//! "PREV TG / PREV PP" ghost — the last successful bench values survive the next run.
//!
//! A bench run clears its own result at the start (`ps.ppResult = null`) and a REPS run reports
//! only the median at the end; the ghost must therefore keep the previous values while results
//! are null and replace them as soon as a run completes. Pure so it can be tested without React.

import type { bench_PPBurstResult, bench_TGBenchResult } from "./types";

export type BenchLastRunGhost = {
  tgTps: number | null;
  ppTps: number | null;
  tgPar: number;
};

/** Merge the latest results into the ghost; returns the same object when nothing succeeded. */
export function mergeBenchLastRun(
  prev: BenchLastRunGhost | null,
  tg: bench_TGBenchResult | null,
  pp: bench_PPBurstResult | null,
): BenchLastRunGhost | null {
  const tgOk = tg?.success && tg.gen_tps > 0 ? tg : null;
  const ppOk = pp?.success && pp.bench_prefill_tps > 0 ? pp : null;
  if (!tgOk && !ppOk) return prev;
  return {
    tgTps: tgOk ? tgOk.gen_tps : prev?.tgTps ?? null,
    ppTps: ppOk ? ppOk.bench_prefill_tps : prev?.ppTps ?? null,
    tgPar: tgOk ? (tgOk.parallel_requests ?? 1) : prev?.tgPar ?? 1,
  };
}
