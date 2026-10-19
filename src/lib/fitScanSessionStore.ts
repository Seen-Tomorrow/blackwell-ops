import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { FitScanComplete, FitScanFull, FitDataPoint, FitScanProgress } from "./types";
import { readStorage, writeStorage, KEYS } from "./storage";

type FitScanStatus = "idle" | "scanning" | "complete" | "error";

interface ProviderFitScanState {
  status: FitScanStatus;
  parallel: number;
  totalModels: number;
  completed: number;
  failed: number;
  results?: FitScanComplete;
  error?: string;
  scanStartTime?: number;
  panelHidden?: boolean;
  /** True when a user pressed SCAN/RESCAN — such a run keeps its results open. */
  manual?: boolean;
  /** Models finished **in this run** (the strip's numerator; the results map also
   *  holds entries carried over from the cache). */
  runCompleted?: number;
  /** Model currently scanning (live row highlight) */
  activeLabel?: string;
  activeModelPath?: string;
}

type SessionMap = Record<string, ProviderFitScanState>;

let sessions: SessionMap = loadPersistedSessions();
let revision = 0;
let activeProviderId: string | null = null;
const subscribers = new Set<() => void>();
let listenersReady = false;
/** Models finished per provider **in the current run** — in-memory only. */
const runDone = new Map<string, Set<string>>();

function loadPersistedSessions(): SessionMap {
  try {
    const raw = readStorage(KEYS.fitScanSessions);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as SessionMap;
    if (!parsed || typeof parsed !== "object") return {};
    for (const state of Object.values(parsed)) {
      // A scan cannot survive a page reload — the command future dies with the
      // webview and so does the progress listener. A persisted "scanning" was
      // kept before, which then satisfied the single-flight check forever: every
      // new scan answered "busy" and a phantom progress panel never closed.
      if (state.status === "scanning") {
        state.status = "idle";
        state.totalModels = 0;
        state.completed = 0;
        state.failed = 0;
        state.activeModelPath = undefined;
        state.activeLabel = undefined;
      }
    }
    return parsed;
  } catch {
    return {};
  }
}

function persistSessions() {
  writeStorage(KEYS.fitScanSessions, JSON.stringify(sessions));
}

/**
 * Progress arrives per plan point (~10 per model, plus scanning events), so a
 * 73-model run emits >1000 updates. Serialising the whole results map and
 * notifying every subscriber per event re-rendered the provider page and the
 * catalog thousands of times — enough to stall the window during a cancel.
 * Coalesce both: subscribers see ~10 fps, the localStorage write is debounced.
 */
let notifyScheduled = false;
let persistTimer: number | null = null;

const hasWindow = typeof window !== "undefined";

function scheduleNotify() {
  if (!hasWindow) {
    subscribers.forEach((cb) => cb());
    return;
  }
  if (notifyScheduled) return;
  notifyScheduled = true;
  window.setTimeout(() => {
    notifyScheduled = false;
    subscribers.forEach((cb) => cb());
  }, 100);
}

function schedulePersist() {
  if (!hasWindow) {
    persistSessions();
    return;
  }
  if (persistTimer !== null) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    persistSessions();
  }, 1500);
}

function bump() {
  revision += 1;
  schedulePersist();
  scheduleNotify();
}

function ensureListeners() {
  if (listenersReady) return;
  listenersReady = true;

  void listen<FitScanProgress>("fit-scan-progress", (e) => {
    applyFitScanProgress(e.payload);
  });
}

function mergeProgressPoint(
  entry: FitScanFull | undefined,
  modelPath: string,
  label: string,
  vramMib: number,
): FitScanFull {
  const prev = entry ?? { model_path: modelPath, points: [] };
  const points = [...(prev.points ?? [])];
  const pt: FitDataPoint = {
    label,
    ctx: 0,
    kv_quant: "",
    batch: 0,
    parallel: 0,
    split_mode: "",
    vram_mib: vramMib,
  };
  const idx = points.findIndex((p) => p.label === label);
  if (idx >= 0) points[idx] = pt;
  else points.push(pt);
  return { ...prev, model_path: modelPath, points, error: prev.error };
}

function emitScanConsoleLine(evt: FitScanProgress) {
  if (evt.status === "error" || evt.status === "library_meta" || !evt.model_path) return;
  void invoke("emit_to_blackwell_console", {
    category: "utils",
    content: `[FIT-SCAN] ${evt.model_path} | ${evt.status} | ${evt.label || ""} | ${evt.skip_reason || ""} | ${evt.vram_mib != null ? `${evt.vram_mib} MiB` : ""}`,
    style: evt.status === "complete" ? "Success" : "Normal",
  });
}

function applyFitScanProgress(evt: FitScanProgress) {
  if (!evt) return;
  emitScanConsoleLine(evt);

  if (evt.status === "library_meta") {
    const pid = evt.provider_id ?? activeProviderId;
    if (!pid) return;
    const ps = sessions[pid];
    if (!ps || ps.status !== "scanning") return;
    sessions[pid] = {
      ...ps,
      // The queue total is seeded from the catalog before the run starts; the
      // backend's `library_meta` used to overwrite it per path, which made the
      // progress read 1/5 → 1/9 → 1/32 while the scan was already underway.
      totalModels: ps.totalModels > 0 ? ps.totalModels : (evt.total_models ?? 0),
      results: ps.results
        ? {
            ...ps.results,
            scan_points_total: evt.scan_points_total ?? ps.results.scan_points_total,
          }
        : {
            provider_id: pid,
            total_models: evt.total_models ?? 0,
            completed: 0,
            failed: 0,
            scan_points_total: evt.scan_points_total,
            results: {},
          },
    };
    bump();
    return;
  }

  if (!evt.model_path) return;

  const pid = activeProviderId;
  if (!pid) return;
  const ps = sessions[pid];
  if (!ps || ps.status !== "scanning") return;

  const existingResults = ps.results?.results ?? {};
  const prevEntry = existingResults[evt.model_path];
  runDone.get(pid)?.add(evt.model_path);
  const runCompleted = runDone.get(pid)?.size ?? 0;

  if (evt.status === "scanning") {
    sessions[pid] = {
      ...ps,
      runCompleted,
      activeModelPath: evt.model_path,
      activeLabel: evt.label,
      results: ps.results
        ? { ...ps.results, results: existingResults }
        : {
            provider_id: pid,
            total_models: ps.totalModels,
            completed: 0,
            failed: 0,
            scan_points_total: ps.results?.scan_points_total,
            results: existingResults,
          },
    };
    bump();
    return;
  }

  let updatedEntry = prevEntry;
  if (evt.status === "skipped") {
    updatedEntry = {
      model_path: evt.model_path,
      points: [],
      skip_reason: evt.skip_reason,
    };
  } else if (evt.status === "point_skipped" && evt.label) {
    const prevSkipped = { ...(prevEntry?.skipped_points ?? {}) };
    if (evt.skip_reason) {
      prevSkipped[evt.label] = evt.skip_reason;
    }
    updatedEntry = {
      model_path: evt.model_path,
      points: prevEntry?.points ?? [],
      error: prevEntry?.error,
      skip_reason: prevEntry?.skip_reason,
      skipped_points: prevSkipped,
    };
  } else if (evt.status === "complete" && evt.vram_mib != null && evt.label) {
    updatedEntry = mergeProgressPoint(prevEntry, evt.model_path, evt.label, evt.vram_mib);
  }

  const updatedResults = {
    ...existingResults,
    [evt.model_path]: updatedEntry ?? prevEntry ?? { model_path: evt.model_path, points: [] },
  };

  sessions[pid] = {
    ...ps,
    runCompleted,
    // The denominator is the queue seeded at start; the results map also carries
    // cached entries, so it must never grow the total mid-run.
    totalModels: ps.totalModels > 0 ? ps.totalModels : (evt.total_models ?? 0),
    activeModelPath:
      evt.status === "complete" || evt.status === "skipped" || evt.status === "point_skipped"
        ? undefined
        : evt.model_path,
    activeLabel:
      evt.status === "complete" || evt.status === "skipped" || evt.status === "point_skipped"
        ? undefined
        : evt.label,
    results: {
      provider_id: pid,
      total_models: ps.totalModels,
      completed: ps.completed,
      failed: ps.failed,
      scan_points_total: ps.results?.scan_points_total ?? evt.scan_points_total,
      results: updatedResults,
    },
  };
  bump();
}

export function getFitScanRevision(): number {
  return revision;
}

export function subscribeFitScanSessions(cb: () => void): () => void {
  ensureListeners();
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function getFitScanSessions(): SessionMap {
  ensureListeners();
  return sessions;
}

function getProviderFitScanState(providerId: string): ProviderFitScanState | undefined {
  return sessions[providerId];
}

export function showFitScanPanel(providerId: string) {
  const ps = sessions[providerId];
  if (!ps) return;
  sessions[providerId] = { ...ps, panelHidden: false };
  bump();
}

export function hideFitScanPanel(providerId: string) {
  const ps = sessions[providerId];
  if (!ps) return;
  if (ps.status === "scanning") {
    sessions[providerId] = { ...ps, panelHidden: true };
  } else {
    sessions[providerId] = {
      status: "idle",
      parallel: ps.parallel,
      totalModels: 0,
      completed: 0,
      failed: 0,
    };
  }
  bump();
}

export function stopFitScanLocal(providerId: string) {
  const ps = sessions[providerId];
  runDone.delete(providerId);
  sessions[providerId] = {
    status: "idle",
    parallel: ps?.parallel ?? 2,
    totalModels: 0,
    completed: 0,
    failed: 0,
  };
  activeProviderId = null;
  bump();
}

export async function bootstrapFitScanCache(providerId: string): Promise<FitScanComplete | null> {
  try {
    const snap = await invoke<{
      provider_id: string;
      scan_points_total: number;
      results: Record<string, FitScanFull>;
    }>("get_fit_scan_cache_snapshot", { providerId });
    if (!snap.results || Object.keys(snap.results).length === 0) return null;
    return {
      provider_id: snap.provider_id,
      total_models: Object.keys(snap.results).length,
      completed: Object.keys(snap.results).length,
      failed: 0,
      scan_points_total: snap.scan_points_total,
      results: snap.results,
    };
  } catch {
    return null;
  }
}

export function beginFitScanSession(
  providerId: string,
  parallel: number,
  cached: FitScanComplete | null,
  forceRescan: boolean,
  opts?: { totalModels?: number; manual?: boolean },
) {
  ensureListeners();
  activeProviderId = providerId;
  runDone.set(providerId, new Set());
  const prev = sessions[providerId];
  const scanPointsTotal = cached?.scan_points_total ?? prev?.results?.scan_points_total;
  const baseResults: Record<string, FitScanFull> = forceRescan
    ? {}
    : { ...(cached?.results ?? prev?.results?.results ?? {}) };

  sessions[providerId] = {
    status: "scanning",
    parallel,
    // Seed the total from the queue the caller is about to scan, so the bar has
    // a stable denominator from the first frame. The cache size is NOT the job
    // size (cached entries are skipped), so it is only a last-resort default.
    totalModels:
      opts?.totalModels ??
      Math.max(Object.keys(baseResults).length, cached?.total_models ?? 0),
    manual: opts?.manual ?? false,
    runCompleted: 0,
    completed: 0,
    failed: 0,
    scanStartTime: Date.now(),
    panelHidden: false,
    results: {
      provider_id: providerId,
      total_models: Object.keys(baseResults).length,
      completed: 0,
      failed: 0,
      scan_points_total: scanPointsTotal,
      results: baseResults,
    },
  };
  bump();
}

export function completeFitScanSession(providerId: string, result: FitScanComplete) {
  const ps = sessions[providerId];
  sessions[providerId] = {
    status: "complete",
    parallel: ps?.parallel ?? 2,
    // Keep the queue total when it is known: `result.total_models` is the
    // backend's own main-model count, which can differ from the catalog queue.
    totalModels: Math.max(result.total_models, ps?.totalModels ?? 0),
    manual: ps?.manual,
    completed: result.completed,
    failed: result.failed,
    results: result,
    panelHidden: false,
    scanStartTime: ps?.scanStartTime,
  };
  runDone.delete(providerId);
  if (activeProviderId === providerId) activeProviderId = null;
  bump();
}

export function failFitScanSession(providerId: string, error: string, parallel: number) {
  const ps = sessions[providerId];
  sessions[providerId] = {
    status: "error",
    parallel,
    totalModels: ps?.totalModels ?? 0,
    manual: ps?.manual,
    completed: 0,
    failed: 0,
    error,
  };
  runDone.delete(providerId);
  if (activeProviderId === providerId) activeProviderId = null;
  bump();
}

export function setFitScanActiveProvider(providerId: string | null) {
  activeProviderId = providerId;
}