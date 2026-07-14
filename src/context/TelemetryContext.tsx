import { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GpuInfo, CpuInfo, SystemInfo } from "../lib/types";
import { gpuScanSnapshotEqual } from "../lib/telemetryGpu";
import { useTauriListen } from "../hooks/useTauriListen";
import { frontendPollEnabled } from "../lib/debugFlags";

interface TelemetryState {
  gpus: GpuInfo[];
  cpu: CpuInfo | null;
  systemInfo: SystemInfo | null;
}

const TelemetryContext = createContext<TelemetryState>({
  gpus: [],
  cpu: null,
  systemInfo: null,
});

export function useTelemetry() {
  return useContext(TelemetryContext);
}

const GPU_FAST_INTERVAL_MS = 250;
/** Catalog VRAM topo — 1s while catalog tab or live engines. */
const GPU_BACKGROUND_INTERVAL_MS = 1000;
/** Idle tabs — slow poll; slot-cleared still triggers immediate refresh. */
const GPU_IDLE_INTERVAL_MS = 5000;
const CPU_INTERVAL_MS = 500;
/** NVML can lag CUDA free by 1–2s after engine stop. */
const GPU_POST_STOP_POLL_MS = 2000;

export type GpuPollTier = "fast" | "normal" | "idle";

function gpuPollIntervalMs(tier: GpuPollTier): number {
  if (tier === "fast") return GPU_FAST_INTERVAL_MS;
  if (tier === "normal") return GPU_BACKGROUND_INTERVAL_MS;
  return GPU_IDLE_INTERVAL_MS;
}

function gpuVramBucketMib(tier: GpuPollTier): number {
  if (tier === "fast") return 64;
  if (tier === "normal") return 128;
  return 256;
}

export function TelemetryProvider({
  children,
  pollingActive,
  gpuPollTier = "idle",
}: {
  children: React.ReactNode;
  pollingActive: boolean;
  /** fast = telemetry tab; normal = catalog or live engines; idle = other tabs */
  gpuPollTier?: GpuPollTier;
}) {
  const [gpus, setGpus] = useState<GpuInfo[]>([]);
  const [cpu, setCpu] = useState<CpuInfo | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const gpusRef = useRef<GpuInfo[]>([]);
  const gpuPollTierRef = useRef(gpuPollTier);
  gpuPollTierRef.current = gpuPollTier;

  const pollGpu = useCallback(async () => {
    if (!frontendPollEnabled()) return;
    try {
      const data = await invoke<GpuInfo[]>("scan_gpus");
      const bucketMib = gpuVramBucketMib(gpuPollTierRef.current);
      if (gpuScanSnapshotEqual(gpusRef.current, data, bucketMib)) return;
      gpusRef.current = data;
      setGpus(data);
    } catch {}
  }, []);

  const pollCpu = useCallback(async () => {
    if (!frontendPollEnabled()) return;
    try {
      const data = await invoke<CpuInfo>("scan_cpu");
      setCpu(data);
    } catch {}
  }, []);

  const postStopPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const schedulePostStopGpuPoll = useCallback(() => {
    void pollGpu();
    if (postStopPollRef.current) clearTimeout(postStopPollRef.current);
    postStopPollRef.current = setTimeout(() => {
      postStopPollRef.current = null;
      void pollGpu();
    }, GPU_POST_STOP_POLL_MS);
  }, [pollGpu]);

  useEffect(() => {
    return () => {
      if (postStopPollRef.current) clearTimeout(postStopPollRef.current);
    };
  }, []);

  // Refresh NVML soon after engine stop — clears stale "External apps" hatched VRAM on topo.
  useTauriListen<{ slot: number }>("slot-cleared", schedulePostStopGpuPoll, [schedulePostStopGpuPoll]);

  // One-time system info + hardware bootstrap snapshot (catalog / fit / reactor)
  useEffect(() => {
    let cancelled = false;
    invoke<SystemInfo>("scan_system_info")
      .then((data) => {
        if (!cancelled) setSystemInfo(data);
      })
      .catch(console.error);
    void pollGpu();
    pollCpu();

    // Fresh installs can miss the first NVML read — forecast stays empty until restart without retries.
    let attempts = 0;
    const bootstrapGpu = setInterval(() => {
      if (cancelled || gpusRef.current.length > 0 || attempts >= 6) {
        clearInterval(bootstrapGpu);
        return;
      }
      attempts += 1;
      void pollGpu();
    }, 1500);

    return () => {
      cancelled = true;
      clearInterval(bootstrapGpu);
    };
  }, [pollGpu, pollCpu]);

  // GPU poll tier: fast (telemetry) / normal (catalog or engines) / idle (other tabs).
  useEffect(() => {
    let paused = document.visibilityState !== "visible";
    const interval = gpuPollIntervalMs(gpuPollTier);

    const tickGpu = () => { if (!paused) void pollGpu(); };
    tickGpu();
    const gpuTimer = setInterval(tickGpu, interval);

    const handleVisibility = () => {
      paused = document.visibilityState !== "visible";
      if (!paused) void pollGpu();
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      clearInterval(gpuTimer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [gpuPollTier, pollGpu]);

  // CPU live polling — TELEMETRY tab or config-panel HW monitor (see App pollingActive)
  useEffect(() => {
    if (!pollingActive) return;

    let paused = document.visibilityState !== "visible";
    const tickCpu = () => { if (!paused) void pollCpu(); };
    tickCpu();
    const cpuTimer = setInterval(tickCpu, CPU_INTERVAL_MS);

    const handleVisibility = () => {
      paused = document.visibilityState !== "visible";
      if (!paused) void pollCpu();
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      clearInterval(cpuTimer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [pollingActive, pollCpu]);

  const value = useMemo(
    () => ({ gpus, cpu, systemInfo }),
    [gpus, cpu, systemInfo],
  );

  return (
    <TelemetryContext.Provider value={value}>
      {children}
    </TelemetryContext.Provider>
  );
}