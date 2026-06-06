import { useEffect, useRef, useState } from "react";
import type { CpuInfo, GpuInfo } from "../../lib/types";

export interface LabSample {
  t: number;
  gpuPower: number[];
  gpuVramPct: number[];
  gpuUtil: number[];
  cpuAvg: number;
  cpuMaxCore: number;
  totalPower: number;
  fusionTps: number;
  gpuTemps: number[];
}

const CAPACITY = 120;

export function useTelemetryLabBuffer(
  gpus: GpuInfo[],
  cpu: CpuInfo | null,
  fusionTps: number,
) {
  const [samples, setSamples] = useState<LabSample[]>([]);
  const ewmaTempsRef = useRef<number[]>([]);
  const [ewmaTemps, setEwmaTemps] = useState<number[]>([]);
  const [thermalEta, setThermalEta] = useState<number[]>([]);
  const alpha = 0.15;

  useEffect(() => {
    if (gpus.length === 0) return;

    const now = Date.now();
    const gpuTemps = gpus.map((g) => g.temperature_gpu);
    const prevEwma = ewmaTempsRef.current;
    const nextEwma = gpus.map((g, i) => {
      const prev = prevEwma[i] ?? g.temperature_gpu;
      return prev + alpha * (g.temperature_gpu - prev);
    });
    ewmaTempsRef.current = nextEwma;

    const eta = gpus.map((g, i) => {
      const slope = Math.max(0, (g.temperature_gpu - nextEwma[i]) * 0.5 + (g.power_draw / Math.max(g.power_limit, 1)) * 8);
      const headroom = Math.max(0, 90 - g.temperature_gpu);
      return slope > 0.1 ? Math.round((headroom / slope) * 2) : 999;
    });

    const sample: LabSample = {
      t: now,
      gpuPower: gpus.map((g) => g.power_draw),
      gpuVramPct: gpus.map((g) => (g.memory_total > 0 ? (g.memory_used / g.memory_total) * 100 : 0)),
      gpuUtil: gpus.map((g) => g.utilization_gpu),
      cpuAvg: cpu?.avg_usage_percent ?? 0,
      cpuMaxCore: cpu ? Math.max(...cpu.core_usages, 0) : 0,
      totalPower: gpus.reduce((s, g) => s + g.power_draw, 0),
      fusionTps,
      gpuTemps,
    };

    setSamples((prev) => [...prev.slice(-(CAPACITY - 1)), sample]);
    setEwmaTemps(nextEwma);
    setThermalEta(eta);
  }, [gpus, cpu, fusionTps]);

  return { samples, ewmaTemps, thermalEta, capacity: CAPACITY };
}