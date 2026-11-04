import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GpuInfo } from "../lib/types";
import {
  planFromLive,
  type GpuCalibrationRow,
  type LayerPlan,
} from "../lib/vramLayerPlan";

/** Exact per-block sizes, as read from the GGUF tensor table. */
type LayerBytes = {
  per_block_mib: number[];
  lookup_mib: number;
  token_embd_mib: number;
  output_mib: number;
  other_mib: number;
};

/**
 * Layer-split plan for the selected model, from metadata + live free VRAM + calibration.
 *
 * Nothing here touches the forecast: the plan is a second opinion that the overlay shows
 * beside FIT and LEARNED, so a wrong plan is visible rather than silently steering a launch.
 */
export function useLayerPlan(
  modelPath: string | null | undefined,
  gpus: GpuInfo[],
  calibration: GpuCalibrationRow[],
): { plan: LayerPlan | null; layerBytes: LayerBytes | null; loading: boolean } {
  const [layerBytes, setLayerBytes] = useState<LayerBytes | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!modelPath) {
      setLayerBytes(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void invoke<LayerBytes>("get_model_layer_bytes", { modelPath })
      .then((bytes) => {
        if (!cancelled) setLayerBytes(bytes?.per_block_mib?.length ? bytes : null);
      })
      .catch(() => {
        if (!cancelled) setLayerBytes(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [modelPath]);

  const plan = useMemo(() => {
    if (!layerBytes || gpus.length !== 2) return null;
    return planFromLive({
      perBlockMib: layerBytes.per_block_mib,
      tokenEmbdMib: layerBytes.token_embd_mib,
      outputMib: layerBytes.output_mib,
      otherMib: layerBytes.other_mib,
      freeMib: gpus.map((g) => Math.max(0, g.memory_free)),
      calibration,
    });
  }, [layerBytes, gpus, calibration]);

  return { plan, layerBytes, loading };
}
