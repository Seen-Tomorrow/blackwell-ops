import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GpuInfo, ModelMetadata } from "../lib/types";
import {
  planFromLive,
  type GpuCalibrationRow,
  type LayerPlan,
} from "../lib/vramLayerPlan";

/** Exact per-block sizes, as read from the GGUF tensor table. */
type LayerBytes = {
  per_block_mib: number[];
  /** Bytes one token of KV costs in one attention block (0 when unknown). */
  kv_bytes_per_token_per_layer: number;
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
/** Bytes per KV element for the quantisations the launcher supports. */
function kvBytesPerElement(kvQuant: string | undefined): number {
  const q = (kvQuant ?? "f16").trim().toLowerCase();
  if (q === "f16" || q === "bf16") return 2;
  if (q === "q8_0") return 34 / 32;
  if (q === "q5_1" || q === "q5_0") return 20 / 32;
  if (q === "q4_1") return 20 / 32;
  if (q === "q4_0") return 18 / 32;
  return 2;
}

/** KV cache per layer for the planned context, MiB. 2 tensors (K and V). */
function kvMibPerLayer(args: {
  ctxTokens?: number;
  kvQuant?: string;
  nHead?: number;
  nHeadKv?: number;
  nEmbd?: number;
}): number {
  const ctx = args.ctxTokens ?? 0;
  const nHead = args.nHead ?? 0;
  const nHeadKv = args.nHeadKv ?? 0;
  const nEmbd = args.nEmbd ?? 0;
  if (!(ctx > 0) || !(nHead > 0) || !(nHeadKv > 0) || !(nEmbd > 0)) return 0;
  const headDim = nEmbd / nHead;
  const bytes = 2 * nHeadKv * headDim * kvBytesPerElement(args.kvQuant) * ctx;
  return bytes / (1024 * 1024);
}

export function useLayerPlan(
  modelPath: string | null | undefined,
  gpus: GpuInfo[],
  calibration: GpuCalibrationRow[],
  knobs?: { ctxTokens?: number; kvQuant?: string; modelMeta?: ModelMetadata | null },
): { plan: LayerPlan | null; layerBytes: LayerBytes | null; kvMibPerLayer: number; loading: boolean } {
  const [layerBytes, setLayerBytes] = useState<LayerBytes | null>(null);
  const [measuredKv, setMeasuredKv] = useState<{ kvMib: number; ctx: number } | null>(null);
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

  // KV from the last real launch beats any formula: hybrid-attention models (Qwen3.8-Flash
  // carries KV in 12 of 48 blocks) make a per-block estimate off by 4x.
  useEffect(() => {
    if (!modelPath) {
      setMeasuredKv(null);
      return;
    }
    let cancelled = false;
    void invoke<{ kv_mib?: number; ctx_tokens?: number } | null>("get_learned_vram_for_model", {
      modelPath,
      ctx: null,
      kvQuant: null,
      split: null,
    })
      .then((hit) => {
        if (cancelled) return;
        if (hit && hit.kv_mib && hit.kv_mib > 0 && hit.ctx_tokens && hit.ctx_tokens > 0) {
          setMeasuredKv({ kvMib: hit.kv_mib, ctx: hit.ctx_tokens });
        } else {
          setMeasuredKv(null);
        }
      })
      .catch(() => {
        if (!cancelled) setMeasuredKv(null);
      });
    return () => {
      cancelled = true;
    };
  }, [modelPath]);

  const kvPerLayer = kvMibPerLayer({
    ctxTokens: knobs?.ctxTokens,
    kvQuant: knobs?.kvQuant,
    nHead: knobs?.modelMeta?.n_head,
    nHeadKv: knobs?.modelMeta?.n_head_kv,
    nEmbd: knobs?.modelMeta?.n_embd,
  });

  const blocks = layerBytes?.per_block_mib.length ?? 0;
  const ctxForKv = knobs?.ctxTokens ?? 0;
  const kvPerBlock = useMemo(() => {
    if (!blocks) return 0;
    if (measuredKv && ctxForKv > 0) {
      // KV is linear in ctx; scale the measured figure to the planned context.
      return (measuredKv.kvMib * (ctxForKv / measuredKv.ctx)) / blocks;
    }
    if (kvPerLayer > 0) return kvPerLayer;
    return 0;
  }, [blocks, measuredKv, ctxForKv, kvPerLayer]);

  const plan = useMemo(() => {
    if (!layerBytes || gpus.length !== 2) return null;
    return planFromLive({
      perBlockMib: layerBytes.per_block_mib,
      kvMibPerLayer: kvPerBlock > 0 ? kvPerBlock : undefined,
      tokenEmbdMib: layerBytes.token_embd_mib,
      outputMib: layerBytes.output_mib,
      otherMib: layerBytes.other_mib,
      freeMib: gpus.map((g) => Math.max(0, g.memory_free)),
      calibration,
    });
  }, [layerBytes, gpus, calibration, kvPerBlock]);

  return { plan, layerBytes, kvMibPerLayer: kvPerBlock, loading };
}
