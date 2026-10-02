import type { bench_TGBenchResult, bench_PPBurstResult, bench_PromptMode } from "./types";
import {
  BENCH_CONTROL_DEFAULTS,
  loadBenchControlPrefs,
  saveBenchControlPrefs,
  type BenchControlPrefs,
} from "./storage";

/** Which bench session is active — drives hero + result panel filtering. */
export type BenchSessionMode = "idle" | "tg" | "pp" | "both";

export interface BenchPortState {
  tgRunning: boolean;
  tgResult: bench_TGBenchResult | null;
  tgPhase: "warmup" | "measured" | null;
  tgEffectiveLength: number | null;
  nPredict: number;
  /** Concurrent identical `/completion` feeds on the measured TG run (1 = single request). */
  tgParallel: number;
  /** User toggle — 512-tok warmup run before measured TG (any n_predict target). */
  tgWarmupEnabled: boolean;
  promptMode: bench_PromptMode;
  ppRunning: boolean;
  ppResult: bench_PPBurstResult | null;
  ppPhase: "warmup" | "measured" | null;
  ppEffectiveLength: number | null;
  ppTargetTokens: number;
  showResults: boolean;
  sessionMode: BenchSessionMode;
}

function applyBenchControlPrefs(state: BenchPortState, prefs: BenchControlPrefs): void {
  state.nPredict = prefs.nPredict;
  state.tgParallel = prefs.tgParallel;
  state.tgWarmupEnabled = prefs.tgWarmupEnabled;
  state.promptMode = prefs.promptMode;
  state.ppTargetTokens = prefs.ppTargetTokens;
}

function defaultBenchState(): BenchPortState {
  const state: BenchPortState = {
    tgRunning: false,
    tgResult: null,
    tgPhase: null,
    tgEffectiveLength: null,
    nPredict: BENCH_CONTROL_DEFAULTS.nPredict,
    tgParallel: BENCH_CONTROL_DEFAULTS.tgParallel,
    tgWarmupEnabled: BENCH_CONTROL_DEFAULTS.tgWarmupEnabled,
    promptMode: BENCH_CONTROL_DEFAULTS.promptMode,
    ppRunning: false,
    ppResult: null,
    ppPhase: null,
    ppEffectiveLength: null,
    ppTargetTokens: BENCH_CONTROL_DEFAULTS.ppTargetTokens,
    showResults: false,
    sessionMode: "idle",
  };
  applyBenchControlPrefs(state, loadBenchControlPrefs());
  return state;
}

const portStates = new Map<number, BenchPortState>();

/**
 * Per-port subscription sets, mirroring `fusionSlotStore`.
 *
 * State was always per-port, but notification was not: a single global listener set
 * meant every bench tick on any port woke every mounted BenchWidget, every
 * FusionOverlay and every SlotLogPanel. With several engines up, one benchmark made
 * unrelated widgets re-render 40×/s.
 */
const portSubs = new Map<number, Set<() => void>>();

/**
 * Wake subscribers of `port`. Omit `port` only for a whole-store change
 * (`resetAllBenchPortStates`, `persistBenchControls`), which genuinely is global.
 */
export function notifyBenchPortStore(port?: number): void {
  if (port == null) {
    for (const set of portSubs.values()) set.forEach((cb) => cb());
    return;
  }
  portSubs.get(port)?.forEach((cb) => cb());
}

/** Per-port bench state — survives engine switches while the widget is mounted. */
export function getBenchPortState(port: number): BenchPortState {
  let ps = portStates.get(port);
  if (!ps) {
    ps = defaultBenchState();
    portStates.set(port, ps);
  }
  return ps;
}

export function subscribeBenchPortStore(port: number, listener: () => void): () => void {
  let set = portSubs.get(port);
  if (!set) {
    set = new Set();
    portSubs.set(port, set);
  }
  const bucket = set;
  bucket.add(listener);
  return () => {
    bucket.delete(listener);
    if (bucket.size === 0) portSubs.delete(port);
  };
}

/** TG warmup runs when the user toggle is ON (always 512-tok decode, then measured at n_predict). */
export function tgWarmupWillRun(_nPredict: number, tgWarmupEnabled: boolean): boolean {
  return tgWarmupEnabled;
}

/** Persist global bench control chips and mirror them on every cached port state. */
export function persistBenchControls(ps: BenchPortState): void {
  saveBenchControlPrefs({
    nPredict: ps.nPredict,
    tgParallel: ps.tgParallel,
    tgWarmupEnabled: ps.tgWarmupEnabled,
    promptMode: ps.promptMode,
    ppTargetTokens: ps.ppTargetTokens,
  });
  for (const state of portStates.values()) {
    applyBenchControlPrefs(state, ps);
  }
}

/** Drop all cached bench results — call when any engine slot stops. */
export function resetAllBenchPortStates(): void {
  if (portStates.size === 0) return;
  portStates.clear();
  notifyBenchPortStore();
}