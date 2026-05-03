/**
 * VRAM Calculator Hook — Dirty Math + Fit Check Calibration
 *
 * Layer 1 (instant):   Dirty math formula for instant feedback
 * Layer 2 (precise):   llama-fit-params.exe deep scan with user's exact params
 */

import { useState, useCallback, useMemo, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ModelEntry, GpuInfo, FitScanResult, SystemInfo } from "../lib/types";

export type VramStatus = 'safe' | 'optimized' | 'pressure' | 'danger' | 'critical';

interface DirtyMathResult {
  status: VramStatus;
  vramNeededMib: number;
  action: string;
  headroomMib: number;
}

interface DeepScanResult extends FitScanResult {
  headroomMib: number;
}

export interface GpuDistribution {
  gpuIndex: number;
  name: string;
  totalMib: number;
  usedMib: number;        // Current telemetry usage (background)
  projectedMib: number;   // Our model's projected VRAM on this GPU
  percentage: number;     // projected/total * 100
  totalManufacturedMib: number;  // manufactured capacity for display
}

export interface RamEstimate {
  totalMib: number;              // Real OS-reported RAM in MiB (used for calculations)
  availableMib: number;          // Currently free
  spillMib: number;              // Model data that would go to RAM (when doesn't fit GPU)
  percentage: number;            // spill/total * 100
  totalManufacturedMib: number;  // Rounded manufactured capacity for display (e.g., 256 GB)
}

export interface AutoOffloadResult {
  /** Number of layers to put on GPU ("all" or numeric string like "48") */
  nGpuLayers: string;
  /** Layers that will be offloaded to RAM */
  ramLayers: number;
  /** Weight memory in MiB that fits on GPU */
  gpuWeightMib: number;
  /** Weight memory in MiB that spills to RAM */
  ramSpillMib: number;
  /** Total layers in the model */
  totalLayers: number;
  /** Whether RAM can accommodate the spill (true = launchable) */
  fitsRam: boolean;
}

const CUDA_FIXED_OVERHEAD_MIB = 2048; // ~2GB fixed CUDA context/kernel overhead

// GQA KV cache coefficients from user guide (MiB per 1B params per 1K tokens)
const KV_COEFF_GQA: Record<string, number> = {
  f16: 0.65, bf16: 0.65, q8_0: 0.33, q4_0: 0.17, iq4_nl: 0.17, q4_k_m: 0.17,
};

// Exact KV cache bytes per param by quantization level
const BYTES_PER_PARAM: Record<string, number> = {
  f16: 2.0, bf16: 2.0, q8_0: 1.0, q5_0: 0.625, q4_0: 0.5, iq4_nl: 0.5, q3_k: 0.375, q2_k: 0.25,
};

function parseCtx(ctxStr: string): number {
  const ctxMap: Record<string, number> = {
    "4K": 4096, "8K": 8192, "16K": 16384, "32K": 32768,
    "64K": 65536, "128K": 131072, "256K": 262144,
    "512K": 524288, "1M": 1048576,
  };
  return ctxMap[ctxStr] || parseInt(ctxStr) || 32768;
}

// Get GQA coefficient for approximate KV cache (MiB per 1B params per 1K tokens)
function getKvCoefficient(kvQuant: string): number {
  const q = kvQuant.toLowerCase();
  if (KV_COEFF_GQA[q]) return KV_COEFF_GQA[q];
  for (const [key, val] of Object.entries(KV_COEFF_GQA)) {
    if (q.includes(key.split('_')[0])) return val;
  }
  return KV_COEFF_GQA.q4_0; // Default to Q4 coefficient
}

// Get bytes per param for exact KV calculation
function getBytesPerParam(kvQuant: string): number {
  const q = kvQuant.toLowerCase();
  if (BYTES_PER_PARAM[q]) return BYTES_PER_PARAM[q];
  for (const [key, val] of Object.entries(BYTES_PER_PARAM)) {
    if (q.includes(key.split('_')[0])) return val;
  }
  return 0.5; // Default Q4
}

// Estimate model param count from file size and quant level
function estimateParamsBillion(modelSizeMib: number, kvQuant: string): number {
  const q = kvQuant.toLowerCase();
  let bytesPerParam: number;
  
  if (q === "f16" || q === "bf16") bytesPerParam = 2.0;
  else if (q.includes("q8")) bytesPerParam = 1.4;
  else if (q.includes("q6")) bytesPerParam = 1.1;
  else if (q.includes("q5")) bytesPerParam = 0.9;
  else if (q.includes("q4") || q.includes("iq4")) bytesPerParam = 0.7;
  else if (q.includes("q3")) bytesPerParam = 0.56;
  else if (q.includes("q2")) bytesPerParam = 0.4;
  else bytesPerParam = 0.7;
  
  return modelSizeMib / (bytesPerParam * 1024);
}

// EXACT KV cache calculation from GGUF metadata (when available)
function exactKvCacheMib(
  totalLayers: number,
  kvHeads: number,
  headDim: number,
  ctxTokens: number,
  kvQuant: string
): number {
  const bytesPerParam = getBytesPerParam(kvQuant);
  // VRAM_KV = 2 × layers × kv_heads × head_dim × ctx_tokens × bytesPerParam / (1024²)
  return (2 * totalLayers * kvHeads * headDim * ctxTokens * bytesPerParam) / (1024 * 1024);
}

// Calculate parallel memory multiplier based on unified KV setting
function getParallelMultiplier(parallel: number, unifiedKv: boolean): number {
  if (parallel <= 1) return 1.0;
  
  if (unifiedKv) {
    // Unified KV: all instances share the same KV cache, minimal overhead
    return 1.05 + (parallel - 1) * 0.02;
  } else {
    // Each parallel instance maintains its own full KV copy
    return parallel;
  }
}

function dirtyMathVram(
  modelSizeMib: number,
  ctxTokens: number,
  kvQuant: string = "f16",
  splitMode: string = "NONE",
  parallel: number = 1,
  unifiedKv: boolean = true,
  mmprojSizeMib: number = 0,
  // Exact metadata (when available from GGUF reader)
  totalLayers?: number,
  kvHeads?: number,
  headDim?: number
): number {
  // File size IS the quantized weight memory on disk - use as-is!
  const staticVram = modelSizeMib + CUDA_FIXED_OVERHEAD_MIB;
  
  let kvOverheadMib: number;
  
  if (totalLayers && kvHeads && headDim) {
    // EXACT calculation from GGUF metadata
    kvOverheadMib = exactKvCacheMib(totalLayers, kvHeads, headDim, ctxTokens, kvQuant);
  } else {
    // APPROXIMATE using GQA coefficients (MiB per 1B params per 1K tokens)
    const kvCoeff = getKvCoefficient(kvQuant);
    const paramsB = estimateParamsBillion(modelSizeMib, kvQuant);
    const ctxK = ctxTokens / 1000;
    kvOverheadMib = paramsB * ctxK * kvCoeff;
  }
  
  let baseVram = staticVram + kvOverheadMib;
  
  // Add mmproj size if vision model detected
  if (mmprojSizeMib > 0) {
    baseVram += mmprojSizeMib;
  }
  
  // Apply parallel multiplier: unified KV has shared cache, non-unified multiplies by count
  const parallelMult = getParallelMultiplier(parallel, unifiedKv);
  baseVram *= parallelMult;
  
  return Math.ceil(baseVram);
}

function determineStatus(
  vramNeeded: number,
  gpus: GpuInfo[],
  totalAvailableVramMib: number
): DirtyMathResult {
  const multiGpuVram = gpus.reduce((sum, g) => sum + g.memory_total, 0);
  
  // Single GPU fits
  if (vramNeeded <= totalAvailableVramMib) {
    return {
      status: 'safe',
      vramNeededMib: vramNeeded,
      action: 'Pure GPU Launch Ready',
      headroomMib: Math.max(0, totalAvailableVramMib - vramNeeded),
    };
  }
  
  // Multi-GPU split possible
  if (gpus.length > 1 && vramNeeded <= multiGpuVram * 0.95) {
    return {
      status: 'optimized',
      vramNeededMib: vramNeeded,
      action: 'Enable Split Mode for Multi-GPU Launch',
      headroomMib: Math.max(0, (multiGpuVram * 0.95) - vramNeeded),
    };
  }
  
  // Would OOM without offload
  if (vramNeeded <= totalAvailableVramMib + (512 * 1024)) {
    return {
      status: 'danger',
      vramNeededMib: vramNeeded,
      action: 'RAM Offload Required — Will Be Slower',
      headroomMib: Math.min(0, totalAvailableVramMib - vramNeeded),
    };
  }
  
  // Cannot fit
  return {
    status: 'critical',
    vramNeededMib: vramNeeded,
    action: 'Insufficient Memory — Cannot Launch This Model',
    headroomMib: Math.min(0, totalAvailableVramMib - vramNeeded),
  };
}

interface UseVramCalculatorOptions {
  model: ModelEntry | null;
  config: Record<string, any>;
  gpus: GpuInfo[];
  availableMib: number; // GPU VRAM minus OS overhead and committed engines
  systemInfo?: SystemInfo | null;
}

/** Calculate optimal GPU layer offload from GGUF metadata. */
export function calculateAutoOffload({
  modelSizeMib,
  totalLayers,
  kvCacheMib,
  fixedOverheadMib,
  totalVramMib,
  availableRamMib,
}: {
  modelSizeMib: number;
  totalLayers: number;
  kvCacheMib: number;
  fixedOverheadMib: number;
  totalVramMib: number;
  availableRamMib: number;
}): AutoOffloadResult | null {
  if (totalLayers <= 0) return null;

  const perLayerMib = modelSizeMib / totalLayers;
  const availableForWeights = totalVramMib - kvCacheMib - fixedOverheadMib;

  // Model fits entirely on GPU — no offload needed
  if (modelSizeMib <= availableForWeights) {
    return {
      nGpuLayers: "all",
      ramLayers: 0,
      gpuWeightMib: modelSizeMib,
      ramSpillMib: 0,
      totalLayers,
      fitsRam: true,
    };
  }

  // Calculate how many layers fit on GPU
  const maxFitLayers = Math.max(1, Math.floor(availableForWeights / perLayerMib));
  const gpuWeightMib = maxFitLayers * perLayerMib;
  const ramSpillMib = (totalLayers - maxFitLayers) * perLayerMib;

  return {
    nGpuLayers: String(maxFitLayers),
    ramLayers: totalLayers - maxFitLayers,
    gpuWeightMib,
    ramSpillMib,
    totalLayers,
    fitsRam: ramSpillMib <= availableRamMib,
  };
}

function isVramMatch(scanVram: number, estimateVram: number): boolean {
  if (scanVram <= 0 || estimateVram <= 0) return false;
  const diff = Math.abs(scanVram - estimateVram);
  const tolerance = Math.max(estimateVram * 0.05, 100); // 5% or 100 MiB
  return diff <= tolerance;
}

export function useVramCalculator({
  model,
  config,
  gpus,
  availableMib,
  systemInfo,
}: UseVramCalculatorOptions) {
  const [scanResult, setScanResult] = useState<DeepScanResult | null>(null);
  const [isScanning, setIsScanning] = useState(false);

  // Reset scan result when model changes — old FIT CHECK is invalid for a different model
  useEffect(() => {
    setScanResult(null);
  }, [model?.path]);

  // ── Layer 1: Dirty Math (instant, no IPC) ───────────────────────────────
  const dirtyResult = useMemo((): DirtyMathResult | null => {
    if (!model || !availableMib) return null;

    const ctxTokens = parseCtx(config.CTX || "32K");
    const kvQuant = config["KV-Quant"] || "f16";
    const splitMode = config.Split || "NONE";
    const parallel = Math.max(1, parseInt(String(config.Parallel)) || 1);
    const unifiedKv = config["Unified-KV"] !== false; // Default true
    const mmprojSizeMib = model?.mmproj_size_mib ?? 0;
    
    // Extract model size from size_str (e.g., "7.2 GB" -> ~7200 MiB)
    let modelSizeMib: number;
    const match = model.size_str?.match(/([\d.]+)\s*GB/i);
    if (match) {
      modelSizeMib = parseFloat(match[1]) * 1024;
    } else {
      modelSizeMib = estimateModelSizeFromQuant(model.name, model.quant);
    }

    const vramNeeded = dirtyMathVram(
      modelSizeMib, ctxTokens, kvQuant, splitMode, parallel, unifiedKv, mmprojSizeMib
    );
    
    return determineStatus(vramNeeded, gpus, availableMib);
  }, [model?.path, config.CTX, config["KV-Quant"], config.Split, config.Parallel,
      config["Unified-KV"], model?.mmproj_size_mib ?? null, gpus.length]);

  // ── Auto-offload: calculate optimal GPU layers from metadata ────────────
  const autoOffload = useMemo((): AutoOffloadResult | null => {
    if (!model || !dirtyResult) return null;

    const meta = model.metadata;
    if (!meta || meta.n_layer <= 0) return null; // No metadata — can't calculate per-layer cost

    const ctxTokens = parseCtx(config.CTX || "32K");
    const kvQuant = config["KV-Quant"] || "f16";
    const mmprojSizeMib = model?.mmproj_size_mib ?? 0;

    // Model size from metadata file_size_bytes (most accurate), fallback to size_str
    let modelSizeMib: number;
    if (meta.file_size_bytes > 0) {
      modelSizeMib = meta.file_size_bytes / (1024 * 1024);
    } else {
      const match = model.size_str?.match(/([\d.]+)\s*GB/i);
      modelSizeMib = match ? parseFloat(match[1]) * 1024 : estimateModelSizeFromQuant(model.name, model.quant);
    }

    // KV cache cost (exact from metadata)
    const headDim = meta.n_embd / meta.n_head;
    const kvCacheMib = exactKvCacheMib(meta.n_layer, meta.n_head_kv, headDim, ctxTokens, kvQuant);

    // Fixed overhead: 2GB per GPU + mmproj
    const fixedOverheadMib = (gpus.length * CUDA_FIXED_OVERHEAD_MIB) + mmprojSizeMib;

    // Total VRAM across all GPUs (for calculation, use real total not manufactured)
    const totalVramMib = gpus.reduce((sum, g) => sum + g.memory_total, 0);

    // Available system RAM for spill
    const availableRamMib = systemInfo?.available_memory_mib ?? 0;

    return calculateAutoOffload({
      modelSizeMib,
      totalLayers: meta.n_layer,
      kvCacheMib,
      fixedOverheadMib,
      totalVramMib,
      availableRamMib,
    });
  }, [model?.path, dirtyResult, config.CTX, config["KV-Quant"], gpus.length, systemInfo]);

  // ── Final VRAM value: scan result overrides dirty math ────────────────
  const finalVramMib = useMemo((): number | null => {
    if (!dirtyResult) return null;
    if (scanResult && scanResult.vram_mib > 0) {
      return Math.round(scanResult.vram_mib);
    }
    return dirtyResult.vramNeededMib;
  }, [dirtyResult?.vramNeededMib, scanResult?.vram_mib]);

  // ── GPU Distribution: split VRAM across GPUs based on topology ───────────
  const gpuDistribution = useMemo((): GpuDistribution[] => {
    if (finalVramMib == null || gpus.length === 0) return [];

    // When auto-offload is active, only GPU-bound weights go on GPU
    const totalNeeded = autoOffload?.ramLayers > 0 ? autoOffload.gpuWeightMib : finalVramMib;
    const splitActive = config.Split && config.Split.toUpperCase() !== "NONE";
    
    // Single GPU or split OFF: show only GPU 0 with full load
    if (!splitActive || gpus.length === 1) {
      return [{
        gpuIndex: gpus[0].index,
        name: gpus[0].name,
        totalMib: gpus[0].memory_total,
        usedMib: gpus[0].memory_used,
        projectedMib: totalNeeded,
        percentage: (totalNeeded / gpus[0].memory_total) * 100,
        totalManufacturedMib: gpus[0].memory_total_manufactured || gpus[0].memory_total,
      }];
    }
    
    // Split ON with multiple GPUs: proportional distribution by available VRAM
    const totalAvailable = gpus.reduce((sum, g) => sum + g.memory_free, 0);
    
    return gpus.map(gpu => {
      const ratio = gpu.memory_free / totalAvailable;
      const projectedMib = Math.ceil(totalNeeded * ratio);
      
      return {
        gpuIndex: gpu.index,
        name: gpu.name,
        totalMib: gpu.memory_total,
        usedMib: gpu.memory_used,
        projectedMib,
        percentage: (projectedMib / gpu.memory_total) * 100,
        totalManufacturedMib: gpu.memory_total_manufactured || gpu.memory_total,
      };
    });
  }, [autoOffload?.gpuWeightMib, finalVramMib, gpus, config.Split]);

  // ── RAM Estimate: spill amount when model doesn't fit GPU(s) ─────────────
  const ramEstimate = useMemo((): RamEstimate | null => {
    if (!systemInfo || finalVramMib == null) return null;

    // Use auto-offload spill calculation when available (accurate per-layer math)
    const spillMib = autoOffload?.ramLayers > 0
      ? autoOffload.ramSpillMib
      : Math.max(0, finalVramMib - gpus.reduce((sum, g) => sum + g.memory_total, 0));

    return {
      totalMib: systemInfo.total_memory_mib,
      availableMib: systemInfo.available_memory_mib,
      spillMib,
      percentage: (spillMib / systemInfo.total_memory_mib) * 100,
      totalManufacturedMib: systemInfo.total_memory_manufactured_mib,
    };
  }, [systemInfo, finalVramMib, gpus, autoOffload]);

  // ── Layer 2: Deep Scan (user-triggered fit check) ───────────────────────
  const triggerFitCheck = useCallback(async () => {
    if (!model) return null;

    setIsScanning(true);
    
    try {
      console.log("[VramCalc] Starting fit scan for:", model.path);
      
      const result = await invoke<FitScanResult>("fit_scan_model", {
        modelPath: model.path,
        providerId: config.providerId || "ggml-stable",
        ctxSize: config.CTX || "32K",
        kvQuant: config["KV-Quant"] || "f16",
        device: config.Device || "GPU-0",
        splitMode: config.Split || "NONE",
      });

      console.log("[VramCalc] Fit scan result:", JSON.stringify({
        vramMib: result.vram_mib, fits: result.fits, ctx: result.ctx
      }));

      const headroomMib = availableMib - Math.round(result.vram_mib);
      
      setScanResult({ ...result, headroomMib });
      
      return result;
    } catch (err) {
      console.error("[VramCalc] Fit scan failed:", err);
      throw err;
    } finally {
      setIsScanning(false);
    }
  }, [model?.path, config.providerId || "ggml-stable", config.CTX, 
      config["KV-Quant"], config.Device, config.Split, availableMib]);

  // ── Combined VRAM display value ───────────────────────────────────────
  const vramDisplay = useMemo(() => {
    if (finalVramMib == null) return null;

    let displayVramMib = finalVramMib;
    const isCalibrated = !!(scanResult && scanResult.vram_mib > 0);

    // When auto-offload says only X layers fit on GPU, show the actual GPU-bound VRAM
    if (autoOffload && autoOffload.ramLayers > 0) {
      displayVramMib = autoOffload.gpuWeightMib;
    }

    console.log("[VramCalc] Display:", JSON.stringify({
      estimate: dirtyResult?.vramNeededMib, scan: scanResult?.vram_mib, final: finalVramMib, display: displayVramMib, calibrated: isCalibrated
    }));

    // Recalculate status with the actual GPU-bound VRAM (lower when offload is active)
    const updatedStatus = determineStatus(displayVramMib, gpus, availableMib);

    return {
      ...updatedStatus,
      vramNeededMib: displayVramMib,
      isCalibrated,
      hasAnchors: false,
    };
  }, [finalVramMib, scanResult?.vram_mib, gpus, availableMib, autoOffload]);

  return {
    dirtyResult,
    vramDisplay,
    gpuDistribution,
    ramEstimate,
    autoOffload,
    triggerFitCheck,
    isScanning,
    scanResult,
  };
}

function estimateModelSizeFromQuant(modelName: string, quant: string): number {
  let paramsB = 7; // default fallback
  
  if (modelName.match(/405[bm]/i)) paramsB = 405;
  else if (modelName.match(/70[bm]/i) || modelName.match(/72[bm]/i)) paramsB = 70;
  else if (modelName.match(/34[bm]/i) || modelName.match(/32[bm]/i)) paramsB = 34;
  else if (modelName.match(/13[bm]/i) || modelName.match(/14[bm]/i)) paramsB = 13;
  else if (modelName.match(/8[bm]/i)) paramsB = 8;
  else if (modelName.match(/7[bm]/i)) paramsB = 7;
  else if (modelName.match(/3[bm]/i) || modelName.match(/2[bm]/i)) paramsB = 3;

  const q = quant.toLowerCase();
  let factor: number;
  
  if (q.includes("f16") || q.includes("bf16")) factor = 1.0;
  else if (q.includes("q8")) factor = 0.7;
  else if (q.includes("q6")) factor = 0.55;
  else if (q.includes("q5")) factor = 0.45;
  else if (q.includes("q4") || q.includes("iq4")) factor = 0.35;
  else if (q.includes("q3")) factor = 0.25;
  else if (q.includes("q2")) factor = 0.18;
  else factor = 0.35;

  return Math.ceil(paramsB * factor * 1024); // in MiB
}
