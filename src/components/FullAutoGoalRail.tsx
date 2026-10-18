import MissionStrip from "./MissionStrip";
import {
  type FullAutoFitState,
  type FullAutoGoal,
  type FullAutoWorkload,
} from "../lib/fullAutoGoals";

interface FullAutoGoalRailProps {
  goal: FullAutoGoal | null;
  workload: FullAutoWorkload | null;
  outcome: string;
  hero?: boolean;
  fitState?: FullAutoFitState;
  fixing?: boolean;
  onGoal: (goal: FullAutoGoal) => void;
  onWorkload: (workload: FullAutoWorkload) => void;
  onFix?: () => void;
  onTakeControl?: () => void;
}

/** FULL AUTO goal + workload picker — outcome first, manual controls one click away. */
export default function FullAutoGoalRail({
  goal,
  workload,
  outcome,
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
      <MissionStrip
        goal={goal}
        workload={workload}
        onGoal={onGoal}
        onWorkload={onWorkload}
      />
      <span className="full-auto-goal-rail__outcome" title={outcome}>
        {outcome}
      </span>
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
