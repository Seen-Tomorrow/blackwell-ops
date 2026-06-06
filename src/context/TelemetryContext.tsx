import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GpuInfo, CpuInfo, SystemInfo } from "../lib/types";

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

const GPU_INTERVAL_MS = 250;
const CPU_INTERVAL_MS = 500;

export function TelemetryProvider({
  children,
  pollingActive,
}: {
  children: React.ReactNode;
  pollingActive: boolean;
}) {
  const [gpus, setGpus] = useState<GpuInfo[]>([]);
  const [cpu, setCpu] = useState<CpuInfo | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);

  const pollGpu = useCallback(async () => {
    try {
      const data = await invoke<GpuInfo[]>("scan_gpus");
      setGpus(data);
    } catch {}
  }, []);

  const pollCpu = useCallback(async () => {
    try {
      const data = await invoke<CpuInfo>("scan_cpu");
      setCpu(data);
    } catch {}
  }, []);

  // One-time system info + hardware bootstrap snapshot (catalog / fit / reactor)
  useEffect(() => {
    invoke<SystemInfo>("scan_system_info")
      .then((data) => setSystemInfo(data))
      .catch(console.error);
    pollGpu();
    pollCpu();
  }, [pollGpu, pollCpu]);

  // Live polling only while TELEMETRY tab is active
  useEffect(() => {
    if (!pollingActive) return;

    let paused = document.visibilityState !== "visible";

    const tickGpu = () => { if (!paused) pollGpu(); };
    const tickCpu = () => { if (!paused) pollCpu(); };

    tickGpu();
    tickCpu();
    const gpuTimer = setInterval(tickGpu, GPU_INTERVAL_MS);
    const cpuTimer = setInterval(tickCpu, CPU_INTERVAL_MS);

    const handleVisibility = () => {
      paused = document.visibilityState !== "visible";
      if (!paused) {
        pollGpu();
        pollCpu();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      clearInterval(gpuTimer);
      clearInterval(cpuTimer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [pollingActive, pollGpu, pollCpu]);

  return (
    <TelemetryContext.Provider value={{ gpus, cpu, systemInfo }}>
      {children}
    </TelemetryContext.Provider>
  );
}