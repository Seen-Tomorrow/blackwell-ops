import type { GpuInfo } from "./types";

const ACTIVE_SPLIT_MODES = new Set(["layer", "row", "tensor"]);

export function isActiveSplitMode(split: unknown): boolean {
  return ACTIVE_SPLIT_MODES.has(String(split ?? "").trim().toLowerCase());
}

/**
 * Parse `device` ("GPU-0", "GPU-0,GPU-1", or "0,1") into sorted, deduplicated
 * valid GPU indices. Falls back to `[gpus[0].index]` when empty/invalid.
 */
export function parseDeviceSelection(deviceValue: unknown, gpus: GpuInfo[]): number[] {
  if (gpus.length === 0) return [];
  const valid = new Set(gpus.map((g) => g.index));
  const raw = String(deviceValue ?? "").trim();
  const parsed: number[] = [];
  const seen = new Set<number>();

  for (const part of raw.split(",")) {
    const trimmed = part.trim().replace(/^gpu-/i, "");
    if (!trimmed) continue;
    const idx = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(idx) || !valid.has(idx) || seen.has(idx)) continue;
    seen.add(idx);
    parsed.push(idx);
  }

  if (parsed.length === 0) {
    return [gpus[0].index];
  }
  return parsed.sort((a, b) => a - b);
}

/** Format GPU indices as `"GPU-0"` or `"GPU-0,GPU-1"`. */
export function formatDeviceSelection(indices: number[]): string {
  const unique = Array.from(new Set(indices)).sort((a, b) => a - b);
  return unique.map((i) => `GPU-${i}`).join(",");
}

/** GPU indices eligible for automatic multi-GPU split (excluding user-excluded cards). */
export function eligibleAutoSplitIndices(gpus: GpuInfo[], excluded: number[]): number[] {
  const excludedSet = new Set(excluded);
  return gpus.map((g) => g.index).filter((idx) => !excludedSet.has(idx));
}

/**
 * Unified toggle:
 * - Clicking an unselected GPU adds it; clicking a selected GPU removes it (unless it's the last one).
 * - 1 GPU selected -> `split: "none"`.
 * - 2+ GPUs selected -> keeps active split (`layer`/`row`/`tensor`), or promotes `"none"` -> `"layer"`.
 */
export function toggleDeviceSelection(
  currentIndices: number[],
  clickedIndex: number,
  currentSplit: unknown,
  allIndices: number[],
): { device: string; split: string; indices: number[] } {
  const validSet = new Set(allIndices);
  const base = currentIndices.filter((i) => validSet.has(i));
  const isSelected = base.includes(clickedIndex);

  let next: number[];
  if (isSelected) {
    next = base.length > 1 ? base.filter((i) => i !== clickedIndex) : base;
  } else if (validSet.has(clickedIndex)) {
    next = [...base, clickedIndex];
  } else {
    next = base;
  }

  if (next.length === 0 && allIndices.length > 0) {
    next = [allIndices[0]];
  }
  next = Array.from(new Set(next)).sort((a, b) => a - b);

  const splitStr = String(currentSplit ?? "none").trim().toLowerCase();
  const nextSplit =
    next.length <= 1
      ? "none"
      : isActiveSplitMode(splitStr)
        ? splitStr
        : "layer";

  return {
    device: formatDeviceSelection(next),
    split: nextSplit,
    indices: next,
  };
}

/**
 * Reconcile `device` when the user explicitly clicks a `SPLIT` chip (`none`, `layer`, `row`, `tensor`).
 */
export function reconcileDeviceOnSplitChange(
  nextSplit: string,
  currentIndices: number[],
  gpus: GpuInfo[],
  excludedAutoSplit: number[],
): { device: string; split: string } {
  const normalized = String(nextSplit ?? "none").trim().toLowerCase();
  if (gpus.length === 0) {
    return { device: "GPU-0", split: normalized };
  }

  if (!isActiveSplitMode(normalized)) {
    const first = currentIndices[0] ?? gpus[0].index;
    return { device: formatDeviceSelection([first]), split: "none" };
  }

  if (currentIndices.length >= 2) {
    return { device: formatDeviceSelection(currentIndices), split: normalized };
  }

  const eligible = eligibleAutoSplitIndices(gpus, excludedAutoSplit);
  const target = eligible.length >= 2 ? eligible : gpus.map((g) => g.index);
  return { device: formatDeviceSelection(target), split: normalized };
}
