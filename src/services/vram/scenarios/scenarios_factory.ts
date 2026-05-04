import type { GpuInfo, ModelMetadata, EngineConfig, Scenario, StyleObject, RunningEngine, GpuAllocation, VramManifest } from "../../../lib/types";

// ── Constants (derived from real launch data) ────────────────────────────────

export const CUDA_BASE_OVERHEAD_GB = 2.5;
export const COMPUTE_BUFFER_PRIMARY_RATIO = 0.20;
export const COMPUTE_BUFFER_SECONDARY_RATIO = 0.15;
export const RS_BUFFER_PER_GPU_GB = 0.3;
export const VISION_WORKSPACE_GB = 0.5;
export const GPU_FILL_TARGET = 0.95;
export const MOE_ATTENTION_RATIO = 0.18;
export const MOE_ROUTING_RATIO = 0.04;
export const MOE_NON_EXPERT_FFN_RATIO = 0.03;
export const CUDA_PARALLEL_OVERHEAD_PER_REQ_GB = 0.5;
export const CUDA_BATCH_OVERHEAD_FACTOR = 1.5 / 4096;
export const CUDA_CTX_OVERHEAD_FACTOR = 0.5 / 131072;

// ── Scenario-specific types (not shared with components) ────────────────────

export interface RunningSlotInfo {
  alias: string;
  modelShort: string;
  vramMib: number;
  gpuMask: string;
}

export interface ScenarioInput {
  modelMeta: ModelMetadata;
  engineConfig: EngineConfig;
  gpus: GpuInfo[];
  runningSlots: RunningSlotInfo[];
  ramAvailableGb: number;
  ramManufacturedGb: number;
  mmprojSizeMib?: number;
}

// ── Pure Helpers (no scenario logic) ────────────────────────────────────────

export function parseCtx(ctxSize: string): number {
  const map: Record<string, number> = {
    "4K": 4096, "8K": 8192, "16K": 16384, "32K": 32768,
    "64K": 65536, "128K": 131072, "256K": 262144,
  };
  const upper = ctxSize.toUpperCase();
  if (map[upper]) return map[upper];
  return parseInt(upper, 10) || 32768;
}

export function kvBytesForQuant(kvQuant: string): number {
  const key = kvQuant.toLowerCase();
  const kvMap: [string, number][] = [
    ["q4_0", 0.5], ["q4_k", 0.8], ["q8_0", 1.0],
    ["f16", 2.0], ["bf16", 2.0], ["f32", 4.0],
  ];
  for (const [k, v] of kvMap) {
    if (key.includes(k) || key.includes(k.replace("_", ""))) return v;
  }
  return 2.0; // default f16
}

export function gpuManufacturedMib(g: GpuInfo): number {
  return g.memory_total_manufactured > 0 ? g.memory_total_manufactured : g.memory_total;
}

export function getRunningEnginesOnGpu(gpuIdx: number, slots: RunningSlotInfo[]): RunningEngine[] {
  return slots.filter(s => s.gpuMask.split(",").some(p => p.trim() === String(gpuIdx)))
    .map(s => ({ slotAlias: s.alias, modelShort: s.modelShort, vramUsedMib: s.vramMib }));
}

export function gpuHasRunningEngines(gpuIdx: number, slots: RunningSlotInfo[]): boolean {
  return slots.some(s => s.gpuMask.split(",").some(p => p.trim() === String(gpuIdx)));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ── Pre-compute shared values for all scenarios ─────────────────────────────

export interface ComputedValues {
  weightsGb: number;
  kvCacheGb: number;
  overheadGb: number;
  visionGb: number;
  vramTotalGb: number;
  gpuAvailable: number[];
  singleMaxAvailable: number;
  multiTotalAvailable: number;
  targetGpuIdx: number;
  splitActive: boolean;
  numGpus: number;
}

export function computeValues(input: ScenarioInput): ComputedValues {
  const { modelMeta, engineConfig, gpus } = input;
  const weightsGb = modelMeta.file_size_bytes / (1024 ** 3);
  const isMoe = modelMeta.n_expert > 0;

  // GPU-bound weight fraction
  const gpuWeightFraction = (isMoe && engineConfig.offload_mode === "MOE_OPTIMAL")
    ? MOE_ATTENTION_RATIO + MOE_ROUTING_RATIO + MOE_NON_EXPERT_FFN_RATIO
    : 1.0;

  // ── Soft Cap: effective context length ────────────────────────────────
  const userCtx = parseCtx(engineConfig.ctx_size);
  const nCtxTrain = modelMeta.n_ctx_train || 4096;
  const ropeScale = engineConfig.rope_scale ?? 1.0;
  const ropeScaling = (engineConfig.rope_scaling || "none").toLowerCase();

  // If RoPE scaling active, trust user's CTX config; otherwise clamp to training limit
  const effectiveCtx = (ropeScale > 1.0 || ropeScaling !== "none")
    ? userCtx
    : Math.min(userCtx, nCtxTrain);

  // KV cache from GGUF metadata — uses effective context
  const headDim = modelMeta.n_head > 0 ? modelMeta.n_embd / modelMeta.n_head : 128;
  const kvBytesPerParam = kvBytesForQuant(engineConfig.kv_quant);
  const kvCacheGb = (modelMeta.n_layer > 0 && modelMeta.n_head_kv > 0)
    ? (2 * modelMeta.n_layer * modelMeta.n_head_kv * headDim * effectiveCtx * kvBytesPerParam) / (1024 ** 3)
    : 0;

  // ── CUDA overhead: Safety Floor + Dynamic Overhead ────────────────────
  const numGpus = gpus.length;
  const weightsOnGpuGb = weightsGb * gpuWeightFraction;
  const safetyFloorComputeBuffer = weightsOnGpuGb * (numGpus === 1
    ? COMPUTE_BUFFER_PRIMARY_RATIO
    : COMPUTE_BUFFER_PRIMARY_RATIO + (numGpus - 1) * COMPUTE_BUFFER_SECONDARY_RATIO);

  // Dynamic activation memory — kicks in when batch > 2048 or parallel > 1
  let dynamicOverhead = 0;
  if (engineConfig.batch > 2048 || engineConfig.parallel > 1) {
    dynamicOverhead = (engineConfig.batch * effectiveCtx * modelMeta.n_head * headDim * 2) / (1024 ** 2);

    // Flash attention reduces activation memory by ~15%
    if (engineConfig.flash_attn) {
      dynamicOverhead *= 0.85;
    }
    // MoE: only active experts compute → lower activation overhead
    if (isMoe && engineConfig.offload_mode !== "MOE_OPTIMAL") {
      dynamicOverhead *= 0.8;
    }
    // YaRN adds +5% overhead for attention scaling calculations
    if (ropeScaling === "yarn") {
      dynamicOverhead *= 1.05;
    }
  }

  const finalComputeBuffer = Math.max(safetyFloorComputeBuffer, dynamicOverhead);
  const parallelOverhead = Math.max(0, engineConfig.parallel - 1) * CUDA_PARALLEL_OVERHEAD_PER_REQ_GB;
  const ctxOverhead = effectiveCtx > 65536 ? (effectiveCtx - 65536) * CUDA_CTX_OVERHEAD_FACTOR : 0;
  const overheadGb = CUDA_BASE_OVERHEAD_GB * numGpus + finalComputeBuffer + RS_BUFFER_PER_GPU_GB * numGpus + parallelOverhead + ctxOverhead;

  // Vision addon
  const visionGb = engineConfig.vision !== "OFF"
    ? (input.mmprojSizeMib || 0) / 1024 + VISION_WORKSPACE_GB
    : 0;

  const vramTotalGb = weightsOnGpuGb + kvCacheGb + overheadGb + visionGb;

  // GPU availability
  const gpuAvailable = gpus.map(g => {
    const manufactured = gpuManufacturedMib(g) / 1024;
    const used = g.memory_used / 1024;
    return Math.max(0, manufactured - used);
  });

  const singleMaxAvailable = Math.max(...gpuAvailable, 0);
  const multiTotalAvailable = gpuAvailable.reduce((a, b) => a + b, 0);

  // Target GPU from config
  const deviceStr = engineConfig.device || "GPU-0";
  const targetGpuIdx = parseInt(deviceStr.replace("GPU-", "").split("/")[0], 10) || 0;

  // Split mode active?
  const splitActive = engineConfig.split_mode.length > 0 && engineConfig.split_mode.toUpperCase() !== "NONE";

  return {
    weightsGb, kvCacheGb, overheadGb, visionGb, vramTotalGb,
    gpuAvailable, singleMaxAvailable, multiTotalAvailable,
    targetGpuIdx, splitActive, numGpus,
  };
}

// ── Build Manifest (pure formatter) ────────────────────────────────────────

export function buildManifest(
  input: ScenarioInput,
  computed: ComputedValues,
  scenario: Scenario,
  style: StyleObject,
  weightsGb: number,
  kvGb: number,
  overheadGb: number,
  ramWeightsGb: number,
  ramKvGb: number,
  ramSpillGb: number,
  fits: boolean,
  recommendation: string,
  gpuLayers: number,
  ramLayers: number,
  perGpuLoad: number[],
): VramManifest {
  const vramTotal = weightsGb + kvGb + overheadGb;
  const ramTotal = ramWeightsGb + ramKvGb + ramSpillGb;

  const gpuAllocations: GpuAllocation[] = input.gpus.map((g, i) => ({
    gpuIndex: g.index,
    name: g.name,
    vramManufacturedGb: round2(gpuManufacturedMib(g) / 1024),
    vramAvailableGb: round2(Math.max(0, gpuManufacturedMib(g) / 1024 - g.memory_used / 1024)),
    projectedLoadGb: round2(perGpuLoad[i] ?? 0),
    runningEngines: getRunningEnginesOnGpu(g.index, input.runningSlots),
  }));

  return {
    scenario,
    style,
    vramWeightsGb: round2(weightsGb),
    vramKvGb: round2(kvGb),
    vramOverheadGb: round2(overheadGb),
    vramTotalGb: round2(vramTotal),
    ramWeightsGb: round2(ramWeightsGb),
    ramKvGb: round2(ramKvGb),
    ramSpillGb: round2(ramSpillGb),
    ramTotalGb: round2(ramTotal),
    ramManufacturedGb: input.ramManufacturedGb,
    ramAvailableGb: input.ramAvailableGb,
    gpuAllocations,
    fits,
    recommendation,
    gpuLayers,
    ramLayers,
  };
}

// ── Orchestrator (strict sequential dispatch) ───────────────────────────────

import { tryEvaluate as soloCleanFit } from "./solo_clean_fit";
import { tryEvaluate as soloBusyFit } from "./solo_busy_fit";
import { tryEvaluate as multiPerfect } from "./multi_perfect";
import { tryEvaluate as multiPressure } from "./multi_pressure";
import { tryEvaluate as soloSpill } from "./solo_spill";
import { tryEvaluate as totalSpill } from "./total_spill";
import { evaluate as hwLocked } from "./hw_locked";

export function evaluate(input: ScenarioInput): VramManifest {
  const computed = computeValues(input);

  // Zero GPUs → immediate HW_LOCKED
  if (computed.numGpus === 0) {
    return hwLocked(input, computed, "No GPUs detected");
  }

  // Strict sequential dispatch — first match wins, null moves to next instantly
  const result =
    soloCleanFit(input, computed) ||
    soloBusyFit(input, computed) ||
    multiPerfect(input, computed) ||
    multiPressure(input, computed) ||
    soloSpill(input, computed) ||
    totalSpill(input, computed);

  if (result) return result;

  // Fallback — always returns a manifest
  return hwLocked(input, computed, `Model requires ${computed.vramTotalGb.toFixed(1)} GB VRAM + RAM, system has ${(computed.multiTotalAvailable + input.ramAvailableGb).toFixed(1)} GB combined`);
}
