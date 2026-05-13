import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GpuInfo, StackEntry } from "../lib/types";

// ── Blackwell Mock Data ────────────────────────────────────────────────

const MOCK_GPUS: GpuInfo[] = [
  {
    index: 0,
    name: "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
    memory_total: 98304 * 1024 * 1024,
    memory_total_manufactured: 98304 * 1024 * 1024,
    memory_used: 40176 * 1024 * 1024,
    memory_free: 58128 * 1024 * 1024,
    temperature_gpu: 38,
    temperature_hot_spot: 42,
    temperature_memory: null,
    power_draw: 90.2,
    power_limit: 420,
    utilization_gpu: 0,
    utilization_memory: 0,
  },
  {
    index: 1,
    name: "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
    memory_total: 98304 * 1024 * 1024,
    memory_total_manufactured: 98304 * 1024 * 1024,
    memory_used: 35679 * 1024 * 1024,
    memory_free: 62625 * 1024 * 1024,
    temperature_gpu: 29,
    temperature_hot_spot: 33,
    temperature_memory: null,
    power_draw: 13.8,
    power_limit: 420,
    utilization_gpu: 0,
    utilization_memory: 0,
  },
];

const MOCK_STACK: StackEntry[] = [
  { idx: 0, alias: "slot-0", model_name: "", port: 9090, gpu: "GPU-0", status: "IDLE" },
  { idx: 1, alias: "slot-1", model_name: "", port: 9091, gpu: "GPU-1", status: "IDLE" },
  { idx: 2, alias: "slot-2", model_name: "", port: 9092, gpu: "GPU-0", status: "IDLE" },
  { idx: 3, alias: "slot-3", model_name: "", port: 9093, gpu: "GPU-1", status: "IDLE" },
];

// ── Tauri Availability Check ───────────────────────────────────────────

let _tauriAvailable: boolean | null = null;

async function checkTauri(): Promise<boolean> {
  if (_tauriAvailable !== null) return _tauriAvailable;
  try {
    await invoke<string>("get_app_version");
    _tauriAvailable = true;
  } catch {
    _tauriAvailable = false;
  }
  return _tauriAvailable;
}

// ── Hook ───────────────────────────────────────────────────────────────

export function useSentinelData() {
  const [gpus, setGpus] = useState<GpuInfo[]>(MOCK_GPUS);
  const [stack, setStack] = useState<StackEntry[]>(MOCK_STACK);
  const tauriReadyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    checkTauri().then((available) => {
      if (!mountedRef.current) return;
      tauriReadyRef.current = available;

      if (available) {
        // Real Tauri mode — poll GPU + stack from Rust backend
        const pollGpu = async () => {
          try { setGpus(await invoke<GpuInfo[]>("scan_gpus")); } catch {}
        };
        const pollStack = async () => {
          try { setStack(await invoke<StackEntry[]>("get_stack_status")); } catch {}
        };

        pollGpu();
        pollStack();
        const gpuInterval = setInterval(pollGpu, 100);
        const stackInterval = setInterval(pollStack, 2000);

        return () => {
          clearInterval(gpuInterval);
          clearInterval(stackInterval);
        };
      } else {
        // Browser mode — keep mock data, optionally simulate live drift
        const driftInterval = setInterval(() => {
          setGpus((prev) =>
            prev.map((gpu) => ({
              ...gpu,
              temperature_gpu: Math.max(25, Math.min(85, gpu.temperature_gpu + (Math.random() - 0.5) * 2)),
              power_draw: Math.max(10, gpu.power_draw + (Math.random() - 0.5) * 4),
            }))
          );
        }, 2000);

        return () => clearInterval(driftInterval);
      }
    });

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const applyTelemetryUpdate = useCallback((data: {
    tps?: number;
    gpu_temps?: number[];
    vram_used_mib?: number[];
    vram_total_mib?: number[];
    engine_status?: string;
  }) => {
    if (data.gpu_temps && data.gpu_temps.length > 0) {
      setGpus((prev) =>
        prev.map((gpu, idx) => ({
          ...gpu,
          temperature_gpu: Math.round(data.gpu_temps![idx] ?? gpu.temperature_gpu),
          power_draw: Math.max(10, (data.engine_status === "generating" ? 90 + Math.random() * 30 : 14)),
        }))
      );
    }

    if (data.vram_used_mib && data.vram_used_mib.length > 0) {
      setGpus((prev) =>
        prev.map((gpu, idx) => ({
          ...gpu,
          memory_used: Math.round(data.vram_used_mib![idx] * 1024 * 1024),
          memory_total: data.vram_total_mib ? Math.round(data.vram_total_mib[idx] * 1024 * 1024) : gpu.memory_total,
        }))
      );
    }

    if (data.engine_status === "generating") {
      setStack((prev) =>
        prev.map((entry) => ({
          ...entry,
          status: entry.status === "IDLE" ? "RUNNING" : entry.status,
          model_name: data.tps && data.tps > 0 ? `model-${Math.round(data.tps)}tps` : entry.model_name,
        }))
      );
    } else {
      setStack((prev) =>
        prev.map((entry) => ({ ...entry, status: "IDLE", model_name: "" }))
      );
    }
  }, []);

  return { gpus, stack, applyTelemetryUpdate };
}
