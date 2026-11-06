import type {
  EngineConfig,
  GpuInfo,
  ModelMetadata,
  VramManifest,
} from "../../../lib/types";
import type { RunningSlotInfo } from "../shared";
import type { GpuCalibrationRow } from "../../../lib/vramLayerPlan";

/**
 * Measured-only forecast input.
 * No GGUF formula path — paint requires a launch point, a launch curve, or a FIT probe.
 * The FIT library sweep is deliberately not an input: it measures fixed q4_0 knobs.
 */
export interface ForecastInput {
  modelMeta: ModelMetadata;
  engineConfig: EngineConfig;
  gpus: GpuInfo[];
  runningSlots: RunningSlotInfo[];
  ramAvailableGb: number;
  ramManufacturedGb: number;
  /**
   * Per-device measured runtime cost (CUDA context, graph pools, allocator slack).
   * The engine's buffer table never prints these bytes, so the number and the gate both
   * have to add them or "fits" is a promise the card cannot keep.
   */
  gpuCalibration?: GpuCalibrationRow[];
  mmprojSizeMib?: number;
  /** External draft GGUF size (MiB) — FIT probe never loads draft. */
  draftSizeMib?: number;
  autoVramLaunch?: boolean;
  fullAutoMode?: boolean;
  fitStyle?: string;
  /**
   * Per-card planned MiB from the layer table when the launch carries an applied `-ts`.
   * `-ts` is a fraction of layers and layer bytes are not that fraction, so the bars must
   * paint this instead of splitting the total by the fraction.
   */
  layerSplitMib?: number[];

  learnedVramMib?: number;
  learnedHostMib?: number;
  /** Host model column from the learned entry — weights, not buffer. */
  learnedHostModelMib?: number;
  /** Host-resident lookup table (Engram / PLE) from the learned launch snapshot. */
  learnedEngramMib?: number;
  /** Model-level lookup table size from the GGUF header — survives any knob change. */
  modelEngramMib?: number;
  learnedGpuBreakdownMib?: number[];
  learnedGpuComponentsMib?: Array<{ model_mib: number; ctx_mib: number; compute_mib: number }>;
  learnedLaunchProfile?: string;
  learnedMeasuredAt?: string;
  learnedSpecContextMib?: number;
  learnedAnchorCtx?: number;
  learnedCurve?: Array<{
    ctx: number;
    vramMib: number;
    hostMib?: number;
    kvMib?: number;
    engramMib?: number;
  }>;

  fitProbeVramMib?: number;
  fitProbeHostMib?: number;
  /** FIT Host model column (weight on host) when printed. */
  fitProbeHostModelMib?: number;
  /** Host-resident lookup table (Engram / PLE) — never VRAM by design. */
  fitProbeEngramMib?: number;
  fitProbeGpuBreakdownMib?: number[];
  /** Per-GPU model/ctx/compute from the probe table — tooltip breakdown. */
  fitProbeComponentsMib?: VramManifest["validatedComponentsMib"];
  /**
   * A short probe sequence at two CTXs, run on demand when no launch curve exists.
   * Two points make the footprint affine in CTX, so the incomplete curve captures compute
   * growth instead of only KV.
   */
  fitProbeCurve?: Array<{ ctx: number; vramMib: number; hostMib?: number; kvMib?: number }>;
  fitProbePlacementKey?: string;
  fitProbeAnchorCtx?: number;
  /** Display clock when probe completed (session). */
  fitProbeMeasuredAt?: string;
  /** `full` | `low_vram` session probe regime. */
  fitProbeMode?: "full" | "low_vram";
  /** Free-pool fingerprint when probe was taken (stale when free moves). */
  fitProbeFreeFingerprint?: string;
  /** Fitted -ngl from low_vram probe when known. */
  fitProbeFittedNgl?: number;
}

/** Compat alias — old scenario call sites. */
type ScenarioInput = ForecastInput;

export interface ForecastAdapter {
  /** Provider ids this adapter owns (lowercase). */
  readonly ids: readonly string[];
  /**
   * Build a measured manifest, or null while waiting for probe/learned.
   * Never invents GGUF formula GB.
   */
  evaluate(input: ForecastInput): VramManifest | null;
}
