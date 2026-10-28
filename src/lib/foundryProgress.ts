// Pure compile-progress math for the Foundry build UI.
//
// The numbers come from the Rust side (`src-tauri/src/reactor_foundry/progress.rs`),
// which parses ninja's `[N/M]` edge counter once per line and ships it on both
// `foundry-progress` and `foundry_status`. This module only maps that counter onto
// the bar, so the dock chip and the build window cannot drift apart.
//
// One deliberate shape: the stage bands live in `foundryPhases.ts` (`BUILD` owns the
// 24→96 band). The compile is ~80% of wall clock, so a linear overall bar must give it
// most of the width — otherwise it sits frozen through the only phase worth watching.

import { phaseBand } from "./foundryPhases";

export interface EdgeProgress {
  done: number;
  total: number;
  /** Leaf name of the edge being compiled, e.g. `fattn-vec-instance-q8_0-f16.cu`. */
  label?: string | null;
  /** Coarse kind from the backend: CUDA | CXX | C | LINK | GEN | OTHER. */
  kind?: string | null;
}

/** Edges of movement required before an ETA is meaningful. */
export const ETA_MIN_EDGES = 12;
/** Minimum sample span before an ETA is meaningful (counter batches land ~250 ms). */
export const ETA_MIN_SPAN_MS = 6_000;
/** Sample ring length for the rate estimate — long enough to smooth, short enough to track. */
export const ETA_WINDOW_MS = 30_000;

/** A rate estimate pinned to the newest sample; see [`etaAnchor`]. */
export interface EtaAnchor {
  /** Time of the newest sample the estimate was anchored at. */
  at: number;
  /** Estimated seconds remaining at `at`. */
  seconds: number;
}

export interface EdgeSample {
  t: number;
  done: number;
  total: number;
}

/** `done / total`, clamped. `null` when the backend has no counter yet. */
export function edgeFraction(edge?: EdgeProgress | null): number | null {
  if (!edge || !Number.isFinite(edge.total) || edge.total <= 0) return null;
  const done = Number.isFinite(edge.done) ? edge.done : 0;
  return Math.min(1, Math.max(0, done / edge.total));
}

/**
 * Overall bar percent for a phase step (`building`, `Configuring`, …).
 *
 * Inside a band with no counter yet, park at 35% of the band rather than 0 — the
 * stage *is* underway, and a bar that jumps back to the band start on every trip to
 * VALIDATE reads as a bug.
 */
export function overallPercent(step: string, edge?: EdgeProgress | null): number {
  const [lo, hi] = phaseBand(step);
  if (hi <= lo) return hi;
  const frac = edgeFraction(edge);
  if (frac === null) return lo + (hi - lo) * 0.35;
  return lo + (hi - lo) * frac;
}

/** `380/416`, or `null` when there is nothing honest to show. */
export function formatEdgeCounter(edge?: EdgeProgress | null): string | null {
  if (!edge || !Number.isFinite(edge.done) || !Number.isFinite(edge.total) || edge.total <= 0) {
    return null;
  }
  return `${Math.max(0, Math.round(edge.done))}/${Math.round(edge.total)}`;
}

/** Compact remaining-time label: `45s`, `2m 10s`, `1h 04m`. */
export function formatEta(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/**
 * ETA from a windowed sample ring, as an *anchor* rather than a live number.
 *
 * Uses the recent slope, never the whole-build average: the last few percent of a
 * ninja graph is linking (fast) while the early CUDA fatbin edges are slow, so an
 * average ETA is wildly pessimistic near the end and optimistic at the start.
 *
 * An anchor is required because the counter legitimately stops between edges — one
 * fatbin instance can compile for minutes. A live estimate would have to be thrown
 * away exactly then (which is what made it vanish); instead [`etaRemaining`] counts
 * this anchor down against the wall clock, so the number keeps moving during the
 * edge and only gives up once the estimate is actually spent.
 *
 * Returns `null` until there is enough movement to guess — no ETA beats a wrong one.
 */
export function etaAnchor(samples: EdgeSample[]): EtaAnchor | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const span = last.t - first.t;
  if (span < ETA_MIN_SPAN_MS) return null;
  const progressed = last.done - first.done;
  if (progressed < ETA_MIN_EDGES) return null;
  const remaining = last.total - last.done;
  if (remaining <= 0) return { at: last.t, seconds: 0 };
  const ratePerMs = progressed / span;
  if (ratePerMs <= 0) return null;
  const cappedMs = Math.min(remaining / ratePerMs, 4 * 60 * 60 * 1000);
  return { at: last.t, seconds: cappedMs / 1000 };
}

/** Anchor minus elapsed wall time, floored at zero. `null` when there is no anchor. */
export function etaRemaining(anchor: EtaAnchor | null, now: number): number | null {
  if (!anchor) return null;
  const elapsedSeconds = Math.max(0, now - anchor.at) / 1000;
  return Math.max(0, anchor.seconds - elapsedSeconds);
}

/**
 * Append a sample, trimming to the sample window.
 *
 * Returns the input array when nothing moved (counter batches arrive ~4×/s and most
 * carry no new edge), so callers can skip a re-render. A changed `total`, or a
 * counter that went backwards, starts a fresh run — that is a new ninja invocation.
 */
export function pushSamples(
  samples: EdgeSample[],
  sample: EdgeSample,
  windowMs: number,
): EdgeSample[] {
  const last = samples[samples.length - 1];
  if (last && last.done === sample.done && last.total === sample.total) return samples;

  const restarted = !last || last.total !== sample.total || sample.done < last.done;
  const next = restarted ? [sample] : [...samples, sample];
  while (next.length > 2 && sample.t - next[0].t > windowMs) next.shift();
  return next;
}
