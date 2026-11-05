import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTauriListen } from "./useTauriListen";
import type { GpuInfo, ModelMetadata } from "../lib/types";
import {
  planFromLive,
  type GpuCalibrationRow,
  type LayerPlan,
} from "../lib/vramLayerPlan";

/** Exact per-block sizes, as read from the GGUF tensor table. */
type ColdForecast = {
  weights_mib: number;
  kv_mib: number;
  compute_mib: number;
  total_mib: number;
  basis?: { arch?: string; layers?: number; points?: unknown[]; kv_layer_ratio?: number };
};

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

/** Parse a written `-ts` ("0.550,0.450"); null unless it names one fraction per device. */
function parseTensorSplit(raw: string | undefined, devices: number): number[] | null {
  if (!raw) return null;
  const parts = raw.split(",").map((part) => Number(part.trim()));
  if (parts.length !== devices) return null;
  if (!parts.every((value) => Number.isFinite(value) && value > 0)) return null;
  return parts;
}

export function useLayerPlan(
  modelPath: string | null | undefined,
  gpus: GpuInfo[],
  calibration: GpuCalibrationRow[],
  knobs?: {
    ctxTokens?: number;
    kvQuant?: string;
    splitMode?: string;
    batch?: number;
    ubatch?: number;
    /** Slot count of the launch — it moves the compute buffers and is part of the key. */
    parallel?: number;
    /** Changes on every engine state change, so a finished launch is picked up without
     *  nudging the ctx slider (`LOADING -> RUNNING -> IDLE`). */
    stackSig?: string;
    /** Applied tensor split ("0.55,0.45"). It pins the placement, so the plan reports the
     *  layers that split really gets instead of proposing its own boundary. */
    tensorSplit?: string;
    modelMeta?: ModelMetadata | null;
  },
): {
  plan: LayerPlan | null;
  /** `-ts` TAKEOVER should write for the byte-balanced boundary; null before the table lands. */
  applyTs: number[] | null;
  layerBytes: LayerBytes | null;
  kvMibPerLayer: number;
  /** measured | profile | geometry | none — geometry is an upper bound, not a forecast. */
  kvSource: "measured" | "profile" | "geometry" | "none";
  /** true when the measured run had to shrink parameters to fit (slower, same inventory). */
  squeezed: boolean;
  /** Scanner projection for this config, when the model has no measurement here. */
  fitProjectionMib: number | null;
  fitProjectionExact: boolean;
  loading: boolean;
} {
  const [layerBytes, setLayerBytes] = useState<LayerBytes | null>(null);
  const [measuredKv, setMeasuredKv] = useState<{
    kvMib: number;
    ctx: number;
    computeMib: number[];
    /** Weights the engine actually held on the GPUs (GGUF total differs by host tensors). */
    modelMib: number;
    /** Recurrent-state + vision buffers, part of the launch inventory. */
    rsMib: number;
    /** The launch total (vram_mib). Overhead = total - weights - KV, which cannot disagree
     *  with the terms it is made of. */
    vramMib: number;
    /** true = the engine shrank parameters to fit (slower for the same inventory). */
    fitChanged: boolean | null;
  } | null>(null);
  // No launch of this model yet: forecast it from launches of the same shape.
  const [cold, setCold] = useState<ColdForecast | null>(null);
  // The FIT scanner's own projection for this config - a model-specific prior (~1.5% below the
  // real inventory), used when this model has no measurement at this ctx.
  const [fitProj, setFitProj] = useState<{ vramMib: number; exact: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  // Bumped whenever a launch persists a learned row; feeds the lookup deps below.
  const [storeVersion, setStoreVersion] = useState(0);
  useTauriListen<null>("learned-vram-changed", () => {
    setStoreVersion((v) => v + 1);
  });

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

  const shapesKey = [modelPath, measuredKv ? 1 : 0, knobs?.ctxTokens, knobs?.kvQuant, knobs?.splitMode, knobs?.batch, knobs?.ubatch].join("|");
  useEffect(() => {
    if (!modelPath || measuredKv) {
      setCold(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void invoke<ColdForecast>("get_cold_forecast", {
        modelPath,
        ctx: knobs?.ctxTokens ?? 0,
        kvQuant: knobs?.kvQuant ?? "",
        split: knobs?.splitMode ?? "none",
        batch: knobs?.batch ?? 0,
        ubatch: knobs?.ubatch ?? 0,
        excludeModel: null,
      })
        .then((hit) => {
          if (!cancelled) setCold(hit && hit.total_mib > 0 ? hit : null);
        })
        .catch(() => {
          if (!cancelled) setCold(null);
        });
    }, 260);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapesKey]);
  // KV from the last real launch beats any formula: hybrid-attention models (Qwen3.8-Flash
  // carries KV in 12 of 48 blocks) make a per-block estimate off by 4x.
  useEffect(() => {
    if (!modelPath) {
      setMeasuredKv(null);
      return;
    }
    let cancelled = false;
    // Debounce: the ctx slider changes this on every step.
    const timer = setTimeout(() => {
    void invoke<{
      kv_mib?: number;
      ctx_tokens?: number;
      compute_mib?: number[];
      vram_mib?: number;
      fit_changed?: boolean | null;
      model_mib?: number;
      rs_mib?: number;
    } | null>("get_learned_vram_for_model", {
      modelPath,
      // Ask for the planned configuration: the nearest-ctx launch gives both the KV
      // baseline and the compute buffers that belong to that context.
      ctx: knobs?.ctxTokens != null ? String(knobs.ctxTokens) : null,
      kvQuant: knobs?.kvQuant ?? null,
      split: null,
      parallel: knobs?.parallel ?? 1,
    })
      .then((hit) => {
        if (cancelled) return;
        if (hit && hit.kv_mib && hit.kv_mib > 0 && hit.ctx_tokens && hit.ctx_tokens > 0) {
          setMeasuredKv({
            kvMib: hit.kv_mib,
            ctx: hit.ctx_tokens,
            computeMib: Array.isArray(hit.compute_mib) ? hit.compute_mib : [],
            modelMib: hit.model_mib ?? 0,
            rsMib: hit.rs_mib ?? 0,
            vramMib: hit.vram_mib ?? 0,
            fitChanged: hit.fit_changed ?? null,
          });
        } else {
          setMeasuredKv(null);
        }
      })
      .catch(() => {
        if (!cancelled) setMeasuredKv(null);
      });
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [modelPath, knobs?.ctxTokens, knobs?.kvQuant, knobs?.splitMode, knobs?.batch, knobs?.ubatch, knobs?.parallel, knobs?.stackSig, storeVersion]);

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
    if (cold && cold.kv_mib > 0) return cold.kv_mib / blocks;
    if (kvPerLayer > 0) return kvPerLayer;
    return 0;
  }, [blocks, measuredKv, ctxForKv, kvPerLayer, cold]);

  // The GGUF total counts tensors the engine keeps on the host; a launch reports what it
  // actually placed on the GPUs (+1.3 GB on Q6_K, +0.7 GB on UD-IQ3_XXS). When a launch of
  // this shape exists, match its weights instead of the file total.
  const ggufWeightsMib = layerBytes
    ? layerBytes.per_block_mib.reduce((sum, mib) => sum + mib, 0) +
      (layerBytes.token_embd_mib ?? 0) +
      (layerBytes.output_mib ?? 0) +
      (layerBytes.other_mib ?? 0)
    : 0;
  const weightScale =
    measuredKv && measuredKv.modelMib > 0 && ggufWeightsMib > 0
      ? measuredKv.modelMib / ggufWeightsMib
      : 1;

  const appliedTs = useMemo(
    () => parseTensorSplit(knobs?.tensorSplit, gpus.length),
    [knobs?.tensorSplit, gpus.length],
  );

  // Overhead is the measured total minus the terms we know: weights on the GPUs and KV.
  // Deriving it beats transporting per-device compute arrays, which arrived short and made a
  // card look free. The per-device SPLIT is not layer-proportional, though: measured compute
  // was 6,539/11,328 MiB on DeepSeek-V4.1 at 512K and 1,655/1,385 MiB on Qwen3.8-27B at 64K,
  // so the sign flips with shape. Use the measured pair only when the ctx matches, else an
  // even split — a layer-count split invents GiB on whichever card carries fewer bytes.
  const overheadTotalMib = measuredKv
    ? Math.max(0, measuredKv.vramMib - measuredKv.modelMib - measuredKv.kvMib)
    : cold?.compute_mib;
  const overheadMib = useMemo(() => {
    if (!overheadTotalMib || overheadTotalMib <= 0) return [];
    const perDevice = measuredKv?.computeMib;
    if (
      perDevice
      && perDevice.length === gpus.length
      && measuredKv?.ctx === ctxForKv
      && perDevice.every((mib) => Number.isFinite(mib) && mib >= 0)
    ) {
      const sum = perDevice.reduce((total, mib) => total + mib, 0);
      if (sum > 0) return perDevice.map((mib) => (overheadTotalMib * mib) / sum);
    }
    return gpus.map(() => overheadTotalMib / gpus.length);
  }, [overheadTotalMib, measuredKv, ctxForKv, gpus.length]);

  const plan: LayerPlan | null = useMemo(() => {
    if (!layerBytes || gpus.length !== 2) return null;
    return planFromLive({
      perBlockMib: layerBytes.per_block_mib.map((mib) => mib * weightScale),
      kvMibPerLayer: kvPerBlock > 0 ? kvPerBlock : undefined,
      tokenEmbdMib: (layerBytes.token_embd_mib ?? 0) * weightScale,
      outputMib: (layerBytes.output_mib ?? 0) * weightScale,
      otherMib: (layerBytes.other_mib ?? 0) * weightScale,
      freeMib: gpus.map((g) => Math.max(0, g.memory_free)),
      overheadMib,
      overheadTotalMib,
      // rs + vision buffers belong to the launch inventory too (598 + 248 MiB on the 27B).
      calibration,
      // A `-ts` in the config is the placement the engine will really get; the plan reports
      // that geometry and keeps the byte-balanced proposal in `applyTs`.
      appliedTs: appliedTs ?? undefined,
    });
  }, [layerBytes, gpus, calibration, kvPerBlock, measuredKv, cold, weightScale, overheadMib, overheadTotalMib, appliedTs]);

  const kvSource: "measured" | "profile" | "geometry" | "none" =
    measuredKv && measuredKv.kvMib > 0
      ? "measured"
      : cold && cold.kv_mib > 0
        ? "profile"
        : kvPerBlock > 0
          ? "geometry"
          : "none";

  // `batch` is not an input: the FIT projection moves with ctx/ubatch, not batch.
  const fitKey = [
    modelPath,
    measuredKv ? 1 : 0,
    knobs?.ctxTokens,
    knobs?.kvQuant,
    knobs?.ubatch,
  ].join("|");
  useEffect(() => {
    if (!modelPath || measuredKv) {
      setFitProj(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void invoke<{ vram_mib: number; exact: boolean } | null>("get_fit_projection", {
        modelPath,
        ctx: knobs?.ctxTokens ?? 0,
        kvQuant: knobs?.kvQuant ?? "",
        batch: knobs?.batch ?? 0,
      })
        .then((hit) => {
          if (!cancelled) setFitProj(hit && hit.vram_mib > 0 ? { vramMib: hit.vram_mib, exact: hit.exact } : null);
        })
        .catch(() => {
          if (!cancelled) setFitProj(null);
        });
    }, 260);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  // Journal the plan whenever the configuration changes, so it can be compared against the
  // FIT estimate and the measured launch in `forecast-log.jsonl` (same file, same join).
  const planSigRef = useRef<string>("");
  useEffect(() => {
    if (!plan || !modelPath) return;
    const signature = [
      modelPath,
      knobs?.ctxTokens ?? 0,
      knobs?.kvQuant ?? "",
      knobs?.splitMode ?? "",
      kvSource,
      // The applied -ts moves the boundary, so it is part of the plan's identity.
      appliedTs?.join(",") ?? "",
    ].join("|");
    if (planSigRef.current === signature) return;
    planSigRef.current = signature;
    const overheadMib = plan.totalMib.map(
      (mib, i) => mib - (plan.weightsMib[i] ?? 0) - (plan.kvMib[i] ?? 0),
    );
    void invoke("record_plan_forecast", {
      row: {
        model_path: modelPath,
        ctx: knobs?.ctxTokens ?? null,
        kv_quant: knobs?.kvQuant ?? null,
        split: knobs?.splitMode ?? null,
        plan_total_mib: plan.sumMib,
        gpu_mib: plan.totalMib,
        weights_mib: plan.weightsMib,
        kv_mib: plan.kvMib,
        overhead_mib: overheadMib,
        budgets_mib: plan.budgetsMib,
        ts: plan.ts,
        boundary: plan.boundary,
        layers: plan.layerCount,
        kv_mib_per_layer: kvPerBlock,
        // "measured" = scaled from a real launch; "geometry" = header-only guess, which is
        // an upper bound because hybrid-attention models do not cache every block.
        kv_source: measuredKv ? "measured" : cold ? "profile" : kvPerBlock > 0 ? "geometry" : "none",
        // Diagnostics: which raw terms this plan used. The 400K case showed KV from the
        // launch row but only a third of its compute buffers, so the next reproduction has to
        // show the inputs, not just the result.
        measured_compute_mib: measuredKv?.computeMib ?? null,
        measured_model_mib: measuredKv?.modelMib ?? null,
        measured_rs_mib: measuredKv?.rsMib ?? null,
        cold_compute_mib: cold?.compute_mib ?? null,
        weight_scale: weightScale,
        fit_changed: measuredKv?.fitChanged ?? null,
        fit_projection_mib: fitProj?.vramMib ?? null,
      },
    }).catch(() => {
      // Journaling is diagnostic; never let it break the plan.
    });
  }, [plan, modelPath, knobs?.ctxTokens, knobs?.kvQuant, knobs?.splitMode, kvPerBlock, measuredKv, cold, kvSource]);
  return {
    plan,
    /** `-ts` the TAKEOVER/APPLY button should write for the byte-balanced boundary. */
    applyTs: plan?.applyTs ?? null,
    layerBytes,
    kvMibPerLayer: kvPerBlock,
    kvSource,
    squeezed: measuredKv?.fitChanged === true,
    fitProjectionMib: fitProj?.vramMib ?? null,
    fitProjectionExact: fitProj?.exact ?? false,
    loading,
  };
}
