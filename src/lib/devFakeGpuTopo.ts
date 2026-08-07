/**
 * DEV-only: inject extra GPUs into telemetry topo for layout stress tests.
 * Session state only — not persisted. Real NVML list stays untouched.
 */

import type { GpuInfo } from "./types";

export const DEV_FAKE_GPU_EXTRA_OPTIONS = [0, 1, 2, 4, 6] as const;
export type DevFakeGpuExtra = (typeof DEV_FAKE_GPU_EXTRA_OPTIONS)[number];

/**
 * Screenshot-friendly product name (subtle “Fake edition” suffix).
 * Detectable via isDevFakeGpu — no special card colors in UI.
 */
export const DEV_FAKE_GPU_NAME = "NVIDIA RTX PRO 6000 Fake edition";

/** RTX PRO 6000-class VRAM (96 GiB) — stable layout / forecast stubs. */
const FAKE_VRAM_MIB = 98304;
const FAKE_POWER_LIMIT_W = 600;

let extraCount: DevFakeGpuExtra = 0;
const listeners = new Set<() => void>();

export function getDevFakeGpuExtra(): DevFakeGpuExtra {
  return extraCount;
}

export function setDevFakeGpuExtra(n: number): void {
  const next = (DEV_FAKE_GPU_EXTRA_OPTIONS as readonly number[]).includes(n)
    ? (n as DevFakeGpuExtra)
    : 0;
  if (next === extraCount) return;
  extraCount = next;
  for (const cb of listeners) cb();
}

export function subscribeDevFakeGpuExtra(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function isDevFakeGpu(gpu: Pick<GpuInfo, "name">): boolean {
  return gpu.name.includes("Fake edition");
}

/**
 * Append N synthetic GPUs after real NVML entries.
 *
 * Same shape as scan_gpus → forecast / split / VRAM badge already consume them.
 * Later: per-fake name + VRAM + (optional) capability tags for mixed topo sims
 * (3090 / 4090 / PRO 6000) without a second code path.
 */
export function appendDevFakeGpus(real: GpuInfo[], extra: number = extraCount): GpuInfo[] {
  const n = Math.max(0, Math.floor(extra));
  if (n <= 0) return real;

  const template = real[real.length - 1];
  const startIdx =
    real.length > 0
      ? Math.max(...real.map((g) => g.index)) + 1
      : 0;

  const total = FAKE_VRAM_MIB;
  const manuf = FAKE_VRAM_MIB;
  // Idle-looking stub — not live NVML (obvious without special paint).
  const used = 256;
  const free = total - used;
  const driver = template?.driver_version;

  const fakes: GpuInfo[] = [];
  for (let i = 0; i < n; i++) {
    const index = startIdx + i;
    const name =
      n === 1 && real.length === 0
        ? DEV_FAKE_GPU_NAME
        : `${DEV_FAKE_GPU_NAME} (${index})`;
    fakes.push({
      index,
      name,
      memory_total: total,
      memory_used: used,
      memory_free: free,
      memory_total_manufactured: manuf,
      temperature_gpu: 38,
      temperature_hot_spot: null,
      temperature_memory: null,
      power_draw: 45,
      power_limit: FAKE_POWER_LIMIT_W,
      utilization_gpu: 0,
      utilization_memory: 0,
      driver_version: driver,
    });
  }

  return real.length === 0 ? fakes : [...real, ...fakes];
}
