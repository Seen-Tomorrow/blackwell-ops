import type {
  EngineConfig,
  GpuInfo,
  ModelMetadata,
  VramManifest,
} from "../../../lib/types";
import type { FitPoint, RunningSlotInfo } from "../shared";

/**
 * Measured-only forecast input.
 * No GGUF formula path — paint requires LEARNED / LEARNED≈ / FIT PROBE.
 */
export interface ForecastInput {
  modelMeta: ModelMetadata;
  engineConfig: EngineConfig;
  gpus: GpuInfo[];
  runningSlots: RunningSlotInfo[];
  ramAvailableGb: number;
  ramManufacturedGb: number;
  mmprojSizeMib?: number;
  /** External draft GGUF size (MiB) — FIT probe never loads draft. */
  draftSizeMib?: number;
  fitPoints?: FitPoint[];
  autoVramLaunch?: boolean;
  fullAutoMode?: boolean;
  fitStyle?: string;

  learnedVramMib?: number;
  learnedHostMib?: number;
  learnedGpuBreakdownMib?: number[];
  learnedGpuComponentsMib?: Array<{ model_mib: number; ctx_mib: number; compute_mib: number }>;
  learnedLaunchProfile?: string;
  learnedMeasuredAt?: string;
  learnedMtpContextMib?: number;
  learnedAnchorCtx?: number;
  learnedCurve?: Array<{ ctx: number; vramMib: number; hostMib?: number }>;

  fitProbeVramMib?: number;
  fitProbeHostMib?: number;
  fitProbeGpuBreakdownMib?: number[];
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
export type ScenarioInput = ForecastInput;

export interface ForecastAdapter {
  /** Provider ids this adapter owns (lowercase). */
  readonly ids: readonly string[];
  /**
   * Build a measured manifest, or null while waiting for probe/learned.
   * Never invents GGUF formula GB.
   */
  evaluate(input: ForecastInput): VramManifest | null;
}
