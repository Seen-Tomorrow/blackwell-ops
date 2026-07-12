import { useEffect, useRef, useState } from "react";
import type { GpuInfo, StackEntry } from "../lib/types";
import { isVramCommittedSlot } from "../services/vram/scenarios/scenarios_factory";

/**
 * Per-GPU NVML used (MiB) captured while no engine holds VRAM — session-scoped only.
 * Freezes on first LOADING/RUNNING slot so post-launch growth is not mistaken for baseline.
 * Used to separate driver/system reserve (e.g. ~600 MiB on CUDA0) from engine vs foreign apps.
 */
export function useGpuIdleBaseline(gpus: GpuInfo[], stack: StackEntry[]): Record<number, number> {
  const frozenRef = useRef(false);
  const baselineRef = useRef<Record<number, number>>({});
  const [baseline, setBaseline] = useState<Record<number, number>>({});

  const hasCommitted = stack.some((s) => isVramCommittedSlot(s.status));

  useEffect(() => {
    if (hasCommitted) {
      frozenRef.current = true;
      return;
    }
    if (frozenRef.current || gpus.length === 0) return;

    let changed = false;
    for (const g of gpus) {
      const mib = g.memory_used / 1024;
      const prev = baselineRef.current[g.index];
      if (prev === undefined) {
        baselineRef.current[g.index] = mib;
        changed = true;
      } else if (mib > prev + 32) {
        // Driver reserve (e.g. ~600 MiB on CUDA0) often appears after the first NVML poll.
        baselineRef.current[g.index] = mib;
        changed = true;
      }
    }
    if (changed) setBaseline({ ...baselineRef.current });
  }, [gpus, hasCommitted]);

  return baseline;
}