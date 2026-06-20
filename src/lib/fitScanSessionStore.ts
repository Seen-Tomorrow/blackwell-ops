import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { FitScanComplete, FitScanFull, FitDataPoint, FitScanProgress } from "./types";
import { readStorage, writeStorage, KEYS } from "./storage";

export type FitScanStatus = "idle" | "scanning" | "complete" | "error";

export interface ProviderFitScanState {
  status: FitScanStatus;
  parallel: number;
  totalModels: number;
  completed: number;
  failed: number;
  results?: FitScanComplete;
  error?: string;
  scanStartTime?: number;
  panelHidden?: boolean;
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

function loadPersistedSessions(): SessionMap {
  try {
    const raw = readStorage(KEYS.fitScanSessions);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as SessionMap;
    if (!parsed || typeof parsed !== "object") return {};
    for (const state of Object.values(parsed)) {
      if (state.status === "scanning") {
        state.status = "scanning";
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

function bump() {
  revision += 1;
  persistSessions();
  subscribers.forEach((cb) => cb());
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

export function applyFitScanProgress(evt: FitScanProgress) {
  if (!evt) return;
  emitScanConsoleLine(evt);

  if (evt.status === "library_meta") {
    const pid = evt.provider_id ?? activeProviderId;
    if (!pid) return;
    const ps = sessions[pid];
    if (!ps || ps.status !== "scanning") return;
    sessions[pid] = {
      ...ps,
      totalModels: evt.total_models ?? ps.totalModels,
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

  if (evt.status === "scanning") {
    sessions[pid] = {
      ...ps,
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
    totalModels: Math.max(ps.totalModels, evt.total_models ?? Object.keys(updatedResults).length),
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

export function getProviderFitScanState(providerId: string): ProviderFitScanState | undefined {
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
) {
  ensureListeners();
  activeProviderId = providerId;
  const prev = sessions[providerId];
  const scanPointsTotal = cached?.scan_points_total ?? prev?.results?.scan_points_total;
  const baseResults: Record<string, FitScanFull> = forceRescan
    ? {}
    : { ...(cached?.results ?? prev?.results?.results ?? {}) };

  sessions[providerId] = {
    status: "scanning",
    parallel,
    totalModels: Math.max(Object.keys(baseResults).length, cached?.total_models ?? 0),
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
    totalModels: result.total_models,
    completed: result.completed,
    failed: result.failed,
    results: result,
    panelHidden: false,
    scanStartTime: ps?.scanStartTime,
  };
  if (activeProviderId === providerId) activeProviderId = null;
  bump();
}

export function failFitScanSession(providerId: string, error: string, parallel: number) {
  sessions[providerId] = {
    status: "error",
    parallel,
    totalModels: 0,
    completed: 0,
    failed: 0,
    error,
  };
  if (activeProviderId === providerId) activeProviderId = null;
  bump();
}

export function setFitScanActiveProvider(providerId: string | null) {
  activeProviderId = providerId;
}