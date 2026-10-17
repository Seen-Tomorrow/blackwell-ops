import type { BrainsId, CodingModeId, SpeedBoostId, ThinkId } from "./multiAgentBooster";
import { THROUGHPUT_STOPS, type ThroughputId } from "./engineSurfaces";

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
  { id: "agents", label: "MAX AGENTS", note: "Army ×32 · Light KV · LATENCY batch" },
  { id: "fastest", label: "FASTEST", note: "Solo · MTP when available · SPEED batch" },
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
    codingMode: "army",
    speed: "smart",
    brains: "light",
    think: "on",
    throughput: "latency",
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
