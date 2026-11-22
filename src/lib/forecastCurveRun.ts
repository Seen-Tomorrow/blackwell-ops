/**
 * Forecast two-point calibration — the run owner for the `2-PT` toggle.
 *
 * The user's launch is point 1. This controller stops it, loads the same shape at a second CTX
 * (point 2), and restores the original CTX. The second CTX is the furthest lower allowed value:
 * lower means less KV, so the calibration cannot OOM the card; the line still spans enough to
 * measure the KV slope. Precision over span is secondary to "never OOM on either launch".
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  port: number | null;
  alias: string | null;
  gpuMask: string | null;
}

export interface CurveStartOptions {
  modelPath: string;
  originalCtx: number;
  /** The CTX choices the UI offers; the controller picks a safe second point from them. */
  ctxOptions: number[];
  /** Build the same launch at a given CTX (the caller patches extra_params.ctx). */
  buildConfig: (ctx: number) => EngineConfig | null;
  /** Keep the panel/profile CTX in sync while the calibration runs. */
  applyCtx: (ctx: number) => void;
  /** Invoked when the final target launch succeeds. */
  onTargetLaunched?: (launched: { idx: number; port: number; alias: string }) => void;
}

const INITIAL: CurveRunSnapshot = {
  phase: "idle",
  message: null,
  error: null,
  modelPath: null,
  fromCtx: null,
  toCtx: null,
  slotIdx: null,
  port: null,
  alias: null,
  gpuMask: null,
};

let snapshot: CurveRunSnapshot = INITIAL;
let running = false;
let abortRequested = false;
let skipRequested = false;
const listeners = new Set<() => void>();

export function abortForecastCurveRun(): void {
  if (!running) return;
  abortRequested = true;
  set({ message: "stopping calibration…" });
  const slot = snapshot.slotIdx;
  if (slot != null) {
    void invoke("stop_engine_slot", { slotIdx: slot }).catch(() => {});
  }
}

export function skipForecastCurveCalibration(): void {
  if (!running || snapshot.phase !== "second-load") return;
  skipRequested = true;
  set({ message: "skipping calibration — launching target CTX…" });
  const slot = snapshot.slotIdx;
  if (slot != null) {
    void invoke("stop_engine_slot", { slotIdx: slot }).catch(() => {});
  }
}

function normPath(p: string | null | undefined): string {
  return (p ?? "").replace(/\\/g, "/").toLowerCase();
}

function armLearnedPersistWaiter(
  modelPath: string,
  timeoutMs = 8000,
): { promise: Promise<boolean>; cancel: () => void } {
  const target = normPath(modelPath);
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unlistenFn: (() => void) | null = null;
  let resolveFn: (ok: boolean) => void = () => {};

  const cleanup = (ok: boolean) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (unlistenFn) {
      try {
        unlistenFn();
      } catch {
        // ignore
      }
    }
    resolveFn(ok);
  };

  const promise = new Promise<boolean>((resolve) => {
    resolveFn = resolve;
    timer = setTimeout(() => cleanup(false), timeoutMs);
    void listen<{ model_path?: string }>("learned-vram-changed", (event) => {
      if (normPath(event.payload?.model_path) === target) {
        cleanup(true);
      }
    }).then((unlisten) => {
      if (settled) {
        unlisten();
      } else {
        unlistenFn = unlisten;
      }
    });
  });

  return {
    promise,
    cancel: () => cleanup(false),
  };
}

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

/**
 * Pick the calibration CTX:
 * - For original >= 32K: furthest lower choice (minimal KV, zero OOM risk, wide span).
 * - For original < 32K: pick the option > original closest to 32K (preferring <= 32K) for a clean slope.
 */
export function chooseSecondCtx(original: number, options: number[]): number | null {
  const sorted = [...new Set(options)]
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (sorted.length < 2) return null;
  const lower = sorted.filter((value) => value < original);
  if (original >= 32768 && lower.length > 0) return lower[0];
  const higher = sorted.filter((value) => value > original);
  if (higher.length > 0) {
    const upTo32k = higher.filter((value) => value <= 32768);
    if (upTo32k.length > 0) return upTo32k[upTo32k.length - 1];
    return higher[0];
  }
  return lower.length > 0 ? lower[0] : null;
}

async function launchAt(
  options: CurveStartOptions,
  ctx: number,
  notifyTarget = false,
): Promise<number> {
  options.applyCtx(ctx);
  const config = options.buildConfig(ctx);
  if (!config) throw new Error(`no launch config at ${fmtCtx(ctx)}`);
  const waiter = armLearnedPersistWaiter(options.modelPath);
  try {
    const launched = await invoke<{ idx: number; port: number; alias: string }>("launch_engine", {
      config,
    });
    dispatchAppEvent(EVENTS.engineLaunched, {
      slotIdx: launched.idx,
      modelPath: options.modelPath,
    });
    dispatchAppEvent(EVENTS.launchSuccess, { alias: launched.alias, port: launched.port });
    set({ slotIdx: launched.idx, port: launched.port, alias: launched.alias, gpuMask: null });
    if (notifyTarget) {
      options.onTargetLaunched?.(launched);
    }
    const entry = await waitForRunning(launched.idx, {
      isAborted: () => abortRequested || (!notifyTarget && skipRequested),
    });
    set({ gpuMask: entry.gpu || snapshot.gpuMask });
    await waiter.promise;
    return launched.idx;
  } finally {
    waiter.cancel();
  }
}

export async function startForecastCurveRun(options: CurveStartOptions): Promise<void> {
  if (running || isCurveRunBusy(snapshot.phase)) return;
  const secondCtx = chooseSecondCtx(options.originalCtx, options.ctxOptions);
  if (secondCtx == null) return;
  running = true;
  abortRequested = false;
  skipRequested = false;
  set({
    phase: "second-load",
    message: `calibration point · ${fmtCtx(secondCtx)}`,
    error: null,
    modelPath: options.modelPath,
    fromCtx: options.originalCtx,
    toCtx: secondCtx,
    slotIdx: null,
    port: null,
    alias: null,
    gpuMask: null,
  });
  try {
    try {
      const calSlot = await launchAt(options, secondCtx, false);
      await stopSlot(calSlot);
      await sleep(500);
    } catch (calErr) {
      if (!skipRequested || abortRequested) throw calErr;
    }
    if (abortRequested) throw new Error("calibration aborted");
    set({
      phase: "restoring",
      message: `target launch · ${fmtCtx(options.originalCtx)}`,
      slotIdx: null,
      port: null,
    });
    const targetSlot = await launchAt(options, options.originalCtx, true);
    set({
      phase: "done",
      message: `curve locked · ${fmtCtx(secondCtx)} + ${fmtCtx(options.originalCtx)}`,
      slotIdx: targetSlot,
    });
  } catch (err) {
    options.applyCtx(options.originalCtx);
    if (abortRequested) {
      set({ ...INITIAL, phase: "idle" });
    } else {
      set({ phase: "error", error: errorMessage(err), message: null });
    }
  } finally {
    running = false;
    abortRequested = false;
    skipRequested = false;
  }
}
