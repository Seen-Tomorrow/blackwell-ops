import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelEntry } from "../lib/types";
import { KEYS, readStorage } from "../lib/storage";
import {
  getMetadataJob,
  startMetadataScan,
  subscribeLibraryJobs,
  type ModelScanPatch,
} from "../lib/libraryJobs";

/**
 * Parallel metadata probes. The work inside each is CPU-only (`-ngl 0`, GPUs hidden), so this is
 * bound by process spawn + header read, not by the GPU. Each probe is a CUDA-build binary, so
 * every extra slot is another CUDA context - do not push this much higher.
 */
const METADATA_CONCURRENCY = 6;

interface UseLibraryScheduleOptions {
  models: ModelEntry[];
  /** Portable CUDA runtime present - the metadata probe's only hard dependency. */
  runtimeReady: boolean;
  /** Awaitable: the scheduler must see the refreshed catalog before deciding. */
  onCatalogChanged: () => void | Promise<void>;
  onModelScanned: (path: string, patch: ModelScanPatch) => void;
}

function pathKey(path: string): string {
  return path.replace(/\//g, "\\").toLowerCase();
}

/**
 * Decides WHEN the library metadata pass runs.
 *
 * Deliberately state-light: the only memory is **what this session already attempted**. A model
 * that was probed - successfully or not - is not probed again until the app restarts. No persisted
 * fingerprints, so nothing can go stale when a cache is wiped or a path is re-linked.
 *
 * The library-wide VRAM fit pass is gone: the glass measures what it needs from learned rows and a
 * single on-demand probe, and nothing scans the whole library in the background.
 */
export function useLibrarySchedule({
  models,
  runtimeReady,
  onCatalogChanged,
  onModelScanned,
}: UseLibraryScheduleOptions): void {
  const [tick, setTick] = useState(0);

  /** Session-scoped "already tried" set - the whole anti-loop mechanism. */
  const attemptedMetadata = useRef(new Set<string>());
  const metadataStarting = useRef(false);

  // Wake only when a job starts or finishes - never on its progress.
  useEffect(() => {
    let lastMetadata = getMetadataJob().status;
    const check = () => {
      const metadata = getMetadataJob().status;
      if (metadata === lastMetadata) return;
      lastMetadata = metadata;
      setTick((t) => t + 1);
    };
    const unsubscribeJobs = subscribeLibraryJobs(check);
    check();
    return unsubscribeJobs;
  }, []);

  /** Models this session has not tried yet. */
  const pendingMetadata = useMemo(
    () =>
      models.filter(
        (m) => !m.metadata && !attemptedMetadata.current.has(pathKey(m.path)),
      ),
    // `tick` re-evaluates after a job finishes; `models` changes on every reload.
    [models, tick],
  );

  // Metadata: starts as soon as the toolchain exists, wizard or not.
  useEffect(() => {
    if (!runtimeReady) return;
    if (pendingMetadata.length === 0) return;
    if (metadataStarting.current) return;
    if (getMetadataJob().status === "running") return;

    // Claim the whole queue up front: a model is attempted once per session, whether the probe
    // succeeds, fails or is cancelled.
    for (const m of pendingMetadata) attemptedMetadata.current.add(pathKey(m.path));
    metadataStarting.current = true;

    void startMetadataScan({
      models: pendingMetadata,
      firstPath: readStorage(KEYS.lastModel),
      concurrency: METADATA_CONCURRENCY,
      onModelScanned,
    }).then(async (result) => {
      try {
        if (result !== "busy") await onCatalogChanged();
      } finally {
        metadataStarting.current = false;
        setTick((t) => t + 1);
      }
    });
  }, [runtimeReady, pendingMetadata, onModelScanned, onCatalogChanged]);
}
