/**
 * MOE OVERDRIVE run — one owner for the whole loop.
 *
 * The first run is a calibration: load with the experts in host RAM and no cache, measure what the
 * real launch leaves free, write the cache that fits, stop the engine, load it again with the
 * cache, and bench both. The result is a before/after comparison the screen stays on until the
 * user leaves.
 *
 * This file is deliberately self-contained: it talks to the existing engine commands and the
 * `moe_overdrive_*` record, and imports nothing from the forecast. If the OVERDRIVE path goes
 * sideways, delete it, `MoeOverdrive.tsx` and `moe_overdrive.rs` — the forecast keeps working.
 */
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { dispatchAppEvent, EVENTS } from "./events";
import type { EngineConfig, StackEntry } from "./types";

/** Everything that changes what a calibration measured. The GPU set comes from the launch's
 *  device/split config, never from the selected slot: a record must survive stopping its engine. */
export interface MoeOverdriveIdentity {
  modelPath: string;
  ctxSize: number;
  kvQuant: string;
  splitMode: string;
  gpuMask: string;
  draft: string;
  draftNMax: number;
}

export interface OverdriveKnobs {
  /** `on` / `off` — the panel's switch value, not a boolean. */
  cpuMoe: string;
  cacheMib: number;
  share: number;
}

export interface OverdriveProbe {
  device: number;
  pp_free_mib: number;
  tg_free_mib: number;
  free_after_load_mib: number;
  pp_tokens: number;
  tg_tokens: number;
  pp_tps: number | null;
  tg_tps: number | null;
  reserve_mib: number;
  recommended_mib: number;
}

export interface OverdriveComponents {
  model_mib: number;
  kv_mib: number;
  compute_mib: number;
  host_mib: number;
}

export interface OverdriveLedger {
  available: boolean;
  components: OverdriveComponents;
  free_mib: number;
  used_mib: number;
}

export interface OverdriveMemory {
  deviceMib: number;
  hostMib: number;
  freeMib: number;
}

export interface OverdriveRecord {
  model_path: string;
  model_size_bytes: number;
  ctx_size: number;
  kv_quant: string;
  split_mode: string;
  gpu_mask: string;
  draft: string;
  draft_n_max: number;
  free_pp_mib: number;
  free_tg_mib: number;
  free_after_load_mib: number;
  reserve_mib: number;
  cache_mib: number;
  tps_before: number | null;
  tps_after: number | null;
  device_mib_before?: number | null;
  device_mib_after?: number | null;
  host_mib_before?: number | null;
  host_mib_after?: number | null;
  engine_build: string | null;
  driver_version: string | null;
  measured_at: string;
}

export interface OverdriveComparison {
  cacheMib: number;
  tpsBefore: number | null;
  tpsAfter: number | null;
  memoryBefore: OverdriveMemory | null;
  memoryAfter: OverdriveMemory | null;
  measuredAt: string | null;
  /** True when the before side came from the stored record instead of a fresh calibration. */
  fromRecord: boolean;
  note: string | null;
}

export type OverdrivePhase =
  | "idle"
  | "preparing"
  | "loading-calibration"
  | "probing"
  | "bench-before"
  | "stopping"
  | "loading-tuned"
  | "bench-after"
  | "done"
  | "error"
  | "aborted";

export interface OverdriveSnapshot {
  phase: OverdrivePhase;
  message: string | null;
  error: string | null;
  identity: MoeOverdriveIdentity | null;
  slotIdx: number | null;
  port: number | null;
  alias: string | null;
  gpuMask: string | null;
  cacheMib: number | null;
  comparison: OverdriveComparison | null;
  startedAt: number | null;
  aborting: boolean;
}

export interface OverdriveStartOptions {
  identity: MoeOverdriveIdentity;
  /** Build the real engine payload with these knobs patched in. Called once per load. */
  buildConfig: (knobs: OverdriveKnobs) => EngineConfig | null;
  /** Persist the knobs into the panel profile (what the next manual launch reads). */
  applyKnobs: (knobs: OverdriveKnobs) => void;
  /** Put the pre-run knobs back after an abort or a failed tuned load. */
  restoreKnobs: () => void;
  /** Skip the stored record and calibrate again. */
  forceCalibrate?: boolean;
}

const INITIAL: OverdriveSnapshot = {
  phase: "idle",
  message: null,
  error: null,
  identity: null,
  slotIdx: null,
  port: null,
  alias: null,
  gpuMask: null,
  cacheMib: null,
  comparison: null,
  startedAt: null,
  aborting: false,
};

const POLL_MS = 800;
const LOAD_DEADLINE_MS = 30 * 60_000;
const STOP_DEADLINE_MS = 60_000;
const STOP_SETTLE_MS = 500;
/** Same shape as the bench tray's default: a real decode window, not the 64-token probe. */
const BENCH_N_PREDICT = 1024;
const BENCH_PROMPT_MODE = "code";
const MIN_CACHE_MIB = 512;

const ACTIVE_STATUSES = new Set(["LOADING", "RUNNING"]);

let snapshot: OverdriveSnapshot = INITIAL;
let running = false;
let abortRequested = false;
const listeners = new Set<() => void>();

function set(patch: Partial<OverdriveSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useOverdriveRun(): OverdriveSnapshot {
  const [, force] = useState(0);
  useEffect(() => subscribe(() => force((n) => n + 1)), []);
  return snapshot;
}

export function isOverdriveBusy(phase: OverdrivePhase): boolean {
  return phase !== "idle" && phase !== "done" && phase !== "error" && phase !== "aborted";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err.split("\n")[0];
  return String(err).split("\n")[0];
}

function normalizePath(path: string | null | undefined): string {
  return (path ?? "").replace(/\\/g, "/").toLowerCase();
}

async function readStack(): Promise<StackEntry[]> {
  return invoke<StackEntry[]>("get_stack_status");
}

function activeEntries(entries: StackEntry[]): StackEntry[] {
  return entries.filter((entry) => ACTIVE_STATUSES.has(entry.status));
}

/** The GPU set the launch will use: all cards for a split, otherwise the configured device. */
export function launchGpuMask(
  gpus: Array<{ index: number }>,
  config: Record<string, unknown>,
): string {
  if (gpus.length === 0) return "";
  const split = String(config.split ?? "none").trim().toLowerCase();
  if (split && split !== "none") return gpus.map((gpu) => String(gpu.index)).join(",");
  const device = String(config.device ?? "GPU-0").replace(/^GPU-/i, "").trim();
  return device || "0";
}

export function deviceIndexFor(identity: MoeOverdriveIdentity): number {
  const first = identity.gpuMask.split(",")[0]?.trim() ?? "";
  const index = Number(first);
  return Number.isFinite(index) && index >= 0 ? index : 0;
}

export async function readOverdriveRecord(
  identity: MoeOverdriveIdentity,
): Promise<OverdriveRecord | null> {
  try {
    const view = await invoke<{ record: OverdriveRecord } | null>("moe_overdrive_record", {
      modelPath: identity.modelPath,
      ctxSize: identity.ctxSize,
      kvQuant: identity.kvQuant,
      splitMode: identity.splitMode,
      gpuMask: identity.gpuMask,
      draft: identity.draft,
      draftNMax: identity.draftNMax,
    });
    return view?.record ?? null;
  } catch {
    return null;
  }
}

/** A stored calibration as the same comparison the screen prints. */
export function comparisonFromRecord(record: OverdriveRecord): OverdriveComparison {
  const hasBeforeMemory =
    record.device_mib_before != null || record.host_mib_before != null;
  return {
    cacheMib: record.cache_mib,
    tpsBefore: record.tps_before,
    tpsAfter: record.tps_after,
    memoryBefore: hasBeforeMemory
      ? {
          deviceMib: record.device_mib_before ?? 0,
          hostMib: record.host_mib_before ?? 0,
          freeMib: record.free_after_load_mib,
        }
      : null,
    memoryAfter:
      record.device_mib_after != null || record.host_mib_after != null
        ? {
            deviceMib: record.device_mib_after ?? 0,
            hostMib: record.host_mib_after ?? 0,
            freeMib: 0,
          }
        : null,
    measuredAt: record.measured_at,
    fromRecord: true,
    note: null,
  };
}

export function abortOverdriveRun(): void {
  if (!running) return;
  abortRequested = true;
  set({ aborting: true, message: "stopping the load…" });
  const slot = snapshot.slotIdx;
  if (slot != null) {
    void invoke("stop_engine_slot", { slotIdx: slot }).catch(() => {});
  }
}

export function resetOverdriveRun(): void {
  if (running) return;
  snapshot = INITIAL;
  for (const listener of listeners) listener();
}

async function waitIdle(slotIdx: number): Promise<void> {
  const deadline = Date.now() + STOP_DEADLINE_MS;
  while (Date.now() < deadline) {
    const entry = (await readStack()).find((item) => item.idx === slotIdx);
    if (!entry || !ACTIVE_STATUSES.has(entry.status)) return;
    await sleep(300);
  }
}

async function stopSlot(slotIdx: number): Promise<void> {
  await invoke("stop_engine_slot", { slotIdx }).catch(() => {});
  await waitIdle(slotIdx);
}

async function stopCurrent(): Promise<void> {
  const slot = snapshot.slotIdx;
  if (slot == null) return;
  await stopSlot(slot);
  set({ slotIdx: null, port: null, gpuMask: null });
  await sleep(STOP_SETTLE_MS);
}

async function safeStop(): Promise<void> {
  const slot = snapshot.slotIdx;
  if (slot != null) await stopSlot(slot);
  set({ slotIdx: null, port: null, gpuMask: null, aborting: false });
}

async function ensureSeatFree(identity: MoeOverdriveIdentity): Promise<void> {
  const live = activeEntries(await readStack());
  const foreign = live.find(
    (entry) => normalizePath(entry.model_path) !== normalizePath(identity.modelPath),
  );
  if (foreign) {
    throw new Error(
      `another model is loaded (${foreign.alias}) — stop it before running OVERDRIVE`,
    );
  }
  for (const entry of live) await stopSlot(entry.idx);
}

async function waitRunning(slotIdx: number): Promise<void> {
  const deadline = Date.now() + LOAD_DEADLINE_MS;
  for (;;) {
    if (abortRequested) throw new Error("aborted");
    const entry = (await readStack()).find((item) => item.idx === slotIdx);
    if (!entry) throw new Error("the launched engine vanished before it finished loading");
    if (entry.status === "ERROR") {
      throw new Error("the engine reported ERROR while loading — see the engine log");
    }
    if (!ACTIVE_STATUSES.has(entry.status)) {
      throw new Error(`the engine stopped while loading (${entry.status})`);
    }
    if (entry.status === "RUNNING") {
      set({
        port: entry.port || snapshot.port,
        alias: entry.alias || snapshot.alias,
        gpuMask: entry.gpu || snapshot.gpuMask,
      });
      return;
    }
    if (entry.gpu) set({ gpuMask: entry.gpu });
    if (Date.now() > deadline) {
      throw new Error("the engine did not reach RUNNING within 30 minutes");
    }
    await sleep(POLL_MS);
  }
}

async function launchWith(
  options: OverdriveStartOptions,
  knobs: OverdriveKnobs,
): Promise<void> {
  options.applyKnobs(knobs);
  const config = options.buildConfig(knobs);
  if (!config) throw new Error("no launch config for the selected model");
  const launched = await invoke<{ idx: number; port: number; alias: string }>("launch_engine", {
    config,
  });
  set({ slotIdx: launched.idx, port: launched.port, alias: launched.alias, gpuMask: null });
  dispatchAppEvent(EVENTS.engineLaunched, {
    slotIdx: launched.idx,
    modelPath: options.identity.modelPath,
  });
  dispatchAppEvent(EVENTS.launchSuccess, { alias: launched.alias, port: launched.port });
  await waitRunning(launched.idx);
}

async function bench(port: number): Promise<{ tg: number | null; pp: number | null }> {
  try {
    const result = await invoke<{
      success: boolean;
      gen_tps: number;
      prompt_tps: number;
      error?: string | null;
    }>("cmd_burst_bench", {
      port,
      nPredict: BENCH_N_PREDICT,
      benchPromptMode: BENCH_PROMPT_MODE,
      tgWarmupEnabled: false,
      parallelRequests: 1,
    });
    return {
      tg: result.success && result.gen_tps > 0 ? result.gen_tps : null,
      pp: result.success && result.prompt_tps > 0 ? result.prompt_tps : null,
    };
  } catch {
    return { tg: null, pp: null };
  }
}

async function readMemory(port: number, deviceIndex: number): Promise<OverdriveMemory> {
  try {
    const ledger = await invoke<OverdriveLedger>("moe_overdrive_ledger", { port, deviceIndex });
    const components = ledger.components;
    return {
      // NVML used, not the ledger component sum: the engine's `/memory` does not account for the
      // expert cache (it lands in "unaccounted"), so the sum would hide half the tuned footprint.
      // It includes other apps on the card; both sides of the comparison do, so the delta is the run.
      deviceMib: ledger.used_mib,
      hostMib: components.host_mib,
      freeMib: ledger.free_mib,
    };
  } catch {
    return { deviceMib: 0, hostMib: 0, freeMib: 0 };
  }
}

async function saveRecord(
  identity: MoeOverdriveIdentity,
  probe: OverdriveProbe,
  comparison: OverdriveComparison,
): Promise<void> {
  await invoke("moe_overdrive_record_save", {
    record: {
      model_path: identity.modelPath,
      model_size_bytes: 0,
      ctx_size: identity.ctxSize,
      kv_quant: identity.kvQuant,
      split_mode: identity.splitMode,
      gpu_mask: identity.gpuMask,
      draft: identity.draft,
      draft_n_max: identity.draftNMax,
      free_pp_mib: probe.pp_free_mib,
      free_tg_mib: probe.tg_free_mib,
      free_after_load_mib: probe.free_after_load_mib,
      reserve_mib: probe.reserve_mib,
      cache_mib: comparison.cacheMib,
      tps_before: comparison.tpsBefore,
      tps_after: comparison.tpsAfter,
      device_mib_before: comparison.memoryBefore?.deviceMib ?? null,
      device_mib_after: comparison.memoryAfter?.deviceMib ?? null,
      host_mib_before: comparison.memoryBefore?.hostMib ?? null,
      host_mib_after: comparison.memoryAfter?.hostMib ?? null,
      engine_build: null,
      driver_version: null,
      measured_at: comparison.measuredAt ?? new Date().toISOString(),
    },
  });
}

/** Fast path: a stored calibration for this exact shape means one tuned load, no calibration. */
async function runStored(
  options: OverdriveStartOptions,
  record: OverdriveRecord,
): Promise<OverdriveComparison> {
  const identity = options.identity;
  const deviceIndex = deviceIndexFor(identity);
  set({
    phase: "loading-tuned",
    cacheMib: record.cache_mib,
    message: `loading with the stored ${record.cache_mib.toLocaleString("en-US")} MiB cache`,
  });
  await launchWith(options, { cpuMoe: "on", cacheMib: record.cache_mib, share: 0 });
  const port = snapshot.port;
  if (port == null) throw new Error("the tuned engine has no port");
  set({ phase: "bench-after", message: "checking the tuned engine…" });
  const after = await bench(port);
  const memoryAfter = await readMemory(port, deviceIndex);
  return {
    cacheMib: record.cache_mib,
    tpsBefore: record.tps_before,
    tpsAfter: after.tg,
    memoryBefore:
      record.device_mib_before != null || record.host_mib_before != null
        ? {
            deviceMib: record.device_mib_before ?? 0,
            hostMib: record.host_mib_before ?? 0,
            freeMib: record.free_after_load_mib,
          }
        : null,
    memoryAfter,
    measuredAt: record.measured_at,
    fromRecord: true,
    note: null,
  };
}

async function runCalibration(options: OverdriveStartOptions): Promise<OverdriveComparison> {
  const identity = options.identity;
  const deviceIndex = deviceIndexFor(identity);

  set({
    phase: "loading-calibration",
    cacheMib: 0,
    message: "calibration load — experts in host RAM, no cache",
  });
  await launchWith(options, { cpuMoe: "on", cacheMib: 0, share: 0 });
  const port = snapshot.port;
  if (port == null) throw new Error("the calibration engine has no port");

  set({ phase: "probing", message: "measuring what the calibration launch leaves free…" });
  const probe = await invoke<OverdriveProbe>("moe_overdrive_probe", { port, deviceIndex });

  set({ phase: "bench-before", message: "baseline bench (cache 0)…" });
  const before = await bench(port);
  const memoryBefore = await readMemory(port, deviceIndex);

  if (probe.recommended_mib < MIN_CACHE_MIB) {
    return {
      cacheMib: 0,
      tpsBefore: before.tg,
      tpsAfter: null,
      memoryBefore,
      memoryAfter: null,
      measuredAt: new Date().toISOString(),
      fromRecord: false,
      note: "this launch leaves no room for an expert cache — lower CTX/KV or free VRAM, then recalibrate",
    };
  }

  // The cache can never be larger than the expert pool it caches: past that, extra MiB buy
  // nothing and only shrink the reserve. Host model bytes are that pool under `-cmoe`.
  const poolCap = memoryBefore.hostMib > 0 ? memoryBefore.hostMib : probe.recommended_mib;
  const cacheMib = Math.min(probe.recommended_mib, poolCap);
  if (cacheMib < MIN_CACHE_MIB) {
    return {
      cacheMib: 0,
      tpsBefore: before.tg,
      tpsAfter: null,
      memoryBefore,
      memoryAfter: null,
      measuredAt: new Date().toISOString(),
      fromRecord: false,
      note: "the expert pool is too small to cache — nothing to gain here",
    };
  }
  // Keep the measurement before the tuned load: if that load fails, the next attempt can use the
  // cache this calibration justified instead of measuring the shape again.
  try {
    await saveRecord(identity, probe, {
      cacheMib,
      tpsBefore: before.tg,
      tpsAfter: null,
      memoryBefore,
      memoryAfter: null,
      measuredAt: new Date().toISOString(),
      fromRecord: false,
      note: null,
    });
  } catch {
    // The tuned run still replaces it; a record is useful, not a gate.
  }

  set({
    phase: "stopping",
    cacheMib,
    message: "stopping the calibration launch…",
  });
  await stopCurrent();

  set({
    phase: "loading-tuned",
    cacheMib,
    message: `tuned load — expert cache ${cacheMib.toLocaleString("en-US")} MiB`,
  });
  await launchWith(options, { cpuMoe: "on", cacheMib, share: 0 });
  const tunedPort = snapshot.port;
  if (tunedPort == null) throw new Error("the tuned engine has no port");

  set({ phase: "bench-after", message: "tuned bench…" });
  const after = await bench(tunedPort);
  const memoryAfter = await readMemory(tunedPort, deviceIndex);

  const comparison: OverdriveComparison = {
    cacheMib,
    tpsBefore: before.tg,
    tpsAfter: after.tg,
    memoryBefore,
    memoryAfter,
    measuredAt: new Date().toISOString(),
    fromRecord: false,
    note: null,
  };
  try {
    await saveRecord(identity, probe, comparison);
  } catch (err) {
    comparison.note = `tuned, but the record could not be saved: ${errorMessage(err)}`;
  }
  return comparison;
}

export async function startOverdriveRun(options: OverdriveStartOptions): Promise<void> {
  if (running) return;
  if (isOverdriveBusy(snapshot.phase)) return;
  running = true;
  abortRequested = false;
  set({
    phase: "preparing",
    message: "checking the seat…",
    error: null,
    comparison: null,
    identity: options.identity,
    slotIdx: null,
    port: null,
    alias: null,
    gpuMask: null,
    cacheMib: null,
    startedAt: Date.now(),
    aborting: false,
  });
  try {
    await ensureSeatFree(options.identity);
    const stored = options.forceCalibrate ? null : await readOverdriveRecord(options.identity);
    const comparison =
      stored && stored.cache_mib > 0
        ? await runStored(options, stored)
        : await runCalibration(options);
    set({ phase: "done", comparison, message: null, error: null, aborting: false });
  } catch (err) {
    const aborted = abortRequested;
    await safeStop();
    options.restoreKnobs();
    const message = errorMessage(err);
    set({
      phase: aborted ? "aborted" : "error",
      message: aborted ? "run stopped — the launch config is back to what it was" : null,
      error: aborted ? null : message,
      aborting: false,
    });
    if (!aborted) dispatchAppEvent(EVENTS.launchError, { message });
  } finally {
    running = false;
    abortRequested = false;
  }
}
