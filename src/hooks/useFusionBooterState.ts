import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GpuInfo } from "../lib/types";
import { LOAD_PHASE_ORDER, parseGpuMask, type LoadPhaseId } from "../lib/fusionLoadParser";
import {
  elapsedSecForSession,
  getBooterRevision,
  getBooterSession,
  initBooterSession,
  patchBooterSession,
  subscribeBooterSession,
} from "../lib/fusionBooterStore";

export interface GpuVramLoad {
  index: number;
  usedMib: number;
  targetMib: number;
  pct: number;
}

interface UseFusionBooterStateArgs {
  slotIdx: number;
  port: number;
  gpuMask: string;
  vramTargetMib?: number;
  modelLayerTotal?: number;
  gpuLoadTargetsMib?: Record<number, number>;
  gpus: GpuInfo[];
  active: boolean;
}

/** Matches telemetry.rs — NVMe PHY sanity cap for boot I/O hero (25 GiB/s). */
export const MAX_DISK_READ_MIB_PER_S = 25 * 1024;

export function clampDiskReadMibPerS(mibPerS: number): number {
  if (!Number.isFinite(mibPerS) || mibPerS < 0) return 0;
  return Math.min(mibPerS, MAX_DISK_READ_MIB_PER_S);
}

export interface FusionBooterState {
  phase: LoadPhaseId;
  tickerLines: string[];
  layerCurrent: number;
  layerTotal: number;
  pingAttempts: number;
  elapsedSec: number;
  diskReadMibPerS: number;
  diskReadMbitPerS: number;
  activeGpuIndices: number[];
  gpuVramLoads: GpuVramLoad[];
  liveGpus: GpuInfo[];
  bitTick: number;
  loadFailed: boolean;
  loadErrorReason: string;
}

export function useFusionBooterState({
  slotIdx,
  port,
  gpuMask,
  vramTargetMib = 0,
  modelLayerTotal = 0,
  gpuLoadTargetsMib = {},
  gpus,
  active,
}: UseFusionBooterStateArgs): FusionBooterState {
  useEffect(() => {
    initBooterSession(slotIdx, port, modelLayerTotal);
  }, [slotIdx, port, modelLayerTotal]);

  const revision = useSyncExternalStore(
    (cb) => subscribeBooterSession(slotIdx, cb),
    () => getBooterRevision(slotIdx),
    () => getBooterRevision(slotIdx),
  );

  const session = getBooterSession(slotIdx);

  const [liveGpus, setLiveGpus] = useState<GpuInfo[]>(gpus);
  const [bitTick, setBitTick] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const vramBaseline = useRef<Map<number, number>>(new Map());
  const baselineCaptured = useRef(false);

  useEffect(() => {
    if (!session) return;
    vramBaseline.current = new Map(
      Object.entries(session.vramBaseline).map(([k, v]) => [Number(k), v]),
    );
    baselineCaptured.current = session.baselineCaptured;
    setElapsedSec(elapsedSecForSession(session));
  }, [revision, session, slotIdx]);

  const activeGpuIndices = useMemo(() => {
    if (!session) return gpus.map((g) => g.index);
    if (session.logGpuIndices.length > 0) return session.logGpuIndices;
    const mask = parseGpuMask(gpuMask);
    if (mask.length > 0) return mask;
    return gpus.map((g) => g.index);
  }, [session, revision, gpuMask, gpus]);

  useEffect(() => {
    if (!active || !session) return;
    const id = window.setInterval(() => {
      setElapsedSec(elapsedSecForSession(session));
      setBitTick((t) => t + 1);
    }, 250);
    return () => window.clearInterval(id);
  }, [active, session, revision]);

  useEffect(() => {
    setLiveGpus(gpus);
  }, [gpus]);

  const pollingActive = active && session != null && !session.loadFailed;

  useEffect(() => {
    if (!pollingActive) return;
    let cancelled = false;

    const pollGpu = async () => {
      try {
        const data = await invoke<GpuInfo[]>("scan_gpus");
        if (!cancelled) setLiveGpus(data);
      } catch {}
    };

    pollGpu();
    const gpuId = window.setInterval(pollGpu, 500);
    return () => {
      cancelled = true;
      window.clearInterval(gpuId);
    };
  }, [pollingActive, slotIdx]);

  useEffect(() => {
    if (!pollingActive) return;
    let cancelled = false;

    const pollDisk = async () => {
      try {
        const data = await invoke<{ read_mib_per_s: number }>("scan_disk_io", { slotIdx });
        const mib = clampDiskReadMibPerS(data.read_mib_per_s ?? 0);
        if (!cancelled) {
          patchBooterSession(slotIdx, { diskReadMibPerS: mib });
        }
      } catch {
        if (!cancelled) patchBooterSession(slotIdx, { diskReadMibPerS: 0 });
      }
    };

    pollDisk();
    const id = window.setInterval(pollDisk, 350);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pollingActive, slotIdx]);

  useEffect(() => {
    if (!pollingActive || baselineCaptured.current) return;
    for (const idx of activeGpuIndices) {
      const gpu = liveGpus.find((g) => g.index === idx);
      if (gpu) vramBaseline.current.set(idx, gpu.memory_used);
    }
    if (activeGpuIndices.length > 0) {
      baselineCaptured.current = true;
      patchBooterSession(slotIdx, {
        vramBaseline: Object.fromEntries(vramBaseline.current),
        baselineCaptured: true,
      });
    }
  }, [pollingActive, liveGpus, activeGpuIndices, slotIdx]);

  const perGpuShareMib =
    vramTargetMib > 0 && activeGpuIndices.length > 0
      ? vramTargetMib / activeGpuIndices.length
      : 0;

  const gpuVramLoads = useMemo((): GpuVramLoad[] => {
    return activeGpuIndices.map((idx) => {
      const gpu = liveGpus.find((g) => g.index === idx);
      const base = vramBaseline.current.get(idx) ?? gpu?.memory_used ?? 0;
      const usedMib = gpu ? Math.max(0, gpu.memory_used - base) : 0;
      const forecastMib = gpuLoadTargetsMib[idx] ?? 0;
      const targetMib =
        forecastMib > 0
          ? forecastMib
          : perGpuShareMib > 0
            ? perGpuShareMib
            : gpu?.memory_total ?? 1;
      const pct = Math.min(100, (usedMib / Math.max(targetMib, 1)) * 100);
      return { index: idx, usedMib, targetMib, pct };
    });
  }, [liveGpus, activeGpuIndices, gpuLoadTargetsMib, perGpuShareMib, bitTick]);

  const diskReadMibPerS = session?.diskReadMibPerS ?? 0;
  const diskReadMbitPerS = diskReadMibPerS * 8;

  if (!session) {
    return {
      phase: "spawn",
      tickerLines: [],
      layerCurrent: 0,
      layerTotal: modelLayerTotal,
      pingAttempts: 0,
      elapsedSec: 0,
      diskReadMibPerS: 0,
      diskReadMbitPerS: 0,
      activeGpuIndices: gpus.map((g) => g.index),
      gpuVramLoads: [],
      liveGpus: gpus,
      bitTick: 0,
      loadFailed: false,
      loadErrorReason: "",
    };
  }

  return {
    phase: session.phase,
    tickerLines: session.tickerLines,
    layerCurrent: session.layerCurrent,
    layerTotal: session.layerTotal || modelLayerTotal,
    pingAttempts: session.pingAttempts,
    elapsedSec,
    diskReadMibPerS,
    diskReadMbitPerS,
    activeGpuIndices,
    gpuVramLoads,
    liveGpus,
    bitTick,
    loadFailed: session.loadFailed,
    loadErrorReason: session.loadErrorReason,
  };
}

export function phaseIndex(phase: LoadPhaseId): number {
  return LOAD_PHASE_ORDER.indexOf(phase);
}