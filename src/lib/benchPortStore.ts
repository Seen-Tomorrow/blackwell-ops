import type { bench_TGBenchResult, bench_PPBurstResult, bench_PromptMode } from "./types";

/** Which bench session is active — drives hero + result panel filtering. */
export type BenchSessionMode = "idle" | "tg" | "pp" | "both";

export interface BenchPortState {
  tgRunning: boolean;
  tgResult: bench_TGBenchResult | null;
  tgPhase: "warmup" | "measured" | null;
  tgEffectiveLength: number | null;
  nPredict: number;
  promptMode: bench_PromptMode;
  ppRunning: boolean;
  ppResult: bench_PPBurstResult | null;
  ppPhase: "warmup" | "measured" | null;
  ppEffectiveLength: number | null;
  ppTargetTokens: number;
  showResults: boolean;
  sessionMode: BenchSessionMode;
}

function defaultBenchState(): BenchPortState {
  return {
    tgRunning: false,
    tgResult: null,
    tgPhase: null,
    tgEffectiveLength: null,
    nPredict: 256,
    promptMode: "unique",
    ppRunning: false,
    ppResult: null,
    ppPhase: null,
    ppEffectiveLength: null,
    ppTargetTokens: 8192,
    showResults: false,
    sessionMode: "idle",
  };
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

/** Drop all cached bench results — call when any engine slot stops. */
export function resetAllBenchPortStates(): void {
  if (portStates.size === 0) return;
  portStates.clear();
  notifyBenchPortStore();
}