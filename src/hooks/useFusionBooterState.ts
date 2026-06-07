import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GpuInfo, LogBatch, SystemEvent } from "../lib/types";
import { useTauriListen } from "./useTauriListen";
import {
  LOAD_PHASE_ORDER,
  type LoadPhaseId,
  maxPhase,
  parseGpuMask,
  parseLoadLogLine,
} from "../lib/fusionLoadParser";

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

const PHASE_DWELL_MS = 750;
/** After KV clears, HTTP + READY are the two fast log transitions — hold each ~750ms on the ladder */
const DWELL_PHASES: LoadPhaseId[] = ["server", "ready"];

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
  const [logPhase, setLogPhase] = useState<LoadPhaseId>("spawn");
  const [phase, setPhase] = useState<LoadPhaseId>("spawn");
  const [tickerLines, setTickerLines] = useState<string[]>([]);
  const [layerCurrent, setLayerCurrent] = useState(0);
  const [layerTotal, setLayerTotal] = useState(modelLayerTotal);
  const [pingAttempts, setPingAttempts] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [diskReadMibPerS, setDiskReadMibPerS] = useState(0);
  const [bitTick, setBitTick] = useState(0);
  const [liveGpus, setLiveGpus] = useState<GpuInfo[]>(gpus);
  const [logGpuIndices, setLogGpuIndices] = useState<number[]>([]);
  const startedAt = useRef(Date.now());
  const phaseSince = useRef(Date.now());
  const vramBaseline = useRef<Map<number, number>>(new Map());
  const baselineCaptured = useRef(false);

  const applyLogPhase = (incoming: LoadPhaseId) => {
    setLogPhase((prev) => maxPhase(prev, incoming));
  };

  const activeGpuIndices = useMemo(() => {
    if (logGpuIndices.length > 0) return logGpuIndices;
    const mask = parseGpuMask(gpuMask);
    if (mask.length > 0) return mask;
    return gpus.map((g) => g.index);
  }, [gpuMask, gpus, logGpuIndices]);

  useEffect(() => {
    if (!active) return;
    startedAt.current = Date.now();
    baselineCaptured.current = false;
    vramBaseline.current.clear();
    setLogPhase("spawn");
    setPhase("spawn");
    phaseSince.current = Date.now();
    setTickerLines([]);
    setLayerCurrent(0);
    setLayerTotal(modelLayerTotal);
    setPingAttempts(0);
    setElapsedSec(0);
    setDiskReadMibPerS(0);
    setLogGpuIndices([]);
  }, [active, slotIdx, modelLayerTotal]);

  useTauriListen<LogBatch>("engine-log-batch", (batch) => {
    if (!active || batch.slot !== slotIdx) return;
    for (const entry of batch.entries) {
      const parsed = parseLoadLogLine(entry.text);
      if (parsed.tickerLine) {
        setTickerLines((prev) => [...prev.slice(-2), parsed.tickerLine!]);
      }
      if (parsed.phase) {
        applyLogPhase(parsed.phase!);
      }
      if (parsed.layerCurrent != null) {
        setLayerCurrent((c) => Math.max(c, parsed.layerCurrent!));
      }
      if (parsed.layerTotal != null) {
        setLayerTotal((t) => Math.max(t, parsed.layerTotal!));
      }
      if (parsed.gpuIndex != null) {
        setLogGpuIndices((prev) =>
          prev.includes(parsed.gpuIndex!) ? prev : [...prev, parsed.gpuIndex!].sort((a, b) => a - b),
        );
      }
    }
  }, [active, slotIdx]);

  useTauriListen<SystemEvent>("engine-system", (ev) => {
    if (!active || ev.slot !== slotIdx) return;
    const parsed = parseLoadLogLine(ev.text);
    if (parsed.tickerLine) {
      setTickerLines((prev) => [...prev.slice(-2), parsed.tickerLine!]);
    }
    if (parsed.phase) {
      applyLogPhase(parsed.phase!);
    }
    if (ev.text.includes("readiness=")) {
      applyLogPhase("ready");
    }
  }, [active, slotIdx]);

  // KV / HTTP / READY flash through in logs — dwell each step ~750ms on the ladder
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      setPhase((display) => {
        const logIdx = LOAD_PHASE_ORDER.indexOf(logPhase);
        const dispIdx = LOAD_PHASE_ORDER.indexOf(display);
        if (dispIdx >= logIdx) return display;

        if (DWELL_PHASES.includes(display) && Date.now() - phaseSince.current < PHASE_DWELL_MS) {
          return display;
        }

        const next = LOAD_PHASE_ORDER[dispIdx + 1];
        phaseSince.current = Date.now();
        return next;
      });
    }, 40);
    return () => window.clearInterval(id);
  }, [active, logPhase]);

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt.current) / 1000));
      setBitTick((t) => t + 1);
    }, 250);
    return () => window.clearInterval(id);
  }, [active, slotIdx]);

  useEffect(() => {
    setLiveGpus(gpus);
  }, [gpus]);

  useEffect(() => {
    if (!active) return;
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
  }, [active, slotIdx]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const pollDisk = async () => {
      try {
        const data = await invoke<{ read_mib_per_s: number }>("scan_disk_io", { slotIdx });
        if (!cancelled) setDiskReadMibPerS(clampDiskReadMibPerS(data.read_mib_per_s ?? 0));
      } catch {
        if (!cancelled) setDiskReadMibPerS(0);
      }
    };

    pollDisk();
    const id = window.setInterval(pollDisk, 350);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active, slotIdx]);

  useEffect(() => {
    if (!active || baselineCaptured.current) return;
    for (const idx of activeGpuIndices) {
      const gpu = liveGpus.find((g) => g.index === idx);
      if (gpu) vramBaseline.current.set(idx, gpu.memory_used);
    }
    if (activeGpuIndices.length > 0) baselineCaptured.current = true;
  }, [active, liveGpus, activeGpuIndices]);

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

  const diskReadMbitPerS = diskReadMibPerS * 8;

  // Matches backend readiness poll interval (engine_stack.rs — 500ms between /health probes)
  useEffect(() => {
    if (!active || phase === "ready") return;
    const id = window.setInterval(() => {
      setPingAttempts((n) => n + 1);
    }, 500);
    return () => window.clearInterval(id);
  }, [active, phase]);

  return {
    phase,
    tickerLines,
    layerCurrent,
    layerTotal: layerTotal || modelLayerTotal,
    pingAttempts,
    elapsedSec,
    diskReadMibPerS,
    diskReadMbitPerS,
    activeGpuIndices,
    gpuVramLoads,
    liveGpus,
    bitTick,
  };
}

export function phaseIndex(phase: LoadPhaseId): number {
  return LOAD_PHASE_ORDER.indexOf(phase);
}