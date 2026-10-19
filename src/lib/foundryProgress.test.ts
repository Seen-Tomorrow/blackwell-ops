import { describe, expect, it } from "vitest";
import {
  edgeFraction,
  etaAnchor,
  etaRemaining,
  formatEdgeCounter,
  formatEta,
  overallPercent,
  pushSamples,
  type EdgeSample,
} from "./foundryProgress";

describe("foundryProgress — bar mapping", () => {
  it("gives compile the bulk of the bar and keeps stages ordered", () => {
    const buildStart = overallPercent("building", { done: 0, total: 416 });
    const buildMid = overallPercent("building", { done: 208, total: 416 });
    const buildDone = overallPercent("building", { done: 416, total: 416 });

    expect(buildStart).toBe(24);
    expect(buildMid).toBe(60);
    expect(buildDone).toBe(96);
    expect(overallPercent("validating")).toBeGreaterThan(buildDone);
    expect(overallPercent("complete")).toBe(100);
    expect(overallPercent("error")).toBe(100);
  });

  it("parks mid-band when a stage has no counter yet", () => {
    const noCounter = overallPercent("building", null);
    expect(noCounter).toBeGreaterThan(24);
    expect(noCounter).toBeLessThan(96);
  });

  it("never leaves 0..100 and clamps impossible counters", () => {
    expect(overallPercent("unknown-phase", null)).toBeGreaterThanOrEqual(0);
    expect(overallPercent("building", { done: 900, total: 416 })).toBe(96);
    expect(overallPercent("building", { done: -3, total: 416 })).toBe(24);
    expect(overallPercent("building", { done: 5, total: 0 })).toBeGreaterThan(24);
  });

  it("treats a missing or zero denominator as no progress", () => {
    expect(edgeFraction(null)).toBeNull();
    expect(edgeFraction({ done: 5, total: 0 })).toBeNull();
    expect(edgeFraction({ done: 5, total: 10 })).toBe(0.5);
  });

  it("formats the counter for the chip and the window", () => {
    expect(formatEdgeCounter({ done: 380, total: 416 })).toBe("380/416");
    expect(formatEdgeCounter({ done: 0, total: 0 })).toBeNull();
    expect(formatEdgeCounter(null)).toBeNull();
  });
});

describe("foundryProgress — ETA", () => {
  const sample = (t: number, done: number, total = 400): EdgeSample => ({ t, done, total });

  it("anchors the recent rate", () => {
    // 40 edges in 20 s → 2 edges/s → 360 remaining → 180 s at t=20000.
    const anchor = etaAnchor([sample(0, 0), sample(10_000, 20), sample(20_000, 40)]);
    expect(anchor).toEqual({ at: 20_000, seconds: 180 });
  });

  it("counts down while the counter stands still, instead of vanishing", () => {
    // One fatbin edge can hold the counter for minutes; the estimate must keep moving.
    const anchor = { at: 20_000, seconds: 180 };
    expect(etaRemaining(anchor, 20_000)).toBeCloseTo(180, 5);
    expect(etaRemaining(anchor, 80_000)).toBeCloseTo(120, 5);
    expect(etaRemaining(anchor, 300_000)).toBe(0);
    expect(etaRemaining(null, 0)).toBeNull();
  });

  it("refuses to guess before enough movement", () => {
    expect(etaAnchor([])).toBeNull();
    expect(etaAnchor([sample(0, 0)])).toBeNull();
    expect(etaAnchor([sample(0, 0), sample(2_000, 4)])).toBeNull();
  });

  it("reports a spent graph as zero", () => {
    expect(etaAnchor([sample(0, 380), sample(10_000, 400)])).toEqual({
      at: 10_000,
      seconds: 0,
    });
  });

  it("formats compactly", () => {
    expect(formatEta(45)).toBe("45s");
    expect(formatEta(130)).toBe("2m 10s");
    expect(formatEta(3840)).toBe("1h 04m");
    expect(formatEta(Number.NaN)).toBeNull();
  });
});

describe("foundryProgress — sample ring", () => {
  it("ignores an unchanged counter", () => {
    const ring = [{ t: 0, done: 10, total: 400 }];
    expect(pushSamples(ring, { t: 500, done: 10, total: 400 }, 30_000)).toBe(ring);
  });

  it("restarts on a new invocation instead of pinning at 100%", () => {
    const ring = [{ t: 0, done: 400, total: 400 }];
    const next = pushSamples(ring, { t: 1_000, done: 1, total: 12 }, 30_000);
    expect(next).toEqual([{ t: 1_000, done: 1, total: 12 }]);
  });

  it("trims to the sample window but keeps at least two points", () => {
    let ring: EdgeSample[] = [];
    for (let i = 0; i <= 10; i += 1) {
      ring = pushSamples(ring, { t: i * 5_000, done: i * 10, total: 400 }, 30_000);
    }
    expect(ring.length).toBeGreaterThanOrEqual(2);
    expect(ring[ring.length - 1].done).toBe(100);
    expect(50_000 - ring[0].t).toBeLessThanOrEqual(35_000);
  });
});
