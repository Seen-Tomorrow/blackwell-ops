import SegmentSwitch from "./SegmentSwitch";
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
}: FullAutoGoalRailProps) {
  return (
    <div className={`full-auto-goal-rail${hero ? " full-auto-goal-rail--hero" : ""}`}>
      <div
        className="flex min-w-0 flex-1 items-center gap-3"
        style={{ flex: "1 1 620px" }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className="shrink-0 type-micro uppercase tracking-widest"
            style={{ color: "var(--theme-text-muted)" }}
          >
            GOAL
          </span>
          <SegmentSwitch
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
            size={hero ? "fit" : "compact"}
            tone="amber"
            className="segment-switch--auto-goal min-w-0 flex-1"
          />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className="shrink-0 type-micro uppercase tracking-widest"
            style={{ color: "var(--theme-text-muted)" }}
          >
            TASK
          </span>
          <SegmentSwitch
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
            size={hero ? "fit" : "compact"}
            tone="amber"
            className="segment-switch--auto-goal min-w-0 flex-1"
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
    </div>
  );
}
