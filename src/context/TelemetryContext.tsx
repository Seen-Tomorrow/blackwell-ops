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
  // Identity guard: skip setState when readings haven't changed numerically.
  // Prevents reference churn from forcing re-renders of the entire tree every 250ms.
  const pollGpu = useCallback(async () => {
    try {
      const data = await invoke<GpuInfo[]>("scan_gpus");
      setGpus(prev => {
        if (prev.length !== data.length) return data;
        for (let i = 0; i < prev.length; i++) {
          if (prev[i].memory_used !== data[i].memory_used ||
              prev[i].temperature_gpu !== data[i].temperature_gpu ||
              prev[i].utilization_gpu !== data[i].utilization_gpu) {
            return data;
          }
        }
        return prev; // Identical reading — retain reference, skip re-render
      });
    } catch {}
  }, []);

  const pollCpu = useCallback(async () => {
    try {
      const data = await invoke<CpuInfo>("scan_cpu");
      setCpu(prev => {
        if (!prev) return data;
        if (prev.avg_usage_percent !== data.avg_usage_percent) return data;
        return prev; // Identical reading — retain reference, skip re-render
      });
    } catch {}
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
