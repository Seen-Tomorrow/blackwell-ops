import type { GpuInfo } from "./types";

/**
 * Coarse arch family from product name (no SM query on GpuInfo).
 * Peers share a family so mixed fleets don't pin Full Auto to a random weak card.
 */
export function gpuArchFamily(name: string): string {
  const n = name.toLowerCase();
  if (
    /\b(blackwell|b200|b100|gb200)\b/.test(n) ||
    /\brtx\s*pro\b/.test(n) ||
    /\b50[0-9]{2}\b/.test(n)
  ) {
    return "blackwell";
  }
  if (/\b(hopper|h100|h200|gh200)\b/.test(n)) return "hopper";
  if (/\b(ada|l40|l4)\b/.test(n) || /\b40[0-9]{2}\b/.test(n)) return "ada";
  if (/\b(ampere|a100|a6000|a40)\b/.test(n) || /\b30[0-9]{2}\b/.test(n)) return "ampere";
  if (/\b(turing|t4)\b/.test(n) || /\b20[0-9]{2}\b/.test(n)) return "turing";
  if (/\b(volta|v100)\b/.test(n)) return "volta";
  return `other:${n.replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).slice(0, 3).join("-") || "gpu"}`;
}

/**
 * Full Auto single-GPU list position: among same-arch peers as the freest card,
 * choose largest free VRAM (tie → lower nvidia index).
 * `perGpuAvailable` is aligned with `gpus[]` (see computeGpuAvailableList).
 * Return value is an index into `gpus` / `perGpuAvailable` (forecast bars).
 */
export function pickFullAutoSingleGpuListPos(
  gpus: GpuInfo[],
  perGpuAvailable: number[],
): number {
  if (gpus.length === 0) return 0;
  if (gpus.length === 1) return 0;

  let bestPos = 0;
  let bestFree = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < gpus.length; i++) {
    const free = perGpuAvailable[i] ?? 0;
    if (free > bestFree + 1e-6) {
      bestFree = free;
      bestPos = i;
    }
  }

  const arch = gpuArchFamily(gpus[bestPos]?.name ?? "");
  let pickPos = bestPos;
  let pickFree = bestFree;
  for (let i = 0; i < gpus.length; i++) {
    if (gpuArchFamily(gpus[i]?.name ?? "") !== arch) continue;
    const free = perGpuAvailable[i] ?? 0;
    const idx = gpus[i]?.index ?? i;
    const pickIdx = gpus[pickPos]?.index ?? pickPos;
    if (free > pickFree + 1e-6 || (Math.abs(free - pickFree) <= 1e-6 && idx < pickIdx)) {
      pickFree = free;
      pickPos = i;
    }
  }
  return pickPos;
}

/** NVIDIA device index for CUDA_VISIBLE_DEVICES / device=GPU-N. */
export function pickFullAutoSingleGpuIndex(
  gpus: GpuInfo[],
  perGpuAvailable: number[],
): number {
  const pos = pickFullAutoSingleGpuListPos(gpus, perGpuAvailable);
  return gpus[pos]?.index ?? pos;
}

export function fullAutoSingleDeviceLabel(
  gpus: GpuInfo[],
  perGpuAvailable: number[],
): string {
  return `GPU-${pickFullAutoSingleGpuIndex(gpus, perGpuAvailable)}`;
}
