import type { bench_TGBenchResult, bench_PPBurstResult, bench_PromptMode } from "./types";
import {
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
    nPredict: 1024,
    tgParallel: 1,
    tgWarmupEnabled: true,
    promptMode: "unique",
    ppRunning: false,
    ppResult: null,
    ppPhase: null,
    ppEffectiveLength: null,
    ppTargetTokens: 8192,
    showResults: false,
    sessionMode: "idle",
  };
  applyBenchControlPrefs(state, loadBenchControlPrefs());
  return state;
}

const portStates = new Map<number, BenchPortState>();
const listeners = new Set<() => void>();

/** Wake every mounted BenchWidget (fusion overlay + engine stack share per-port state). */
export function notifyBenchPortStore(): void {
  for (const fn of listeners) fn();
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

export function subscribeBenchPortStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
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