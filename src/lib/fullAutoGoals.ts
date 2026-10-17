import type { BrainsId, CodingModeId, SpeedBoostId, ThinkId } from "./multiAgentBooster";

/** FULL AUTO outcomes — the app owns the knobs until the user takes control. */
export type FullAutoGoal = "balanced" | "context" | "agents" | "fastest";

export interface FullAutoGoalOption {
  id: FullAutoGoal;
  label: string;
  note: string;
}

export const FULL_AUTO_GOALS: FullAutoGoalOption[] = [
  { id: "balanced", label: "BALANCED", note: "4 agents · Solid KV · Smart boost" },
  { id: "context", label: "MAX CTX", note: "Solo · Light KV — raise CTX to fit VRAM" },
  { id: "agents", label: "MAX AGENTS", note: "Army ×32 · Light KV — watch VRAM" },
  { id: "fastest", label: "FASTEST", note: "Solo · MTP when available · Think off" },
];

export interface FullAutoGoalPlan {
  codingMode: CodingModeId;
  speed: SpeedBoostId;
  brains: BrainsId;
  think: ThinkId;
}

/**
 * Phase-1 cockpit plans. These are deliberately coarse heuristics until the
 * FIT/VRAM calibration pass lands; they set the knobs FULL AUTO already owns.
 */
export const FULL_AUTO_GOAL_PLANS: Record<FullAutoGoal, FullAutoGoalPlan> = {
  balanced: { codingMode: "group", speed: "smart", brains: "solid", think: "on" },
  context: { codingMode: "solo", speed: "smart", brains: "light", think: "on" },
  agents: { codingMode: "army", speed: "smart", brains: "light", think: "on" },
  fastest: { codingMode: "solo", speed: "mtp", brains: "solid", think: "off" },
};
