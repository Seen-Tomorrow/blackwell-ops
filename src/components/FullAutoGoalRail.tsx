import SegmentSwitch from "./SegmentSwitch";
import { FULL_AUTO_GOALS, type FullAutoGoal } from "../lib/fullAutoGoals";

interface FullAutoGoalRailProps {
  goal: FullAutoGoal | null;
  outcome: string;
  onGoal: (goal: FullAutoGoal) => void;
  onTakeControl?: () => void;
}

/** FULL AUTO goal picker — outcome first, manual controls one click away. */
export default function FullAutoGoalRail({
  goal,
  outcome,
  onGoal,
  onTakeControl,
}: FullAutoGoalRailProps) {
  return (
    <div className="full-auto-goal-rail">
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
        size="compact"
        tone="accent"
        className="segment-switch--gpu-bezel segment-switch--auto-goal"
      />
      <span className="full-auto-goal-rail__outcome" title={outcome}>
        {outcome}
      </span>
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
