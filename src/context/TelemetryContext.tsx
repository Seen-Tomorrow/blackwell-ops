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

export function TelemetryProvider({ children, lowPower }: { children: React.ReactNode; lowPower?: boolean }) {
  const [gpus, setGpus] = useState<GpuInfo[]>([]);
  const [cpu, setCpu] = useState<CpuInfo | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);

  // One-time system info fetch (doesn't change at runtime)
  useEffect(() => {
    invoke<SystemInfo>("scan_system_info")
      .then((data) => setSystemInfo(data))
      .catch(console.error);
  }, []);

  // Consolidated telemetry polling — GPU + CPU with configurable intervals
  const pollGpu = useCallback(async () => {
    try { await invoke<GpuInfo[]>("scan_gpus").then(setGpus); } catch {}
  }, []);

  const pollCpu = useCallback(async () => {
    try { await invoke<CpuInfo>("scan_cpu").then(setCpu); } catch {}
  }, []);

  useEffect(() => {
    const gpuInterval = lowPower ? 2000 : 250;
    const cpuInterval = lowPower ? 5000 : 500;

    let paused = false;

    const startPolling = () => {
      paused = false;
      pollGpu();
      pollCpu();
    };

    startPolling();
    const gpuTimer = setInterval(() => { if (!paused) pollGpu(); }, gpuInterval);
    const cpuTimer = setInterval(() => { if (!paused) pollCpu(); }, cpuInterval);

    // Pause polling when tab is hidden to save resources
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
  }, [lowPower, pollGpu, pollCpu]);

  return (
    <TelemetryContext.Provider value={{ gpus, cpu, systemInfo }}>
      {children}
    </TelemetryContext.Provider>
  );
}
