/**
 * Forecast two-point calibration — the run owner for the `2-PT` toggle.
 *
 * The user's launch is point 1. This controller stops it, loads the same shape at a second CTX
 * (point 2), and restores the original CTX. The second CTX is the furthest lower allowed value:
 * lower means less KV, so the calibration cannot OOM the card; the line still spans enough to
 * measure the KV slope. Precision over span is secondary to "never OOM on either launch".
 */
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { dispatchAppEvent, EVENTS } from "./events";
import { sleep, stopSlot, waitForRunning } from "./engineRun";
import type { EngineConfig } from "./types";

export type CurvePhase = "idle" | "waiting-first" | "second-load" | "restoring" | "done" | "error";

export interface CurveRunSnapshot {
  phase: CurvePhase;
  message: string | null;
  error: string | null;
  modelPath: string | null;
  fromCtx: number | null;
  toCtx: number | null;
  slotIdx: number | null;
}

export interface CurveStartOptions {
  modelPath: string;
  /** Slot of the launch that just happened (point 1). */
  slotIdx: number;
  originalCtx: number;
  /** The CTX choices the UI offers; the controller picks a safe second point from them. */
  ctxOptions: number[];
  /** Build the same launch at a given CTX (the caller patches extra_params.ctx). */
  buildConfig: (ctx: number) => EngineConfig | null;
  /** Keep the panel/profile CTX in sync while the calibration runs. */
  applyCtx: (ctx: number) => void;
}

const INITIAL: CurveRunSnapshot = {
  phase: "idle",
  message: null,
  error: null,
  modelPath: null,
  fromCtx: null,
  toCtx: null,
  slotIdx: null,
};

let snapshot: CurveRunSnapshot = INITIAL;
let running = false;
const listeners = new Set<() => void>();

function set(patch: Partial<CurveRunSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useForecastCurveRun(): CurveRunSnapshot {
  const [, force] = useState(0);
  useEffect(() => subscribe(() => force((n) => n + 1)), []);
  return snapshot;
}

export function isCurveRunBusy(phase: CurvePhase): boolean {
  return phase !== "idle" && phase !== "done" && phase !== "error";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err).split("\n")[0];
}

function fmtCtx(ctx: number): string {
  return ctx >= 1024 ? `${Math.round(ctx / 1024)}K` : String(ctx);
}

/** Furthest lower choice (safe direction: less KV); the nearest higher only at the floor. */
export function chooseSecondCtx(original: number, options: number[]): number | null {
  const sorted = [...new Set(options)]
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (sorted.length < 2) return null;
  const lower = sorted.filter((value) => value < original);
  if (lower.length > 0) return lower[0];
  const higher = sorted.filter((value) => value > original);
  return higher.length > 0 ? higher[0] : null;
}

async function launchAt(options: CurveStartOptions, ctx: number): Promise<number> {
  options.applyCtx(ctx);
  const config = options.buildConfig(ctx);
  if (!config) throw new Error(`no launch config at ${fmtCtx(ctx)}`);
  const launched = await invoke<{ idx: number; port: number; alias: string }>("launch_engine", {
    config,
  });
  dispatchAppEvent(EVENTS.engineLaunched, {
    slotIdx: launched.idx,
    modelPath: options.modelPath,
  });
  dispatchAppEvent(EVENTS.launchSuccess, { alias: launched.alias, port: launched.port });
  set({ slotIdx: launched.idx });
  await waitForRunning(launched.idx);
  // The learned row is written as the load's memory snapshot parses; let it land before the
  // controller stops this engine, or the point never reaches the store.
  await sleep(2500);
  return launched.idx;
}

export async function startForecastCurveRun(options: CurveStartOptions): Promise<void> {
  if (running || isCurveRunBusy(snapshot.phase)) return;
  const secondCtx = chooseSecondCtx(options.originalCtx, options.ctxOptions);
  if (secondCtx == null) return;
  running = true;
  set({
    phase: "waiting-first",
    message: "waiting for the first point to finish loading…",
    error: null,
    modelPath: options.modelPath,
    fromCtx: options.originalCtx,
    toCtx: secondCtx,
    slotIdx: options.slotIdx,
  });
  try {
    await waitForRunning(options.slotIdx);
    // The first point must reach the learned store before this engine stops; the memory snapshot
    // is parsed just after RUNNING.
    await sleep(2500);
    set({ phase: "second-load", message: `second point · ${fmtCtx(secondCtx)}` });
    await stopSlot(options.slotIdx);
    await sleep(500);
    const secondSlot = await launchAt(options, secondCtx);
    await stopSlot(secondSlot);
    set({ phase: "restoring", message: `restoring ${fmtCtx(options.originalCtx)}` });
    const restoredSlot = await launchAt(options, options.originalCtx);
    set({
      phase: "done",
      message: `2-PT complete · ${fmtCtx(secondCtx)} + ${fmtCtx(options.originalCtx)}`,
      slotIdx: restoredSlot,
    });
  } catch (err) {
    // Put the user's CTX back and, if possible, their engine. The calibration must not leave
    // them at the second point or with no engine.
    options.applyCtx(options.originalCtx);
    try {
      const config = options.buildConfig(options.originalCtx);
      if (config) {
        const launched = await invoke<{ idx: number; port: number; alias: string }>(
          "launch_engine",
          { config },
        );
        dispatchAppEvent(EVENTS.engineLaunched, {
          slotIdx: launched.idx,
          modelPath: options.modelPath,
        });
        dispatchAppEvent(EVENTS.launchSuccess, { alias: launched.alias, port: launched.port });
        set({ slotIdx: launched.idx });
        await waitForRunning(launched.idx);
      }
    } catch {
      // The restore failed too; the error below is the one that matters.
    }
    set({ phase: "error", error: errorMessage(err), message: null });
  } finally {
    running = false;
  }
}
