import { describe, expect, it } from "vitest";

import { mergeBenchLastRun } from "./benchLastRun";
import type { bench_PPBurstResult, bench_TGBenchResult } from "./types";

function tg(genTps: number, parallel = 1): bench_TGBenchResult {
  return {
    prompt_tokens: 550,
    gen_tokens: 1024,
    prompt_tps: 5000,
    gen_tps: genTps,
    itl_ms: 1,
    success: true,
    parallel_requests: parallel,
  };
}

function pp(prefillTps: number): bench_PPBurstResult {
  return {
    bench_prefill_tps: prefillTps,
    bench_prompt_tokens_actual: 8192,
    success: true,
  };
}

describe("mergeBenchLastRun", () => {
  it("keeps the previous values while a run has cleared its results", () => {
    const first = mergeBenchLastRun(null, tg(110.25), pp(6404.8));
    expect(first).toEqual({ tgTps: 110.25, ppTps: 6404.8, tgPar: 1 });

    // A new run nulls both results; the ghost must survive untouched (same object, no repaint).
    expect(mergeBenchLastRun(first, null, null)).toBe(first);
  });

  it("replaces the PP value when a REPS run reports its median", () => {
    const x1 = mergeBenchLastRun(null, null, pp(6404.8))!;
    // x3 reports the median of the measured reps — the ghost must move by the real delta, not
    // stay on the previous run. 6404.8 vs 6411.7 is why the display needs 2 decimals.
    const x3 = mergeBenchLastRun(x1, null, pp(6411.7))!;
    expect(x3.ppTps).toBe(6411.7);
    expect(x3.tgTps).toBeNull();
  });

  it("keeps the TG value across a PP-only run and vice versa", () => {
    const both = mergeBenchLastRun(null, tg(110, 16), pp(9000))!;
    const ppOnly = mergeBenchLastRun(both, null, pp(9100))!;
    expect(ppOnly.tgTps).toBe(110);
    expect(ppOnly.tgPar).toBe(16);
    const tgOnly = mergeBenchLastRun(ppOnly, tg(111, 1), null)!;
    expect(tgOnly.ppTps).toBe(9100);
    expect(tgOnly.tgPar).toBe(1);
  });

  it("ignores a failed or empty result", () => {
    const good = mergeBenchLastRun(null, tg(110), pp(6400))!;
    const failedTg = { ...tg(0), success: false };
    const failedPp = { ...pp(0), success: false };
    expect(mergeBenchLastRun(good, failedTg, failedPp)).toBe(good);
    expect(mergeBenchLastRun(null, failedTg, failedPp)).toBeNull();
  });
});
