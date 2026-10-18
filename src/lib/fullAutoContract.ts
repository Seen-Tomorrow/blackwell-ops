/**
 * FULL AUTO contract — pure decisions only.
 *
 * FULL AUTO owns its goal/workload/spec choice and emits a plan. It must not
 * read manual cockpit state (speedBoost, draft rows, etc.); the writer applies
 * the plan to the shared engine config afterwards.
 */

import {
  FULL_AUTO_GOAL_PLANS,
  type FullAutoGoal,
  type FullAutoWorkload,
} from "./fullAutoGoals";
import {
  resolveFullAutoPlan,
  type FullAutoPlan,
  type SpeedBoostId,
} from "./multiAgentBooster";
import type { SpecCapability } from "./specDraft";
import type { ThroughputId } from "./engineSurfaces";

/** Safe spec defaults — P-MIN above zero is model-specific and rarely helps. */
export const FULL_AUTO_SPEC_EXTRAS_DEFAULT = {
  nMax: 3,
  nMin: 1,
  pMin: 0,
} as const;

export type FullAutoSpecMethod = "off" | "mtp" | "dflash" | "dspark";
export type FullAutoDraftSource = "none" | "built-in" | "saved" | "external";

export interface FullAutoSpecExtras {
  nMax: number;
  nMin: number;
  pMin: number;
}

export interface FullAutoDecisionInput {
  goal: FullAutoGoal;
  workload: FullAutoWorkload;
  capabilities: SpecCapability[];
  dflashLibraryReady: boolean;
  dflashGettable?: boolean;
  kvQuantValues: (string | number)[];
  /** Target carries baked-in nextn tensors. */
  hasBakedMtp?: boolean;
  /** Current/saved external MTP head path, if any. */
  mtpDraftPath?: string | null;
  /** Auto-contract override for the SPEC lane (not an ASSISTED handoff). */
  speedOverride?: SpeedBoostId | null;
  /** User/controller overrides; falls back to the safe defaults. */
  specExtras?: Partial<FullAutoSpecExtras>;
}

export interface FullAutoSpecDecision {
  method: FullAutoSpecMethod;
  specType: string | null;
  draftSource: FullAutoDraftSource;
  needsDraft: boolean;
  extras: FullAutoSpecExtras;
}

export interface FullAutoDecision {
  goal: FullAutoGoal;
  workload: FullAutoWorkload;
  plan: FullAutoPlan;
  throughput: ThroughputId;
  spec: FullAutoSpecDecision;
  outcome: string;
  reasons: string[];
}

function finite(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizedExtras(
  overrides?: Partial<FullAutoSpecExtras>,
): FullAutoSpecExtras {
  return {
    nMax: finite(overrides?.nMax, FULL_AUTO_SPEC_EXTRAS_DEFAULT.nMax),
    nMin: finite(overrides?.nMin, FULL_AUTO_SPEC_EXTRAS_DEFAULT.nMin),
    pMin: finite(overrides?.pMin, FULL_AUTO_SPEC_EXTRAS_DEFAULT.pMin),
  };
}

/**
 * Resolve one FULL AUTO decision from static model capabilities and the goal.
 * No React state, no config mutation, no draft picker side effects.
 */
export function resolveFullAutoDecision(
  input: FullAutoDecisionInput,
): FullAutoDecision {
  const goalPlan = FULL_AUTO_GOAL_PLANS[input.goal];
  const requestedSpeed = input.speedOverride ?? goalPlan.speed;
  const plan = resolveFullAutoPlan({
    codingMode: goalPlan.codingMode,
    speed: requestedSpeed,
    brains: goalPlan.brains,
    think: goalPlan.think,
    capabilities: input.capabilities,
    dflashLibraryReady: input.dflashLibraryReady,
    dflashGettable: input.dflashGettable,
    kvQuantValues: input.kvQuantValues,
    powerUser: false,
  });

  const method: FullAutoSpecMethod =
    plan.speed === "mtp" || plan.speed === "dflash" || plan.speed === "dspark"
      ? plan.speed
      : "off";

  const mtpAvailable = input.capabilities.includes("mtp");
  const bakedIn = Boolean(input.hasBakedMtp && mtpAvailable);
  const savedMtp = Boolean(
    mtpAvailable
    && String(input.mtpDraftPath ?? "").trim()
    && String(input.mtpDraftPath ?? "").trim().toLowerCase() !== "off",
  );

  let draftSource: FullAutoDraftSource = "none";
  if (method === "mtp") {
    draftSource = bakedIn ? "built-in" : savedMtp ? "saved" : "none";
  } else if (method === "dflash" || method === "dspark") {
    draftSource = plan.needsDflashDraft ? "none" : "external";
  }

  const needsDraft = method !== "off" && draftSource === "none";
  const reasons: string[] = [];
  if (method === "mtp") {
    if (bakedIn) reasons.push("MTP head is built in.");
    else if (savedMtp) reasons.push("Using the saved external MTP head.");
    else reasons.push("MTP selected, but no head is paired yet.");
  } else if ((method === "dflash" || method === "dspark") && needsDraft) {
    reasons.push("External draft needed for the selected SPEC lane.");
  } else if (method === "off") {
    reasons.push(
      mtpAvailable || input.dflashLibraryReady || input.dflashGettable
        ? "SPEC is capable but not selected — pick a lane to go faster."
        : "No usable SPEC lane for this target.",
    );
  }
  if (plan.softNote) reasons.push(plan.softNote);

  const spec: FullAutoSpecDecision = {
    method,
    specType: plan.specType,
    draftSource,
    needsDraft,
    extras: normalizedExtras(input.specExtras),
  };

  return {
    goal: input.goal,
    workload: input.workload,
    plan,
    throughput: goalPlan.throughput,
    spec,
    outcome: plan.outcome,
    reasons,
  };
}
