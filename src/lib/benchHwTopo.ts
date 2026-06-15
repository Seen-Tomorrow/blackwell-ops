import type { GpuInfo } from "./types";

/** Distinct slot colors — matches multi-GPU topology chips (up to 8). */
export const BENCH_GPU_COLORS = [
  "#76B900",
  "#22D3EE",
  "#FBBF24",
  "#FB923C",
  "#A78BFA",
  "#F472B6",
  "#94A3B8",
  "#EF4444",
] as const;

export interface BenchGpuTopoEntry {
  key: string;
  color: string;
  count: number;
  /** e.g. "RTX PRO 6000 96GB" */
  label: string;
  indices: number[];
  /** Driver version for the first GPU in this group (e.g. "610.47"). */
  driverVersion?: string;
}

/** Short driver label for UI — "610.47.23" → "610.47". */
export function formatGpuDriverVersion(raw?: string): string | undefined {
  if (!raw?.trim()) return undefined;
  const trimmed = raw.trim();
  const parts = trimmed.split(".");
  if (parts.length >= 2) return `${parts[0]}.${parts[1]}`;
  return trimmed;
}

export function parseGpuMaskIndices(gpuMask: string | undefined, gpus: GpuInfo[]): number[] {
  if (gpuMask?.trim()) {
    const parsed = gpuMask
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n) && gpus.some((g) => g.index === n));
    if (parsed.length > 0) return parsed;
  }
  if (gpus.length === 1) return [gpus[0].index];
  return [];
}

export function formatGpuShortLabel(gpu: GpuInfo): string {
  const vramGb = Math.round((gpu.memory_total_manufactured || gpu.memory_total) / 1024);
  const shortName = gpu.name.replace(/^NVIDIA\s+/i, "").trim();
  return `${shortName} ${vramGb}GB`;
}

export function buildBenchGpuTopoEntries(
  gpus: GpuInfo[],
  gpuMask?: string,
): BenchGpuTopoEntry[] {
  const indices = parseGpuMaskIndices(gpuMask, gpus);
  const selected = indices
    .map((i) => gpus.find((g) => g.index === i))
    .filter((g): g is GpuInfo => g != null);
  if (selected.length === 0) return [];

  const groups = new Map<string, BenchGpuTopoEntry>();
  for (const gpu of selected) {
    const label = formatGpuShortLabel(gpu);
    const key = label;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.indices.push(gpu.index);
    } else {
      groups.set(key, {
        key,
        color: BENCH_GPU_COLORS[gpu.index % BENCH_GPU_COLORS.length],
        count: 1,
        label,
        indices: [gpu.index],
        driverVersion: formatGpuDriverVersion(gpu.driver_version),
      });
    }
  }

  return Array.from(groups.values()).sort((a, b) => a.indices[0] - b.indices[0]);
}

export function formatBenchSplitHeadline(
  gpus: GpuInfo[],
  gpuMask: string | undefined,
  splitMode: string | undefined,
): string | null {
  const indices = parseGpuMaskIndices(gpuMask, gpus);
  if (indices.length === 0) return null;

  const split = String(splitMode ?? "none").trim().toLowerCase();
  const splitActive = split.length > 0 && split !== "none";
  const n = indices.length;

  if (n <= 1) {
    return splitActive ? `1 GPU · ${split} split` : "1 GPU";
  }
  if (splitActive) {
    return `${n} GPUs · ${split} split`;
  }
  return `${n} GPUs`;
}