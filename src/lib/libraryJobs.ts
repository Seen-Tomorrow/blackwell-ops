/**
 * Library maintenance jobs — the ONE place that runs metadata probes, whatever started them.
 *
 * Two callers exist (the first-run backfill and the catalog's SCAN META). Before this module each
 * had its own sequencing, so the same scan behaved differently per entry point: metadata was only
 * published when a batch finished, and progress lived in different places. They now all call the
 * functions below.
 *
 * Rules encoded here:
 * - metadata is scanned **per model**, ordered (last-used first, then smallest), and published as
 *   each model lands — no all-or-nothing batch;
 * - only one metadata job can run at a time.
 *
 * The library-wide VRAM fit scan is gone: a model is measured by its own launches and by an
 * on-demand probe, not by a background pass over the whole library.
 */
import { invoke } from "@tauri-apps/api/core";
import type { ModelEntry } from "./types";
import { dispatchAppEvent, EVENTS } from "./events";
import { errorMessage } from "./blackwellError";
import { loadLibraryBackfill, saveLibraryBackfill } from "./storage";
import { sizeLabelBytes } from "./modelSize";

/** Model shape the scan order needs — the catalog already carries both fields. */
interface ScanOrderModel {
  path: string;
  size_str?: string;
  metadata?: unknown;
}

/**
 * Bytes for a model's label. Anything unparseable sorts last, so a formatting
 * change can never put an unknown model at the front of the queue.
 */
function parseSizeLabel(label: string | undefined): number {
  return sizeLabelBytes(label) ?? Number.POSITIVE_INFINITY;
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
          // Bulk scan: the backend queues the cache write and flushes at job end.
          buffered: true,
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
  // Persist whatever the scans queued (one cache rewrite, not one per model).
  try {
    await invoke("flush_scan_cache_cmd");
  } catch (err) {
    console.warn("[library-jobs] cache flush failed:", err);
  }

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
