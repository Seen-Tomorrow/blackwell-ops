import type { BrainsId, CodingModeId, SpeedBoostId, ThinkId } from "./multiAgentBooster";
import {
  THROUGHPUT_STOPS,
  sameParamValue,
  type ParamValue,
  type SamplerKey,
  type ThroughputId,
} from "./engineSurfaces";

/** FULL AUTO outcomes — the app owns the knobs until the user takes control. */
export type FullAutoGoal = "balanced" | "context" | "agents" | "fastest";

export interface FullAutoGoalOption {
  id: FullAutoGoal;
  label: string;
  note: string;
}

export const FULL_AUTO_GOALS: FullAutoGoalOption[] = [
  { id: "balanced", label: "BALANCED", note: "4 agents · Solid KV · BALANCE batch" },
  { id: "context", label: "MAX CTX", note: "Solo · Light KV · LATENCY batch" },
  { id: "agents", label: "MAX AGENTS", note: "Squad ×8 · Solid KV · BALANCE batch" },
  { id: "fastest", label: "MAX PERFORMANCE", note: "Solo · MTP when available · SPEED batch" },
];

export interface FullAutoGoalPlan {
  codingMode: CodingModeId;
  speed: SpeedBoostId;
  brains: BrainsId;
  think: ThinkId;
  throughput: ThroughputId;
}

/**
 * Phase-1 cockpit plans. These are deliberately coarse heuristics until the
 * FIT/VRAM calibration pass lands; they set the knobs FULL AUTO already owns.
 */
export const FULL_AUTO_GOAL_PLANS: Record<FullAutoGoal, FullAutoGoalPlan> = {
  balanced: {
    codingMode: "group",
    speed: "smart",
    brains: "solid",
    think: "on",
    throughput: "balance",
  },
  context: {
    codingMode: "solo",
    speed: "smart",
    brains: "light",
    think: "on",
    throughput: "latency",
  },
  agents: {
    codingMode: "squad",
    speed: "smart",
    brains: "solid",
    think: "on",
    throughput: "balance",
  },
  fastest: {
    codingMode: "solo",
    speed: "mtp",
    brains: "solid",
    think: "off",
    throughput: "speed",
  },
};

export function fullAutoGoalBatchLabel(goal: FullAutoGoal | null): string | null {
  if (!goal) return null;
  const throughput = FULL_AUTO_GOAL_PLANS[goal].throughput;
  return THROUGHPUT_STOPS.find((stop) => stop.id === throughput)?.label ?? null;
}

export type FullAutoFitState = "ready" | "tight" | "estimating";

// ── Workload layer ─────────────────────────────────────────────────────────

export type FullAutoWorkload = "chat" | "coding" | "longdoc" | "batch";

export interface FullAutoWorkloadOption {
  id: FullAutoWorkload;
  label: string;
  note: string;
  /** Explicit sampler values — no percent positions, no provider-value drift. */
  sampler: Record<SamplerKey, ParamValue>;
  /** Preferred tweak values; only applied when the template exposes them. */
  tweaks: Record<string, ParamValue>;
}

export const FULL_AUTO_WORKLOADS: FullAutoWorkloadOption[] = [
  {
    id: "chat",
    label: "CHAT",
    note: "0.7 / 0.95 · presence 0 · Jinja on",
    sampler: {
      temp: 0.7,
      top_p: 0.95,
      top_k: 20,
      min_p: 0.05,
      presence_penalty: 0,
      repeat_penalty: 1,
    },
    tweaks: {
      jinja: "on",
      swa_full: "off",
      spm_infill: "on",
      cache_ram: 8192,
      reasoning_preserve: "on",
    },
  },
  {
    id: "coding",
    label: "CODING",
    note: "0.3 / 0.95 · presence 0 · larger cache",
    sampler: {
      temp: 0.3,
      top_p: 0.95,
      top_k: 20,
      min_p: 0,
      presence_penalty: 0,
      repeat_penalty: 1,
    },
    tweaks: {
      jinja: "on",
      swa_full: "off",
      spm_infill: "on",
      cache_ram: 16384,
      reasoning_preserve: "on",
    },
  },
  {
    id: "longdoc",
    label: "LONG-DOC",
    note: "0.3 / 0.9 · presence 0 · SWA full · 32K cache",
    sampler: {
      temp: 0.3,
      top_p: 0.9,
      top_k: 20,
      min_p: 0,
      presence_penalty: 0,
      repeat_penalty: 1,
    },
    tweaks: {
      jinja: "on",
      swa_full: "on",
      spm_infill: "on",
      cache_ram: 32768,
      reasoning_preserve: "on",
    },
  },
  {
    id: "batch",
    label: "BATCH",
    note: "greedy · top-k 1 · presence 0 · max TPS",
    sampler: {
      temp: 0,
      top_p: 1,
      top_k: 1,
      min_p: 0,
      presence_penalty: 0,
      repeat_penalty: 1,
    },
    tweaks: {
      jinja: "off",
      swa_full: "off",
      spm_infill: "off",
      cache_ram: 8192,
      reasoning_preserve: "off",
    },
  },
];

/** Which task the current sampler bag represents, or CUSTOM after any edit. */
export function detectSamplerTask(
  config: Record<string, unknown>,
): FullAutoWorkload | "custom" {
  for (const option of FULL_AUTO_WORKLOADS) {
    const match = Object.entries(option.sampler).every(([key, value]) =>
      sameParamValue(config[key], value),
    );
    if (match) return option.id;
  }
  return "custom";
}

export function fullAutoWorkloadLabel(workload: FullAutoWorkload | null): string | null {
  if (!workload) return null;
  return FULL_AUTO_WORKLOADS.find((item) => item.id === workload)?.label ?? null;
}
