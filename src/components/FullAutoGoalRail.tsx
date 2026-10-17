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
      <span className="full-auto-goal-rail__label">AUTO</span>
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
        tone="accent"
        className="segment-switch--gpu-bezel segment-switch--auto-goal"
      />
      <span className="full-auto-goal-rail__label">WORK</span>
      <SegmentSwitch
        ariaLabel="Full Auto workload"
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
        tone="accent"
        className="segment-switch--gpu-bezel segment-switch--auto-goal"
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
          title="Run the low-VRAM FIT probe — refine the fit or start RAM offload"
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
