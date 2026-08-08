/**
 * DEV-only: inject synthetic GPUs into telemetry for layout + forecast stress.
 * Session state only. Real NVML list is never mutated at the source.
 */

import type { GpuInfo } from "./types";

/** Catalog of real-ish SKUs (last ~3 gens + pro) with manufactured VRAM. */
export type DevFakeGpuSku = {
  id: string;
  /** nvidia-smi style product name (screenshots / forecast). */
  name: string;
  /** Manufactured VRAM MiB. */
  vramMib: number;
  powerLimitW: number;
  /** Short chip label in the modal. */
  short: string;
  gen: "ampere" | "ada" | "blackwell" | "pro";
};

export const DEV_FAKE_GPU_CATALOG: DevFakeGpuSku[] = [
  {
    id: "rtx3090",
    name: "NVIDIA GeForce RTX 3090",
    vramMib: 24576,
    powerLimitW: 350,
    short: "3090 24G",
    gen: "ampere",
  },
  {
    id: "rtx4090",
    name: "NVIDIA GeForce RTX 4090",
    vramMib: 24576,
    powerLimitW: 450,
    short: "4090 24G",
    gen: "ada",
  },
  {
    id: "rtx5090",
    name: "NVIDIA GeForce RTX 5090",
    vramMib: 32768,
    powerLimitW: 575,
    short: "5090 32G",
    gen: "blackwell",
  },
  {
    id: "rtx6000ada",
    name: "NVIDIA RTX 6000 Ada Generation",
    vramMib: 49152,
    powerLimitW: 300,
    short: "6000 Ada 48G",
    gen: "ada",
  },
  {
    id: "l40s",
    name: "NVIDIA L40S",
    vramMib: 49152,
    powerLimitW: 350,
    short: "L40S 48G",
    gen: "ada",
  },
  {
    id: "pro6000",
    name: "NVIDIA RTX PRO 6000 Blackwell",
    vramMib: 98304,
    powerLimitW: 600,
    short: "PRO 6000 96G",
    gen: "pro",
  },
];

export const DEV_FAKE_GPU_COUNT_MAX = 8;

/** Counts per SKU id (0 = none). */
export type DevFakeGpuPlan = Record<string, number>;

let plan: DevFakeGpuPlan = {};
const fakeIndices = new Set<number>();
const listeners = new Set<() => void>();

export function getDevFakeGpuPlan(): DevFakeGpuPlan {
  return { ...plan };
}

export function getDevFakeGpuTotal(): number {
  return Object.values(plan).reduce((s, n) => s + Math.max(0, n | 0), 0);
}

export function setDevFakeGpuPlan(next: DevFakeGpuPlan): void {
  const cleaned: DevFakeGpuPlan = {};
  for (const sku of DEV_FAKE_GPU_CATALOG) {
    const n = Math.max(0, Math.min(DEV_FAKE_GPU_COUNT_MAX, Math.floor(Number(next[sku.id]) || 0)));
    if (n > 0) cleaned[sku.id] = n;
  }
  plan = cleaned;
  for (const cb of listeners) cb();
}

export function setDevFakeGpuCount(skuId: string, count: number): void {
  setDevFakeGpuPlan({ ...plan, [skuId]: count });
}

export function clearDevFakeGpus(): void {
  setDevFakeGpuPlan({});
}

export function subscribeDevFakeGpuExtra(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function isDevFakeGpu(gpu: Pick<GpuInfo, "index" | "name">): boolean {
  return fakeIndices.has(gpu.index);
}

/**
 * Expand plan into GpuInfo rows after real NVML entries.
 * Indices continue from max real index. Names are real product strings.
 */
export function appendDevFakeGpus(real: GpuInfo[], p: DevFakeGpuPlan = plan): GpuInfo[] {
  fakeIndices.clear();
  const total = Object.values(p).reduce((s, n) => s + Math.max(0, n | 0), 0);
  if (total <= 0) return real;

  const template = real[real.length - 1];
  let nextIdx =
    real.length > 0 ? Math.max(...real.map((g) => g.index)) + 1 : 0;
  const driver = template?.driver_version;
  const fakes: GpuInfo[] = [];

  for (const sku of DEV_FAKE_GPU_CATALOG) {
    const n = Math.max(0, Math.min(DEV_FAKE_GPU_COUNT_MAX, Math.floor(Number(p[sku.id]) || 0)));
    for (let i = 0; i < n; i++) {
      const index = nextIdx++;
      fakeIndices.add(index);
      const used = 256;
      fakes.push({
        index,
        name: n > 1 ? `${sku.name} (${i + 1})` : sku.name,
        memory_total: sku.vramMib,
        memory_used: used,
        memory_free: sku.vramMib - used,
        memory_total_manufactured: sku.vramMib,
        temperature_gpu: 36,
        temperature_hot_spot: null,
        temperature_memory: null,
        power_draw: 40,
        power_limit: sku.powerLimitW,
        utilization_gpu: 0,
        utilization_memory: 0,
        driver_version: driver,
      });
    }
  }

  return real.length === 0 ? fakes : [...real, ...fakes];
}

/** @deprecated Use getDevFakeGpuTotal / plan — kept for button label helpers. */
export function getDevFakeGpuExtra(): number {
  return getDevFakeGpuTotal();
}
