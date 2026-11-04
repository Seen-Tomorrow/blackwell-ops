import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GpuCalibrationRow } from "../lib/vramLayerPlan";

/**
 * Measured per-device runtime cost (`gpu_calibration::get_gpu_calibration`).
 *
 * Each engine launch appends a sample; the backend returns the median per device. An empty
 * list is normal on a machine that has not launched anything yet — the planner then falls
 * back to `DEFAULT_CONTEXT_MIB`.
 */
export function useGpuCalibration(refreshKey?: unknown): {
  calibration: GpuCalibrationRow[];
  reload: () => void;
} {
  const [calibration, setCalibration] = useState<GpuCalibrationRow[]>([]);

  const load = useCallback(async () => {
    try {
      const rows = await invoke<GpuCalibrationRow[]>("get_gpu_calibration");
      setCalibration(Array.isArray(rows) ? rows : []);
    } catch {
      // No calibration file yet, or the command is unavailable in an older build.
      setCalibration([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const reload = useCallback(() => {
    void load();
  }, [load]);

  return { calibration, reload };
}
