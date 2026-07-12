import type { GpuInfo, ModelMetadata, EngineConfig, Scenario, StyleObject, RunningEngine, GpuAllocation, VramManifest, MoeSuggestion } from "../../../lib/types";
import { attachMemorySource } from "../memorySource";

// ── Constants (derived from real launch data) ────────────────────────────────

export const RS_BUFFER_PER_GPU_GB = 0.1; // Reduced from 0.3 to match actual llama.cpp memory usage
export const CUDA_CTX_OVERHEAD_FACTOR = 0.5 / 131072;

// ── FIT scan data types ─────────────────────────────────────────────────────

export interface FitPoint {
  label: string;
  ctx: number;
  kv_quant: string;
  batch: number;
  parallel: number;
  split_mode: string;
  vram_mib: number;
}

// ── Scenario-specific types (not shared with components) ────────────────────

export interface RunningSlotInfo {
  alias: string;
  modelShort: string;
  vramMib: number;
  gpuMask: string;
  /** Per-GPU SELF MiB from memory breakdown — maps to gpuMask order when present. */
  gpuBreakdownMib?: number[];
}

/** Slots that hold or are acquiring VRAM — include LOADING so forecast reserves early. */
export function isVramCommittedSlot(status: string): boolean {
  return status === "RUNNING" || status === "LOADING";
}

function modelShortFromStackEntry(s: { model_name: string; model_path?: string }): string {
  return (s.model_name && s.model_name !== s.model_path)
    ? s.model_name.slice(0, 30)
    : s.model_path?.split(/[\/\\]/).pop()?.slice(0, 30)
      || s.model_name.slice(0, 30);
}

/** RUNNING + LOADING stack entries for availability / hatched reserved bars. */
export function committedSlotsFromStack(
  stack: Array<{
    status: string;
    alias: string;
    model_name: string;
    model_path?: string;
    vram_mib?: number;
    gpu: string;
    gpu_breakdown_mib?: number[];
  }>,
): RunningSlotInfo[] {
  return stack
    .filter((s) => isVramCommittedSlot(s.status))
    .map((s) => ({
      alias: s.alias,
      modelShort: modelShortFromStackEntry(s),
      vramMib: s.vram_mib || 0,
      gpuMask: s.gpu,
      gpuBreakdownMib: s.gpu_breakdown_mib,
    }));
}

export function committedStackKey(
  stack: Array<{ status: string; alias: string; vram_mib?: number; gpu_breakdown_mib?: number[] }>,
): string {
  return stack
    .filter((s) => isVramCommittedSlot(s.status))
    .map((s) => `${s.alias}-${s.vram_mib || 0}-${(s.gpu_breakdown_mib ?? []).join("+")}`)
    .join("|");
}

export interface ScenarioInput {
  modelMeta: ModelMetadata;
  engineConfig: EngineConfig;
  gpus: GpuInfo[];
  runningSlots: RunningSlotInfo[];
  ramAvailableGb: number;
  ramManufacturedGb: number;
  mmprojSizeMib?: number;
  fitPoints?: FitPoint[];
  /** True when launch uses provider --fit on (all FIT-capable providers). */
  autoVramLaunch?: boolean;
  /** FULL AUTO vs ASSISTED — drives forecast hero + chrome policy. */
  fullAutoMode?: boolean;
  fitStyle?: string;
  /** Post-launch measured VRAM from learned-vram.json (MiB). */
  learnedVramMib?: number;
  /** Host RAM from learned breakdown (MiB) — buffers + any tensor offload. */
  learnedHostMib?: number;
  /** Per-GPU SELF MiB from learned breakdown. */
  learnedGpuBreakdownMib?: number[];
  /** Per-GPU model/ctx/compute from launch buffer inventory. */
  learnedGpuComponentsMib?: Array<{ model_mib: number; ctx_mib: number; compute_mib: number }>;
  /** Reference profile tag from launch parser (e.g. QWEN3.6-27B MTP). */
  learnedLaunchProfile?: string;
  /** ISO timestamp from learned-vram.json for SOURCE provenance. */
  learnedMeasuredAt?: string;
  /** Active FIT probe session — authoritative until config changes. */
  fitProbeVramMib?: number;
  fitProbeHostMib?: number;
  fitProbeGpuBreakdownMib?: number[];
}

// ── Pure Helpers (no scenario logic) ────────────────────────────────────────

export function parseCtx(ctxSize: string | number): number {
  if (typeof ctxSize === 'number') return ctxSize;
  const str = String(ctxSize).trim().toLowerCase();
  // Handle legacy "k" suffix format
  if (str.endsWith('k')) {
    const num = parseInt(str.slice(0, -1), 10);
    return num > 0 ? num * 1024 : 32768;
  }
  if (str.endsWith('m')) {
    const num = parseInt(str.slice(0, -1), 10);
    return num > 0 ? num * 1024 * 1024 : 32768;
  }
  const parsed = parseInt(str, 10);
  return parsed > 0 ? parsed : 32768;
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
    .map(s => {
      const maskParts = s.gpuMask.split(",").map((p) => p.trim());
      const gpuCount = maskParts.length;
      const idxInMask = maskParts.findIndex((p) => p === String(gpuIdx));
      const perGpuShare = s.vramMib / gpuCount;
      const perGpuBreakdown =
        s.gpuBreakdownMib && idxInMask >= 0 && idxInMask < s.gpuBreakdownMib.length
          ? s.gpuBreakdownMib[idxInMask]
          : 0;
      // Prefer the higher of per-GPU SELF breakdown vs even split of slot total —
      // breakdown can lag (early table) while vram_mib was updated, or vice versa.
      const vramUsedMib = Math.max(perGpuShare, perGpuBreakdown);
      return { slotAlias: s.alias, modelShort: s.modelShort, vramUsedMib };
    });
}

export function gpuHasRunningEngines(gpuIdx: number, slots: RunningSlotInfo[]): boolean {
  return slots.some(s => s.gpuMask.split(",").some(p => p.trim() === String(gpuIdx)));
}

/**
 * VRAM bar split for GpuTopology — breakdown SELF is model+ctx+compute when memory table parsed.
 * When breakdown lags NVML (large KV, no table yet), attribute the gap to our engines and
 * cap External at 4 GiB/GPU. When breakdown is current, cap engine CUDA/runtime overhead instead
 * so foreign apps (LM Studio, etc.) stay in External.
 */
export const CUDA_RUNTIME_OVERHEAD_CAP_MIB = 4096;
/** Baseline at/above this = foreign app (LM Studio, etc.) present before our launch. */
const FOREIGN_BASELINE_THRESHOLD_MIB = 1024;
/** CUDA0 driver context — applied when NVML baseline under-captured (<512 MiB). */
const CUDA0_SYSTEM_RESERVE_FLOOR_MIB = 640;

function effectiveSessionBaselineMib(idleBaselineMib: number, gpuIndex?: number): number {
  if (idleBaselineMib >= 512) return idleBaselineMib;
  if (gpuIndex === 0 && idleBaselineMib < 512) {
    return Math.max(idleBaselineMib, CUDA0_SYSTEM_RESERVE_FLOOR_MIB);
  }
  return idleBaselineMib;
}

function splitExternalMib(
  osOtherMib: number,
  sessionBaselineMib: number,
): { systemReservedMib: number; foreignAppsMib: number } {
  if (sessionBaselineMib >= FOREIGN_BASELINE_THRESHOLD_MIB) {
    return {
      systemReservedMib: 0,
      foreignAppsMib: Math.max(0, osOtherMib),
    };
  }
  const systemReservedMib = Math.min(sessionBaselineMib, osOtherMib);
  return {
    systemReservedMib,
    foreignAppsMib: Math.max(0, osOtherMib - systemReservedMib),
  };
}

export function splitGpuTopoBarUsage(
  usedMib: number,
  breakdownMib: number,
  hasOurEngines: boolean,
  idleBaselineMib = 0,
  gpuIndex?: number,
): {
  engineBarMib: number;
  osOtherMib: number;
  attributedOverheadMib: number;
  breakdownUnderReports: boolean;
  systemReservedMib: number;
  foreignAppsMib: number;
} {
  const sessionBaselineMib = Math.max(
    0,
    Math.min(effectiveSessionBaselineMib(idleBaselineMib, gpuIndex), usedMib),
  );

  if (!hasOurEngines) {
    const osOtherMib = Math.max(0, usedMib - breakdownMib);
    const { systemReservedMib, foreignAppsMib } = splitExternalMib(osOtherMib, sessionBaselineMib);
    return {
      engineBarMib: breakdownMib,
      osOtherMib,
      attributedOverheadMib: 0,
      breakdownUnderReports: false,
      systemReservedMib,
      foreignAppsMib,
    };
  }

  const aboveSessionMib = Math.max(0, usedMib - sessionBaselineMib);
  const deltaMib = Math.max(0, aboveSessionMib - breakdownMib);
  const driverSlackMaxMib = CUDA_RUNTIME_OVERHEAD_CAP_MIB * 2;
  const foreignPreloaded = sessionBaselineMib >= FOREIGN_BASELINE_THRESHOLD_MIB;

  // NVML ≫ tracked SELF — typical when only weights/file-size estimate is known (512K KV not in table).
  const breakdownUnderReports =
    !foreignPreloaded
    && deltaMib > CUDA_RUNTIME_OVERHEAD_CAP_MIB
    && breakdownMib < aboveSessionMib * 0.5;

  if (breakdownUnderReports) {
    const foreignAboveEngineMib = Math.min(deltaMib, CUDA_RUNTIME_OVERHEAD_CAP_MIB);
    const osOtherMib = sessionBaselineMib + foreignAboveEngineMib;
    const engineBarMib = usedMib - osOtherMib;
    const attributedOverheadMib = Math.max(0, engineBarMib - breakdownMib);
    const { systemReservedMib, foreignAppsMib } = splitExternalMib(osOtherMib, sessionBaselineMib);
    return {
      engineBarMib,
      osOtherMib,
      attributedOverheadMib,
      breakdownUnderReports: true,
      systemReservedMib,
      foreignAppsMib: foreignPreloaded ? osOtherMib : foreignAppsMib,
    };
  }

  // LM Studio (etc.) was already resident — hold session baseline, attribute NVML gap above SELF to our engine.
  if (foreignPreloaded) {
    const slackMib = Math.min(deltaMib, driverSlackMaxMib);
    const engineBarMib = Math.min(aboveSessionMib, breakdownMib + slackMib);
    const osOtherMib = Math.max(sessionBaselineMib, usedMib - engineBarMib);
    const attributedOverheadMib = Math.max(0, engineBarMib - breakdownMib);
    return {
      engineBarMib,
      osOtherMib,
      attributedOverheadMib,
      breakdownUnderReports: false,
      systemReservedMib: 0,
      foreignAppsMib: osOtherMib,
    };
  }

  // Clean GPU — sched_reserve / driver buffers above SELF are still our engine.
  const breakdownLooksComplete = breakdownMib >= aboveSessionMib * 0.65;
  if (breakdownLooksComplete && deltaMib > 0 && deltaMib <= driverSlackMaxMib) {
    const osOtherMib = sessionBaselineMib;
    const engineBarMib = usedMib - osOtherMib;
    const attributedOverheadMib = Math.max(0, engineBarMib - breakdownMib);
    return {
      engineBarMib,
      osOtherMib,
      attributedOverheadMib,
      breakdownUnderReports: false,
      systemReservedMib: sessionBaselineMib,
      foreignAppsMib: 0,
    };
  }

  const attributedOverheadMib = Math.min(deltaMib, CUDA_RUNTIME_OVERHEAD_CAP_MIB);
  const engineBarMib = breakdownMib + attributedOverheadMib;
  const osOtherMib = Math.max(sessionBaselineMib, usedMib - engineBarMib);
  const { systemReservedMib, foreignAppsMib } = splitExternalMib(osOtherMib, sessionBaselineMib);
  return {
    engineBarMib,
    osOtherMib,
    attributedOverheadMib,
    breakdownUnderReports: false,
    systemReservedMib,
    foreignAppsMib,
  };
}

/** Per-GPU free VRAM (GB) — single source of truth for scenarios + auto VRAM launch. */
export function computeGpuAvailableList(
  gpus: GpuInfo[],
  runningSlots: RunningSlotInfo[],
): number[] {
  return gpus.map((g) => {
    const manufactured = gpuManufacturedMib(g) / 1024;
    const nvmlUsed = g.memory_used / 1024;
    const stackUsed = getRunningEnginesOnGpu(g.index, runningSlots)
      .reduce((sum, e) => sum + e.vramUsedMib / 1024, 0);
    // NVML reflects real driver allocation (including orphan llama-server processes).
    // Stack supplements when NVML lags — LOADING slots reserve learned/estimated MiB immediately.
    const committed = Math.max(nvmlUsed, stackUsed);
    return Math.max(0, manufactured - committed);
  });
}

/** Free VRAM (all GPUs) + free host RAM — upper bound for a single launch. */
export function systemMemoryAvailableGb(
  computed: ComputedValues,
  input: Pick<ScenarioInput, "ramAvailableGb">,
): number {
  return computed.multiTotalAvailable + input.ramAvailableGb;
}

export function systemMemoryHeadroomGb(poolGb: number): number {
  return Math.max(2.0, poolGb * 0.02);
}

/** True when the estimate cannot fit in combined GPU VRAM + host RAM. */
export function exceedsSystemMemory(
  estimateGb: number,
  computed: ComputedValues,
  input: Pick<ScenarioInput, "ramAvailableGb">,
): boolean {
  const poolGb = systemMemoryAvailableGb(computed, input);
  return estimateGb > poolGb - systemMemoryHeadroomGb(poolGb);
}

/** Accessors for flattened EngineConfig — read from extra_params with defaults. */
function ep(cfg: EngineConfig): Record<string, any> { return cfg.extra_params || {}; }

function cfgStr(cfg: EngineConfig, key: string, fallback: string): string {
  const v = ep(cfg)[key];
  return v != null ? String(v) : fallback;
}
function cfgNum(cfg: EngineConfig, key: string, fallback: number): number {
  const v = ep(cfg)[key];
  if (typeof v === 'number') return v;
  const p = parseInt(String(v), 10);
  return isNaN(p) ? fallback : p;
}
function cfgBool(cfg: EngineConfig, key: string, fallback: boolean): boolean {
  const v = ep(cfg)[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() !== 'off' && v.toLowerCase() !== 'false';
  return fallback;
}

/** Compute per-layer weight in GB from architecture dimensions (full layer).
 *  Replaces uniform `weightsGb / nLayer` which is wrong for MoE models
 *  where expert FFN weights dominate layer size. */
export function perLayerWeightGb(input: ScenarioInput, computed: ComputedValues): number {
  const m = input.modelMeta;
  const nLayer = m.n_layer;
  if (nLayer === 0 || m.n_embd === 0) return computed.weightsGb / Math.max(nLayer, 1);

  const headDim = m.n_head > 0 ? m.n_embd / m.n_head : 128;
  const nHeadKv = m.n_head_kv > 0 ? m.n_head_kv : m.n_head;
  const isMoe = m.n_expert > 0;

  // Per-layer param count from architecture
  let perLayerParams: number;

  if (isMoe) {
    // Attention: Q + K + V + output_proj
    const attnParams = m.n_embd * m.n_embd
      + 2 * m.n_embd * (nHeadKv * headDim)
      + m.n_embd * m.n_embd;
    // Router weight
    const routerParams = m.n_embd * m.n_expert;

    // Expert FFN length — prefer GGUF metadata, derive from file size if missing.
    let expertFfnLen: number | null = m.expert_feed_forward_length || null;
    if (expertFfnLen === null && m.bpw > 0) {
      // Derive: totalParams = file_size * 8 / bpw
      const totalParams = (m.file_size_bytes * 8) / m.bpw;
      // Non-expert params per layer: attention + router + norms (~2*n_embd per norm, 4 norms/layer)
      const normParamsPerLayer = 4 * m.n_embd;
      const nonExpertPerLayer = attnParams + routerParams + normParamsPerLayer;
      // Token embedding (shared, not per-layer)
      const tokenEmbedding = m.vocab_size * m.n_embd;
      // Final LM head — often shares weights with token embedding in llama.cpp models.
      // If shared: 0 extra params. If not shared: vocab_size * n_embd more.
      // Conservative: assume shared (most GGUF models do).
      const totalNonExpert = nonExpertPerLayer * nLayer + tokenEmbedding;
      // Remaining params are all in expert FFN: n_layer * n_expert * 3 * n_embd * expertFfnLen
      const expertTotalParams = totalParams - totalNonExpert;
      if (expertTotalParams > 0 && m.n_expert > 0) {
        expertFfnLen = Math.round(expertTotalParams / (nLayer * m.n_expert * 3 * m.n_embd));
      }
    }
    // Last resort fallback
    if (expertFfnLen === null || expertFfnLen <= 0) {
      expertFfnLen = m.feed_forward_length || Math.round(m.n_embd * 4);
    }

    const moeParams = m.n_expert * 3 * m.n_embd * expertFfnLen;
    perLayerParams = attnParams + moeParams + routerParams;
  } else {
    // Dense: attention + FFN (gate + up + down)
    const ffnLen = m.feed_forward_length || (m.n_embd * 4);
    const attnParams = m.n_embd * m.n_embd
      + 2 * m.n_embd * (nHeadKv * headDim)
      + m.n_embd * m.n_embd;
    const ffnParams = 3 * m.n_embd * ffnLen;
    perLayerParams = attnParams + ffnParams;
  }

  // Convert to GB using bpw from file metadata
  if (m.bpw > 0) {
    return (perLayerParams * m.bpw / 8) / (1024 ** 3);
  }
  return computed.weightsGb / nLayer;
}

/** Compute the fraction of MOE model weights that stay on GPU in MOE_OPTIMAL mode.
 *  Non-expert weights (attention, norms, router) always stay on GPU.
 *  Expert FFN weights are streamed from RAM — only n_expert_used activate per token. */
function computeMoeGpuWeightFraction(meta: ModelMetadata): number {
  if (meta.n_expert === 0 || meta.n_expert_used === 0) return 0.25;

  const expertDensity = meta.n_expert_used / meta.n_expert;
  const nonExpertFraction = 1.0 - (1.0 - expertDensity) * 0.75;

  return Math.max(0.1, Math.min(1.0, nonExpertFraction));
}

/** GPU-bound per-layer weight — applies gpuWeightFraction for MOE_OPTIMAL.
 *  In MOE_OPTIMAL mode only attention+router weights go to VRAM (~25% of layer).
 *  Use this for spill scenario layer counting (how many layers fit on GPU). */
export function gpuPerLayerWeightGb(input: ScenarioInput, computed: ComputedValues): number {
  return perLayerWeightGb(input, computed) * computed.gpuWeightFraction;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ── FIT interpolation helpers ───────────────────────────────────────────────

export function findFitPoint(points: FitPoint[], label: string): FitPoint | undefined {
  return points.find(p => p.label === label);
}

export function getBaseVramMib(points: FitPoint[]): number | null {
  const noBatch = findFitPoint(points, "base_no_batch");
  if (noBatch) return noBatch.vram_mib;
  const base = findFitPoint(points, "base");
  return base ? base.vram_mib : null;
}

export function estimateOverheadMib(points: FitPoint[], weightsGb: number, userCtx: number): number | null {
  const noBatch = findFitPoint(points, "base_no_batch");
  if (!noBatch) return null;
  const kvBytesPerToken = kvBytesForQuant(noBatch.kv_quant);
  const headDim = 128; // approximate, actual depends on model arch
  const estimatedKVAtCtx = (2 * noBatch.ctx * kvBytesPerToken * headDim) / (1024 * 1024);
  return noBatch.vram_mib - (weightsGb * 1024) - estimatedKVAtCtx;
}

export function estimateActivationPerBatchToken(points: FitPoint[]): number | null {
  const base = findFitPoint(points, "base");
  const noBatch = findFitPoint(points, "base_no_batch");
  if (!base || !noBatch) return null;
  return (base.vram_mib - noBatch.vram_mib) / 512;
}

export function estimateKvGrowthPerToken(points: FitPoint[]): number | null {
  const ctxPoints = points.filter(p => p.label.startsWith("ctx_") && p.batch <= 8);
  if (ctxPoints.length < 2) return null;
  ctxPoints.sort((a, b) => a.ctx - b.ctx);
  const lower = ctxPoints[0];
  const higher = ctxPoints[ctxPoints.length - 1];
  if (higher.ctx === lower.ctx) return null;
  return (higher.vram_mib - lower.vram_mib) / (higher.ctx - lower.ctx);
}

export function estimateSplitTaxMiB(points: FitPoint[], splitMode: string): number | null {
  const mode = splitMode.toLowerCase();
  const candidates = [
    `split_${mode}`,
    `split_${mode}_64k`,
    `split_${mode}_256k`,
  ];

  const baseNoBatch = findFitPoint(points, "base_no_batch");
  const base = baseNoBatch || findFitPoint(points, "base");
  if (!base) return null;

  for (const label of candidates) {
    const splitPt = findFitPoint(points, label);
    if (splitPt) return splitPt.vram_mib - base.vram_mib;
  }
  return null;
}

export function extrapolateVramFromPoints(
  points: FitPoint[],
  userCtx: number,
  _userKvQuant: string,
  userBatch: number,
  splitMode: string,
  weightsGb: number
): number | null {
  const baseNoBatch = findFitPoint(points, "base_no_batch");
  const base = baseNoBatch || findFitPoint(points, "base");
  if (!base) return null;

  let totalMib = base.vram_mib;

  // KV growth extrapolation for context difference
  const kvGrowthPerToken = estimateKvGrowthPerToken(points);
  if (kvGrowthPerToken !== null && userCtx !== base.ctx) {
    totalMib += kvGrowthPerToken * (userCtx - base.ctx);
  }

  // Activation delta for batch difference
  const actPerToken = estimateActivationPerBatchToken(points);
  if (actPerToken !== null && userBatch !== base.batch) {
    totalMib += actPerToken * (userBatch - base.batch);
  }

  // Split tax
  if (splitMode.length > 0 && splitMode.toUpperCase() !== "NONE") {
    const splitTax = estimateSplitTaxMiB(points, splitMode.toLowerCase());
    if (splitTax !== null) {
      totalMib += splitTax;
    }
  }

  return Math.max(0, totalMib);
}

export function estimateDefaultOverheadGb(weightsGb: number): number {
  return 0.3 + 0.1 + weightsGb * 0.02;
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
  /** Fraction of weights that actually go to GPU VRAM (1.0 for dense/regular, ~0.25 for MoE+MOE_OPTIMAL) */
  gpuWeightFraction: number;
  /** Portion of model weights bound to GPU VRAM */
  weightsOnGpuGb: number;
  /** Portion of model weights offloaded to RAM (MoE expert FFN in MOE_OPTIMAL mode) */
  ramWeightsGb: number;
}

export function computeValues(input: ScenarioInput, validatedVramMib?: number): ComputedValues {
  const { modelMeta, engineConfig, gpus } = input;
  const weightsGb = modelMeta.file_size_bytes / (1024 ** 3);
  const isMoe = modelMeta.n_expert > 0;

  // GPU-bound weight fraction — MOE_OPTIMAL always applies reduced fraction when selected.
  // Only attention + router weights go to GPU; expert FFN stays in RAM until dispatch.
  const gpuWeightFraction = (isMoe && cfgStr(engineConfig, "offload_mode", "regular") === "moe_optimal")
    ? computeMoeGpuWeightFraction(modelMeta)
    : 1.0;

  // ── Soft Cap: effective context length ────────────────────────────────
  const userCtx = parseCtx(cfgStr(engineConfig, "ctx", "32k"));
  const nCtxTrain = modelMeta.n_ctx_train || 4096;
  const ropeScale = cfgNum(engineConfig, "rope_scale", 1.0);
  const ropeScaling = cfgStr(engineConfig, "rope_scaling", "none").toLowerCase();

  // Always use the context length the user selected — no soft cap.
  const effectiveCtx = userCtx;

  // KV cache from GGUF metadata — uses effective context
  const headDim = modelMeta.n_head > 0 ? modelMeta.n_embd / modelMeta.n_head : 128;
  const kvBytesPerParam = kvBytesForQuant(cfgStr(engineConfig, "kv_quant", "f16"));
  const kvCacheGb = (modelMeta.n_layer > 0 && modelMeta.n_head_kv > 0)
    ? (2 * modelMeta.n_layer * modelMeta.n_head_kv * headDim * effectiveCtx * kvBytesPerParam) / (1024 ** 3)
    : 0;

  // ── CUDA overhead ─────────────────────────────────────────────────────
  const numGpusTotal = gpus.length;

  // Split mode active?
  const splitActive = cfgStr(engineConfig, "split", "none").length > 0 && cfgStr(engineConfig, "split", "none").toUpperCase() !== "NONE";

  // GPUs actually used by this model — single GPU when no split, all when splitting
  const deviceStr = cfgStr(engineConfig, "device", "GPU-0");
  const numGpusUsed = splitActive ? numGpusTotal : (deviceStr.includes("/") ? deviceStr.split("/").length : 1);

  const weightsOnGpuGb = weightsGb * gpuWeightFraction;
  const ramWeightsGb = weightsGb - weightsOnGpuGb;
  const moeOptimal = gpuWeightFraction < 1.0;

  // Vision addon — mmproj file size only
  const visionGb = cfgStr(engineConfig, "vision", "auto").toUpperCase() !== "OFF" ? (input.mmprojSizeMib || 0) / 1024 : 0;

  let overheadGb: number;
  let fitCacheExtrapolatedGb: number | null = null;

  if (input.fitPoints && input.fitPoints.length > 0) {
    // ── FIT-based estimation ────────────────────────────────────────────
    const splitMode = splitActive ? cfgStr(engineConfig, "split", "none").toLowerCase() : "";
    const extrapolatedMib = extrapolateVramFromPoints(
      input.fitPoints, userCtx, cfgStr(engineConfig, "kv_quant", "f16"), cfgNum(engineConfig, "batch", 2048), splitMode, weightsGb
    );

    if (extrapolatedMib !== null) {
      fitCacheExtrapolatedGb = extrapolatedMib / 1024;
      const formulaOverheadGb = computeDefaultOverhead(
        engineConfig, modelMeta, weightsGb, weightsOnGpuGb, numGpusUsed, effectiveCtx, isMoe, moeOptimal,
      );
      if (moeOptimal) {
        // Library scan measures regular offload (all experts on GPU) — peel experts to host RAM.
        const moeGpuGb = Math.max(
          weightsOnGpuGb + kvCacheGb + visionGb,
          fitCacheExtrapolatedGb - ramWeightsGb,
        );
        overheadGb = Math.max(0, moeGpuGb - weightsOnGpuGb - kvCacheGb - visionGb);
        overheadGb = Math.max(overheadGb, formulaOverheadGb);
      } else {
        // Derive overhead from measured FIT data: residual after subtracting known components.
        const fitOverheadGb = Math.max(0, fitCacheExtrapolatedGb - weightsOnGpuGb - kvCacheGb - visionGb);
        overheadGb = Math.max(fitOverheadGb, formulaOverheadGb);
      }
    } else {
      overheadGb = computeDefaultOverhead(
        engineConfig, modelMeta, weightsGb, weightsOnGpuGb, numGpusUsed, effectiveCtx, isMoe, moeOptimal,
      );
    }
  } else {
    // ── Default formula (no FIT data) ───────────────────────────────────
    overheadGb = computeDefaultOverhead(
      engineConfig, modelMeta, weightsGb, weightsOnGpuGb, numGpusUsed, effectiveCtx, isMoe, moeOptimal,
    );
  }

  // vramTotalGb is ALWAYS the sum of components — guarantees guards and display are consistent.
  let vramTotalGb: number;
  if (validatedVramMib) {
    vramTotalGb = validatedVramMib / 1024;
  } else {
    vramTotalGb = weightsOnGpuGb + kvCacheGb + overheadGb + visionGb;
  }

  const gpuAvailable = computeGpuAvailableList(gpus, input.runningSlots);

  const singleMaxAvailable = Math.max(...gpuAvailable, 0);
  const multiTotalAvailable = gpuAvailable.reduce((a, b) => a + b, 0);

  // Target GPU from config
  const targetGpuIdx = parseInt(deviceStr.replace("GPU-", "").split("/")[0], 10) || 0;

  return {
    weightsGb, kvCacheGb, overheadGb, visionGb, vramTotalGb,
    gpuAvailable, singleMaxAvailable, multiTotalAvailable,
    targetGpuIdx, splitActive, numGpus: numGpusUsed,
    gpuWeightFraction, weightsOnGpuGb, ramWeightsGb,
  };
}

/** Compute overhead using the default formula (no FIT data available). */
function computeDefaultOverhead(
  engineConfig: EngineConfig,
  modelMeta: ModelMetadata,
  weightsGb: number,
  weightsOnGpuGb: number,
  numGpusUsed: number,
  effectiveCtx: number,
  isMoe: boolean,
  moeOptimal: boolean,
): number {
  const baseOverheadPerGpu = estimateDefaultOverheadGb(moeOptimal ? weightsOnGpuGb : weightsGb);

  // Slot count does not affect VRAM forecast — unified KV shares one pool; FIT scan no longer sweeps parallel.
  let activationOverheadGb = (cfgNum(engineConfig, "ubatch", 512) / 1024) * 1.5 * (modelMeta.n_embd / 4096);
  const batchWorkspaceGb = Math.min((cfgNum(engineConfig, "batch", 2048) / 1024) * 0.375, 2.0);

  // Flash attention reduces activation memory by ~15%
  if (cfgBool(engineConfig, "flash_attn", false)) {
    activationOverheadGb *= 0.85;
  }

  // MoE: only active experts compute → lower activation overhead
  if (isMoe) {
    activationOverheadGb *= 0.8;
  }

  const ropeScaling = cfgStr(engineConfig, "rope_scaling", "none").toLowerCase();
  if (ropeScaling === "yarn") {
    activationOverheadGb *= 1.05;
  }

  // Context overhead scales past 64K but caps at 2 GB to prevent blowup on 1M ctx.
  const ctxOverhead = effectiveCtx > 65536
    ? Math.min((effectiveCtx - 65536) * CUDA_CTX_OVERHEAD_FACTOR, 2.0)
    : 0;

  return baseOverheadPerGpu * numGpusUsed + activationOverheadGb + batchWorkspaceGb + RS_BUFFER_PER_GPU_GB * numGpusUsed + ctxOverhead;
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
    vramAvailableGb: round2(computed.gpuAvailable[i] ?? 0),
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
    formulaVramTotalGb: round2(vramTotal),
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

import { tryEvaluate as autoFit } from "./auto_fit";
import { evaluate as hwLocked } from "./hw_locked";

/** Compute MOE_OPTIMAL suggestion internally (not exposed as actual scenario) */
function computeMoeAlternative(
  input: ScenarioInput, 
  computed: ComputedValues,
  currentManifest: VramManifest
): MoeSuggestion | null {
  const { modelMeta } = input;
  
  // Only suggest for MoE models
  if (modelMeta.n_expert === 0) return null;
  
  // Don't suggest if already in MOE_OPTIMAL mode
  if (cfgStr(input.engineConfig, "offload_mode", "regular") === "moe_optimal") return null;
  
  // Simulate MOE_OPTIMAL computation with reduced GPU weight fraction
  const currentGpuFraction = computed.gpuWeightFraction;
  
  // Apply MOE_OPTIMAL reduction (~25% to GPU, ~75% to RAM)
  if (currentGpuFraction === 1.0) {
    const moeGpuFraction = computeMoeGpuWeightFraction(modelMeta);
    const moeWeightsOnGpuGb = computed.weightsGb * moeGpuFraction;
    
    const moeVramTotal = moeWeightsOnGpuGb + computed.kvCacheGb + computed.overheadGb + computed.visionGb;
    const currentVramTotal = currentManifest.vramTotalGb;
    const vramSaved = currentVramTotal - moeVramTotal;
    const wouldFitOnGpu = moeVramTotal <= computed.singleMaxAvailable;
    const hostOffloadLikely = currentManifest.ramTotalGb > 0.5
      || (currentManifest.style.uiTemplate.offloadWarningText?.length ?? 0) > 0;
    const shouldHighlight = hostOffloadLikely && wouldFitOnGpu;
    
    return {
      wouldFit: wouldFitOnGpu || vramSaved > 0,
      vramSavedGb: vramSaved > 0 ? vramSaved : undefined,
      avoidsSpill: hostOffloadLikely && wouldFitOnGpu,
      speedImpact: "<10%",
      shouldHighlight, // New field to control animation
      suggestionText: wouldFitOnGpu 
        ? `Use MOE_OPTIMAL to save ~${vramSaved.toFixed(1)} GB VRAM with minimal speed impact`
        : `MOE_OPTIMAL reduces VRAM usage by ~${vramSaved.toFixed(1)} GB`,
    };
  }
  
  return null;
}

// Extend VramManifest type locally for MOE suggestion
interface VramManifestWithMoe extends VramManifest {
  moeSuggestion?: MoeSuggestion | null;
}

/** Learned VRAM totals + per-GPU projection are owned by AUTO_FIT — do not stomp forecast bars here. */
export function applyLearnedVramOverlay(
  manifest: VramManifest,
  _input: ScenarioInput,
  validatedVramMib?: number,
): VramManifest {
  if (validatedVramMib != null) return manifest;
  return manifest;
}

export function evaluate(input: ScenarioInput, validatedVramMib?: number): VramManifest {
  const computed = computeValues(input, validatedVramMib);

  // Zero GPUs → immediate HW_LOCKED
  if (computed.numGpus === 0) {
    return hwLocked(input, computed, "No GPUs detected");
  }

  const result = autoFit(input, computed);

  let manifest: VramManifest | null = result;

  // Fallback if no scenario matched
  if (!manifest) {
    manifest = hwLocked(input, computed, `Model requires ${computed.vramTotalGb.toFixed(1)} GB VRAM + RAM, system has ${(computed.multiTotalAvailable + input.ramAvailableGb).toFixed(1)} GB combined`);
  }

  // Compute MOE suggestion and attach to manifest
  const moeSuggestion = computeMoeAlternative(input, computed, manifest);
  
  // Always sync moeSuggestion (remove when not applicable)
  (manifest as VramManifestWithMoe).moeSuggestion = moeSuggestion;

  return attachMemorySource(
    applyLearnedVramOverlay(manifest, input, validatedVramMib),
    input,
  );
}

/** Apply FIT-validated total to a formula-based manifest.
 *  Scales component breakdown proportionally so weights+kv+overhead sum to measured total.
 *  Also replaces per-GPU projected load with measured breakdown if available. */
export function applyFitValidation(
  manifest: VramManifest,
  validatedMib: number,
  gpuBreakdown?: number[],
  hostMib?: number,
): VramManifest {
  const formulaTotalGb = manifest.formulaVramTotalGb;
  if (formulaTotalGb === 0) return manifest;

  const scale = (validatedMib / 1024) / formulaTotalGb;
  const validatedTotalGb = validatedMib / 1024;

  // Scale component breakdown proportionally
  const scaledWeights = round2(manifest.vramWeightsGb * scale);
  const scaledKv = round2(manifest.vramKvGb * scale);
  const scaledOverhead = round2(validatedTotalGb - scaledWeights - scaledKv);

  // Scale per-GPU projected load — use measured breakdown if available, else proportional
  const scaledAllocations = manifest.gpuAllocations.map((alloc, i) => {
    let load: number;
    if (gpuBreakdown && gpuBreakdown[i] != null) {
      load = round2(gpuBreakdown[i] / 1024);
    } else {
      load = round2(alloc.projectedLoadGb * scale);
    }
    return { ...alloc, projectedLoadGb: load };
  });

  // Recalculate fits based on validated total
  const totalGpuVramGb = manifest.gpuAllocations.reduce((s, a) => s + a.vramManufacturedGb, 0);
  const newFits = validatedTotalGb <= totalGpuVramGb;

  return {
    ...manifest,
    vramWeightsGb: scaledWeights,
    vramKvGb: scaledKv,
    vramOverheadGb: Math.max(0, scaledOverhead),
    vramTotalGb: round2(validatedTotalGb),
    gpuAllocations: scaledAllocations,
    fits: newFits,
    validatedVramMib: validatedMib,
    validatedGpuBreakdownMib: gpuBreakdown,
    validatedHostMib: hostMib,
  };
}
