import type { BrainsId, CodingModeId, SpeedBoostId, ThinkId } from "./multiAgentBooster";
import { THROUGHPUT_STOPS, type ParamValue, type TasteId, type ThroughputId } from "./engineSurfaces";

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
  taste: TasteId;
  /** Preferred tweak values; only applied when the template exposes them. */
  tweaks: Record<string, ParamValue>;
}

export const FULL_AUTO_WORKLOADS: FullAutoWorkloadOption[] = [
  {
    id: "chat",
    label: "CHAT",
    note: "BALANCED sampler · Jinja on · reasoning on",
    taste: "balanced",
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
    note: "EXACT sampler · Jinja on · larger cache",
    taste: "exact",
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
    note: "BALANCED sampler · SWA full · 32K cache",
    taste: "balanced",
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
    note: "EXACT sampler · Jinja off · reasoning off",
    taste: "exact",
    tweaks: {
      jinja: "off",
      swa_full: "off",
      spm_infill: "off",
      cache_ram: 8192,
      reasoning_preserve: "off",
    },
  },
];

export function fullAutoWorkloadLabel(workload: FullAutoWorkload | null): string | null {
  if (!workload) return null;
  return FULL_AUTO_WORKLOADS.find((item) => item.id === workload)?.label ?? null;
}
