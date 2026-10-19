import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FitScanFull, ModelEntry, StackEntry } from "../lib/types";
import { DEFAULT_PROVIDER_ID } from "../lib/types";
import { KEYS, readStorage, subscribeStorage } from "../lib/storage";
import { isLaunchableMain } from "../lib/specDraft";
import {
  FIT_SCAN_POINTS_TOTAL,
  findFitScanEntry,
  modelHasCompleteFitScan,
} from "../lib/fitScanTable";
import { bootstrapFitScanCache, subscribeFitScanSessions } from "../lib/fitScanSessionStore";
import {
  getMetadataJob,
  getRunningFitSession,
  isFitSnoozed,
  startFitScan,
  startMetadataScan,
  stopFitScan,
  subscribeLibraryJobs,
  type ModelScanPatch,
} from "../lib/libraryJobs";
import { EVENTS } from "../lib/events";
import { useDownloadTasks } from "./useDownloadTasks";

/**
 * Parallel metadata probes. The work inside each is CPU-only (`-ngl 0`, GPUs
 * hidden), so this is bound by process spawn + header read, not by the GPU.
 * Each probe is a CUDA-build binary, so every extra slot is another CUDA
 * context — do not push this much higher.
 */
const METADATA_CONCURRENCY = 6;
/**
 * Fit parallel probes.
 *
 * Two, not four: `llama-fit-params` loads tensors to measure, and the library
 * now contains 100 GB+ sharded models. Four concurrent probes of that size push
 * the system commit limit — the failure mode is not a clean "too big" error but
 * STATUS_* crashes inside the child. The CONFIG menu still offers 2×/4× for a
 * deliberate run.
 */
const FIT_PARALLEL = 2;
/** Let the catalog reload land before the GPU pass may start. */
const FIT_SETTLE_MS = 10_000;

interface UseLibraryScheduleOptions {
  models: ModelEntry[];
  /** Portable CUDA runtime present — the metadata probe's only hard dependency. */
  runtimeReady: boolean;
  /** First-run wizard still owns the UI (blocks only the GPU pass). */
  setupActive: boolean;
  /** Both setup probes answered — `setupActive === false` then means “done”. */
  setupResolved: boolean;
  stack: StackEntry[];
  /** Awaitable: the scheduler must see the refreshed catalog before deciding. */
  onCatalogChanged: () => void | Promise<void>;
  onModelScanned: (path: string, patch: ModelScanPatch) => void;
}

function pathKey(path: string): string {
  return path.replace(/\//g, "\\").toLowerCase();
}

function isEngineBusy(stack: StackEntry[]): boolean {
  return stack.some((s) => s.status === "RUNNING" || s.status === "LOADING");
}

function isDownloadBusy(tasks: { status: string }[]): boolean {
  return tasks.some((t) =>
    ["queued", "downloading", "paused", "scanning"].includes(t.status),
  );
}

/**
 * Decides WHEN the two library passes run.
 *
 * Deliberately state-light: the only memory is **what this session already
 * attempted**. A model that was probed — successfully or not — is not probed
 * again until the app restarts. No persisted fingerprints, so nothing can go
 * stale when a cache is wiped, a path is re-linked or setup is replayed, and the
 * scheduler cannot re-queue the same library in a loop.
 */
export function useLibrarySchedule({
  models,
  runtimeReady,
  setupActive,
  setupResolved,
  stack,
  onCatalogChanged,
  onModelScanned,
}: UseLibraryScheduleOptions): void {
  const downloads = useDownloadTasks();
  const [tick, setTick] = useState(0);
  const [providerId, setProviderId] = useState(
    () => readStorage(KEYS.lastProvider) || DEFAULT_PROVIDER_ID,
  );
  const [fitCache, setFitCache] = useState<{
    results: Record<string, FitScanFull>;
    pointsTotal: number;
    loaded: boolean;
  }>({ results: {}, pointsTotal: FIT_SCAN_POINTS_TOTAL, loaded: false });

  /** Session-scoped “already tried” sets — the whole anti-loop mechanism. */
  const attemptedMetadata = useRef(new Set<string>());
  const attemptedFit = useRef(new Set<string>());
  const metadataStarting = useRef(false);
  const fitStarting = useRef(false);
  /** Earliest moment the fit may start (catalog settle window). */
  const fitEligibleAt = useRef(0);

  useEffect(
    () =>
      subscribeStorage(KEYS.lastProvider, () =>
        setProviderId(readStorage(KEYS.lastProvider) || DEFAULT_PROVIDER_ID),
      ),
    [],
  );

  // Wake only when a job starts or finishes — never on its progress.
  useEffect(() => {
    let lastMetadata = getMetadataJob().status;
    let lastFit = getRunningFitSession() ? "running" : "idle";
    const check = () => {
      const metadata = getMetadataJob().status;
      const fit = getRunningFitSession() ? "running" : "idle";
      if (metadata === lastMetadata && fit === lastFit) return;
      lastMetadata = metadata;
      lastFit = fit;
      setTick((t) => t + 1);
    };
    const unsubscribeJobs = subscribeLibraryJobs(check);
    const unsubscribeFit = subscribeFitScanSessions(check);
    check();
    return () => {
      unsubscribeJobs();
      unsubscribeFit();
    };
  }, []);

  const refreshFitCache = useCallback(async () => {
    const cached = await bootstrapFitScanCache(providerId);
    setFitCache({
      results: cached?.results ?? {},
      pointsTotal: cached?.scan_points_total ?? FIT_SCAN_POINTS_TOTAL,
      loaded: true,
    });
  }, [providerId]);

  useEffect(() => {
    void refreshFitCache();
  }, [refreshFitCache]);

  // A pass finished elsewhere (CONFIG RESCAN, catalog) — reload the fit cache.
  useEffect(() => {
    const onChanged = () => {
      void refreshFitCache();
    };
    window.addEventListener(EVENTS.fitScanCacheChanged, onChanged);
    return () => window.removeEventListener(EVENTS.fitScanCacheChanged, onChanged);
  }, [refreshFitCache]);

  const engineBusy = useMemo(() => isEngineBusy(stack), [stack]);
  const downloadBusy = useMemo(() => isDownloadBusy(downloads), [downloads]);

  /** Models this session has not tried yet. */
  const pendingMetadata = useMemo(
    () =>
      models.filter(
        (m) => !m.metadata && !attemptedMetadata.current.has(pathKey(m.path)),
      ),
    // `tick` re-evaluates after a job finishes; `models` changes on every reload.
    [models, tick],
  );
  const pendingFit = useMemo(
    () =>
      models.filter((m) => {
        if (!isLaunchableMain(m)) return false;
        if (attemptedFit.current.has(pathKey(m.path))) return false;
        const entry = findFitScanEntry(fitCache.results, m.path);
        return !modelHasCompleteFitScan(entry, fitCache.pointsTotal);
      }),
    [models, fitCache, tick],
  );

  // ── Metadata: starts as soon as the toolchain exists, wizard or not ─────
  useEffect(() => {
    if (!runtimeReady || !fitCache.loaded) return;
    if (pendingMetadata.length === 0) return;
    if (metadataStarting.current) return;
    if (getMetadataJob().status === "running") return;

    // Claim the whole queue up front: a model is attempted once per session,
    // whether the probe succeeds, fails or is cancelled.
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
        if (result === "completed" || result === "cancelled") {
          fitEligibleAt.current = Date.now() + FIT_SETTLE_MS;
        }
        setTick((t) => t + 1);
      }
    });
  }, [runtimeReady, fitCache.loaded, pendingMetadata, onModelScanned, onCatalogChanged]);

  // ── Fit: idle machine only, after the metadata settle window ────────────
  useEffect(() => {
    if (!setupResolved || setupActive) return;
    if (!fitCache.loaded) return;
    if (pendingFit.length === 0) return;
    if (isFitSnoozed()) return;
    if (getMetadataJob().status === "running") return;
    if (getRunningFitSession()) return;
    if (fitStarting.current) return;
    if (engineBusy || downloadBusy) return;
    const wait = Math.max(0, fitEligibleAt.current - Date.now());
    if (wait > 0) {
      const timer = setTimeout(() => setTick((t) => t + 1), wait + 50);
      return () => clearTimeout(timer);
    }

    for (const m of pendingFit) attemptedFit.current.add(pathKey(m.path));
    fitStarting.current = true;
    void startFitScan(providerId, FIT_PARALLEL, false, {
      expectedTotal: pendingFit.length,
      manual: false,
    })
      .then(() => {
        void refreshFitCache();
      })
      .finally(() => {
        fitStarting.current = false;
        setTick((t) => t + 1);
      });
  }, [
    setupResolved,
    setupActive,
    fitCache.loaded,
    pendingFit,
    engineBusy,
    downloadBusy,
    providerId,
    refreshFitCache,
  ]);

  // A launched engine outranks a background VRAM probe — yield immediately.
  useEffect(() => {
    if (!engineBusy) return;
    const running = getRunningFitSession();
    if (!running) return;
    void stopFitScan(running.providerId);
  }, [engineBusy]);
}
