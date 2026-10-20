/**
 * Library maintenance jobs — the ONE place that runs metadata probes and the
 * VRAM fit scan, whatever started them.
 *
 * Three callers exist (first-run backfill, catalog SCAN META, CONFIG SCAN
 * LIBRARY). Before this module each had its own sequencing, so the same scan
 * behaved differently per entry point: metadata was only published when a batch
 * finished, a background fit could overlap a manual one, and progress lived in
 * different places. They now all call the functions below.
 *
 * Rules encoded here:
 * - metadata is scanned **per model**, ordered (last-used first, then smallest),
 *   and published as each model lands — no all-or-nothing batch;
 * - the fit scan drives `fitScanSessionStore`, so the CONFIG panel, the catalog
 *   badges and the header strip all read the same session;
 * - only one job of each kind can run (the backend guards the fit too).
 */
import { invoke } from "@tauri-apps/api/core";
import type { FitScanComplete, ModelEntry } from "./types";
import { dispatchAppEvent, EVENTS } from "./events";
import { errorMessage } from "./blackwellError";
import {
  beginFitScanSession,
  bootstrapFitScanCache,
  completeFitScanSession,
  failFitScanSession,
  getFitScanSessions,
  stopFitScanLocal,
} from "./fitScanSessionStore";
import { loadLibraryBackfill, saveLibraryBackfill } from "./storage";

/** Model shape the scan order needs — the catalog already carries both fields. */
interface ScanOrderModel {
  path: string;
  size_str?: string;
  metadata?: unknown;
}

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  tb: 1000 ** 4,
};

/**
 * `"46.20 GiB"` → bytes. Anything unparseable sorts last, so a formatting change
 * can never put an unknown model at the front of the queue.
 */
function parseSizeLabel(label: string | undefined): number {
  if (!label) return Number.POSITIVE_INFINITY;
  const match = label.trim().match(/^([\d.]+)\s*([a-zA-Z]+)$/);
  if (!match) return Number.POSITIVE_INFINITY;
  const value = Number.parseFloat(match[1]);
  const unit = SIZE_UNITS[match[2].toLowerCase()];
  if (!Number.isFinite(value) || unit == null) return Number.POSITIVE_INFINITY;
  return value * unit;
}

function pathKey(path: string): string {
  return path.replace(/\//g, "\\").toLowerCase();
}

/**
 * Scan order: the model the user last looked at first, then smallest → largest.
 *
 * Small models finish in seconds, so the first rows of the catalog get their
 * badges immediately instead of after the whole library. Already-scanned models
 * are dropped — nothing to probe.
 */
function orderModelsForScan<T extends ScanOrderModel>(
  models: T[],
  firstPath?: string | null,
): T[] {
  const first = firstPath ? pathKey(firstPath) : null;
  return models
    .filter((m) => !m.metadata)
    .sort((a, b) => {
      const aFirst = first != null && pathKey(a.path) === first ? 0 : 1;
      const bFirst = first != null && pathKey(b.path) === first ? 0 : 1;
      if (aFirst !== bFirst) return aFirst - bFirst;
      const bySize = parseSizeLabel(a.size_str) - parseSizeLabel(b.size_str);
      if (bySize !== 0 && Number.isFinite(bySize)) return bySize;
      return a.path.localeCompare(b.path);
    });
}

/** “NOT NOW” silence window for the fit scan. */
const FIT_SNOOZE_MS = 24 * 60 * 60 * 1000;

export interface MetadataJobState {
  status: "idle" | "running";
  done: number;
  failed: number;
  total: number;
  /** True when the catalog's SCAN META started it, false for the first-run pass. */
  manual: boolean;
  /** Display name of the model being probed. */
  current: string | null;
}

export type ModelScanPatch = Pick<ModelEntry, "metadata" | "ggufShape" | "quant">;

const IDLE_METADATA: MetadataJobState = {
  status: "idle",
  done: 0,
  failed: 0,
  total: 0,
  manual: false,
  current: null,
};

let metadataJob: MetadataJobState = IDLE_METADATA;
/** Bumped on cancel — in-flight probes finish, no new ones are scheduled. */
let metadataToken = 0;
const listeners = new Set<() => void>();

function bump() {
  listeners.forEach((cb) => cb());
}

export function subscribeLibraryJobs(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getMetadataJob(): MetadataJobState {
  return metadataJob;
}

// ── Metadata job ────────────────────────────────────────────────────────

export interface StartMetadataOptions {
  models: ScanOrderModel[];
  /** Last-used / selected model — probed first. */
  firstPath?: string | null;
  /** Parallel probes. Each is a short-lived process; 2 keeps first contact calm. */
  concurrency?: number;
  /** Called as each model lands, so the catalog updates model by model. */
  onModelScanned?: (path: string, patch: ModelScanPatch) => void;
  /** Started by the user (catalog SCAN META) rather than the first-run pass. */
  manual?: boolean;
}

export type MetadataRunResult = "completed" | "cancelled" | "busy";

/**
 * Probe GGUF metadata for every unscanned model, publishing each result.
 *
 * `completed` means the whole queue was probed and the caller may mark the
 * library as covered; `cancelled` must leave the fingerprint alone so the next
 * run resumes; `busy` means another scan already owns the job.
 */
export async function startMetadataScan({
  models,
  firstPath,
  concurrency = 2,
  onModelScanned,
  manual = false,
}: StartMetadataOptions): Promise<MetadataRunResult> {
  if (metadataJob.status === "running") return "busy";

  const token = ++metadataToken;
  const queue = orderModelsForScan(models, firstPath);
  // Nothing to probe — do not flash a running job for an empty queue.
  if (queue.length === 0) return "completed";
  metadataJob = {
    status: "running",
    done: 0,
    failed: 0,
    total: queue.length,
    manual,
    current: null,
  };
  bump();

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      if (token !== metadataToken) return;
      const index = cursor;
      cursor += 1;
      const model = queue[index];
      if (!model) return;

      metadataJob = { ...metadataJob, current: model.path.split(/[/\\]/).pop() ?? null };
      bump();
      try {
        const entry = await invoke<ModelEntry>("scan_model_metadata_cmd", {
          modelPath: model.path,
          providerId: null,
        });
        if (token !== metadataToken) return;
        onModelScanned?.(model.path, {
          metadata: entry.metadata,
          ggufShape: entry.ggufShape,
          quant: entry.quant,
        });
        metadataJob = { ...metadataJob, done: metadataJob.done + 1 };
      } catch (err) {
        if (token !== metadataToken) return;
        console.warn("[library-jobs] metadata probe failed:", model.path, err);
        metadataJob = {
          ...metadataJob,
          done: metadataJob.done + 1,
          failed: metadataJob.failed + 1,
        };
      }
      bump();
    }
  };

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
  await Promise.all(workers);

  const finished = token === metadataToken;
  metadataJob = { ...IDLE_METADATA };
  bump();
  return finished ? "completed" : "cancelled";
}

export function cancelMetadataScan(): void {
  if (metadataJob.status !== "running") return;
  metadataToken += 1;
  metadataJob = { ...IDLE_METADATA };
  bump();
}

// ── Fit job ─────────────────────────────────────────────────────────────

function getFitSnoozeUntil(): number {
  return loadLibraryBackfill().fitSnoozeUntil ?? 0;
}

export function isFitSnoozed(now = Date.now()): boolean {
  return getFitSnoozeUntil() > now;
}

/** The fit session currently scanning, if any — single source for progress. */
export function getRunningFitSession() {
  for (const [providerId, state] of Object.entries(getFitScanSessions())) {
    if (state.status === "scanning") return { providerId, state };
  }
  return null;
}

export type FitStartResult = "completed" | "failed" | "stopped" | "busy";

/** Set when a stop is requested while a run is in flight — the invoke resolves
 *  with partial results, which must not be mistaken for a finished pass. */
let fitStopRequested = false;

/**
 * Run the library VRAM fit scan through the shared session store.
 *
 * Returns `busy` when a session is already scanning — the caller must not treat
 * that as its own run (the backend refuses a second concurrent scan anyway).
 * `stopped` means the run was cut short: partial results are already on disk,
 * but the library is NOT covered, so the caller must not mark it as such.
 */
export async function startFitScan(
  providerId: string,
  parallel: number,
  forceRescan = false,
  opts?: { expectedTotal?: number; manual?: boolean },
): Promise<FitStartResult> {
  if (getFitScanSessions()[providerId]?.status === "scanning") return "busy";
  if (getRunningFitSession()) return "busy";

  fitStopRequested = false;
  const cached = forceRescan ? null : await bootstrapFitScanCache(providerId);
  beginFitScanSession(providerId, parallel, cached, forceRescan, {
    totalModels: opts?.expectedTotal,
    manual: opts?.manual,
  });

  try {
    const result = await invoke<FitScanComplete>("fit_scan_library", {
      providerId,
      modelBase: "",
      parallelCount: Math.max(parallel, 1),
      batch: 2048,
      ubatch: 512,
      forceRescan,
    });
    dispatchAppEvent(EVENTS.fitScanCacheChanged);
    if (fitStopRequested) {
      // Partial results are on disk; leaving the session “complete” would claim
      // a finished pass.
      stopFitScanLocal(providerId);
      return "stopped";
    }
    completeFitScanSession(providerId, result);
    return "completed";
  } catch (err) {
    failFitScanSession(providerId, errorMessage(err) || String(err), parallel);
    return "failed";
  }
}

export async function stopFitScan(providerId: string): Promise<void> {
  fitStopRequested = true;
  try {
    await invoke("fit_stop_scan");
  } catch {
    /* already finishing */
  }
  stopFitScanLocal(providerId);
}

/** Stop the fit scan and keep it off for a day. */
export async function snoozeFitScan(providerId: string): Promise<void> {
  const until = Date.now() + FIT_SNOOZE_MS;
  saveLibraryBackfill({ ...loadLibraryBackfill(), fitSnoozeUntil: until });
  await stopFitScan(providerId);
}
