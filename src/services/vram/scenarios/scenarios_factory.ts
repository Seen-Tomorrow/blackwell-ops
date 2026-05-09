import type { GpuInfo, ModelMetadata, EngineConfig, Scenario, StyleObject, RunningEngine, GpuAllocation, VramManifest, MoeSuggestion } from "../../../lib/types";

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
    "512K": 524288, "1M": 1048576,
  };
  const upper = ctxSize.toUpperCase();
  if (map[upper]) return map[upper];
  // Handle numeric strings like "131072" or suffixed values not in map
  const parsed = parseInt(upper.replace(/[^0-9]/g, ""), 10);
  if (parsed > 0) return parsed;
  // Try with suffix multiplier as last resort
  const suffixMatch = upper.match(/^(\d+)([KMG])$/);
  if (suffixMatch) {
    const num = parseInt(suffixMatch[1], 10);
    const mult = { K: 1024, M: 1048576, G: 1073741824 }[suffixMatch[2]];
    return num * (mult || 1);
  }
  return 32768;
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
      // If engine spans multiple GPUs, show its per-GPU share (tensor-split divides evenly)
      const gpuCount = s.gpuMask.split(",").length;
      return { slotAlias: s.alias, modelShort: s.modelShort, vramUsedMib: s.vramMib / gpuCount };
    });
}

export function gpuHasRunningEngines(gpuIdx: number, slots: RunningSlotInfo[]): boolean {
  return slots.some(s => s.gpuMask.split(",").some(p => p.trim() === String(gpuIdx)));
}

/** Compute per-layer weight in GB from architecture dimensions (full layer).
 *  Replaces uniform `weightsGb / nLayer` which is wrong for MoE models
 *  where expert FFN weights dominate layer size. */
const warnedClamps = new Set<string>();

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
    // All experts loaded into VRAM (llama.cpp loads all, not just active)
    const expertFfnLen = m.expert_feed_forward_length || (m.feed_forward_length || m.n_embd * 4);
    const moeParams = m.n_expert * 3 * m.n_embd * expertFfnLen;
    // Router weight
    const routerParams = m.n_embd * m.n_expert;
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
  let perLayerGb = 0;
  if (m.bpw > 0) {
    perLayerGb = (perLayerParams * m.bpw / 8) / (1024 ** 3);
  } else {
    perLayerGb = computed.weightsGb / nLayer;
  }

  // Sanity clamp: architecture-derived per-layer should not exceed file-size-based uniform by >2x.
  // If it does, metadata is likely wrong (e.g., missing expert_feed_forward_length) and we fall back.
  const uniformPerLayer = computed.weightsGb / nLayer;
  if (perLayerGb > uniformPerLayer * 2) {
    // Only warn once per unique model signature to avoid console spam
    const key = `${input.modelMeta.n_layer}-${computed.weightsGb.toFixed(1)}`;
    if (!warnedClamps.has(key)) {
      console.warn(
        `[VRAM] perLayerWeightGb sanity clamp: arch=${perLayerGb.toFixed(2)}GB > uniform=${uniformPerLayer.toFixed(2)}GB × 2. Falling back to uniform.`
      );
      warnedClamps.add(key);
    }
    return uniformPerLayer;
  }

  return perLayerGb;
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
  const gpuWeightFraction = (isMoe && engineConfig.offload_mode === "moe_optimal")
    ? MOE_ATTENTION_RATIO + MOE_ROUTING_RATIO + MOE_NON_EXPERT_FFN_RATIO
    : 1.0;

  // ── Soft Cap: effective context length ────────────────────────────────
  const userCtx = parseCtx(engineConfig.ctx_size);
  const nCtxTrain = modelMeta.n_ctx_train || 4096;
  const ropeScale = engineConfig.rope_scale ?? 1.0;
  const ropeScaling = (engineConfig.rope_scaling || "none").toLowerCase();

  // Always use the context length the user selected — no soft cap.
  const effectiveCtx = userCtx;

  // KV cache from GGUF metadata — uses effective context
  const headDim = modelMeta.n_head > 0 ? modelMeta.n_embd / modelMeta.n_head : 128;
  const kvBytesPerParam = kvBytesForQuant(engineConfig.kv_quant);
  const kvCacheGb = (modelMeta.n_layer > 0 && modelMeta.n_head_kv > 0)
    ? (2 * modelMeta.n_layer * modelMeta.n_head_kv * headDim * effectiveCtx * kvBytesPerParam) / (1024 ** 3)
    : 0;

  // ── CUDA overhead: Safety Floor + Dynamic Overhead ────────────────────
  const numGpus = gpus.length;
  const weightsOnGpuGb = weightsGb * gpuWeightFraction;

  // Base overhead scales with model size — small models don't need 2.5 GB per GPU.
  // Derived from FIT measurements: <4B ~0.8GB, 4-13B ~1.5GB, 13-70B ~2.5GB, >70B ~3.5GB
  const baseOverheadPerGpu = weightsGb < 4 ? 0.8 :
                              weightsGb < 13 ? 1.5 :
                              weightsGb < 70 ? 2.5 : 3.5;

  // Compute buffer scales with weight size but caps at reasonable levels
  const computeBufferRatio = numGpus === 1
    ? COMPUTE_BUFFER_PRIMARY_RATIO
    : COMPUTE_BUFFER_PRIMARY_RATIO + (numGpus - 1) * COMPUTE_BUFFER_SECONDARY_RATIO;
  const safetyFloorComputeBuffer = Math.min(weightsOnGpuGb * computeBufferRatio, weightsOnGpuGb * 0.3);

  // Dynamic overhead has two components:
  // 1) Activation memory (ubatch-based peak activations during forward pass)
  // 2) Batch workspace buffer (CUDA staging buffers that scale with total batch size)
  let activationOverhead = 0;
  let batchWorkspaceGb = 0;

  if (engineConfig.batch > 2048 || engineConfig.parallel > 1) {
    const effectiveHeads = modelMeta.n_head_kv > 0 ? modelMeta.n_head_kv : modelMeta.n_head;
    // Peak activation memory: one layer's activations at a time, processed in ubatch chunks.
    // Cap effective ubatch to avoid blowup on huge batch configs.
    const effectiveUbatch = Math.min(engineConfig.ubatch, 2048);
    activationOverhead = (effectiveUbatch * modelMeta.n_embd * effectiveHeads * headDim * 2) / (1024 ** 3);

    // Flash attention reduces activation memory by ~15%
    if (engineConfig.flash_attn) {
      activationOverhead *= 0.85;
    }
    // MoE: only active experts compute → lower activation overhead in both modes.
    // In REGULAR mode all expert weights are on GPU but only n_expert_used activate per token.
    // In MOE_OPTIMAL mode expert FFN is streamed from RAM — same selective dispatch applies,
    // so the 20% reduction holds for both paths.
    if (isMoe) {
      activationOverhead *= 0.8;
    }
    // YaRN adds +5% overhead for attention scaling calculations
    if (ropeScaling === "yarn") {
      activationOverhead *= 1.05;
    }

    // Batch workspace: CUDA staging buffers scale with total batch size, not ubatch.
    // Factor ~1.5 GB per 4096 tokens — derived from real launch measurements. Cap at 2 GB.
    batchWorkspaceGb = Math.min(engineConfig.batch * CUDA_BATCH_OVERHEAD_FACTOR, 2.0);
  }

  const finalComputeBuffer = safetyFloorComputeBuffer + Math.max(activationOverhead, batchWorkspaceGb);
  const parallelOverhead = Math.max(0, engineConfig.parallel - 1) * CUDA_PARALLEL_OVERHEAD_PER_REQ_GB;
  // Context overhead scales past 64K but caps at 2 GB to prevent blowup on 1M ctx.
  const ctxOverhead = effectiveCtx > 65536
    ? Math.min((effectiveCtx - 65536) * CUDA_CTX_OVERHEAD_FACTOR, 2.0)
    : 0;
  const overheadGb = baseOverheadPerGpu * numGpus + finalComputeBuffer + RS_BUFFER_PER_GPU_GB * numGpus + parallelOverhead + ctxOverhead;

  // Vision addon
  const visionGb = engineConfig.vision !== "OFF"
    ? (input.mmprojSizeMib || 0) / 1024 + VISION_WORKSPACE_GB
    : 0;

  // Use measured VRAM total if provided (from FIT validation), otherwise use formula
  const vramTotalGb = validatedVramMib 
    ? validatedVramMib / 1024  // Convert MiB to GB
    : weightsOnGpuGb + kvCacheGb + overheadGb + visionGb;

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

  const ramWeightsGb = weightsGb - weightsOnGpuGb;

  return {
    weightsGb, kvCacheGb, overheadGb, visionGb, vramTotalGb,
    gpuAvailable, singleMaxAvailable, multiTotalAvailable,
    targetGpuIdx, splitActive, numGpus,
    gpuWeightFraction, weightsOnGpuGb, ramWeightsGb,
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

import { tryEvaluate as soloFit } from "./solo_fit";
import { tryEvaluate as soloPressure } from "./solo_pressure";
import { tryEvaluate as multiFit } from "./multi_fit";
import { tryEvaluate as multiPressure } from "./multi_pressure";
import { tryEvaluate as soloSpill } from "./solo_spill";
import { tryEvaluate as multiSpill } from "./multi_spill";
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
  if (input.engineConfig.offload_mode === "moe_optimal") return null;
  
  // Simulate MOE_OPTIMAL computation with reduced GPU weight fraction
  const currentGpuFraction = computed.gpuWeightFraction;
  
  // Apply MOE_OPTIMAL reduction (~25% to GPU, ~75% to RAM)
  if (currentGpuFraction === 1.0) {
    const moeGpuFraction = 
      MOE_ATTENTION_RATIO + MOE_ROUTING_RATIO + MOE_NON_EXPERT_FFN_RATIO; // ~0.25
    const moeWeightsOnGpuGb = computed.weightsGb * moeGpuFraction;
    
    // Check if MOE_OPTIMAL would be better than current scenario
    const currentIsSpill = 
      currentManifest.scenario === 'SOLO_SPILL' || 
      currentManifest.scenario === 'MULTI_SPILL';
    
    const moeVramTotal = moeWeightsOnGpuGb + computed.kvCacheGb + computed.overheadGb + computed.visionGb;
    const currentVramTotal = currentManifest.vramTotalGb;
    
    // MOE_OPTIMAL is beneficial if:
    // - Current scenario is spill AND MOE would fit on GPU, OR
    // - Current scenario is MULTI_FIT/MULTI_PRESSURE and MOE reduces GPU utilization below 85%, OR
    // - MOE saves any meaningful VRAM (>2 GB) even if both fit
    const vramSaved = currentVramTotal - moeVramTotal;
    const wouldFitOnGpu = moeVramTotal <= computed.singleMaxAvailable;
    
    // Check GPU utilization reduction for multi-GPU scenarios
    const isMultiScenario = 
      currentManifest.scenario === 'MULTI_FIT' || 
      currentManifest.scenario === 'MULTI_PRESSURE';
    
    const totalGpuCapacityGb = computed.multiTotalAvailable;
    const moeUtilizationRatio = totalGpuCapacityGb > 0 ? moeVramTotal / totalGpuCapacityGb : 1.0;
    const wouldReduceUtilBelow85Pct = isMultiScenario && moeUtilizationRatio < 0.85;
    
    // Determine if suggestion should be highlighted (animated border)
    // Only highlight for spill scenarios, ignore VRAM savings
    const shouldHighlight = currentIsSpill;
    
    return {
      wouldFit: wouldFitOnGpu || vramSaved > 0,
      vramSavedGb: vramSaved > 0 ? vramSaved : undefined,
      avoidsSpill: currentIsSpill && wouldFitOnGpu,
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

export function evaluate(input: ScenarioInput, validatedVramMib?: number): VramManifest {
  const computed = computeValues(input, validatedVramMib);

  // Zero GPUs → immediate HW_LOCKED
  if (computed.numGpus === 0) {
    return hwLocked(input, computed, "No GPUs detected");
  }

  // Evaluation order: single-GPU fits (comfortable → pressure) → spill (RAM offload) → multi-GPU distribution
  const result =
    soloFit(input, computed) ||
    soloPressure(input, computed) ||
    soloSpill(input, computed) ||
    multiSpill(input, computed) ||
    multiFit(input, computed) ||
    multiPressure(input, computed);

  let manifest: VramManifest | null = result;

  // Fallback if no scenario matched
  if (!manifest) {
    manifest = hwLocked(input, computed, `Model requires ${computed.vramTotalGb.toFixed(1)} GB VRAM + RAM, system has ${(computed.multiTotalAvailable + input.ramAvailableGb).toFixed(1)} GB combined`);
  }

  // Compute MOE suggestion and attach to manifest
  const moeSuggestion = computeMoeAlternative(input, computed, manifest);
  
  // Always sync moeSuggestion (remove when not applicable)
  (manifest as VramManifestWithMoe).moeSuggestion = moeSuggestion;

  return manifest;
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

  function round2(v: number): number {
    return Math.round(v * 100) / 100;
  }
}
