import type { ReactNode } from "react";
import CockpitNavSegment from "./CockpitNavSegment";
import {
  FULL_AUTO_GOALS,
  FULL_AUTO_WORKLOADS,
  type FullAutoFitState,
  type FullAutoGoal,
  type FullAutoWorkload,
} from "../lib/fullAutoGoals";

interface FullAutoGoalRailProps {
  goal: FullAutoGoal | null;
  workload: FullAutoWorkload | null;
  hero?: boolean;
  fitState?: FullAutoFitState;
  fixing?: boolean;
  onGoal: (goal: FullAutoGoal) => void;
  onWorkload: (workload: FullAutoWorkload) => void;
  onFix?: () => void;
  onTakeControl?: () => void;
  /** Compact SPEC switch, tucked under the GOAL segment. */
  specSlot?: ReactNode;
  /** Full-width SPEC-EXTRA/draft row, inside the same rail. */
  specExtraSlot?: ReactNode;
}

/** FULL AUTO goal + task picker — two big segments, manual controls one click away. */
export default function FullAutoGoalRail({
  goal,
  workload,
  hero = false,
  fitState,
  fixing = false,
  onGoal,
  onWorkload,
  onFix,
  onTakeControl,
  specSlot,
  specExtraSlot,
}: FullAutoGoalRailProps) {
  return (
    <div className={`full-auto-goal-rail${hero ? " full-auto-goal-rail--hero" : ""}`}>
      <div
        className="flex min-w-0 flex-1 items-start gap-3"
        style={{ flex: "1 1 620px" }}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="shrink-0 type-micro uppercase tracking-widest"
              style={{ color: "var(--theme-text-muted)" }}
            >
              GOAL
            </span>
            <CockpitNavSegment
              ariaLabel="Full Auto goal"
              options={FULL_AUTO_GOALS.map((option) => ({
                id: option.id,
                label: option.label,
                title: option.note,
              }))}
              selectedId={goal ?? ""}
              onSelect={(id) => {
                if (id) onGoal(id as FullAutoGoal);
              }}
              size="primary"
              className="segment-switch--auto-goal min-w-0"
            />
          </div>
          {specSlot ? (
            <div
              className="flex items-center justify-end"
              style={{ padding: "4px 6px 0" }}
            >
              {specSlot}
            </div>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className="shrink-0 type-micro uppercase tracking-widest"
            style={{ color: "var(--theme-text-muted)" }}
          >
            TASK
          </span>
          <CockpitNavSegment
            ariaLabel="Full Auto task"
            options={FULL_AUTO_WORKLOADS.map((option) => ({
              id: option.id,
              label: option.label,
              title: option.note,
            }))}
            selectedId={workload ?? ""}
            onSelect={(id) => {
              if (id) onWorkload(id as FullAutoWorkload);
            }}
            size="primary"
            className="segment-switch--auto-goal min-w-0"
          />
        </div>
      </div>
      {fitState === "tight" && onFix ? (
        <button
          type="button"
          className="full-auto-goal-rail__take"
          onClick={onFix}
          disabled={fixing}
          title="Run the low-VRAM FIT probe, then correct CTX/batch — or let FASTEST try a split after the single GPU fails"
        >
          {fixing ? "PROBING…" : "LOW-VRAM PROBE"}
        </button>
      ) : null}
      {onTakeControl ? (
        <button
          type="button"
          className="full-auto-goal-rail__take"
          onClick={onTakeControl}
          title="Switch to ASSISTED and unlock the cockpit"
        >
          TAKE CONTROL
        </button>
      ) : null}
      {specExtraSlot ? (
        <div style={{ flex: "1 1 100%", padding: "5px 6px 0" }}>
          {specExtraSlot}
        </div>
      ) : null}
    </div>
  );
}
